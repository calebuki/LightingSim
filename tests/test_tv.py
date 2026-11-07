"""The TV: a rig member with no pixels, driven by the same scenes and clock as the lights."""
import asyncio
import json
import re
import time
from pathlib import Path

import numpy as np
from aiohttp.test_utils import TestClient, TestServer

from lightsim.app import build_app
from lightsim.engine import CompiledTrack, Engine, Layout
from lightsim.fixtures import make_fixture, normalize_fixture
from lightsim.presets import SCENE_VISUALS, default_scenes, default_show, pat, track
from lightsim.show import Show

LIBRARY = Path(__file__).resolve().parent.parent / "web" / "js" / "visuals" / "library.js"


class FixedClock:
    def __init__(self, bpm=120.0):
        self.bpm, self.speed, self.b = bpm, 1.0, 0.0

    def beat(self, t=None):
        return self.b


def library_ids():
    return set(re.findall(r"\{ id: '(\w+)', name:", LIBRARY.read_text("utf-8")))


def test_tv_has_no_pixels_even_after_normalizing():
    tv = normalize_fixture(make_fixture("tv", 0.5, 0.3))
    assert tv["pixels"] == 0 and tv["shape"] == "screen" and tv["group"] == "screens"


def test_tv_never_joins_a_light_chase():
    lights = [make_fixture("bulb_diy", 0.2, 0.5), make_fixture("tv", 0.5, 0.3), make_fixture("bulb_diy", 0.8, 0.5)]
    lay = Layout(lights, 1)
    assert lay.P == 2
    assert 1 not in lay.targets(["all"])
    assert 1 not in lay.targets(["screens"])
    ct = CompiledTrack(track("c", ["all"], {"type": "solid", "colors": ["white"]}, pat(1, 1, "x"), spread="chase"), lay)
    assert ct.n == 2  # a chase over all lights has two steps, not three with a dark hole


def test_every_preset_renders_with_a_tv_in_the_rig(tmp_path):
    show = Show(tmp_path / "show.json")
    assert any(f["shape"] == "screen" for f in show.data["fixtures"])
    eng = Engine(show, FixedClock())
    for sid in show.data["bank"]:
        eng.current = sid
        for b in np.linspace(0, 16, 9):
            eng.clock.b = b
            eng.next_update[:] = 0
            frame, _ = eng.tick(time.perf_counter())
            assert len(frame) == eng.layout.P * 3


def test_scenes_still_change_on_a_rig_with_only_a_tv(tmp_path):
    show = Show(tmp_path / "show.json")
    show.data["fixtures"] = [make_fixture("tv", 0.5, 0.3)]
    eng = Engine(show, FixedClock())
    a, b = show.data["bank"][:2]
    eng.current = a
    eng.launch(b, "now", {"type": "fade", "beats": 2})
    eng.tick(time.perf_counter())
    assert eng.current == b
    assert eng.transition["from"] == a
    eng.clock.b = 3.0
    eng.tick(time.perf_counter())
    assert eng.transition is None


def test_status_gives_the_tv_what_it_needs_to_stay_on_the_beat(tmp_path):
    show = Show(tmp_path / "show.json")
    eng = Engine(show, FixedClock())
    a, b = show.data["bank"][:2]
    eng.current = a
    eng.launch(b, "bar", {"type": "wipe", "beats": 4})
    q = eng.status()["queued"]
    assert q["scene"] == b and q["tr"] == {"type": "wipe", "beats": 4}
    eng.clock.b = q["at"]
    eng.tick(time.perf_counter())
    tr = eng.status()["transition"]
    assert tr["type"] == "wipe" and tr["beats"] == 4 and tr["start"] == q["at"]


def test_old_show_files_gain_a_tv_once(tmp_path):
    old = default_show()
    old["version"] = 1
    old["fixtures"] = [f for f in old["fixtures"] if f["shape"] != "screen"]
    for s in old["scenes"]:
        s.pop("visual", None)
    old["settings"]["theme"] = "daylight"
    old["palette"] = {"name": "Neon", "colors": ["#ff2d95", "#00e5ff", "#7c4dff", "#ffffff"]}
    path = tmp_path / "show.json"
    path.write_text(json.dumps(old), "utf-8")

    show = Show(path)
    assert sum(f["shape"] == "screen" for f in show.data["fixtures"]) == 1
    assert all("visual" in s for s in show.data["scenes"])
    assert show.data["settings"]["theme"] == "light"
    assert show.data["palette"]["name"] == "Dusk"
    assert show.data["version"] == 2

    show.save()
    again = Show(path)
    assert sum(f["shape"] == "screen" for f in again.data["fixtures"]) == 1


def test_a_removed_tv_stays_removed(tmp_path):
    path = tmp_path / "show.json"
    show = Show(path)
    show.data["fixtures"] = [f for f in show.data["fixtures"] if f["shape"] != "screen"]
    show.save()
    assert not any(f["shape"] == "screen" for f in Show(path).data["fixtures"])


def test_preset_visuals_exist_in_the_library():
    ids = library_ids() | {"none"}
    assert len(library_ids()) >= 30
    assert {v["id"] for v in SCENE_VISUALS.values()} <= ids
    assert all(s["visual"]["id"] in ids for s in default_scenes())


def test_tv_page_and_bundled_fonts_are_served(tmp_path):
    async def go():
        app = build_app(Show(tmp_path / "show.json"), 0, False)
        async with TestClient(TestServer(app)) as client:
            page = await client.get("/tv")
            assert page.status == 200
            assert 'id="screen"' in await page.text()
            font = await client.get("/static/fonts/jetbrains-mono-500.woff2")
            assert font.status == 200
            index = await (await client.get("/")).text()
            assert "fonts.googleapis.com" not in index  # works with no internet

    asyncio.run(go())


def test_a_new_tv_can_join_a_group(tmp_path):
    tv = normalize_fixture(make_fixture("tv", 0.5, 0.3, wall="A", size=0.8))
    assert tv["wall"] == "A" and tv["size"] == 0.8
    assert normalize_fixture(make_fixture("tv", 0.5, 0.3))["wall"] == ""


def test_energy_fader_moves_a_shared_phase(tmp_path):
    show = Show(tmp_path / "show.json")
    eng = Engine(show, FixedClock())
    show.data["settings"]["tv"]["energy"] = 1.0
    eng.clock.b = 10.0
    eng.tick(time.perf_counter())
    eng.clock.b = 10.5
    eng.tick(time.perf_counter())
    assert abs(eng.status()["tv_phase"] - 0.25) < 1e-6
    show.data["settings"]["tv"]["energy"] = 0.5
    eng.clock.b = 11.0
    eng.tick(time.perf_counter())
    assert abs(eng.status()["tv_phase"] - 0.25) < 1e-6
