@echo off
setlocal
title Air-Waves Launcher

rem ============================================================
rem  Air-Waves one-click launcher
rem    1. find a free port on 127.0.0.1 and start a static server
rem    2. wait until it responds, then open the default browser
rem  To stop the server, close the window titled "Air-Waves Server".
rem  (Kept ASCII-only on purpose: cmd.exe reads .cmd files using the
rem   OEM codepage, so non-ASCII text here would break parsing.)
rem ============================================================

cd /d "%~dp0"

set "PORT="

rem Reuse an already-running instance instead of starting a second server
for %%P in (8765 8766 8767 8768 8769) do (
  if not defined PORT (
    powershell -NoProfile -Command "try { if ((Invoke-WebRequest -Uri 'http://127.0.0.1:%%P/index.html' -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
    if not errorlevel 1 (
      set "PORT=%%P"
      echo [Air-Waves] Reusing running server on port %%P
    )
  )
)

rem Otherwise start a new server on the first free port
if not defined PORT (
  for %%P in (8765 8766 8767 8768 8769) do (
    if not defined PORT (
      powershell -NoProfile -Command "try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', %%P); $c.Close(); exit 0 } catch { exit 1 }" >nul 2>&1
      if errorlevel 1 (
        set "PORT=%%P"
        echo [Air-Waves] Starting server on port %%P
        rem serve.py = stdlib http.server plus disabled caching, so the browser
        rem never serves a stale app.js / audio.js after an update.
        start "Air-Waves Server" /min cmd /k python "%~dp0serve.py" %%P -d "%~dp0."
      )
    )
  )
)

if not defined PORT (
  echo [Air-Waves] No free port in 8765-8769. Close whatever is using them and retry.
  echo.
  pause
  exit /b 1
)

rem Wait for the server to answer (about 15s max)
set /a WAITED=0
:waitloop
powershell -NoProfile -Command "try { if ((Invoke-WebRequest -Uri 'http://127.0.0.1:%PORT%/index.html' -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 goto ready
set /a WAITED+=1
if %WAITED% GEQ 30 goto failed
timeout /t 1 /nobreak >nul 2>&1
goto waitloop

:failed
echo.
echo [Air-Waves] Server failed to start. Make sure Python 3 is installed:
echo             python -m http.server 8765
echo.
pause
exit /b 1

:ready
echo [Air-Waves] Ready. Opening browser...
start "" "http://127.0.0.1:%PORT%/"
exit /b 0
