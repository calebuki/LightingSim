// The real TV output: a bare, full-window picture with no controls.
//   /tv            the main picture
//   /tv?wall=A     all of group A, for one window stretched across several displays
//   /tv?id=<tv>    just this TV's part of its group, for a TV with its own browser
import { S } from './state.js';
import { connect } from './net.js';
import { TV } from './visuals/tv.js';
import { wallsOf } from './visuals/walls.js';

const canvas = document.getElementById('screen');
const tv = new TV(canvas);
const params = new URLSearchParams(location.search);
const wantId = params.get('id');
const wantWall = params.get('wall');
const WHOLE = [0, 0, 1, 1];

/** What this window shows: which wall, and which part of it. */
function target() {
  const walls = wallsOf(S.show.fixtures, S.show.settings.stage.aspect);
  if (wantId) {
    for (const wall of walls) {
      const t = wall.tvs.find((x) => x.f.id === wantId);
      if (t) return { wall, region: t.region, f: t.f };
    }
  }
  const wall = (wantWall != null && walls.find((w) => w.id === wantWall)) || walls[0];
  return { wall, region: WHOLE, f: wall.tvs[0]?.f };
}

function loop() {
  requestAnimationFrame(loop);
  if (!S.show || !tv.due()) return;
  const { wall, region, f } = target();
  // the part we show keeps its shape; a window of another shape gets black bars
  const shape = (wall.aspect * region[2]) / region[3];
  const winW = innerWidth, winH = innerHeight;
  const fits = Math.abs(shape / (winW / winH) - 1) < 0.04;
  const cssW = fits ? winW : Math.min(winW, winH * shape);
  const cssH = fits ? winH : cssW / shape;
  const dpr = Math.min(2, devicePixelRatio || 1);
  const w = Math.round(cssW * dpr), h = Math.round(cssH * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
  }
  tv.tick(f?.caps.latency_ms ?? 0);
  tv.draw(w, h, wall, region);
}

// double-click for fullscreen; the cursor hides itself
window.addEventListener('dblclick', () => {
  if (window.pywebview?.api?.toggle_fullscreen) return window.pywebview.api.toggle_fullscreen();
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
});
let idle;
window.addEventListener('pointermove', () => {
  document.body.classList.remove('idle');
  clearTimeout(idle);
  idle = setTimeout(() => document.body.classList.add('idle'), 1500);
});
document.body.classList.add('idle');

connect();
loop();
