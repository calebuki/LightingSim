"""Engine sanity checks: timing, fallbacks, presets, outputs."""
import asyncio
import time

import numpy as np
import pytest

from lightsim.clock import BeatClock
from lightsim.engine import CompiledTrack, Engine, Layout
from lightsim.fixtures import make_fixture
from lightsim.outputs import dmx_values
from lightsim.presets import default_show, pat, track
from lightsim.show import Show


class FixedClock:
    def __init__(self, bpm=120.0):
        self.bpm, self.speed, self.b = bpm, 1.0, 0.0

    def beat(self, t=None):
        return self.b


def make_engine(tmp_path, fixtures=None, scenes=None):
    show = Show(tmp_path / "show.json")
    if fixtures is not None:
        show.data["fixtures"] = fixtures
    if scenes is not None:
        show.data["scenes"] = scenes
        show.data["bank"] = [s["id"] for s in scenes]
    eng = Engine(show, FixedClock())
    eng.current = show.data["bank"][0] if show.data["bank"] else None
    return eng


def test_all_presets_render(tmp_path):
    eng = make_engine(tmp_path)
    for sid in eng.show.data["bank"]:
        eng.current = sid
        for b in np.linspace(0, 32, 37):
            eng.clock.b = b
            eng.next_update[:] = 0
            frame, _ = eng.tick(time.perf_counter())
            assert len(frame) == eng.layout.P * 3


def test_render_is_fast(tmp_path):
    eng = make_engine(tmp_path)
    eng.current = next(s["id"] for s in eng.show.data["scenes"] if s["name"] == "Drop")
    t0 = time.perf_counter()
    for i in range(200):
        eng.clock.b = i * 0.03
        eng.tick(time.perf_counter())
    per_frame_ms = (time.perf_counter() - t0) / 200 * 1000
    assert per_frame_ms < 8, per_frame_ms


def _one(kind):
    return [make_fixture(kind, 0.5, 0.5)]


def test_fast_fixture_follows_16ths():
    lay = Layout(_one("strip_wled"), 1)
    ct = CompiledTrack(track("s", ["all"], {"type": "solid", "colors": ["white"]}, pat(16, 1, "x"), env="gate"), lay)
    beat_ms = 500.0  # 120 bpm
    on = ct.gate(np.array([0.01]), beat_ms, lay.min_pulse, lay.update_hz)[0]
    off = ct.gate(np.array([1 / 16 * 0.75]), beat_ms, lay.min_pulse, lay.update_hz)[0]
    assert on == 1.0 and off == 0.0


def test_slow_fixture_falls_back_to_slower_pulse():
    lay = Layout(_one("govee_string"), 1)  # min pulse 220ms, 10 Hz
    ct = CompiledTrack(track("s", ["all"], {"type": "solid", "colors": ["white"]}, pat(16, 1, "x"), env="gate"), lay)
    beat_ms = 500.0
    # 1/16 at 120bpm = 31ms steps; the Govee gets re-timed to 1/2-beat pulses (250 ms)
    vals = [ct.gate(np.array([b]), beat_ms, lay.min_pulse, lay.update_hz)[0] for b in np.arange(0, 1, 1 / 64)]
    changes = sum(1 for a, b in zip(vals, vals[1:]) if a != b)
    assert changes <= 4


def test_skip_fallback_blacks_out_slow_fixture():
    lay = Layout(_one("flood_relay"), 1)
    ct = CompiledTrack(track("s", ["all"], {"type": "solid", "colors": ["white"]}, pat(16, 1, "x"), env="gate",
                             fallback="skip"), lay)
    assert ct.gate(np.array([0.01]), 500.0, lay.min_pulse, lay.update_hz)[0] == 0.0


def test_alternate_spread():
    fx = [make_fixture("flood_dmx", 0.2, 0.5), make_fixture("flood_dmx", 0.8, 0.5)]
    lay = Layout(fx, 1)
    ct = CompiledTrack(track("s", ["all"], {"type": "solid"}, pat(4, 1, "x"), spread="alternate"), lay)
    g0 = ct.gate(np.array([0.01, 0.01]), 500.0, lay.min_pulse, lay.update_hz)
    g1 = ct.gate(np.array([0.26, 0.26]), 500.0, lay.min_pulse, lay.update_hz)
    assert list(g0) == [1.0, 0.0] and list(g1) == [0.0, 1.0]


def test_sample_and_hold_respects_update_rate(tmp_path):
    sc = {"id": "a", "name": "a", "bars": 1, "tracks": [
        track("s", ["all"], {"type": "rainbow", "rate": 0.1, "axis": "x"})]}
    eng = make_engine(tmp_path, _one("govee_string"), [sc])
    t = 1000.0
    eng.tick(t)
    first = eng.held.copy()
    eng.clock.b = 0.05
    eng.tick(t + 0.03)  # 30 ms later: a 10 Hz device must still show the old value
    assert np.allclose(first, eng.held)
    eng.tick(t + 0.2)
    assert not np.allclose(first, eng.held)


def test_launch_survives_clock_jumping_back(tmp_path):
    eng = make_engine(tmp_path)
    a, b = eng.show.data["bank"][:2]
    eng.current = a
    eng.clock.b = 100.3
    eng.launch(b, "bar", {"type": "fade", "beats": 2})
    eng.clock.b = 3.0  # Link session re-seated the timeline
    eng.tick(1.0)
    assert eng.current == b
    eng.clock.b = 1.0  # jumps again mid-transition: must not freeze
    eng.tick(1.1)
    eng.clock.b = 3.5
    eng.tick(1.2)
    assert eng.transition is None


def test_dmx_mapping():
    assert dmx_values(["dim", "r", "g", "b", "strobe"], np.array([1.0, 0.0, 0.0]), False, 1.0, 1.0) == [255, 255, 0, 0, 0]
    assert dmx_values(["dim"], np.array([0.5, 0.5, 0.5]), True, 1.0, 1.0) == [128]
    assert dmx_values(["r", "g", "b", "w", "0"], np.array([1.0, 1.0, 1.0]), False, 1.0, 1.0) == [0, 0, 0, 255, 0]


def test_tap_tempo():
    async def run():
        clk = BeatClock(asyncio.get_running_loop(), 100)
        base = time.perf_counter()
        import lightsim.clock as cm
        real = cm.now
        try:
            for i in range(5):
                cm.now = lambda i=i: base + i * 0.5
                clk.tap()
        finally:
            cm.now = real
        return clk.bpm
    assert abs(asyncio.run(run()) - 120.0) < 0.2


def test_show_roundtrip(tmp_path):
    s = Show(tmp_path / "x.json")
    s.save()
    s2 = Show(tmp_path / "x.json")
    assert len(s2.data["scenes"]) == len(default_show()["scenes"])
    assert len(s2.data["fixtures"]) == len(s.data["fixtures"])
