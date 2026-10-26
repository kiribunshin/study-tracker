/* Cultivar — Stock Market page (§6).
   Rendered as an in-universe computer: a fake OS desktop with three apps
   (Internet / Stock Market / Info). Talks to /api/<profile>/market/*.
   Global helpers ($, $$, el, esc, api, currentProfile) come from app.js. */

/* Same el() varargs shim as industrial.js — see the comment there. */
(function () {
  const _base = window.el;
  if (typeof _base !== 'function') return;
  if (window.__elVarargsShimmed) return;
  window.__elVarargsShimmed = true;
  window.el = function (tag, attrs = {}, ...rest) {
    let kids;
    if (rest.length === 1 && Array.isArray(rest[0])) kids = rest[0];
    else if (rest.length > 0) kids = rest.flat(Infinity);
    else kids = [];
    return _base(tag, attrs, kids);
  };
})();

const SM = {
  booted: false,
  windows: {},          // appId → {elm, minimized, restore}
  focused: null,        // appId of the focused window
  zTop: 100,
  sel: null,            // selected commodity item name
  compare: [],          // pinned items for split-screen comparison
  sort: { key: 'change_pct', dir: -1 },
  search: '',
  cat: 'all',
  overview: null,
};

function _smApi(path, opts) { return api(`/api/${currentProfile}/market/${path}`, opts); }

async function renderStockMarket(c) {
  const device = el('div', { class: 'sm-device' });
  const screen = el('div', { class: 'sm-screen', id: 'smScreen' });
  device.appendChild(screen);
  c.innerHTML = '';
  c.appendChild(device);

  if (!SM.booted) {
    const ok = await _runBoot(screen);
    if (!ok) return;   // user navigated away mid-boot
    SM.booted = true;
  }
  if (typeof currentPage === 'undefined' || currentPage !== 'stock_market') return;
  _buildDesktop(screen);
  // Re-open previously open windows (preserving minimized state). On
  // the very first boot nothing is open yet — launch the Market app
  // automatically, since this page IS the Stock Market experience now,
  // not a device someone has to click an icon on first.
  const wasMin = {};
  for (const [id, rec] of Object.entries(SM.windows)) wasMin[id] = !!rec.minimized;
  const ids = Object.keys(SM.windows).length ? Object.keys(SM.windows) : ['market'];
  for (const id of ids) {
    _openApp(id);
    if (wasMin[id]) _toggleMinimize(id);
  }
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ── Boot sequence: retro POST lines + progress bar ── */
const BOOT_LINES = [
  'CULTIVAR BIOS v1.3 — Market Terminal Edition',
  'CPU: Study-Core @ 4.77 MHz ............. OK',
  'Memory test: 65536K .................... OK',
  'Detecting drives:',
  '  hdd0: warehouse.img .................. OK',
  '  hdd1: ledger.db ...................... OK',
  'Loading kernel modules: net chart trade',
  'Mounting /exchange ..................... OK',
  'Syncing world news feed ................ OK',
  'Starting CULTIVAR OS 1.0',
];

async function _runBoot(screen) {
  SM.windows = {};        // a power cycle ends all sessions
  SM.focused = null;
  const boot = el('div', { class: 'sm-boot sm-boot-post' });
  const log = el('div', { class: 'sm-boot-log' });
  boot.appendChild(log);
  screen.appendChild(boot);
  for (let i = 0; i < BOOT_LINES.length; i++) {
    if (!document.getElementById('smScreen')) return false;
    log.appendChild(el('div', { class: 'sm-boot-line', text: BOOT_LINES[i] }));
    await _sleep(i === 0 ? 300 : 90 + Math.floor(Math.random() * 130));
  }
  await _sleep(180);
  if (!boot.isConnected) return false;
  const bar = el('div', { class: 'sm-boot-bar' }, el('div', { class: 'sm-boot-bar-fill' }));
  boot.appendChild(bar);
  requestAnimationFrame(() => { if (bar.firstChild) bar.firstChild.style.width = '100%'; });
  await _sleep(620);
  if (!boot.isConnected) return false;
  boot.classList.add('sm-boot-done');
  await _sleep(260);
  if (!boot.isConnected) return false;
  boot.remove();
  return true;
}

const SM_APPS = {
  internet: { icon: '📰', label: 'Internet', title: 'World News Internet' },
  market: { icon: '📈', label: 'Stock Market', title: 'Commodities Exchange' },
  info: { icon: '❓', label: 'Info', title: 'Market Help & Info' },
};

function _buildDesktop(screen) {
  const desk = el('div', { class: 'sm-desktop', id: 'smDesktop' });
  // Desktop icons
  const icons = el('div', { class: 'sm-icons' });
  for (const [id, app] of Object.entries(SM_APPS)) {
    const ic = el('div', { class: 'sm-icon' },
      el('div', { class: 'sm-icon-glyph', text: app.icon }),
      el('div', { class: 'sm-icon-label', text: app.label }));
    ic.addEventListener('click', () => _openApp(id));   // single click opens
    ic.addEventListener('dblclick', () => _openApp(id));
    icons.appendChild(ic);
  }
  desk.appendChild(icons);
  // Taskbar: launcher ❖ · window buttons · nerds · clock
  const taskbar = el('div', { class: 'sm-taskbar' });
  taskbar.appendChild(el('button', {
    class: 'sm-launch-btn', text: '❖', title: 'Apps & power',
    onclick: (e) => { e.stopPropagation(); _toggleLauncher(); },
  }));
  taskbar.appendChild(el('span', { class: 'sm-tb-brand', text: 'CULTIVAR OS' }));
  taskbar.appendChild(el('div', { class: 'sm-tb-wins', id: 'smTbWins' }));
  taskbar.appendChild(el('span', { class: 'sm-tb-nerds', id: 'smTbNerds' }));
  taskbar.appendChild(el('span', { class: 'sm-tb-clock', id: 'smTbClock', text: 'syncing…' }));
  desk.appendChild(taskbar);
  screen.appendChild(desk);
  // Right-click anywhere on the desktop (not on windows/taskbar) → OS menu
  desk.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.sm-win') || e.target.closest('.sm-taskbar')) return;
    e.preventDefault();
    _showContextMenu(e);
  });
  _refreshClockAndNerds();
  window.SM_CLOCK_TIMER = window.SM_CLOCK_TIMER || setInterval(() => {
    if (document.getElementById('smTbClock')) _refreshClockAndNerds();
  }, 30000);
}

/* ── OS menus: launcher + desktop context menu ── */
function _closeOsWithMenus() { document.querySelectorAll('.sm-menu').forEach(m => m.remove()); }

function _menuButton(label, danger, onclick) {
  return el('button', { class: 'sm-menu-item' + (danger ? ' danger' : ''), text: label, onclick });
}

function _toggleLauncher() {
  const existing = document.getElementById('smLauncher');
  _closeOsWithMenus();
  if (existing) return;   // it was open; we just closed it
  const screen = document.getElementById('smScreen');
  if (!screen) return;
  const m = el('div', { class: 'sm-menu', id: 'smLauncher', style: 'left:8px;bottom:46px' });
  for (const [id, app] of Object.entries(SM_APPS)) {
    m.appendChild(_menuButton(`${app.icon}  ${app.label}`, false, () => { _closeOsWithMenus(); _openApp(id); }));
  }
  m.appendChild(el('div', { class: 'sm-menu-sep' }));
  m.appendChild(_menuButton('⏻  Shut Down', true, () => { _closeOsWithMenus(); _shutdown(); }));
  screen.appendChild(m);
}

function _showContextMenu(e) {
  _closeOsWithMenus();
  const screen = document.getElementById('smScreen');
  if (!screen) return;
  const r = screen.getBoundingClientRect();
  const m = el('div', {
    class: 'sm-menu',
    style: `left:${Math.min(e.clientX - r.left, r.width - 200)}px;top:${Math.min(e.clientY - r.top, r.height - 240)}px`,
  });
  for (const [id, app] of Object.entries(SM_APPS)) {
    m.appendChild(_menuButton(`${app.icon}  Open ${app.label}`, false, () => { _closeOsWithMenus(); _openApp(id); }));
  }
  m.appendChild(el('div', { class: 'sm-menu-sep' }));
  m.appendChild(_menuButton('⟳  Refresh prices', false, () => {
    _closeOsWithMenus();
    SM.overview = null;
    _newsCache = null;
    const body = document.getElementById('smBody_market');
    if (body && SM.windows.market) _renderAppBody('market', body);
    _refreshClockAndNerds();
    _smToast('Market data refreshed.');
  }));
  m.appendChild(el('div', { class: 'sm-menu-sep' }));
  m.appendChild(_menuButton('⏻  Shut Down', true, () => { _closeOsWithMenus(); _shutdown(); }));
  screen.appendChild(m);
}

// One global closer: any click outside a .sm-menu dismisses all menus.
document.addEventListener('click', (e) => {
  if (e.target.closest && e.target.closest('.sm-menu')) return;
  _closeOsWithMenus();
});

/* ── Power off / power on ── */
function _shutdown() {
  const screen = document.getElementById('smScreen');
  if (!screen) return;
  Object.values(SM.windows).forEach(w => w.elm.remove());
  SM.windows = {};
  SM.focused = null;
  SM.booted = false;
  const off = el('div', { class: 'sm-off' },
    el('div', { class: 'sm-off-msg', text: 'It is now safe to walk away.' }),
    el('div', { class: 'sm-off-sub', text: '— click anywhere to power on —' }));
  off.addEventListener('click', () => {
    const c = $('#content');
    if (c) renderStockMarket(c);
  });
  screen.appendChild(off);
}

async function _refreshClockAndNerds() {
  try {
    const ov = SM.overview || await _smApi('overview');
    SM.overview = ov;
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const clockEl = document.getElementById('smTbClock');
    if (clockEl) clockEl.textContent = `${hhmm} · 📅 ${ov.cycle_info.label}`;
    const nEl = document.getElementById('smTbNerds');
    if (nEl) nEl.textContent = `◉ ${fmt(ov.nerds ?? 0, 1)} Nerds`;
  } catch (e) { /* offline is fine */ }
}

/* ── Window manager: focus, minimize, maximize, resize, taskbar sync ── */
function _openApp(appId) {
  let rec = SM.windows[appId];
  if (rec && rec.elm.isConnected) {
    if (rec.minimized) _toggleMinimize(appId);
    else _focusApp(appId);
    return;
  }
  const app = SM_APPS[appId];
  rec = { elm: null, minimized: false, restore: null };
  const win = el('div', {
    class: 'sm-win focused',
    style: `z-index:${++SM.zTop};left:${60 + Object.keys(SM.windows).length * 36}px;top:${30 + Object.keys(SM.windows).length * 30}px;width:${appId === 'market' ? 1180 : 620}px;height:${appId === 'market' ? 720 : 560}px`,
  });
  win.addEventListener('mousedown', () => _focusApp(appId));
  const titlebar = el('div', { class: 'sm-win-titlebar' },
    el('span', { text: app.icon }),
    el('span', { class: 'sm-win-title', text: app.title }),
    el('div', { class: 'sm-win-ctl' },
      el('button', { class: 'sm-win-min', text: '–', title: 'Minimize',
        onclick: (e) => { e.stopPropagation(); _toggleMinimize(appId); } }),
      el('button', { class: 'sm-win-max', text: '□', title: 'Maximize / restore',
        onclick: (e) => { e.stopPropagation(); _toggleMaximize(appId); } }),
      el('button', { class: 'sm-win-close', text: '✕', title: 'Close',
        onclick: (e) => { e.stopPropagation(); _closeApp(appId); } })));
  win.appendChild(titlebar);
  const body = el('div', { class: 'sm-win-body', id: `smBody_${appId}` });
  win.appendChild(body);
  const grip = el('div', { class: 'sm-resize', title: 'Resize' });
  win.appendChild(grip);

  // Dragging by titlebar (disabled while maximized)
  titlebar.addEventListener('mousedown', (e) => {
    if (e.target.closest('.sm-win-ctl') || win.classList.contains('maximized')) return;
    e.preventDefault();
    const rect = win.getBoundingClientRect();
    const offX = e.clientX - rect.left, offY = e.clientY - rect.top;
    function mv(ev) {
      const screen = document.getElementById('smScreen').getBoundingClientRect();
      win.style.left = `${Math.max(0, Math.min(ev.clientX - offX - screen.left, screen.width - 120))}px`;
      win.style.top = `${Math.max(0, Math.min(ev.clientY - offY - screen.top, screen.height - 70))}px`;
    }
    function up() { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); }
    window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
  });
  // Double-click titlebar = maximize toggle
  titlebar.addEventListener('dblclick', (e) => {
    if (!e.target.closest('.sm-win-ctl')) _toggleMaximize(appId);
  });
  // Resize grip (bottom-right corner)
  grip.addEventListener('mousedown', (e) => {
    e.preventDefault(); e.stopPropagation();
    if (win.classList.contains('maximized')) _toggleMaximize(appId);
    const r = win.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY, sw = r.width, sh = r.height;
    function mv(ev) {
      win.style.width = `${Math.max(380, sw + ev.clientX - sx)}px`;
      win.style.height = `${Math.max(220, sh + ev.clientY - sy)}px`;
    }
    function up() { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); }
    window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
  });

  document.getElementById('smScreen').appendChild(win);
  rec.elm = win;
  SM.windows[appId] = rec;
  _focusApp(appId);
  _syncTaskbar();
  _renderAppBody(appId, body);
  // The Market app opens maximized by default — the Stock Market page
  // itself is now sized to be the primary experience, so its own
  // window should fill the screen from the start instead of sitting
  // small in a corner.
  if (appId === 'market') _toggleMaximize(appId);
}

function _focusApp(appId) {
  const rec = SM.windows[appId];
  if (!rec || !rec.elm.isConnected) return;
  document.querySelectorAll('.sm-win').forEach(w => w.classList.remove('focused'));
  rec.elm.classList.add('focused');
  rec.elm.style.zIndex = ++SM.zTop;
  SM.focused = appId;
  _syncTaskbar();
}

function _toggleMinimize(appId) {
  const rec = SM.windows[appId];
  if (!rec || !rec.elm.isConnected) return;
  rec.minimized = !rec.minimized;
  rec.elm.style.display = rec.minimized ? 'none' : '';
  if (!rec.minimized) _focusApp(appId);
  else if (SM.focused === appId) SM.focused = null;
  _syncTaskbar();
}

function _toggleMaximize(appId) {
  const rec = SM.windows[appId];
  if (!rec || !rec.elm.isConnected) return;
  const w = rec.elm;
  if (w.classList.contains('maximized')) {
    w.classList.remove('maximized');
    Object.assign(w.style, rec.restore || {});
    rec.restore = null;
  } else {
    rec.restore = { left: w.style.left, top: w.style.top, width: w.style.width, height: w.style.height };
    w.classList.add('maximized');
  }
  _focusApp(appId);
}

function _closeApp(appId) {
  const rec = SM.windows[appId];
  if (!rec) return;
  rec.elm.remove();
  delete SM.windows[appId];
  if (SM.focused === appId) SM.focused = null;
  _syncTaskbar();
}

function _syncTaskbar() {
  const host = document.getElementById('smTbWins');
  if (!host) return;
  host.innerHTML = '';
  for (const id of Object.keys(SM_APPS)) {
    const rec = SM.windows[id];
    if (!rec || !rec.elm.isConnected) continue;
    const app = SM_APPS[id];
    host.appendChild(el('button', {
      class: 'sm-tb-app' + (SM.focused === id && !rec.minimized ? ' active' : '') + (rec.minimized ? ' min' : ''),
      title: rec.minimized ? `Restore ${app.title}` : (SM.focused === id ? 'Minimize' : 'Focus'),
      onclick: () => {
        if (rec.minimized) _toggleMinimize(id);          // restore
        else if (SM.focused === id) _toggleMinimize(id); // focused → minimize
        else _focusApp(id);
      },
    },
      el('span', { text: app.icon }),
      el('span', { text: app.label })));
  }
}

async function _renderAppBody(appId, body) {
  body.innerHTML = '<div style="color:var(--textdim);padding:20px;text-align:center">Loading…</div>';
  try {
    if (appId === 'internet') await _renderNews(body);
    else if (appId === 'info') await _renderInfo(body);
    else await _renderMarketApp(body);
  } catch (e) {
    body.innerHTML = '';
    body.appendChild(el('div', { class: 'sm-toast error', text: e.message }));
  }
}

function _smToast(msg, isErr) {
  const screen = document.getElementById('smScreen');
  if (!screen) { alert(msg); return; }
  const t = el('div', { class: 'sm-toast' + (isErr ? ' error' : ''), text: msg });
  screen.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

/* ═══════════════════════════════════════════════════════════════════
   INTERNET APP — world news feed (§6)
   ═══════════════════════════════════════════════════════════════════ */
let _newsCache = null;
let _newsTag = 'all';

async function _renderNews(body) {
  const data = _newsCache || (_newsCache = await _smApi('news'));
  body.innerHTML = '';
  body.appendChild(el('h3', { text: '🌍 World News', style: 'margin:2px 0 4px;font-size:16px;color:var(--text)' }));
  body.appendChild(el('div', { class: 'insp-sub', style: 'color:var(--textdim);margin-bottom:10px',
    html: `${esc(data.refresh_note || '')} Simulated date: <b>${esc(data.cycle_info.label)}</b>.` }));

  // ── Exchange Spotlight: today's five boosted commodities ──
  if ((data.picks || []).length) {
    const spot = el('div', { style: 'border:1px solid color-mix(in srgb, var(--gold) 45%, transparent);background:color-mix(in srgb, var(--gold) 8%, transparent);border-radius:12px;padding:10px 12px;margin-bottom:12px' });
    spot.appendChild(el('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:8px' },
      el('span', { style: 'font-size:15px', text: '⭐' }),
      el('span', { style: 'font-weight:700;color:var(--gold);font-size:14.5px', text: 'Exchange Spotlight — Boosted Until Midnight' })));
    const grid = el('div', { style: 'display:flex;flex-wrap:wrap;gap:8px' });
    for (const p of data.picks) {
      const chip = el('div', {
        class: 'event-pill',
        style: 'cursor:pointer;border-color:color-mix(in srgb, var(--gold) 50%, transparent);flex-direction:column;align-items:flex-start;gap:1px;min-width:150px',
        title: 'Click to open in the Stock Market app',
      },
        el('span', { style: 'display:flex;gap:6px;align-items:baseline' },
          el('b', { style: 'color:var(--gold);font-size:12.5px', text: p.item }),
          el('span', { class: 'px-up mono', text: `+${p.pct}%` })),
        el('span', { style: 'font-size:10px;color:var(--textdim)', text: 'Sell today →' }));
      chip.addEventListener('click', () => { _openApp('market'); SM.overview = null; _renderAppBody('market', document.getElementById('smBody_market')); setTimeout(() => _selectCommodity(p.item, true), 600); });
      grid.appendChild(chip);
    }
    spot.appendChild(grid);
    body.appendChild(spot);
  }

  const tags = ['all', ...new Set(data.feed.map(n => n.tag))];
  const filterRow = el('div', { class: 'news-filter' });
  for (const tg of tags) {
    filterRow.appendChild(el('span', {
      class: 'tag-chip',
      style: _newsTag === tg ? 'border-color:var(--accent);color:var(--accent)' : '',
      text: tg === 'all' ? 'All' : humanizeLabel(tg),
      onclick: () => { _newsTag = tg; _renderNews(body); },
    }));
  }
  body.appendChild(filterRow);

  const list = el('div', { class: 'news-list' });
  for (const n of data.feed) {
    if (_newsTag !== 'all' && n.tag !== _newsTag) continue;
    const arrow = n.pct > 0 ? `<span class="px-up">▲ +${n.pct}%</span>` : `<span class="px-down">▼ ${n.pct}%</span>`;
    const item = el('div', { class: `news-item ${n.status}` },
      el('div', { class: 'news-head' },
        el('span', { class: `status-chip status-${n.status}`, text: n.status === 'active' ? 'Live Today' : humanizeLabel(n.status) }),
        el('span', { class: 'tag-chip', text: humanizeLabel(n.tag) }),
        el('span', { class: 'mono', style: 'font-size:11px;color:var(--textdim)', text: n.end_sim && n.end_sim !== '+1d' ? `Runs ${n.end_sim}` : 'Ends tonight' })),
      el('div', { class: 'news-title', style: 'margin-top:6px', html: `${esc(n.title)} ${arrow}` }),
      n.blurb ? el('div', { class: 'news-blurb', text: n.blurb }) : null,
      el('div', { style: 'margin-top:6px' },
        ...n.affected_sample.map(a => el('span', { class: 'event-pill', text: a })),
        n.affected_count > n.affected_sample.length ? el('span', { class: 'event-pill', text: `+${n.affected_count - n.affected_sample.length} more` }) : null),
      el('div', { class: 'insp-sub', style: 'margin-top:5px;color:var(--textdim)',
        text: n.decay === 'exp' ? 'Fades slightly by evening' : 'Steady all day' }));
    list.appendChild(item);
  }
  body.appendChild(list);
}

/* ═══════════════════════════════════════════════════════════════════
   STOCK MARKET APP — table, chart, trade box, profit calc, compare
   ═══════════════════════════════════════════════════════════════════ */
async function _renderMarketApp(body) {
  const ov = SM.overview || (SM.overview = await _smApi('overview'));
  body.innerHTML = '';
  const layout = el('div', { class: 'mkt-layout' });
  const left = el('div');
  const right = el('div', { class: 'mkt-detail', id: 'mktDetail' });
  layout.appendChild(left); layout.appendChild(right);
  body.appendChild(layout);

  // toolbar
  const toolbar = el('div', { style: 'display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap' });
  const search = el('input', { class: 'wiki-search', style: 'flex:1;background:var(--bg);border-color:var(--border);color:var(--text)',
    placeholder: 'Search commodities…', value: SM.search });
  search.oninput = () => { SM.search = search.value; _repaintMktTable(left); };
  toolbar.appendChild(search);
  left.appendChild(toolbar);

  // category filter chips
  const cats = ['all', ...new Set(ov.rows.map(r => r.category).filter(Boolean))].sort((a, b) => a === 'all' ? -1 : b === 'all' ? 1 : a.localeCompare(b));
  const catRow = el('div', { class: 'news-filter', id: 'mktCatRow' });
  for (const c of cats) {
    catRow.appendChild(el('span', {
      class: 'tag-chip', style: SM.cat === c ? 'border-color:var(--accent);color:var(--accent)' : '',
      text: c === 'all' ? 'All' : humanizeLabel(c),
      onclick: () => { SM.cat = c; _repaintCatRow(); _repaintMktTable(left); },
    }));
  }
  left.appendChild(catRow);

  // Trading Floor — full side-by-side comparison of pinned commodities
  left.appendChild(el('div', { id: 'tradingFloor' }));

  const tableWrap = el('div', { class: 'mkt-table-wrap' });
  left.appendChild(tableWrap);

  right.appendChild(el('div', { class: 'insp-empty', style: 'color:var(--textdim)', text: 'Select a commodity to view its chart and trade.' }));

  _paintCompareTray();
  _repaintMktTable(left);
  if (SM.sel) _selectCommodity(SM.sel, false);
}

function _repaintCatRow() {
  const row = document.getElementById('mktCatRow');
  if (!row) return;
  row.querySelectorAll('.tag-chip').forEach(chip => {
    const isAll = chip.textContent === 'All';
    const active = isAll ? SM.cat === 'all' : humanizeLabel(SM.cat) === chip.textContent;
    chip.style.borderColor = active ? 'var(--accent)' : '';
    chip.style.color = active ? 'var(--accent)' : '';
  });
}

function _mktRows() {
  const rows = SM.overview.rows.slice();
  const q = SM.search.trim().toLowerCase();
  let out = rows.filter(r => !q || r.item.toLowerCase().includes(q) || (r.label || '').toLowerCase().includes(q));
  if (SM.cat !== 'all') out = out.filter(r => r.category === SM.cat);
  const { key, dir } = SM.sort;
  out.sort((a, b) => {
    const av = a[key], bv = b[key];
    if (typeof av === 'string') return dir * String(av).localeCompare(String(bv));
    return dir * ((av ?? 0) - (bv ?? 0));
  });
  return out;
}

function _repaintMktTable(host) {
  const wrap = host.querySelector('.mkt-table-wrap');
  if (!wrap) return;
  wrap.innerHTML = '';
  const rows = _mktRows();
  const table = el('table', { class: 'mkt-table' });
  const theadRow = el('tr');
  const cols = [['item', 'Commodity'], ['price', 'Price'], ['change_pct', '24h %'], ['holdings', 'Held'], ['daily_cap', 'Cap/day'], ['impact', 'Your impact']];
  for (const [key, label] of cols) {
    theadRow.appendChild(el('th', {
      text: label + (SM.sort.key === key ? (SM.sort.dir > 0 ? ' ▲' : ' ▼') : ''),
      onclick: () => { SM.sort = SM.sort.key === key ? { key, dir: -SM.sort.dir } : { key, dir: key === 'item' ? 1 : -1 }; _repaintMktTable(host); },
    }));
  }
  table.appendChild(el('thead', {}, theadRow));
  const tbody = el('tbody');
  rows.slice(0, 300).forEach(r => {
    const cls = r.change_pct >= 0 ? 'px-up' : 'px-down';
    const tr = el('tr', { class: 'clickable' + (SM.sel === r.item ? ' sel' : ''), 'data-item': r.item },
      el('td', { text: r.label && r.label !== r.item ? `${r.label} (${r.item})` : r.item }),
      el('td', { class: 'mono', text: fmt(r.price, 2) }),
      el('td', { class: `mono ${cls}`, text: `${r.change_pct >= 0 ? '+' : ''}${fmt(r.change_pct, 2)}%` }),
      el('td', { class: 'mono', text: String(Math.floor(r.holdings)) }),
      el('td', { class: 'mono', text: String(r.daily_cap) }),
      el('td', { class: 'mono', text: r.impact ? `${r.impact}%` : '—' }));
    tr.addEventListener('click', () => _selectCommodity(r.item, true));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  if (rows.length > 300) wrap.parentElement.insertBefore(
    el('div', { class: 'insp-sub', text: `Showing first 300 of ${rows.length} — refine your search.`, style: 'padding:4px 2px' }), wrap.nextSibling || null);
}

async function _selectCommodity(item, fetch) {
  SM.sel = item;
  const right = document.getElementById('mktDetail');
  if (!right) return;
  document.querySelectorAll('.mkt-table tr.sel').forEach(t => t.classList.remove('sel'));
  document.querySelectorAll('.mkt-table tr').forEach(t => {
    if (t.textContent.includes(item)) t.classList.add('sel');
  });
  right.innerHTML = '<div style="color:var(--textdim);padding:14px">Loading chart…</div>';
  let det;
  try { det = await _smApi(`item/${encodeURIComponent(item)}`); }
  catch (e) { right.innerHTML = ''; right.appendChild(el('div', { class: 'sm-toast error', text: e.message })); return; }
  right.innerHTML = '';

  right.appendChild(el('h3', { text: det.label || det.item }));
  if (det.daily_pick) {
    right.appendChild(el('div', { style: 'display:inline-block;border:1px solid color-mix(in srgb, var(--gold) 50%, transparent);background:color-mix(in srgb, var(--gold) 8%, transparent);color:var(--gold);border-radius:10px;padding:2px 10px;font-size:12px;margin-bottom:4px',
      text: `⭐ Exchange Spotlight today: +${det.daily_pick.pct}% — sell before midnight!` }));
  }
  const pxRow = el('div', { style: 'display:flex;gap:12px;align-items:baseline' },
    el('span', { id: 'mktLivePrice', class: 'mono', style: 'font-size:22px;color:var(--text)', text: fmt(det.price, 2) }),
    el('span', { id: 'mktLiveInfo', class: 'insp-sub', text: _detInfoText(det) }));
  SM.liveDet = det;
  right.appendChild(pxRow);

  // main chart
  const canvas = el('canvas', { width: 320, height: 130 });
  canvas.style.width = '100%';
  const chartBox = el('div', { class: 'chart-box', style: 'padding:6px' }, canvas);
  right.appendChild(chartBox);
  _drawChart(canvas, det.series.y, det.price);

  // active events affecting this commodity
  if ((det.events || []).length) {
    right.appendChild(el('div', {},
      ...(det.events.slice(0, 6).map(ev => el('span', { class: 'event-pill' },
        el('span', { html: ev.contrib_pct >= 0 ? '<b class="px-up">▲</b>' : '<b class="px-down">▼</b>' }),
        el('span', { text: `${ev.title} (${ev.contrib_pct > 0 ? '+' : ''}${ev.contrib_pct}%)` }))))));
  }

  // ── Trade box ──
  const qtyInput = el('input', { type: 'number', min: '1', value: '10' });
  const projBuy = el('div', { class: 'calc-line' }, el('span', { text: 'Buy cost ≈' }), el('b', { id: 'calcBuy', text: '—' }));
  const projSell = el('div', { class: 'calc-line' }, el('span', { text: 'Sell revenue ≈' }), el('b', { id: 'calcSell', text: '—' }));
  function recalc() {
    const q = Math.max(0, parseInt(qtyInput.value || '0', 10));
    projBuy.querySelector('b').textContent = `${fmt(det.price * 1.02 * q, 1)} N`;
    projSell.querySelector('b').textContent = `${fmt(det.price * 0.98 * q, 1)} N`;
    // profit calculator vs target price
    const target = parseFloat(targetInput.value);
    if (!isNaN(target) && target > 0 && q > 0) {
      const pl = (target - det.price * 1.0) * q;
      plOut.querySelector('b').textContent = `${pl >= 0 ? '+' : ''}${fmt(pl, 1)} N @ sell ${fmt(target, 2)}`;
      plOut.querySelector('b').style.color = pl >= 0 ? 'var(--green)' : 'var(--red)';
    } else plOut.querySelector('b').textContent = '—';
  }
  qtyInput.oninput = recalc;

  const targetInput = el('input', { type: 'number', step: '0.01', placeholder: 'target price…',
    style: 'width:110px;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:7px;padding:5px 8px;font-size:13px' });
  targetInput.oninput = recalc;
  const trendBtn = el('button', { class: 'btn-xs', text: 'Use trend ↗',
    title: 'Project the recent price slope forward one simulated week',
    onclick: () => { targetInput.value = _trendTarget(det.series.y); recalc(); } });

  const plOut = el('div', { class: 'calc-line' }, el('span', { text: 'Projected P/L:' }), el('b', { text: '—' }));

  const buyBtn = el('button', { class: 'trade-btn buy', text: `BUY`, onclick: () => _doTrade('buy', det) });
  const sellBtn = el('button', { class: 'trade-btn sell', text: `SELL`, onclick: () => _doTrade('sell', det) });

  const trade = el('div', { class: 'trade-box' },
    el('div', { class: 'trade-row' }, qtyInput,
      el('span', { class: 'insp-sub', text: 'quantity' }), buyBtn, sellBtn),
    projBuy, projSell,
    el('div', { class: 'trade-row' }, targetInput, trendBtn),
    plOut,
    el('div', { class: 'insp-sub', text: 'Selling pulls from your industrial warehouse, Market Depots, and Botanarium bag. Large orders slip the price against you.' }));
  right.appendChild(trade);

  const pin = el('button', { class: 'btn-xs', text: '📌 Compare',
    onclick: () => { _pinCompare(det.item); } });
  right.appendChild(pin);

  recalc();
  SM.recalc = recalc;
}

function _trendTarget(ys) {
  // least-squares slope over the last ~40 points, projected forward 7 sim days
  const tail = ys.slice(-40);
  const n = tail.length;
  if (n < 4) return ys[ys.length - 1] || 0;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  tail.forEach((y, i) => { sx += i; sy += y; sxy += i * y; sxx += i * i; });
  const slope = (n * sxy - sx * sy) / Math.max(1e-9, n * sxx - sx * sx);
  const last = tail[n - 1];
  return Math.max(0.01, last + slope * 7);
}

async function _doTrade(side, det) {
  const qtyInput = document.querySelector('.mkt-detail input[type=number]');
  const qty = parseInt((qtyInput?.value || '0'), 10);
  if (!qty || qty <= 0) { _smToast('Enter a quantity first.', true); return; }
  try {
    const r = await _smApi('trade', { method: 'POST', body: JSON.stringify({ side, item: det.item, qty }) });
    _smToast(side === 'sell'
      ? `Sold ${r.qty} × ${det.label || det.item} for ${fmt(r.proceeds, 1)} Nerds (${fmt(r.unit_price, 2)}/unit)`
      : `Bought ${r.qty} × ${det.label || det.item} for ${fmt(r.total, 1)} Nerds (${fmt(r.unit_price, 2)}/unit)`);
    SM.overview = null;   // refresh prices/holdings next render
    if (typeof refreshNerdsBadge === 'function') refreshNerdsBadge();   // top-bar Nerds must follow the trade
    await _refreshClockAndNerds();
    const left = document.querySelector('.mkt-layout > div');
    if (left && SM.overview) _repaintMktTable(left);
    _selectCommodity(det.item, true);
  } catch (e) { _smToast(e.message, true); }
}

/* ── Trading Floor: full side-by-side comparison (§6) ──
   Pinning a commodity (see the "📌 Compare" button in the detail pane)
   gives it its own full column here — price, chart, and active events
   — laid out side by side so several commodities can genuinely be
   read against each other at a glance, not just tiny sparklines. */
function _pinCompare(item) {
  if (SM.compare.includes(item)) SM.compare = SM.compare.filter(x => x !== item);
  else {
    if (SM.compare.length >= 4) { _smToast('The Trading Floor holds 4 commodities max.', true); return; }
    SM.compare.push(item);
  }
  _paintCompareTray();
}

function _paintCompareTray() {
  const floor = document.getElementById('tradingFloor');
  if (!floor) return;
  floor.innerHTML = '';
  if (!SM.compare.length) return;
  const track = el('div', { class: 'trading-floor' });
  floor.appendChild(el('div', { style: 'font-weight:700;margin:4px 0 6px;color:var(--text)', text: `📌 Trading Floor (${SM.compare.length}/4)` }));
  for (const item of SM.compare) {
    const col = el('div', { class: 'tf-col', 'data-item': item });
    col.appendChild(el('div', { class: 'tf-col-head' },
      el('span', { class: 'tf-col-title', text: item }),
      el('span', { class: 'tf-col-remove', text: '✕', onclick: () => _pinCompare(item) })));
    col.appendChild(el('div', { class: 'tf-col-price mono', text: 'Loading…' }));
    const cv = el('canvas', { width: 280, height: 70 });
    col.appendChild(cv);
    const eventsRow = el('div', { class: 'tf-col-events' });
    col.appendChild(eventsRow);
    const openBtn = el('button', { class: 'btn-xs', text: 'Open in detail →', onclick: () => _selectCommodity(item, true) });
    col.appendChild(openBtn);
    track.appendChild(col);
    _smApi(`item/${encodeURIComponent(item)}`).then(det => {
      _drawChart(cv, det.series.y, det.price);
      const priceEl = col.querySelector('.tf-col-price');
      const cls = (det.event_effect_pct || 0) >= 0 ? 'px-up' : 'px-down';
      priceEl.dataset.pct = det.event_effect_pct;
      priceEl.innerHTML = _tfPriceHtml(det.price, det.event_effect_pct);
      for (const ev of (det.events || []).slice(0, 3)) {
        eventsRow.appendChild(el('span', { class: 'event-pill', text: ev.title }));
      }
    }).catch(() => {});
  }
  floor.appendChild(track);
}

/* ── Canvas line chart with gradient fill ── */
function _drawChart(canvas, ys, cur) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!ys || ys.length < 2) return;
  const mn = Math.min(...ys), mx = Math.max(...ys);
  const pad = 4;
  const X = i => pad + (i / (ys.length - 1)) * (W - 2 * pad);
  const Y = v => H - pad - ((v - mn) / Math.max(1e-9, mx - mn)) * (H - 2 * pad);
  // Colors pulled live from the active theme's CSS custom properties,
  // so the chart always matches whatever theme is applied instead of
  // being locked to the old dark-only neon-cyan palette.
  const cs = getComputedStyle(document.documentElement);
  const accent = (cs.getPropertyValue('--accent') || '#00e5ff').trim();
  const textColor = (cs.getPropertyValue('--text') || '#ffffff').trim();
  const dimColor = (cs.getPropertyValue('--textdim') || '#7188a0').trim();
  const borderColor = (cs.getPropertyValue('--border') || '#22304a').trim();

  // gridlines
  ctx.strokeStyle = borderColor;
  ctx.globalAlpha = .5;
  ctx.lineWidth = 1;
  for (let g = 1; g < 4; g++) {
    ctx.beginPath(); ctx.moveTo(0, (H / 4) * g); ctx.lineTo(W, (H / 4) * g); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  // fill
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, _hexOrVarToRgba(accent, .22));
  grad.addColorStop(1, _hexOrVarToRgba(accent, .01));
  ctx.beginPath();
  ctx.moveTo(X(0), Y(ys[0]));
  ys.forEach((v, i) => ctx.lineTo(X(i), Y(v)));
  ctx.lineTo(X(ys.length - 1), H); ctx.lineTo(X(0), H); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
  // line
  ctx.beginPath();
  ctx.moveTo(X(0), Y(ys[0]));
  ys.forEach((v, i) => ctx.lineTo(X(i), Y(v)));
  ctx.strokeStyle = accent; ctx.lineWidth = 1.6; ctx.stroke();
  // current dot
  ctx.beginPath();
  ctx.arc(X(ys.length - 1), Y(cur ?? ys[ys.length - 1]), 3, 0, Math.PI * 2);
  ctx.fillStyle = textColor; ctx.fill();
  // labels
  ctx.fillStyle = dimColor;
  ctx.font = '9px "Share Tech Mono", monospace';
  ctx.fillText(fmt(mx, mx < 10 ? 2 : 0), 2, 9);
  ctx.fillText(fmt(mn, mn < 10 ? 2 : 0), 2, H - 2);
}

// Best-effort hex→rgba conversion so canvas gradients can use an alpha
// channel even when the CSS var resolves to a plain #rrggbb (most
// themes) rather than an rgb()/rgba() string.
function _hexOrVarToRgba(color, alpha) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(color || '');
  if (!m) return color;
  const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/* ═══════════════════════════════════════════════════════════════════
   INFO APP (§6: scoped ONLY to market mechanics)
   ═══════════════════════════════════════════════════════════════════ */
async function _renderInfo(body) {
  const data = await _smApi('info');
  body.innerHTML = '';
  body.appendChild(el('h3', { text: '📚 How this market works', style: 'margin:2px 0 10px;font-size:16px;color:var(--text)' }));
  for (const p of data.pages) {
    const details = el('details', { class: 'info-page' },
      el('summary', { text: p.title }),
      el('div', { class: 'info-body' }, ...p.body.map(par => el('p', { text: par }))));
    body.appendChild(details);
  }
}


/* ═══ LIVE UPDATES — patched in place every 2s (no re-render, no flicker) ═══ */
function _detInfoText(det) {
  return `base ${det.base} · vol ±${Math.round(det.volatility * 100)}% · cap ${det.daily_cap}/day · held ${Math.floor(det.holdings)}`;
}
function _tfPriceHtml(price, pct) {
  const cls = (pct || 0) >= 0 ? 'px-up' : 'px-down';
  return `${fmt(price, 2)} N <span class="${cls}" style="font-size:12px">${pct >= 0 ? '+' : ''}${pct}%</span>`;
}

function _smPatchTable() {
  const host = document.querySelector('#smBody_market .mkt-layout > div');
  const wrap = document.querySelector('#smBody_market .mkt-table-wrap');
  const tbody = wrap && wrap.querySelector('tbody');
  if (!host || !tbody || !SM.overview) return;
  const rows = _mktRows().slice(0, 300);
  const trs = new Map();
  tbody.querySelectorAll('tr').forEach(tr => trs.set(tr.dataset.item, tr));
  const sameSet = rows.length === trs.size && rows.every(r => trs.has(r.item));
  if (!sameSet) {
    const st = wrap.scrollTop;
    _repaintMktTable(host);
    const w2 = document.querySelector('#smBody_market .mkt-table-wrap');
    if (w2) w2.scrollTop = st;
    return;
  }
  rows.forEach(r => {
    const c = trs.get(r.item).children;
    c[1].textContent = fmt(r.price, 2);
    c[2].textContent = `${r.change_pct >= 0 ? '+' : ''}${fmt(r.change_pct, 2)}%`;
    c[2].className = `mono ${r.change_pct >= 0 ? 'px-up' : 'px-down'}`;
    c[3].textContent = String(Math.floor(r.holdings));
    c[4].textContent = String(r.daily_cap);
    c[5].textContent = r.impact ? `${r.impact}%` : '—';
  });
  const cur = Array.from(tbody.children);
  if (cur.some((tr, i) => tr.dataset.item !== rows[i].item)) rows.forEach(r => tbody.appendChild(trs.get(r.item)));
}

function _smPatchDetail() {
  const det = SM.liveDet;
  if (!det || det.item !== SM.sel || !SM.overview) return;
  const pe = document.getElementById('mktLivePrice');
  if (!pe) return;
  const row = SM.overview.rows.find(r => r.item === det.item);
  if (!row) return;
  det.price = row.price; det.holdings = row.holdings;
  pe.textContent = fmt(det.price, 2);
  const ie = document.getElementById('mktLiveInfo');
  if (ie) ie.textContent = _detInfoText(det);
  if (SM.recalc) SM.recalc();
}

function _smPatchFloor() {
  if (!SM.overview) return;
  const byItem = new Map(SM.overview.rows.map(r => [r.item, r]));
  document.querySelectorAll('#tradingFloor .tf-col').forEach(col => {
    const pe = col.querySelector('.tf-col-price');
    const row = byItem.get(col.dataset.item);
    if (!pe || !row || pe.dataset.pct === undefined) return;
    pe.innerHTML = _tfPriceHtml(row.price, parseFloat(pe.dataset.pct));
  });
}

async function _smLiveTick() {
  if (typeof currentPage === 'undefined' || currentPage !== 'stock_market') return;
  if (document.visibilityState !== 'visible' || SM._liveBusy) return;
  const rec = SM.windows.market;
  if (!rec || rec.minimized || !rec.elm.isConnected) return;
  SM._liveBusy = true;
  try {
    SM.overview = await _smApi('overview');
    _smPatchTable(); _smPatchDetail(); _smPatchFloor();
    _refreshClockAndNerds();
  } catch (e) { /* transient */ }
  SM._liveBusy = false;
}
window.SM_LIVE_TIMER = window.SM_LIVE_TIMER || setInterval(_smLiveTick, 2000);
