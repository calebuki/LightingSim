@echo off
rem Run from source on Windows. First run sets things up (needs Python 3.10+ from python.org).
rem After that it opens the LightingSim app window and this console closes itself.
cd /d "%~dp0"
where py >nul 2>nul && (set PY=py -3) || (set PY=python)
if not exist .venv\Scripts\pythonw.exe (
  echo Setting up LightingSim for the first time...
  %PY% -m venv .venv || (echo Python 3.10+ is required: https://www.python.org/downloads/ & pause & exit /b 1)
  .venv\Scripts\python -m pip install --upgrade pip >nul
  .venv\Scripts\python -m pip install aiohttp numpy pyserial pywebview || (pause & exit /b 1)
  .venv\Scripts\python -m pip install aalink mido python-rtmidi || echo Note: Link/MIDI extras failed to install; manual tempo still works.
)
.venv\Scripts\python -c "import webview" 2>nul || .venv\Scripts\python -m pip install pywebview
start "" .venv\Scripts\pythonw.exe -m lightsim %*
