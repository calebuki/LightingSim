"""Render engine: turns scenes + beat position into colours for every pixel.

Design notes (speed):
- Every pixel of every fixture lives in one flat array, so each track is a
  handful of numpy ops no matter how many lights there are.
- Scenes are "compiled" (step arrays, target indices, coarse fallbacks) only
  when the show changes, never per frame.
- Runs on its own thread with high-resolution sleeps; the web server only
  receives finished frames.

Realism:
- Each fixture's gate is re-timed to the fastest subdivision it can actually
  show (min_pulse_ms, update_hz) using the track's fallback: pulse/hold/skip.
- Each fixture is rendered latency_ms ahead so slow Wi-Fi lights land on beat.
- Values are sample-and-held at the fixture's update_hz, exactly like the
  real device will receive them. The browser adds the rise/fall fade.
"""
from __future__ import annotations

import math
import random
import threading
import time
from functools import lru_cache

import numpy as np

from .fixtures import pixel_positions

DIVS = (1, 2, 3, 4, 6, 8, 12, 16, 32)  # steps per beat: 1, 1/2, 1/3 ... 1/32 beat
TAU = 2.0 * math.pi
M32 = np.uint64(0xFFFFFFFF)


# --------------------------------------------------------------------------- utils
@lru_cache(maxsize=512)
def hex_rgb(h: str) -> tuple[float, float, float]:
    h = (h or "#000000").lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    try:
        return (int(h[0:2], 16) / 255.0, int(h[2:4], 16) / 255.0, int(h[4:6], 16) / 255.0)
    except ValueError:
        return (1.0, 1.0, 1.0)


def resolve_color(c: str, palette: list[str]) -> tuple[float, float, float]:
    if isinstance(c, str) and c.startswith("p") and c[1:].isdigit():
        i = int(c[1:])
        return hex_rgb(palette[i % len(palette)]) if palette else (1.0, 1.0, 1.0)
    if c == "white":
        return (1.0, 1.0, 1.0)
    if c == "black":
        return (0.0, 0.0, 0.0)
    return hex_rgb(c)


def hash01(a, b):
    """Cheap vectorised integer hash -> [0,1)."""
    a = np.asarray(a).astype(np.int64).astype(np.uint64)
    b = np.asarray(b).astype(np.int64).astype(np.uint64)
    h = (a * np.uint64(374761393) + b * np.uint64(668265263) + np.uint64(0x9E3779B9)) & M32
    h = ((h ^ (h >> np.uint64(13))) * np.uint64(1274126177)) & M32
    h = h ^ (h >> np.uint64(16))
    return h.astype(np.float64) / 4294967296.0


def frac(x):
    return x - np.floor(x)


def smoothstep(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3.0 - 2.0 * x)


def hsv_rgb(h, s=1.0, v=1.0):
    h6 = frac(h) * 6.0
    i = np.floor(h6).astype(np.int64) % 6
    f = h6 - np.floor(h6)
    p = v * (1 - s)
    q = v * (1 - s * f)
    t = v * (1 - s * (1 - f))
    v = np.broadcast_to(v, h6.shape)
    p, q, t = (np.broadcast_to(z, h6.shape) for z in (p, q, t))
    r = np.choose(i, [v, q, p, p, t, v])
    g = np.choose(i, [t, v, v, q, p, p])
    b = np.choose(i, [p, p, t, v, v, q])
    return np.stack([r, g, b], axis=1)


def divisors(d: int) -> list[int]:
    return [c for c in range(1, d + 1) if d % c == 0]


# --------------------------------------------------------------------------- layout
class Layout:
    """Flat pixel arrays for the current fixture list."""

    def __init__(self, fixtures: list[dict], version: int):
        self.version = version
        self.fixtures = fixtures
        self.F = len(fixtures)
        self.index = {fx["id"]: i for i, fx in enumerate(fixtures)}
        counts = [fx["pixels"] for fx in fixtures]
        self.offsets = np.concatenate([[0], np.cumsum(counts)]).astype(np.int64) if counts else np.zeros(1, np.int64)
        self.P = int(self.offsets[-1])
        self.fid = np.repeat(np.arange(self.F), counts) if counts else np.zeros(0, np.int64)
        xs, ys, us = [], [], []
        for fx in fixtures:
            pts = pixel_positions(fx)
            n = len(pts)
            xs += [p[0] for p in pts]
            ys += [p[1] for p in pts]
            us += [i / (n - 1) if n > 1 else 0.5 for i in range(n)]
        self.X = np.array(xs, dtype=np.float64)
        self.Y = np.array(ys, dtype=np.float64)
        self.U = np.array(us, dtype=np.float64)
        self.local = np.arange(self.P) - self.offsets[self.fid] if self.P else np.zeros(0, np.int64)
        caps = [fx["caps"] for fx in fixtures]
        self.latency = np.array([c["latency_ms"] for c in caps], dtype=np.float64)
        self.update_hz = np.array([max(1.0, c["update_hz"]) for c in caps], dtype=np.float64)
        self.min_pulse = np.array([c["min_pulse_ms"] for c in caps], dtype=np.float64)
        self.mono = np.array([fx["color"] == "mono" for fx in fixtures], dtype=bool)
        self.tint = np.array([hex_rgb(fx.get("tint", "#ffffff")) for fx in fixtures]).reshape(-1, 3)
        self.groups = [fx["group"] for fx in fixtures]
        self.fx_x = np.array([fx["x"] for fx in fixtures], dtype=np.float64)
        self.fx_y = np.array([fx["y"] for fx in fixtures], dtype=np.float64)

    def targets(self, target: list[str]) -> np.ndarray:
        """Fixture indices a track addresses, ordered left->right, top->bottom."""
        if not target or "all" in target:
            idx = list(range(self.F))
        else:
            tset = set(target)
            idx = [i for i, fx in enumerate(self.fixtures) if fx["group"] in tset or fx["id"] in tset]
        idx.sort(key=lambda i: (round(self.fx_x[i], 3), self.fx_y[i]))
        return np.array(idx, dtype=np.int64)


# --------------------------------------------------------------------------- compiled
class CompiledTrack:
    def __init__(self, tr: dict, lay: Layout):
        self.src = tr
        g = tr.get("gate", {})
        self.effect = tr.get("effect", {"type": "solid", "colors": ["p0"]})
        self.level = float(tr.get("level", 1.0))
        self.mute = bool(tr.get("mute", False))
        self.blend = tr.get("blend", "max")
        self.div = int(g.get("div", 1)) if int(g.get("div", 1)) in DIVS else 1
        self.bars = int(g.get("bars", 1)) if int(g.get("bars", 1)) in (1, 2, 4, 8) else 1
        n_steps = self.bars * 4 * self.div
        steps = list(g.get("steps") or [1.0])
        steps = (steps * (n_steps // max(1, len(steps)) + 1))[:n_steps]
        self.steps = np.clip(np.array(steps, dtype=np.float64), 0.0, 1.0)
        self.duty = float(np.clip(g.get("duty", 0.5), 0.02, 1.0))
        self.env = g.get("env", "hold")
        self.spread = g.get("spread", "all")
        self.fallback = g.get("fallback", "pulse")
        self.swing = float(np.clip(g.get("swing", 0.0), 0.0, 0.6))
        self.fx = lay.targets(tr.get("target", ["all"]))
        self.n = len(self.fx)
        self.rank_of = np.full(lay.F, -1, dtype=np.int64)
        self.rank_of[self.fx] = np.arange(self.n)
        pm = np.isin(lay.fid, self.fx) if lay.P else np.zeros(0, bool)
        self.pix = np.nonzero(pm)[0]
        self.pix_fid = lay.fid[self.pix]
        self.pix_rank = self.rank_of[self.pix_fid]
        self.pix_rankn = self.pix_rank / max(1, self.n - 1)
        self._coarse: dict[int, np.ndarray] = {}
        self.cands = divisors(self.div)
        # shortest visible on/off segment as a fraction of one step
        if self.env == "gate":
            self.k = max(0.05, min(self.duty, 1 - self.duty))
        elif self.env in ("decay", "swell"):
            self.k = 0.5
        else:
            self.k = 1.0

    def coarse(self, c: int) -> np.ndarray:
        a = self._coarse.get(c)
        if a is None:
            ratio = self.div // c
            a = self.steps.reshape(-1, ratio).max(axis=1)
            self._coarse[c] = a
        return a

    def gate(self, bF: np.ndarray, beat_ms: float, min_pulse: np.ndarray, update_hz: np.ndarray) -> np.ndarray:
        """Gate value per target fixture (in rank order)."""
        n = self.n
        if n == 0:
            return np.zeros(0)
        b = bF[self.fx]
        mp = min_pulse[self.fx]
        up = 980.0 / update_hz[self.fx]  # every step must survive at least one refresh
        c = np.ones(n, dtype=np.int64)
        for d in self.cands:  # ascending -> ends at the fastest the light can do
            step = beat_ms / d
            c = np.where((step * self.k >= mp) & (step >= up), d, c)
        out = np.zeros(n)
        for cv in np.unique(c):
            m = c == cv
            degraded = cv < self.div
            if degraded and self.fallback == "skip":
                continue
            steps = self.coarse(int(cv))
            L = len(steps)
            x = b[m] * cv
            if self.swing > 0 and not degraded and self.div % 2 == 0:
                s, p = _swing(x, self.swing)
            else:
                s = np.floor(x).astype(np.int64)
                p = x - s
            r = np.arange(n)[m]
            v = steps[s % L] * self._spread(s, r)
            if degraded and self.fallback == "hold":
                out[m] = v
                continue
            out[m] = self._envelope(v, p, s, r, steps)
        return out

    def _spread(self, s, r):
        n, sp = self.n, self.spread
        if sp == "all" or n <= 1:
            return 1.0
        if sp == "alternate":
            return ((s + r) % 2 == 0).astype(np.float64)
        if sp == "chase":
            return (s % n == r).astype(np.float64)
        if sp == "bounce":
            per = max(1, 2 * n - 2)
            q = s % per
            q = np.where(q < n, q, per - q)
            return (q == r).astype(np.float64)
        if sp == "fill":
            return (r <= s % n).astype(np.float64)
        if sp == "random":
            return (np.floor(hash01(s, 91) * n).astype(np.int64) == r).astype(np.float64)
        if sp == "odd":
            return (r % 2 == 1).astype(np.float64)
        if sp == "even":
            return (r % 2 == 0).astype(np.float64)
        return 1.0

    def _envelope(self, v, p, s, r, steps):
        env, duty = self.env, self.duty
        if env == "gate":
            return v * (p < duty)
        if env == "decay":
            return v * (1.0 - np.minimum(p / duty, 1.0)) ** 2
        if env == "swell":
            return v * np.minimum(p / duty, 1.0) ** 2
        if env == "sine":
            return v * (0.5 - 0.5 * np.cos(TAU * p))
        if env == "smooth":
            vn = steps[(s + 1) % len(steps)] * self._spread(s + 1, r)
            return v + (vn - v) * (0.5 - 0.5 * np.cos(math.pi * p))
        return v  # hold


def _swing(x, sw):
    pair = np.floor(x / 2.0)
    q = x - 2.0 * pair
    edge = 1.0 + sw
    second = q >= edge
    s = (2 * pair + second).astype(np.int64)
    p = np.where(second, (q - edge) / (2.0 - edge), q / edge)
    return s, p


class CompiledScene:
    def __init__(self, sc: dict, lay: Layout):
        self.id = sc["id"]
        self.bars = int(sc.get("bars", 4))
        self.tracks = [CompiledTrack(t, lay) for t in sc.get("tracks", [])]
        solo = [t for t in self.tracks if t.src.get("solo")]
        self.active = [t for t in (solo or self.tracks) if not t.mute]


# --------------------------------------------------------------------------- effects
def _axis(e: dict, lay: Layout, ct: CompiledTrack):
    ax = e.get("axis", "x")
    pix = ct.pix
    if ax == "y":
        a = lay.Y[pix]
    elif ax == "u":
        a = lay.U[pix]
    elif ax == "rank":
        a = ct.pix_rankn
    elif ax == "radial":
        a = np.minimum(1.0, np.hypot(lay.X[pix] - 0.5, lay.Y[pix] - 0.5) / 0.5)
    elif ax == "angle":
        a = frac(np.arctan2(lay.Y[pix] - 0.5, lay.X[pix] - 0.5) / TAU)
    elif ax == "diag":
        a = (lay.X[pix] + lay.Y[pix]) * 0.5
    else:
        a = lay.X[pix]
    if e.get("reverse"):
        a = 1.0 - a
    return a


def render_effect(ct: CompiledTrack, lay: Layout, bP: np.ndarray, palette: list[str]) -> np.ndarray:
    e = ct.effect
    typ = e.get("type", "solid")
    cols = np.array([resolve_color(c, palette) for c in (e.get("colors") or ["p0"])], dtype=np.float64)
    nc = len(cols)
    b = bP[ct.pix]
    P = len(b)
    rate = max(1e-3, float(e.get("rate", 4.0)))
    ph = b / rate

    if typ == "solid":
        return np.broadcast_to(cols[0], (P, 3))

    if typ == "cycle":
        a = _axis(e, lay, ct) * float(e.get("spread", 0.0))
        f = ph + a
        i = np.floor(f).astype(np.int64)
        fade = float(e.get("fade", 0.3))
        m = smoothstep((frac(f) - (1 - fade)) / max(fade, 1e-3)) if fade > 0 else 0.0
        c0 = cols[i % nc]
        c1 = cols[(i + 1) % nc]
        m = np.asarray(m).reshape(-1, 1) if np.ndim(m) else m
        return c0 + (c1 - c0) * m

    if typ == "sweep":
        a = _axis(e, lay, ct)
        w = max(0.02, float(e.get("width", 0.25)))
        f = frac(ph)
        pos = 1.0 - np.abs(2.0 * f - 1.0) if e.get("bounce") else f
        pos = -w + pos * (1.0 + 2.0 * w)
        band = smoothstep(1.0 - np.abs(a - pos) / w)
        bg = cols[1] * float(e.get("bg", 0.0)) if nc > 1 else np.zeros(3)
        return bg + (cols[0] - bg) * band[:, None]

    if typ == "wave":
        a = _axis(e, lay, ct)
        w = 0.5 + 0.5 * np.sin(TAU * (a * float(e.get("cycles", 1.0)) - ph))
        c1 = cols[1] if nc > 1 else np.zeros(3)
        depth = float(e.get("depth", 0.6))
        col = c1 + (cols[0] - c1) * w[:, None]
        return col * ((1.0 - depth) + depth * w)[:, None]

    if typ == "rainbow":
        a = _axis(e, lay, ct)
        return hsv_rgb(a * float(e.get("cycles", 1.0)) + ph, float(e.get("sat", 1.0)), 1.0)

    if typ == "gradient":
        a = _axis(e, lay, ct)
        t = frac(a * float(e.get("cycles", 1.0)) + (ph if e.get("scroll", True) else 0.0))
        t = 1.0 - np.abs(2.0 * t - 1.0)  # mirror so the scroll is seamless
        if nc == 1:
            return np.broadcast_to(cols[0], (P, 3))
        x = t * (nc - 1)
        i = np.minimum(np.floor(x).astype(np.int64), nc - 2)
        m = (x - i)[:, None]
        return cols[i] + (cols[i + 1] - cols[i]) * m

    if typ == "sparkle":
        s = np.floor(ph).astype(np.int64)
        gid = ct.pix.astype(np.int64)
        on = hash01(gid, s) < float(e.get("density", 0.15))
        env = (1.0 - frac(ph)) ** 2
        ci = np.floor(hash01(gid, s + 7777) * nc).astype(np.int64)
        return cols[ci] * (on * env)[:, None]

    if typ == "split":
        seg = int(e.get("segments", 0))
        base = np.floor(lay.U[ct.pix] * seg).astype(np.int64) if seg > 0 else ct.pix_rank
        i = (base + np.floor(ph).astype(np.int64)) % nc
        return cols[i]

    if typ == "flicker":
        gid = ct.pix.astype(np.float64)
        n = (np.sin(b * 7.3 + gid * 1.7) + np.sin(b * 13.1 + gid * 4.1) * 0.6 + np.sin(b * 3.7 + gid * 0.3) * 0.4) / 2.0
        n = 0.5 + 0.5 * np.clip(n, -1, 1)
        amt = float(e.get("depth", 0.5))
        c1 = cols[1] if nc > 1 else cols[0]
        col = c1 + (cols[0] - c1) * n[:, None]
        return col * ((1 - amt) + amt * n)[:, None]

    return np.broadcast_to(cols[0], (P, 3))


# --------------------------------------------------------------------------- engine
TRANSITIONS = ("cut", "fade", "wipe", "iris", "flash", "dip")
QUANT = {"now": 0, "beat": 1, "bar": 4, "2bar": 8, "4bar": 16, "8bar": 32}


class Engine:
    def __init__(self, show, clock, outputs=None):
        self.show = show
        self.clock = clock
        self.outputs = outputs
        self.lock = threading.RLock()
        self.layout: Layout | None = None
        self.layout_version = 0
        self.show_rev = 0
        self._compiled: dict[str, tuple[int, int, CompiledScene]] = {}
        # live state
        self.current: str | None = None
        self.transition: dict | None = None
        self.queued: dict | None = None
        self.master = 1.0
        self.blackout = False
        self._blackout_level = 0.0
        self.flash = 0.0
        self.strobe = False
        self.group_levels = {"floods": 1.0, "strips": 1.0, "strings": 1.0, "bulbs": 1.0}
        self.identify: dict[int, float] = {}
        self.preview_scene: str | None = None  # editor audition (sim only override)
        self._last_phrase = None
        self._auto_order: list[str] = []
        self._strobe_ct: CompiledTrack | None = None
        self.stats = {"render_ms": 0.0, "fps": 0.0}
        self.rebuild_layout()

    # -- structure ------------------------------------------------------------------
    def rebuild_layout(self):
        with self.lock:
            self.layout_version += 1
            self.layout = Layout(self.show.data["fixtures"], self.layout_version)
            lay = self.layout
            self.held = np.zeros((lay.P, 3))
            self.display = np.zeros((lay.P, 3))
            self.next_update = np.zeros(lay.F)
            self._compiled.clear()
            self._strobe_ct = None
            if self.outputs:
                self.outputs.configure(lay, self.show.data)

    def touch(self):
        """Call after any scene/track edit."""
        with self.lock:
            self.show_rev += 1

    def compiled(self, scene_id: str | None) -> CompiledScene | None:
        if not scene_id:
            return None
        hit = self._compiled.get(scene_id)
        if hit and hit[0] == self.show_rev and hit[1] == self.layout_version:
            return hit[2]
        sc = self.show.scene(scene_id)
        if sc is None:
            return None
        cs = CompiledScene(sc, self.layout)
        self._compiled[scene_id] = (self.show_rev, self.layout_version, cs)
        return cs

    # -- performer actions ------------------------------------------------------------
    def launch(self, scene_id: str, quantize: str | None = None, transition: dict | None = None):
        st = self.show.data["settings"]
        q = QUANT.get(quantize or st.get("launch_quantize", "bar"), 4)
        tr = dict(transition or st.get("transition", {"type": "fade", "beats": 2}))
        with self.lock:
            b = self.clock.beat()
            if self.current is None:
                self.current = scene_id
                self.queued = None
                return
            at = b if q == 0 else math.ceil((b - 0.02) / q) * q
            self.queued = {"scene": scene_id, "at": at, "tr": tr}

    def _start_transition(self, q: dict, b: float):
        tr = q["tr"]
        typ = tr.get("type", "fade")
        beats = float(tr.get("beats", 2))
        if typ == "cut" or beats <= 0 or self.current is None:
            self.current = q["scene"]
            self.transition = None
        else:
            self.transition = {"from": self.current, "to": q["scene"], "start": b, "beats": beats, "type": typ}
            self.current = q["scene"]
        self.queued = None

    def _autopilot(self, b: float):
        ap = self.show.data["settings"].get("autopilot", {})
        if not ap.get("enabled"):
            self._last_phrase = None
            return
        every = int(ap.get("every_bars", 16)) * 4
        phrase = math.floor(b / every)
        if self._last_phrase is None:
            self._last_phrase = phrase
            return
        if phrase != self._last_phrase:  # crossed a phrase boundary: next look lands on the 1
            self._last_phrase = phrase
            ids = [i for i in (ap.get("playlist") or []) if self.show.scene(i)] or [
                s["id"] for s in self.show.data["scenes"] if not s.get("utility")]
            if not ids:
                return
            if ap.get("order") == "sequence":
                i = (ids.index(self.current) + 1) % len(ids) if self.current in ids else 0
                nxt = ids[i]
            else:
                if not self._auto_order:
                    self._auto_order = random.sample(ids, len(ids))
                nxt = self._auto_order.pop()
                if nxt == self.current and self._auto_order:
                    nxt = self._auto_order.pop()
            self._start_transition({"scene": nxt, "tr": self.show.data["settings"].get("transition", {})}, b)

    # -- rendering ----------------------------------------------------------------------
    def _render_scene(self, cs: CompiledScene | None, bF, bP, beat_ms, min_pulse, palette) -> np.ndarray:
        lay = self.layout
        out = np.zeros((lay.P, 3))
        if cs is None:
            return out
        for ct in cs.active:
            if not len(ct.pix) or ct.level <= 0:
                continue
            gF = np.zeros(lay.F)
            gF[ct.fx] = ct.gate(bF, beat_ms, min_pulse, self._uhz)
            g = (gF[ct.pix_fid] * ct.level)[:, None]
            col = render_effect(ct, lay, bP, palette)
            cur = out[ct.pix]
            if ct.blend == "add":
                out[ct.pix] = np.minimum(1.0, cur + col * g)
            elif ct.blend == "over":
                out[ct.pix] = cur * (1.0 - g) + col * g
            elif ct.blend == "mask":
                out[ct.pix] = cur * g
            else:  # max / HTP
                out[ct.pix] = np.maximum(cur, col * g)
        return out

    def _mix(self, a, bb, t, typ):
        lay = self.layout
        if typ == "fade":
            return a + (bb - a) * smoothstep(t)
        if typ in ("wipe", "iris"):
            coord = lay.X if typ == "wipe" else np.minimum(1.0, np.hypot(lay.X - 0.5, lay.Y - 0.5) / 0.5)
            soft = 0.2
            m = np.clip((t * (1 + soft) - coord) / soft, 0, 1)[:, None]
            return a + (bb - a) * m
        if typ == "flash":
            base = a if t < 0.5 else bb
            w = (1.0 - abs(2 * t - 1.0)) ** 2
            return np.maximum(base, w)
        if typ == "dip":
            return a * (1 - 2 * t) if t < 0.5 else bb * (2 * t - 1)
        return bb

    def tick(self, t: float):
        """Render one frame. Returns (display uint8 bytes, updated-fixture mask)."""
        t0 = time.perf_counter()
        with self.lock:
            lay = self.layout
            st = self.show.data["settings"]
            palette = self.show.data["palette"]["colors"]
            bpm = self.clock.bpm
            speed = self.clock.speed
            b = self.clock.beat(t)
            beat_ms = 60000.0 / max(1.0, bpm * speed)
            if lay.P == 0:
                return b"", np.zeros(0, bool)

            flash_cap = float(st.get("max_flash_hz", 0) or 0)
            min_pulse = lay.min_pulse if flash_cap <= 0 else np.maximum(lay.min_pulse, 500.0 / flash_cap)
            self._uhz = np.minimum(lay.update_hz, float(st.get("fps", 60)))  # the engine can't outrun itself
            live = bool(st.get("output_enabled"))
            look = lay.latency / beat_ms if live else np.zeros(lay.F)
            bF = b + look
            bP = bF[lay.fid]

            # launch when due - or right away if the clock jumped backwards
            # (a Link peer joining/leaving can re-seat the shared timeline)
            if self.queued and (b >= self.queued["at"] or self.queued["at"] - b > 33):
                self._start_transition(self.queued, b)
            if self.transition and b < self.transition["start"] - 0.5:
                self.transition["start"] = b
            self._autopilot(b)

            scene_id = self.preview_scene or self.current
            out = self._render_scene(self.compiled(scene_id), bF, bP, beat_ms, min_pulse, palette)
            tr = self.transition
            if tr and not self.preview_scene:
                p = (b - tr["start"]) / tr["beats"]
                if p >= 1.0:
                    self.transition = None
                else:
                    prev = self._render_scene(self.compiled(tr["from"]), bF, bP, beat_ms, min_pulse, palette)
                    out = self._mix(prev, out, max(0.0, p), tr["type"])

            # -- performer overrides
            if self.strobe:
                if self._strobe_ct is None or self._strobe_ct.div != int(st.get("strobe_div", 16)):
                    self._strobe_ct = CompiledTrack({
                        "target": ["all"], "effect": {"type": "solid", "colors": [st.get("flash_color", "#ffffff")]},
                        "gate": {"div": int(st.get("strobe_div", 16)), "bars": 1, "steps": [1], "env": "gate",
                                 "duty": 0.5, "spread": "all", "fallback": "pulse"}}, lay)
                g = np.zeros(lay.F)
                g[self._strobe_ct.fx] = self._strobe_ct.gate(bF, beat_ms, min_pulse, self._uhz)
                sc = np.array(hex_rgb(st.get("flash_color", "#ffffff")))
                out = sc[None, :] * g[lay.fid][:, None]
            if self.flash > 0:
                fc = np.array(hex_rgb(st.get("flash_color", "#ffffff")))
                out = np.maximum(out, fc[None, :] * self.flash)
            if self.identify:
                for fi, until in list(self.identify.items()):
                    if t > until or fi >= lay.F:
                        self.identify.pop(fi, None)
                        continue
                    sl = slice(lay.offsets[fi], lay.offsets[fi + 1])
                    out[sl] = 1.0 if int(t * 6) % 2 == 0 else 0.0

            # -- master section
            gl = np.array([self.group_levels.get(g, 1.0) for g in lay.groups])
            target_bo = 1.0 if self.blackout else 0.0
            self._blackout_level += (target_bo - self._blackout_level) * 0.35
            gain = gl * self.master * (1.0 - self._blackout_level)
            out = out * gain[lay.fid][:, None]

            # mono fixtures: brightness only, shown in their natural tint
            if lay.mono.any():
                mp = lay.mono[lay.fid]
                lum = out[mp].max(axis=1)
                out[mp] = lum[:, None] * lay.tint[lay.fid[mp]]

            # -- sample & hold at each fixture's real update rate
            upd = t >= self.next_update
            if upd.any():
                nxt = self.next_update + 1.0 / lay.update_hz
                nxt = np.where(nxt <= t, t + 1.0 / lay.update_hz, nxt)  # stalled/first frame: restart the grid
                self.next_update = np.where(upd, nxt, self.next_update)
                pm = upd[lay.fid]
                self.held[pm] = out[pm]
            self.stats["render_ms"] = self.stats["render_ms"] * 0.9 + (time.perf_counter() - t0) * 100.0
            frame = (np.clip(self.held, 0, 1) * 255.0 + 0.5).astype(np.uint8)
            return frame.tobytes(), upd

    def status(self) -> dict:
        b = self.clock.beat()
        tr = self.transition
        return {
            "beat": b,
            "current": self.current,
            "queued": self.queued and {"scene": self.queued["scene"], "at": self.queued["at"]},
            "transition": tr and {"from": tr["from"], "to": tr["to"],
                                  "progress": max(0.0, min(1.0, (b - tr["start"]) / tr["beats"]))},
            "master": self.master,
            "blackout": self.blackout,
            "strobe": self.strobe,
            "group_levels": self.group_levels,
            "preview": self.preview_scene,
            "render_ms": round(self.stats["render_ms"], 2),
            "fps": round(self.stats["fps"], 1),
        }


class EngineThread(threading.Thread):
    """Runs the engine at a fixed rate and hands frames to the web server."""

    def __init__(self, engine: Engine, on_frame, fps_sim: float = 30.0):
        super().__init__(daemon=True, name="lightsim-engine")
        self.engine = engine
        self.on_frame = on_frame
        self.fps_sim = fps_sim
        self.running = True

    def run(self):
        _hires_timer(True)
        eng = self.engine
        nxt = time.perf_counter()
        last_sim = 0.0
        frames, t_fps = 0, time.perf_counter()
        while self.running:
            fps = float(eng.show.data["settings"].get("fps", 60))
            dt = 1.0 / max(20.0, min(120.0, fps))
            t = time.perf_counter()
            try:
                frame, upd = eng.tick(t)
                if eng.outputs and eng.show.data["settings"].get("output_enabled"):
                    eng.outputs.send(eng.held, upd, eng.layout)
                if t - last_sim >= 1.0 / self.fps_sim:
                    last_sim = t
                    self.on_frame(frame, eng.layout.version)
            except Exception:  # keep the show running no matter what
                import traceback
                traceback.print_exc()
                time.sleep(0.2)
            frames += 1
            if t - t_fps >= 1.0:
                eng.stats["fps"] = frames / (t - t_fps)
                frames, t_fps = 0, t
            nxt += dt
            delay = nxt - time.perf_counter()
            if delay < -0.1:
                nxt = time.perf_counter()
            elif delay > 0:
                time.sleep(delay)
        if eng.outputs:
            eng.outputs.blackout_all(eng.layout)
        _hires_timer(False)


def _hires_timer(on: bool):
    """1 ms timer resolution on Windows so 60 fps is actually 60 fps."""
    try:
        import sys
        if sys.platform == "win32":
            import ctypes
            (ctypes.windll.winmm.timeBeginPeriod if on else ctypes.windll.winmm.timeEndPeriod)(1)
    except Exception:
        pass
