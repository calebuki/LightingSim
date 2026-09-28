"""MIDI in: clock for sync + notes/CCs for pad controllers (MIDI learn)."""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Callable

log = logging.getLogger("lightsim.midi")

try:
    import mido
    mido.set_backend("mido.backends.rtmidi")
except Exception:  # pragma: no cover - optional
    mido = None


class MidiManager:
    def __init__(self, loop: asyncio.AbstractEventLoop, clock_sink, on_control: Callable[[str, float], None]):
        self.loop = loop
        self.clock_sink = clock_sink
        self.on_control = on_control
        self.ports: dict[str, object] = {}
        self.error = "" if mido else "MIDI unavailable (install mido + python-rtmidi)"

    def list_inputs(self) -> list[str]:
        if not mido:
            return []
        try:
            return sorted(set(mido.get_input_names()))
        except Exception as e:  # pragma: no cover
            self.error = str(e)
            return []

    def set_inputs(self, names: list[str]):
        if not mido:
            return
        for n in list(self.ports):
            if n not in names:
                try:
                    self.ports.pop(n).close()
                except Exception:
                    pass
        for n in names:
            if n in self.ports:
                continue
            try:
                self.ports[n] = mido.open_input(n, callback=lambda m, n=n: self._on_msg(n, m))
                log.info("MIDI input opened: %s", n)
            except Exception as e:
                self.error = f"{n}: {e}"
                log.warning("Could not open MIDI input %s: %s", n, e)
        self.clock_sink.port_name = ", ".join(self.ports)

    def close(self):
        self.set_inputs([])

    # called on the rtmidi thread
    def _on_msg(self, port: str, msg):
        t = time.perf_counter()
        typ = msg.type
        if typ == "clock":
            self.clock_sink.on_message("clock", t)
        elif typ in ("start", "stop", "continue"):
            self.clock_sink.on_message(typ, t)
        elif typ == "songpos":
            self.clock_sink.on_message("songpos", t, msg.pos)
        elif typ in ("note_on", "note_off"):
            vel = msg.velocity / 127.0 if typ == "note_on" else 0.0
            self.loop.call_soon_threadsafe(self.on_control, f"note:{msg.channel}:{msg.note}", vel)
        elif typ == "control_change":
            self.loop.call_soon_threadsafe(self.on_control, f"cc:{msg.channel}:{msg.control}", msg.value / 127.0)
