# LightingSim

A budget light show controller for DJs. It follows rekordbox's tempo and bar position, drives cheap lights you can buy or build, plays braille visuals on a TV, and shows a simulator of your rig so you can design looks before you buy anything.

- **Syncs with rekordbox** over Ableton Link (no cables, no extra hardware). MIDI clock and tap tempo also work.
- **Runs on Windows and macOS.** Download a release, or run from source on either.
- **Drives budget lights:** WLED LED strips and pixel bulbs, Govee lights over LAN, WiZ bulbs, and DMX floods/strobes through a $15 USB cable or an Art-Net Wi-Fi node.
- **Pattern editor** with 1-, 2-, 4- and 8-bar loops and steps of 1, 1/2, 1/4, 1/8, 1/16 and 1/32 beat, plus triplets (1/3, 1/6, 1/12).
- **Knows what each light can physically do.** When a pattern is too fast for a light (a Govee string can't do 1/16 strobes), the editor warns you and that light automatically plays a slower version.
- **Simulator** that models each light's fade, update rate and latency, and renders it the way a camera would: real falloff on the walls, beams through haze, floor reflections and hot sources that bloom. Drag lights around, aim floods, drape string lights, and drop in a photo of your space to see it lit by your rig.
- **TV visuals:** a library of 30 animated effects drawn as braille, ASCII, lines, dots, grain or blocks, locked to the same beat clock and palette as the lights. Group several TVs and one picture spans them all.

---

## Get it

### Option A: download the app
Go to **Releases** on this repo and download:
- **Windows:** `LightingSim-windows.zip`. Unzip it anywhere (for example into Documents) and double-click `LightingSim.exe`. Right-click it → **Pin to Start** or **Send to → Desktop** for a shortcut. If Windows SmartScreen warns about an unknown app, click **More info → Run anyway**.
- **Mac (Apple Silicon):** `LightingSim-macos-apple-silicon.zip`. Unzip it and move `LightingSim.app` to Applications. The first time, **right-click → Open** (the app isn't signed by Apple). Allow "local network" access when macOS asks; Link and Wi-Fi lights need it.

LightingSim opens in its own window. There's no browser tab or terminal to keep open, and closing the window quits the app (it blacks out any live lights first). The window uses Microsoft Edge WebView2, which is built into Windows 10 and 11. If it's missing, the app opens in your browser instead.

### Option B: run from source (any Mac, including Intel, and Windows)
1. Install Python 3.10 or newer from [python.org](https://www.python.org/downloads/).
2. Download this repo (green **Code** button → Download ZIP, or `git clone`).
3. Double-click **`run-windows.bat`** (Windows) or **`run-mac.command`** (Mac). The first run installs everything into a local `.venv` folder.

The app window opens and the setup window closes by itself. To use your web browser instead, run with `--browser`; the controller is then at `http://127.0.0.1:8750`.

---

## Sync with rekordbox

1. In rekordbox, switch to **PERFORMANCE** mode.
2. Click **LINK** at the top of the rekordbox window (rekordbox 6 or newer). If you can't find it, search rekordbox's Preferences for "Link".
3. In LightingSim go to **Setup** and choose **Link**. The top bar shows `Link 1` once it's connected.
4. Make the deck you're playing the tempo **MASTER** in rekordbox.

Link shares tempo and the position within the bar. It doesn't know where phrases or drops are. Use the top bar:
- **Beat 1**: press on a downbeat if the lights feel a beat or two off.
- **Drop**: press on the first beat of a drop to line up 8-bar loops and Auto changes.
- **− / +**: nudge the phase a hair.
- **½ / 2**: half-time and double-time without touching rekordbox.

rekordbox and LightingSim can run on the same laptop or on two machines on the same network.

---

## Budget hardware guide

| What you want | Buy | Rough cost | Connects via | Fastest clean strobe at 128 BPM |
|---|---|---|---|---|
| Strobes / floods | "DMX 7ch" LED floods or PARs | $25–40 each | USB Open DMX cable ($15–20, FTDI) or Enttec USB Pro clone | 1/16 |
| LED strips | WS2812B strip + ESP32 running [WLED](https://install.wled.me) | $5 + $10–20 per 5 m | Wi-Fi (DDP) | 1/16 (1/32 at slower tempos with the engine at 90–120 fps) |
| DIY bulbs | 12 mm WS2811 pixel bulbs on the same ESP32 | $1–2 per bulb | Wi-Fi (WLED) | 1/16 |
| Smart bulbs | WiZ colour bulbs | $8–12 each | Wi-Fi (local UDP) | 1 beat |
| Warm filament bulbs | Standard bulbs + 4-ch DMX dimmer pack | ~$40 pack | DMX | 1 beat (they glow up and down slowly) |
| Govee outdoor string lights | What you already have | – | Wi-Fi (Govee LAN API) | 1 beat, with smoothing |
| Floods on smart plugs | Any flood + smart plug | ~$10 | – (simulate only) | Not for strobing: relays wear out |

**Cheapest fast setup:** one ESP32 running WLED for strips and pixel bulbs, plus one USB-DMX cable for a pair of floods, about $60–80 on top of the lights.

**Govee:** open the Govee Home app → each light → settings → turn on **LAN Control**. Then use **Rig → Find Govee lights**. The LAN API sets the whole device to one colour. Govee firmware smooths changes and handles about 10 updates a second, so it suits colour moves and beat pulses, not strobes.

**DMX floods:** set each light's DMX address with its menu buttons, then enter the same start address and channel order in the inspector (for example `dim, r, g, b, strobe, 0, 0` for a typical 7-channel flood). Put `0` on mode and speed channels. LightingSim does the strobing itself, so leave the light's own strobe channel at 0.

---

## TV visuals

The TV is part of the rig. It sits on the stage like any other light (drag it, resize it from its corner), and it plays whatever visual the current scene has. Change scene and the TV changes with it, on the same beat and with the same transition. It also reacts to what the lights are doing, so a kick pattern on the floods pushes the picture.

Open the **TV** tab to browse the library. Every tile is live. Click one to give it to the scene that's playing.

- **Moody:** Smoke, Contours, Aurora, Ribbons, Rain, Halo, Wings, Drift, Comet
- **Dynamic:** Currents, Ink, Bloom, Ridges, Swell, Tunnel, Moiré, Melt, Skin, Liquid, Vortex, Orbit
- **Harsh:** Shards, Tear, Bars, Shock, Static, Blocks, Cutup, Radar, Warp

Each visual has a **style** (Braille, ASCII, Lines, Dots, Grain, Blocks), **colour** (Palette follows the lights), **detail**, **speed**, **energy**, **scale** and **glow**.

While performing, the **Energy** slider on the Play tab pushes every visual from moody toward harsh. **Hold** keeps the current visual when scenes change. **Flash**, **Strobe**, **Black**, **Master** and the **TV** fader all reach the screen too.

### Putting it on a real TV

Press **Open** on the Play or TV tab.

- **HDMI:** with the TV connected as a second display, the picture opens fullscreen on it.
- **Smart TV or casting:** tick **Allow phones and TVs on Wi-Fi** in Setup and restart. The TV tab shows an address ending in `/tv`. Open it in the TV's browser, or cast that browser tab.

**Several TVs as one display:** in the Rig tab, select a TV and press **Add TV**. The new TV joins it side by side and the picture extends across both. Put existing TVs in the same **Group** (A, B or C) and press **Line up** to do the same by hand. The picture covers the box around the group, and each TV shows the part where it sits on stage, so gaps between TVs behave like gaps in a real video wall.

With a group on one computer, **Open** stretches a single window across that many spare displays. A TV with its own browser can show just its part at the address in its Rig panel, ending in `/tv?id=…`. Those separate pages stay on the same beat, but Currents, Ink, Melt, Skin, Orbit and Radar build up frame by frame on each screen, so they won't line up exactly at the seams; use the stretched window for those.

Double-click the picture to toggle fullscreen. If the TV lags behind the lights, set its **Delay ms** in the Rig tab to its input lag; the picture is sent that much early.

---

## Designing looks

A **scene** (a pad on the Play tab) loops for 1, 2, 4 or 8 bars. A scene contains **tracks**. Each track is:

- **Lights:** which groups it drives (Floods, Strips, Strings, Bulbs, or All). Scenes target groups, not individual lights, so presets keep working when you add or move lights.
- **Look:** solid, colour cycle, sweep/chase band, wave, rainbow, gradient, sparkle, split colours, or candle flicker. Spatial looks use where the lights sit on the stage, so moving a light changes the show.
- **Steps:** a drum-machine grid. Step size is 1 beat down to 1/32 beat (plus triplets); length is 1–8 bars (up to 128 steps). Click or drag to paint; Shift or right-click paints half brightness.
- **Shape:** Hold, Gate (hard on/off, the strobe setting), Decay, Swell, Glide, Pulse.
- **Spread:** how steps move across lights. Together, Alternate (alternating strobes), Chase, Bounce, Fill, Random, Odd, Even.
- **Slow lights:** what lights that can't keep up should do. Slower (default), Steady, or Dark.
- **Mix:** Brightest, Add, Cover, or Mask (cut the tracks above into shapes).

Colours can be palette slots (`p0`–`p3`) or fixed colours. Change the palette on the Play tab and every scene and visual recolours.

**Performing:** pads launch on the next beat, bar, or phrase (you choose), with a Cut, Fade, Wipe, Iris, Flash, or Dip transition. Shift-click launches instantly. **Flash** and **Strobe** are hold buttons. The group faders trim each type of light. **Auto** changes scenes every 4–32 bars for hands-free sets.

### Why a light "can't switch" that fast
Every light type has five limits, which you can see and edit in the inspector:

| Limit | Meaning |
|---|---|
| Updates / sec | How often the device accepts a new value. The simulator sample-and-holds at this rate. |
| Latency | Network and firmware delay. When Live is on, LightingSim sends each light's values this much early so they land on the beat. |
| Fade-up / fade-down | Filament glow and firmware smoothing. The simulator reproduces it. |
| Shortest flash | Below this, flashes blur together. |

The engine also can't run faster than its own frame rate (60 fps by default). 1/32 at 128 BPM is a 15 ms step, which is faster than 60 fps and faster than DMX's ~44 Hz refresh, so even fast lights drop to 1/16 unless you raise the engine rate for WLED gear.

---

## Controls

| Key | Action |
|---|---|
| `Space` | Beat 1 (`Shift` = Drop) |
| `T` | Tap tempo |
| `1`–`9` | Launch pads 1–9 (Shift = instantly) |
| `F` (hold) | Flash |
| `S` (hold) | Strobe |
| `B` | Blackout |
| `H` | Hold the TV's visual |
| `←` / `→` | Nudge phase |
| `[` / `]` | Half-time / double-time |
| `Delete` | Remove the selected light (Rig tab) |

**MIDI controllers:** Setup → tick your controller → pick an action → **Learn** → press a pad or move a knob. Pads can launch scenes; knobs and faders can drive master, flash, group levels and TV energy.

**Phone remote:** tick **Allow phones and TVs on Wi-Fi**, restart, and open the address Setup shows on your phone.

**Live:** real lights only receive data while Live is on. With it off, everything is simulation. Turning it off blacks out the real lights.

---

## Moving between computers

Your rig and scenes autosave to:
- Windows: `%APPDATA%\LightingSim\show.json`
- macOS: `~/Library/Application Support/LightingSim/show.json`

Use **Setup → Export** to save a `.lightshow.json` file and **Import** on the other machine. You can commit show files to this repo to keep them with the app.

---

## Safety

- Strobes of roughly 3–30 flashes per second can trigger seizures in people with photosensitive epilepsy. There's a **Flash limit** in Setup that slows the lights and the TV's harsh visuals; turn it on when guests are around, and warn people before strobe-heavy sets.
- Mains-voltage projects (dimmer packs, relays, outdoor floods) should use rated, weatherproof gear. Keep DIY work to low-voltage LED pixels unless you know what you're doing.

---

## Development

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt pytest   # Windows: .venv\Scripts\pip
.venv/bin/python -m pytest -q tests
.venv/bin/python -m lightsim --show dev-show.json
```

Options: `--port 8750`, `--lan` (allow phones), `--browser` (use a browser tab instead of the app window), `--no-browser` (server only), `--show PATH`. Logs go to `lightsim.log` next to the show file.

| Path | What's there |
|---|---|
| `lightsim/engine.py` | Vectorised render engine: gates, fallbacks, effects, transitions, sample & hold |
| `lightsim/clock.py` | Ableton Link, MIDI clock and tap-tempo beat clock |
| `lightsim/outputs.py` | WLED (DDP), Govee LAN, WiZ, DMX (USB Pro, Open DMX, Art-Net) |
| `lightsim/fixtures.py` | Light profiles and their physical limits |
| `lightsim/presets.py` | Palettes, demo rig and built-in scenes |
| `web/` | The controller UI (plain ES modules, no build step) |
| `web/js/visuals/` | TV visuals: the effect library, the WebGL glyph renderer, and TV groups |
| `web/js/stage-gl.js` | The stage's physically based light renderer |
| `web/tv.html` | The bare TV output, served at `/tv` |
| `packaging/` | PyInstaller spec for the Windows/Mac apps |

**Releasing:** push a tag such as `v1.0.1`. GitHub Actions runs the tests on Windows and macOS, builds both apps, and attaches them to a GitHub Release.
