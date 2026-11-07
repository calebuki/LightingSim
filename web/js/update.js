// "Update" button + confirm dialog. The app downloads, installs and restarts itself.
import { S, send } from './state.js';
import { $, h, on, toast } from './util.js';

let lastStatus = '';

export function initUpdate() {
  const btn = $('#update-btn');
  btn.addEventListener('click', () => {
    const u = S.status?.update;
    if (!u || ['downloading', 'installing'].includes(u.status)) return;
    confirmUpdate(u);
  });
  on('status', (m) => {
    const u = m.update;
    if (!u) return;
    const busy = ['downloading', 'installing'].includes(u.status);
    btn.hidden = !(u.available || busy);
    if (busy) btn.textContent = u.status === 'installing' ? 'Installing' : `${Math.round(u.progress * 100)}%`;
    else if (u.available) btn.textContent = `Update ${u.latest}`;
    if (u.status !== lastStatus) {
      if (u.status === 'error' && u.error && lastStatus) toast(u.error, true);
      lastStatus = u.status;
    }
  });
}

export function confirmUpdate(u) {
  const close = () => bg.remove();
  const bg = h('div.modal-bg', { onclick: (e) => e.target === bg && close() },
    h('div.modal.small', { role: 'dialog', 'aria-label': 'Update' },
      h('h3', `Update to ${u.latest}`),
      u.can_install
        ? h('p', 'Your rig and scenes are kept. Live lights go dark while it restarts.')
        : h('p', 'Running from source: run git pull, then restart.'),
      h('div.actions',
        h('a.btn', { href: u.notes_url, target: '_blank', rel: 'noopener' }, 'Notes'),
        h('button', { onclick: close }, 'Later'),
        u.can_install ? h('button.on', { onclick: () => { send('update_install'); close(); } }, 'Update') : null)));
  document.body.append(bg);
}
