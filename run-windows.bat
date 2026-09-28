@echo off
rem One-click run from source on Windows. First run sets things up (needs Python 3.10+ from python.org).
cd /d "%~dp0"
where py >nul 2>nul && (set PY=py -3) || (set PY=python)
if not exist .venv\Scripts\python.exe (
  echo Setting up LightingSim for the first time...
  %PY% -m venv .venv || (echo Python 3.10+ is required: https://www.python.org/downloads/ & pause & exit /b 1)
  .venv\Scripts\python -m pip install --upgrade pip >nul
  .venv\Scripts\python -m pip install aiohttp numpy pyserial || (pause & exit /b 1)
  .venv\Scripts\python -m pip install aalink mido python-rtmidi || echo Note: Link/MIDI extras failed to install; manual tempo still works.
)
.venv\Scripts\python -m lightsim %*
pause
