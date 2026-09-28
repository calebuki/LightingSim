// Sync & Settings tab.
import { S, send, request, scene } from './state.js';
import { $, field, h, on, select, toast } from './util.js';

let root;
let lastLearned = null;

const CONTROLS = [
  ['master', 'Master fader'], ['flash', 'Flash (hold)'], ['strobe', 'Strobe (hold)'], ['blackout', 'Blackout toggle'],
  ['tap', 'Tap tempo'], ['next', 'Next scene'], ['prev', 'Previous scene'], ['align_bar', 'Align bar (the 1)'],
  ['align_phrase', 'Align phrase'], ['autopilot', 'Autopilot on/off'],
  ['group:floods', 'Floods fader'], ['group:strips', 'Strips fader'], ['group:strings', 'Strings fader'], ['group:bulbs', 'Bulbs fader'],
];

export function initSettings() {
  root = $('#tab-settings');
  on('init', render);
  on('settings', render);
  on('scenes', () => !root.hidden && render());
  on('status', (m) => {
    if (m.learned && JSON.stringify(m.learned) !== JSON.stringify(lastLearned)) {
      lastLearned = m.learned;
      toast(`Mapped ${m.learned.key} → ${labelFor(m.learned.target)}`);
    }
    const lb = root.querySelector('[data-learn]');
    if (lb && (lb.dataset.learn || null) !== (m.learn || null)) render();
    const src = $('#sync-status', root);
    if (src) src.textContent = m.clock.detail;
    root.querySelectorAll('[data-dmx]').forEach((el) => {
      const d = m.outputs.dmx[el.dataset.dmx];
      el.className = 'tag ' + (!d || d.type === 'none' ? 'off' : d.ok ? 'ok' : 'warn');
      el.textContent = !d || d.type === 'none' ? 'off' : d.ok ? 'connected' : (d.error || 'not connected');
    });
  });
}

function labelFor(t) {
  if (t?.startsWith('scene:')) return `Launch “${scene(t.slice(6))?.name || '?'}”`;
  return CONTROLS.find(([k]) => k === t)?.[1] || t;
}
const patch = (p) => send('settings', { patch: p });

function render() {
  if (!S.show || !root) return;
  const st = S.show.settings;
  root.replaceChildren(h('div.settings',
    h('div.scol', syncCard(st)),
    h('div.scol', midiCard(st), showCard()),
    h('div.scol', dmxCard(st)),
    h('div.scol', safetyCard(st), appCard(st))));
}

/** Version/updates, phone remote and quit in one small card. */
function appCard(st) {
  const u = S.status?.update || { current: S.version, status: 'idle' };
  const line = u.status === 'checking' ? 'Checking for updates…'
    : u.status === 'error' ? u.error
    : u.available ? `Version ${u.latest} is available.`
    : u.latest ? `Up to date (${u.current}).` : `Version ${u.current || S.version}.`;
  const remote = S.lan && S.lanUrls.length ? `Phones: ${S.lanUrls[0]}` : st.lan_access ? 'Restart to turn on phone access.' : '';
  return h('div.card',
    h('h4', 'App'),
    h('p#update-line', line),
    h('div.row', { style: { gap: '4px' } },
      u.available ? h('button.btn.sm.primary', { onclick: () => import('./update.js').then((m) => m.confirmUpdate(u)) }, `Update to ${u.latest}`)
        : h('button.btn.sm', { onclick: () => { send('update_check'); setTimeout(render, 2500); } }, 'Check for updates'),
      h('button.btn.sm', { onclick: async () => { await fetch('/api/quit', { method: 'POST' }).catch(() => {}); if (!window.pywebview) toast('LightingSim stopped. You can close this tab.'); } }, 'Quit')),
    h('label.check', h('input', { type: 'checkbox', checked: st.auto_update_check !== false,
      onchange: (e) => patch({ auto_update_check: e.target.checked }) }), 'Check for updates on open'),
    h('label.check', h('input', { type: 'checkbox', checked: !!st.lan_access, onchange: (e) => patch({ lan_access: e.target.checked }) }),
      'Phone remote on this Wi-Fi'),
    remote ? h('p.mono', { style: { color: 'var(--text)' } }, remote) : null);
}

function syncCard(st) {
  const opt = (v, title, sub) => h('label.src', { title: sub },
    h('input', { type: 'radio', name: 'clock', value: v, checked: st.clock_source === v, onchange: () => patch({ clock_source: v }) }),
    h('strong', title));
  return h('div.card',
    h('h4', 'Sync to rekordbox'),
    h('p.mono#sync-status', { style: { fontSize: '11px', marginTop: '-4px' } }, ''),
    h('div.src-options',
      opt('link', 'Ableton Link (recommended)', 'Tempo + bar position from rekordbox over your network.'),
      opt('midi', 'MIDI clock', 'From apps or gear that send MIDI clock.'),
      opt('internal', 'Manual / tap tempo', 'Type the BPM or tap along. Works with vinyl.')),
    st.clock_source === 'link' ? h('ol',
      h('li', 'rekordbox → ', h('b', 'PERFORMANCE'), ' mode, click ', h('b', 'LINK'), ' at the top (rekordbox 6+).'),
      h('li', 'Make the playing deck tempo ', h('b', 'MASTER'), '.'),
      h('li', 'Lights off by a beat? Press ', h('b', '1'), ' (or Space) on a downbeat. ', h('b', 'PHR'), ' on the first beat of a drop.')) : null,
    st.clock_source === 'midi' ? h('p', 'Tick the input that sends clock under MIDI. rekordbox doesn’t send MIDI clock; use Link for it.') : null);
}

function midiCard(st) {
  const inputs = S.midiInputs || [];
  const map = st.midi_map || {};
  const actions = [...CONTROLS, ...S.show.bank.slice(0, 32).map((id) => [`scene:${id}`, `Launch “${scene(id)?.name}”`])];
  const pick = root.querySelector('#midi-action')?.value || 'master';
  const learning = S.status?.learn;
  const mapped = Object.entries(map);
  return h('div.card',
    h('h4', 'MIDI controllers', h('button.btn.xs', { onclick: async () => { S.midiInputs = await request('scan', { kind: 'midi' }); render(); } }, 'Refresh')),
    S.midiError ? h('p', S.midiError) : null,
    inputs.length ? h('div', { style: { display: 'grid', gap: '3px' } }, inputs.map((n) =>
      h('label.check', h('input', { type: 'checkbox', checked: (st.midi_inputs || []).includes(n),
        onchange: (e) => patch({ midi_inputs: e.target.checked ? [...(st.midi_inputs || []), n] : (st.midi_inputs || []).filter((x) => x !== n) }) }), n)))
      : h('p', 'No MIDI devices found. Plug in a controller and press Refresh.'),
    h('p', 'Pick an action, press Learn, then hit a pad or move a knob.'),
    h('div.row', { style: { flexWrap: 'nowrap' } },
      select(actions, pick, () => {}, { id: 'midi-action', 'aria-label': 'Action to map', style: 'flex:1;min-width:0' }),
      h('button.btn.sm', { class: learning ? 'learning' : '', 'data-learn': learning || '',
        onclick: () => send('midi_learn', { target: learning ? null : root.querySelector('#midi-action').value }) }, learning ? 'Listening…' : 'Learn')),
    mapped.length
      ? h('div.map-list', mapped.slice(0, 8).map(([k, t]) => h('div.map-row',
        h('code', k), h('span.grow', labelFor(t)), h('button.btn.xs', { title: 'Remove mapping', onclick: () => send('midi_unmap', { key: k }) }, '✕'))),
        mapped.length > 8 ? h('span.muted', { style: { fontSize: '11px' } }, `+${mapped.length - 8} more`) : null)
      : h('p', 'Nothing mapped yet.'));
}

function dmxCard(st) {
  const ifaces = st.dmx_interfaces || [];
  const ports = S.serialPorts || [];
  const setIface = (i, k, v) => { const list = ifaces.map((d) => ({ ...d })); list[i][k] = v; patch({ dmx_interfaces: list }); };
  return h('div.card',
    h('h4', 'DMX interfaces', h('button.btn.xs', { onclick: async () => { S.serialPorts = await request('scan', { kind: 'serial' }); render(); } }, 'Rescan USB')),
    ...ifaces.map((d, i) => h('div', { style: { display: 'grid', gap: '8px', paddingBottom: '8px', borderBottom: '1px solid var(--line)' } },
      h('div.row', h('strong.mono', d.id), h('span.tag', { 'data-dmx': d.id }, '…'), h('span.grow'),
        ifaces.length > 1 ? h('button.btn.xs', { onclick: () => patch({ dmx_interfaces: ifaces.filter((_, j) => j !== i) }) }, 'Remove') : null),
      h('div.row',
        field('Type', select([['none', 'Not used'], ['opendmx', 'USB Open DMX (FTDI, ~$15)'], ['usbpro', 'Enttec USB Pro / clone'], ['artnet', 'Art-Net (Wi-Fi node)']], d.type,
          (v) => setIface(i, 'type', v)), 'grow'),
        ['opendmx', 'usbpro'].includes(d.type) ? field('USB port', select([['', 'Choose…'], ...ports.map((p) => [p.device, `${p.device} ${p.description !== p.device ? '· ' + p.description : ''}`])], d.port || '',
          (v) => setIface(i, 'port', v)), 'grow') : null,
        d.type === 'artnet' ? field('Node IP', h('input', { type: 'text', value: d.host || '', placeholder: 'blank = broadcast', onchange: (e) => setIface(i, 'host', e.target.value.trim()) }), 'grow') : null,
        d.type === 'artnet' ? field('Universe', h('input', { type: 'number', min: 0, max: 32767, value: d.universe || 0, style: { width: '80px' }, onchange: (e) => setIface(i, 'universe', parseInt(e.target.value) || 0) })) : null))),
    h('button.btn.xs', { style: { justifySelf: 'start' }, onclick: () => patch({ dmx_interfaces: [...ifaces, { id: `dmx${ifaces.length + 1}`, type: 'none', port: '', host: '', universe: 0 }] }) }, '+ Add interface'),
    h('p', 'Open DMX cables may need the FTDI driver on Windows. DMX only goes out while LIVE is on.'));
}

function safetyCard(st) {
  return h('div.card',
    h('h4', 'Safety & look'),
    h('div.two',
      field('Flash limit', select([[0, 'Off'], [3, '3 / sec'], [5, '5 / sec'], [8, '8 / sec'], [12, '12 / sec']], st.max_flash_hz || 0,
        (v) => patch({ max_flash_hz: parseFloat(v) }), { id: 'max-flash', title: 'Strobes of 3–30 flashes/sec can trigger seizures in people with photosensitive epilepsy. Set a limit when guests are around.' })),
      field('Engine rate', select([[30, '30 fps'], [44, '44 fps'], [60, '60 fps'], [90, '90 fps'], [120, '120 fps']], st.fps || 60,
        (v) => patch({ fps: parseInt(v) }), { id: 'fps', title: 'Higher lets fast lights follow 1/32 steps at club tempos (more CPU)' }))),
    h('p', 'Fast strobes can trigger seizures. Set a flash limit when guests are around.'),
    field('Interface look', select([['console', 'Console (dark)'], ['graphite', 'Graphite (warm dark)'], ['daylight', 'Daylight (outdoors)']],
      st.theme === 'neon' ? 'console' : st.theme || 'console', (v) => patch({ theme: v }), { id: 'ui-theme' })));
}

function showCard() {
  return h('div.card',
    h('h4', 'Show file', h('small', 'autosaves')),
    h('div.two',
      h('a.btn.sm', { href: '/api/export', download: '', title: 'Save your rig and scenes to move them to another computer',
        onclick: async (e) => {
          if (!window.pywebview?.api?.export_show) return; // browser: normal download
          e.preventDefault();
          const name = await window.pywebview.api.export_show();
          if (name) toast(`Saved ${name}`);
        } }, 'Export show'),
      h('label.btn.sm', { style: { cursor: 'pointer' } }, 'Import show…', h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: importShow })),
      h('button.btn.sm', { onclick: () => send('restore_presets'), title: 'Bring back any built-in presets you deleted' }, 'Restore presets'),
      h('button.btn.sm', { onclick: (e) => {
        const b = e.target;
        if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Replaces all. Sure?'; b.classList.add('danger'); return; }
        send('reset_demo');
      } }, 'Reset to demo')));
}
async function importShow(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const show = JSON.parse(await file.text());
    if (!Array.isArray(show.fixtures) || !Array.isArray(show.scenes)) throw new Error('not a LightingSim show file');
    send('import_show', { show });
    toast(`Imported “${show.name || file.name}”`);
  } catch (err) {
    toast(`Couldn’t import: ${err.message}`, true);
  }
}
