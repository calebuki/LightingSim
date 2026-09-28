# PyInstaller build: `pyinstaller packaging/lightsim.spec` from the repo root.
# Windows -> dist/LightingSim/LightingSim.exe   (a normal windowed app, no console)
# macOS   -> dist/LightingSim.app
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

root = Path(SPECPATH).parent
hidden = ["mido.backends.rtmidi", "rtmidi", "aalink", "serial.tools.list_ports"]
if sys.platform == "win32":
    hidden += ["webview.platforms.edgechromium", "webview.platforms.winforms", "clr"]
elif sys.platform == "darwin":
    hidden += ["webview.platforms.cocoa"]

a = Analysis(
    [str(root / "packaging" / "launcher.py")],
    pathex=[str(root)],
    datas=[(str(root / "web"), "web"), (str(root / "packaging" / "icon.png"), "packaging"),
           (str(root / "packaging" / "icon.ico"), "packaging")]
          + collect_data_files("webview"),
    hiddenimports=hidden + collect_submodules("webview.platforms", filter=lambda n: (
        ("edgechromium" in n or "winforms" in n) if sys.platform == "win32" else "cocoa" in n)),
    excludes=["tkinter", "matplotlib", "PIL", "pytest", "PyQt5", "PyQt6", "PySide2", "PySide6", "gi"],
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, [],
    exclude_binaries=True,
    name="LightingSim",
    console=False,
    icon=str(root / "packaging" / ("icon.ico" if sys.platform == "win32" else "icon.icns")),
    upx=False,
)
coll = COLLECT(exe, a.binaries, a.datas, name="LightingSim", upx=False)

if sys.platform == "darwin":
    app = BUNDLE(
        coll,
        name="LightingSim.app",
        icon=str(root / "packaging" / "icon.icns"),
        bundle_identifier="io.github.calebuki.lightingsim",
        info_plist={
            "CFBundleName": "LightingSim",
            "CFBundleShortVersionString": "1.1.1",
            "NSHighResolutionCapable": True,
            "NSLocalNetworkUsageDescription": "LightingSim talks to WLED, Govee and WiZ lights and Ableton Link (rekordbox) on your network.",
            "NSBonjourServices": ["_ableton-link._udp"],
        },
    )
