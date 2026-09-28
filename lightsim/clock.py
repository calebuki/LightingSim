"""Beat clock: where are we in the music right now?

Sources (pick one in Settings):
- "link"     Ableton Link. rekordbox (Performance mode -> LINK) shares tempo and
             bar phase over the network. Zero extra hardware.
- "midi"     MIDI clock in (24 ppqn) from any app/hardware that sends it.
- "internal" Manual BPM + tap tempo. Works with anything, even vinyl.

All sources expose beat(t) -> float beats on the perf_counter() timeline, so the
engine can render ahead of time to cancel out each light's network latency.
"""
from __future__ import annotations

import asyncio
import math
import threading
import time
from collections import deque

try:
    import aalink  # Ableton Link bindings (prebuilt wheels for Win/Mac/Linux)
except Exception:  # pragma: no cover - optional
    aalink = None

now = time.perf_counter


class InternalSource:
    name = "internal"

    def __init__(self, bpm: float = 124.0):
        self.bpm = bpm
        self.anchor_t = now()
        self.anchor_beat = 0.0

    def beat(self, t: float) -> float:
        return self.anchor_beat + (t - self.anchor_t) * self.bpm / 60.0

    def set_bpm(self, bpm: float):
        t = now()
        self.anchor_beat = self.beat(t)
        self.anchor_t = t
        self.bpm = bpm

    def shift(self, beats: float):
        self.anchor_beat += beats

    def status(self) -> dict:
        return {"ok": True, "detail": "Manual / tap tempo"}


class LinkSource:
    name = "link"

    def __init__(self, bpm: float, loop: asyncio.AbstractEventLoop):
        self.available = aalink is not None
        self.link = None
        self.error = ""
        if self.available:
            try:
                self.link = aalink.Link(bpm)
                self.link.quantum = 4  # one bar: shares downbeats with rekordbox
                self.link.enabled = True
            except Exception as e:  # pragma: no cover
                self.error = str(e)
                self.link = None

    @property
    def bpm(self) -> float:
        return float(self.link.tempo) if self.link else 120.0

    def beat(self, t: float) -> float:
        if not self.link:
            return 0.0
        b = float(self.link.beat)
        return b + (t - now()) * self.bpm / 60.0

    def set_bpm(self, bpm: float):
        if self.link:
            self.link.tempo = bpm

    def shift(self, beats: float):
        pass  # phase belongs to the Link session; use the clock offset instead

    def close(self):
        if self.link:
            self.link.enabled = False

    def status(self) -> dict:
        if not self.link:
            return {"ok": False, "detail": "Link unavailable: " + (self.error or "install 'aalink'")}
        peers = int(self.link.num_peers)
        return {
            "ok": peers > 0,
            "peers": peers,
            "detail": f"{peers} Link peer{'s' if peers != 1 else ''}" if peers else "Waiting for rekordbox (turn on LINK)",
        }


class MidiClockSource:
    """Beat position from 24-ppqn MIDI clock. Messages are fed from the MIDI thread."""

    name = "midi"

    def __init__(self, bpm: float = 120.0):
        self._lock = threading.Lock()
        self.ticks = 0
        self.last_tick_t = now()
        self.tick_dt = 60.0 / bpm / 24.0
        self.intervals: deque[float] = deque(maxlen=48)
        self.running = False
        self.last_msg_t = 0.0
        self.port_name = ""

    @property
    def bpm(self) -> float:
        return 60.0 / (self.tick_dt * 24.0)

    def on_message(self, kind: str, t: float, value: int = 0):
        with self._lock:
            self.last_msg_t = t
            if kind == "clock":
                dt = t - self.last_tick_t
                if 0.002 < dt < 0.1:
                    self.intervals.append(dt)
                    self.tick_dt = sorted(self.intervals)[len(self.intervals) // 2]
                self.ticks += 1
                self.last_tick_t = t
            elif kind == "start":
                self.ticks = 0
                self.running = True
                self.last_tick_t = t
            elif kind == "continue":
                self.running = True
            elif kind == "stop":
                self.running = False
            elif kind == "songpos":
                self.ticks = value * 6

    def beat(self, t: float) -> float:
        with self._lock:
            frac = min(1.0, max(0.0, (t - self.last_tick_t) / self.tick_dt))
            if t - self.last_tick_t > 0.25:  # clock stopped: free-run at last tempo
                frac = (t - self.last_tick_t) / self.tick_dt
            return (self.ticks + frac) / 24.0

    def set_bpm(self, bpm: float):
        pass  # tempo comes from the sender

    def shift(self, beats: float):
        with self._lock:
            self.ticks += int(round(beats * 24))

    def status(self) -> dict:
        alive = now() - self.last_msg_t < 1.0
        return {
            "ok": alive,
            "detail": (f"MIDI clock from {self.port_name}" if alive else "No MIDI clock received")
            if self.port_name else "Pick a MIDI input in Settings",
        }


class BeatClock:
    def __init__(self, loop: asyncio.AbstractEventLoop, bpm: float = 124.0):
        self.loop = loop
        self.internal = InternalSource(bpm)
        self.midi = MidiClockSource(bpm)
        self.link: LinkSource | None = None
        self.source = self.internal
        self.offset = 0.0  # user bar/phrase realignment in beats
        self.speed = 1.0   # half-time / double-time applied to pattern playback
        self.taps: deque[float] = deque(maxlen=8)
        self._speed_anchor = (0.0, 0.0)  # (raw beat, scaled beat) so speed changes don't jump

    # -- source selection ---------------------------------------------------------
    def use(self, name: str):
        if name == self.source.name:
            return
        before = self.beat()
        if name == "link":
            if self.link is None:
                self.link = LinkSource(self.source.bpm, self.loop)
            self.source = self.link
        elif name == "midi":
            self.source = self.midi
        else:
            self.internal.set_bpm(self.source.bpm)
            self.source = self.internal
        # keep bar position continuous across the switch when phase is ours to set
        if self.source is self.internal:
            self.internal.anchor_beat += before - self.beat()

    def close(self):
        if self.link:
            self.link.close()

    # -- time -----------------------------------------------------------------------
    @property
    def bpm(self) -> float:
        return self.source.bpm

    def raw_beat(self, t: float | None = None) -> float:
        return self.source.beat(now() if t is None else t) + self.offset

    def beat(self, t: float | None = None) -> float:
        """Pattern beat position, with half/double-time applied."""
        raw = self.raw_beat(t)
        r0, s0 = self._speed_anchor
        return s0 + (raw - r0) * self.speed

    def set_speed(self, speed: float):
        raw = self.raw_beat()
        self._speed_anchor = (raw, self.beat())  # continuous: no jump in the pattern
        self.speed = speed

    # -- performer controls ---------------------------------------------------------
    def set_bpm(self, bpm: float):
        bpm = max(40.0, min(240.0, float(bpm)))
        self.source.set_bpm(bpm)

    def tap(self):
        t = now()
        if self.taps and t - self.taps[-1] > 2.0:
            self.taps.clear()
        self.taps.append(t)
        if len(self.taps) >= 3:
            iv = [b - a for a, b in zip(self.taps, list(self.taps)[1:])]
            iv.sort()
            bpm = 60.0 / iv[len(iv) // 2]
            self.set_bpm(round(bpm * 10) / 10)
            if self.source is self.internal:  # land the tap exactly on a beat
                b = self.internal.beat(t)
                self.internal.anchor_beat -= b - round(b)

    def nudge(self, beats: float):
        self.offset += beats

    def align(self, period: int):
        """'This moment is the 1' - realign bar (4) or phrase (32) to now."""
        b = self.raw_beat()
        d = b % period
        if d > period / 2:
            d -= period
        if self.source is self.internal:
            self.offset -= d  # full phase, tap-accurate
        else:
            self.offset -= round(d)  # keep the external sub-beat phase

    def status(self) -> dict:
        s = self.source.status()
        return {"source": self.source.name, "bpm": round(self.bpm, 2), "speed": self.speed, **s}


def fmod(a: float, b: float) -> float:
    return a - b * math.floor(a / b)
