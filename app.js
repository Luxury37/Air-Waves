/* ==========================================================================
   Air-Waves — 界面与交互控制
   依赖 audio.js 暴露的 window.AirWavesAudio
   ========================================================================== */
(function (global, document) {
  'use strict';

  /* ------------------------------ 常量 ------------------------------ */

  var BANDS = {
    theta: { key: 'theta', label: 'THETA',    cn: '深度放松 / 创意', min: 6,  max: 8,  beat: 7.0,  carrier: 180 },
    alpha: { key: 'alpha', label: 'ALPHA',    cn: '放松专注 · 推荐', min: 8,  max: 12, beat: 10.0, carrier: 200 },
    beta:  { key: 'beta',  label: 'LOW BETA', cn: '工作学习专注',    min: 12, max: 18, beat: 15.0, carrier: 220 }
  };

  var DEFAULT_BAND = 'alpha';
  var DEFAULT_VOLUME = 35;    // 百分比（界面值）
  var BEAT_MIN = 4;
  var BEAT_MAX = 18;

  var REDUCED_MOTION = false;
  try {
    REDUCED_MOTION = !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (e) { REDUCED_MOTION = false; }

  /* ------------------------------ DOM ------------------------------ */

  function $(id) { return document.getElementById(id); }

  var el = {
    body: document.body,
    clock: $('clock'),

    viewHome: $('view-home'),
    viewPlayer: $('view-player'),

    btnStart: $('btn-start'),
    btnBack: $('btn-back'),
    btnPlay: $('btn-play'),
    playIcon: $('play-icon'),
    playText: $('play-text'),
    btnNoise: $('btn-noise'),

    roBand: $('ro-band'),
    roBeat: $('ro-beat'),
    roCarrier: $('ro-carrier'),
    roStatus: $('ro-status'),
    roElapsed: $('ro-elapsed'),

    tagPreset: $('tag-preset'),
    tagMode: $('tag-mode'),

    vuFill: $('vu-fill'),
    vuValue: $('vu-value'),
    wave: $('wave'),

    dialNeedle: $('dial-needle'),

    beatRange: $('beat-range'),
    beatRangeVal: $('beat-range-val'),
    volRange: $('vol-range'),
    volVal: $('vol-val'),

    boot: $('boot'),
    figure: $('figure'),
    playerBg: $('player-bg'),
    homeBg: $('home-bg')
  };

  /* ------------------------------ 状态 ------------------------------ */

  var state = {
    view: 'home',
    playing: false,
    band: DEFAULT_BAND,
    beat: BANDS[DEFAULT_BAND].beat,
    carrier: BANDS[DEFAULT_BAND].carrier,
    volume: DEFAULT_VOLUME / 100,
    muted: false,
    lastVolume: DEFAULT_VOLUME,
    mode: 'binaural',
    noise: false,
    startedAt: 0,
    elapsed: 0,
    ready: false,
    busy: false
  };

  var engine = null;
  var bootTimer = null;

  /* ------------------------------ 工具 ------------------------------ */

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function bandOf(beat) {
    if (beat < 8) return BANDS.theta;
    if (beat < 12) return BANDS.alpha;
    return BANDS.beta;
  }

  function fmtTime(ms) {
    var total = Math.max(0, Math.floor(ms / 1000));
    var m = Math.floor(total / 60);
    var s = total % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  function fmtDb(rms) {
    if (!(rms > 0.00004)) return '−∞ dB';
    var db = 20 * Math.log10(rms);
    return (db >= 0 ? '+' : '') + db.toFixed(1) + ' dB';
  }

  /* ------------------------------ 视觉读数同步 ------------------------------ */

  function renderReadout() {
    var band = bandOf(state.beat);

    el.roBand.textContent = band.label;
    el.roBeat.textContent = state.beat.toFixed(1);
    el.roCarrier.textContent = 'L ' + state.carrier.toFixed(1) + ' / R ' +
      (state.carrier + state.beat).toFixed(1) + ' Hz';

    el.roStatus.textContent = state.playing ? 'TRANSMITTING' : 'STANDBY';

    el.tagPreset.textContent = band.label + (band.key === state.band ? ' / 默认' : '');
    el.tagMode.textContent = state.mode === 'isochronic' ? 'ISOCHRONIC' : 'BINAURAL';

    // 刻度指针：Δf 映射到轨道 6%–94%
    var ratio = clamp((state.beat - BEAT_MIN) / (BEAT_MAX - BEAT_MIN), 0, 1);
    el.dialNeedle.style.left = (6 + ratio * 88).toFixed(2) + '%';

    el.beatRangeVal.textContent = state.beat.toFixed(1) + ' Hz';
    if (el.beatRange.value !== String(state.beat)) el.beatRange.value = String(state.beat);

    var volPct = state.muted ? 0 : Math.round(state.volume);
    el.volVal.textContent = volPct + '%';
    if (document.activeElement !== el.volRange) {
      var want = String(volPct);
      if (el.volRange.value !== want) el.volRange.value = want;
    }
  }

  function renderTransport() {
    el.body.setAttribute('data-state', state.playing ? 'playing' : 'idle');
    el.btnPlay.setAttribute('aria-pressed', state.playing ? 'true' : 'false');
    el.playIcon.textContent = state.playing ? '❚❚' : '▶';
    el.playText.textContent = state.playing ? 'PAUSE' : 'PLAY';
    el.btnPlay.setAttribute('aria-label', state.playing ? '暂停听觉节拍' : '播放听觉节拍');
    renderReadout();
  }

  function renderView() {
    el.body.setAttribute('data-view', state.view);
    if (state.view === 'home') {
      el.btnStart.focus({ preventScroll: true });
    } else {
      el.btnPlay.focus({ preventScroll: true });
    }
  }

  /* ------------------------------ 播放控制 ------------------------------ */

  /* 音量单位约定：state.volume 始终保存百分比 0–100，进入音频层前才转成 0–1 增益 */
  function pctToGain(pct) {
    // 二次曲线：低音量区间更好调
    var x = clamp(pct, 0, 100) / 100;
    return x * x;
  }

  function showBoot() {
    if (!el.boot || !el.boot.hidden) return;
    el.boot.hidden = false;
    if (bootTimer) global.clearTimeout(bootTimer);
  }

  function hideBoot() {
    if (!el.boot) return;
    el.boot.hidden = true;
    if (bootTimer) { global.clearTimeout(bootTimer); bootTimer = null; }
  }

  /* 音频层未就绪时的降级处理：界面照常可用，只是没有声音 */
  function bootError(message) {
    if (!el.boot) return;
    var line = el.boot.querySelector('.boot__line');
    var sub = el.boot.querySelector('.boot__sub');
    if (line) line.textContent = 'AUDIO LINK FAILED';
    if (sub) sub.textContent = message || '无法启动音频上下文';
    bootTimer = global.setTimeout(hideBoot, 3200);
  }

  function ensureEngine() {
    if (engine || !global.AirWavesAudio) return engine;
    engine = new global.AirWavesAudio.AudioEngine({
      beat: state.beat,
      carrier: state.carrier,
      volume: pctToGain(state.volume)
    });
    return engine;
  }

  function startPlayback() {
    var eng = ensureEngine();
    if (!eng) {
      bootError('音频引擎未加载（audio.js）');
      return Promise.resolve(false);
    }

    state.busy = true;
    el.btnPlay.disabled = true;

    var wasRunning = eng.state() === 'running';
    if (!wasRunning) showBoot();

    return eng.play().then(function (ok) {
      state.busy = false;
      el.btnPlay.disabled = false;
      hideBoot();

      if (ok !== false) {
        state.playing = true;
        if (!state.startedAt) state.startedAt = Date.now() - state.elapsed;
        renderTransport();
      }
      return ok;
    }).catch(function (err) {
      state.busy = false;
      el.btnPlay.disabled = false;
      state.playing = false;
      renderTransport();
      bootError(eng.unsupportedReason() || (err && err.message) || '未知错误');
      return false;
    });
  }

  function stopPlayback() {
    if (!engine) {
      state.playing = false;
      renderTransport();
      return Promise.resolve();
    }

    state.playing = false;
    renderTransport();

    return engine.pause().catch(function () { /* 已暂停 */ });
  }

  function togglePlayback() {
    if (state.busy) return;
    return state.playing ? stopPlayback() : startPlayback();
  }

  /* ------------------------------ 交互：视图 ------------------------------ */

  /**
   * 切换到播放页。
   * @param {boolean} [autoPlay] 是否立即开始播放。默认 false ——
   *   进入电台后停在待机状态，由用户手动点 PLAY 启动
   *   （只有明确的"播放"指令，如按空格键，才传 true）。
   */
  function goPlayer(autoPlay) {
    state.view = 'player';
    state.startedAt = 0;
    state.elapsed = 0;
    el.roElapsed.textContent = '00:00';
    renderReadout();
    renderView();
    // 播放页此时才可见，需要重新测量画布尺寸
    global.requestAnimationFrame(setupCanvas);
    if (autoPlay === true) startPlayback();
  }

  function goHome() {
    state.view = 'home';
    stopPlayback();
    state.startedAt = 0;
    state.elapsed = 0;
    el.roElapsed.textContent = '00:00';
    renderView();
  }

  /* ------------------------------ 交互：参数 ------------------------------ */

  function setBand(key) {
    var band = BANDS[key];
    if (!band) return;

    state.band = key;
    state.beat = band.beat;
    state.carrier = band.carrier;

    Array.prototype.forEach.call(document.querySelectorAll('.seg__btn'), function (btn) {
      var active = btn.getAttribute('data-preset') === key;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-checked', active ? 'true' : 'false');
    });

    if (engine) {
      engine.setCarrier(state.carrier);
      engine.setBeat(state.beat);
    }

    renderReadout();
  }

  function setBeat(hz, fromSlider) {
    var next = clamp(Math.round(hz * 2) / 2, BEAT_MIN, BEAT_MAX);
    state.beat = next;

    // 滑块脱离预设值时，取消预设高亮
    if (fromSlider) {
      var band = bandOf(next);
      state.band = band.key;
      state.carrier = band.carrier;
      Array.prototype.forEach.call(document.querySelectorAll('.seg__btn'), function (btn) {
        var active = btn.getAttribute('data-preset') === band.key;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-checked', active ? 'true' : 'false');
      });
    }

    if (engine) engine.setBeat(next);
    renderReadout();
  }

  function setVolume(pct, opts) {
    opts = opts || {};
    var value = clamp(Number(pct), 0, 100);
    if (isNaN(value)) return;

    state.volume = value;
    if (!opts.silent) state.muted = value === 0;
    state.lastVolume = value > 0 ? value : state.lastVolume;

    if (engine) engine.setVolume(pctToGain(state.muted ? 0 : value));
    renderReadout();
  }

  function toggleMute() {
    if (state.muted) {
      var back = state.lastVolume > 0 ? state.lastVolume : DEFAULT_VOLUME;
      state.muted = false;
      setVolume(back, { silent: true });
    } else {
      state.lastVolume = Math.round(state.volume) || DEFAULT_VOLUME;
      state.muted = true;
      setVolume(0, { silent: true });
    }
  }

  function setMode(mode) {
    if (mode !== 'binaural' && mode !== 'isochronic') return;
    state.mode = mode;

    Array.prototype.forEach.call(document.querySelectorAll('.switch__btn[data-mode]'), function (btn) {
      var active = btn.getAttribute('data-mode') === mode;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-checked', active ? 'true' : 'false');
    });

    if (engine) engine.setIsochronic(mode === 'isochronic');
    renderReadout();
  }

  function setNoise(on) {
    state.noise = !!on;
    if (el.btnNoise) {
      el.btnNoise.classList.toggle('is-active', state.noise);
      el.btnNoise.textContent = state.noise ? 'ON' : 'OFF';
      el.btnNoise.setAttribute('aria-pressed', state.noise ? 'true' : 'false');
    }
    if (engine) engine.setNoise(state.noise);
  }

  /* ------------------------------ 电平表 / 波形 ------------------------------ */

  var canvas = { ctx: null, w: 0, h: 0, dpr: 1, waveBuf: null, lastDraw: 0 };

  function setupCanvas() {
    var c = el.wave;
    if (!c || !c.getContext) return;

    canvas.ctx = c.getContext('2d');
    // 分析器读取缓冲只分配一次，之后复用（避免渲染循环里的反复分配）
    if (!canvas.waveBuf) canvas.waveBuf = new Float32Array(2048);

    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    var rect = c.getBoundingClientRect();
    var w = Math.max(120, Math.round(rect.width || 300));
    var h = Math.max(40, Math.round(rect.height || 62));

    canvas.dpr = dpr;
    canvas.w = w;
    canvas.h = h;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);

    if (canvas.ctx) {
      canvas.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      canvas.ctx.lineJoin = 'round';
    }
  }

  function drawIdleWave() {
    var ctx = canvas.ctx;
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.w, canvas.h);

    // 网格
    ctx.strokeStyle = 'rgba(45,74,96,0.42)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var x = 0; x <= canvas.w; x += 40) {
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, canvas.h);
    }
    for (var y = 0; y <= canvas.h; y += 20) {
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(canvas.w, Math.round(y) + 0.5);
    }
    ctx.stroke();

    // 静默基线
    ctx.strokeStyle = 'rgba(111,227,255,0.34)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, canvas.h / 2 + 0.5);
    ctx.lineTo(canvas.w, canvas.h / 2 + 0.5);
    ctx.stroke();
  }

  function drawWave(wave, rms) {
    var ctx = canvas.ctx;
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.w, canvas.h);

    ctx.strokeStyle = 'rgba(45,74,96,0.34)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var x = 0; x <= canvas.w; x += 40) {
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, canvas.h);
    }
    ctx.stroke();

    var mid = canvas.h / 2;
    var amp = canvas.h * 0.44;
    var n = wave.length;
    var step = Math.max(1, Math.floor(n / canvas.w));

    ctx.beginPath();
    for (var i = 0, px = 0; i < n; i += step, px++) {
      var v = wave[i] * 2.6;                    // 视觉增益
      v = v > 1 ? 1 : (v < -1 ? -1 : v);
      var py = mid - v * amp;
      if (px === 0) ctx.moveTo(0, py);
      else ctx.lineTo((px / (n / step)) * canvas.w, py);
    }
    ctx.strokeStyle = 'rgba(111,227,255,0.92)';
    ctx.lineWidth = 1.35;
    ctx.stroke();

    // 电平着色（过载提示）
    if (rms > 0.28) {
      ctx.strokeStyle = 'rgba(200,65,47,0.55)';
      ctx.lineWidth = 2.4;
      ctx.stroke();
    }
  }

  function tick(ts) {
    global.requestAnimationFrame(tick);

    // 时钟
    var d = new Date();
    var hh = d.getHours(), mm = d.getMinutes(), ss = d.getSeconds();
    el.clock.textContent =
      (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm + ':' + (ss < 10 ? '0' : '') + ss;

    // 计时
    if (state.playing) {
      state.elapsed = Date.now() - state.startedAt;
      el.roElapsed.textContent = fmtTime(state.elapsed);
    }

    // 示波器/VU 按 ~20fps 刷新：分析器读取无需 60fps，
    // 且读取缓冲在启动时一次性分配并复用，避免渲染循环制造 GC 停顿导致音频断流咔哒
    if (!canvas.ctx || ts - canvas.lastDraw < 50) return;
    canvas.lastDraw = ts;

    if (state.playing && engine) {
      var res = engine.readLevel(canvas.waveBuf);
      if (res.wave) {
        drawWave(res.wave, res.rms);
        var level = clamp(res.rms / 0.32, 0, 1);
        el.vuFill.style.right = (100 - level * 100).toFixed(1) + '%';
        el.vuValue.textContent = fmtDb(res.rms);
        return;
      }
    }

    if (!state.playing) {
      el.vuFill.style.right = '100%';
      el.vuValue.textContent = '−∞ dB';
    }
    drawIdleWave();
  }

  /* ------------------------------ 事件绑定 ------------------------------ */

  function bind() {
    // 点 START 只进入电台，不自动播放；用户手动点 PLAY 启动
    el.btnStart.addEventListener('click', function () { goPlayer(); });
    el.btnBack.addEventListener('click', goHome);
    el.btnPlay.addEventListener('click', togglePlayback);

    Array.prototype.forEach.call(document.querySelectorAll('.seg__btn'), function (btn) {
      btn.addEventListener('click', function () {
        setBand(btn.getAttribute('data-preset'));
      });
    });

    el.beatRange.addEventListener('input', function () {
      setBeat(parseFloat(el.beatRange.value), true);
    });

    el.volRange.addEventListener('input', function () {
      state.muted = false;
      setVolume(parseFloat(el.volRange.value), { silent: true });
    });

    Array.prototype.forEach.call(document.querySelectorAll('.switch__btn[data-mode]'), function (btn) {
      btn.addEventListener('click', function () {
        setMode(btn.getAttribute('data-mode'));
      });
    });

    if (el.btnNoise) {
      el.btnNoise.addEventListener('click', function () { setNoise(!state.noise); });
    }

    document.addEventListener('keydown', function (ev) {
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      var tag = ev.target && ev.target.tagName;
      var typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

      if (ev.code === 'Space' || ev.key === ' ') {
        if (typing && ev.target.type !== 'range') return;
        ev.preventDefault();
        if (state.view !== 'player') goPlayer(true);
        else togglePlayback();
        return;
      }

      var key = (ev.key || '').toLowerCase();

      if (key === 'm') { ev.preventDefault(); toggleMute(); return; }

      if (ev.key === 'Escape') {
        if (state.view === 'player') { ev.preventDefault(); goHome(); }
        return;
      }

      if (typing) return;

      if (state.view !== 'player') return;

      if (key === '1') { ev.preventDefault(); setBand('theta'); }
      else if (key === '2') { ev.preventDefault(); setBand('alpha'); }
      else if (key === '3') { ev.preventDefault(); setBand('beta'); }
      else if (key === 'arrowup') { ev.preventDefault(); state.muted = false; setVolume(Math.min(100, Math.round(state.volume) + 5), { silent: true }); }
      else if (key === 'arrowdown') { ev.preventDefault(); state.muted = false; setVolume(Math.max(0, Math.round(state.volume) - 5), { silent: true }); }
      else if (key === 'arrowleft') { ev.preventDefault(); setBeat(state.beat - 0.5, true); }
      else if (key === 'arrowright') { ev.preventDefault(); setBeat(state.beat + 0.5, true); }
    });

    // 切到其他标签页时继续播放：电台应当能在后台正常发声，
    // 只有用户自己按暂停才停止。音频线程在后台不受标签页节流影响。

    global.addEventListener('resize', function () {
      setupCanvas();
      if (!state.playing) drawIdleWave();
    });

    // 播放页从隐藏到显示时尺寸会变化，用 ResizeObserver 兜底
    if (global.ResizeObserver && el.viewPlayer) {
      try {
        var ro = new global.ResizeObserver(function () {
          setupCanvas();
          if (!state.playing) drawIdleWave();
        });
        ro.observe(el.viewPlayer);
      } catch (e) { /* 忽略：resize 监听已覆盖 */ }
    }

    global.addEventListener('beforeunload', function () {
      if (engine) engine.destroy();
    });

    // 预加载播放页背景与人物图，避免首次切换闪白
    ['assets/scene/scene-player.png'].forEach(function (src, i) {
      var img = new Image();
      img.decoding = 'async';
      img.src = src;
      img.onerror = function () {
        if (i === 0) {
          // TODO: 场景图缺失时的占位处理（可在 assets/scene/scene-player.png 放置替换图）
          el.body.classList.add('fallback-bg');
        }
      };
    });
  }

  /* ------------------------------ 启动 ------------------------------ */

  function main() {
    if (!global.AirWavesAudio) {
      // audio.js 未加载时仍保证界面可用
      bootError('音频引擎未加载（audio.js）');
    }

    bind();
    setBand(DEFAULT_BAND);
    setVolume(DEFAULT_VOLUME, { silent: true });
    setMode('binaural');
    setNoise(false);
    renderTransport();
    renderView();

    setupCanvas();
    drawIdleWave();
    global.requestAnimationFrame(tick);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
})(window, document);
