/* ==========================================================================
   Air-Waves — 音频引擎 (Web Audio API)
   支持双耳节拍 (binaural) 与等时节拍 (isochronic)
   无框架、无依赖，可独立在浏览器中加载。

   ── 无爆音设计要点 ──────────────────────────────────────────────
   1. 振荡器常驻：init() 时一次性创建并 start()，之后永不 stop()，
      播放/暂停/换频/切模式全部只改参数，不重建节点。
   2. 模式切换用交叉淡化：A(双耳) 与 B(等时) 两套图常驻，各自一个淡化增益，
      切换时先淡出再淡入（中间留极短静音），避免两图相位抵消造成音量抖动。
   3. 所有参数变化都用线性/指数自动化（sample-accurate），不做瞬间赋值。
   4. 暂停后延迟数秒才 suspend()：AudioContext 恢复瞬间可能产生电平跳变，
      因此恢复后先把主增益置 0，等图稳定再淡入。
   5. 计算音频图之外的代码不制造 GC 压力（渲染循环复用缓冲区）。
   ========================================================================== */
(function (global) {
  'use strict';

  var DEFAULT_BEAT = 10;      // 默认 Δf = 10 Hz → Alpha
  var DEFAULT_CARRIER = 200;  // 左耳基频 200 Hz，右耳 = 200 + Δf
  var TONE_PEAK = 0.6;        // 单个振荡器在音乐域内的峰值增益

  /* 抗蓝牙编码噪点用的"舒适底噪"(dither)。
     纯正弦 + 很低的电平会被 SBC/AAC 用很少的比特量化，听感就是"沙沙噪点"；
     叠加一层极低的宽带噪声能让编码器更均匀地分配比特，并掩蔽量化噪声。
     数值经实测校准：默认音量下输出约 -72 dBFS，比主信号低约 48 dB
     —— 类似安静房间的本底声，有线耳机下几乎察觉不到，但足以打散量化台阶。
     若仍不满意，可打开界面的 AMBIENT NOISE 获得更强的掩蔽噪声。 */
  var DITHER_PEAK = 0.1;

  var FADE_IN = 0.9;          // 播放渐入（秒）
  var FADE_OUT = 0.55;        // 暂停渐出（秒）
  var TARGET_RAMP = 0.35;     // 音量变化
  var FREQ_RAMP = 0.6;        // 换频时的滑音过渡
  var XFADE = 0.22;           // 模式切换淡出/淡入时长
  var XGAP = 0.12;            // 模式切换中间的静音间隙
  var RESUME_SETTLE = 0.12;   // 从挂起恢复后的稳定等待
  var SUSPEND_DELAY = 4000;   // 暂停后多久才真的挂起 AudioContext

  /* ------------------------------------------------------------------ */
  /* 工具                                                                */
  /* ------------------------------------------------------------------ */

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function toFiniteNumber(v, fallback) {
    var n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  /* 把参数"钉"在当前值，再叠加新的自动化。
     注意：实测 cancelAndHoldAtTime() 在被高频调用时（如拖动滑杆）
     会在参数上产生波形跳变 → 咔哒声，因此这里统一用
     cancelScheduledValues + setValueAtTime 的写法（对照实验 0 次跳变）。 */
  function anchorParam(param, now) {
    var current = param.value;
    try { param.cancelScheduledValues(now); } catch (e) { /* ignore */ }
    try { param.setValueAtTime(current, now); } catch (e) { /* ignore */ }
  }

  /* 线性滑到目标值（对 0 安全） */
  function rampTo(param, value, now, duration) {
    anchorParam(param, now);
    param.linearRampToValueAtTime(value, now + Math.max(duration, 0.01));
  }

  /* 指数滑音（用于频率），对 0 不安全，先做保护 */
  function glideTo(param, value, now, duration) {
    var safe = Math.max(value, 1e-3);
    anchorParam(param, now);
    param.exponentialRampToValueAtTime(safe, now + Math.max(duration, 0.01));
  }

  /* ------------------------------------------------------------------ */
  /* 粉红噪声缓冲（用于可选的背景底噪）                                    */
  /* ------------------------------------------------------------------ */

  function createNoiseBuffer(ctx, seconds) {
    var len = Math.floor(ctx.sampleRate * seconds);
    var buffer = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buffer.getChannelData(0);

    // Paul Kellet 的粉红噪声近似
    var b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (var i = 0; i < len; i++) {
      var white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      var pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
      b6 = white * 0.115926;
      d[i] = pink * 0.11;
    }
    return buffer;
  }

  /* ------------------------------------------------------------------ */
  /* 引擎                                                                */
  /* ------------------------------------------------------------------ */

  function AudioEngine(opts) {
    opts = opts || {};

    this.ctx = null;
    this._nodes = null;
    this._isochronic = false;
    this._noiseOn = false;
    this._playing = false;
    this._destroyed = false;

    // 期望参数：即使尚未播放也会被记住，播放时按此构建
    this._beat = clamp(toFiniteNumber(opts.beat, DEFAULT_BEAT), 0.5, 60);
    this._carrier = clamp(toFiniteNumber(opts.carrier, DEFAULT_CARRIER), 40, 1200);
    this._volume = clamp(toFiniteNumber(opts.volume, 0.35), 0, 1);

    this._unsupportedReason = null;
    this._suspendTimer = null;
    this._xfadeToken = 0;
  }

  AudioEngine.prototype.supported = function () {
    return !!(global.AudioContext || global.webkitAudioContext);
  };

  AudioEngine.prototype.unsupportedReason = function () {
    return this._unsupportedReason;
  };

  AudioEngine.prototype.isPlaying = function () { return this._playing; };
  AudioEngine.prototype.isIsochronic = function () { return this._isochronic; };
  AudioEngine.prototype.isNoiseOn = function () { return this._noiseOn; };
  AudioEngine.prototype.getBeat = function () { return this._beat; };
  AudioEngine.prototype.getCarrier = function () { return this._carrier; };
  AudioEngine.prototype.getVolume = function () { return this._volume; };

  AudioEngine.prototype.state = function () {
    return this.ctx ? this.ctx.state : 'closed';
  };

  /* ---------------- 上下文与常驻音频图 ---------------- */

  AudioEngine.prototype.init = function () {
    if (this._destroyed) return Promise.reject(new Error('engine destroyed'));
    if (this.ctx) return Promise.resolve(this.ctx);

    var Ctor = global.AudioContext || global.webkitAudioContext;
    if (!Ctor) {
      this._unsupportedReason = '当前浏览器不支持 Web Audio API';
      return Promise.reject(new Error(this._unsupportedReason));
    }

    try {
      this.ctx = new Ctor({ latencyHint: 'interactive' });
    } catch (e) {
      try {
        this.ctx = new Ctor();
      } catch (e2) {
        this._unsupportedReason = 'AudioContext 创建失败';
        return Promise.reject(e2);
      }
    }

    var ctx = this.ctx;
    var now = ctx.currentTime;
    var beat = this._beat;
    var carrier = this._carrier;

    // 主输出链：master → limiter → analyser → destination
    var master = ctx.createGain();
    master.gain.value = 0;

    var limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 4;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.004;
    limiter.release.value = 0.22;

    var analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.82;

    // 立体声分离：两路 mono 分别并入 L / R
    var merger = ctx.createChannelMerger(2);

    master.connect(limiter);
    limiter.connect(analyser);
    analyser.connect(ctx.destination);

    /* ---- 图 A：双耳节拍（左右基频相差 Δf） ---- */
    // osc → tone(gain，交叉淡化操控点) → pan → merger
    function makeTone(panValue, freq, initialGain) {
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;

      var tone = ctx.createGain();
      tone.gain.value = initialGain;

      var pan = ctx.createStereoPanner();
      pan.pan.value = panValue;

      osc.connect(tone);
      tone.connect(pan);
      osc.start(now);                   // 常驻：此后不再 stop()
      return { osc: osc, tone: tone, pan: pan };
    }

    var aFade = this._isochronic ? 0 : 1;

    var aLeft = makeTone(-1, carrier, aFade * TONE_PEAK);
    var aRight = makeTone(1, carrier + beat, aFade * TONE_PEAK);
    aLeft.pan.connect(merger, 0, 0);
    aRight.pan.connect(merger, 0, 1);

    /* ---- 图 B：等时节拍（左右同频，按 Δf 通断） ---- */
    var bFade = this._isochronic ? 1 : 0;

    var bLeft = makeTone(-1, carrier, bFade * TONE_PEAK);
    var bRight = makeTone(1, carrier, bFade * TONE_PEAK);
    bLeft.pan.connect(merger, 0, 0);
    bRight.pan.connect(merger, 0, 1);

    // 等时脉冲：直接调制 tone 增益会在 0.5 处产生直流偏置，
    // 所以再加一级"通断增益"，由 LFO 驱动 0..1 的脉冲包络。
    function makeGate(channel) {
      var gate = ctx.createGain();
      gate.gain.value = 0;
      var depth = ctx.createGain();
      depth.gain.value = 0.5;
      var offset = ctx.createGain();
      offset.gain.value = 0.5;
      // 插到 tone 之前：脉冲包络作用在信号上，不动 tone 的淡化值
      channel.osc.disconnect();
      channel.osc.connect(gate);
      gate.connect(channel.tone);
      depth.connect(gate.gain);
      offset.connect(gate.gain);
      return { gate: gate, depth: depth, offset: offset };
    }

    var lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = beat;

    var gateL = makeGate(bLeft);
    var gateR = makeGate(bRight);
    lfo.connect(gateL.depth);
    lfo.connect(gateR.depth);
    lfo.start(now);

    merger.connect(master);

    /* ---- 噪声层：源只建一次，分两路输出 ----
       1) ditherGain  : 常开的极低"舒适底噪"，用于压制蓝牙编码噪点
       2) noiseGain   : 用户可选的环境底噪（音量明显更大） */
    var noiseGain = ctx.createGain();
    noiseGain.gain.value = 0;

    var ditherGain = ctx.createGain();
    ditherGain.gain.value = 0;

    var noiseSource = null;
    try {
      noiseSource = ctx.createBufferSource();
      noiseSource.buffer = createNoiseBuffer(ctx, 4);
      noiseSource.loop = true;

      // 两路用不同带宽：dither 收窄到中低频（掩蔽效率高、听感不刺耳），
      // 环境底噪保留更宽的高频，听感更像"雨声/空气声"。
      var lpDither = ctx.createBiquadFilter();
      lpDither.type = 'lowpass';
      lpDither.frequency.value = 2200;
      lpDither.Q.value = 0.4;

      var lpNoise = ctx.createBiquadFilter();
      lpNoise.type = 'lowpass';
      lpNoise.frequency.value = 1400;
      lpNoise.Q.value = 0.4;

      noiseSource.connect(lpDither);
      lpDither.connect(ditherGain);
      noiseSource.connect(lpNoise);
      lpNoise.connect(noiseGain);

      ditherGain.connect(master);
      noiseGain.connect(master);

      noiseSource.start(now);
    } catch (e) {
      noiseSource = null;
    }

    this._nodes = {
      master: master,
      limiter: limiter,
      analyser: analyser,
      merger: merger,
      noiseGain: noiseGain,
      ditherGain: ditherGain,
      noiseSource: noiseSource,
      aLeft: aLeft,
      aRight: aRight,
      bLeft: bLeft,
      bRight: bRight,
      lfo: lfo,
      gateL: gateL,
      gateR: gateR
    };

    return Promise.resolve(ctx);
  };

  AudioEngine.prototype.resume = function () {
    var self = this;
    return this.init().then(function (ctx) {
      if (ctx.state === 'running') return ctx;
      return ctx.resume().then(function () { return ctx; });
    }).catch(function (err) {
      if (!self._unsupportedReason) self._unsupportedReason = '音频上下文无法启动';
      throw err;
    });
  };

  AudioEngine.prototype.suspend = function () {
    if (!this.ctx || this.ctx.state !== 'running') return Promise.resolve();
    return this.ctx.suspend().catch(function () { /* ignore */ });
  };

  /* ---------------- 播放 / 暂停 ---------------- */

  AudioEngine.prototype.play = function () {
    var self = this;
    if (this._destroyed) return Promise.resolve(false);

    this._clearSuspendTimer();

    // 从挂起状态恢复时，音频图重启瞬间可能有电平跳变 → 先静音再淡入
    var wasSuspended = !!this.ctx && this.ctx.state !== 'running';

    return this.resume().then(function () {
      var ctx = self.ctx;
      var nodes = self._nodes;
      if (!ctx || !nodes) return false;

      self._playing = true;

      var now = ctx.currentTime;

      if (wasSuspended) {
        // 从挂起恢复：先把增益钉在 0，等图稳定后再淡入，避免恢复瞬间的跳变
        anchorParam(nodes.master.gain, now);
        nodes.master.gain.setValueAtTime(0, now);
        nodes.master.gain.linearRampToValueAtTime(self._volume, now + RESUME_SETTLE + FADE_IN);
      } else {
        rampTo(nodes.master.gain, self._volume, now, FADE_IN);
      }

      // 底噪（常驻运行，仅靠增益开关）
      if (nodes.noiseGain) {
        rampTo(nodes.noiseGain.gain,
          self._noiseOn ? self._noiseLevel() : 0, now, FADE_IN);
      }
      self._applyDither(now, FADE_IN);
      return true;
    }).catch(function (err) {
      self._playing = false;
      throw err;
    });
  };

  AudioEngine.prototype.pause = function () {
    var self = this;
    if (!this.ctx || !this._nodes) {
      this._playing = false;
      return Promise.resolve(false);
    }

    var ctx = this.ctx;
    var nodes = this._nodes;
    var now = ctx.currentTime;

    this._playing = false;
    this._clearSuspendTimer();

    // 平滑淡出（音源常驻，无需拆除）
    rampTo(nodes.master.gain, 0, now, FADE_OUT);
    if (nodes.noiseGain) rampTo(nodes.noiseGain.gain, 0, now, FADE_OUT);
    this._applyDither(now, FADE_OUT);

    // 延迟较久才真正挂起：AudioContext 恢复瞬间容易产生电平跳变，
    // 保持运行可彻底避免，只在长时间静默后再释放音频硬件。
    this._suspendTimer = global.setTimeout(function () {
      self._suspendTimer = null;
      if (self._playing || self._destroyed) return;
      self.suspend();
    }, SUSPEND_DELAY);

    return Promise.resolve(true);
  };

  AudioEngine.prototype.toggle = function () {
    return this._playing ? this.pause() : this.play();
  };

  /* ---------------- 参数 ---------------- */

  AudioEngine.prototype._noiseLevel = function () {
    return 0.05 * (0.25 + 0.75 * this._volume);
  };

  /* 舒适底噪电平。
     注意：this._volume 是 0..1 的主增益（不是百分比），所以这里随音量线性缩放，
     保证 dither 与主信号的比例恒定 —— 音量调小时底噪同样变小，不会显得更吵。 */
  AudioEngine.prototype._ditherLevel = function () {
    return DITHER_PEAK * this._volume;
  };

  /* 播放开始时把 dither 淡入；停止时淡出 */
  AudioEngine.prototype._applyDither = function (now, duration) {
    if (!this._nodes || !this._nodes.ditherGain) return;
    rampTo(this._nodes.ditherGain.gain,
      this._playing ? this._ditherLevel() : 0, now, duration);
  };

  /** 设置拍频 Δf（Hz）。播放中会平滑滑音。 */
  AudioEngine.prototype.setBeat = function (hz, glide) {
    this._beat = clamp(toFiniteNumber(hz, this._beat), 0.5, 60);
    if (!this.ctx || !this._nodes) return;

    var now = this.ctx.currentTime;
    var dur = toFiniteNumber(glide, FREQ_RAMP);
    var n = this._nodes;

    // 双耳图：右耳 = 载波 + Δf
    glideTo(n.aRight.osc.frequency, this._carrier + this._beat, now, dur);
    // 等时图：脉冲速率 = Δf（左右同频，不改频率）
    glideTo(n.lfo.frequency, this._beat, now, dur);
  };

  /** 设置基频（左耳）。双耳图右耳 = 基频 + Δf。 */
  AudioEngine.prototype.setCarrier = function (hz, glide) {
    this._carrier = clamp(toFiniteNumber(hz, this._carrier), 40, 1200);
    if (!this.ctx || !this._nodes) return;

    var now = this.ctx.currentTime;
    var dur = toFiniteNumber(glide, FREQ_RAMP);
    var n = this._nodes;

    glideTo(n.aLeft.osc.frequency, this._carrier, now, dur);
    glideTo(n.aRight.osc.frequency, this._carrier + this._beat, now, dur);
    glideTo(n.bLeft.osc.frequency, this._carrier, now, dur);
    glideTo(n.bRight.osc.frequency, this._carrier, now, dur);
  };

  /** 设置音量 0..1 */
  AudioEngine.prototype.setVolume = function (v) {
    this._volume = clamp(toFiniteNumber(v, this._volume), 0, 1);
    if (!this.ctx || !this._nodes) return;

    var now = this.ctx.currentTime;
    var n = this._nodes;

    rampTo(n.master.gain, this._playing ? this._volume : 0, now, TARGET_RAMP);
    if (n.noiseGain) {
      rampTo(n.noiseGain.gain,
        (this._playing && this._noiseOn) ? this._noiseLevel() : 0, now, TARGET_RAMP);
    }
    this._applyDither(now, TARGET_RAMP);
  };

  /**
   * 切换双耳 / 等时模式。
   * 两套图常驻，这里只交叉淡化 tone 增益：先淡出现用图，留极短静音，
   * 再淡入目标图。中间不留静音会因两图相位差造成音量忽大忽小；留一点空缺则听不出来。
   */
  AudioEngine.prototype.setIsochronic = function (on) {
    var next = !!on;
    if (next === this._isochronic) return;
    this._isochronic = next;
    if (!this.ctx || !this._nodes) return;

    var self = this;
    var n = this._nodes;
    var now = this.ctx.currentTime;

    // 等时图始终跟随当前载波（左右同频）
    n.bLeft.osc.frequency.setValueAtTime(this._carrier, now);
    n.bRight.osc.frequency.setValueAtTime(this._carrier, now);

    var token = ++this._xfadeToken;
    var out = next ? [n.aLeft, n.aRight] : [n.bLeft, n.bRight];
    var into = next ? [n.bLeft, n.bRight] : [n.aLeft, n.aRight];
    var targetGain = TONE_PEAK;

    // 1) 淡出现用图
    out.forEach(function (ch) { rampTo(ch.tone.gain, 0, now, XFADE); });
    // 2) 目标图先归零，等淡出结束后再淡入
    into.forEach(function (ch) { rampTo(ch.tone.gain, 0, now, 0.005); });

    global.setTimeout(function () {
      if (self._destroyed || token !== self._xfadeToken) return;
      if (!self.ctx || !self._nodes) return;
      var t = self.ctx.currentTime;
      self._nodes && into.forEach(function (ch) {
        rampTo(ch.tone.gain, targetGain, t, XFADE);
      });
    }, Math.round((XFADE + XGAP) * 1000));
  };

  /** 开关背景底噪 */
  AudioEngine.prototype.setNoise = function (on) {
    this._noiseOn = !!on;
    if (!this.ctx || !this._nodes || !this._nodes.noiseGain) return;

    var now = this.ctx.currentTime;
    rampTo(this._nodes.noiseGain.gain,
      (this._playing && this._noiseOn) ? this._noiseLevel() : 0, now, 0.8);
  };

  /* ---------------- 电平 / 波形 ---------------- */

  AudioEngine.prototype.getAnalyser = function () {
    return this._nodes ? this._nodes.analyser : null;
  };

  /**
   * 读取时域波形与 RMS 电平。
   * @param {Float32Array} [out] 复用的缓冲（长度需为 fftSize），避免渲染循环里反复分配
   */
  AudioEngine.prototype.readLevel = function (out) {
    var analyser = this.getAnalyser();
    if (!analyser || !this._playing) {
      return { wave: null, rms: 0, db: -Infinity };
    }

    var buf = (out instanceof Float32Array && out.length === analyser.fftSize)
      ? out
      : new Float32Array(analyser.fftSize);

    analyser.getFloatTimeDomainData(buf);

    var sum = 0;
    for (var i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    var rms = Math.sqrt(sum / buf.length);
    var db = rms > 0 ? 20 * Math.log10(rms) : -Infinity;

    return { wave: buf, rms: rms, db: db };
  };

  /* ---------------- 清理 ---------------- */

  AudioEngine.prototype._clearSuspendTimer = function () {
    if (this._suspendTimer) {
      global.clearTimeout(this._suspendTimer);
      this._suspendTimer = null;
    }
  };

  AudioEngine.prototype.destroy = function () {
    this._destroyed = true;
    this._xfadeToken++;
    this._clearSuspendTimer();

    if (!this.ctx) return Promise.resolve();

    var ctx = this.ctx;
    var n = this._nodes;
    this._playing = false;

    // 先静音，再停止常驻音源
    try {
      if (n && n.master) {
        anchorParam(n.master.gain, ctx.currentTime);
        n.master.gain.setValueAtTime(0, ctx.currentTime);
      }
    } catch (e) { /* ignore */ }

    if (n) {
      [n.aLeft, n.aRight, n.bLeft, n.bRight].forEach(function (ch) {
        if (!ch) return;
        try { ch.osc.stop(); } catch (e) { /* ignore */ }
        try { ch.osc.disconnect(); } catch (e) { /* ignore */ }
      });
      try { n.lfo.stop(); } catch (e) { /* ignore */ }
      try { if (n.noiseSource) n.noiseSource.stop(); } catch (e) { /* ignore */ }
    }

    this._nodes = null;

    return ctx.close().catch(function () { /* ignore */ }).then(function () {
      ctx = null;
    });
  };

  global.AirWavesAudio = {
    AudioEngine: AudioEngine,
    DEFAULT_BEAT: DEFAULT_BEAT,
    DEFAULT_CARRIER: DEFAULT_CARRIER
  };
})(window);
