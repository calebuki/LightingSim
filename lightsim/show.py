"""Show file: fixtures, scenes, palette and settings, autosaved as JSON."""
from __future__ import annotations

import copy
import json
import logging
import os
import sys
import threading
import time
from pathlib import Path

from . import APP_NAME
from .fixtures import normalize_fixture
from .presets import PALETTES, SCENE_VISUALS, SHOW_VERSION, default_settings, default_show, make_tv

log = logging.getLogger("lightsim.show")


def data_dir() -> Path:
    if sys.platform == "win32":
        base = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    d = base / APP_NAME
    d.mkdir(parents=True, exist_ok=True)
    return d


class Show:
    def __init__(self, path: Path | None = None):
        self.path = path or data_dir() / "show.json"
        self._dirty_at = 0.0
        self._lock = threading.Lock()
        self.data = self._load()

    # -- persistence -----------------------------------------------------------------
    def _load(self) -> dict:
        if self.path.exists():
            try:
                return self.normalize(json.loads(self.path.read_text("utf-8")))
            except Exception as e:
                bak = self.path.with_suffix(f".broken-{int(time.time())}.json")
                self.path.replace(bak)
                log.warning("Show file unreadable (%s); saved as %s and starting fresh", e, bak.name)
        return self.normalize(default_show())

    @staticmethod
    def normalize(d: dict) -> dict:
        base = default_show()
        out = {**base, **{k: v for k, v in d.items() if k in base}}
        out["fixtures"] = [normalize_fixture(f) for f in out.get("fixtures", [])]
        st = default_settings()
        for k, v in (d.get("settings") or {}).items():
            if isinstance(v, dict) and isinstance(st.get(k), dict):
                st[k] = {**st[k], **v}
            else:
                st[k] = v
        out["settings"] = st
        ids = {s["id"] for s in out["scenes"]}
        out["bank"] = [i for i in out.get("bank", []) if i in ids] + [
            s["id"] for s in out["scenes"] if s["id"] not in out.get("bank", [])]
        if d.get("version", 1) < 2:
            Show._migrate_v2(out)
        if d.get("version", 1) < 3:
            Show._migrate_v3(out)
        out["version"] = SHOW_VERSION
        return out

    @staticmethod
    def _migrate_v3(d: dict):
        """Version 3 adds a white TV, which the built-in Full White scene should use."""
        for s in d["scenes"]:
            if s.get("name") == "Full White" and s.get("builtin") and (s.get("visual") or {}).get("id") == "none":
                s["visual"] = {"id": "white"}

    @staticmethod
    def _migrate_v2(d: dict):
        """Version 2 adds a TV: one on stage, and a visual for every scene."""
        d["fixtures"].insert(0, make_tv())
        for s in d["scenes"]:
            s.setdefault("visual", dict(SCENE_VISUALS.get(s.get("name"), {"id": "currents"})))
        if d["palette"].get("name") == "Neon":  # the old default, which is no longer offered
            d["palette"] = {"name": PALETTES[0]["name"], "colors": list(PALETTES[0]["colors"])}
        st = d["settings"]
        st["theme"] = "light" if st.get("theme") == "daylight" else "dark"
        st["stage"]["show_labels"] = False

    def mark_dirty(self):
        self._dirty_at = time.time()

    def save_if_dirty(self, delay: float = 1.0):
        if self._dirty_at and time.time() - self._dirty_at >= delay:
            self.save()

    def save(self):
        with self._lock:
            self._dirty_at = 0.0
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.data, indent=1), "utf-8")
            tmp.replace(self.path)

    def replace(self, d: dict):
        self.data = self.normalize(d)
        self.mark_dirty()

    def export(self) -> dict:
        return copy.deepcopy(self.data)

    # -- lookups ---------------------------------------------------------------------
    def scene(self, sid: str) -> dict | None:
        for s in self.data["scenes"]:
            if s["id"] == sid:
                return s
        return None

    def fixture(self, fid: str) -> dict | None:
        for f in self.data["fixtures"]:
            if f["id"] == fid:
                return f
        return None
