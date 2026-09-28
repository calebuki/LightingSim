"""Built-in palettes, demo rig and default scenes (presets).

Scenes target fixture *groups* (floods / strips / strings / bulbs), so they work
on any rig you build - move or add lights and the presets follow.
"""
from __future__ import annotations

from .fixtures import make_fixture, new_id

PALETTES = [
    {"name": "Neon", "colors": ["#ff2d95", "#00e5ff", "#7c4dff", "#ffffff"]},
    {"name": "Sunset", "colors": ["#ff6b2d", "#ff2d55", "#ffc53d", "#8a2be2"]},
    {"name": "Ice", "colors": ["#00b7ff", "#e6f7ff", "#3d5afe", "#9ffcff"]},
    {"name": "Acid", "colors": ["#b6ff00", "#00ffa3", "#ff00e6", "#fff200"]},
    {"name": "Ember", "colors": ["#ff3d00", "#ffb300", "#ff1744", "#ffe0b2"]},
    {"name": "Miami", "colors": ["#ff4fd8", "#2de2e6", "#f9c80e", "#fd3777"]},
    {"name": "Forest", "colors": ["#00c853", "#aeea00", "#00bfa5", "#fff59d"]},
    {"name": "Mono", "colors": ["#ffffff", "#c8d2ff", "#ffe6c8", "#ffffff"]},
]


def pat(div: int, bars: int, pattern: str) -> dict:
    """Steps from a drum-machine string: x = full, o = half, . = off (repeats to fill)."""
    n = bars * 4 * div
    vals = [1.0 if c == "x" else 0.5 if c == "o" else 0.0 for c in pattern if c in "xo."]
    vals = (vals * (n // max(1, len(vals)) + 1))[:n]
    return {"div": div, "bars": bars, "steps": vals}


def track(name, target, effect, gate=None, level=1.0, blend="max", **gx):
    g = {"div": 1, "bars": 1, "steps": [1.0] * 4, "env": "hold", "duty": 0.5,
         "spread": "all", "fallback": "pulse", "swing": 0.0}
    g.update(gate or {})
    g.update(gx)
    return {"id": new_id("tr"), "name": name, "target": target, "effect": effect, "gate": g,
            "level": level, "blend": blend, "mute": False, "solo": False}


def solid(*c):
    return {"type": "solid", "colors": list(c) or ["p0"]}


def scene(name, bars, color, tracks, utility=False):
    return {"id": new_id("sc"), "name": name, "bars": bars, "color": color, "tracks": tracks,
            "utility": utility, "builtin": True}


def default_scenes() -> list[dict]:
    ALL = ["all"]
    build = pat(4, 8, "x..." * 16 + "x.x." * 8 + "xxxx" * 8)
    build_ramp = {"div": 1, "bars": 8, "steps": [round(0.08 + 0.92 * (i / 31) ** 1.6, 3) for i in range(32)]}
    return [
        scene("Warm Glow", 4, "#ffb347", [
            track("Wash", ALL, {"type": "gradient", "colors": ["p0", "p1"], "axis": "x", "rate": 16, "cycles": 0.5}, level=0.55),
            track("Candles", ["bulbs"], {"type": "flicker", "colors": ["#ffb347", "#ff6a00"], "depth": 0.45}, level=0.9),
        ]),
        scene("Four on the Floor", 1, "#ff2d95", [
            track("Kick", ["floods"], solid("p0"), pat(1, 1, "x"), env="decay", duty=0.7),
            track("Strip wave", ["strips"], {"type": "wave", "colors": ["p0", "p1"], "axis": "x", "rate": 2, "cycles": 1}),
            track("Strings", ["strings"], {"type": "cycle", "colors": ["p1", "p2"], "rate": 4, "fade": 0.5}, level=0.6),
            track("Bulb chase", ["bulbs"], solid("p2"), pat(1, 1, "x"), env="decay", duty=0.9, spread="chase"),
        ]),
        scene("Offbeat Hats", 1, "#00e5ff", [
            track("Kick", ["floods"], solid("p0"), pat(1, 1, "x"), env="decay", duty=0.5, level=0.6),
            track("Hats", ["strips"], solid("white"), pat(2, 1, ".x"), env="decay", duty=0.6),
            track("Bulbs", ["bulbs"], solid("p1"), pat(2, 1, ".x"), env="decay", duty=0.8, spread="alternate"),
            track("Strings", ["strings"], {"type": "cycle", "colors": ["p0", "p1"], "rate": 8, "fade": 0.6}, level=0.5),
        ]),
        scene("Alternating Strobe", 1, "#ffffff", [
            track("Floods", ["floods"], solid("white"), pat(16, 1, "x"), env="gate", duty=0.5, spread="alternate"),
            track("Strips", ["strips"], solid("white"), pat(8, 1, "x"), env="gate", duty=0.5, spread="alternate"),
            track("Bulbs", ["bulbs"], solid("white"), pat(16, 1, "x"), env="gate", duty=0.5, spread="alternate"),
            track("Strings", ["strings"], solid("p0"), fallback="hold", level=0.45),
        ]),
        scene("Rainbow Sweep", 8, "#7c4dff", [
            track("Rainbow", ALL, {"type": "rainbow", "axis": "x", "rate": 8, "cycles": 1}),
            track("Beat lift", ["floods"], solid("white"), pat(1, 1, "x"), env="decay", duty=0.5, level=0.35, blend="add"),
        ]),
        scene("Left-Right Chase", 1, "#2de2e6", [
            track("Sweep", ALL, {"type": "sweep", "colors": ["p0", "p1"], "axis": "x", "rate": 2, "width": 0.22,
                                 "bounce": True, "bg": 0.12}),
        ]),
        scene("Center Burst", 1, "#ff6b2d", [
            track("Burst", ALL, {"type": "sweep", "colors": ["p1", "p0"], "axis": "radial", "rate": 1, "width": 0.3, "bg": 0.1}),
            track("Kick", ["floods"], solid("white"), pat(1, 1, "x"), env="decay", duty=0.4, level=0.7),
        ]),
        scene("Build-Up (8 bars)", 8, "#fff200", [
            track("Riser strobe", ["floods"], solid("white"), build, env="gate", duty=0.5),
            track("Swell", ["strips", "strings"], {"type": "sweep", "colors": ["p0"], "axis": "radial", "rate": 1, "width": 0.35},
                  build_ramp, env="smooth"),
            track("Fill", ["bulbs"], solid("p1"), pat(1, 8, "x"), spread="fill"),
        ]),
        scene("Drop", 1, "#ff00e6", [
            track("Floods", ["floods"], solid("white"), pat(2, 1, "x"), env="decay", duty=0.6, spread="alternate"),
            track("Strips", ["strips"], {"type": "rainbow", "axis": "x", "rate": 1, "cycles": 2}, pat(4, 1, "x.xx"), env="decay", duty=0.9),
            track("Strings", ["strings"], {"type": "cycle", "colors": ["p0", "p1", "p2"], "rate": 1, "fade": 0.4}),
            track("Bulbs", ["bulbs"], solid("p0"), pat(4, 1, "x"), env="decay", duty=0.8, spread="random"),
        ]),
        scene("Sparkle Night", 4, "#9ffcff", [
            track("Glints", ["strips", "strings"], {"type": "sparkle", "colors": ["white", "p1"], "rate": 0.25, "density": 0.14}),
            track("Base", ["strips", "strings"], solid("p2"), level=0.12),
            track("Candles", ["bulbs"], {"type": "flicker", "colors": ["#ffcf8a", "#ff7a1a"], "depth": 0.5}, level=0.7),
            track("Floods", ["floods"], solid("p2"), level=0.18),
        ]),
        scene("Split Colors", 2, "#f9c80e", [
            track("Split", ALL, {"type": "split", "colors": ["p0", "p1"], "rate": 4}),
            track("Pulse", ["floods", "bulbs"], solid("white"), pat(1, 1, "x"), env="decay", duty=0.35, level=0.4, blend="add"),
        ]),
        scene("Ocean Breakdown", 8, "#0050ff", [
            track("Waves", ALL, {"type": "wave", "colors": ["#00e5ff", "#0033ff"], "axis": "x", "rate": 8, "cycles": 1.5, "depth": 0.55}),
            track("Breath", ["bulbs"], solid("#9ffcff"), pat(1, 2, "x..."), env="smooth", level=0.6),
        ]),
        scene("Snare 2 & 4", 1, "#fd3777", [
            track("Snare", ["floods"], solid("white"), pat(1, 1, ".x"), env="decay", duty=0.5),
            track("Kick bulbs", ["bulbs"], solid("p1"), pat(1, 1, "x."), env="decay", duty=0.9),
            track("Bed", ["strips", "strings"], {"type": "gradient", "colors": ["p0", "p2"], "axis": "x", "rate": 8}, level=0.45),
        ]),
        scene("Triplet Chase", 1, "#00ffa3", [
            track("Chase", ["floods", "bulbs"], solid("p0"), pat(3, 1, "x"), env="decay", duty=0.9, spread="bounce"),
            track("Strips", ["strips", "strings"], {"type": "sweep", "colors": ["p1"], "axis": "x", "rate": 1.3333, "width": 0.18}),
        ]),
        scene("32nd Roll", 1, "#e6f7ff", [
            track("Roll", ["strips", "bulbs"], solid("white"), pat(32, 1, "x"), env="gate", duty=0.5),
            track("Floods", ["floods"], solid("white"), pat(32, 1, "x"), env="gate", duty=0.5, spread="alternate"),
            track("Strings", ["strings"], solid("p0"), fallback="hold", level=0.4),
        ]),
        scene("Palette Cycle", 4, "#8a2be2", [
            track("Cycle", ALL, {"type": "cycle", "colors": ["p0", "p1", "p2"], "rate": 4, "fade": 0.35, "axis": "x", "spread": 0.6}),
        ]),
        scene("Full White", 1, "#f4f7ff", [track("White", ALL, solid("white"))], utility=True),
        scene("Dark", 1, "#1b1b24", [], utility=True),
    ]


def demo_rig() -> list[dict]:
    fx = []
    fx.append(make_fixture("flood_dmx", 0.07, 0.16, name="Flood TL", angle=50))
    fx.append(make_fixture("flood_dmx", 0.93, 0.16, name="Flood TR", angle=130))
    fx.append(make_fixture("strobe_dmx", 0.33, 0.93, name="Strobe L", angle=-90))
    fx.append(make_fixture("strobe_dmx", 0.67, 0.93, name="Strobe R", angle=-90))
    # DMX addresses: 5ch floods at 1 and 6, 1ch strobes at 11 and 12
    fx[0]["patch"]["address"] = 1
    fx[1]["patch"]["address"] = 6
    fx[2]["patch"]["address"] = 11
    fx[3]["patch"]["address"] = 12
    fx.append(make_fixture("govee_string", 0.04, 0.07, name="Govee String L", x2=0.5, y2=0.09, sag=0.09))
    fx.append(make_fixture("govee_string", 0.5, 0.09, name="Govee String R", x2=0.96, y2=0.07, sag=0.09))
    fx.append(make_fixture("strip_wled", 0.12, 0.8, name="Strip L", x2=0.48, y2=0.8))
    s2 = make_fixture("strip_wled", 0.52, 0.8, name="Strip R", x2=0.88, y2=0.8)
    s2["patch"]["start"] = 60
    fx.append(s2)
    kinds = ["bulb_wiz", "bulb_diy", "bulb_incandescent", "bulb_incandescent", "bulb_diy", "bulb_wiz"]
    for i, k in enumerate(kinds):
        b = make_fixture(k, 0.22 + i * 0.112, 0.48, name=f"Bulb {i + 1}")
        if k == "bulb_incandescent":
            b["patch"]["address"] = 13 + (i - 2)
        fx.append(b)
    return fx


def default_settings() -> dict:
    return {
        "clock_source": "internal",
        "bpm": 124.0,
        "midi_inputs": [],
        "midi_map": {},
        "launch_quantize": "bar",
        "transition": {"type": "fade", "beats": 2},
        "autopilot": {"enabled": False, "every_bars": 16, "order": "shuffle", "playlist": []},
        "max_flash_hz": 0,
        "strobe_div": 16,
        "flash_color": "#ffffff",
        "fps": 60,
        "output_enabled": False,
        "dmx_interfaces": [{"id": "dmx1", "type": "none", "port": "", "host": "", "universe": 0}],
        "lan_access": False,
        "theme": "neon",
        "stage": {"aspect": 1.7778, "background": "", "bg_dim": 0.55, "haze": 0.5, "show_labels": True},
    }


def default_show() -> dict:
    scenes = default_scenes()
    return {
        "version": 1,
        "name": "My Rig",
        "fixtures": demo_rig(),
        "scenes": scenes,
        "bank": [s["id"] for s in scenes],
        "palette": {"name": PALETTES[0]["name"], "colors": list(PALETTES[0]["colors"])},
        "settings": default_settings(),
    }
