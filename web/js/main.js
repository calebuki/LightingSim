// Boot, connection, shared state, top bar, tabs and keyboard.
import { $, $$, clamp, emit, on, showTab, toast } from './util.js';
import { initStage } from './stage.js';
import { initPerform } from './perform.js';
import { initPatterns } from './patterns.js';
import { initRig, renderInspector } from './rig.js';
import { initSettings } from './settings.js';

import { S, send, beatNow, scene, fixture, palette, pending, setSocket } from './state.js';

// ------------------------------------------------------------------ connection
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  setSocket(ws);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { S.connected = true; $('#offline').hidden = true; };
  ws.onclose = () => { S.connected = false; $('#offline').hidden = false; setTimeout(connect, 1000); };
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') return onFrame(e.data);
    const m = JSON.parse(e.data);
    handlers[m.type]?.(m);
  };
}

function onFrame(buf) {
  const dv = new DataView(buf);
  S.beat = dv.getFloat64(4, true);
  S.bpm = dv.getFloat32(12, true);
  S.beatT = performance.now();
  S.frame = new Uint8Array(buf, 16);
}

const handlers = {
  init(m) {
    Object.assign(S, {
      show: m.show, profiles: m.profiles, palettes: m.palettes, divs: m.divs, transitions: m.transitions,
      quantize: m.quantize, lanUrls: m.lan_urls, serialPorts: m.serial_ports, midiInputs: m.midi_inputs,
      midiError: m.midi_error, version: m.version, lan: m.lan,
    });
    if (!scene(S.editScene)) S.editScene = S.show.bank[0] || null;
    if (S.sel && !fixture(S.sel)) S.sel = null;
    applyTheme();
    $('#show-name').value = S.show.name || 'My Rig';
    $('#live').checked = !!S.show.settings.output_enabled;
    emit('init');
  },
  status(m) {
    S.status = m;
    S.speed = m.clock.speed;
    emit('status', m);
  },
  fixtures(m) {
    S.show.fixtures = m.fixtures;
    if (m.select) S.sel = m.select;
    if (S.sel && !fixture(S.sel)) S.sel = null;
    emit('fixtures');
  },
  layout_version() {},
  scene(m) {
    const i = S.show.scenes.findIndex((s) => s.id === m.scene.id);
    if (i >= 0) S.show.scenes[i] = m.scene; else S.show.scenes.push(m.scene);
    S.show.bank = m.bank;
    if (m.select) S.editScene = m.scene.id;
    emit('scenes', m.scene.id);
  },
  scene_deleted(m) {
    S.show.scenes = S.show.scenes.filter((s) => s.id !== m.id);
    S.show.bank = m.bank;
    if (S.editScene === m.id) S.editScene = S.show.bank[0] || null;
    emit('scenes');
  },
  bank(m) { S.show.bank = m.bank; emit('scenes'); },
  palette(m) { S.show.palette = m.palette; applyTheme(); emit('palette'); },
  settings(m) {
    S.show.settings = m.settings;
    $('#live').checked = !!m.settings.output_enabled;
    applyTheme();
    emit('settings');
  },
  scan_result(m) { const r = pending.get(m.req); if (r) { pending.delete(m.req); r(m.results); } },
  error(m) { toast(m.message, true); },
};

// ------------------------------------------------------------------ theme
export function applyTheme() {
  const st = S.show.settings;
  document.documentElement.dataset.ui = st.theme === 'neon' ? 'console' : (st.theme || 'console');
  const [a, b] = palette();
  const root = document.documentElement.style;
  root.setProperty('--accent', a || '#ff2d95');
  root.setProperty('--accent-2', b || '#00e5ff');
  const [r, g, bl] = hexToRgbLocal(a || '#ff2d95');
  root.setProperty('--accent-ink', (r * 0.299 + g * 0.587 + bl * 0.114) > 150 ? '#0b0d14' : '#ffffff');
}
function hexToRgbLocal(hex) { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }

// ------------------------------------------------------------------ top bar
function initTopbar() {
  const bpm = $('#bpm');
  bpm.addEventListener('change', () => send('bpm', { value: clamp(parseFloat(bpm.value) || 120, 40, 240) }));
  bpm.addEventListener('keydown', (e) => { if (e.key === 'Enter') bpm.blur(); e.stopPropagation(); });
  $('#tap').addEventListener('pointerdown', tap);
  $('#nudge-back').onclick = () => send('nudge', { beats: -0.03 });
  $('#nudge-fwd').onclick = () => send('nudge', { beats: 0.03 });
  $('#align-bar').onclick = () => { send('align', { period: 4 }); toast('Bar realigned: this is the 1'); };
  $('#align-phrase').onclick = () => { send('align', { period: 32 }); toast('Phrase realigned: 8-bar loops start now'); };
  $$('#speed .btn').forEach((b) => (b.onclick = () => send('speed', { value: parseFloat(b.dataset.speed) })));
  $('#master').addEventListener('input', (e) => send('master', { value: parseFloat(e.target.value) }));
  $('#blackout').onclick = () => send('blackout', { on: !S.status?.engine.blackout });
  $('#live').addEventListener('change', (e) => {
    send('settings', { patch: { output_enabled: e.target.checked } });
    toast(e.target.checked ? 'Live: sending to real lights' : 'Simulate only: real lights released');
  });
  $('#sync-pill').onclick = () => showTab('settings');
  $('#show-name').addEventListener('change', (e) => send('rename_show', { name: e.target.value }));
  $('#show-name').addEventListener('keydown', (e) => e.stopPropagation());

  let lastBeatInt = -1;
  on('status', (m) => {
    const c = m.clock;
    const pill = $('#sync-pill');
    pill.className = 'sync-pill ' + (c.source === 'internal' ? '' : c.ok ? 'ok' : 'wait');
    $('#sync-label').textContent = c.source === 'link' ? (c.ok ? `LINK · ${c.peers} peer${c.peers > 1 ? 's' : ''}` : 'LINK · waiting')
      : c.source === 'midi' ? (c.ok ? 'MIDI clock' : 'MIDI · no clock') : 'Manual';
    pill.title = c.detail;
    if (document.activeElement !== bpm) bpm.value = c.bpm.toFixed(1);
    $$('#speed .btn').forEach((b) => b.classList.toggle('on', parseFloat(b.dataset.speed) === c.speed));
    $('#blackout').classList.toggle('on', m.engine.blackout);
    if (document.activeElement !== $('#master')) $('#master').value = m.engine.master;
    $('#perf').textContent = `${m.engine.fps} fps · ${m.engine.render_ms} ms`;
  });
  // beat lights run at display rate from the interpolated clock
  const dots = $$('#beats span');
  dots[0].classList.add('one');
  const mark = $('.brand-mark');
  (function loop() {
    const b = beatNow();
    const bi = Math.floor(b);
    const inBeat = b - bi;
    dots.forEach((d, i) => d.classList.toggle('on', ((bi % 4) + 4) % 4 === i && inBeat < 0.5));
    if (bi !== lastBeatInt) {
      lastBeatInt = bi;
      $('#phrase').firstChild.textContent = String((((Math.floor(b / 4) % 8) + 8) % 8) + 1);
      mark.classList.add('hit'); setTimeout(() => mark.classList.remove('hit'), 90);
    }
    requestAnimationFrame(loop);
  })();
}
function tap() {
  send('tap');
  const t = $('#tap'); t.classList.add('hit'); setTimeout(() => t.classList.remove('hit'), 90);
}

// ------------------------------------------------------------------ tabs & dock

function initDock() {
  $$('.tabs [data-tab]').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
  let saved = 'perform';
  try { saved = localStorage.getItem('ls.tab') || 'perform'; } catch {}
  showTab(saved);
  const grip = document.createElement('div');
  grip.className = 'dock-grip';
  $('#dock').append(grip);
  try { const h = localStorage.getItem('ls.dock'); if (h) document.documentElement.style.setProperty('--dock-h', h); } catch {}
  grip.addEventListener('pointerdown', (e) => {
    grip.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const h = clamp(window.innerHeight - ev.clientY, 140, window.innerHeight - 180);
      document.documentElement.style.setProperty('--dock-h', h + 'px');
      emit('resize');
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      try { localStorage.setItem('ls.dock', getComputedStyle(document.documentElement).getPropertyValue('--dock-h')); } catch {}
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up, { once: true });
  });
}

// ------------------------------------------------------------------ keyboard
const held = new Set();
function initKeys() {
  window.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.repeat) return;
    const k = e.key.toLowerCase();
    if (k === 't') tap();
    else if (k === 'b') send('blackout', { on: !S.status?.engine.blackout });
    else if (k === 'f') { held.add('f'); send('flash', { value: 1 }); }
    else if (k === 's') { held.add('s'); send('strobe', { on: true }); }
    else if (k === 'arrowleft') send('nudge', { beats: -0.03 });
    else if (k === 'arrowright') send('nudge', { beats: 0.03 });
    else if (k === '[') send('speed', { value: S.speed === 2 ? 1 : 0.5 });
    else if (k === ']') send('speed', { value: S.speed === 0.5 ? 1 : 2 });
    else if (/^[1-9]$/.test(k)) {
      const id = S.show.bank[+k - 1];
      if (id) send('launch', { scene: id, quantize: e.shiftKey ? 'now' : undefined });
    } else if ((k === 'delete' || k === 'backspace') && S.sel && document.activeElement === $('#stage')) {
      send('fixture_delete', { ids: [S.sel] });
    } else return;
    e.preventDefault();
  });
  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'f' && held.delete('f')) send('flash', { value: 0 });
    if (k === 's' && held.delete('s')) send('strobe', { on: false });
  });
  window.addEventListener('blur', () => {
    if (held.delete('f')) send('flash', { value: 0 });
    if (held.delete('s')) send('strobe', { on: false });
  });
}

// ------------------------------------------------------------------ boot
initTopbar();
initDock();
initKeys();
initStage();
initPerform();
initPatterns();
initRig();
initSettings();
on('init', renderInspector);
connect();
