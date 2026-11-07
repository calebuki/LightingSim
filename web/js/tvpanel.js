// The TV picture in the controller, the visual library, and opening the real TV window.
import { S, send, scene } from './state.js';
import { $, $$, debounce, emit, h, on, select } from './util.js';
import { BASE, COLORS, DETAIL, MOODS, STYLES, VISUALS, resolveVisual } from './visuals/library.js';
import { TV } from './visuals/tv.js';
import { motionRate } from './visuals/renderer.js';
import { wallsOf } from './visuals/walls.js';

let tv, gl, view, ctx;
let root, library, controls;
let filter = 'all';
let tiles = [];
let tvW = 960, tvH = 540, baseW = 960;
let panelAspect = 16 / 9;
let renderedKey = '';

let walls = [];
const pictures = new Map(); // group -> { canvas, ctx }, the finished picture

/** Every picture being drawn, for the stage. */
export const wallOutputs = () => walls.map((wall) => ({ id: wall.id, wall, canvas: pictures.get(wall.id)?.canvas })).filter((o) => o.canvas);
export const heldOn = () => !!(S.show?.settings.tv?.hold && S.show.settings.tv.held);

// ------------------------------------------------------------------ output loop
export function initTVOutput() {
  gl = document.createElement('canvas');
  tv = new TV(gl);
  view = $('#tv');
  ctx = view.getContext('2d', { alpha: false });
  view.width = tvW;
  view.height = tvH;
  const wrap = view.parentElement;
  new ResizeObserver(fit).observe(wrap);
  on('resize', fit);
  (function loop() {
    requestAnimationFrame(loop);
    if (!S.show || !tv.ok || !tv.due()) return;
    tv.tick(0);
    walls = wallsOf(S.show.fixtures, S.show.settings.stage.aspect || 16 / 9);
    if (walls[0].aspect !== panelAspect) { panelAspect = walls[0].aspect; fit(); }
    for (const wall of walls) {
      const w = Math.min(2400, Math.round(baseW * wall.unitsWide)), ht = Math.max(2, Math.round(w / wall.aspect));
      let pic = pictures.get(wall.id);
      if (!pic) {
        const canvas = document.createElement('canvas');
        pic = { canvas, ctx: canvas.getContext('2d', { alpha: false }) };
        pictures.set(wall.id, pic);
      }
      if (pic.canvas.width !== w || pic.canvas.height !== ht) { pic.canvas.width = w; pic.canvas.height = ht; }
      if (tv.draw(w, ht, wall)) pic.ctx.drawImage(gl, 0, gl.height - ht, w, ht, 0, 0, w, ht);
    }
    paintPanel(walls[0]);
    drawTiles();
  })();
}

function fit() {
  const wrap = view.parentElement;
  const W = wrap.clientWidth, H = wrap.clientHeight;
  if (!W || !H) return;
  const w = Math.min(W, H * panelAspect), ht = w / panelAspect;
  view.style.width = `${w}px`;
  view.style.height = `${ht}px`;
  const dpr = Math.min(2, devicePixelRatio || 1);
  tvW = Math.round(w * dpr);
  tvH = Math.round(ht * dpr);
  baseW = Math.round(Math.min(W, (H * 16) / 9) * dpr);
  if (view.width !== tvW || view.height !== tvH) { view.width = tvW; view.height = tvH; }
}

/** The panel shows the biggest group as it will look: one picture, seen through its TVs. */
function paintPanel(wall) {
  const pic = pictures.get(wall.id);
  if (!pic) return;
  const { canvas } = pic;
  if (wall.tvs.length < 2) return ctx.drawImage(canvas, 0, 0, view.width, view.height);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, view.width, view.height);
  for (const { region: [u, v, du, dv] } of wall.tvs) {
    const top = 1 - v - dv;
    ctx.drawImage(canvas, u * canvas.width, top * canvas.height, du * canvas.width, dv * canvas.height,
      u * view.width + 1, top * view.height, du * view.width - 2, dv * view.height);
  }
}

/** Opens every picture on real screens. Pressing again closes them. */
export async function openTV() {
  const list = wallsOf(S.show.fixtures, S.show.settings.stage.aspect || 16 / 9).map((w) => ({
    query: w.id ? `wall=${w.id}` : '', tvs: w.id ? w.tvs.length : 1, aspect: w.aspect,
  }));
  if (window.pywebview?.api?.open_tv) return window.pywebview.api.open_tv(list);
  list.forEach((s, i) => window.open(`/tv${s.query ? `?${s.query}` : ''}`, `lightsim-tv-${i}`, `popup,width=1280,height=${Math.round(1280 / s.aspect)}`));
}

// ------------------------------------------------------------------ which visual the panel edits
const tvSettings = () => S.show.settings.tv || {};
const liveScene = () => S.status?.engine.preview || S.status?.engine.current || S.show.bank[0];
const editing = () => (heldOn() ? tvSettings().held : scene(liveScene())?.visual);
const saveScene = debounce((id) => { const sc = scene(id); if (sc) send('scene_update', { scene: sc }); }, 70);

function patchVisual(patch) {
  if (heldOn()) {
    send('settings', { patch: { tv: { held: { ...tvSettings().held, ...patch } } } });
    S.show.settings.tv.held = { ...tvSettings().held, ...patch };
  } else {
    const sc = scene(liveScene());
    if (!sc) return;
    sc.visual = { ...sc.visual, ...patch };
    saveScene(sc.id);
    emit('scenes', sc.id);
  }
  renderControls();
  markTiles();
}

export function toggleHold() {
  const set = tvSettings();
  const next = !set.hold;
  const patch = { hold: next };
  if (next) patch.held = { ...resolveVisual(scene(liveScene())?.visual) };
  send('settings', { patch: { tv: patch } });
}

// ------------------------------------------------------------------ library tab
export function initTVPanel() {
  root = $('#tab-tv');
  controls = h('div#tv-controls');
  library = h('div#tv-library');
  root.append(controls, library);
  on('init', () => { renderLibrary(); renderControls(); });
  on('settings', () => { renderControls(); markTiles(); });
  on('tab', (t) => { if (t === 'tv') { sizeTiles(); renderControls(); markTiles(); } });
  on('status', () => {
    const key = `${liveScene()}|${heldOn()}`;
    if (key !== renderedKey && !root.hidden) { renderControls(); markTiles(); }
  });
  new ResizeObserver(sizeTiles).observe(library);
}

function renderLibrary() {
  const shown = VISUALS.filter((v) => filter === 'all' || v.mood === filter);
  tiles = shown.map((def, i) => {
    const canvas = h('canvas');
    const el = h('button.tile', { 'data-id': def.id, onclick: () => patchVisual(pickPatch(def)) }, canvas, h('span', def.name));
    return { def, el, canvas, ctx: canvas.getContext('2d', { alpha: false }), vis: null, phase: i };
  });
  library.replaceChildren(
    h('div.tabs',
      [['all', 'All'], ...MOODS].map(([k, label]) => h('button', { class: filter === k ? 'on' : '', onclick: () => { filter = k; renderLibrary(); sizeTiles(); markTiles(); } }, label)),
      h('span.grow'),
      h('button', { 'data-id': 'none', class: 'tile-black', onclick: () => patchVisual({ id: 'none' }) }, 'Black')),
    h('div.tiles', tiles.map((t) => t.el)));
  sizeTiles();
  markTiles();
}

/** Switching visual drops per-visual tweaks that the new one sets itself. */
function pickPatch(def) {
  const clean = { id: def.id, style: BASE.style, color: BASE.color, cols: BASE.cols, glow: BASE.glow, ...def.defaults };
  return clean;
}

function sizeTiles() {
  for (const t of tiles) {
    const w = t.el.clientWidth, ht = t.el.clientHeight;
    if (!w || !ht || t.canvas.width === w && t.canvas.height === ht) continue;
    t.canvas.width = w;
    t.canvas.height = ht;
    t.vis = resolveVisual({ id: t.def.id, cols: Math.max(24, Math.round(w / 4)) });
  }
}

function markTiles() {
  const cur = resolveVisual(editing());
  $$('.tile', library).forEach((el) => el.classList.toggle('on', el.dataset.id === cur.id));
  $('.tile-black', library)?.classList.toggle('on', cur.id === 'none');
}

let tileIndex = 0;
function drawTiles() {
  if (!root || root.hidden || !tiles.length) return;
  // a few tiles per frame keeps the library alive without eating the TV's frame budget
  const n = Math.min(tiles.length, 7);
  for (let i = 0; i < n; i++) {
    const t = tiles[tileIndex++ % tiles.length];
    if (!t.vis) continue;
    if (tv.drawThumb(t.vis, t.canvas.width, t.canvas.height)) {
      t.ctx.drawImage(gl, 0, gl.height - t.canvas.height, t.canvas.width, t.canvas.height, 0, 0, t.canvas.width, t.canvas.height);
    }
  }
}

function seg(options, value, onpick) {
  return h('div.seg', options.map(([v, label]) =>
    h('button', { class: String(v) === String(value) ? 'on' : '', onclick: () => onpick(v) }, label)));
}

function slider(label, key, v, min, max) {
  return h('label.row',
    h('span.lbl', label),
    h('div.row-c', h('input', { type: 'range', min, max, step: 0.01, value: v, 'aria-label': label,
      oninput: (e) => patchVisualQuiet({ [key]: parseFloat(e.target.value) }) })));
}

/** Changing how fast a visual moves shouldn't make it jump: t0 keeps it where it is right now. */
function keepMotion(vis, patch) {
  const f = tv.frame;
  if (!f || !('speed' in patch || 'energy' in patch)) return patch;
  const was = resolveVisual(vis), next = { ...was, ...patch };
  const at = (v) => motionRate(v) * f.beat + 0.9 * v.speed * (f.phase || 0);
  return { ...patch, t0: (was.t0 || 0) + at(was) - at(next) };
}

/** Slider drags change the picture without rebuilding the controls under the pointer. */
function patchVisualQuiet(patch) {
  if (heldOn()) {
    S.show.settings.tv.held = { ...tvSettings().held, ...keepMotion(tvSettings().held, patch) };
    send('settings', { patch: { tv: { held: S.show.settings.tv.held } } });
  } else {
    const sc = scene(liveScene());
    if (!sc) return;
    sc.visual = { ...sc.visual, ...keepMotion(sc.visual, patch) };
    saveScene(sc.id);
  }
}

function renderControls() {
  if (!controls || !S.show || root.hidden) return;
  if (document.activeElement?.type === 'range' && controls.contains(document.activeElement)) return;
  renderedKey = `${liveScene()}|${heldOn()}`;
  const v = resolveVisual(editing());
  const set = tvSettings();
  const scenes = S.show.bank.map(scene).filter(Boolean).map((s) => [s.id, s.name]);
  const lan = S.lan && S.lanUrls[0] ? `${S.lanUrls[0]}/tv` : '';
  controls.replaceChildren(...[
    h('div.row',
      h('span.lbl', 'Scene'),
      h('div.row-c',
        select(scenes, liveScene(), (id) => send('launch', { scene: id, quantize: 'now' }), { 'aria-label': 'Scene', disabled: heldOn() }),
        h('button.toggle', { class: set.hold ? 'on' : '', title: 'Keep this visual when scenes change (H)', onclick: toggleHold }, 'Hold'),
        h('button', { title: 'Open the TV picture in its own window', onclick: openTV }, 'Open'))),
    h('div.row', h('span.lbl', 'Style'), seg(STYLES, v.style, (x) => patchVisual({ style: x }))),
    h('div.row', h('span.lbl', 'Colour'), seg(COLORS, v.color, (x) => patchVisual({ color: x }))),
    h('div.row', h('span.lbl', 'Detail'), seg(DETAIL, v.cols, (x) => patchVisual({ cols: x }))),
    slider('Speed', 'speed', v.speed, 0.1, 3),
    slider('Energy', 'energy', v.energy, 0, 1),
    slider('Scale', 'scale', v.scale, 0.4, 2.5),
    slider('Glow', 'glow', v.glow, 0, 1.5),
    lan ? h('div.row', h('span.lbl', 'Address'), h('code', lan)) : null,
  ].filter(Boolean));
}
