"""Fixture profiles: what each kind of budget light can physically do.

Every profile carries the real-world limits the engine and simulator honour:

- update_hz     how often the device accepts a new value (sample & hold)
- latency_ms    network/firmware delay; the engine renders this far ahead
- rise_ms/fall_ms  physical/firmware fade (incandescent filaments, Govee smoothing)
- min_pulse_ms  shortest on/off the light can show reliably. Faster patterns
                are re-timed with the track's slow-fixture fallback.
- color         "rgb" | "rgbw" | "mono"
"""
from __future__ import annotations

import copy
import uuid

PROFILES: dict[str, dict] = {
    "flood_dmx": {
        "label": "LED Flood / PAR (DMX)",
        "group": "floods",
        "shape": "flood",
        "color": "rgb",
        "pixels": 1,
        "update_hz": 44,
        "latency_ms": 8,
        "rise_ms": 2,
        "fall_ms": 6,
        "min_pulse_ms": 12,
        "protocol": "dmx",
        "channels": ["dim", "r", "g", "b", "strobe"],
        "cost": "$25-40 each + $15-60 USB-DMX dongle",
        "notes": "Best budget strobe. Cheap 'DMX 7ch' floods usually use Dimmer,R,G,B,Strobe,Mode,Speed; set Mode to 0.",
    },
    "strobe_dmx": {
        "label": "White Strobe Flood (DMX)",
        "group": "floods",
        "shape": "flood",
        "color": "mono",
        "tint": "#f4f7ff",
        "pixels": 1,
        "update_hz": 44,
        "latency_ms": 8,
        "rise_ms": 1,
        "fall_ms": 4,
        "min_pulse_ms": 10,
        "protocol": "dmx",
        "channels": ["dim"],
        "cost": "$30-50",
        "notes": "Handles 1/16 and most 1/32 strobes.",
    },
    "flood_relay": {
        "label": "Flood on Smart Plug / Relay",
        "group": "floods",
        "shape": "flood",
        "color": "mono",
        "tint": "#fff1d6",
        "pixels": 1,
        "update_hz": 8,
        "latency_ms": 90,
        "rise_ms": 25,
        "fall_ms": 60,
        "min_pulse_ms": 300,
        "protocol": "none",
        "cost": "$10 plug + existing flood",
        "notes": "Relays wear out and lag - on/off per bar only, never strobe.",
    },
    "strip_wled": {
        "label": "LED Strip (WLED / ESP32)",
        "group": "strips",
        "shape": "line",
        "color": "rgb",
        "pixels": 60,
        "update_hz": 60,
        "latency_ms": 15,
        "rise_ms": 0,
        "fall_ms": 0,
        "min_pulse_ms": 10,
        "protocol": "wled",
        "cost": "$5 ESP32 + $10-20/5m WS2812B strip",
        "notes": "Fastest option. Flash WLED from install.wled.me, then use its IP.",
    },
    "govee_string": {
        "label": "Govee Outdoor String Lights (LAN)",
        "group": "strings",
        "shape": "string",
        "color": "rgb",
        "pixels": 15,
        "update_hz": 10,
        "latency_ms": 120,
        "rise_ms": 90,
        "fall_ms": 120,
        "min_pulse_ms": 220,
        "protocol": "govee",
        "cost": "already owned",
        "notes": "Enable 'LAN Control' in the Govee app. Firmware smooths changes, so keep to 1/2-beat or slower.",
    },
    "govee_strip": {
        "label": "Govee Strip / Light (LAN)",
        "group": "strips",
        "shape": "line",
        "color": "rgb",
        "pixels": 20,
        "update_hz": 10,
        "latency_ms": 120,
        "rise_ms": 90,
        "fall_ms": 120,
        "min_pulse_ms": 220,
        "protocol": "govee",
        "cost": "already owned",
        "notes": "Whole device is one colour unless experimental segment mode works on your model.",
    },
    "bulb_wiz": {
        "label": "Smart Bulb (WiZ, Wi-Fi)",
        "group": "bulbs",
        "shape": "bulb",
        "color": "rgb",
        "pixels": 1,
        "update_hz": 15,
        "latency_ms": 60,
        "rise_ms": 50,
        "fall_ms": 70,
        "min_pulse_ms": 140,
        "protocol": "wiz",
        "cost": "$8-12 each",
        "notes": "Cheapest LAN-controllable bulb. Beat pulses fine, strobes smear.",
    },
    "bulb_diy": {
        "label": "DIY Pixel Bulb (WLED / ESP)",
        "group": "bulbs",
        "shape": "bulb",
        "color": "rgb",
        "pixels": 1,
        "update_hz": 60,
        "latency_ms": 15,
        "rise_ms": 0,
        "fall_ms": 0,
        "min_pulse_ms": 10,
        "protocol": "wled",
        "cost": "$1-2 per 12mm pixel bulb",
        "notes": "WS2811 12mm pixel 'bulbs' on a WLED ESP - as fast as strips.",
    },
    "bulb_incandescent": {
        "label": "Incandescent / Filament Bulb (DMX dimmer)",
        "group": "bulbs",
        "shape": "bulb",
        "color": "mono",
        "tint": "#ffb866",
        "pixels": 1,
        "update_hz": 44,
        "latency_ms": 8,
        "rise_ms": 110,
        "fall_ms": 260,
        "min_pulse_ms": 180,
        "protocol": "dmx",
        "channels": ["dim"],
        "cost": "$40 4-ch DMX dimmer pack",
        "notes": "Filaments glow up/down slowly - great for warm chases, not strobes.",
    },
    "virtual": {
        "label": "Virtual (simulate only)",
        "group": "bulbs",
        "shape": "bulb",
        "color": "rgb",
        "pixels": 1,
        "update_hz": 60,
        "latency_ms": 0,
        "rise_ms": 0,
        "fall_ms": 0,
        "min_pulse_ms": 0,
        "protocol": "none",
        "cost": "free",
        "notes": "For planning a rig before buying anything.",
    },
}

CAP_KEYS = ("update_hz", "latency_ms", "rise_ms", "fall_ms", "min_pulse_ms")
SHAPES = ("flood", "line", "string", "bulb")
GROUPS = ("floods", "strips", "strings", "bulbs")


def new_id(prefix: str = "fx") -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


def make_fixture(kind: str, x: float = 0.5, y: float = 0.5, **over) -> dict:
    """Create a fixture dict from a profile with sensible geometry."""
    p = PROFILES[kind]
    shape = p["shape"]
    fx = {
        "id": new_id(),
        "name": p["label"].split(" (")[0],
        "kind": kind,
        "group": p["group"],
        "shape": shape,
        "color": p["color"],
        "tint": p.get("tint", "#ffffff"),
        "pixels": p["pixels"],
        "x": x,
        "y": y,
        # line / string geometry: second endpoint
        "x2": min(1.0, x + 0.25) if shape in ("line", "string") else x,
        "y2": y,
        "sag": 0.06 if shape == "string" else 0.0,
        "angle": 90.0 if shape == "flood" else 0.0,  # beam direction, degrees (90 = down)
        "size": 1.0,
        "caps": {k: p[k] for k in CAP_KEYS},
        "patch": _default_patch(p),
    }
    fx.update(over)
    return fx


def _default_patch(p: dict) -> dict:
    proto = p["protocol"]
    if proto == "dmx":
        return {"protocol": "dmx", "interface": "dmx1", "address": 1, "channels": list(p.get("channels", ["r", "g", "b"]))}
    if proto == "wled":
        return {"protocol": "wled", "host": "", "start": 0}
    if proto in ("govee", "wiz"):
        return {"protocol": proto, "host": ""}
    return {"protocol": "none"}


def normalize_fixture(fx: dict) -> dict:
    """Fill in anything missing (older show files, hand-edited JSON)."""
    kind = fx.get("kind") if fx.get("kind") in PROFILES else "virtual"
    base = make_fixture(kind, fx.get("x", 0.5), fx.get("y", 0.5))
    out = copy.deepcopy(base)
    out.update({k: v for k, v in fx.items() if k not in ("caps", "patch")})
    out["caps"] = {**base["caps"], **(fx.get("caps") or {})}
    out["patch"] = {**base["patch"], **(fx.get("patch") or {})}
    out["pixels"] = max(1, min(1024, int(out.get("pixels", 1))))
    return out


def pixel_positions(fx: dict) -> list[tuple[float, float]]:
    """Stage positions (0..1) of each pixel, used for spatial effects & wipes."""
    n = fx["pixels"]
    x1, y1 = fx["x"], fx["y"]
    if fx["shape"] not in ("line", "string") or n == 1:
        return [(x1, y1)] * n
    x2, y2 = fx["x2"], fx["y2"]
    sag = fx.get("sag", 0.0) if fx["shape"] == "string" else 0.0
    pts = []
    for i in range(n):
        u = i / (n - 1)
        pts.append((x1 + (x2 - x1) * u, y1 + (y2 - y1) * u + sag * 4 * u * (1 - u)))
    return pts


def profile_catalog() -> dict:
    return {k: {kk: vv for kk, vv in v.items()} for k, v in PROFILES.items()}
