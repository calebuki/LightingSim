// Stage simulator: draws the rig, emulates each light's physical fade, lets you move lights.
import { S, send, fixture } from './state.js';
import { $, clamp, emit, on, throttle } from './util.js';

let cv, ctx, W = 0, H = 0, dpr = 1;
let rect = { ox: 0, oy: 0, w: 1, h: 1 };
let lay = { P: 0, offsets: [0], pos: [] };
let disp = new Float32Array(0);
let bgImg = null, bgSrc = '';
let drag = null, hover = null;
let lastT = performance.now();
const sprites = new Map();

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
  let w = W - 24, h = w / aspect;
  if (h > H - 24) { h = H - 24; w = h * aspect; }
  rect = { ox: (W - w) / 2, oy: (H - h) / 2, w: Math.max(w, 10), h: Math.max(h, 10) };
}

// ------------------------------------------------------------------ glow sprites
function sprite(r, g, b) {
  const m = Math.max(r, g, b, 1);
  const q = (v) => Math.round((v / m) * 15);
  const key = (q(r) << 8) | (q(g) << 4) | q(b);
  let s = sprites.get(key);
  if (!s) {
    s = document.createElement('canvas');
    s.width = s.height = 128;
    const c = s.getContext('2d');
    const cr = Math.round((q(r) / 15) * 255), cg = Math.round((q(g) / 15) * 255), cb = Math.round((q(b) / 15) * 255);
    const grd = c.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, `rgba(${cr},${cg},${cb},1)`);
    grd.addColorStop(0.18, `rgba(${cr},${cg},${cb},.55)`);
    grd.addColorStop(0.5, `rgba(${cr},${cg},${cb},.14)`);
    grd.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
    c.fillStyle = grd;
    c.fillRect(0, 0, 128, 128);
    if (sprites.size > 600) sprites.clear();
    sprites.set(key, s);
  }
  return s;
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

// ------------------------------------------------------------------ drawing
function draw() {
  const now = performance.now();
  const dt = Math.min(100, now - lastT);
  lastT = now;
  if (!S.show) return requestAnimationFrame(draw);
  stepPhysics(dt);
  const st = S.show.settings.stage;
  const fxs = S.show.fixtures;
  const u = unit();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#05060a';
  ctx.fillRect(0, 0, W, H);

  // stage area
  const { ox, oy, w, h } = rect;
  ctx.save();
  ctx.beginPath(); ctx.roundRect(ox, oy, w, h, 12); ctx.clip();
  if (bgImg && bgImg.complete && bgImg.naturalWidth) {
    ctx.drawImage(bgImg, ox, oy, w, h);
    ctx.fillStyle = `rgba(4,5,9,${st.bg_dim ?? 0.55})`;
    ctx.fillRect(ox, oy, w, h);
  } else {
    const g = ctx.createLinearGradient(0, oy, 0, oy + h);
    g.addColorStop(0, '#0b0d15'); g.addColorStop(0.72, '#0d0f19'); g.addColorStop(1, '#141724');
    ctx.fillStyle = g; ctx.fillRect(ox, oy, w, h);
    // floor grid in perspective-ish lines
    ctx.strokeStyle = 'rgba(140,150,200,.06)'; ctx.lineWidth = 1;
    for (let i = 0; i <= 20; i++) { ctx.beginPath(); ctx.moveTo(ox + (i / 20) * w, oy); ctx.lineTo(ox + (i / 20) * w, oy + h); ctx.stroke(); }
    for (let i = 0; i <= 11; i++) { ctx.beginPath(); ctx.moveTo(ox, oy + (i / 11) * h); ctx.lineTo(ox + w, oy + (i / 11) * h); ctx.stroke(); }
  }

  // haze: the room picks up the average colour of the lights
  let sr = 0, sg = 0, sb = 0;
  for (let j = 0; j < lay.P * 3; j += 3) { sr += disp[j]; sg += disp[j + 1]; sb += disp[j + 2]; }
  const n = Math.max(1, lay.P);
  const haze = (st.haze ?? 0.5) * 0.35;
  if (haze > 0 && lay.P) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = `rgba(${sr / n | 0},${sg / n | 0},${sb / n | 0},${haze})`;
    ctx.fillRect(ox, oy, w, h);
  }

  // bodies (unlit hardware)
  ctx.globalCompositeOperation = 'source-over';
  fxs.forEach((f, i) => drawBody(f, i, u));

  // beams + glows
  ctx.globalCompositeOperation = 'lighter';
  fxs.forEach((f, i) => {
    const a = lay.offsets[i];
    if (f.shape === 'flood') drawBeam(f, disp[a * 3], disp[a * 3 + 1], disp[a * 3 + 2], u);
    const r = glowRadius(f) * u;
    const pts = lay.pos[i];
    for (let k = 0; k < f.pixels; k++) {
      const j = (a + k) * 3;
      const R = disp[j], G = disp[j + 1], B = disp[j + 2];
      const m = Math.max(R, G, B);
      if (m < 3) continue;
      ctx.globalAlpha = Math.min(1, m / 255);
      const s = sprite(R, G, B);
      const x = px(pts[k][0]), y = py(pts[k][1]);
      ctx.drawImage(s, x - r, y - r, r * 2, r * 2);
    }
  });
  ctx.globalAlpha = 1;

  // hot cores
  ctx.globalCompositeOperation = 'source-over';
  fxs.forEach((f, i) => {
    const a = lay.offsets[i];
    const pts = lay.pos[i];
    const cr = coreRadius(f) * u;
    for (let k = 0; k < f.pixels; k++) {
      const j = (a + k) * 3;
      const R = disp[j], G = disp[j + 1], B = disp[j + 2];
      const m = Math.max(R, G, B) / 255;
      if (m < 0.02) continue;
      const wmix = m * 0.55; // bright LEDs blow out toward white
      ctx.fillStyle = `rgba(${R + (255 - R) * wmix | 0},${G + (255 - G) * wmix | 0},${B + (255 - B) * wmix | 0},${Math.min(1, m * 1.4)})`;
      ctx.beginPath(); ctx.arc(px(pts[k][0]), py(pts[k][1]), cr, 0, Math.PI * 2); ctx.fill();
    }
  });
  ctx.restore();

  // overlays
  fxs.forEach((f, i) => {
    if (st.show_labels) drawLabel(f, i, u);
    if (f.id === S.sel) drawSelection(f, i, u);
    else if (hover && hover.id === f.id) drawHover(f, i, u);
  });
  requestAnimationFrame(draw);
}

function glowRadius(f) {
  return { flood: 70, bulb: 58, string: 30, line: 18 }[f.shape] * (f.size || 1);
}
function coreRadius(f) {
  return { flood: 9, bulb: 8, string: 4.2, line: 2.6 }[f.shape] * (f.size || 1);
}

function drawBody(f, i, u) {
  const pts = lay.pos[i];
  ctx.lineCap = 'round';
  if (f.shape === 'line') {
    ctx.strokeStyle = '#1d2130'; ctx.lineWidth = 7 * u * (f.size || 1);
    ctx.beginPath(); ctx.moveTo(px(f.x), py(f.y)); ctx.lineTo(px(f.x2), py(f.y2)); ctx.stroke();
    ctx.fillStyle = '#2a2f44';
    for (const p of pts) { ctx.beginPath(); ctx.arc(px(p[0]), py(p[1]), 1.6 * u, 0, 7); ctx.fill(); }
  } else if (f.shape === 'string') {
    ctx.strokeStyle = '#2a2d3a'; ctx.lineWidth = 1.5 * u;
    ctx.beginPath();
    for (let s = 0; s <= 30; s++) {
      const t = s / 30;
      const x = f.x + (f.x2 - f.x) * t, y = f.y + (f.y2 - f.y) * t + (f.sag || 0) * 4 * t * (1 - t);
      s ? ctx.lineTo(px(x), py(y)) : ctx.moveTo(px(x), py(y));
    }
    ctx.stroke();
    ctx.fillStyle = '#343849';
    for (const p of pts) {
      ctx.beginPath(); ctx.arc(px(p[0]), py(p[1]) + 3 * u, 4 * u * (f.size || 1), 0, 7); ctx.fill();
      ctx.fillRect(px(p[0]) - 1.5 * u, py(p[1]) - 2 * u, 3 * u, 3 * u);
    }
  } else if (f.shape === 'bulb') {
    const x = px(f.x), y = py(f.y), s = (f.size || 1) * u;
    ctx.strokeStyle = '#2a2d3a'; ctx.lineWidth = 1.5 * u;
    ctx.beginPath(); ctx.moveTo(x, rect.oy); ctx.lineTo(x, y - 12 * s); ctx.stroke(); // hanging cord
    ctx.fillStyle = '#2b2f3f'; ctx.fillRect(x - 4 * s, y - 14 * s, 8 * s, 6 * s);
    ctx.fillStyle = 'rgba(160,170,200,.12)'; ctx.strokeStyle = 'rgba(180,190,220,.25)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(x, y, 9 * s, 0, 7); ctx.fill(); ctx.stroke();
  } else if (f.shape === 'flood') {
    const x = px(f.x), y = py(f.y), s = (f.size || 1) * u;
    ctx.save(); ctx.translate(x, y); ctx.rotate((f.angle * Math.PI) / 180);
    ctx.fillStyle = '#23273a'; ctx.strokeStyle = '#3a3f58'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(-12 * s, -13 * s, 18 * s, 26 * s, 3 * s); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#10121b'; ctx.fillRect(4 * s, -11 * s, 4 * s, 22 * s);
    ctx.restore();
  }
}

function drawBeam(f, R, G, B, u) {
  const m = Math.max(R, G, B) / 255;
  if (m < 0.01) return;
  const x = px(f.x), y = py(f.y);
  const a = (f.angle * Math.PI) / 180;
  const len = 330 * u * (f.size || 1);
  const spread = 0.42;
  const ex = x + Math.cos(a) * len, ey = y + Math.sin(a) * len;
  const g = ctx.createLinearGradient(x, y, ex, ey);
  g.addColorStop(0, `rgba(${R | 0},${G | 0},${B | 0},${0.5 * m})`);
  g.addColorStop(0.6, `rgba(${R | 0},${G | 0},${B | 0},${0.14 * m})`);
  g.addColorStop(1, `rgba(${R | 0},${G | 0},${B | 0},0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(x + Math.cos(a + Math.PI / 2) * 8 * u, y + Math.sin(a + Math.PI / 2) * 8 * u);
  ctx.lineTo(x + Math.cos(a + spread) * len, y + Math.sin(a + spread) * len);
  ctx.lineTo(x + Math.cos(a - spread) * len, y + Math.sin(a - spread) * len);
  ctx.lineTo(x + Math.cos(a - Math.PI / 2) * 8 * u, y + Math.sin(a - Math.PI / 2) * 8 * u);
  ctx.closePath(); ctx.fill();
  // pool of light where the beam lands
  ctx.globalAlpha = 0.35 * m;
  const s = sprite(R, G, B);
  const pr = len * 0.45;
  ctx.drawImage(s, ex - pr, ey - pr * 0.7, pr * 2, pr * 1.4);
  ctx.globalAlpha = 1;
}

function drawLabel(f, i, u) {
  const x = px(f.x), y = py(f.y);
  ctx.font = `500 ${Math.max(10, 11 * Math.min(1.2, u))}px "IBM Plex Sans", system-ui, sans-serif`;
  ctx.fillStyle = 'rgba(220,225,245,.55)';
  ctx.textAlign = 'center';
  const ly = f.shape === 'flood' ? y + 24 * u : f.shape === 'bulb' ? y + 24 * u : y - 10 * u;
  const lx = ['line', 'string'].includes(f.shape) ? (x + px(f.x2)) / 2 : x;
  ctx.fillText(f.name, lx, ly);
}

function handles(f, u) {
  const hs = [];
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
  if (['line', 'string'].includes(f.shape)) {
    lay.pos[i].forEach((p, k) => (k ? ctx.lineTo(px(p[0]), py(p[1])) : ctx.moveTo(px(p[0]), py(p[1]))));
    if (f.pixels === 1) ctx.lineTo(px(f.x2), py(f.y2));
  } else {
    ctx.arc(px(f.x), py(f.y), (f.shape === 'flood' ? 20 : 15) * u * (f.size || 1), 0, 7);
  }
}
function drawSelection(f, i, u) {
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent-2').trim() || '#00e5ff';
  ctx.save();
  ctx.strokeStyle = accent; ctx.lineWidth = ['line', 'string'].includes(f.shape) ? 14 * u : 2;
  ctx.globalAlpha = ['line', 'string'].includes(f.shape) ? 0.25 : 0.9;
  ctx.setLineDash(['line', 'string'].includes(f.shape) ? [] : [4, 3]);
  outline(f, i, u); ctx.stroke();
  ctx.restore();
  for (const hd of handles(f, u)) {
    ctx.fillStyle = '#0b0d14'; ctx.strokeStyle = accent; ctx.lineWidth = 2;
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
    if (['line', 'string'].includes(f.shape)) {
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
  if (!S.show) return;
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
  new ResizeObserver(resize).observe(cv.parentElement);
  cv.addEventListener('pointerdown', onDown);
  cv.addEventListener('pointermove', onMove);
  cv.addEventListener('pointerup', onUp);
  cv.addEventListener('pointercancel', onUp);
  cv.addEventListener('pointerleave', () => (hover = null));
  cv.addEventListener('dblclick', () => $('#inspector').classList.add('open'));
  $('#toggle-labels').onclick = () => {
    const st = S.show.settings.stage;
    send('settings', { patch: { stage: { ...st, show_labels: !st.show_labels } } });
  };
  $('#add-light').onclick = () => emit('add-light');
  const refresh = () => {
    rebuildLayout(); resize();
    const src = S.show?.settings.stage.background || '';
    if (src !== bgSrc) { bgSrc = src; bgImg = src ? Object.assign(new Image(), { src }) : null; }
  };
  on('init', refresh);
  on('fixtures', () => { if (!drag) rebuildLayout(); });
  on('layout-local', rebuildLayout);
  on('settings', refresh);
  on('resize', resize);
  on('status', (m) => {
    const e = m.engine;
    const name = (id) => S.show.scenes.find((s) => s.id === id)?.name || '';
    $('#hud-scene').textContent = e.preview ? `Audition · ${name(e.preview)}` : name(e.current) || 'No scene';
    $('#hud-next').textContent = e.queued ? `Next: ${name(e.queued.scene)} in ${Math.max(0, e.queued.at - e.beat).toFixed(1)} beats`
      : e.transition ? `${Math.round(e.transition.progress * 100)}% → ${name(e.transition.to)}` : '';
  });
  requestAnimationFrame(draw);
}
