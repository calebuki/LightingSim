// Setup tab: tempo sync, MIDI, DMX, safety, show file, app.
import { S, send, request, scene } from './state.js';
import { $, field, h, on, select, toast } from './util.js';
import { confirmUpdate } from './update.js';

let root;
let lastLearned = null;

const CONTROLS = [
  ['master', 'Master'], ['flash', 'Flash'], ['strobe', 'Strobe'], ['blackout', 'Blackout'],
  ['tap', 'Tap'], ['next', 'Next scene'], ['prev', 'Previous scene'], ['align_bar', 'Beat 1'],
  ['align_phrase', 'Drop'], ['autopilot', 'Auto'], ['tv_energy', 'TV energy'], ['tv_hold', 'TV hold'],
  ['group:floods', 'Floods'], ['group:strips', 'Strips'], ['group:strings', 'Strings'], ['group:bulbs', 'Bulbs'], ['group:screens', 'TV level'],
];
const KEYS = [['Space', 'Beat 1'], ['Shift Space', 'Drop'], ['T', 'Tap'], ['1-9', 'Scene'], ['F', 'Flash'], ['S', 'Strobe'], ['B', 'Black'], ['H', 'TV hold'], ['[ ]', 'Half, double'], ['Left Right', 'Nudge']];

export function initSettings() {
  root = $('#tab-setup');
  on('init', render);
  on('settings', render);
  on('scenes', () => !root.hidden && render());
  on('tab', (t) => t === 'setup' && render());
  on('status', (m) => {
    if (m.learned && JSON.stringify(m.learned) !== JSON.stringify(lastLearned)) {
      lastLearned = m.learned;
      toast(`${m.learned.key}: ${labelFor(m.learned.target)}`);
    }
    if (root.hidden) return;
    const lb = root.querySelector('[data-learn]');
    if (lb && (lb.dataset.learn || null) !== (m.learn || null)) render();
    const src = $('#sync-status', root);
    if (src) src.textContent = m.clock.detail;
    root.querySelectorAll('[data-dmx]').forEach((el) => {
      const d = m.outputs.dmx[el.dataset.dmx];
      el.className = 'state ' + (!d || d.type === 'none' ? '' : d.ok ? 'ok' : 'warn');
      el.textContent = !d || d.type === 'none' ? 'Off' : d.ok ? 'Connected' : (d.error || 'Not connected');
    });
  });
}

function labelFor(t) {
  if (t?.startsWith('scene:')) return scene(t.slice(6))?.name || '?';
  return CONTROLS.find(([k]) => k === t)?.[1] || t;
}
const patch = (p) => send('settings', { patch: p });

function render() {
  if (!S.show || !root) return;
  const st = S.show.settings;
  root.replaceChildren(
    h('div.column', syncBlock(st), safetyBlock(st)),
    h('div.column', midiBlock(st)),
    h('div.column', dmxBlock(st), showBlock()),
    h('div.column', appBlock(st), keysBlock()));
}

const block = (title, ...kids) => h('section.block', h('h3', title), ...kids);

function syncBlock(st) {
  const c = S.status?.clock;
  return block('Tempo',
    h('div.seg', [['link', 'Link'], ['midi', 'MIDI'], ['internal', 'Manual']].map(([v, label]) =>
      h('button', { class: st.clock_source === v ? 'on' : '', onclick: () => patch({ clock_source: v }) }, label))),
    h('p.note#sync-status', c?.detail || ''));
}

function midiBlock(st) {
  const inputs = S.midiInputs || [];
  const map = st.midi_map || {};
  const actions = [...CONTROLS, ...S.show.bank.slice(0, 32).map((id) => [`scene:${id}`, scene(id)?.name])];
  const pick = root.querySelector('#midi-action')?.value || 'master';
  const learning = S.status?.learn;
  const mapped = Object.entries(map);
  return block('MIDI',
    S.midiError ? h('p.note', S.midiError) : null,
    inputs.length ? inputs.map((n) =>
      h('label.check', h('input', { type: 'checkbox', checked: (st.midi_inputs || []).includes(n),
        onchange: (e) => patch({ midi_inputs: e.target.checked ? [...(st.midi_inputs || []), n] : (st.midi_inputs || []).filter((x) => x !== n) }) }), n))
      : h('p.note', 'No devices'),
    h('div.bar-row',
      h('button', { onclick: async () => { S.midiInputs = await request('scan', { kind: 'midi' }); render(); } }, 'Refresh')),
    h('div.bar-row.fill',
      select(actions, pick, () => {}, { id: 'midi-action', 'aria-label': 'Action to map' }),
      h('button', { class: learning ? 'alert' : '', 'data-learn': learning || '',
        onclick: () => send('midi_learn', { target: learning ? null : root.querySelector('#midi-action').value }) }, learning ? 'Listening' : 'Learn')),
    mapped.length ? h('div.map-list', mapped.slice(0, 12).map(([k, t]) => h('div.map-row',
      h('code', k), h('span.grow', labelFor(t)), h('button.xs', { title: 'Remove', onclick: () => send('midi_unmap', { key: k }) }, 'Remove')))) : null,
    mapped.length > 12 ? h('p.note', `${mapped.length - 12} more`) : null);
}

function dmxBlock(st) {
  const ifaces = st.dmx_interfaces || [];
  const ports = S.serialPorts || [];
  const setIface = (i, k, v) => { const list = ifaces.map((d) => ({ ...d })); list[i][k] = v; patch({ dmx_interfaces: list }); };
  return block('DMX',
    ...ifaces.map((d, i) => h('div.iface',
      h('div.bar-row', h('b', d.id), h('span.state', { 'data-dmx': d.id }, ''), h('span.grow'),
        ifaces.length > 1 ? h('button.xs', { onclick: () => patch({ dmx_interfaces: ifaces.filter((_, j) => j !== i) }) }, 'Remove') : null),
      field('Type', select([['none', 'Off'], ['opendmx', 'USB Open DMX'], ['usbpro', 'Enttec USB Pro'], ['artnet', 'Art-Net']], d.type, (v) => setIface(i, 'type', v))),
      ['opendmx', 'usbpro'].includes(d.type) ? field('Port', select([['', 'Choose'], ...ports.map((p) => [p.device, p.device])], d.port || '', (v) => setIface(i, 'port', v))) : null,
      d.type === 'artnet' ? field('IP', h('input', { type: 'text', value: d.host || '', placeholder: 'Broadcast', onchange: (e) => setIface(i, 'host', e.target.value.trim()) })) : null,
      d.type === 'artnet' ? field('Universe', h('input', { type: 'number', min: 0, max: 32767, value: d.universe || 0, onchange: (e) => setIface(i, 'universe', parseInt(e.target.value) || 0) })) : null)),
    h('div.bar-row',
      h('button', { onclick: () => patch({ dmx_interfaces: [...ifaces, { id: `dmx${ifaces.length + 1}`, type: 'none', port: '', host: '', universe: 0 }] }) }, 'Add'),
      h('button', { onclick: async () => { S.serialPorts = await request('scan', { kind: 'serial' }); render(); } }, 'Rescan')));
}

function safetyBlock(st) {
  return block('Output',
    field('Flash limit', select([[0, 'Off'], [3, '3 / sec'], [5, '5 / sec'], [8, '8 / sec'], [12, '12 / sec']], st.max_flash_hz || 0,
      (v) => patch({ max_flash_hz: parseFloat(v) }), { id: 'max-flash', title: 'Fast strobes can trigger seizures. Limits the lights and the TV.' })),
    field('Engine rate', select([[30, '30 fps'], [44, '44 fps'], [60, '60 fps'], [90, '90 fps'], [120, '120 fps']], st.fps || 60,
      (v) => patch({ fps: parseInt(v) }), { id: 'fps' })),
    field('Theme', select([['dark', 'Dark'], ['light', 'Light']], st.theme === 'light' ? 'light' : 'dark', (v) => patch({ theme: v }), { id: 'ui-theme' })));
}

function showBlock() {
  return block('Show',
    h('input#show-name', { type: 'text', value: S.show.name || '', 'aria-label': 'Show name', onchange: (e) => { S.show.name = e.target.value; send('rename_show', { name: e.target.value }); } }),
    h('div.bar-row',
      h('a.btn', { href: '/api/export', download: '',
        onclick: async (e) => {
          if (!window.pywebview?.api?.export_show) return;
          e.preventDefault();
          const name = await window.pywebview.api.export_show();
          if (name) toast(`Saved ${name}`);
        } }, 'Export'),
      h('label.btn', 'Import', h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: importShow })),
      h('button', { title: 'Bring back deleted built-in scenes', onclick: () => send('restore_presets') }, 'Restore'),
      h('button', { title: 'Replace everything with the demo show', onclick: (e) => {
        const b = e.target;
        if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Sure?'; b.classList.add('alert'); return; }
        send('reset_demo');
      } }, 'Reset')));
}

function appBlock(st) {
  const u = S.status?.update || { current: S.version, status: 'idle' };
  const line = u.status === 'checking' ? 'Checking' : u.status === 'error' ? u.error
    : u.available ? `${u.latest} available` : `Version ${u.current || S.version}`;
  const remote = S.lan && S.lanUrls.length ? S.lanUrls[0] : st.lan_access ? 'Restart to apply' : '';
  return block('App',
    h('p.note#update-line', line),
    h('div.bar-row',
      u.available ? h('button.on', { onclick: () => confirmUpdate(u) }, 'Update')
        : h('button', { onclick: () => { send('update_check'); setTimeout(render, 2500); } }, 'Check'),
      h('button', { onclick: async () => { await fetch('/api/quit', { method: 'POST' }).catch(() => {}); if (!window.pywebview) toast('Stopped. You can close this tab.'); } }, 'Quit')),
    h('label.check', h('input', { type: 'checkbox', checked: st.auto_update_check !== false, onchange: (e) => patch({ auto_update_check: e.target.checked }) }), 'Check on open'),
    h('label.check', h('input', { type: 'checkbox', checked: !!st.lan_access, onchange: (e) => patch({ lan_access: e.target.checked }) }), 'Allow phones and TVs on Wi-Fi'),
    remote ? h('code', remote) : null);
}

function keysBlock() {
  return block('Keys', h('table.keys', h('tbody', KEYS.map(([k, v]) => h('tr', h('td', h('kbd', k)), h('td', v))))));
}

async function importShow(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const show = JSON.parse(await file.text());
    if (!Array.isArray(show.fixtures) || !Array.isArray(show.scenes)) throw new Error('not a show file');
    send('import_show', { show });
    toast(`Imported ${show.name || file.name}`);
  } catch (err) {
    toast(`Couldn’t import: ${err.message}`, true);
  }
}
