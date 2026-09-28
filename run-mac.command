#!/bin/bash
# One-click run from source on macOS (double-click in Finder). Also works on Linux.
cd "$(dirname "$0")"
PY=python3
if [ ! -x .venv/bin/python ]; then
  echo "Setting up LightingSim for the first time..."
  $PY -m venv .venv || { echo "Python 3.10+ is required: https://www.python.org/downloads/"; read -r; exit 1; }
  .venv/bin/python -m pip install --upgrade pip >/dev/null
  .venv/bin/python -m pip install aiohttp numpy pyserial || { read -r; exit 1; }
  .venv/bin/python -m pip install aalink mido python-rtmidi || echo "Note: Link/MIDI extras failed to install; manual tempo still works."
fi
exec .venv/bin/python -m lightsim "$@"
