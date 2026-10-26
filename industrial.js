/* Cultivar — Industrial Production page.
   Card-based workspace (§2), tech tree browser (§5), and the production
   Wiki (§6). Talks to /api/<profile>/industrial/*.

   There is no grid, no pipes/wires, no rotation, no x/y placement —
   every owned miner/forester/generator/processor is a CARD in a plain
   list, exactly like the Botanarium's plant cards. Placing a card is a
   single click (no drag, no cursor-follow) since there's no position to
   choose; the person configures where it reads/writes AFTER placing it,
   by picking warehouses on the card itself. Global helpers ($, $$, el,
   esc, api, navigate, currentProfile) come from app.js. */

/* ── el() varargs compatibility shim ──
   This file (and stockmarket.js) call el('div', {...}, childA, childB)
   while app.js's canonical el() signature is el(tag, attrs, childrenArray).
   Wrapping once here lets every call site in this file use whichever style
   reads best, without touching any other file's call sites: arrays pass
   through untouched, loose arguments get flattened into an array. */
(function () {
  const _base = window.el;
  if (typeof _base !== 'function') return;   // app.js loads first (see index.html)
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

const IND = {
  state: null,
  view: 'workspace',        // workspace | tree | wiki
  paletteOpen: {},          // collapsed-state per palette group
  treeFilter: { era: 'all', q: '' },
  treeNodeSel: null,
  wiki: { q: '', cat: 'all' },
};

// ── Live-refresh polling ── keeps the workspace (progress bars,
// warehouse stock, build counters) in sync without needing a manual
// page refresh. Guarded so it only actually fetches/re-renders while
// the person is looking at the Industrial workspace tab.
let _indPollTimer = null;
function _indSig(st) { return JSON.stringify({ ...st, last_tick: null }); }

// Rebuilds the workspace DOM in place (no "Loading…" flash, scroll positions
// of the page and palette preserved) so values update live without the page
// visually reloading.
async function _indRebuildInPlace() {
  const host = document.querySelector('.ind-wrap');
  if (!host) return false;
  const content = document.getElementById('content');
  const sc = content ? content.scrollTop : 0;
  const pal = host.querySelector('.ind-palette2');
  const palSc = pal ? pal.scrollTop : 0;
  const fresh = el('div', { class: 'ind-wrap' });
  fresh.appendChild(_indTopbar());
  fresh.appendChild(await _indWorkspace());
  host.replaceWith(fresh);
  if (content) content.scrollTop = sc;
  const pal2 = fresh.querySelector('.ind-palette2');
  if (pal2) pal2.scrollTop = palSc;
  return true;
}

// Called after any user action: refresh state, then patch the view in place.
async function _indSoft() {
  await _refreshState();
  if (typeof refreshNerdsBadge === 'function') refreshNerdsBadge();
  if (IND.view === 'workspace' && currentPage === 'industrial') {
    if (!(await _indRebuildInPlace())) render();
  } else render();
}

let _indPolling = false;

// Layout-affecting state only; pure live numbers are patched in place.
function _indStructSig(st) {
  return JSON.stringify({
    cards: (st.cards || []).map(c => {
      const { prog, request_done, working, blocked_reason, energy_draw, energy_draw_rated, active_job_secs, ...rest } = c;
      return rest;
    }),
    wh: (st.warehouses || []).map(w => ({ id: w.id, name: w.name, level: w.level, level_name: w.level_name, capacity: w.capacity, next: w.next_upgrade_cost })),
    nwc: st.next_warehouse_cost, caps: st.caps, researched: st.researched,
    hf: st.hands_free, hp: st.hands_place_nerds,
  });
}

function _indPatchLive() {
  const s = IND.state;
  if (!s) return;
  const key = JSON.stringify({ h: s.hours, n: s.nerds, p: s.power });
  if (key !== IND._topKey) {
    const old = document.querySelector('.ind-topbar');
    if (old) old.replaceWith(_indTopbar());
  }
  (s.cards || []).forEach(c => {
    if (!c.jobs) return;
    const root = document.querySelector(`[data-card-id="${c.id}"]`);
    if (root) _paintProcLive(root, c);
  });
  (s.warehouses || []).forEach(w => {
    const root = document.querySelector(`[data-wh-id="${w.id}"]`);
    if (root) _paintWhLive(root, w);
  });
}

function _indStartPolling() {
  if (_indPollTimer) return;
  _indPollTimer = setInterval(async () => {
    if (_indPolling || typeof currentPage === 'undefined' || currentPage !== 'industrial' || IND.view !== 'workspace') return;
    if (document.visibilityState !== 'visible') return;
    _indPolling = true;
    try {
      await _refreshState();
      if (currentPage === 'industrial' && IND.view === 'workspace') {
        if (_indStructSig(IND.state) !== IND._struct) {
          const host = document.querySelector('.ind-wrap');
          const ae = document.activeElement;
          const editing = ae && host && host.contains(ae) && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName);
          if (!editing) await _indRebuildInPlace(); else _indPatchLive();
        } else _indPatchLive();
      }
    } catch (e) { /* ignore transient errors */ }
    _indPolling = false;
  }, 1000);
}

// Turns a raw snake_case/category id ("mining_tools", "ore_copper",
// "botanarium") into a readable title — "Mining Tools", "Ore Copper",
// "Botanarium" — used anywhere a backend category/tag/branch string
// would otherwise be shown to the person verbatim. A small overrides
// table fixes the handful that don't title-case cleanly on their own.
const _LABEL_OVERRIDES = {
  ore: 'Ore', pcb: 'PCB', cpu: 'CPU', ram: 'RAM', led: 'LED', ups: 'UPS',
};
function humanizeLabel(s) {
  if (!s) return '';
  return String(s).split(/[_\s]+/).filter(Boolean)
    .map(w => _LABEL_OVERRIDES[w.toLowerCase()] || (w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ');
}
window.humanizeLabel = humanizeLabel;

const ERA_ORDER = ['starter', 'primitive', 'early_metallurgy', 'industrial', 'advanced', 'precious'];
const ERA_LABELS = {
  starter: 'Starter Kit', primitive: 'Primitive', early_metallurgy: 'Early Metallurgy',
  industrial: 'Industrial', advanced: 'Advanced', precious: 'Precious',
};
// Deterministic flat-color fallback per category — used only as a small
// accent stripe on each card, since there's no sprite art in the
// card-list view.
function _catColor(cat) {
  let h = 0;
  for (const ch of String(cat || 'misc')) h = (h * 31 + ch.charCodeAt(0)) & 0xFFFFFF;
  const hue = h % 360;
  return `hsl(${hue} 55% 42%)`;
}

function _indApi(path, opts) { return api(`/api/${currentProfile}/industrial/${path}`, opts); }

async function renderIndustrial(c) {
  IND.state = await _indApi('state');
  // Nerds are spent/earned on this page (placing, upgrades, slots, warehouses);
  // keep the top-bar balance in step with the ledger without a full reload.
  if (typeof refreshNerdsBadge === 'function') refreshNerdsBadge();
  const wrap = el('div', { class: 'ind-wrap' });
  wrap.appendChild(_indTopbar());
  if (IND.view === 'workspace') wrap.appendChild(await _indWorkspace());
  else if (IND.view === 'tree') wrap.appendChild(await _indTreeView());
  else wrap.appendChild(await _indWikiView());
  c.innerHTML = '';
  c.appendChild(wrap);
  _indStartPolling();
}

async function _refreshState() { IND.state = await _indApi('state'); }

function _indToast(msg, isErr) {
  const t = el('div', { class: 'ind-toast' + (isErr ? ' error' : ''), text: msg });
  document.body.appendChild(t);
  setTimeout(() => t.remove(), isErr ? 5000 : 3000);
}

/* ── Top bar: stats strip + view tabs ── */
function _indTopbar() {
  const s = IND.state;
  IND._topKey = JSON.stringify({ h: s.hours, n: s.nerds, p: s.power });
  const capM = s.caps.mining, capW = s.caps.wood, capP = s.caps.processing;
  const bar = el('div', { class: 'ind-topbar' });
  bar.appendChild(el('div', { class: 'ind-stat' },
    el('b', { text: `${fmt(s.hours.available, 1)}h` }),
    el('span', { text: 'Study hours' })));
  bar.appendChild(el('div', { class: 'ind-stat' },
    el('b', { text: `×${fmt(s.hours.weekly_multiplier, 2)}` }),
    el('span', { text: `Weekly mult (${fmt(s.hours.weekly, 1)}h studied)` })));
  if (s.hours.luck_bonus > 0.001) {
    bar.appendChild(el('div', { class: 'ind-stat' },
      el('b', { text: `+${Math.round(s.hours.luck_bonus * 100)}%` }),
      el('span', { text: 'Rare find luck' })));
  }
  bar.appendChild(el('div', { class: 'ind-stat' },
    el('b', { text: fmt(s.nerds ?? 0, 0) }),
    el('span', { text: 'Nerds' })));
  bar.appendChild(el('div', { class: 'ind-stat' },
    el('b', { text: `${fmt(s.power.supply, 1)} / ${fmt(s.power.demand, 1)}` }),
    el('span', { text: `Power E/s (ratio ${fmt(s.power.ratio, 2)})` })));
  for (const [dom, cap] of [['Mining', capM], ['Wood', capW], ['Processing', capP]]) {
    const dd = el('div', { class: 'ind-stat' },
      el('b', { text: `${cap.used}/${cap.limit}` }),
      el('span', { text: dom + ' slots' }));
    if (cap.next_cost != null && cap.used >= cap.limit) {
      dd.appendChild(el('button', {
        class: 'btn-xs good', text: `+${cap.next_cost} Nerds`,
        onclick: async () => { await _postCap(dom.toLowerCase()); },
      }));
    }
    bar.appendChild(dd);
  }
  const tabs = el('div', { class: 'ind-tabs' });
  for (const [v, label] of [['workspace', 'Workspace'], ['tree', 'Tech Tree'], ['wiki', 'Wiki']]) {
    tabs.appendChild(el('button', {
      class: 'ind-tab' + (IND.view === v ? ' active' : ''), text: label,
      onclick: () => { IND.view = v; render(); },
    }));
  }
  bar.appendChild(tabs);
  return bar;
}

async function _postCap(domain) {
  try {
    await _indApi('buy_cap', { method: 'POST', body: JSON.stringify({ domain }) });
    await _indSoft();
  } catch (e) { _indToast(e.message, true); }
}

/* ═══════════════════════════════════════════════════════════════════
   WORKSPACE — palette (left) + owned cards + warehouses (right)
   ═══════════════════════════════════════════════════════════════════ */
async function _indWorkspace() {
  IND._struct = _indStructSig(IND.state);
  const grid = el('div', { class: 'ind-workspace2' });
  grid.appendChild(_palette());
  const main = el('div', { class: 'ind-main2' });
  main.appendChild(_cardsSection());
  main.appendChild(_warehousesSection());
  grid.appendChild(main);
  return grid;
}

/* ── Build palette (left) ── */
function _familyDisplayName(fid) {
  if (fid === 'hands') return 'Bare Hands';
  return fid.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
function _familyNodeName(fid) {
  return _treeIndex[fid] ? _treeIndex[fid].name : _familyDisplayName(fid);
}
let _treeIndex = {};

function _palette() {
  const s = IND.state;
  const pal = el('div', { class: 'ind-palette2' });

  function group(title, key, itemsBuilder) {
    const closed = IND.paletteOpen[key] === false;
    const head = el('div', { class: 'pal-group-title' }, el('span', { text: title }), el('span', { text: closed ? '▸' : '▾' }));
    head.onclick = () => { IND.paletteOpen[key] = closed ? true : false; _indRebuildInPlace(); };
    pal.appendChild(head);
    if (!closed) itemsBuilder().forEach(i => pal.appendChild(i));
  }

  function palItem(label, costText, locked, onclick, title) {
    return el('button', {
      class: 'pal-item2' + (locked ? ' locked' : ''),
      disabled: !!locked, title: title || null,
      onclick: locked ? null : onclick,
    },
      el('span', { text: label }),
      costText ? el('span', { class: 'pal-cost2', text: costText }) : null);
  }

  // Miners and foresters are only ever placed as Bare Hands; every better
  // tool is reached by upgrading that card (Upgrade button on the card).
  const handsRow = (domain, title) => group(title, domain, () => {
    const free = s.hands_free && s.hands_free[domain];
    return [palItem('Bare Hands', free ? 'Free' : `${s.hands_place_nerds} N`, false,
      () => _placeDirect({ family: 'hands', domain }),
      'Place a Bare Hands card, then upgrade it up its own tool ladder from the card itself')];
  });
  handsRow('mining', 'Miners');
  handsRow('wood', 'Foresters');

  group('Machines — Energy', 'mach_energy', () => _machineButtons(['energy', 'energy_storage']));
  group('Machines — Processing', 'mach_proc', () => _machineButtons(null));

  return pal;
}

let _machineCache = null;
async function _loadMachineList() {
  if (_machineCache) return _machineCache;
  const w = await _indApi('wiki');
  _machineCache = w.machines;
  return _machineCache;
}

function _machineButtons(categories) {
  if (!_machineCache) {
    _loadMachineList().then(() => { if (IND.view === 'workspace') render(); });
    _loadMachineIntros().then(() => { if (IND.view === 'workspace') render(); });
    return [el('div', { class: 'insp-empty', text: 'Loading…', style: 'padding:8px;font-size:12px' })];
  }
  const out = [];
  const seen = new Set();
  for (const m of _machineCache) {
    if (seen.has(m.name)) continue;
    seen.add(m.name);
    if (categories ? !categories.includes(m.category) : ['energy', 'energy_storage'].includes(m.category)) continue;
    const unlocked = _machineUnlockedByName(m.name);
    const st = IND.state;
    const isFree = st.starter_machines.includes(m.name) && !(st.free_placed || []).includes(m.name);
    const mats = Object.entries(m.build_inputs || {}).map(([k, v]) => `${v}× ${k}`).join(', ');
    const costText = isFree ? 'Free' : `${m.place_nerds} N`;
    out.push(el('button', {
      class: 'pal-item2' + (unlocked ? '' : ' locked'), disabled: !unlocked,
      title: unlocked
        ? `Build ${m.name} — ${isFree ? 'first one is free' : `${m.place_nerds} Nerds` + (mats ? ` + ${mats}` : '')}`
        : `Locked — research "${m.introduced_by || '?'}" first`,
      onclick: unlocked ? () => _placeDirect({ type: m.name }) : null,
    },
      el('span', { text: m.name }),
      el('span', { class: 'pal-cost2', text: unlocked ? costText : '🔒' })));
  }
  return out;
}

function _machineUnlockedByName(name) {
  const n = _machineIntro[name];
  return !n || IND.state.researched.includes(n) || IND.state.starter_machines.includes(name);
}
let _machineIntro = {};
async function _loadMachineIntros() {
  if (Object.keys(_machineIntro).length || _machineIntroLoaded) return;
  const t = await _indApi('tree');
  for (const nd of t.nodes) {
    for (const p of (nd.produces || [])) {
      if (p.is_machine) _machineIntro[p.item] = nd.id;
    }
  }
  _machineIntroLoaded = true;
}
let _machineIntroLoaded = false;

/* ── Placing a card is a single, immediate action — there's no grid
   position to choose, so the click IS the placement. Whatever warehouse
   it reads from/writes to defaults sensibly server-side and is then
   configured on the card itself (see the per-card selectors below). ── */
async function _placeDirect(payload) {
  try {
    const r = await _indApi('place', { method: 'POST', body: JSON.stringify(payload) });
    await _indSoft();
    const parts = [];
    if (r.nerds_spent > 0) parts.push(`${r.nerds_spent} Nerds`);
    if (r.consumed_build && Object.keys(r.consumed_build).length) {
      parts.push(Object.entries(r.consumed_build).map(([k, v]) => `${v}× ${k}`).join(', '));
    }
    if (parts.length) _indToast('Built for ' + parts.join(' + '));
  } catch (e) { _indToast(e.message, true); }
}

/* ── Owned cards (main area) ── */
function _cardsSection() {
  const s = IND.state;
  const wrap = el('div', { class: 'ind-cards-section' });
  if (!s.cards.length) {
    wrap.appendChild(el('div', { class: 'insp-empty', text: 'No cards yet — click a miner, forester, or machine in the palette to place one.' }));
    return wrap;
  }
  const groups = { mining: [], wood: [], power: [], processing: [], other: [] };
  for (const c of s.cards) {
    if (c.domain === 'mining') groups.mining.push(c);
    else if (c.domain === 'wood') groups.wood.push(c);
    else if (c.generator) groups.power.push(c);
    else if (c.is_machine) groups.processing.push(c);
    else groups.other.push(c);
  }
  const sections = [['mining', 'Mining'], ['wood', 'Forestry'], ['power', 'Power'], ['processing', 'Processing'], ['other', 'Other']];
  for (const [key, title] of sections) {
    if (!groups[key].length) continue;
    wrap.appendChild(el('div', { class: 'ind-cards-title', text: `${title} (${groups[key].length})` }));
    const grid = el('div', { class: 'ind-cards-grid' });
    groups[key].forEach(c => grid.appendChild(_buildCard(c)));
    wrap.appendChild(grid);
  }
  return wrap;
}

function _cardHeader(c) {
  return el('div', { class: 'ind-card2-head' },
    el('div', { class: 'ind-card2-name' },
      el('span', { text: c.type }),
      el('span', { class: 'text-dim', style: 'font-size:10px;font-weight:500', text: ERA_LABELS[c.era] || '' })),
    el('div', { class: 'ind-card2-actions' },
      el('button', {
        class: 'btn-xs' + (c.active ? ' good' : ''), text: c.active ? 'On' : 'Off',
        title: 'Toggle on/off — an off card draws no power and does nothing',
        onclick: () => _configCard(c.id, { active: !c.active }),
      }),
      el('button', { class: 'btn-xs danger', text: '✕', title: 'Remove card', onclick: () => _removeCard(c.id) })));
}

function _whSelect(current, onChange) {
  const sel = el('select', { onchange: (e) => onChange(e.target.value) });
  (IND.state.warehouses || []).forEach(w => sel.appendChild(el('option', {
    value: w.id, text: w.name, selected: w.id === current ? '' : null,
  })));
  return sel;
}

function _whMultiSelect(currentIds, onChange) {
  const wrap = el('div', { class: 'ind-wh-multi' });
  (IND.state.warehouses || []).forEach(w => {
    const checked = (currentIds || []).includes(w.id);
    wrap.appendChild(el('label', { class: 'ind-wh-multi-row' },
      el('input', {
        type: 'checkbox', checked,
        onchange: (e) => {
          const next = new Set(currentIds || []);
          if (e.target.checked) next.add(w.id); else next.delete(w.id);
          onChange(Array.from(next));
        },
      }),
      el('span', { text: w.name })));
  });
  return wrap;
}

function _buildCard(c) {
  if (c.family) return _buildMinerCard(c);
  if (c.generator) return _buildGeneratorCard(c);
  if (c.jobs) return _buildProcessorCard(c);
  // Fallback for any card type with nothing domain-specific to show —
  // deliberately minimal rather than showing fields it doesn't use.
  const card = el('div', { class: 'ind-card2', style: `border-left-color:${_catColor(c.category || c.type)}` });
  card.appendChild(_cardHeader(c));
  return card;
}

function _buildMinerCard(c) {
  const card = el('div', {
    class: 'ind-card2' + (c.active ? '' : ' inactive'),
    style: `border-left-color:${_catColor(c.domain)}`,
  });
  card.appendChild(_cardHeader(c));
  const body = el('div', { class: 'ind-card2-body' });
  body.appendChild(el('div', { class: 'insp-row' }, el('span', { text: 'Level' }), el('b', { text: `${c.level}/3` })));
  body.appendChild(el('div', { class: 'insp-row' }, el('span', { text: 'Base rate' }), el('b', { text: `${c.base_rate}/s ×mult` })));
  if (c.energy_draw != null) body.appendChild(el('div', { class: 'insp-row' }, el('span', { text: 'Power draw (current)' }), el('b', { text: `${c.energy_draw} E/s` })));

  // Only shown when this family can reach more than one raw item —
  // a family with a single reachable item has nothing to focus on.
  if ((c.reachable || []).length > 1) {
    const toggle = el('div', { class: 'ind-mode-toggle' },
      el('button', { class: c.mode !== 'focus' ? 'on' : '', text: 'Mixed', onclick: () => _configCard(c.id, { mode: 'mixed' }) }),
      el('button', { class: c.mode === 'focus' ? 'on' : '', text: 'Focus ×3', onclick: () => _configCard(c.id, { mode: 'focus' }) }));
    body.appendChild(toggle);
    if (c.mode === 'focus') {
      const sel = el('select', { onchange: (e) => _configCard(c.id, { focus: e.target.value }) });
      c.reachable.forEach(it => sel.appendChild(el('option', { value: it, text: it, selected: c.focus === it ? '' : null })));
      body.appendChild(sel);
    }
  }

  body.appendChild(el('label', { text: 'Output warehouse' }));
  body.appendChild(_whSelect(c.output_warehouse, (v) => _configCard(c.id, { output_warehouse: v })));

  const actions = el('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap;margin-top:4px' });
  if (!c.powered_tool && c.family !== 'hands' && c.level < 3) {
    actions.appendChild(el('button', { class: 'btn-xs good', text: '⬆ Level up', onclick: () => _toolAction('tool_level', c.id) }));
  }
  if (c.upgrade) {
    const u = c.upgrade;
    const bill = [`${u.nerds} Nerds`, ...Object.entries(u.items).map(([k, v]) => `${v}× ${k}`)].join(' + ');
    body.appendChild(el('label', { text: `Next tool: ${u.name}` }));
    body.appendChild(el('div', { class: 'ind-recipe-line build', text: bill }));
    if (u.researched) {
      actions.appendChild(el('button', { class: 'btn-xs good', text: `⬆ Upgrade to ${u.name}`, title: bill, onclick: () => _toolAction('tool_upgrade', c.id) }));
    } else {
      body.appendChild(el('div', { class: 'ind-blocked', text: `Research "${u.name}" in the Tech Tree to unlock this upgrade.` }));
    }
  } else {
    body.appendChild(el('div', { class: 'text-dim text-sm', text: 'Top of its tool ladder.' }));
  }
  body.appendChild(actions);

  card.appendChild(body);
  return card;
}

function _buildGeneratorCard(c) {
  const card = el('div', {
    class: 'ind-card2' + (c.active ? '' : ' inactive'),
    style: `border-left-color:${_catColor(c.type)}`,
  });
  card.appendChild(_cardHeader(c));
  const body = el('div', { class: 'ind-card2-body' });
  body.appendChild(el('div', { class: 'insp-row' }, el('span', { text: 'Power output' }), el('b', { text: `${c.generator.power} E/s` })));
  if (c.generator.fuel) {
    for (const [f, rate] of Object.entries(c.generator.fuel)) {
      body.appendChild(el('div', { class: 'insp-row' }, el('span', { text: `Burns ${f}` }), el('b', { text: `${rate}/s` })));
    }
    body.appendChild(el('label', { text: 'Fuel warehouses' }));
    body.appendChild(_whMultiSelect(c.input_warehouses, (ids) => _configCard(c.id, { input_warehouses: ids })));
  } else {
    body.appendChild(el('div', { class: 'text-dim text-sm', text: 'No fuel required — always supplies its full rating while on.' }));
  }
  card.appendChild(body);
  return card;
}

function _procLiveNodes(c) {
  const out = [];
  if (!(c.jobs || []).length) return out;
  if (c.blocked_reason) out.push(el('div', { class: 'ind-blocked', text: c.blocked_reason }));
  const complete = c.request_qty != null && !c.has_request;
  let progText;
  if (c.has_request) progText = `Building ${c.request_item}: ${c.request_done}/${c.request_qty}${c.active ? (c.working ? ' — working' : '') : ' (paused)'}`;
  else if (complete) progText = `Request complete (${c.request_done}/${c.request_qty} ${c.request_item}) — idle`;
  else progText = 'Idle — set a build request to start production (idle machines make nothing and draw no power)';
  out.push(el('div', { class: 'ind-prog-row', text: progText }));
  if (c.working && c.active_job_secs) {
    const pct = Math.max(0, Math.min(100, (c.prog / c.active_job_secs) * 100));
    const secsLeft = Math.max(0, Math.round(c.active_job_secs - c.prog));
    out.push(el('div', { class: 'ind-item-progress' }, [
      el('div', { class: 'ind-item-progress-track' }, [el('div', { class: 'ind-item-progress-fill', style: `width:${pct}%` })]),
      el('div', { class: 'ind-item-progress-label', text: `${Math.round(pct)}% of this unit • ${secsLeft}s left` })
    ]));
  }
  return out;
}

function _paintProcLive(root, c) {
  const en = root.querySelector('.live-energy');
  if (en && c.energy_draw != null) en.textContent = `${c.energy_draw} E/s${c.energy_draw_rated ? ` (rated ${c.energy_draw_rated})` : ''}`;
  const box = root.querySelector('.live-proc');
  if (!box) return;
  const nodes = _procLiveNodes(c);
  const key = nodes.map(n => n.outerHTML).join('');
  if (box.dataset.k !== key) { box.replaceChildren(...nodes); box.dataset.k = key; }
}

function _buildProcessorCard(c) {
  const card = el('div', {
    class: 'ind-card2' + (c.active ? '' : ' inactive'),
    style: `border-left-color:${_catColor(c.category || c.type)}`,
    'data-card-id': c.id,
  });
  card.appendChild(_cardHeader(c));
  const body = el('div', { class: 'ind-card2-body' });
  if (c.energy_draw != null) body.appendChild(el('div', { class: 'insp-row' }, el('span', { text: 'Power draw (current)' }),
    el('b', { class: 'live-energy', text: `${c.energy_draw} E/s${c.energy_draw_rated ? ` (rated ${c.energy_draw_rated})` : ''}` })));

  const jw = el('div', { class: 'ind-recipes' });
  (c.jobs || []).forEach(j => {
    const ins = Object.entries(j.inputs).map(([k, v]) => `${v}× ${k}`).join(' + ') || '—';
    const outs = Object.entries(j.outputs).map(([k, v]) => `${v}× ${k}`).join(', ');
    jw.appendChild(el('div', {
      class: 'ind-recipe-line' + (j.build ? ' build' : ''),
      text: `${ins} → ${outs} (${j.secs}s${j.build ? ' · build' : ''})`,
    }));
  });
  if ((c.jobs || []).length) body.appendChild(jw);

  body.appendChild(el('label', { text: 'Input warehouses' }));
  body.appendChild(_whMultiSelect(c.input_warehouses, (ids) => _configCard(c.id, { input_warehouses: ids })));
  body.appendChild(el('label', { text: 'Output warehouse' }));
  body.appendChild(_whSelect(c.output_warehouse, (v) => _configCard(c.id, { output_warehouse: v })));

  const outputsSet = new Set();
  (c.jobs || []).forEach(j => Object.keys(j.outputs).forEach(k => outputsSet.add(k)));
  if (outputsSet.size) {
    const live = el('div', { class: 'live-proc' });
    const nodes = _procLiveNodes(c);
    live.replaceChildren(...nodes);
    live.dataset.k = nodes.map(n => n.outerHTML).join('');
    body.appendChild(live);

    const outputsList = Array.from(outputsSet);
    let reqSel = null;
    if (outputsList.length > 1) {
      reqSel = el('select', {});
      outputsList.forEach(it => reqSel.appendChild(el('option', { value: it, text: it, selected: c.request_item === it ? '' : null })));
    }
    const qtyInput = el('input', { type: 'number', min: '1', value: '1', style: 'width:74px' });
    const reqRow = el('div', { class: 'row', style: 'gap:6px;margin-top:6px;align-items:center;flex-wrap:wrap' });
    if (reqSel) reqRow.appendChild(reqSel);
    reqRow.appendChild(qtyInput);
    reqRow.appendChild(el('button', {
      class: 'btn-xs good', text: 'Start request', title: 'Build this many, then stop',
      onclick: () => {
        const patch = { request_qty: parseInt(qtyInput.value) || 1 };
        patch.request_item = reqSel ? reqSel.value : outputsList[0];
        _configCard(c.id, patch);
      },
    }));
    if (c.request_qty != null) {
      reqRow.appendChild(el('button', { class: 'btn-xs danger', text: c.has_request ? 'Cancel request' : 'Clear', onclick: () => _configCard(c.id, { request_qty: null }) }));
    }
    body.appendChild(reqRow);
  }

  card.appendChild(body);
  return card;
}

async function _configCard(id, patch) {
  try {
    await _indApi('config', { method: 'POST', body: JSON.stringify({ id, ...patch }) });
    await _indSoft();
  } catch (e) { _indToast(e.message, true); }
}
async function _toolAction(action, id) {
  try {
    const r = await _indApi(action, { method: 'POST', body: JSON.stringify({ id }) });
    _indToast(action === 'tool_level' ? `Leveled up to L${r.level}!` : `Upgraded to ${r.name} for ${r.cost} Nerds`);
    await _indSoft();
  } catch (e) { _indToast(e.message, true); }
}
async function _removeCard(id) {
  try {
    await _indApi('remove', { method: 'POST', body: JSON.stringify({ id }) });
    await _indSoft();
  } catch (e) { _indToast(e.message, true); }
}

/* ── Warehouses ── */
function _warehousesSection() {
  const s = IND.state;
  const wrap = el('div', { class: 'ind-warehouses-section' });
  wrap.appendChild(el('div', { class: 'ind-cards-title', text: `Warehouses (${s.warehouses.length}/${s.warehouse_max})` }));
  const grid = el('div', { class: 'ind-cards-grid' });
  s.warehouses.forEach(w => grid.appendChild(_buildWarehouseCard(w)));
  if (s.next_warehouse_cost != null) {
    const addCard = el('div', {
      class: 'ind-card2 ind-card2-add',
      onclick: async () => {
        try {
          await _indApi('warehouse/add', { method: 'POST', body: JSON.stringify({}) });
          await _indSoft();
        } catch (e) { _indToast(e.message, true); }
      },
    },
      el('div', { text: '+ New Warehouse' }),
      el('div', { class: 'text-dim text-sm', text: `${s.next_warehouse_cost} Nerds` }));
    grid.appendChild(addCard);
  }
  wrap.appendChild(grid);
  return wrap;
}

function _whChipsFill(chips, w) {
  const invEntries = Object.entries(w.inv || {}).filter(([, v]) => v >= 0.5).sort((a, b) => b[1] - a[1]);
  const key = invEntries.map(([k, v]) => k + ':' + fmt(v, 0)).join('|');
  if (chips.dataset.k === key) return;
  chips.dataset.k = key;
  chips.replaceChildren();
  if (!invEntries.length) {
    chips.appendChild(el('div', { class: 'text-dim text-sm', text: 'Empty' }));
    return;
  }
  invEntries.slice(0, 2).forEach(([k, v]) => chips.appendChild(
    el('div', { class: 'ind-wh-line' }, el('span', { text: k }), el('b', { text: fmt(v, 0) }))));
  if (invEntries.length > 2) {
    const fullList = invEntries.map(([k, v]) => `${k}: ${fmt(v, 0)}`).join('\n');
    const more = el('div', { class: 'ind-more-link', text: `+${invEntries.length - 2} more items — hover to view` });
    attachTooltip(more, fullList, 'var(--gold)');
    chips.appendChild(more);
  }
}

function _paintWhLive(root, w) {
  const u = root.querySelector('.live-wh-used');
  if (u) u.textContent = `${fmt(w.used, 0)}/${w.capacity}`;
  const f = root.querySelector('.live-wh-fill');
  if (f) f.style.width = `${w.capacity ? Math.min(100, (w.used / w.capacity) * 100) : 0}%`;
  const chips = root.querySelector('.ind-wh-chips');
  if (chips) _whChipsFill(chips, w);
}

function _buildWarehouseCard(w) {
  const card = el('div', { class: 'ind-card2 ind-wh-card', 'data-wh-id': w.id });
  const nameInput = el('input', { value: w.name, class: 'ind-wh-name-input' });
  nameInput.addEventListener('change', async () => {
    const val = nameInput.value.trim();
    if (!val) { nameInput.value = w.name; return; }
    try {
      await _indApi('warehouse/rename', { method: 'POST', body: JSON.stringify({ warehouse_id: w.id, name: val }) });
      await _refreshState();
    } catch (e) { _indToast(e.message, true); nameInput.value = w.name; }
  });
  card.appendChild(nameInput);
  card.appendChild(el('div', { class: 'text-dim text-sm' }, [
    el('span', { text: `${w.level_name} · ` }),
    el('span', { class: 'live-wh-used', text: `${fmt(w.used, 0)}/${w.capacity}` })]));
  const pct = w.capacity ? Math.min(100, (w.used / w.capacity) * 100) : 0;
  card.appendChild(el('div', { class: 'xp-progress-track' }, el('div', { class: 'xp-progress-fill live-wh-fill', style: `width:${pct}%` })));
  const chips = el('div', { class: 'ind-wh-chips' });
  _whChipsFill(chips, w);
  card.appendChild(chips);
  if (w.next_upgrade_cost != null) {
    card.appendChild(el('button', {
      class: 'btn-xs good', text: `⬆ Upgrade (${w.next_upgrade_cost}N)`,
      onclick: async () => {
        try {
          await _indApi('warehouse/upgrade', { method: 'POST', body: JSON.stringify({ warehouse_id: w.id }) });
          await _indSoft();
        } catch (e) { _indToast(e.message, true); }
      },
    }));
  } else {
    card.appendChild(el('div', { class: 'text-dim text-sm', text: 'Max capacity' }));
  }
  return card;
}

/* ═══════════════════════════════════════════════════════════════════
   TECH TREE VIEW
   ═══════════════════════════════════════════════════════════════════ */
async function _indTreeView() {
  const t = await _indApi('tree');
  _treeIndex = {};
  for (const n of t.nodes) _treeIndex[n.id] = n;
  const wrap = el('div');
  const toolbar = el('div', { class: 'tree-toolbar' });
  const search = el('input', { class: 'wiki-search', placeholder: 'Search nodes…', value: IND.treeFilter.q });
  search.oninput = () => { IND.treeFilter.q = search.value; _repaintTreeCols(t, colsHost); };
  toolbar.appendChild(search);
  for (const era of ['all', ...ERA_ORDER, 'efficiency']) {
    toolbar.appendChild(el('button', {
      class: 'wiki-cat-chip' + (IND.treeFilter.era === era ? ' active' : ''),
      text: era === 'all' ? 'All eras' : (era === 'efficiency' ? 'Efficiency branch' : ERA_LABELS[era]),
      onclick: () => { IND.treeFilter.era = era; render(); },
    }));
  }
  toolbar.appendChild(el('div', { class: 'ind-stat', style: 'margin-left:auto;border:none' },
    el('b', { text: `${t.hours.available}h` }), el('span', { text: 'available to spend' })));
  wrap.appendChild(toolbar);

  const layout = el('div', { class: 'tree-layout' });
  const colsHost = el('div', { class: 'tree-cols-wrap' });
  _repaintTreeCols(t, colsHost);
  layout.appendChild(colsHost);

  const detail = el('div', { id: 'treeDetail', class: 'tree-detail-dock' });
  layout.appendChild(detail);
  wrap.appendChild(layout);
  _renderTreeDetail(t, detail);
  return wrap;
}

function _nodeStatus(n, researchedSet) {
  if (n.researched) return 'done';
  return (n.affordable_hours && n.prerequisites.every(p => researchedSet.has(p))) ? 'avail' : 'locked';
}

function _repaintTreeCols(t, host) {
  host.innerHTML = '';
  const researchedSet = new Set(t.nodes.filter(n => n.researched).map(n => n.id));
  const q = IND.treeFilter.q.trim().toLowerCase();
  let nodes = t.nodes;
  if (q) nodes = nodes.filter(n => n.name.toLowerCase().includes(q) || n.id.includes(q));
  if (IND.treeFilter.era !== 'all') {
    nodes = nodes.filter(n => IND.treeFilter.era === 'efficiency' ? n.branch === 'efficiency' : n.era === IND.treeFilter.era);
  }
  const groups = {};
  for (const era of ERA_ORDER) groups[era] = [];
  groups['efficiency'] = [];
  groups['other'] = [];
  for (const n of nodes) {
    if (n.branch === 'efficiency') groups.efficiency.push(n);
    else if (groups[n.era]) groups[n.era].push(n);
    else groups.other.push(n);
  }
  const cols = el('div', { class: 'tree-cols' });
  const sections = [...ERA_ORDER.map(e => [e, ERA_LABELS[e]]), ['efficiency', 'Efficiency'], ['other', 'Other']];
  let shown = 0;
  for (const [key, label] of sections) {
    if (!groups[key].length) continue;
    const col = el('div', { class: 'tree-col' });
    col.appendChild(el('div', { class: 'tree-col-title', text: label }));
    for (const n of groups[key]) {
      shown++;
      const st = _nodeStatus(n, researchedSet);
      const node = el('div', {
        class: `tree-node ${st}` + (IND.treeNodeSel === n.id ? ' selected' : ''),
        onclick: () => { IND.treeNodeSel = n.id; _repaintTreeCols(t, host); _renderTreeDetail(t, document.getElementById('treeDetail')); },
      },
        el('div', { class: 'tn-name', text: n.name }),
        el('div', { class: 'tn-meta' },
          el('span', { class: 'tn-hours', text: `${n.study_hours}h` }),
          el('span', { text: st === 'done' ? '✓ researched' : st === 'avail' ? '● available' : '🔒 locked' }),
          n.effect ? el('span', { class: 'effect-chip', text: 'buff' }) : null));
      col.appendChild(node);
    }
    cols.appendChild(col);
  }
  if (!shown) host.appendChild(el('div', { class: 'insp-empty', text: 'No nodes match this filter.' }));
  host.appendChild(cols);
}

function _renderTreeDetail(t, host) {
  host.innerHTML = '';
  const n = t.nodes.find(x => x.id === IND.treeNodeSel);
  if (!n) {
    host.appendChild(el('div', { class: 'tree-detail tree-detail-empty' },
      el('div', { class: 'insp-empty', text: 'Select a node on the left to see what it unlocks, what it costs, and to research it.' })));
    return;
  }
  const box = el('div', { class: 'tree-detail' });
  box.appendChild(el('h3', { text: n.name, style: 'margin:0 0 4px;color:var(--accent)' }));
  box.appendChild(el('div', { class: 'insp-sub', text: `${n.branch === 'efficiency' ? 'Efficiency buff' : 'Unlock'} · ${ERA_LABELS[n.era] || humanizeLabel(n.category)} · Category: ${humanizeLabel(n.category)}` }));
  if (n.description) box.appendChild(el('p', { text: n.description, style: 'font-size:13.5px;line-height:1.55' }));
  box.appendChild(el('p', { html: `<b>Unlocks:</b> ${esc(n.unlocks || '')}`, style: 'font-size:13px' }));

  if (n.effect) {
    const eff = n.effect;
    const mag = eff.magnitude > 0 ? '+' : '';
    box.appendChild(el('div', { style: 'margin:8px 0' },
      el('span', { class: 'effect-chip', text: `${mag}${Math.round(eff.magnitude * 100)}% ${humanizeLabel(eff.type)}` }),
      el('span', { class: 'insp-sub', text: `Target: ${humanizeLabel(eff.target)}` })));
  }

  if ((n.prerequisites || []).length) {
    const pw = el('div', { style: 'margin:8px 0' }, el('b', { text: 'Prerequisites: ', style: 'font-size:13px' }));
    for (const p of n.prerequisites) {
      const pn = t.nodes.find(x => x.id === p);
      pw.appendChild(el('span', {
        class: 'pre-chip', text: pn ? pn.name : p,
        style: pn && pn.researched ? 'color:var(--green)' : '',
        onclick: () => { IND.treeNodeSel = p; _renderTreeDetail(t, host); window.scrollTo(0, 0); },
      }));
    }
    box.appendChild(pw);
  }

  if ((n.requirements || []).length) {
    const rw = el('div', { style: 'margin:8px 0' }, el('b', { text: 'Consumes: ', style: 'font-size:13px' }));
    for (const r of n.requirements) {
      rw.appendChild(el('span', { class: `pre-chip ${r.have >= r.quantity ? 'req-ok' : 'req-no'}`, text: `${r.item} ${Math.floor(r.have)}/${r.quantity}` }));
    }
    box.appendChild(rw);
  }

  if ((n.produces || []).length) {
    const prodw = el('div', { style: 'margin:8px 0' }, el('b', { text: 'Produces: ', style: 'font-size:13px' }));
    for (const p of n.produces) prodw.appendChild(el('span', { class: 'pre-chip', text: p.is_machine ? `🏭 ${p.item}` : p.item }));
    box.appendChild(prodw);
  }

  const canResearch = !n.researched && n.affordable_hours && n.affordable_res &&
    n.prerequisites.every(p => t.nodes.find(x => x.id === p)?.researched);
  const btn = el('button', {
    class: 'btn-xs good', style: 'padding:8px 22px;font-size:14px;margin-top:8px',
    text: n.researched ? '✓ Researched' : (canResearch ? `Research — ${n.study_hours}h` : 'Locked'),
    disabled: !canResearch ? '' : null,
    onclick: async () => {
      try {
        const r = await _indApi('research', { method: 'POST', body: JSON.stringify({ node_id: n.id }) });
        _indToast(`Researched ${n.name}! ${r.unlocks || ''}`);
        await render();
      } catch (e) { _indToast(e.message, true); }
    },
  });
  box.appendChild(btn);
  host.appendChild(box);
}

/* ═══════════════════════════════════════════════════════════════════
   WIKI VIEW (§6: documents the industrial system, outside the device UI)
   ═══════════════════════════════════════════════════════════════════ */
async function _indWikiView() {
  const w = await _indApi('wiki');
  const wrap = el('div');
  const search = el('input', { class: 'wiki-search', placeholder: 'Search production points, items, recipes…', value: IND.wiki.q });
  search.oninput = () => { IND.wiki.q = search.value; _repaintWiki(w, listHost); };
  wrap.appendChild(search);
  const cats = ['all', ...Object.keys(w.categories)];
  const chipRow = el('div', { class: 'wiki-cats', id: 'wikiCats' });
  wrap.appendChild(chipRow);
  const listHost = el('div');
  wrap.appendChild(listHost);
  _paintWikiChips(cats, chipRow, w, listHost);
  _repaintWiki(w, listHost);
  return wrap;
}

function _paintWikiChips(cats, chipRow, w, listHost) {
  chipRow.innerHTML = '';
  for (const c of cats) {
    chipRow.appendChild(el('span', {
      class: 'wiki-cat-chip' + (IND.wiki.cat === c ? ' active' : ''),
      text: c === 'all' ? 'All' : humanizeLabel(c),
      onclick: () => { IND.wiki.cat = c; _paintWikiChips(cats, chipRow, w, listHost); _repaintWiki(w, listHost); },
    }));
  }
}

function _repaintWiki(w, host) {
  host.innerHTML = '';
  const q = IND.wiki.q.trim().toLowerCase();
  const entries = [];
  for (const [cat, list] of Object.entries(w.categories)) {
    if (IND.wiki.cat !== 'all' && cat !== IND.wiki.cat) continue;
    for (const e of list) {
      if (q && !e.name.toLowerCase().includes(q) && !(e.node_name || '').toLowerCase().includes(q)) continue;
      entries.push(e);
    }
  }
  entries.sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name));
  const sub = el('h3', { text: `Items & Goods (${entries.length})`, style: 'margin:14px 0 8px' });
  host.appendChild(sub);
  for (const e of entries.slice(0, 400)) {
    const rec = e.recipe ? `${Object.entries(e.recipe.inputs).map(([k, v]) => `${v}× ${k}`).join(' + ')} → ${Object.entries(e.recipe.outputs).map(([k, v]) => `${v}× ${k}`).join(', ')} @ ${e.recipe.machine}` :
      (e.build_recipe ? `Built at ${e.build_recipe.machine}` : (e.crafted_at === 'BY_HAND' ? 'Crafted by hand' : '—'));
    host.appendChild(el('div', { class: 'wiki-entry' },
      el('div', { class: 'pal-swatch', style: `background:${_catColor(e.category)};width:30px;height:30px` }),
      el('div', {},
        el('h4', { text: e.name }),
        el('div', { class: 'w-meta', text: `${humanizeLabel(e.category)} · from "${e.node_name}"${rec !== '—' ? ' · ' + rec : ''}` })),
      el('div', { class: 'wiki-price', text: `${fmt(e.base_price, 1)} N` })));
  }

  const mach = el('h3', { text: `Production Points (${w.machines.length})`, style: 'margin:18px 0 8px' });
  host.appendChild(mach);
  for (const m of w.machines) {
    if (IND.wiki.cat !== 'all' && m.category !== IND.wiki.cat) continue;
    if (q && !m.name.toLowerCase().includes(q)) continue;
    const lines = [];
    if (m.generator) lines.push(`Generator: ${m.generator.power} E/s` + (m.generator.fuel ? `, burns ${Object.keys(m.generator.fuel).join(', ')}` : ', no fuel needed'));
    for (const r of (m.recipes_run || []).slice(0, 4)) {
      lines.push(`${Object.entries(r.inputs).map(([k, v]) => `${v}× ${k}`).join(' + ')} → ${Object.entries(r.outputs).map(([k, v]) => `${v}× ${k}`).join(', ')} (${r.secs}s)`);
    }
    host.appendChild(el('div', { class: 'wiki-entry' },
      el('div', { class: 'pal-swatch', style: `background:${_catColor(m.category)};width:30px;height:30px` }),
      el('div', {},
        el('h4', { text: m.name }),
        ...(lines.map(l => el('div', { class: 'w-meta', text: l })))),
      el('div', { class: 'w-meta', text: ERA_LABELS[m.era] || '' })));
  }
}
