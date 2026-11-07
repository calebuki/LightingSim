// Boot: top bar, tabs and keyboard.
import { $, $$, clamp, emit, on, showTab, toast } from './util.js';
import { S, send, beatNow } from './state.js';
import { connect } from './net.js';
import { initStage } from './stage.js';
import { initPlay } from './play.js';
import { initPatterns } from './patterns.js';
import { initTVPanel, initTVOutput, toggleHold } from './tvpanel.js';
import { initRig } from './rig.js';
import { initSettings } from './settings.js';
import { initUpdate } from './update.js';

function applyTheme() {
  const t = S.show?.settings.theme;
  document.documentElement.dataset.ui = t === 'light' ? 'light' : 'dark';
}

function initBar() {
  const bpm = $('#bpm');
  bpm.addEventListener('change', () => send('bpm', { value: clamp(parseFloat(bpm.value) || 120, 40, 240) }));
  bpm.addEventListener('keydown', (e) => { if (e.key === 'Enter') bpm.blur(); e.stopPropagation(); });
  $('#tap').addEventListener('pointerdown', tap);
  $('#nudge-back').onclick = () => send('nudge', { beats: -0.03 });
  $('#nudge-fwd').onclick = () => send('nudge', { beats: 0.03 });
  // fire on press, not release: a click only lands when the mouse comes back up,
  // which is ~100 ms after you hit the beat
  $('#align-bar').addEventListener('pointerdown', (e) => { e.preventDefault(); align(4); });
  $('#align-phrase').addEventListener('pointerdown', (e) => { e.preventDefault(); align(32); });
  $$('#speed button').forEach((b) => (b.onclick = () => send('speed', { value: parseFloat(b.dataset.speed) })));
  $('#master').addEventListener('input', (e) => send('master', { value: parseFloat(e.target.value) }));
  $('#blackout').onclick = () => send('blackout', { on: !S.status?.engine.blackout });
  $('#live').onclick = () => send('settings', { patch: { output_enabled: !S.show.settings.output_enabled } });
  $('#sync').onclick = () => showTab('setup');

  on('settings', () => { $('#live').classList.toggle('alert', !!S.show.settings.output_enabled); applyTheme(); });
  on('init', () => { $('#live').classList.toggle('alert', !!S.show.settings.output_enabled); applyTheme(); });
  on('status', (m) => {
    const c = m.clock;
    const sync = $('#sync');
    sync.textContent = c.source === 'link' ? (c.ok ? `Link ${c.peers}` : 'Link waiting')
      : c.source === 'midi' ? (c.ok ? 'MIDI' : 'MIDI waiting') : 'Manual';
    sync.classList.toggle('waiting', c.source !== 'internal' && !c.ok);
    sync.title = c.detail;
    if (document.activeElement !== bpm) bpm.value = c.bpm.toFixed(1);
    $$('#speed button').forEach((b) => b.classList.toggle('on', parseFloat(b.dataset.speed) === c.speed));
    $('#blackout').classList.toggle('on', m.engine.blackout);
    if (document.activeElement !== $('#master')) $('#master').value = m.engine.master;
  });

  const dots = $$('#beats i');
  let last = -1;
  (function loop() {
    const b = beatNow();
    const bi = Math.floor(b);
    const lit = ((bi % 4) + 4) % 4;
    dots.forEach((d, i) => d.classList.toggle('on', lit === i && b - bi < 0.5));
    if (bi !== last) {
      last = bi;
      $('#pos').textContent = `${((Math.floor(b / 4) % 8) + 8) % 8 + 1}/8`;
    }
    requestAnimationFrame(loop);
  })();
}

function align(period) {
  send('align', { period });
  const b = $(period === 4 ? '#align-bar' : '#align-phrase');
  b.classList.add('on'); setTimeout(() => b.classList.remove('on'), 140);
}

function tap() {
  send('tap');
  const t = $('#tap'); t.classList.add('on'); setTimeout(() => t.classList.remove('on'), 80);
}

function initTabs() {
  $$('#nav [data-tab]').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
  let saved = 'play';
  try { saved = localStorage.getItem('ls.tab2') || 'play'; } catch {}
  showTab(saved);
  on('tab', () => requestAnimationFrame(() => emit('resize')));
}

const held = new Set();
function initKeys() {
  window.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.repeat) return;
    const k = e.key.toLowerCase();
    if (k === 't') tap();
    else if (k === ' ') align(e.shiftKey ? 32 : 4);
    else if (k === 'b') send('blackout', { on: !S.status?.engine.blackout });
    else if (k === 'f') { held.add('f'); send('flash', { value: 1 }); }
    else if (k === 's') { held.add('s'); send('strobe', { on: true }); }
    else if (k === 'h') toggleHold();
    else if (k === 'arrowleft') send('nudge', { beats: -0.03 });
    else if (k === 'arrowright') send('nudge', { beats: 0.03 });
    else if (k === '[') send('speed', { value: S.speed === 2 ? 1 : 0.5 });
    else if (k === ']') send('speed', { value: S.speed === 0.5 ? 1 : 2 });
    else if (/^[1-9]$/.test(k)) {
      const id = S.show.bank[+k - 1];
      if (id) send('launch', { scene: id, quantize: e.shiftKey ? 'now' : undefined });
    } else if ((k === 'delete' || k === 'backspace') && S.sel && S.tab === 'rig') {
      send('fixture_delete', { ids: [S.sel] });
    } else return;
    e.preventDefault();
  });
  const release = (k) => {
    if (k === 'f' && held.delete('f')) send('flash', { value: 0 });
    if (k === 's' && held.delete('s')) send('strobe', { on: false });
  };
  window.addEventListener('keyup', (e) => release(e.key.toLowerCase()));
  window.addEventListener('blur', () => { release('f'); release('s'); });
}

on('online', (ok) => { $('#offline').hidden = ok; });
on('server-error', (msg) => toast(msg, true));

initBar();
initTabs();
initKeys();
initTVOutput();
initStage();
initPlay();
initPatterns();
initTVPanel();
initRig();
initSettings();
initUpdate();
connect();
