# PyInstaller build: `pyinstaller packaging/lightsim.spec` from the repo root.
# Windows -> dist/LightingSim/LightingSim.exe (console shows the URL; close it to quit)
# macOS   -> dist/LightingSim.app
import sys
from pathlib import Path

root = Path(SPECPATH).parent
hidden = ["mido.backends.rtmidi", "rtmidi", "aalink", "serial.tools.list_ports"]

a = Analysis(
    [str(root / "packaging" / "launcher.py")],
    pathex=[str(root)],
    datas=[(str(root / "web"), "web")],
    hiddenimports=hidden,
    excludes=["tkinter", "matplotlib", "PIL", "pytest"],
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, [],
    exclude_binaries=True,
    name="LightingSim",
    console=sys.platform != "darwin",
    upx=False,
)
coll = COLLECT(exe, a.binaries, a.datas, name="LightingSim", upx=False)

if sys.platform == "darwin":
    app = BUNDLE(
        coll,
        name="LightingSim.app",
        bundle_identifier="io.github.lightingsim",
        info_plist={
            "CFBundleShortVersionString": "1.0.0",
            "NSLocalNetworkUsageDescription": "LightingSim talks to WLED, Govee and WiZ lights and Ableton Link (rekordbox) on your network.",
            "NSBonjourServices": ["_ableton-link._udp"],
            "LSUIElement": False,
        },
    )
