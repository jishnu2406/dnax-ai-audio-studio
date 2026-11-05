@echo off
setlocal
cd /d "%~dp0"

set "DNAX_LAUNCH_PORT=%PORT%"
if not defined DNAX_LAUNCH_PORT set "DNAX_LAUNCH_PORT=4317"
set "DNAX_LAUNCH_URL=http://127.0.0.1:%DNAX_LAUNCH_PORT%/#video"

where node.exe >nul 2>&1
if errorlevel 1 (
  echo Node.js 20 or newer is required. Install it from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)
node.exe -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)" >nul 2>&1
if errorlevel 1 (
  echo This app requires Node.js 20 or newer. Update Node.js and run this file again.
  pause
  exit /b 1
)

call :app_running
if not errorlevel 1 goto open_app

if not defined RVC_PYTHON if not exist ".venv\Scripts\python.exe" goto setup
if not exist "vendor\rvc\webui.py" goto setup
if not exist "vendor\rvc\assets\hubert_base\config.json" goto setup
if not exist "vendor\rvc\assets\hubert_base\preprocessor_config.json" goto setup
if not exist "vendor\rvc\assets\hubert_base\pytorch_model.bin" goto setup
if not exist "vendor\rvc\assets\rmvpe\rmvpe.pt" goto setup
if not exist "vendor\rvc\assets\pretrained_v2\f0G40k.pth" goto setup
if not exist "vendor\rvc\assets\pretrained_v2\f0D40k.pth" goto setup
if not exist "vendor\rvc\logs\mute\0_gt_wavs\mute40k.wav" goto setup
if not exist "vendor\rvc\ffmpeg.exe" goto setup
if not exist "vendor\rvc\ffprobe.exe" goto setup
goto launch

:setup
echo First-time setup is required. This downloads Python packages and model files.
if /I "%~1"=="cpu" goto setup_cpu
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
goto setup_done

:setup_cpu
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" -Cpu

:setup_done
if errorlevel 1 (
  echo Setup failed. Review the message above, then run this file again.
  pause
  exit /b 1
)

:launch
echo Starting DNAX.ai Audio Studio on %DNAX_LAUNCH_URL%
echo Keep the server window open while using the app. Press Ctrl+C there to stop it.
start "DNAX.ai Audio Studio server" /D "%~dp0" cmd.exe /k "node server.mjs"
for /L %%I in (1,1,30) do (
  call :app_running
  if not errorlevel 1 goto open_app
  timeout /t 1 /nobreak >nul
)
echo The server did not become ready. Check the DNAX.ai Audio Studio server window.
pause
exit /b 1

:open_app
start "" "%DNAX_LAUNCH_URL%"
exit /b 0

:app_running
powershell.exe -NoProfile -Command "try { $status = Invoke-RestMethod -Uri 'http://127.0.0.1:%DNAX_LAUNCH_PORT%/api/status' -TimeoutSec 2; if ($status.repository -eq 'RVC-Project/Retrieval-based-Voice-Conversion-WebUI') { exit 0 } } catch {} ; exit 1" >nul 2>&1
exit /b %errorlevel%
