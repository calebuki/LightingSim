#!/bin/bash
# Run from source on macOS (double-click in Finder). Also works on Linux.
# Opens the LightingSim app window; you can close this Terminal window afterwards.
cd "$(dirname "$0")"
PY=python3
if [ ! -x .venv/bin/python ]; then
  echo "Setting up LightingSim for the first time..."
  $PY -m venv .venv || { echo "Python 3.10+ is required: https://www.python.org/downloads/"; read -r; exit 1; }
  .venv/bin/python -m pip install --upgrade pip >/dev/null
  .venv/bin/python -m pip install aiohttp numpy pyserial pywebview || { read -r; exit 1; }
  .venv/bin/python -m pip install aalink mido python-rtmidi || echo "Note: Link/MIDI extras failed to install; manual tempo still works."
fi
.venv/bin/python -c "import webview" 2>/dev/null || .venv/bin/python -m pip install pywebview
nohup .venv/bin/python -m lightsim "$@" >/dev/null 2>&1 &
disown
osascript -e 'tell application "Terminal" to close front window' >/dev/null 2>&1 &
exit 0
