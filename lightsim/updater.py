"""In-app updates from GitHub Releases, so you never re-download by hand.

Check: asks GitHub for the latest release and compares versions.
Install (packaged app only): downloads this platform's zip, unpacks it next
to the app, then a tiny helper script waits for LightingSim to close, swaps
the files in and relaunches it. Files we download ourselves don't get
Windows' "from the internet" mark or macOS quarantine, so there are no
security prompts on the relaunch.
"""
from __future__ import annotations

import asyncio
import logging
import os
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

import aiohttp

from . import __version__

log = logging.getLogger("lightsim.update")

REPO = "calebuki/LightingSim"
API = f"https://api.github.com/repos/{REPO}/releases/latest"


def parse_version(v: str) -> tuple[int, ...]:
    parts = []
    for p in v.strip().lstrip("vV").split("."):
        num = "".join(ch for ch in p if ch.isdigit())
        parts.append(int(num) if num else 0)
    return tuple(parts + [0] * (3 - len(parts)))


def install_target() -> Path | None:
    """Folder (Windows) or .app bundle (macOS) this packaged app runs from."""
    if not getattr(sys, "frozen", False):
        return None
    exe = Path(sys.executable).resolve()
    if sys.platform == "win32":
        return exe.parent
    if sys.platform == "darwin":
        app = exe.parents[2]
        return app if app.suffix == ".app" else None
    return None


class Updater:
    def __init__(self):
        target = install_target()
        self.state = {
            "current": __version__,
            "latest": None,
            "available": False,
            "status": "idle",  # idle | checking | downloading | installing | error
            "progress": 0.0,
            "error": "",
            "notes_url": f"https://github.com/{REPO}/releases/latest",
            "can_install": target is not None,
        }
        self._asset_url: str | None = None

    async def check(self) -> dict:
        self.state.update(status="checking", error="")
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=8),
                                             headers={"User-Agent": f"LightingSim/{__version__}",
                                                      "Accept": "application/vnd.github+json"}) as s:
                async with s.get(API) as r:
                    if r.status != 200:
                        raise RuntimeError(f"GitHub answered {r.status}")
                    rel = await r.json()
            tag = rel.get("tag_name", "")
            self.state["latest"] = tag.lstrip("vV")
            self.state["notes_url"] = rel.get("html_url", self.state["notes_url"])
            want = "windows" if sys.platform == "win32" else "macos"
            self._asset_url = next((a["browser_download_url"] for a in rel.get("assets", [])
                                    if want in a["name"].lower() and a["name"].endswith(".zip")), None)
            self.state["available"] = parse_version(tag) > parse_version(__version__)
            self.state["status"] = "idle"
        except Exception as e:
            self.state.update(status="error", error=f"Couldn't check for updates ({e.__class__.__name__}). Are you online?")
            log.info("Update check failed: %s", e)
        return self.state

    async def install(self) -> bool:
        """Download + stage the update. Returns True when the app should quit to finish."""
        target = install_target()
        if target is None:
            self.state.update(status="error", error="Automatic updates work in the downloaded app. "
                                                    "From source, run: git pull")
            return False
        if not self._asset_url:
            await self.check()
        if not self._asset_url:
            self.state.update(status="error", error="This release has no download for your system yet.")
            return False
        work = Path(tempfile.mkdtemp(prefix="lightsim-update-"))
        zpath = work / "update.zip"
        try:
            self.state.update(status="downloading", progress=0.0, error="")
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=600),
                                             headers={"User-Agent": f"LightingSim/{__version__}"}) as s:
                async with s.get(self._asset_url) as r:
                    r.raise_for_status()
                    total = int(r.headers.get("Content-Length", 0)) or 1
                    got = 0
                    with open(zpath, "wb") as f:
                        async for chunk in r.content.iter_chunked(1 << 16):
                            f.write(chunk)
                            got += len(chunk)
                            self.state["progress"] = min(0.99, got / total)
            self.state.update(status="installing", progress=1.0)
            await asyncio.to_thread(self._stage, zpath, work, target)
            return True
        except Exception as e:
            log.exception("Update failed")
            self.state.update(status="error", error=f"Update failed: {e}")
            return False

    # -- platform specifics ------------------------------------------------------------
    def _stage(self, zpath: Path, work: Path, target: Path):
        pid = os.getpid()
        new = work / "new"
        if sys.platform == "win32":
            with zipfile.ZipFile(zpath) as z:
                z.extractall(new)
            src = new / "LightingSim" if (new / "LightingSim").is_dir() else new
            if not (src / "LightingSim.exe").exists():
                raise RuntimeError("download didn't contain LightingSim.exe")
            bat = work / "finish-update.bat"
            bat.write_text(
                "@echo off\r\n"
                ":wait\r\n"
                f'tasklist /FI "PID eq {pid}" 2>nul | find "{pid}" >nul && (timeout /t 1 /nobreak >nul & goto wait)\r\n'
                f'robocopy "{src}" "{target}" /E /IS /IT /R:5 /W:1 /NFL /NDL /NJH /NJS /NP >nul\r\n'
                f'start "" "{target / "LightingSim.exe"}"\r\n'
                f'rmdir /s /q "{new}" 2>nul\r\n',
                "utf-8")
            flags = 0x08000000 | 0x00000008  # CREATE_NO_WINDOW | DETACHED_PROCESS
            subprocess.Popen(["cmd", "/c", str(bat)], creationflags=flags, close_fds=True)
        else:
            new.mkdir()
            subprocess.run(["ditto", "-x", "-k", str(zpath), str(new)], check=True)  # keeps symlinks & perms
            app = next(new.glob("*.app"), None)
            if app is None:
                raise RuntimeError("download didn't contain LightingSim.app")
            sh = work / "finish-update.sh"
            sh.write_text(
                "#!/bin/bash\n"
                f"while kill -0 {pid} 2>/dev/null; do sleep 0.5; done\n"
                f'rm -rf "{target}.old"\n'
                f'if mv "{target}" "{target}.old" && ditto "{app}" "{target}"; then rm -rf "{target}.old";'
                f' else rm -rf "{target}"; mv "{target}.old" "{target}"; fi\n'
                f'open "{target}"\n')
            sh.chmod(0o755)
            subprocess.Popen(["/bin/bash", str(sh)], start_new_session=True, close_fds=True)
