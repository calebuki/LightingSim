// Stage simulator: emulates each light's physical fade, feeds the renderer in stage-gl.js,
// paints the hardware, and lets you move lights (Rig tab).
import { S, send, fixture } from './state.js';
import { $, clamp, emit, on, throttle } from './util.js';
import { wallOutputs } from './tvpanel.js';
import { tvBox } from './visuals/walls.js';
import { StageRenderer } from './stage-gl.js';

let cv, ctx, W = 0, H = 0, dpr = 1;
let rect = { ox: 0, oy: 0, w: 1, h: 1 };
let lay = { P: 0, offsets: [0], pos: [] };
let disp = new Float32Array(0);
let bgImg = null, bgSrc = '';
let drag = null, hover = null;
let lastT = performance.now();
let gl = null, glCanvas = null;
let nextDraw = 0, startT = performance.now();
let bodiesDirty = true;
const bodies = document.createElement('canvas');
// the light each picture throws on the room: every picture, small, one above another
const spill = document.createElement('canvas');
spill.width = 128;
const spillCtx = spill.getContext('2d', { alpha: false });
const SPREAD = 0.38; // flood half-angle, radians
const FLOOR = 0.84; // where the wall meets the floor, unless the stage is a photo
let pointData = new Float32Array(9 * 256), floodData = new Float32Array(12 * 32), poolData = new Float32Array(8 * 64);
const canEdit = () => S.tab === 'rig';

// ------------------------------------------------------------------ geometry
export function pixelPositions(fx) {
  const n = fx.pixels;
  if (!['line', 'string'].includes(fx.shape) || n === 1) return Array.from({ length: n }, () => [fx.x, fx.y]);
  const sag = fx.shape === 'string' ? fx.sag || 0 : 0;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    pts.push([fx.x + (fx.x2 - fx.x) * u, fx.y + (fx.y2 - fx.y) * u + sag * 4 * u * (1 - u)]);
  }
  return pts;
}
function rebuildLayout() {
  const fxs = S.show?.fixtures || [];
  const offsets = [0];
  const pos = [];
  for (const f of fxs) {
    offsets.push(offsets[offsets.length - 1] + f.pixels);
    pos.push(pixelPositions(f));
  }
  const P = offsets[offsets.length - 1];
  if (P !== lay.P) disp = new Float32Array(P * 3);
  lay = { P, offsets, pos };
  bodiesDirty = true;
}
const px = (x) => rect.ox + x * rect.w;
const py = (y) => rect.oy + y * rect.h;
const unit = () => rect.h / 620; // scale lights with stage size

function resize() {
  const wrap = cv.parentElement;
  dpr = Math.min(2, window.devicePixelRatio || 1);
  W = wrap.clientWidth; H = wrap.clientHeight;
  cv.width = Math.max(1, W * dpr); cv.height = Math.max(1, H * dpr);
  const aspect = S.show?.settings.stage.aspect || 16 / 9;
  let w = W, h = w / aspect;
  if (h > H) { h = H; w = h * aspect; }
  rect = { ox: (W - w) / 2, oy: (H - h) / 2, w: Math.max(w, 10), h: Math.max(h, 10) };
  if (glCanvas && W && H) {
    glCanvas.style.left = `${rect.ox}px`;
    glCanvas.style.top = `${rect.oy}px`;
    glCanvas.style.width = `${rect.w}px`;
    glCanvas.style.height = `${rect.h}px`;
    const scale = Math.min(1.5, window.devicePixelRatio || 1, 1920 / rect.w);
    gl?.resize(Math.round(rect.w * scale), Math.round(rect.h * scale));
    bodiesDirty = true;
  }
}

// ------------------------------------------------------------------ physics
function stepPhysics(dt) {
  const f = S.frame;
  const fxs = S.show?.fixtures || [];
  if (!f || f.length !== lay.P * 3) return;
  for (let i = 0; i < fxs.length; i++) {
    const c = fxs[i].caps;
    const up = c.rise_ms > 0 ? 1 - Math.exp(-dt / c.rise_ms) : 1;
    const down = c.fall_ms > 0 ? 1 - Math.exp(-dt / c.fall_ms) : 1;
    for (let j = lay.offsets[i] * 3, e = lay.offsets[i + 1] * 3; j < e; j++) {
      const t = f[j], d = disp[j];
      disp[j] = d + (t - d) * (t > d ? up : down);
    }
  }
}

// ------------------------------------------------------------------ the scene for the renderer
const linear = (v) => (v / 255) ** 2.2;

function buildScene(outputs) {
  const st = S.show.settings.stage;
  const placed = new Map();
  outputs.forEach((o, n) => o.wall.tvs.forEach((t) => placed.set(t.f.id, { n, id: o.id, region: t.region })));
  const fxs = S.show.fixtures;
  const aspect = rect.w / rect.h;
  const floor = bgImg ? 9 : FLOOR;
  if (pointData.length < (lay.P + 64) * 9) pointData = new Float32Array((lay.P + 64) * 18);
  let np = 0, nf = 0, npool = 0;
  let gr = 0, gg = 0, gb = 0;
  const screens = [];

  const point = (x, y, r, g, b, power, h, core, kind) => {
    const o = np++ * 9;
    pointData[o] = x; pointData[o + 1] = y;
    pointData[o + 2] = r; pointData[o + 3] = g; pointData[o + 4] = b;
    pointData[o + 5] = power; pointData[o + 6] = h; pointData[o + 7] = core; pointData[o + 8] = kind;
  };
  const pool = (x, y, r, g, b, power, rx, ry) => {
    if (npool * 8 >= poolData.length) return;
    const o = npool++ * 8;
    poolData[o] = x; poolData[o + 1] = y;
    poolData[o + 2] = r; poolData[o + 3] = g; poolData[o + 4] = b;
    poolData[o + 5] = power; poolData[o + 6] = rx; poolData[o + 7] = ry;
  };

  fxs.forEach((f, i) => {
    const size = f.size || 1;
    if (f.shape === 'screen') {
      const place = placed.get(f.id);
      if (!place) return;
      const box = tvBox(f, aspect);
      const hw = box.w / 2, hh = box.h / 2;
      const cx = f.x * aspect, cy = f.y;
      const [u, v, du, dv] = place.region;
      screens.push({ x: cx, y: cy, hw, hh, picture: place.id, region: place.region });
      // the picture lights the wall around it, each patch in its own colour
      for (let a = 0; a < 4; a++) {
        for (let b = 0; b < 3; b++) {
          const pv = v + dv * (1 - (b + 0.5) / 3);
          point(cx + ((a + 0.5) / 4 - 0.5) * 2 * hw, cy + ((b + 0.5) / 3 - 0.5) * 2 * hh, u + du * ((a + 0.5) / 4), (place.n + pv) / outputs.length, 0, 0.012 * size, 0.1, 0, 4);
        }
      }
      return;
    }
    const start = lay.offsets[i];
    const pts = lay.pos[i];
    const filament = f.kind === 'bulb_incandescent';
    for (let k = 0; k < f.pixels; k++) {
      const j = (start + k) * 3;
      const m = Math.max(disp[j], disp[j + 1], disp[j + 2]);
      if (m < 1.2) continue;
      let r = linear(disp[j]), g = linear(disp[j + 1]), b = linear(disp[j + 2]);
      if (filament) { // a dimmed filament runs cooler, and glows redder
        const l = Math.max(r, g, b);
        g *= l ** 0.28;
        b *= l ** 0.75;
      }
      const x = pts[k][0] * aspect, y = pts[k][1];
      if (f.shape === 'line') {
        point(x, y, r, g, b, 0.0009 * size, 0.03, 0.0034 * size, 0);
        gr += r * 0.0015; gg += g * 0.0015; gb += b * 0.0015;
      } else if (f.shape === 'string') {
        point(x, y + 0.008 * size, r, g, b, 0.011 * size, 0.07, 0.0078 * size, 1);
        gr += r * 0.004; gg += g * 0.004; gb += b * 0.004;
      } else if (f.shape === 'bulb') {
        point(x, y, r, g, b, 0.06 * size, 0.22, 0.0155 * size, filament ? 3 : 2);
        gr += r * 0.012; gg += g * 0.012; gb += b * 0.012;
      } else if (f.shape === 'flood') {
        if (nf * 12 >= floodData.length) continue;
        const power = (f.kind === 'strobe_dmx' ? 1.3 : 0.8) * size;
        const a = (f.angle * Math.PI) / 180;
        const dx = Math.cos(a), dy = Math.sin(a);
        const lensR = 0.019 * size;
        const back = lensR / Math.tan(SPREAD);
        const lensX = x + dx * 0.012 * size, lensY = y + dy * 0.012 * size;
        let L = 1.9;
        if (floor < 2 && y < floor && dy > 0.05) {
          const t = (floor + 0.05 - lensY) / dy;
          L = Math.min(L, t + back + 0.08);
          // where the beam lands: a pool, flattened by the view across the floor
          const rx = t * Math.tan(SPREAD) * 1.05 + 0.05;
          pool(lensX + dx * t, floor + 0.05, r, g, b, (power * 2.2) / (1 + t * t * 1.5), rx, rx * 0.2);
        } else if (floor < 2 && y >= floor) {
          pool(x, y + 0.006, r, g, b, power * 0.5, 0.1 * size, 0.022 * size);
        }
        const o = nf++ * 12;
        floodData[o] = lensX - dx * back; floodData[o + 1] = lensY - dy * back;
        floodData[o + 2] = r; floodData[o + 3] = g; floodData[o + 4] = b;
        floodData[o + 5] = power; floodData[o + 6] = a; floodData[o + 7] = SPREAD; floodData[o + 8] = L;
        floodData[o + 9] = back; floodData[o + 10] = i * 0.37; floodData[o + 11] = lensR;
        gr += r * 0.04 * power; gg += g * 0.04 * power; gb += b * 0.04 * power;
      }
    }
  });

  const glow = 0.1;
  return {
    aspect, floor, time: (performance.now() - startT) / 1000,
    haze: (st.haze ?? 0.5) * 1.1,
    ambient: 0.004 + (st.room ?? 0.1) * (bgImg ? 0.55 : 0.28),
    glow: [gr * glow, gg * glow, gb * glow],
    points: pointData, nPoints: np,
    floods: floodData, nFloods: nf,
    pools: poolData, nPools: npool,
    screens,
  };
}

// ------------------------------------------------------------------ hardware
/** Paints what the lights hang from and are made of, as reflectance: light from elsewhere picks it out. */
function paintBodies() {
  const W2 = gl.w, H2 = gl.h;
  if (bodies.width !== W2 || bodies.height !== H2) { bodies.width = W2; bodies.height = H2; }
  const c = bodies.getContext('2d');
  c.clearRect(0, 0, W2, H2);
  if (bgImg && bgImg.complete && bgImg.naturalWidth) c.drawImage(bgImg, 0, 0, W2, H2);
  const X = (x) => x * W2, Y = (y) => y * H2;
  const u = H2 / 620;
  c.lineCap = 'round';
  S.show.fixtures.forEach((f, i) => {
    const size = f.size || 1, s = size * u;
    const pts = lay.pos[i];
    if (f.shape === 'line') {
      // aluminium channel with the LED tape inside it
      c.strokeStyle = '#3a3a38'; c.lineWidth = 5.5 * s;
      c.beginPath(); c.moveTo(X(f.x), Y(f.y)); c.lineTo(X(f.x2), Y(f.y2)); c.stroke();
      c.strokeStyle = '#70706c'; c.lineWidth = 1 * s;
      c.beginPath(); c.moveTo(X(f.x), Y(f.y) - 2.6 * s); c.lineTo(X(f.x2), Y(f.y2) - 2.6 * s); c.stroke();
      c.strokeStyle = '#141413'; c.lineWidth = 2.8 * s;
      c.beginPath(); c.moveTo(X(f.x), Y(f.y)); c.lineTo(X(f.x2), Y(f.y2)); c.stroke();
    } else if (f.shape === 'string') {
      c.strokeStyle = '#101010'; c.lineWidth = Math.max(1, 1.4 * u);
      c.beginPath();
      for (let k = 0; k <= 40; k++) {
        const t = k / 40;
        const x = f.x + (f.x2 - f.x) * t, y = f.y + (f.y2 - f.y) * t + (f.sag || 0) * 4 * t * (1 - t);
        k ? c.lineTo(X(x), Y(y)) : c.moveTo(X(x), Y(y));
      }
      c.stroke();
      for (const p of pts) {
        const x = X(p[0]), y = Y(p[1]);
        c.fillStyle = '#1a1a19';
        c.fillRect(x - 2.2 * s, y - 1 * s, 4.4 * s, 4.6 * s);
        const g = c.createRadialGradient(x - 1.5 * s, y + 3.5 * s, 0, x, y + 5 * s, 5 * s);
        g.addColorStop(0, 'rgba(235,232,224,.75)');
        g.addColorStop(1, 'rgba(150,148,140,.45)');
        c.fillStyle = g;
        c.beginPath(); c.arc(x, y + 5 * s, 4.8 * s, 0, 7); c.fill();
      }
    } else if (f.shape === 'bulb') {
      const x = X(f.x), y = Y(f.y);
      c.strokeStyle = '#101010'; c.lineWidth = Math.max(1, 1.5 * u);
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x, y - 14 * s); c.stroke();
      const brass = c.createLinearGradient(x - 5 * s, 0, x + 5 * s, 0);
      brass.addColorStop(0, '#2a2925'); brass.addColorStop(0.45, '#6b6a62'); brass.addColorStop(1, '#1f1e1b');
      c.fillStyle = brass;
      c.fillRect(x - 4.6 * s, y - 16 * s, 9.2 * s, 8 * s);
      const g = c.createRadialGradient(x - 3 * s, y - 3 * s, 0.5 * s, x, y, 10 * s);
      g.addColorStop(0, 'rgba(240,238,230,.8)');
      g.addColorStop(0.5, 'rgba(190,188,180,.42)');
      g.addColorStop(1, 'rgba(120,118,112,.55)');
      c.fillStyle = g;
      c.beginPath(); c.arc(x, y, 9.6 * s, 0, 7); c.fill();
    } else if (f.shape === 'flood') {
      const x = X(f.x), y = Y(f.y);
      // a pipe to the ceiling, or a plate on the floor
      c.strokeStyle = '#161615';
      if (f.y < 0.5) {
        c.lineWidth = 3 * s;
        c.beginPath(); c.moveTo(x, 0); c.lineTo(x, y); c.stroke();
      } else {
        c.fillStyle = '#1b1b1a';
        c.fillRect(x - 16 * s, y + 9 * s, 32 * s, 3 * s);
        c.lineWidth = 3 * s;
        c.beginPath(); c.moveTo(x, y); c.lineTo(x, y + 10 * s); c.stroke();
      }
      c.save();
      c.translate(x, y);
      c.rotate((f.angle * Math.PI) / 180);
      const body = c.createLinearGradient(0, -13 * s, 0, 13 * s);
      body.addColorStop(0, '#3e3e3b'); body.addColorStop(0.5, '#262624'); body.addColorStop(1, '#141413');
      c.fillStyle = body;
      c.fillRect(-13 * s, -11 * s, 18 * s, 22 * s);
      c.fillStyle = '#0f0f0e'; // cooling fins
      for (let k = 0; k < 5; k++) c.fillRect(-13 * s + k * 3.4 * s, -13 * s, 1.6 * s, 26 * s);
      c.fillStyle = '#50504c'; // bezel
      c.fillRect(5 * s, -13 * s, 3 * s, 26 * s);
      c.fillStyle = '#6a6a65'; // yoke pivot
      c.beginPath(); c.arc(-3 * s, 0, 2.4 * s, 0, 7); c.fill();
      c.restore();
    } else if (f.shape === 'screen') {
      const hw = 0.11 * size * W2, hh = (hw * 9) / 16;
      c.fillStyle = '#1a1a19';
      c.fillRect(X(f.x) - hw - 1.4 * u, Y(f.y) - hh - 1.4 * u, 2 * hw + 2.8 * u, 2 * hh + 2.8 * u);
      c.fillStyle = '#050505';
      c.fillRect(X(f.x) - hw, Y(f.y) - hh, 2 * hw, 2 * hh);
    }
  });
  gl.setFixtures(bodies);
}

// ------------------------------------------------------------------ drawing
function draw() {
  requestAnimationFrame(draw);
  const now = performance.now();
  if (now < nextDraw - 3) return; // the light picture advances at 60 Hz on any display
  nextDraw = Math.max(nextDraw + 1000 / 60, now);
  const dt = Math.min(100, now - lastT);
  lastT = now;
  if (!S.show || !W || !H) return;
  stepPhysics(dt);
  const st = S.show.settings.stage;
  const fxs = S.show.fixtures;
  const u = unit();

  if (gl?.gl) {
    if (bodiesDirty) { paintBodies(); bodiesDirty = false; }
    const outputs = wallOutputs().filter((o) => o.wall.tvs.length);
    if (outputs.length) {
      const rowH = 24;
      if (spill.height !== rowH * outputs.length) spill.height = rowH * outputs.length;
      outputs.forEach((o, n) => {
        gl.setPicture(o.id, o.canvas);
        spillCtx.drawImage(o.canvas, 0, (outputs.length - 1 - n) * rowH, spill.width, rowH);
      });
      gl.setSpill(spill);
    }
    gl.render(buildScene(outputs));
  }

  // overlays
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  fxs.forEach((f, i) => {
    const hovered = hover && hover.id === f.id;
    const editing = canEdit();
    if (st.show_labels || (editing && (hovered || f.id === S.sel))) drawLabel(f, i, u);
    if (editing && f.id === S.sel) drawSelection(f, i, u);
    else if (editing && hovered) drawHover(f, i, u);
  });
}

/** A screen on the stage: 16:9, centred on (x, y), width set by size. */
function screenRect(f) {
  const sw = 0.22 * (f.size || 1) * rect.w;
  const sh = (sw * 9) / 16;
  return { x: px(f.x) - sw / 2, y: py(f.y) - sh / 2, w: sw, h: sh };
}

function drawLabel(f, i, u) {
  const x = px(f.x), y = py(f.y);
  ctx.font = `400 ${Math.max(10, 11 * Math.min(1.2, u))}px "JetBrains Mono", ui-monospace, monospace`;
  ctx.fillStyle = 'rgba(233,231,226,.75)';
  ctx.textAlign = 'center';
  const ly = f.shape === 'screen' ? y + screenRect(f).h / 2 + 14 : f.shape === 'flood' ? y + 24 * u : f.shape === 'bulb' ? y + 24 * u : y - 10 * u;
  const lx = ['line', 'string'].includes(f.shape) ? (x + px(f.x2)) / 2 : x;
  ctx.fillText(f.name, lx, ly);
}

function handles(f, u) {
  const hs = [];
  if (f.shape === 'screen') {
    const r = screenRect(f);
    hs.push({ mode: 'size', x: r.x + r.w, y: r.y + r.h });
  }
  if (['line', 'string'].includes(f.shape)) {
    hs.push({ mode: 'p1', x: px(f.x), y: py(f.y) }, { mode: 'p2', x: px(f.x2), y: py(f.y2) });
    if (f.shape === 'string') hs.push({ mode: 'sag', x: (px(f.x) + px(f.x2)) / 2, y: (py(f.y) + py(f.y2)) / 2 + (f.sag || 0) * rect.h });
  }
  if (f.shape === 'flood') {
    const a = (f.angle * Math.PI) / 180;
    hs.push({ mode: 'rotate', x: px(f.x) + Math.cos(a) * 46 * u, y: py(f.y) + Math.sin(a) * 46 * u });
  }
  return hs;
}

function outline(f, i, u) {
  ctx.beginPath();
  if (f.shape === 'screen') {
    const r = screenRect(f);
    ctx.rect(r.x - 2, r.y - 2, r.w + 4, r.h + 4);
  } else if (['line', 'string'].includes(f.shape)) {
    lay.pos[i].forEach((p, k) => (k ? ctx.lineTo(px(p[0]), py(p[1])) : ctx.moveTo(px(p[0]), py(p[1]))));
    if (f.pixels === 1) ctx.lineTo(px(f.x2), py(f.y2));
  } else {
    ctx.arc(px(f.x), py(f.y), (f.shape === 'flood' ? 20 : 15) * u * (f.size || 1), 0, 7);
  }
}
function drawSelection(f, i, u) {
  const ink = '#ffffff';
  ctx.save();
  ctx.strokeStyle = ink; ctx.lineWidth = ['line', 'string'].includes(f.shape) ? 14 * u : 2;
  ctx.globalAlpha = ['line', 'string'].includes(f.shape) ? 0.25 : 0.9;
  ctx.setLineDash(['line', 'string'].includes(f.shape) ? [] : [4, 3]);
  outline(f, i, u); ctx.stroke();
  ctx.restore();
  for (const hd of handles(f, u)) {
    ctx.fillStyle = '#000'; ctx.strokeStyle = ink; ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (hd.mode === 'rotate') { ctx.arc(hd.x, hd.y, 6, 0, 7); } else { ctx.rect(hd.x - 5, hd.y - 5, 10, 10); }
    ctx.fill(); ctx.stroke();
    if (hd.mode === 'rotate') {
      ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(px(f.x), py(f.y)); ctx.lineTo(hd.x, hd.y); ctx.stroke(); ctx.setLineDash([]);
    }
  }
}
function drawHover(f, i, u) {
  ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = ['line', 'string'].includes(f.shape) ? 10 * u : 1.5;
  ctx.globalAlpha = ['line', 'string'].includes(f.shape) ? 0.3 : 1;
  outline(f, i, u); ctx.stroke(); ctx.restore();
}

// ------------------------------------------------------------------ interaction
function toNorm(e) {
  const r = cv.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  return { x, y, nx: (x - rect.ox) / rect.w, ny: (y - rect.oy) / rect.h };
}
function segDist(x, y, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const t = clamp(((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy || 1), 0, 1);
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}
function hit(x, y) {
  const u = unit();
  const sel = fixture(S.sel);
  if (sel) for (const hd of handles(sel, u)) if (Math.hypot(x - hd.x, y - hd.y) < 10) return { f: sel, mode: hd.mode };
  const fxs = S.show.fixtures;
  for (let i = fxs.length - 1; i >= 0; i--) {
    const f = fxs[i];
    if (f.shape === 'screen') {
      const r = screenRect(f);
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return { f, mode: 'move' };
    } else if (['line', 'string'].includes(f.shape)) {
      const pts = lay.pos[i];
      if (pts.length === 1 && segDist(x, y, px(f.x), py(f.y), px(f.x2), py(f.y2)) < 10) return { f, mode: 'move' };
      for (let k = 1; k < pts.length; k++) {
        if (segDist(x, y, px(pts[k - 1][0]), py(pts[k - 1][1]), px(pts[k][0]), py(pts[k][1])) < 10) return { f, mode: 'move' };
      }
    } else if (Math.hypot(x - px(f.x), y - py(f.y)) < (f.shape === 'flood' ? 22 : 16) * u * (f.size || 1) + 4) {
      return { f, mode: 'move' };
    }
  }
  return null;
}

const pushMove = throttle((f) => send('fixture_update', { fixture: f, quiet: true }), 70);

function onDown(e) {
  if (!S.show || !canEdit()) return;
  cv.focus();
  const p = toNorm(e);
  const h = hit(p.x, p.y);
  if (!h) { if (S.sel) { S.sel = null; emit('select'); } return; }
  if (S.sel !== h.f.id) { S.sel = h.f.id; emit('select'); }
  cv.setPointerCapture(e.pointerId);
  drag = { mode: h.mode, id: h.f.id, start: p, orig: { ...h.f } };
}
function onMove(e) {
  const p = toNorm(e);
  if (!drag) {
    if (!canEdit()) { hover = null; cv.style.cursor = 'default'; return; }
    const h = S.show && hit(p.x, p.y);
    hover = h ? h.f : null;
    cv.style.cursor = h ? (h.mode === 'rotate' ? 'grab' : h.mode === 'move' ? 'move' : 'crosshair') : 'default';
    return;
  }
  const f = fixture(drag.id);
  if (!f) return;
  const o = drag.orig;
  const snap = (v) => (e.shiftKey ? Math.round(v * 40) / 40 : v);
  const dx = p.nx - drag.start.nx, dy = p.ny - drag.start.ny;
  const cl = (v) => clamp(v, 0, 1);
  if (drag.mode === 'move') {
    const nx = cl(snap(o.x + dx)), ny = cl(snap(o.y + dy));
    f.x2 = cl(o.x2 + (nx - o.x)); f.y2 = cl(o.y2 + (ny - o.y));
    f.x = nx; f.y = ny;
  } else if (drag.mode === 'size') {
    f.size = clamp((2 * Math.abs(p.nx - f.x)) / 0.22, 0.4, 4);
  } else if (drag.mode === 'p1') { f.x = cl(snap(p.nx)); f.y = cl(snap(p.ny)); }
  else if (drag.mode === 'p2') { f.x2 = cl(snap(p.nx)); f.y2 = cl(snap(p.ny)); }
  else if (drag.mode === 'sag') { f.sag = clamp(p.ny - (f.y + f.y2) / 2, -0.3, 0.4); }
  else if (drag.mode === 'rotate') {
    let a = (Math.atan2(p.y - py(f.y), p.x - px(f.x)) * 180) / Math.PI;
    if (e.shiftKey) a = Math.round(a / 15) * 15;
    f.angle = Math.round(a);
  }
  rebuildLayout();
  pushMove(f);
  emit('fixture-moved', f);
}
function onUp() {
  if (!drag) return;
  const f = fixture(drag.id);
  if (f) setTimeout(() => send('fixture_update', { fixture: f, quiet: true }), 80);
  drag = null;
}

// ------------------------------------------------------------------ init
export function initStage() {
  cv = $('#stage');
  ctx = cv.getContext('2d');
  glCanvas = $('#stage-gl');
  gl = new StageRenderer(glCanvas);
  new ResizeObserver(resize).observe(cv.parentElement);
  cv.addEventListener('pointerdown', onDown);
  cv.addEventListener('pointermove', onMove);
  cv.addEventListener('pointerup', onUp);
  cv.addEventListener('pointercancel', onUp);
  cv.addEventListener('pointerleave', () => (hover = null));
  const refresh = () => {
    rebuildLayout(); resize();
    const src = S.show?.settings.stage.background || '';
    if (src !== bgSrc) {
      bgSrc = src;
      bgImg = src ? Object.assign(new Image(), { src, onload: () => { bodiesDirty = true; } }) : null;
    }
    bodiesDirty = true;
  };
  on('init', refresh);
  on('fixtures', () => { if (!drag) rebuildLayout(); });
  on('layout-local', rebuildLayout);
  on('settings', refresh);
  on('resize', resize);
  requestAnimationFrame(draw);
}
