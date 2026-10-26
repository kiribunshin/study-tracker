/* Cultivar - Frontend */
// ═══════════════════════════════════════════
// ── VERSION ── Bump this whenever you ship a meaningful change. This
// is the ONE place to edit it on the frontend - it's what the topbar's
// "v..." sub-label (see index.html's #topLevelBar area / logo-sub span)
// and any future about/settings display should read from. The backend
// has its own matching APP_VERSION constant near the top of server.py;
// the two are edited independently but should generally be bumped
// together when you ship a change that touches both.
// ═══════════════════════════════════════════
const APP_VERSION = '3.0.0';
const API = '';
let currentProfile = null;
let currentPage = 'dashboard';
let cachedConfig = null;
let cachedData = null;
let gamification = null;   // cached /gamification response
let gamificationError = null;
let lastKnownLevel = null; // used to detect level-ups after XP-earning actions
let lastKnownXp = null;
let lastKnownNerds = null;
let pendingSettingsScroll = null;
let pendingFileExplorerOpen = null; // {ref_type, ref_id} - jump the Files page straight to an item, set from Settings' buttons
let subjectListYearFilter = 'all';
// Both the Market and Theme Shop start COLLAPSED - the Inventory page
// used to require a lot of scrolling to reach the Theme Shop, most of
// it past a Market table that isn't always what someone opened the
// page for. Remembered across page visits (not just this render) via
// localStorage, same pattern as theme/audio preferences.
let marketExpanded = localStorage.getItem('st_market_expanded') === '1';
let themeShopExpanded = localStorage.getItem('st_themeshop_expanded') === '1';
let themeUpgradesExpanded = localStorage.getItem('st_themeupgrades_expanded') === '1';
let settingsYearsExpanded = localStorage.getItem('st_settings_years_expanded') === '1';
let vaultPreviewExpanded = localStorage.getItem('st_vault_preview_expanded') === '1';
let activeTimer = null; // last known server timer state - refreshed on load/navigation/actions, not polled

// ═══════════════════════════════════════════
// ── CONTROL PANEL (frontend) ──
// UI-only timing/behavior constants - the gameplay/economy numbers
// (XP rates, badge thresholds, etc.) live server-side in server.py's
// own Control Panel, since the server is the source of truth for
// those. This block is just presentation timing: how long toasts
// stay up, how long celebratory overlays linger, etc.
// ═══════════════════════════════════════════
const UI_XP_TOAST_DISPLAY_MS = 2600;
const UI_UNDO_TOAST_DISPLAY_MS = 8000;
const UI_SESSION_XP_TOAST_DISPLAY_MS = 4200;
const UI_TOAST_FADE_OUT_MS = 220;          // matches the .xp-toast CSS transition duration
const UI_LEVELUP_OVERLAY_AUTO_DISMISS_MS = 6000;
const UI_LEVELUP_BAR_PULSE_MS = 1800;      // how long #topLevelBar keeps its level-up-pulse class
const UI_STATUS_MESSAGE_CLEAR_MS = 4000;   // how long a timer status line ("Saved: 30min") stays before clearing
const UI_MINI_TIMER_TICK_MS = 1000;
const UI_CHART_CACHE_BUST = true;          // append ?t=Date.now() to chart <img> src so Stats always shows fresh renders

// Timetable calendar vertical scale. pxPerHour normally sits at
// CAL_BASE_PX_PER_HOUR; renderCalendar() grows it (up to
// CAL_MAX_PX_PER_HOUR) whenever the current week has a real block
// shorter than CAL_MIN_BLOCK_PX would need at the base scale - this is
// what keeps short back-to-back study/break segments from visually
// overlapping instead of padding them past their real end time.
const CAL_BASE_PX_PER_HOUR = 44;
const CAL_MAX_PX_PER_HOUR = 110;
const CAL_MIN_BLOCK_PX = 20;               // must match the render-time height floor below

// ── Helpers ──
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }
function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    // A null/undefined attribute value means "omit this attribute
    // entirely" (e.g. `disabled: cond ? '' : null`) - without this
    // check, setAttribute(k, null) stringifies to the literal text
    // "null", which for presence-based attributes like `disabled` is
    // still present and therefore still true, permanently disabling
    // the element regardless of `cond`. This silently broke every
    // button in the app using that pattern (Research, buy/upgrade
    // buttons, etc.) - always disabled no matter the real condition.
    if (v === null || v === undefined) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    // Boolean HTML attributes (disabled, checked, selected, required...)
    // are presence-based: setAttribute(k, false) still ADDS the attribute
    // (as the string "false"), which the browser reads as present = on.
    // Setting them as DOM properties instead respects actual truthiness,
    // so passing disabled:false correctly leaves the element enabled.
    else if (typeof v === 'boolean') e[k] = v;
    // <textarea> renders from its text content / .value property, NOT
    // the "value" HTML attribute (that only works for <input>/<select>).
    // setAttribute('value', ...) on a textarea is silently a no-op
    // visually, which was making every pre-filled textarea (e.g. the
    // Edit Focus note field) show up blank even though the data
    // was correctly passed in.
    else if (k === 'value' && tag === 'textarea') { e.value = v; }
    else e.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}
function fmt(n, d = 1) { return Number(n).toFixed(d); }
function fmtHours(mins) { return fmt(mins / 60, 1); }
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// ── Icon manifest ──
// Every custom PNG icon the UI references, gathered in ONE place -
// rename a file on disk and update its value here once, rather than
// hunting through the whole app for scattered string literals. Each
// value is a filename (no extension) resolved by uiIcon() as
// /sprites/icons/<value>.png. `collection(id)` is a function rather
// than a flat entry since there's one icon per Botanarium collection,
// living one folder deeper at /sprites/icons/collections/<id>.png.
const ICONS = {
  audioVolume: 'audio_volume',   // background music mute + theme ambient audio mute (shared - see updateAudioMuteButton/updateThemeAudioMuteButton)
  streak: 'streak',              // navbar level card + Progression XP card
  folder: 'folder',              // File Explorer folder cards
  fileMarkdown: 'file_markdown', // .md / .markdown
  fileTxt: 'file_txt',           // .txt
  filePdf: 'file_pdf',           // .pdf
  filePython: 'file_python',     // .py
  fileJs: 'file_js',             // .js / .jsx / .ts / .tsx
  fileCss: 'file_css',           // .css / .scss
  fileHtml: 'file_html',         // .html / .htm
  moneyGained: 'money_gained',   // Finance ledger - any positive entry
  moneySpent: 'money_spent',     // Finance ledger - any negative entry
  collection: (id) => `collections/${id}`, // one per Botanarium collection, e.g. collections/potato_collection.png
};

// ── Custom icon support ──
// A growing set of spots in the UI used to rely on emoji glyphs for
// small inline icons (mute buttons, streak, file kinds, plant
// collections, finance income/expense) - uiIcon() replaces those with
// real, user-droppable PNG files living at /sprites/icons/<name>.png,
// so anyone can swap in their own custom-made icon set just by placing
// files there, with zero code changes. A missing file fails gracefully:
// if `fallbackText` is given, the <img> quietly swaps itself for a
// small text badge (matching the old file-kind-badge look) the moment
// it fails to load; otherwise it just disappears rather than showing a
// broken-image icon.
function uiIcon(name, size, extraClass, fallbackText) {
  const img = el('img', {
    src: `/sprites/icons/${name}.png`,
    class: `ui-icon${extraClass ? ' ' + extraClass : ''}`,
    style: `width:${size || 16}px;height:${size || 16}px`
  });
  img.addEventListener('error', () => {
    if (fallbackText !== undefined && fallbackText !== null) {
      img.replaceWith(el('span', { class: 'fe-card-icon', text: fallbackText }));
    } else {
      img.style.display = 'none';
    }
  }, { once: true });
  return img;
}
// Lesson/attendance type codes stay "C"/"TD"/"TP" in stored data (no
// migration needed), but display everywhere as Lesson / Guided Work
// / Lab. Use lessonTypeLabel(code) anywhere a raw code would otherwise
// be shown to the person.
const LESSON_TYPE_LABELS = { C: 'Lesson', TD: 'Guided Work', TP: 'Lab' };
function lessonTypeLabel(code) { return LESSON_TYPE_LABELS[code] || code; }
function nowStr() { return new Date().toISOString().slice(0, 19); }
function localDateStr(d = new Date()) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
function todayStr() { return localDateStr(new Date()); }
// Subjects tied to an academic year that's already ENDED shouldn't
// clutter pickers for CURRENT/new activity (starting a timer, logging
// today's study, marking today's attendance) - but they must stay
// fully visible everywhere else (Settings' subject list, Progression/
// Achievements/Mastery, Stats, Exams) since that's real historical
// record-keeping, not "what am I doing right now." A subject with no
// year assigned, or whose year has no end_date, is always considered
// current - only an explicit, already-past end_date excludes it.
function activeSubjects(cfg) {
  const subjects = (cfg?.subjects || []).filter(s => !s.archived);
  const years = cfg?.academic_years || [];
  const today = todayStr();
  return subjects.filter(s => {
    if (!s.year_id) return true;
    const yr = years.find(y => y.id === s.year_id);
    if (!yr || !yr.end_date) return true;
    return yr.end_date >= today;
  });
}

// Builds <optgroup>-organized subject/skill picker options - replaces
// the old flat "[Skill] Name" list, which got hard to scan once
// someone had a real spread of subjects and skills. Subjects/skills are
// grouped under their OWN category as the group label (skills under
// "Skill: <category>", so it never gets confused with a same-named
// subject category), with a plain "Subjects"/"Skills" group for
// anything uncategorized. { activeOnly: true } applies the same
// current-academic-year filter as activeSubjects() - skills have no
// year concept, so they're never filtered.
function buildSubjectSkillOptionGroups(cfg, opts = {}) {
  const subjects = opts.activeOnly ? activeSubjects(cfg) : (cfg?.subjects || []).filter(s => !s.archived);
  const subjectCats = cfg?.subject_categories || [];
  const skills = (cfg?.skills || []).filter(s => !s.archived);
  const skillCats = cfg?.skill_categories || [];
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

  function grouped(items, cats) {
    const byCat = [];
    const seen = new Set();
    [...cats].sort(byName).forEach(cat => {
      const inCat = items.filter(it => it.category_id === cat.id).sort(byName);
      if (inCat.length) { byCat.push({ label: cat.name, items: inCat }); seen.add(cat.id); }
    });
    const uncategorized = items.filter(it => !it.category_id || !cats.some(c => c.id === it.category_id)).sort(byName);
    return { byCat, uncategorized };
  }

  const nodes = [];
  const subjGrouped = grouped(subjects, subjectCats);
  subjGrouped.byCat.forEach(g => nodes.push(el('optgroup', { label: g.label }, g.items.map(s => el('option', { value: s.id, text: s.name })))));
  if (subjGrouped.uncategorized.length) nodes.push(el('optgroup', { label: 'Subjects' }, subjGrouped.uncategorized.map(s => el('option', { value: s.id, text: s.name }))));

  const skillGrouped = grouped(skills, skillCats);
  skillGrouped.byCat.forEach(g => nodes.push(el('optgroup', { label: `Skill: ${g.label}` }, g.items.map(s => el('option', { value: 'skill_' + s.id, text: s.name })))));
  if (skillGrouped.uncategorized.length) nodes.push(el('optgroup', { label: 'Skills' }, skillGrouped.uncategorized.map(s => el('option', { value: 'skill_' + s.id, text: s.name }))));

  return nodes;
}
function localDateFromStr(dateStr) { return new Date(`${dateStr}T12:00:00`); }

async function api(path, opts = {}) {
  const url = API + path;
  const defaults = { headers: { 'Content-Type': 'application/json' } };
  const res = await fetch(url, { ...defaults, ...opts });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `Request failed (HTTP ${res.status})` }));
    throw new Error(err.error || `Request failed (HTTP ${res.status})`);
  }
  return res.json();
}

// ── Navigation ──
function navigate(page) {
  const changed = page !== currentPage;
  currentPage = page;
  $$('.nav-btn[data-page]').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  updateMiniTimerBadge();
  updateParallaxPosition();
  updateNavOverflow();
  if (changed) playPageTransitionSweep();
  render();
}

// A themed transition (see THEME_TRANSITION_STYLES) if the active
// theme has one, otherwise the plain CSS sweep. Reuses one canvas
// across navigations instead of creating a new one every time.
function playPageTransitionSweep() {
  const theme = document.documentElement.getAttribute('data-theme');
  const style = THEME_TRANSITION_STYLES[theme];
  if (style) {
    const cs = getComputedStyle(document.documentElement);
    const colors = ['--accent', '--accent2', '--accent3'].map(v => cs.getPropertyValue(v).trim()).filter(Boolean);
    PageTransitionFX.run(style, colors);
    return;
  }
  let sweep = document.getElementById('pageTransitionSweep');
  if (!sweep) {
    sweep = el('div', { id: 'pageTransitionSweep', class: 'page-transition-sweep' });
    document.body.appendChild(sweep);
  }
  sweep.classList.remove('play');
  void sweep.offsetWidth;
  sweep.classList.add('play');
}

// ── Nav bar: overflow "More ▾" menu + traveling active-tab dot ──
// Rather than shrinking font size until buttons squeeze-fit (the old
// behavior), narrower windows now tuck the trailing nav items into a
// dropdown instead - measured in real pixels since this is a resizable
// desktop window, not a fixed set of breakpoints. Buttons are hidden
// (not removed) so their real onclick/data-page attributes stay intact
// for the dropdown to reuse directly.
function _debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function updateNavOverflow() {
  const wrap = $('.nav-btns');
  const moreBtn = $('#navMoreBtn');
  if (!wrap || !moreBtn) return;
  const buttons = Array.from(wrap.querySelectorAll('.nav-btn[data-page]'));
  buttons.forEach(b => b.classList.remove('nav-btn-overflowed'));
  moreBtn.classList.add('hidden');
  // Buttons flagged data-always-more (Hall of Fame, Finance) live in the
  // "More ▾" menu permanently, regardless of available width - they're
  // pages someone dips into occasionally, not ones that need to compete
  // for space in the main bar. Hide them FIRST so the width-based
  // overflow measurement below reclaims their space for everything else.
  const alwaysMore = buttons.filter(b => b.dataset.alwaysMore === '1');
  alwaysMore.forEach(b => b.classList.add('nav-btn-overflowed'));
  const widthCandidates = buttons.filter(b => b.dataset.alwaysMore !== '1');
  // Everything else visible now (nothing width-overflowed yet) - measure
  // in this state so earlier buttons' positions are the same regardless
  // of how many trailing ones end up hidden.
  const limit = wrap.getBoundingClientRect().right - 86; // reserve room for the "More ▾" button itself
  let overflowIdx = -1;
  for (let i = 0; i < widthCandidates.length; i++) {
    if (widthCandidates[i].getBoundingClientRect().right > limit) { overflowIdx = i; break; }
  }
  if (overflowIdx !== -1) {
    widthCandidates.slice(overflowIdx).forEach(b => b.classList.add('nav-btn-overflowed'));
  }
  const overflowed = buttons.filter(b => b.classList.contains('nav-btn-overflowed'));
  if (overflowed.length) {
    moreBtn.classList.remove('hidden');
    moreBtn.classList.toggle('active', overflowed.some(b => b.classList.contains('active')));
  } else {
    moreBtn.classList.remove('active');
  }
  updateNavActiveDot();
}

function updateNavActiveDot() {
  const dot = $('#navActiveDot');
  const wrap = $('.nav-btns');
  if (!dot || !wrap) return;
  const moreBtn = $('#navMoreBtn');
  let target = wrap.querySelector('.nav-btn.active:not(.nav-btn-overflowed)');
  if (!target && moreBtn && !moreBtn.classList.contains('hidden') && moreBtn.classList.contains('active')) target = moreBtn;
  if (!target) { dot.style.opacity = '0'; return; }
  const wrapRect = wrap.getBoundingClientRect();
  const tRect = target.getBoundingClientRect();
  dot.style.opacity = '1';
  dot.style.left = `${tRect.left - wrapRect.left + tRect.width / 2 - 3}px`;
}

function toggleNavMoreMenu(e) {
  e.stopPropagation();
  const existing = document.querySelector('.nav-more-popover');
  if (existing) { existing.remove(); return; }
  const overflowed = Array.from(document.querySelectorAll('.nav-btn.nav-btn-overflowed'));
  if (!overflowed.length) return;
  const pop = el('div', { class: 'nav-more-popover' }, overflowed.map(b =>
    el('div', {
      class: `nav-more-item${b.classList.contains('active') ? ' active' : ''}`,
      text: b.textContent,
      onclick: () => { pop.remove(); navigate(b.dataset.page); }
    })
  ));
  document.body.appendChild(pop);
  const rect = $('#navMoreBtn').getBoundingClientRect();
  const popWidth = 170;
  pop.style.top = `${rect.bottom + 6}px`;
  pop.style.left = `${Math.max(8, Math.min(rect.right - popWidth, window.innerWidth - popWidth - 8))}px`;
  setTimeout(() => document.addEventListener('click', () => pop.remove(), { once: true }), 0);
}

window.addEventListener('resize', _debounce(updateNavOverflow, 120));

// Activity time tracking (music/video/pages). Each gets its own
// achievement ladder server-side (Melomaniac/Cinephile/Dedicated, see
// BADGE_DEFS in server.py). Deliberately excludes the app's own ambient
// background music from "music", since that plays by default for
// everyone and would trivially max the badge. Only File Explorer
// playback (something the person chose to open) counts. Heartbeats
// send periodically while the activity is ongoing rather than one ping
// at the end, so a session survives an app close without losing all
// its progress.
const ACTIVITY_PING_INTERVAL_MS = 30000;

function _makeActivityTicker(kind, pageGetter) {
  let iv = null;
  return {
    start() {
      if (iv || !currentProfile) return;
      iv = setInterval(() => {
        if (document.visibilityState !== 'visible' || !currentProfile) return;
        api(`/api/${currentProfile}/activity/ping`, {
          method: 'POST',
          body: JSON.stringify({ kind, page: pageGetter ? pageGetter() : undefined, seconds: ACTIVITY_PING_INTERVAL_MS / 1000 })
        }).catch(() => {});
      }, ACTIVITY_PING_INTERVAL_MS);
    },
    stop() { if (iv) { clearInterval(iv); iv = null; } }
  };
}
const pageActivityTicker = _makeActivityTicker('page', () => currentPage);
const musicActivityTicker = _makeActivityTicker('music');

// ── Modal ──
// A backdrop click only counts as "close the modal" intent if the
// mousedown ALSO started directly on the backdrop - otherwise, selecting
// text inside the modal (e.g. dragging across a paragraph) and letting
// go with the mouse slightly outside the modal's edge would close the
// whole thing mid-selection, which is exactly the kind of thing that
// makes an editor feel fragile instead of "dominant."
let _modalMouseDownWasBackdrop = false;
(function _wireModalBackdropMouseTracking() {
  const overlay = document.getElementById('modalOverlay');
  if (overlay) {
    overlay.addEventListener('mousedown', (e) => { _modalMouseDownWasBackdrop = (e.target === overlay); });
  }
})();
// Escape always closes the topmost modal - a deliberate keypress, unlike
// an accidental outside click, so this applies even to "dominant"
// viewer/editor modals that ignore backdrop clicks.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('modalOverlay').classList.contains('show')) {
    closeModal();
  }
});

function showModal(content) {
  const mc = $('#modalContent');
  // A previous modal (e.g. the PDF/video viewer) may have left sizing
  // classes or a still-playing <video>/<audio> behind - always reset
  // to a clean slate before mounting new content, rather than only
  // doing that cleanup on explicit close.
  mc.querySelectorAll('video, audio').forEach(m => { try { m.pause(); m.removeAttribute('src'); m.load(); } catch (_) {} });
  mc.className = 'modal';
  mc.innerHTML = '';
  mc.appendChild(content);
  $('#modalOverlay').classList.add('show');
}
function closeModal(e) {
  // The guard below only ever applies to a click that bubbled up to the
  // OVERLAY's own click handler (e.currentTarget really is the overlay
  // element in that case) - every other caller (a modal's × button, the
  // Escape handler above, or a plain closeModal() call after saving)
  // passes either no event at all or an event whose currentTarget is
  // something else entirely, and those must always close the modal
  // unconditionally. Applying this guard to every closeModal(e) call
  // indiscriminately - the previous version's bug - ended up blocking
  // the × button itself for "dominant" viewer modals, and for regular
  // modals whenever no prior backdrop mousedown had been recorded yet.
  const overlay = document.getElementById('modalOverlay');
  if (e && e.currentTarget === overlay) {
    const mc = $('#modalContent');
    if (mc.classList.contains('fe-viewer-modal')) return;
    if (e.target !== e.currentTarget || !_modalMouseDownWasBackdrop) return;
  }
  $('#modalOverlay').classList.remove('show');
  const mc = $('#modalContent');
  // Hiding the overlay is purely visual - a <video>/<audio> element left
  // inside #modalContent keeps playing (and keeps making sound) until
  // its node is actually removed, which used to only happen the NEXT
  // time a modal opened. Stop and clear it immediately on close instead.
  mc.querySelectorAll('video, audio').forEach(m => { try { m.pause(); m.removeAttribute('src'); m.load(); } catch (_) {} });
  mc.className = 'modal';
  mc.innerHTML = '';
}

// Themes beyond the free starting set unlock by level (see
// gamification.unlocked_themes). setTheme() guards against applying a
// theme the person hasn't unlocked, since the saved theme is read
// straight from localStorage on load and could be stale.
//
// THEME_META mirrors server.py's THEME_CATALOG/VAULT_THEME_CATALOG for
// just the cosmetic fields (background stem, effect class), kept
// client-side so the parallax layer/effect class can apply instantly on
// load instead of waiting on gamification to fetch. Vault themes are
// included too since real unlock eligibility is still enforced
// server-side, this is display data only.
const THEME_META = {
  sakura: { background: 'sakurabackground', effect: 'particle-drift' },
  light: { background: 'lightbackground', effect: 'sharp-snap' },
  dark: { background: 'darkbackground', effect: 'glow-breathe' },
  breeze: { background: 'breezebackground', effect: 'sway-idle' },
  midnight: { background: 'midnightbackground', effect: 'glow-breathe' },
  forest: { background: 'forestbackground', effect: 'sway-idle' },
  sunset: { background: 'sunsetbackground', effect: 'warm-pulse' },
  ocean: { background: 'oceanbackground', effect: 'ripple-fill' },
  rosegold: { background: 'rosegoldbackground', effect: 'glow-breathe' },
  autumn: { background: 'autumnbackground', effect: 'particle-drift' },
  cyberpunk: { background: 'cyberpunkbackground', effect: 'glitch-pulse' },
  nord: { background: 'nordbackground', effect: 'compact-density' },
  mono: { background: 'monobackground', effect: 'sharp-snap' },
  candy: { background: 'candybackground', effect: 'warm-pulse' },
  coffee: { background: 'coffeebackground', effect: 'warm-pulse' },
  aurora: { background: 'aurorabackground', effect: 'ripple-fill' },
  velvet: { background: 'velvetbackground', effect: 'glow-breathe' },
  obsidian: { background: 'obsidianbackground', effect: 'sharp-snap' },
  citrus: { background: 'citrusbackground', effect: 'particle-drift' },
  copperline: { background: 'copperlinebackground', effect: 'glow-breathe' },
  orchard: { background: 'orchardbackground', effect: 'sway-idle' },
  wisteria_dream: { background: 'wisteriadreambackground', effect: 'wisteria_dream' },
  starfall: { background: 'starfallbackground', effect: 'starfall' },
  gilded_bloom: { background: 'gildedbloombackground', effect: 'gilded_bloom' },
  void_bloom: { background: 'voidbloombackground', effect: 'void_bloom' },
  phoenix_ember: { background: 'phoenixemberbackground', effect: 'phoenix_ember' },
  vault_eclipse_court: { background: 'eclipsecourtbackground', effect: 'vault_eclipse_court' },
  vault_marrow_garden: { background: 'marrowgardenbackground', effect: 'vault_marrow_garden' },
  vault_glass_monsoon: { background: 'glassmonsoonbackground', effect: 'vault_glass_monsoon' },
  vault_gold_leaf_requiem: { background: 'goldleafrequiembackground', effect: 'vault_gold_leaf_requiem' },
  vault_cathedral_static: { background: 'cathedralstaticbackground', effect: 'vault_cathedral_static' },
  vault_paper_lantern_sea: { background: 'paperlanternseabackground', effect: 'vault_paper_lantern_sea' },
  vault_iron_orchid: { background: 'ironorchidbackground', effect: 'vault_iron_orchid' },
  vault_permafrost_atrium: { background: 'permafrostatriumbackground', effect: 'vault_permafrost_atrium' },
  vault_bioluminal_reef: { background: 'bioluminalreefbackground', effect: 'vault_bioluminal_reef' },
  vault_last_ember_kingdom: { background: 'lastemberkingdombackground', effect: 'vault_last_ember_kingdom' },
};
const THEME_EFFECT_CLASSES = ['glitch-pulse', 'ripple-fill', 'sway-idle', 'glow-breathe', 'warm-pulse', 'sharp-snap', 'particle-drift', 'compact-density'];

// Theme Particle Engine: a small canvas system reused across premium/
// vault themes via one config object per theme, instead of separate
// CSS keyframes for each. Free/early themes get no entry on purpose.
//
// Config fields:
//   shape: 'dot' | 'diamond' | 'streak'
//   colors: array of css colors, one picked per particle
//   size: [min, max] px
//   speed: [min, max] px/frame
//   direction: 'down' | 'up' | 'drift' (drift = slow random wander)
//   spawn: 'top' | 'bottom' | 'random'
//   driftX: horizontal wander amount
//   sway: sideways sine amplitude
//   life: [min, max] seconds before a particle respawns
//   opacity: peak alpha
//   glow: shadowBlur px, 0 for none
//   spin: diamonds rotate while falling
//   angle: [dx, dy] direction for streak particles (rain, lightning)
const THEME_PARTICLE_CONFIGS = {
  wisteria_dream: {
    shape: 'diamond', count: 34, colors: ['#b98af0', '#e0b8ff', '#8a5fd9'],
    size: [3, 6], speed: [0.35, 0.9], direction: 'down', spawn: 'top',
    driftX: 0.3, sway: 0.9, life: [10, 18], opacity: 0.65, glow: 8, spin: true,
  },
  starfall: {
    shape: 'dot', count: 110, colors: ['#ffffff', '#ffd76a', '#6a8aff'],
    size: [0.5, 1.6], speed: [0.02, 0.06], direction: 'drift', spawn: 'random',
    driftX: 0.05, sway: 0, life: [20, 40], opacity: 0.9, glow: 5,
    // Makes the star field feel navigable rather than a fixed backdrop
    // pasted behind the app - see themeCameraOffsetY / the wheel
    // listener below, which this flag opts ThemeFX's render loop into
    // reading from. worldHeightMultiplier is how many viewport-heights
    // tall the star field actually is - scrolling pans within that
    // fixed range (no looping); see themeCameraMaxOffset.
    scrollParallax: true, worldHeightMultiplier: 2.4,
    // A rare shooting star streaking across the screen - see
    // SHOOTING_STAR_AUDIO_PATH near the ThemeFX engine below for the
    // exact audio file this expects.
    shootingStar: true, shootingStarInterval: [18000, 42000],
  },
  gilded_bloom: {
    shape: 'dot', count: 24, colors: ['#f0c44a', '#fce09a'],
    size: [1.5, 3.5], speed: [0.2, 0.5], direction: 'up', spawn: 'bottom',
    driftX: 0.15, sway: 0.4, life: [12, 20], opacity: 0.8, glow: 10,
  },
  void_bloom: {
    shape: 'dot', count: 50, colors: ['#a83cff', '#ff4ec7', '#5a1fa8'],
    size: [1, 3.5], speed: [0.06, 0.16], direction: 'drift', spawn: 'random',
    driftX: 0.1, sway: 1.4, life: [18, 30], opacity: 0.75, glow: 12,
  },
  phoenix_ember: {
    shape: 'dot', count: 26, colors: ['#ffd27a', '#ff8a3d', '#d93a14'],
    size: [1.5, 3], speed: [0.6, 1.2], direction: 'up', spawn: 'bottom',
    driftX: 0.3, sway: 0.6, life: [6, 10], opacity: 0.85, glow: 9,
  },
  vault_eclipse_court: {
    // A unique shape for this theme alone: thin rotating corona-flare
    // arcs (not full rings, not dots) in pale gold/white, matching the
    // reworked "real eclipse" vibe below rather than the old generic
    // purple dot drift.
    shape: 'flare', count: 22, colors: ['#f0dfa8', '#ffffff', '#d8ceff'],
    size: [4, 9], speed: [0.04, 0.09], direction: 'drift', spawn: 'random',
    driftX: 0.08, sway: 1.2, life: [14, 24], opacity: 0.75, glow: 9, rotateSlow: true,
  },
  vault_marrow_garden: {
    shape: 'dot', count: 18, colors: ['#b8342f', '#e0d6c9'],
    size: [1.5, 3], speed: [0.05, 0.12], direction: 'drift', spawn: 'random',
    driftX: 0.2, sway: 1.0, life: [14, 22], opacity: 0.55, glow: 8,
  },
  vault_glass_monsoon: {
    // "Monsoon" - see THEME_CATALOG label. Genuine drops (see the
    // 'raindrop' shape below), not thin streak lines, plus windy=true
    // for a horizontal gust sway during the ambient loop. Cathedral
    // Static below uses the EXACT same size/speed/angle/driftX so the
    // two themes' rain reads as the same rain - only color/count/glow
    // (the vibe, not the rain itself) differ.
    shape: 'raindrop', count: 55, colors: ['rgba(78,232,224,.85)', 'rgba(168,255,245,.8)'],
    size: [7, 12], speed: [7, 12], direction: 'down', spawn: 'top',
    driftX: 0.7, sway: 0, life: [8, 16], opacity: 0.85, glow: 0, angle: [0.6, 7],
    windy: true,
  },
  vault_gold_leaf_requiem: {
    shape: 'diamond', count: 22, colors: ['#e8c559', '#fff0c2'],
    size: [3, 5], speed: [0.3, 0.7], direction: 'down', spawn: 'top',
    driftX: 0.5, sway: 0.6, life: [12, 20], opacity: 0.6, glow: 6, spin: true,
  },
  vault_cathedral_static: {
    // Same rain shape/physics as Monsoon above (per spec: "those 2
    // themes should differ through everything else other than the
    // rain") - only the color and a touch less density differ, since
    // Cathedral Static's drama comes from its lightning flashes instead.
    shape: 'raindrop', count: 40, colors: ['rgba(191,230,255,.85)'],
    size: [7, 12], speed: [7, 12], direction: 'down', spawn: 'top',
    driftX: 0.7, sway: 0, life: [8, 16], opacity: 0.7, glow: 0, angle: [0.6, 7],
    windy: true,
  },
  vault_paper_lantern_sea: {
    shape: 'dot', count: 16, colors: ['#ff8a4e', '#ffd39a'],
    size: [5, 9], speed: [0.05, 0.15], direction: 'up', spawn: 'bottom',
    driftX: 0.4, sway: 1.3, life: [16, 26], opacity: 0.6, glow: 16,
  },
  vault_bioluminal_reef: {
    shape: 'dot', count: 45, colors: ['#2effd1', '#9dffef'],
    size: [1.5, 4], speed: [0.05, 0.14], direction: 'drift', spawn: 'random',
    driftX: 0.25, sway: 1.5, life: [10, 18], opacity: 0.8, glow: 11,
  },
  vault_last_ember_kingdom: {
    shape: 'dot', count: 20, colors: ['#ffe0a8', '#ffb14e', '#cc3a1f'],
    size: [2, 4], speed: [0.4, 0.9], direction: 'up', spawn: 'bottom',
    driftX: 0.7, sway: 1.8, life: [9, 16], opacity: 0.85, glow: 12,
  },
  sunset: {
    shape: 'dot', count: 18, colors: ['#ff7849', '#ffb347'],
    size: [1.5, 3], speed: [0.1, 0.25], direction: 'up', spawn: 'bottom',
    driftX: 0.2, sway: 0.5, life: [10, 16], opacity: 0.45, glow: 5,
  },
  ocean: {
    shape: 'bubble', count: 26, colors: ['rgba(255,255,255,.55)', 'rgba(180,255,250,.45)', 'rgba(95,224,227,.5)'],
    size: [2, 7], speed: [0.15, 0.42], direction: 'up', spawn: 'bottom',
    driftX: 0.15, sway: 1.0, life: [7, 15], opacity: 0.55, glow: 3,
  },
  mono: {
    shape: 'dot', count: 18, colors: ['#1a1a1a', '#444444'],
    size: [1, 2.4], speed: [0.1, 0.25], direction: 'down', spawn: 'top',
    driftX: 0.1, sway: 0.2, life: [8, 14], opacity: 0.5, glow: 2,
  },
  candy: {
    shape: 'dot', count: 20, colors: ['#ff4fc3', '#7bd6ff', '#ffd54f'],
    size: [2, 4], speed: [0.1, 0.3], direction: 'up', spawn: 'bottom',
    driftX: 0.4, sway: 1.0, life: [8, 14], opacity: 0.55, glow: 6,
  },
  aurora: {
    shape: 'dot', count: 30, colors: ['#45e8c4', '#7c5cff', '#45c4e8'],
    size: [1, 3], speed: [0.05, 0.15], direction: 'drift', spawn: 'random',
    driftX: 0.2, sway: 1.2, life: [14, 22], opacity: 0.6, glow: 8,
  },
  velvet: {
    shape: 'diamond', count: 18, colors: ['#d946a8', '#f0729e'],
    size: [2, 4], speed: [0.2, 0.45], direction: 'down', spawn: 'top',
    driftX: 0.3, sway: 0.5, life: [9, 15], opacity: 0.5, glow: 5, spin: true,
  },
  obsidian: {
    shape: 'dot', count: 16, colors: ['#8fd9d9', '#c9e8e8'],
    size: [1, 2], speed: [0.04, 0.1], direction: 'drift', spawn: 'random',
    driftX: 0.1, sway: 0.8, life: [14, 20], opacity: 0.4, glow: 5,
  },
};

// ── Shared mouse tracking + Starfall's scroll "camera" ──
// Used by ThemeGridFX (Rose Gold/Cyberpunk/Copperline's hover
// highlight) and by ThemeFX's scrollParallax particles (Starfall).
let _themeMouseX = -9999, _themeMouseY = -9999;
window.addEventListener('mousemove', (e) => { _themeMouseX = e.clientX; _themeMouseY = e.clientY; });

// themeCameraOffsetY is the smoothed value actually used to draw with -
// it eases toward themeCameraOffsetYTarget by a little every animation
// frame (see ThemeFX's tick()), which is what makes scrolling feel like
// a real smooth pan instead of jumping by whatever raw amount each
// individual wheel event reports. themeCameraMaxOffset is a real upper
// bound (set from Starfall's worldHeightMultiplier - see ThemeFX's
// resize()) - scrolling stops at the top/bottom of that fixed range
// rather than wrapping back around like a looping record.
let themeCameraOffsetY = 0;
let themeCameraOffsetYTarget = 0;
let themeCameraMaxOffset = 0;
window.addEventListener('wheel', (e) => {
  if (document.documentElement.getAttribute('data-theme') === 'starfall') {
    themeCameraOffsetYTarget = Math.max(0, Math.min(themeCameraMaxOffset, themeCameraOffsetYTarget + e.deltaY * 0.5));
  }
}, { passive: true });

const ThemeFX = (() => {
  let canvas = null, ctx = null, raf = null, particles = [], cfg = null, w = 0, h = 0;
  let windPhase = 0;
  let shootingStars = [], shootingStarTimer = null;

  function resize() {
    if (!canvas) return;
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
    if (cfg && cfg.scrollParallax) {
      const worldHeight = h * (cfg.worldHeightMultiplier || 1.6);
      themeCameraMaxOffset = Math.max(0, worldHeight - h);
      themeCameraOffsetYTarget = Math.max(0, Math.min(themeCameraMaxOffset, themeCameraOffsetYTarget));
      themeCameraOffsetY = Math.max(0, Math.min(themeCameraMaxOffset, themeCameraOffsetY));
    }
  }

  function rand(min, max) { return min + Math.random() * (max - min); }

  function spawnParticle() {
    let y;
    if (cfg.spawn === 'top') y = -20;
    else if (cfg.spawn === 'bottom') y = h + 20;
    else if (cfg.scrollParallax) y = Math.random() * (h * (cfg.worldHeightMultiplier || 1.6));
    else y = Math.random() * h;
    const speed = rand(cfg.speed[0], cfg.speed[1]);
    let vy = 0;
    if (cfg.direction === 'down') vy = speed;
    else if (cfg.direction === 'up') vy = -speed;
    else vy = (Math.random() - 0.5) * speed;
    return {
      x: Math.random() * w, y, vy,
      vx: (Math.random() - 0.5) * (cfg.driftX || 0.2),
      size: rand(cfg.size[0], cfg.size[1]),
      age: 0, maxAge: rand(cfg.life[0], cfg.life[1]) * 60,
      sway: Math.random() * Math.PI * 2, swaySpeed: rand(0.3, 1),
      color: cfg.colors[Math.floor(Math.random() * cfg.colors.length)],
      rot: Math.random() * Math.PI * 2,
      gustSeed: Math.random() * Math.PI * 2,
    };
  }

  function draw(p) {
    let a;
    if (cfg.flicker) {
      a = Math.random() < 0.012 ? cfg.opacity : 0;
    } else {
      const fadeIn = Math.min(1, p.age / 40);
      const fadeOut = Math.min(1, (p.maxAge - p.age) / 40);
      a = Math.max(0, Math.min(fadeIn, fadeOut)) * cfg.opacity;
    }
    if (a <= 0.01) return;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = p.color;
    ctx.strokeStyle = p.color;
    if (cfg.glow) { ctx.shadowColor = p.color; ctx.shadowBlur = cfg.glow; }
    if (cfg.shape === 'diamond') {
      ctx.translate(p.x, p.y);
      if (cfg.spin) ctx.rotate(p.rot);
      ctx.beginPath();
      ctx.moveTo(0, -p.size); ctx.lineTo(p.size, 0); ctx.lineTo(0, p.size); ctx.lineTo(-p.size, 0);
      ctx.closePath(); ctx.fill();
    } else if (cfg.shape === 'streak') {
      const ang = cfg.angle || [1, 6];
      ctx.lineWidth = Math.max(1.5, p.size * 0.35);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - ang[0] * p.size, p.y - ang[1] * p.size);
      ctx.stroke();
    } else if (cfg.shape === 'raindrop') {
      // A genuine drop: an elongated teardrop body with a small
      // off-center highlight (light refracting through the water) plus
      // a faint motion-blur tail behind it - reads as real falling
      // water instead of a flat streak line at any size.
      const ang = cfg.angle || [0.6, 7];
      const trailLen = p.size * 2.6;
      const dirAng = Math.atan2(ang[1], ang[0]);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(dirAng);
      const grad = ctx.createLinearGradient(-trailLen, 0, -p.size * 0.4, 0);
      grad.addColorStop(0, 'rgba(255,255,255,0)');
      grad.addColorStop(1, p.color);
      ctx.strokeStyle = grad;
      ctx.lineWidth = Math.max(1, p.size * 0.16);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-trailLen, 0);
      ctx.lineTo(-p.size * 0.4, 0);
      ctx.stroke();
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.ellipse(0, 0, p.size * 0.3, p.size * 0.48, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = a * 0.6;
      ctx.fillStyle = 'rgba(255,255,255,.8)';
      ctx.beginPath();
      ctx.ellipse(-p.size * 0.08, -p.size * 0.1, p.size * 0.08, p.size * 0.14, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else if (cfg.shape === 'flare') {
      // A miniature corona: a full ring of light with a dark disc at
      // its center - the earlier open-arc version read as "half lit"
      // rather than light fully surrounding a dark circle, which is
      // what a real corona looks like.
      ctx.lineWidth = Math.max(1, p.size * 0.2);
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.stroke();
      ctx.save();
      ctx.globalAlpha = a * 0.85;
      ctx.fillStyle = 'rgba(4,4,8,.6)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * 0.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else if (cfg.shape === 'bubble') {
      // A real bubble reads as a thin ring with a small off-center
      // catch-light, not a filled dot - a filled dot is what made the
      // old Ocean effect look like generic floating specks rather than
      // something actually submerged.
      ctx.lineWidth = Math.max(0.6, p.size * 0.16);
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.globalAlpha = a * 0.85;
      ctx.arc(p.x - p.size * 0.35, p.y - p.size * 0.35, Math.max(0.5, p.size * 0.22), 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function tick() {
    if (!ctx || !cfg) return;
    ctx.clearRect(0, 0, w, h);
    windPhase += 0.006;
    if (cfg.scrollParallax) {
      // Ease the drawn offset toward the wheel-driven target a little
      // each frame - this is what makes scrolling read as one smooth
      // continuous pan instead of jumping by whatever raw amount a
      // single wheel event reported.
      themeCameraOffsetY += (themeCameraOffsetYTarget - themeCameraOffsetY) * 0.08;
    }
    while (particles.length < cfg.count) particles.push(spawnParticle());
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      p.age++;
      p.sway += 0.02 * p.swaySpeed;
      p.x += p.vx + Math.sin(p.sway) * (cfg.sway || 0);
      p.y += p.vy;
      if (cfg.windy) {
        // A slow, shared gust rather than per-particle noise - every
        // drop leans the same way at the same moment, which is what
        // actually reads as "wind" instead of just jitter.
        p.x += Math.sin(windPhase + p.gustSeed) * 1.4;
      }
      if (cfg.rotateSlow) p.rot += 0.006;
      let drawY = p.y;
      let outOfBounds;
      if (cfg.scrollParallax) {
        // Real bounded panning, no looping: the particle's world-space
        // y already spans the whole scrollable range (see
        // spawnParticle), so drawing is just "world position minus
        // camera" - no wraparound needed. Recycling only cares about
        // horizontal bounds and age; a star scrolled out of the
        // current viewport is still valid world content, not "gone".
        drawY = p.y - themeCameraOffsetY;
        outOfBounds = p.x < -60 || p.x > w + 60;
      } else {
        outOfBounds = p.x < -60 || p.x > w + 60 || p.y < -60 || p.y > h + 60;
      }
      draw({ ...p, y: drawY });
      if (p.age >= p.maxAge || outOfBounds) {
        particles[i] = spawnParticle();
      }
    }

    if (cfg.shootingStar) {
      for (let i = shootingStars.length - 1; i >= 0; i--) {
        const s = shootingStars[i];
        s.life++;
        s.x += s.vx; s.y += s.vy;
        const fadeIn = Math.min(1, s.life / 6);
        const fadeOut = Math.max(0, 1 - Math.max(0, s.life - s.maxLife * 0.7) / (s.maxLife * 0.3));
        const alpha = fadeIn * fadeOut;
        if (alpha > 0.01) {
          const tailLen = 130;
          const ang = Math.atan2(s.vy, s.vx);
          ctx.save();
          ctx.translate(s.x, s.y);
          ctx.rotate(ang);
          const grad = ctx.createLinearGradient(-tailLen, 0, 0, 0);
          grad.addColorStop(0, 'rgba(255,255,255,0)');
          grad.addColorStop(1, `rgba(255,255,255,${alpha})`);
          ctx.strokeStyle = grad;
          ctx.lineWidth = 2;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(-tailLen, 0);
          ctx.lineTo(0, 0);
          ctx.stroke();
          ctx.fillStyle = `rgba(255,255,255,${alpha})`;
          ctx.shadowColor = '#fff'; ctx.shadowBlur = 12;
          ctx.beginPath();
          ctx.arc(0, 0, 1.8, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
        if (s.life >= s.maxLife || s.x > w + 150 || s.y > h + 150) shootingStars.splice(i, 1);
      }
    }
    raf = requestAnimationFrame(tick);
  }

  // ── Shooting star (Starfall only) ──
  // Drop your own clip at SHOOTING_STAR_AUDIO_PATH (declared near the
  // top of this file, alongside the other audio engines) - missing is
  // completely fine, it just plays silently/not at all.
  function scheduleShootingStar() {
    if (!cfg || !cfg.shootingStar) return;
    const [lo, hi] = cfg.shootingStarInterval || [18000, 42000];
    shootingStarTimer = setTimeout(() => {
      spawnShootingStar();
      scheduleShootingStar();
    }, rand(lo, hi));
  }

  function spawnShootingStar() {
    if (!w || !h) return;
    shootingStars.push({
      x: rand(w * 0.05, w * 0.65), y: rand(-20, h * 0.35),
      vx: rand(9, 14), vy: rand(4, 7),
      life: 0, maxLife: rand(35, 55),
    });
    try {
      shootingStarAudio.currentTime = 0;
      shootingStarAudio.play().catch(() => {});
    } catch (e) { /* no audio file yet - silent, non-fatal */ }
  }

  function start(config) {
    stop();
    canvas = document.getElementById('themeFxCanvas');
    if (!canvas) return;
    ctx = canvas.getContext('2d');
    cfg = config;
    resize();
    canvas.classList.remove('hidden');
    particles = [];
    shootingStars = [];
    if (cfg.shootingStar) scheduleShootingStar();
    raf = requestAnimationFrame(tick);
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    if (shootingStarTimer) clearTimeout(shootingStarTimer);
    shootingStarTimer = null;
    shootingStars = [];
    cfg = null;
    particles = [];
    if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (canvas) canvas.classList.add('hidden');
  }

  window.addEventListener('resize', () => { if (canvas) resize(); });

  return { start, stop };
})();

// ── Theme Grid Engine (Rose Gold / Cyberpunk / Copperline) ──
// A second canvas-drawn system, mutually exclusive per-theme with
// ThemeFX's particle engine above (see applyThemeVisuals). Instead of
// floating particles, these three themes get a low-opacity network of
// lines drawn across the viewport that slowly breathes/pulses, plus a
// localized brightening wherever the mouse currently sits. 'crystal'
// style (Rose Gold) jitters a point grid and links neighbors (plus an
// occasional diagonal) into an irregular triangulated-looking web.
// 'circuit' style (Cyberpunk/Copperline) is a RADIAL motherboard/chip
// layout centered on the viewport - a central chip core surrounded by
// many symmetric branch traces reaching outward with small offshoot
// stubs, matching a real circuit-board diagram rather than a grid with
// some lines missing. Cyberpunk/Copperline also get a central
// "CULTIVAR" wordmark sitting in the chip core, flickering at random
// intervals like a real neon sign tube.
const THEME_GRID_CONFIGS = {
  rosegold: { style: 'crystal', color: '150,112,116', baseAlpha: 0.07, pulseAlpha: 0.05, pulseSpeed: 0.35, hoverAlpha: 0.4, hoverGlow: 9, hoverRadius: 130 },
  cyberpunk: { style: 'circuit', color: '0,229,255', accentColor: '255,46,136', baseAlpha: 0.16, pulseAlpha: 0.1, pulseSpeed: 0.6, hoverAlpha: 0.9, hoverGlow: 16, hoverRadius: 150, armCount: 18, coreRadiusRatio: 0.1, coreLabel: true },
  copperline: { style: 'circuit', color: '240,150,80', accentColor: '255,200,140', baseAlpha: 0.26, pulseAlpha: 0.12, pulseSpeed: 0.4, hoverAlpha: 0.95, hoverGlow: 14, hoverRadius: 150, armCount: 16, coreRadiusRatio: 0.11, coreLabel: true },
};

const ThemeGridFX = (() => {
  let canvas = null, ctx = null, raf = null, cfg = null, w = 0, h = 0;
  let edges = [], pads = [];
  const GRID_COLS = 20, GRID_ROWS = 20; // crystal style only - circuit is radial, not grid-based
  let labelEl = null, flickerTimer = null;

  function rand(min, max) { return min + Math.random() * (max - min); }

  function buildMesh() {
    edges = []; pads = [];
    if (cfg.style === 'crystal') {
      const colStep = w / GRID_COLS, rowStep = h / GRID_ROWS;
      const jitter = Math.min(colStep, rowStep) * 0.32;
      const grid = [];
      for (let gy = 0; gy <= GRID_ROWS; gy++) {
        const row = [];
        for (let gx = 0; gx <= GRID_COLS; gx++) {
          row.push({ x: gx * colStep + rand(-jitter, jitter), y: gy * rowStep + rand(-jitter, jitter) });
        }
        grid.push(row);
      }
      for (let gy = 0; gy <= GRID_ROWS; gy++) {
        for (let gx = 0; gx <= GRID_COLS; gx++) {
          const n = grid[gy][gx];
          if (gx < GRID_COLS) edges.push([n, grid[gy][gx + 1]]);
          if (gy < GRID_ROWS) edges.push([n, grid[gy + 1][gx]]);
          if (gx < GRID_COLS && gy < GRID_ROWS && Math.random() < 0.32) {
            edges.push([n, Math.random() < 0.5 ? grid[gy + 1][gx + 1] : grid[gy][gx + 1]]);
          }
        }
      }
    } else {
      // 'circuit' - a radial motherboard/chip map: a ring of arms
      // radiate outward from the viewport's center (the chip core),
      // each a short jagged run of 2-4 segments ending in a node, with
      // small offshoot stubs branching off partway - a real circuit
      // diagram's structure, not a grid with some edges missing.
      const cx = w / 2, cy = h / 2;
      const coreRadius = Math.min(w, h) * cfg.coreRadiusRatio;
      const reach = Math.max(w, h) * 0.68;
      const armCount = cfg.armCount || 18;
      for (let i = 0; i < armCount; i++) {
        const baseAngle = (i / armCount) * Math.PI * 2 + rand(-0.06, 0.06);
        let x = cx + Math.cos(baseAngle) * coreRadius;
        let y = cy + Math.sin(baseAngle) * coreRadius;
        let angle = baseAngle;
        pads.push({ x, y });
        const segCount = 2 + Math.floor(rand(0, 3));
        for (let s = 0; s < segCount; s++) {
          const segLen = ((reach - coreRadius) / segCount) * rand(0.75, 1.2);
          const nx = x + Math.cos(angle) * segLen;
          const ny = y + Math.sin(angle) * segLen;
          edges.push([{ x, y }, { x: nx, y: ny }]);
          x = nx; y = ny;
          pads.push({ x, y });
          // A short offshoot stub with its own end node - the
          // secondary branch lines visible in real board diagrams.
          if (Math.random() < 0.55) {
            const stubAngle = angle + (Math.random() < 0.5 ? 1 : -1) * (Math.PI / 2 + rand(-0.2, 0.2));
            const stubLen = segLen * rand(0.3, 0.6);
            const sx = x + Math.cos(stubAngle) * stubLen;
            const sy = y + Math.sin(stubAngle) * stubLen;
            edges.push([{ x, y }, { x: sx, y: sy }]);
            pads.push({ x: sx, y: sy });
          }
          angle += rand(-0.3, 0.3);
        }
      }
    }
  }

  function resize() {
    if (!canvas) return;
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
    buildMesh();
    positionLabel();
  }

  function tick(t) {
    if (!ctx || !cfg) return;
    ctx.clearRect(0, 0, w, h);
    const pulse = cfg.baseAlpha + (Math.sin(t / 1000 * cfg.pulseSpeed) * 0.5 + 0.5) * cfg.pulseAlpha;
    const mouseOnScreen = _themeMouseX >= 0 && _themeMouseX <= w && _themeMouseY >= 0 && _themeMouseY <= h;
    const hoverRadius = cfg.hoverRadius || 130;

    ctx.lineWidth = 1;
    edges.forEach(([a, b]) => {
      const dist = mouseOnScreen ? Math.min(Math.hypot(a.x - _themeMouseX, a.y - _themeMouseY), Math.hypot(b.x - _themeMouseX, b.y - _themeMouseY)) : Infinity;
      const hoverT = Math.max(0, 1 - dist / hoverRadius);
      const alpha = pulse + hoverT * (cfg.hoverAlpha - pulse);
      ctx.strokeStyle = `rgba(${cfg.color},${Math.min(1, alpha)})`;
      ctx.shadowBlur = hoverT > 0.05 ? cfg.hoverGlow * hoverT : 0;
      ctx.shadowColor = `rgba(${cfg.color},.9)`;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    });

    if (cfg.style === 'circuit') {
      pads.forEach(n => {
        const dist = mouseOnScreen ? Math.hypot(n.x - _themeMouseX, n.y - _themeMouseY) : Infinity;
        const hoverT = Math.max(0, 1 - dist / hoverRadius);
        const alpha = pulse + hoverT * (cfg.hoverAlpha - pulse);
        const color = hoverT > 0.4 && cfg.accentColor ? cfg.accentColor : cfg.color;
        ctx.fillStyle = `rgba(${color},${Math.min(1, alpha)})`;
        ctx.shadowColor = ctx.fillStyle;
        ctx.shadowBlur = hoverT > 0.4 ? cfg.hoverGlow : 0;
        ctx.fillRect(n.x - 2, n.y - 2, 4, 4);
      });

      // The chip core's own soft glow behind the CULTIVAR label.
      const cx = w / 2, cy = h / 2;
      const coreRadius = Math.min(w, h) * cfg.coreRadiusRatio;
      const glowPulse = 0.5 + Math.sin(t / 1000 * cfg.pulseSpeed * 0.7) * 0.5;
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreRadius * 1.7);
      grad.addColorStop(0, `rgba(${cfg.color},${0.14 + glowPulse * 0.09})`);
      grad.addColorStop(1, `rgba(${cfg.color},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, coreRadius * 1.7, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
    raf = requestAnimationFrame(tick);
  }

  // ── CULTIVAR neon core label (Cyberpunk/Copperline only) ──
  function positionLabel() {
    if (!labelEl) return;
    const coreRadius = Math.min(w, h) * cfg.coreRadiusRatio;
    labelEl.style.fontSize = `${Math.max(11, coreRadius * 0.42)}px`;
  }

  function ensureLabel() {
    if (labelEl) { positionLabel(); return; }
    labelEl = document.createElement('div');
    labelEl.className = 'circuit-core-label';
    labelEl.textContent = 'CULTIVAR';
    document.body.appendChild(labelEl);
    positionLabel();
    scheduleFlicker();
  }

  function removeLabel() {
    if (flickerTimer) clearTimeout(flickerTimer);
    flickerTimer = null;
    if (labelEl) { labelEl.remove(); labelEl = null; }
  }

  // A real failing neon tube doesn't flicker on a steady beat - random
  // gaps between flickers, an occasional quick double-flicker, and a
  // brief dim (not a full blackout) reads far more like a genuine sign
  // than a repeating CSS keyframe would.
  function scheduleFlicker() {
    if (!labelEl) return;
    flickerTimer = setTimeout(() => {
      if (!labelEl) return;
      labelEl.classList.add('flicker-dim');
      setTimeout(() => {
        if (!labelEl) return;
        labelEl.classList.remove('flicker-dim');
        if (Math.random() < 0.35) {
          setTimeout(() => {
            if (!labelEl) return;
            labelEl.classList.add('flicker-dim');
            setTimeout(() => { if (labelEl) labelEl.classList.remove('flicker-dim'); }, rand(40, 100));
          }, rand(60, 140));
        }
        scheduleFlicker();
      }, rand(50, 170));
    }, rand(1800, 5200));
  }

  function start(config) {
    stop();
    canvas = document.getElementById('themeFxCanvas');
    if (!canvas) return;
    ctx = canvas.getContext('2d');
    cfg = config;
    resize();
    canvas.classList.remove('hidden');
    raf = requestAnimationFrame(tick);
    if (cfg.coreLabel) ensureLabel(); else removeLabel();
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    cfg = null;
    if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (canvas) canvas.classList.add('hidden');
    removeLabel();
  }

  window.addEventListener('resize', () => { if (canvas && cfg) resize(); });

  return { start, stop };
})();

// ── Theme Sprite Engine ──
// Image-based ambient effects, for anything a procedural canvas shape
// can't convincingly stand in for the real thing (falling fruit, foliage, 
// snow, fish, floating flowers). Runs on its OWN canvas (#themeSpriteFxCanvas) 
// independently of ThemeFX/ThemeGridFX above, since a couple of themes run this 
// alongside one of those (e.g. Bioluminal Reef's glow motes + swimming fish together).
//
// Every image file is probed once and cached; a missing file is
// silently skipped (never a broken-image icon, never a console error)
// so a theme with no art dropped in yet just renders nothing until it
// is. Expected location for every filename referenced below:
//   /sprites/themes/effects/<filename>
//
// Config fields:
//   sprites: array of filenames (PNG/WEBP/GIF etc. - anything a plain
//     <img>/drawImage can render; each needs real alpha transparency
//     around its subject, no white/solid background)
//   mode: 'fall' (drifts down, recycles from the top) | 'rise' (drifts
//     up, recycles from the bottom - smoke/embers) | 'swim' (free
//     roaming with velocity, bounces off screen edges and flips to
//     face its new direction) | 'float' (gentle wandering bob, wraps
//     around screen edges instead of recycling)
//   count, size:[min,max] px (applied to the sprite's longer side,
//     aspect ratio preserved from the image's real dimensions)
//   speed:[min,max] px/frame, rotate: true/false (slow spin/sway)
//   sway: horizontal wander amplitude
//   opacity: peak alpha
//   mouseReactive: true - 'rise' mode drifts its horizontal position
//     toward the cursor's x (unused now that Coffee's steam is a real
//     simulation - see ThemeSmokeFX below - but kept for any future
//     rise-mode sprite effect)
//   edgeBounce: true - 'swim' mode reflects off edges instead of
//     wrapping, and mirrors the sprite horizontally to face the new
//     direction of travel
//
// species: [...] - an ALTERNATIVE to `sprites` for effects that need
//   several distinct animated creatures instead of one pool of static
//   images (currently just Bioluminal Reef's fish). Each entry is its
//   own walk-cycle: { frames: [...filenames], fps, count, size:[min,max],
//   speed:[min,max]?, mode?, rotate? }. `count` is exactly how many of
//   that species spawn (NOT a shared pool - every species gets its own
//   guaranteed population); `frames` can be any length (2, 3, 6...) and
//   loops continuously at `fps`. mode/speed/rotate are optional PER-
//   SPECIES overrides of the effect's own top-level defaults, so e.g. a
//   jellyfish species can float while fish species swim, in the same
//   effect. To add a new species: append one more object to the array
//   with its own frame filenames - nothing else in the code needs to
//   change.
const THEME_SPRITE_CONFIGS = {
  autumn: {
    sprites: ['brownleaf1.png', 'brownleaf2.png', 'brownleaf3.png', 'brownleaf4.png', 'brownleaf5.png', 'brownleaf6.png', 'brownleaf7.png', 'brownleaf8.png', 'brownleaf9.png', 'brownleaf10.png', 'brownleaf11.png', 'brownleaf12.png', 'brownleaf13.png', 'brownleaf14.png', 'brownleaf15.png', 'brownleaf16.png', 'brownleaf17.png', 'brownleaf18.png', 'brownleaf19.png', 'brownleaf20.png', 'brownleaf21.png', 'brownleaf22.png', 'brownleaf23.png', 'brownleaf24.png', 'brownleaf25.png', 'brownleaf26.png', 'brownleaf27.png', 'brownleaf28.png', 'brownleaf29.png', 'brownleaf30.png', 'brownleaf31.png', 'brownleaf32.png', 'brownleaf33.png', 'brownleaf34.png', 'brownleaf35.png', 'brownleaf36.png', 'brownleaf37.png', 'brownleaf38.png', 'brownleaf39.png'],
    mode: 'fall', count: 39, size: [16, 34], speed: [0.4, 0.9],
    rotate: true, sway: 1.4, opacity: 0.9,
  },
  orchard: {
    sprites: ['orchardleaf1.png', 'orchardleaf2.png', 'orchardleaf3.png', 'orchardleaf4.png', 'orchardleaf5.png', 'orchardapple1.png', 'orchardapple2.png', 'orchardapple3.png', 'orchardapple4.png'],
    mode: 'fall', count: 14, size: [14, 30], speed: [0.35, 0.8],
    rotate: true, sway: 1.2, opacity: 0.88,
  },
  citrus: {
    sprites: ['orchardleaf1.png', 'orchardleaf2.png', 'orchardleaf3.png', 'orchardleaf4.png', 'orchardleaf5.png', 'citrusfruit1.png', 'citrusfruit2.png'],
    mode: 'fall', count: 12, size: [18, 32], speed: [0.4, 0.85],
    rotate: true, sway: 1.0, opacity: 0.92,
  },
  nord: {
    sprites: ['snowflake1.png', 'snowflake2.png', 'snowflake3.png', 'snowflake4.png', 'snowflake5.png', 'snowflake6.png', 'snowflake7.png', 'snowflake8.png', 'snowflake9.png', 'snowflake10.png', 'snowflake11.png'],
    mode: 'fall', count: 34, size: [6, 15], speed: [0.22, 0.55],
    rotate: true, sway: 0.8, opacity: 0.85,
  },
  vault_permafrost_atrium: {
    sprites: ['snowflake1.png', 'snowflake2.png', 'snowflake3.png', 'snowflake4.png', 'snowflake5.png', 'snowflake6.png', 'snowflake7.png', 'snowflake8.png', 'snowflake9.png', 'snowflake10.png', 'snowflake11.png'],
    mode: 'fall', count: 55, size: [7, 18], speed: [0.3, 0.75],
    rotate: true, sway: 0.9, opacity: 0.92,
  },
  vault_iron_orchid: {
    sprites: ['ironorchid1.png', 'ironorchid2.png', 'ironorchid3.png', 'ironorchid4.png', 'ironorchid5.png', 'ironorchid6.png', 'ironorchid7.png', 'ironorchid8.png'],
    mode: 'float', count: 9, size: [42, 82], speed: [0.05, 0.13],
    rotate: true, sway: 1.6, opacity: 0.85,
  },
  // Bioluminal Reef - every "species" here is a full walk-cycle
  // animation (however many frames you actually have), not a single
  // static picture. The three below are just a starter template with
  // three example species (a small reef fish, a larger anglerfish-type,
  // and a slow-floating jellyfish) - add, remove, resize, or rename
  // any of them freely; nothing else in the code needs to change.
  //
  // UNLIKE every other effect above, this one doesn't show all its
  // fish right away - it starts at ZERO and each one is unlocked with
  // a repeatable Nerds purchase in Inventory's Theme Upgrades card
  // (same place as the video/audio upgrades), one at a time, in the
  // order species are listed here (this species' whole count is filled
  // before moving to the next). See BIOLUMINAL_REEF_TOTAL_FISH right
  // below - it's auto-computed from this array, so adding/removing a
  // species or changing a `count` automatically updates how many times
  // the upgrade can be bought. server.py's THEME_FISH_UNLOCK_TOTALS
  // must be kept in sync with this same total by hand, since the
  // backend can't read this JS file to compute it itself.
  vault_bioluminal_reef: {
    mode: 'swim', edgeBounce: true, opacity: 0.92,
    species: [
      { frames: ['whiteperchswim0.png', 'whiteperchswim1.png', 'whiteperchswim2.png', 'whiteperchswim3.png', 'whiteperchswim4.png', 'whiteperchswim5.png', 'whiteperchswim6.png', 'whiteperchswim7.png', 'whiteperchswim8.png', 'whiteperchswim9.png', 'whiteperchswim10.png', 'whiteperchswim11.png', 'whiteperchswim12.png', 'whiteperchswim13.png', 'whiteperchswim14.png', 'whiteperchswim15.png', 'whiteperchswim16.png'], fps: 12, count: 1, size: [30, 55], speed: [0.35, 0.75] },
      { frames: ['yellowperch0.png', 'yellowperch1.png', 'yellowperch2.png', 'yellowperch3.png', 'yellowperch4.png', 'yellowperch5.png', 'yellowperch6.png', 'yellowperch7.png', 'yellowperch8.png'], fps: 8, count: 1, size: [70, 120], speed: [0.2, 0.4] },
      { frames: ['rainbowtrout0.png', 'rainbowtrout1.png', 'rainbowtrout2.png', 'rainbowtrout3.png', 'rainbowtrout4.png', 'rainbowtrout5.png', 'rainbowtrout6.png', 'rainbowtrout7.png', 'rainbowtrout8.png', 'rainbowtrout9.png', 'rainbowtrout10.png', 'rainbowtrout11.png', 'rainbowtrout12.png', 'rainbowtrout13.png', 'rainbowtrout14.png', 'rainbowtrout15.png', 'rainbowtrout16.png'], fps: 12, count: 1, size: [30, 70], speed: [0.35, 0.75] },
    ],
  },
};

// Auto-computed from the species array above - the single source of
// truth for "how many fish total", so it can never drift out of sync
// with the species list itself the way a hand-typed number could.
const BIOLUMINAL_REEF_TOTAL_FISH = THEME_SPRITE_CONFIGS.vault_bioluminal_reef.species.reduce((sum, def) => sum + (def.count || 1), 0);

// Registry of every theme that unlocks its sprite creatures gradually
// via a repeatable Theme Upgrades purchase, instead of showing them
// all immediately. Extending this to a future theme just means adding
// one more entry here (and a matching one in server.py's
// THEME_FISH_UNLOCK_TOTALS) - the Theme Upgrades UI and the sprite
// engine both already read from this generically.
const THEME_FISH_TOTALS = { vault_bioluminal_reef: BIOLUMINAL_REEF_TOTAL_FISH };

function themeFishUnlockedCount(themeId) {
  const key = `theme_upgrade_${themeId}_fish`;
  return (gamification?.theme_upgrades_owned || []).filter(x => x === key).length;
}

// Given a base sprite config with a `species` array, returns a COPY
// whose species `count`s are trimmed down to only the first
// `unlockedCount` fish, filling each species in listed order before
// moving to the next - species entirely past the unlocked count are
// dropped so the sprite engine never spawns them.
function buildUnlockedSpeciesConfig(baseCfg, unlockedCount) {
  let remaining = Math.max(0, unlockedCount);
  const species = baseCfg.species.map(def => {
    const take = Math.max(0, Math.min(def.count || 1, remaining));
    remaining -= take;
    return { ...def, count: take };
  }).filter(def => def.count > 0);
  return { ...baseCfg, species };
}

const _spriteImageCache = {};
function _loadSpriteImage(path) {
  if (_spriteImageCache[path]) return _spriteImageCache[path];
  const entry = { img: new Image(), loaded: false, failed: false };
  entry.img.onload = () => { entry.loaded = true; };
  entry.img.onerror = () => { entry.failed = true; };
  entry.img.src = path;
  _spriteImageCache[path] = entry;
  return entry;
}

const ThemeSpriteFX = (() => {
  let canvas = null, ctx = null, raf = null, cfg = null, w = 0, h = 0;
  let sprites = [], items = [];

  function resize() {
    if (!canvas) return;
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
  }

  function rand(min, max) { return min + Math.random() * (max - min); }

  function pickSprite() {
    const usable = sprites.filter(s => s.loaded);
    return usable.length ? usable[Math.floor(Math.random() * usable.length)] : null;
  }

  // Shared movement init for both static-sprite items and animated
  // species items - `mode` is passed explicitly since a species entry
  // can override the effect's own top-level mode (e.g. a floating
  // jellyfish species inside an otherwise swim-mode fish effect).
  function initMotion(mode, size, speed) {
    let x, y, vx = 0, vy = 0;
    if (mode === 'fall') {
      x = Math.random() * w; y = -size - rand(0, h);
      vy = speed; vx = (Math.random() - 0.5) * (cfg.sway || 0) * 0.3;
    } else if (mode === 'rise') {
      x = Math.random() * w; y = h + size + rand(0, h * 0.4);
      vy = -speed;
    } else if (mode === 'swim') {
      x = Math.random() * w; y = rand(size, h - size);
      const dir = Math.random() < 0.5 ? 1 : -1;
      vx = dir * speed; vy = (Math.random() - 0.5) * speed * 0.3;
    } else { // float
      x = Math.random() * w; y = Math.random() * h;
      vx = (Math.random() - 0.5) * speed; vy = (Math.random() - 0.5) * speed;
    }
    return { x, y, vx, vy };
  }

  function spawnItem() {
    const size = rand(cfg.size[0], cfg.size[1]);
    const speed = rand(cfg.speed[0], cfg.speed[1]);
    const mode = cfg.mode;
    const rotate = cfg.rotate;
    const { x, y, vx, vy } = initMotion(mode, size, speed);
    return {
      animated: false, sprite: pickSprite(), mode, rotate, x, y, vx, vy, size,
      rot: Math.random() * Math.PI * 2,
      rotSpeed: rotate ? (Math.random() - 0.5) * 0.012 : 0,
      sway: Math.random() * Math.PI * 2, swaySpeed: rand(0.3, 1),
      age: 0, maxAge: rand(600, 1400), facing: vx < 0 ? -1 : 1,
    };
  }

  // A "species" item is identical in every way except it cycles through
  // its own multi-frame walk-cycle (def.frames/def.fps) instead of
  // showing one static picture, and can override mode/size/speed/rotate
  // from the effect's own top-level defaults.
  function spawnSpeciesItem(def) {
    const size = rand((def.size || cfg.size)[0], (def.size || cfg.size)[1]);
    const speed = rand((def.speed || cfg.speed)[0], (def.speed || cfg.speed)[1]);
    const mode = def.mode || cfg.mode;
    const rotate = def.rotate !== undefined ? def.rotate : cfg.rotate;
    const { x, y, vx, vy } = initMotion(mode, size, speed);
    return {
      animated: true, def, frameIdx: Math.floor(Math.random() * def.frames.length), frameTimer: Math.random() * 60,
      mode, rotate, x, y, vx, vy, size,
      rot: Math.random() * Math.PI * 2,
      rotSpeed: rotate ? (Math.random() - 0.5) * 0.012 : 0,
      sway: Math.random() * Math.PI * 2, swaySpeed: rand(0.3, 1),
      age: 0, maxAge: rand(600, 1400), facing: vx < 0 ? -1 : 1,
    };
  }

  function drawItem(p) {
    let img;
    if (p.animated) {
      const entry = p.def.frameImgs[p.frameIdx % p.def.frameImgs.length];
      if (!entry || !entry.loaded) return;
      img = entry.img;
    } else {
      if (!p.sprite || !p.sprite.loaded) return;
      img = p.sprite.img;
    }
    const ratio = (img.naturalHeight / img.naturalWidth) || 1;
    const wPx = p.size, hPx = p.size * ratio;
    let a = cfg.opacity;
    if (p.mode === 'fall' || p.mode === 'rise') {
      // Only fade IN at spawn - no age-based fade-out. That used to cut
      // a leaf/snowflake/fruit off partway down the page once it hit
      // its random maxAge, well before it had actually finished
      // falling through the whole viewport on a tall window. Now it
      // only ever disappears once it's genuinely off-screen (see the
      // recycle check in tick() below).
      a *= Math.min(1, p.age / 60);
    }
    if (a <= 0.01) return;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(p.x, p.y);
    if (p.rotate) ctx.rotate(p.rot);
    ctx.scale(p.facing, 1);
    ctx.drawImage(img, -wPx / 2, -hPx / 2, wPx, hPx);
    ctx.restore();
  }

  function tick() {
    if (!ctx || !cfg) return;
    ctx.clearRect(0, 0, w, h);
    if (cfg.species) {
      if (!items.length) {
        cfg.species.forEach(def => {
          for (let i = 0; i < (def.count || 1); i++) items.push(spawnSpeciesItem(def));
        });
      }
    } else {
      while (items.length < cfg.count) items.push(spawnItem());
    }
    for (let i = 0; i < items.length; i++) {
      const p = items[i];
      p.age++;
      p.sway += 0.02 * p.swaySpeed;
      let recycle = false;
      if (p.mode === 'fall') {
        p.x += p.vx + Math.sin(p.sway) * (cfg.sway || 0) * 0.4;
        p.y += p.vy;
        recycle = p.y > h + 80 || p.x < -100 || p.x > w + 100;
      } else if (p.mode === 'rise') {
        if (cfg.mouseReactive && _themeMouseX >= 0 && _themeMouseX <= w) {
          const targetX = _themeMouseX + Math.sin(p.sway) * 70;
          p.x += (targetX - p.x) * 0.014;
        } else {
          p.x += Math.sin(p.sway) * (cfg.sway || 0) * 0.5;
        }
        p.y += p.vy;
        recycle = p.y < -100;
      } else if (p.mode === 'swim') {
        p.x += p.vx; p.y += p.vy + Math.sin(p.sway) * 0.15;
        if (cfg.edgeBounce) {
          if (p.x < p.size / 2 || p.x > w - p.size / 2) {
            p.vx *= -1; p.facing = p.vx < 0 ? -1 : 1;
            p.x = Math.max(p.size / 2, Math.min(w - p.size / 2, p.x));
          }
          if (p.y < p.size / 2 || p.y > h - p.size / 2) {
            p.vy *= -1;
            p.y = Math.max(p.size / 2, Math.min(h - p.size / 2, p.y));
          }
        }
      } else { // float
        p.x += p.vx + Math.sin(p.sway) * (cfg.sway || 0) * 0.2;
        p.y += p.vy;
        if (p.x < -p.size) p.x = w + p.size;
        if (p.x > w + p.size) p.x = -p.size;
        if (p.y < -p.size) p.y = h + p.size;
        if (p.y > h + p.size) p.y = -p.size;
      }
      if (p.rotate) p.rot += p.rotSpeed;
      if (p.animated) {
        p.frameTimer++;
        const framesPerAdvance = 60 / (p.def.fps || 6);
        if (p.frameTimer >= framesPerAdvance) {
          p.frameTimer = 0;
          p.frameIdx = (p.frameIdx + 1) % p.def.frames.length;
        }
      } else if (!p.sprite) {
        p.sprite = pickSprite();
      }
      drawItem(p);
      if (recycle) items[i] = p.animated ? spawnSpeciesItem(p.def) : spawnItem();
    }
    raf = requestAnimationFrame(tick);
  }

  function start(config) {
    stop();
    canvas = document.getElementById('themeSpriteFxCanvas');
    if (!canvas) return;
    ctx = canvas.getContext('2d');
    cfg = config;
    items = [];
    if (config.species) {
      sprites = [];
      config.species.forEach(def => {
        def.frameImgs = def.frames.map(f => _loadSpriteImage(`/sprites/themes/effects/${f}`));
      });
    } else {
      sprites = config.sprites.map(f => _loadSpriteImage(`/sprites/themes/effects/${f}`));
    }
    resize();
    canvas.classList.remove('hidden');
    raf = requestAnimationFrame(tick);
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = null; cfg = null; items = [];
    if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (canvas) canvas.classList.add('hidden');
  }

  window.addEventListener('resize', () => { if (canvas && cfg) resize(); });

  return { start, stop };
})();

// ── Theme Smoke Engine (Coffee) ──
// A genuinely simulated wisp of rising smoke - no texture files, pure
// canvas. Each "puff" is a small cluster of soft, additively-blended
// radial-gradient blobs (the same trick real canvas smoke demos use,
// since a single blurred circle reads as a blob but several overlapping
// ones drifting at slightly different rates reads as roiling vapor)
// that expands as it rises, drifts sideways via layered sine waves
// standing in for turbulence/noise, and leans toward the cursor within
// a limited radius - the "reacts to the mouse" behavior. Runs on the
// same canvas slot as ThemeFX/ThemeGridFX (mutually exclusive with
// both - see applyThemeVisuals) since Coffee doesn't use either.
const THEME_SMOKE_CONFIGS = {
  coffee: {
    count: 8, size: [70, 170], speed: [0.12, 0.32], opacity: 0.22,
    color: '227,212,190', mouseReactive: true, mouseRadius: 260,
  },
};

const ThemeSmokeFX = (() => {
  let canvas = null, ctx = null, raf = null, cfg = null, w = 0, h = 0;
  let puffs = [];

  function resize() {
    if (!canvas) return;
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
  }

  function rand(min, max) { return min + Math.random() * (max - min); }

  function spawnPuff() {
    return {
      x: rand(w * 0.25, w * 0.75), y: h + rand(10, 70),
      size: rand(cfg.size[0], cfg.size[1]),
      speed: rand(cfg.speed[0], cfg.speed[1]),
      seed: Math.random() * 1000,
      age: 0, maxAge: rand(500, 950),
      // 4 overlapping blobs per puff, each with its own small offset
      // and phase, so the cluster roils rather than moving as one
      // rigid shape.
      blobs: Array.from({ length: 4 }, () => ({
        ox: rand(-16, 16), oy: rand(-12, 12), rMul: rand(0.55, 1), phase: Math.random() * Math.PI * 2,
      })),
    };
  }

  // Cheap layered-sine "noise" - three sine waves at different
  // frequencies/phases summed together reads as organic wander without
  // needing a real Perlin/simplex noise implementation.
  function pseudoNoise(seed, t) {
    return Math.sin(t * 0.6 + seed) * 0.6 + Math.sin(t * 1.6 + seed * 1.4) * 0.3 + Math.sin(t * 3.3 + seed * 0.7) * 0.15;
  }

  function tick() {
    if (!ctx || !cfg) return;
    ctx.clearRect(0, 0, w, h);
    while (puffs.length < cfg.count) puffs.push(spawnPuff());
    const tGlobal = performance.now() / 1000;
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < puffs.length; i++) {
      const p = puffs[i];
      p.age++;
      const lifeT = p.age / p.maxAge;
      p.y -= p.speed;
      const turbulence = pseudoNoise(p.seed, tGlobal * 0.5) * 26;
      let targetX = p.x;
      if (cfg.mouseReactive && _themeMouseX >= 0 && _themeMouseX <= w) {
        const dist = Math.abs(_themeMouseX - p.x);
        const pull = Math.max(0, 1 - dist / (cfg.mouseRadius || 260));
        targetX = p.x + (_themeMouseX - p.x) * pull * 0.018;
      }
      p.x = targetX + turbulence;
      // Real smoke expands as it rises and cools/disperses - grow from
      // a tight wisp into a wider cloud over its lifetime.
      const sizeNow = p.size * (0.35 + Math.min(1, lifeT * 1.8) * 1.0);
      const fadeIn = Math.min(1, p.age / 45);
      const fadeOut = Math.max(0, 1 - Math.max(0, lifeT - 0.55) / 0.45);
      const alpha = cfg.opacity * fadeIn * fadeOut;
      if (alpha > 0.006) {
        p.blobs.forEach(b => {
          const bx = p.x + b.ox * (0.7 + lifeT * 1.3) + Math.sin(tGlobal * 0.8 + b.phase) * 7;
          const by = p.y + b.oy * (0.7 + lifeT * 1.3);
          const r = sizeNow * b.rMul;
          if (r <= 0) return;
          const grad = ctx.createRadialGradient(bx, by, 0, bx, by, r);
          grad.addColorStop(0, `rgba(${cfg.color},${alpha})`);
          grad.addColorStop(1, `rgba(${cfg.color},0)`);
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(bx, by, r, 0, Math.PI * 2);
          ctx.fill();
        });
      }
      if (p.age >= p.maxAge || p.y < -sizeNow - 60) puffs[i] = spawnPuff();
    }
    ctx.globalCompositeOperation = 'source-over';
    raf = requestAnimationFrame(tick);
  }

  function start(config) {
    stop();
    canvas = document.getElementById('themeFxCanvas');
    if (!canvas) return;
    ctx = canvas.getContext('2d');
    cfg = config;
    puffs = [];
    resize();
    canvas.classList.remove('hidden');
    raf = requestAnimationFrame(tick);
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = null; cfg = null; puffs = [];
    if (ctx && canvas) { ctx.globalCompositeOperation = 'source-over'; ctx.clearRect(0, 0, canvas.width, canvas.height); }
    if (canvas) canvas.classList.add('hidden');
  }

  window.addEventListener('resize', () => { if (canvas && cfg) resize(); });

  return { start, stop };
})();

// motion pattern on navigate(), not the same sweep recolored. Themes
// not listed here fall back to the plain CSS sweep (see
// playPageTransitionSweep) - matching the free/early tier staying
// visually plain on purpose. Colors are pulled straight from that
// theme's own THEME_PARTICLE_CONFIGS entry, so a transition always
// matches its ambient particles without needing its own color list.
//
// To add a transition for a theme not listed here, add a line to
// THEME_TRANSITION_STYLES pointing at one of the style names below. To
// add a brand new STYLE (not just reuse one), add a case to
// buildTransitionParticles() and drawTransitionFrame().
const THEME_TRANSITION_STYLES = {
  vault_permafrost_atrium: 'permafrostChill', nord: 'frost',
  wisteria_dream: 'gust', citrus: 'gust', orchard: 'gust', autumn: 'gust',
  vault_gold_leaf_requiem: 'gust', velvet: 'silkRibbon', coffee: 'ripple',
  phoenix_ember: 'emberBurst', vault_last_ember_kingdom: 'emberBurst',
  vault_cathedral_static: 'lightning',
  cyberpunk: 'circuit', copperline: 'circuit',
  starfall: 'comet',
  vault_glass_monsoon: 'rainWipe',
  vault_iron_orchid: 'shine',
  obsidian: 'glassCrack', mono: 'inkBlot',
  vault_bioluminal_reef: 'ripple', ocean: 'ripple',
  vault_eclipse_court: 'eclipse',
  vault_marrow_garden: 'veinPulse',
  gilded_bloom: 'sparkleBurst', rosegold: 'sparkleBurst', candy: 'bubblePop',
  vault_paper_lantern_sea: 'lanternRise',
  aurora: 'auroraWave', sunset: 'auroraWave',
  void_bloom: 'voidWarp',
};
const TRANSITION_DURATION_MS = {
  frost: 1000, gust: 1300, emberBurst: 900, lightning: 550, circuit: 800,
  comet: 800, rainWipe: 750, shine: 800, ripple: 900, shadowWipe: 800,
  sparkleBurst: 850, lanternRise: 1000, steamRise: 1200, auroraWave: 900,
  bubblePop: 900, voidWarp: 900, veinPulse: 800, silkRibbon: 950,
  inkBlot: 900, glassCrack: 750, eclipse: 1150, permafrostChill: 1350,
};

// Most styles used to fade with a plain sin(t*PI) curve, which peaks
// briefly around the midpoint and is already fading before a particle
// has traveled far. This holds full opacity through the middle of the
// animation and only eases out gently near the end, so an effect is
// actually visible crossing the screen instead of disappearing early.
function _transitionFade(t) {
  const inEnd = 0.16, outStart = 0.68;
  if (t < inEnd) return t / inEnd;
  if (t > outStart) return Math.max(0, 1 - (t - outStart) / (1 - outStart));
  return 1;
}

function _hexToRgba(hex, alpha) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
  if (!m) return hex || `rgba(255,255,255,${alpha})`;
  const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function buildTransitionParticles(style, colors, w, h, opts) {
  const c = colors && colors.length ? colors : ['#ffffff'];
  const pick = () => c[Math.floor(Math.random() * c.length)];
  const items = [];
  if (style === 'frost') {
    for (let i = 0; i < 10; i++) {
      let x = Math.random() * w * 0.7, y = Math.random() * h, ang = Math.random() * Math.PI * 2;
      const pts = [[x, y]];
      for (let s = 0; s < 4; s++) {
        ang += (Math.random() - 0.5) * 1.3;
        const len = 16 + Math.random() * 26;
        x += Math.cos(ang) * len; y += Math.sin(ang) * len;
        pts.push([x, y]);
      }
      items.push({ crackPts: pts });
    }
    for (let i = 0; i < 45; i++) items.push({ x: Math.random() * w, y: Math.random() * h, size: 1 + Math.random() * 2 });
  } else if (style === 'gust') {
    for (let i = 0; i < 40; i++) items.push({ x: -40 - Math.random() * w * 0.5, y: Math.random() * h, vx: 14 + Math.random() * 10, vy: (Math.random() - 0.5) * 3, size: 3 + Math.random() * 5, rot: Math.random() * Math.PI * 2, spin: (Math.random() - 0.5) * 0.3, color: pick() });
  } else if (style === 'emberBurst') {
    const cx = w / 2, cy = h / 2;
    for (let i = 0; i < 60; i++) { const a = Math.random() * Math.PI * 2, sp = 4 + Math.random() * 10; items.push({ x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, size: 1.5 + Math.random() * 3, color: pick() }); }
  } else if (style === 'lightning') {
    for (let i = 0; i < 3; i++) {
      const x0 = Math.random() * w, pts = [[x0, 0]];
      let y = 0;
      while (y < h) { y += 30 + Math.random() * 50; pts.push([pts[pts.length - 1][0] + (Math.random() - 0.5) * 70, y]); }
      items.push({ pts, color: pick() });
    }
  } else if (style === 'circuit') {
    const cx = w / 2, cy = h / 2;
    const dirs = [0, 45, 90, 135, 180, 225, 270, 315];
    for (let i = 0; i < 12; i++) {
      let ang = dirs[i % dirs.length] * Math.PI / 180;
      let x = cx, y = cy;
      const pts = [[x, y]];
      const segCount = 2 + Math.floor(Math.random() * 3);
      for (let s = 0; s < segCount; s++) {
        const len = 45 + Math.random() * 100;
        x += Math.cos(ang) * len; y += Math.sin(ang) * len;
        pts.push([x, y]);
        if (Math.random() < 0.55) ang += (Math.random() < 0.5 ? 1 : -1) * (Math.PI / 4);
      }
      items.push({ pts, color: pick() });
    }
  } else if (style === 'comet') {
    for (let i = 0; i < 4; i++) items.push({ x: -80 - Math.random() * 200, y: Math.random() * h * 0.7, vx: 22 + Math.random() * 12, vy: 6 + Math.random() * 6, len: 60 + Math.random() * 60, color: pick() });
  } else if (style === 'rainWipe') {
    for (let i = 0; i < 100; i++) items.push({ x: Math.random() * (w + 300) - 150, y: -30 - Math.random() * h, vy: 10 + Math.random() * 8, len: 18 + Math.random() * 28, lw: 1 + Math.random() * 1.8, flicker: Math.random(), color: pick() });
    // Wind-blown scatter debris - thin fast dashes flying nearly
    // horizontally across the screen, crossing the vertical rain at a
    // shallow angle so the whole scene reads as genuinely windy rather
    // than rain falling straight down in still air.
    for (let i = 0; i < 22; i++) {
      items.push({
        debris: true, x: -60 - Math.random() * 200, y: Math.random() * h,
        vx: 16 + Math.random() * 14, vy: -1.5 + Math.random() * 3,
        len: 8 + Math.random() * 16, color: pick(),
      });
    }
  } else if (style === 'shine') {
    items.push({ color: pick() });
  } else if (style === 'ripple') {
    items.push({ cx: w / 2, cy: h / 2, color: pick() });
  } else if (style === 'shadowWipe') {
    items.push({ color: pick() });
  } else if (style === 'sparkleBurst') {
    const cx = w / 2, cy = h / 2;
    for (let i = 0; i < 45; i++) { const a = Math.random() * Math.PI * 2, dist = 40 + Math.random() * Math.max(w, h) * 0.45; items.push({ x: cx, y: cy, tx: cx + Math.cos(a) * dist, ty: cy + Math.sin(a) * dist, size: 1 + Math.random() * 2.5, color: pick() }); }
  } else if (style === 'lanternRise') {
    for (let i = 0; i < 10; i++) items.push({ x: Math.random() * w, size: 8 + Math.random() * 10, sway: Math.random() * Math.PI * 2, delay: Math.random() * 0.3, color: pick() });
  } else if (style === 'steamRise') {
    for (let i = 0; i < 8; i++) items.push({ x: w * 0.5 + (Math.random() - 0.5) * w * 0.6, seed: Math.random() * 10, color: pick() });
  } else if (style === 'auroraWave') {
    for (let i = 0; i < 3; i++) items.push({ phase: Math.random() * Math.PI * 2, yBase: h * (0.2 + i * 0.25), color: pick() });
  } else if (style === 'bubblePop') {
    for (let i = 0; i < 26; i++) items.push({ x: Math.random() * w, y: h + 20 + Math.random() * 100, size: 4 + Math.random() * 8, popAt: 0.4 + Math.random() * 0.5, color: pick() });
  } else if (style === 'voidWarp') {
    for (let i = 0; i < 50; i++) { const a = Math.random() * Math.PI * 2, r = 60 + Math.random() * Math.max(w, h) * 0.5; items.push({ a, r, speed: 3 + Math.random() * 4, color: pick() }); }
  } else if (style === 'veinPulse') {
    const cx = w / 2, cy = h / 2;
    for (let i = 0; i < 14; i++) {
      let ang = Math.random() * Math.PI * 2, x = cx, y = cy;
      const pts = [[x, y]];
      const segs = 3 + Math.floor(Math.random() * 3);
      for (let s = 0; s < segs; s++) {
        ang += (Math.random() - 0.5) * 1.0;
        const len = 30 + Math.random() * 70;
        x += Math.cos(ang) * len; y += Math.sin(ang) * len;
        pts.push([x, y]);
      }
      items.push({ pts, color: pick() });
    }
  } else if (style === 'silkRibbon') {
    for (let i = 0; i < 3; i++) items.push({ yBase: h * (0.25 + i * 0.25), phase: Math.random() * Math.PI * 2, color: pick() });
  } else if (style === 'glassCrack') {
    const cx = (opts && opts.origin) ? opts.origin.x : w * (0.3 + Math.random() * 0.4);
    const cy = (opts && opts.origin) ? opts.origin.y : h * (0.3 + Math.random() * 0.4);
    for (let i = 0; i < 9; i++) {
      const ang = (i / 9) * Math.PI * 2 + (Math.random() - 0.5) * 0.3;
      const len = 80 + Math.random() * 180;
      const bendAng = ang + (Math.random() - 0.5) * 0.4;
      items.push({
        pts: [[cx, cy], [cx + Math.cos(ang) * len * 0.5, cy + Math.sin(ang) * len * 0.5], [cx + Math.cos(bendAng) * len, cy + Math.sin(bendAng) * len]],
        color: pick(),
      });
    }
  } else if (style === 'inkBlot') {
    items.push({ cx: w / 2, cy: h / 2, color: pick() });
  } else if (style === 'permafrostChill') {
    const flakeFiles = ['snowflake1.png', 'snowflake2.png', 'snowflake3.png', 'snowflake4.png', 'snowflake5.png', 'snowflake6.png', 'snowflake7.png', 'snowflake8.png', 'snowflake9.png', 'snowflake10.png', 'snowflake11.png'];
    const flakeSprites = flakeFiles.map(f => _loadSpriteImage(`/sprites/themes/effects/${f}`));
    for (let i = 0; i < 34; i++) {
      items.push({
        flake: true, x: Math.random() * w * 1.2 - w * 0.1, y: -20 - Math.random() * h * 0.6,
        vx: -1.5 + Math.random() * 3, vy: 2 + Math.random() * 3,
        size: 10 + Math.random() * 22, rot: Math.random() * Math.PI * 2, rotSpeed: (Math.random() - 0.5) * 0.05,
        sprite: flakeSprites[Math.floor(Math.random() * flakeSprites.length)],
      });
    }
    for (let i = 0; i < 4; i++) items.push({ fog: true, yBase: h * (0.15 + i * 0.22), phase: Math.random() * Math.PI * 2 });
  }
  return items;
}

function drawTransitionFrame(style, items, t, ctx, w, h, colors) {
  const c = colors && colors.length ? colors : ['#ffffff'];
  if (style === 'frost') {
    const edgeX = -80 + t * (w + 160);
    const wall = c[0], edge = c[1] || c[0], bright = c[2] || '#eaf7ff';
    ctx.save();
    const grad = ctx.createLinearGradient(0, 0, edgeX, 0);
    grad.addColorStop(0, _hexToRgba(edge, 0.06));
    grad.addColorStop(0.75, _hexToRgba(wall, 0.3));
    grad.addColorStop(1, _hexToRgba(bright, 0.55));
    ctx.globalAlpha = _transitionFade(t) * 0.95;
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, Math.max(0, edgeX), h);
    ctx.restore();
    const spikeCount = 16;
    for (let i = 0; i < spikeCount; i++) {
      const y = (h / spikeCount) * i + (h / spikeCount) * 0.5;
      const len = 22 + ((i * 37) % 42);
      ctx.save();
      ctx.globalAlpha = _transitionFade(t) * 0.9;
      ctx.fillStyle = bright;
      ctx.shadowColor = wall; ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.moveTo(edgeX, y - 7);
      ctx.lineTo(edgeX + len, y);
      ctx.lineTo(edgeX, y + 7);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    items.forEach(s => {
      if (s.crackPts) {
        if (s.crackPts[0][0] > edgeX + 30) return;
        ctx.save();
        ctx.globalAlpha = _transitionFade(t) * 0.65;
        ctx.strokeStyle = bright; ctx.lineWidth = 1.2; ctx.shadowColor = wall; ctx.shadowBlur = 5;
        ctx.beginPath();
        s.crackPts.forEach((p, j) => j ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
        ctx.stroke();
        ctx.restore();
      } else if (s.x <= edgeX + 20) {
        ctx.save();
        ctx.globalAlpha = (Math.random() < 0.5 ? 0.95 : 0.35) * _transitionFade(t);
        ctx.fillStyle = bright; ctx.shadowColor = bright; ctx.shadowBlur = 6;
        ctx.beginPath(); ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
    });
  } else if (style === 'gust') {
    items.forEach(p => {
      p.x += p.vx; p.y += p.vy; p.rot += p.spin;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.globalAlpha = _transitionFade(t) * 0.85; ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.moveTo(0, -p.size); ctx.lineTo(p.size, 0); ctx.lineTo(0, p.size); ctx.lineTo(-p.size, 0); ctx.closePath(); ctx.fill();
      ctx.restore();
    });
  } else if (style === 'emberBurst') {
    items.forEach(p => {
      p.x += p.vx; p.y += p.vy; p.vy += 0.08;
      ctx.save(); ctx.globalAlpha = (1 - t) * 0.9; ctx.fillStyle = p.color;
      ctx.shadowColor = p.color; ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    });
  } else if (style === 'lightning') {
    const flash = t < 0.25 ? 1 - t / 0.25 : 0;
    ctx.save(); ctx.globalAlpha = flash * 0.25; ctx.fillStyle = '#dff2ff'; ctx.fillRect(0, 0, w, h); ctx.restore();
    if (t < 0.4) items.forEach(bolt => {
      ctx.save(); ctx.globalAlpha = (1 - t / 0.4) * 0.9; ctx.strokeStyle = bolt.color; ctx.lineWidth = 2; ctx.shadowColor = bolt.color; ctx.shadowBlur = 12;
      ctx.beginPath(); bolt.pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.stroke(); ctx.restore();
    });
  } else if (style === 'circuit') {
    items.forEach(line => {
      const totalSegs = line.pts.length - 1;
      const revealSegs = t * totalSegs * 1.3;
      ctx.save();
      ctx.strokeStyle = line.color; ctx.lineWidth = 2; ctx.shadowColor = line.color; ctx.shadowBlur = 9;
      ctx.globalAlpha = _transitionFade(Math.min(1, t * 1.3)) * 0.9;
      ctx.beginPath();
      for (let s = 0; s < totalSegs; s++) {
        const segT = Math.max(0, Math.min(1, revealSegs - s));
        if (segT <= 0) break;
        const [x0, y0] = line.pts[s], [x1, y1] = line.pts[s + 1];
        const ex = x0 + (x1 - x0) * segT, ey = y0 + (y1 - y0) * segT;
        if (s === 0) ctx.moveTo(x0, y0);
        ctx.lineTo(ex, ey);
      }
      ctx.stroke();
      const tipSeg = Math.min(totalSegs - 1, Math.floor(revealSegs));
      const tip = line.pts[Math.min(line.pts.length - 1, tipSeg + 1)];
      ctx.beginPath(); ctx.fillStyle = line.color; ctx.arc(tip[0], tip[1], 3, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    });
  } else if (style === 'comet') {
    items.forEach(p => {
      p.x += p.vx; p.y += p.vy;
      ctx.save(); ctx.globalAlpha = _transitionFade(t) * 0.9; ctx.strokeStyle = p.color; ctx.lineWidth = 2.5; ctx.shadowColor = p.color; ctx.shadowBlur = 10;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.len, p.y - p.len * 0.45); ctx.stroke(); ctx.restore();
    });
  } else if (style === 'rainWipe') {
    ctx.save();
    ctx.globalAlpha = _transitionFade(t) * 0.14;
    ctx.fillStyle = c[0] || '#1f9a94';
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
    items.forEach(p => {
      if (p.debris) return;
      p.y += p.vy;
      ctx.save();
      ctx.globalAlpha = _transitionFade(t) * (0.4 + p.flicker * 0.5);
      ctx.strokeStyle = p.color; ctx.lineWidth = p.lw + 0.8; ctx.lineCap = 'round'; ctx.shadowColor = p.color; ctx.shadowBlur = 3;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.lw * 2, p.y + p.len * 0.7); ctx.stroke();
      ctx.restore();
    });
    // Wind-blown scatter debris - fast, nearly-horizontal dashes,
    // deliberately crossing the rain's mostly-vertical fall at a
    // shallow angle so the gust reads clearly against it.
    items.forEach(p => {
      if (!p.debris) return;
      p.x += p.vx; p.y += p.vy;
      ctx.save();
      ctx.globalAlpha = _transitionFade(t) * 0.5;
      ctx.strokeStyle = p.color; ctx.lineWidth = 1.4; ctx.lineCap = 'round';
      ctx.shadowColor = p.color; ctx.shadowBlur = 4;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.len, p.y - p.len * 0.18); ctx.stroke();
      ctx.restore();
    });
  } else if (style === 'shine') {
    const s = items[0];
    const bandX = -w * 0.3 + (w * 1.6) * t;
    const a = _transitionFade(t);
    ctx.save();
    const soft = ctx.createLinearGradient(bandX - 90, 0, bandX + 90, h);
    soft.addColorStop(0, 'rgba(255,255,255,0)'); soft.addColorStop(0.5, _hexToRgba(s.color, 0.22)); soft.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.globalAlpha = a; ctx.fillStyle = soft;
    ctx.translate(bandX, 0); ctx.transform(1, 0, -0.22, 1, 0, 0); ctx.fillRect(-90, -h * 0.2, 180, h * 1.4);
    ctx.restore();
    ctx.save();
    const core = ctx.createLinearGradient(bandX - 14, 0, bandX + 14, h);
    core.addColorStop(0, 'rgba(255,255,255,0)'); core.addColorStop(0.5, _hexToRgba('#ffffff', 0.5)); core.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.globalAlpha = a; ctx.fillStyle = core;
    ctx.translate(bandX, 0); ctx.transform(1, 0, -0.22, 1, 0, 0); ctx.fillRect(-14, -h * 0.2, 28, h * 1.4);
    ctx.restore();
  } else if (style === 'ripple') {
    const s = items[0];
    for (let i = 0; i < 3; i++) {
      const rt = Math.max(0, t - i * 0.12);
      const r = rt * Math.max(w, h) * 0.7;
      ctx.save(); ctx.globalAlpha = Math.max(0, 0.35 - rt * 0.35); ctx.strokeStyle = s.color; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(s.cx, s.cy, r, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    }
  } else if (style === 'shadowWipe') {
    const s = items[0];
    const spread = t * Math.max(w, h) * 0.75;
    ctx.save();
    const grad = ctx.createRadialGradient(w / 2, h / 2, Math.max(0, spread - 60), w / 2, h / 2, spread);
    grad.addColorStop(0, 'rgba(0,0,0,0)'); grad.addColorStop(0.85, _hexToRgba(s.color, 0.28)); grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = _transitionFade(t); ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h);
    ctx.restore();
  } else if (style === 'sparkleBurst') {
    items.forEach(p => {
      const ease = 1 - Math.pow(1 - t, 3);
      const x = p.x + (p.tx - p.x) * ease, y = p.y + (p.ty - p.y) * ease;
      ctx.save(); ctx.globalAlpha = (1 - t) * 0.9; ctx.fillStyle = p.color;
      ctx.shadowColor = p.color; ctx.shadowBlur = 6;
      ctx.beginPath(); ctx.arc(x, y, p.size, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    });
  } else if (style === 'lanternRise') {
    items.forEach(p => {
      const lt = Math.max(0, t - p.delay);
      const y = h + 30 - lt * (h + 60);
      const x = p.x + Math.sin(p.sway + lt * 4) * 18;
      ctx.save(); ctx.globalAlpha = _transitionFade(Math.min(1, lt)) * 0.8; ctx.fillStyle = p.color;
      ctx.shadowColor = p.color; ctx.shadowBlur = 14;
      ctx.beginPath(); ctx.arc(x, y, p.size, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    });
  } else if (style === 'steamRise') {
    // Soft radial-gradient blobs (transparent at the edge) instead of
    // solid-filled circles, so overlapping ones blend into a continuous
    // wisp instead of reading as separate beads.
    items.forEach(s => {
      const steps = 20;
      ctx.save();
      for (let k = 0; k < steps; k++) {
        const kt = k / steps;
        const localT = Math.max(0, t - kt * 0.035);
        const y = h - localT * (h * 0.95) - kt * 6;
        const x = s.x + Math.sin(s.seed + localT * 2 + kt * 0.6) * (8 + kt * 18);
        const r = 10 + kt * 15;
        const a = Math.max(0, 1 - localT) * 0.22 * Math.sin(Math.min(1, localT * 3) * Math.PI / 2);
        if (a <= 0.008) continue;
        const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
        grad.addColorStop(0, _hexToRgba(s.color, a));
        grad.addColorStop(1, _hexToRgba(s.color, 0));
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    });
  } else if (style === 'auroraWave') {
    items.forEach((band, idx) => {
      ctx.save();
      ctx.globalAlpha = _transitionFade(t) * 0.35;
      ctx.strokeStyle = band.color; ctx.lineWidth = 26 + idx * 10; ctx.lineCap = 'round';
      ctx.shadowColor = band.color; ctx.shadowBlur = 20;
      ctx.beginPath();
      for (let x = 0; x <= w; x += 20) {
        const y = band.yBase + Math.sin(x * 0.01 + band.phase + t * 6) * 40;
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
    });
  } else if (style === 'bubblePop') {
    items.forEach(p => {
      if (t < p.popAt) {
        const y = p.y - (t / p.popAt) * (h * 0.6);
        ctx.save(); ctx.globalAlpha = 0.7; ctx.strokeStyle = p.color; ctx.lineWidth = 1.5; ctx.shadowColor = p.color; ctx.shadowBlur = 6;
        ctx.beginPath(); ctx.arc(p.x, y, p.size, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
      } else {
        const poppedT = (t - p.popAt) / (1 - p.popAt + 0.001);
        const y = p.y - h * 0.6;
        const r = p.size + poppedT * 14;
        ctx.save(); ctx.globalAlpha = Math.max(0, 1 - poppedT) * 0.6; ctx.strokeStyle = p.color; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(p.x, y, r, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
      }
    });
  } else if (style === 'voidWarp') {
    const cx = w / 2, cy = h / 2;
    items.forEach(p => {
      const inward = t < 0.5;
      const localT = inward ? t / 0.5 : (t - 0.5) / 0.5;
      const r = inward ? p.r * (1 - localT) : p.r * localT;
      const ang = p.a + t * p.speed;
      const x = cx + Math.cos(ang) * r, y = cy + Math.sin(ang) * r;
      ctx.save(); ctx.globalAlpha = _transitionFade(t) * 0.8; ctx.fillStyle = p.color;
      ctx.shadowColor = p.color; ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    });
  } else if (style === 'veinPulse') {
    items.forEach(line => {
      const totalSegs = line.pts.length - 1;
      const revealSegs = t * totalSegs * 1.3;
      ctx.save();
      ctx.strokeStyle = line.color; ctx.lineWidth = 2.5 + Math.sin(t * Math.PI * 3) * 1.5; ctx.shadowColor = line.color; ctx.shadowBlur = 10;
      ctx.globalAlpha = _transitionFade(Math.min(1, t * 1.3)) * 0.85;
      ctx.beginPath();
      for (let s = 0; s < totalSegs; s++) {
        const segT = Math.max(0, Math.min(1, revealSegs - s));
        if (segT <= 0) break;
        const [x0, y0] = line.pts[s], [x1, y1] = line.pts[s + 1];
        const ex = x0 + (x1 - x0) * segT, ey = y0 + (y1 - y0) * segT;
        if (s === 0) ctx.moveTo(x0, y0);
        ctx.lineTo(ex, ey);
      }
      ctx.stroke();
      ctx.restore();
    });
  } else if (style === 'silkRibbon') {
    // A filled, gradient-shaded wavy band (not a single stroked line)
    // so it actually reads as a flowing sheet of fabric instead of a
    // thin squiggle.
    items.forEach((band, idx) => {
      const xOff = -w * 0.25 + t * w * 1.2;
      const thickness = 30 - idx * 3;
      ctx.save();
      ctx.globalAlpha = _transitionFade(t) * 0.4;
      const grad = ctx.createLinearGradient(xOff - 200, 0, xOff + 200, 0);
      grad.addColorStop(0, _hexToRgba(band.color, 0));
      grad.addColorStop(0.5, _hexToRgba(band.color, 0.6));
      grad.addColorStop(1, _hexToRgba(band.color, 0));
      ctx.fillStyle = grad;
      ctx.shadowColor = band.color; ctx.shadowBlur = 10;
      const top = [];
      for (let dx = -220; dx <= 220; dx += 12) {
        const x = xOff + dx;
        const y = band.yBase + Math.sin(dx * 0.025 + band.phase + t * 6) * 34;
        top.push([x, y]);
      }
      ctx.beginPath();
      top.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
      for (let i = top.length - 1; i >= 0; i--) ctx.lineTo(top[i][0], top[i][1] + thickness);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    });
  } else if (style === 'glassCrack') {
    items.forEach(line => {
      const reveal = Math.min(1, t * 2.2);
      ctx.save();
      ctx.globalAlpha = _transitionFade(t) * 0.7;
      ctx.strokeStyle = line.color; ctx.lineWidth = 1.2; ctx.shadowColor = line.color; ctx.shadowBlur = 6;
      ctx.beginPath();
      const segs = line.pts.length - 1;
      for (let s = 0; s < segs; s++) {
        const segT = Math.max(0, Math.min(1, reveal * segs - s));
        if (segT <= 0) break;
        const [x0, y0] = line.pts[s], [x1, y1] = line.pts[s + 1];
        const ex = x0 + (x1 - x0) * segT, ey = y0 + (y1 - y0) * segT;
        if (s === 0) ctx.moveTo(x0, y0);
        ctx.lineTo(ex, ey);
      }
      ctx.stroke();
      ctx.restore();
    });
  } else if (style === 'inkBlot') {
    const s = items[0];
    const a = _transitionFade(t);
    const r = t * Math.max(w, h) * 0.5 * (0.3 + 0.7 * Math.min(1, t * 2));
    ctx.save();
    const grad = ctx.createRadialGradient(s.cx, s.cy, 0, s.cx, s.cy, r);
    grad.addColorStop(0, _hexToRgba(s.color, 0.32 * a));
    grad.addColorStop(0.7, _hexToRgba(s.color, 0.1 * a));
    grad.addColorStop(1, _hexToRgba(s.color, 0));
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(s.cx, s.cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  } else if (style === 'eclipse') {
    // Pure canvas, no texture needed. A near-black disc (totality)
    // crosses the screen, fully ringed by a bright corona (not just a
    // glow blob on one side) with thin radiating streamers, while the
    // whole screen dims through the middle of the transition like the
    // sky actually going dark - then brightens back up as it passes.
    const r = Math.min(w, h) * 0.15;
    const cx = -r * 2 + t * (w + r * 4);
    const cy = h * 0.38;
    const a = _transitionFade(t);
    const darken = Math.sin(Math.min(1, Math.max(0, t)) * Math.PI);

    ctx.save();
    ctx.globalAlpha = darken * 0.6;
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, w, h);
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = a;

    // Thin radiating corona streamers, slowly rotating as the moon
    // crosses - gives the corona real texture instead of a flat glow.
    for (let i = 0; i < 16; i++) {
      const ang = (i / 16) * Math.PI * 2 + t * 1.2;
      const rayLen = r * (1.7 + 0.9 * Math.abs(Math.sin(i * 2.1 + t * 4)));
      const grad = ctx.createLinearGradient(cx, cy, cx + Math.cos(ang) * rayLen, cy + Math.sin(ang) * rayLen);
      grad.addColorStop(0, 'rgba(245,232,190,.5)');
      grad.addColorStop(1, 'rgba(245,232,190,0)');
      ctx.strokeStyle = grad;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(ang) * r * 0.96, cy + Math.sin(ang) * r * 0.96);
      ctx.lineTo(cx + Math.cos(ang) * rayLen, cy + Math.sin(ang) * rayLen);
      ctx.stroke();
    }

    // The corona itself - a FULL radial gradient centered on the disc,
    // so light surrounds it evenly on every side rather than glowing
    // brighter on just one edge.
    const corona = ctx.createRadialGradient(cx, cy, r * 0.98, cx, cy, r * 2.3);
    corona.addColorStop(0, 'rgba(245,232,190,.9)');
    corona.addColorStop(0.28, 'rgba(216,206,255,.4)');
    corona.addColorStop(1, 'rgba(216,206,255,0)');
    ctx.fillStyle = corona;
    ctx.beginPath(); ctx.arc(cx, cy, r * 2.3, 0, Math.PI * 2); ctx.fill();

    // The eclipsed disc - near-pure black (totality), with the
    // faintest cool undertone so it reads as a shadowed sphere rather
    // than a flat hole punched in the canvas.
    const moonGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    moonGrad.addColorStop(0, '#050308');
    moonGrad.addColorStop(1, '#020103');
    ctx.fillStyle = moonGrad;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();

    // A crisp bright ring right at the disc's edge - the sliver of
    // corona that's always brightest closest to the disc itself.
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = 'rgba(245,235,205,.95)';
    ctx.shadowColor = 'rgba(245,235,205,1)'; ctx.shadowBlur = 16;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  } else if (style === 'permafrostChill') {
    // A genuine chill-and-breeze rework: a cool blue wash over the
    // whole screen, drifting breath-fog bands, real (sprite) snowflakes
    // blown diagonally rather than falling straight, and frost creeping
    // in from BOTH edges (not just one) for a fuller "closing in" feel
    // than the shared 'frost' style Nord still uses.
    const a = _transitionFade(t);
    ctx.save();
    ctx.globalAlpha = a * 0.16;
    ctx.fillStyle = '#bfe9ff';
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
    items.forEach(p => {
      if (!p.fog) return;
      ctx.save();
      ctx.globalAlpha = a * 0.14;
      const grad = ctx.createLinearGradient(0, p.yBase - 40, 0, p.yBase + 40);
      grad.addColorStop(0, 'rgba(191,233,255,0)');
      grad.addColorStop(0.5, 'rgba(191,233,255,.5)');
      grad.addColorStop(1, 'rgba(191,233,255,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      for (let x = -50; x <= w + 50; x += 24) {
        const y = p.yBase + Math.sin(x * 0.02 + p.phase + t * 5) * 22;
        if (x === -50) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.lineTo(w + 50, p.yBase + 90); ctx.lineTo(-50, p.yBase + 90); ctx.closePath();
      ctx.fill();
      ctx.restore();
    });
    items.forEach(p => {
      if (!p.flake) return;
      p.x += p.vx; p.y += p.vy; p.rot += p.rotSpeed;
      ctx.save();
      ctx.globalAlpha = a * 0.9;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      if (p.sprite && p.sprite.loaded) {
        const img = p.sprite.img;
        const ratio = (img.naturalHeight / img.naturalWidth) || 1;
        ctx.drawImage(img, -p.size / 2, -p.size * ratio / 2, p.size, p.size * ratio);
      } else {
        ctx.fillStyle = '#eaf7ff'; ctx.shadowColor = '#eaf7ff'; ctx.shadowBlur = 6;
        ctx.beginPath(); ctx.arc(0, 0, p.size * 0.18, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    });
    const edgeProgress = Math.min(1, t * 1.3);
    [0, w].forEach((edgeX, i) => {
      const dir = i === 0 ? 1 : -1;
      const reach = edgeProgress * w * 0.28;
      ctx.save();
      ctx.globalAlpha = a * 0.5;
      const grad = ctx.createLinearGradient(edgeX, 0, edgeX + dir * reach, 0);
      grad.addColorStop(0, 'rgba(191,233,255,.55)');
      grad.addColorStop(1, 'rgba(191,233,255,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(Math.min(edgeX, edgeX + dir * reach), 0, Math.abs(reach), h);
      ctx.restore();
    });
  }
}

const PageTransitionFX = (() => {
  let canvas = null, ctx = null, raf = null;

  function ensureCanvas() {
    if (canvas) return canvas;
    canvas = el('canvas', { id: 'pageTransitionCanvas', class: 'page-transition-canvas' });
    document.body.appendChild(canvas);
    return canvas;
  }

  function run(style, colors, opts) {
    ensureCanvas();
    ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    canvas.classList.add('active');
    if (raf) cancelAnimationFrame(raf);
    const w = canvas.width, h = canvas.height;
    const items = buildTransitionParticles(style, colors, w, h, opts);
    const duration = TRANSITION_DURATION_MS[style] || 700;
    const startTime = performance.now();
    function frame(now) {
      const t = Math.min(1, (now - startTime) / duration);
      ctx.clearRect(0, 0, w, h);
      drawTransitionFrame(style, items, t, ctx, w, h, colors);
      if (t < 1) { raf = requestAnimationFrame(frame); }
      else { ctx.clearRect(0, 0, w, h); canvas.classList.remove('active'); raf = null; }
    }
    raf = requestAnimationFrame(frame);
  }

  return { run };
})();

// ── Obsidian Glass: click-to-crack ──
// Clicking anywhere on the truly empty background (not a card, button,
// input, table row, modal, plant tile, etc.) while Obsidian Glass is
// active plays the same glassCrack effect used on page transitions,
// centered on the click point instead of a random spot - see the
// origin opt threaded through PageTransitionFX.run above.
document.addEventListener('click', (e) => {
  if (document.documentElement.getAttribute('data-theme') !== 'obsidian') return;
  const interactiveHit = e.target.closest(
    '.card, .stat-card, .btn, button, a, input, select, textarea, label, ' +
    '.modal, .modal-overlay, .topbar, .nav-btns, .nav-more-popover, ' +
    '.fe-card, .plant-card, .item-slot, table, .audio-player-bar, ' +
    '.pdf-viewer-host, .theme-preview-banner, .ct-tooltip, .fe-sidebar, ' +
    '.calendar-wrap, .xp-toast-container'
  );
  if (interactiveHit) return;
  const cs = getComputedStyle(document.documentElement);
  const colors = ['--accent', '--accent2', '--accent3'].map(v => cs.getPropertyValue(v).trim()).filter(Boolean);
  PageTransitionFX.run('glassCrack', colors, { origin: { x: e.clientX, y: e.clientY } });
});
// every theme - this cache remembers, per filename stem, whether the
// image actually loads, so a missing file silently results in "no
// photo layer" (never a broken-image icon, never a console error spam
// on every render).
const _bgProbeCache = {};
function _probeThemeBackground(stem, cb) {
  if (!stem) { cb(false); return; }
  if (stem in _bgProbeCache) { cb(_bgProbeCache[stem]); return; }
  const img = new Image();
  img.onload = () => { _bgProbeCache[stem] = true; cb(true); };
  img.onerror = () => { _bgProbeCache[stem] = false; cb(false); };
  img.src = `/sprites/themes/${stem}.png`;
}

// Video backgrounds are the paid upgrade path over a static photo
// same probe-and-fall-back pattern as the photo itself. The <video>
// element is a child of the blurred theme-bg-layer, so it inherits the
// same filter: blur as the photo with no extra CSS needed to match.
function _probeThemeVideo(stem, cb) {
  if (!stem) { cb(false); return; }
  const key = stem + '.mp4';
  if (key in _bgProbeCache) { cb(_bgProbeCache[key]); return; }
  fetch(`/sprites/themes/${stem}.mp4`, { method: 'HEAD' })
    .then(r => { _bgProbeCache[key] = r.ok; cb(r.ok); })
    .catch(() => { _bgProbeCache[key] = false; cb(false); });
}
function _getThemeVideoEl(layer) {
  let v = layer.querySelector('video.theme-bg-video');
  if (!v) {
    v = document.createElement('video');
    v.className = 'theme-bg-video';
    v.muted = true; v.loop = true; v.playsInline = true; v.autoplay = true;
    layer.appendChild(v);
  }
  return v;
}

function themeOwnsUpgrade(themeId, upgradeType) {
  return !!(gamification && (gamification.theme_upgrades_owned || []).includes(`theme_upgrade_${themeId}_${upgradeType}`));
}

function applyThemeVisuals(theme) {
  const meta = THEME_META[theme] || {};
  // Effect class - exactly one lives on <body> at a time. Strips ANY
  // previous theme-effect-* class (both the 8 shared ones AND every
  // premium/vault theme's own bespoke class - see styles.css) rather
  // than only the shared list, since premium/vault themes use their own
  // theme id as the effect id and wouldn't otherwise get cleaned up.
  Array.from(document.body.classList).forEach(cls => {
    if (cls.startsWith('theme-effect-')) document.body.classList.remove(cls);
  });
  if (meta.effect) document.body.classList.add(`theme-effect-${meta.effect}`);
  // Background parallax photo layer. IMPORTANT: this layer is left
  // visible even when no photo has been sourced yet for this theme
  // several premium/vault effects (falling petals, embers, rain,
  // starfield, etc.) render as pseudo-elements ON this same layer (see
  // styles.css's .theme-effect-* rules), so fully hiding the layer
  // whenever the photo itself is missing was silently hiding those
  // effects too. Only the photo (backgroundImage) is conditional; the
  // layer's own visibility never depends on it.
  const layer = $('#themeBgLayer');
  if (layer) {
    layer.classList.remove('hidden');
    const videoEl = _getThemeVideoEl(layer);
    const wantsVideo = themeOwnsUpgrade(theme, 'video') && themeBgMode(theme) === 'video';
    if (!wantsVideo) {
      videoEl.classList.remove('active');
      videoEl.pause();
      videoEl.removeAttribute('src');
      _probeThemeBackground(meta.background, (exists) => {
        layer.style.backgroundImage = exists ? `url('/sprites/themes/${meta.background}.png')` : 'none';
      });
    } else {
      _probeThemeVideo(meta.background, (hasVideo) => {
        if (hasVideo) {
          const src = `/sprites/themes/${meta.background}.mp4`;
          if (!videoEl.src.endsWith(src)) videoEl.src = src;
          videoEl.classList.add('active');
          videoEl.play().catch(() => {});
          layer.style.backgroundImage = 'none';
        } else {
          videoEl.classList.remove('active');
          videoEl.pause();
          videoEl.removeAttribute('src');
          _probeThemeBackground(meta.background, (exists) => {
            layer.style.backgroundImage = exists ? `url('/sprites/themes/${meta.background}.png')` : 'none';
          });
        }
      });
    }
  }

  const particleCfg = THEME_PARTICLE_CONFIGS[theme];
  const gridCfg = THEME_GRID_CONFIGS[theme];
  const smokeCfg = THEME_SMOKE_CONFIGS[theme];
  if (smokeCfg) {
    ThemeFX.stop();
    ThemeGridFX.stop();
    ThemeSmokeFX.start(smokeCfg);
  } else if (gridCfg) {
    ThemeFX.stop();
    ThemeSmokeFX.stop();
    ThemeGridFX.start(gridCfg);
  } else if (particleCfg) {
    ThemeGridFX.stop();
    ThemeSmokeFX.stop();
    ThemeFX.start(particleCfg);
  } else {
    ThemeFX.stop();
    ThemeGridFX.stop();
    ThemeSmokeFX.stop();
  }

  // Sprite-based effects (see THEME_SPRITE_CONFIGS) run on their own
  // canvas, independently of the particle/grid/smoke choice above -
  // some themes (Bioluminal Reef) deliberately run both a particle
  // effect AND a sprite effect at once. Themes registered in
  // THEME_FISH_TOTALS (currently just Bioluminal Reef) start with
  // ZERO creatures and only show as many as have been unlocked via the
  // repeatable Theme Upgrades purchase.
  const spriteCfg = THEME_SPRITE_CONFIGS[theme];
  if (spriteCfg && THEME_FISH_TOTALS[theme]) {
    const unlocked = themeCreaturesOn(theme) ? themeFishUnlockedCount(theme) : 0;
    const effectiveCfg = buildUnlockedSpeciesConfig(spriteCfg, unlocked);
    if (effectiveCfg.species.length) ThemeSpriteFX.start(effectiveCfg); else ThemeSpriteFX.stop();
  } else if (spriteCfg) {
    ThemeSpriteFX.start(spriteCfg);
  } else {
    ThemeSpriteFX.stop();
  }

  updateThemeFishHint(theme);
  applyThemeAmbient(theme);
}

// ── Small "buy more fish" hint (Bioluminal Reef) ──
// A tiny, unobtrusive (i) badge fixed near the top of the screen,
// shown only while viewing a theme registered in THEME_FISH_TOTALS
// that still has unlocked creatures remaining - hovering it explains
// where to buy more. Disappears once every fish is unlocked.
function updateThemeFishHint(theme) {
  const total = THEME_FISH_TOTALS[theme];
  let hint = document.getElementById('themeFishHint');
  if (!total) {
    if (hint) hint.remove();
    return;
  }
  const owned = themeFishUnlockedCount(theme);
  if (owned >= total) {
    if (hint) hint.remove();
    return;
  }
  if (!hint) {
    hint = el('div', { id: 'themeFishHint', class: 'theme-fish-hint', text: 'i' });
    document.body.appendChild(hint);
  }
  attachTooltip(hint, `${owned}/${total} fish unlocked - buy more in Inventory → Theme Upgrades`, 'var(--accent)');
}

function setTheme(theme, force) {
  const unlocked = gamification?.unlocked_themes;
  if (!force && unlocked && !unlocked.includes(theme)) {
    theme = 'dark';
  }
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('st_theme', theme);
  applyThemeVisuals(theme);
  // Persist so theme-perk math (see server.py's THEME_PERKS /
  // compute_theme_session_multipliers) knows which theme is active
  // fire-and-forget, never blocks the theme from applying visually even
  // if offline/slow.
  if (currentProfile) {
    api(`/api/${currentProfile}/config`, { method: 'PUT', body: JSON.stringify({ active_theme: theme }) }).catch(() => {});
  }
}
function loadTheme() {
  const saved = localStorage.getItem('st_theme') || 'dark';
  setTheme(saved);
}

// ── Background Audio Engine ──
// A single shared pool of generic ambient/instrumental loop tracks
// (audiotheme1.mp3, audiotheme2.mp3, ...) that shuffles and loops
// continuously regardless of which visual theme is active - deliberately
// simple (one pool, not a per-theme pool) per design. Missing files are
// silently skipped (probed via HEAD request up front) so the pool can
// start at 0 tracks and grow over time as files are dropped in, with
// zero code changes and zero console errors either way.
const AUDIO_POOL_MAX_PROBE = 24;   // how many audiotheme<N>.mp3 candidates to check for
const AUDIO_POOL_DIR = '/sprites/audio/';
const AUDIO_BG_CROSSFADE_MS = 2200;
const AUDIO_BG_CROSSFADE_STEPS = 22;

let audioBgPool = [];              // resolved, existing track URLs
let audioBgShuffleQueue = [];      // remaining play order for the current shuffle pass
let audioBgLastPlayed = null;
let audioBgPlayerA = new Audio();
let audioBgPlayerB = new Audio();
let audioBgActive = null;          // whichever of A/B is currently the "live" player
let audioBgMuted = localStorage.getItem('st_audio_muted') === '1';
// Per-theme ambient audio (the purchasable Theme Upgrade loop) has its
// OWN mute state, entirely independent from the background music pool
// above - either can be on/off/both/neither. Shares the same volume
// SLIDER value (audioBgVolume) as a single "how loud" control, but
// mute is tracked separately here.
let themeAudioMuted = localStorage.getItem('st_theme_audio_muted') === '1';
let audioBgVolume = parseFloat(localStorage.getItem('st_audio_volume'));
if (isNaN(audioBgVolume) || audioBgVolume < 0 || audioBgVolume > 1) audioBgVolume = 0.32;
let audioBgProbed = false;
let audioBgUnlocked = false;       // becomes true after the first user gesture (autoplay policy)

async function _probeAudioPool() {
  if (audioBgProbed) return;
  audioBgProbed = true;
  const candidates = Array.from({ length: AUDIO_POOL_MAX_PROBE }, (_, i) => `${AUDIO_POOL_DIR}audiotheme${i + 1}.mp3`);
  const checks = await Promise.all(candidates.map(async (url) => {
    try {
      const res = await fetch(url, { method: 'HEAD' });
      return res.ok ? url : null;
    } catch (e) { return null; }
  }));
  audioBgPool = checks.filter(Boolean);
}

function _shuffledCopy(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function _nextAudioTrack() {
  if (!audioBgPool.length) return null;
  if (!audioBgShuffleQueue.length) {
    audioBgShuffleQueue = _shuffledCopy(audioBgPool);
    // Avoid immediately repeating the last track across a shuffle-pass boundary.
    if (audioBgShuffleQueue.length > 1 && audioBgShuffleQueue[0] === audioBgLastPlayed) {
      audioBgShuffleQueue.push(audioBgShuffleQueue.shift());
    }
  }
  const track = audioBgShuffleQueue.shift();
  audioBgLastPlayed = track;
  return track;
}

function _crossfadeTo(url) {
  const incoming = audioBgActive === audioBgPlayerA ? audioBgPlayerB : audioBgPlayerA;
  const outgoing = audioBgActive;
  incoming.src = url;
  incoming.volume = 0;
  incoming.loop = false;
  incoming.play().catch(() => {});
  audioBgActive = incoming;
  let step = 0;
  const targetVol = audioBgMuted ? 0 : audioBgVolume;
  const iv = setInterval(() => {
    step++;
    const t = step / AUDIO_BG_CROSSFADE_STEPS;
    incoming.volume = Math.min(targetVol, targetVol * t);
    if (outgoing) outgoing.volume = Math.max(0, targetVol * (1 - t));
    if (step >= AUDIO_BG_CROSSFADE_STEPS) {
      clearInterval(iv);
      if (outgoing) { outgoing.pause(); outgoing.removeAttribute('src'); }
    }
  }, AUDIO_BG_CROSSFADE_MS / AUDIO_BG_CROSSFADE_STEPS);
}

function _playNextBgTrack() {
  const track = _nextAudioTrack();
  if (!track) return;
  _crossfadeTo(track);
}

[audioBgPlayerA, audioBgPlayerB].forEach(p => {
  p.addEventListener('ended', () => { if (audioBgActive === p) _playNextBgTrack(); });
});

async function startBackgroundAudioIfNeeded() {
  if (audioBgUnlocked) return;
  audioBgUnlocked = true;
  await _probeAudioPool();
  if (!audioBgMuted && audioBgPool.length) {
    audioBgActive = audioBgPlayerA;
    _playNextBgTrack();
  }
  if (!themeAudioMuted && themeAmbientAudio.src) themeAmbientAudio.play().catch(() => {});
}

// ── Starfall shooting star audio ──
// Played once each time a shooting star spawns (see spawnShootingStar
// in ThemeFX above) - a short one-shot sound effect, NOT a loop. Drop
// your own clip at this exact path/filename and it'll just start
// working; missing is completely fine too, it fails silently (no
// console error, the streak still plays without sound).
const SHOOTING_STAR_AUDIO_PATH = '/sprites/audio/effects/shootingstar.mp3';
const shootingStarAudio = new Audio(SHOOTING_STAR_AUDIO_PATH);
shootingStarAudio.volume = 0.45;

// ── Per-theme ambient audio ──
// A separate, quieter loop layered underneath the generic pooled music
// above - this is the "breezy sounds for Permafrost Atrium" upgrade:
// one file per theme id, probed the same forgiving way as everything
// else here, and controlled by the SAME mute/volume slider so there's
// no second set of controls to manage. See /sprites/audio/themes/.
const themeAmbientAudio = new Audio();
themeAmbientAudio.loop = true;

function _probeThemeAmbient(themeId, cb) {
  const key = 'ambient:' + themeId;
  if (key in _bgProbeCache) { cb(_bgProbeCache[key]); return; }
  fetch(`/sprites/audio/themes/${themeId}.mp3`, { method: 'HEAD' })
    .then(r => { _bgProbeCache[key] = r.ok; cb(r.ok); })
    .catch(() => { _bgProbeCache[key] = false; cb(false); });
}

function themeBgMode(id) { return localStorage.getItem('st_theme_bg_' + id) || 'video'; }
function setThemeBgMode(id, mode) { localStorage.setItem('st_theme_bg_' + id, mode === 'picture' ? 'picture' : 'video'); }
function themeCreaturesOn(id) { return localStorage.getItem('st_theme_creatures_' + id) !== '0'; }
function themeAmbientVolume(id) {
  const v = parseFloat(localStorage.getItem('st_theme_vol_' + id));
  return isNaN(v) ? 0.5 : Math.max(0, Math.min(1, v));
}
function setThemeAmbientVolume(id, value) {
  const v = Math.max(0, Math.min(1, parseFloat(value)));
  localStorage.setItem('st_theme_vol_' + id, String(v));
  if (themeAudioMuted && v > 0) {
    themeAudioMuted = false;
    localStorage.setItem('st_theme_audio_muted', '0');
    updateThemeAudioMuteButton();
    if (audioBgUnlocked && themeAmbientAudio.src) themeAmbientAudio.play().catch(() => {});
  }
  if (!themeAudioMuted) themeAmbientAudio.volume = v;
}
function currentThemeId() { return document.documentElement.getAttribute('data-theme'); }

function applyThemeAmbient(themeId) {
  if (!themeOwnsUpgrade(themeId, 'ambient_audio')) {
    themeAmbientAudio.pause();
    themeAmbientAudio.removeAttribute('src');
    return;
  }
  _probeThemeAmbient(themeId, (exists) => {
    if (!exists) {
      themeAmbientAudio.pause();
      themeAmbientAudio.removeAttribute('src');
      return;
    }
    const src = `/sprites/audio/themes/${themeId}.mp3`;
    if (!themeAmbientAudio.src.endsWith(src)) themeAmbientAudio.src = src;
    themeAmbientAudio.volume = themeAudioMuted ? 0 : themeAmbientVolume(themeId);
    if (audioBgUnlocked && !themeAudioMuted) themeAmbientAudio.play().catch(() => {});
  });
}

function toggleAudioMute() {
  audioBgMuted = !audioBgMuted;
  localStorage.setItem('st_audio_muted', audioBgMuted ? '1' : '0');
  [audioBgPlayerA, audioBgPlayerB].forEach(p => { p.volume = audioBgMuted ? 0 : audioBgVolume; });
  updateAudioMuteButton();
  if (!audioBgMuted && audioBgUnlocked && !audioBgActive?.src) _playNextBgTrack();
}

// Independent toggle for the per-theme ambient loop (see themeAudioMuted
// above) - deliberately never touches audioBgPlayerA/B, so background
// music keeps playing (or stays off) exactly as it was.
function toggleThemeAudioMute() {
  themeAudioMuted = !themeAudioMuted;
  localStorage.setItem('st_theme_audio_muted', themeAudioMuted ? '1' : '0');
  themeAmbientAudio.volume = themeAudioMuted ? 0 : themeAmbientVolume(currentThemeId());
  updateThemeAudioMuteButton();
  if (themeAudioMuted) {
    themeAmbientAudio.pause();
  } else if (audioBgUnlocked && themeAmbientAudio.src) {
    themeAmbientAudio.play().catch(() => {});
  }
}

// Dragging the volume slider always means "I want sound" - auto-unmutes
// whichever of the two (background music / theme ambient) was muted,
// rather than silently adjusting a volume nobody can hear yet. Both
// share this one slider as their common "how loud" value even though
// their mute states stay independent.
function setAudioVolume(value) {
  audioBgVolume = Math.max(0, Math.min(1, parseFloat(value)));
  localStorage.setItem('st_audio_volume', String(audioBgVolume));
  if (audioBgMuted && audioBgVolume > 0) {
    audioBgMuted = false;
    localStorage.setItem('st_audio_muted', '0');
    updateAudioMuteButton();
    if (audioBgUnlocked && !audioBgActive?.src) _playNextBgTrack();
  }
  [audioBgPlayerA, audioBgPlayerB].forEach(p => { if (!audioBgMuted) p.volume = audioBgVolume; });
}

function updateAudioMuteButton() {
  const btn = $('#audioMuteBtn');
  if (btn) {
    btn.innerHTML = '';
    btn.appendChild(uiIcon(ICONS.audioVolume, 16, audioBgMuted ? 'icon-muted' : ''));
    btn.title = audioBgMuted ? 'Background music muted - click to unmute' : 'Background music on - click to mute';
  }
  const slider = $('#audioVolumeSlider');
  if (slider) slider.value = audioBgMuted ? 0 : audioBgVolume;
}

// Theme ambient audio (see the Theme Upgrades card in Inventory) shares
// the exact same icon file as the background-music mute button above -
// they're both "volume" controls, just for different audio layers, so
// there's no reason for them to look like two different icons.
function updateThemeAudioMuteButton() {
  const btn = $('#themeAudioMuteBtn');
  if (btn) {
    btn.innerHTML = '';
    btn.appendChild(uiIcon(ICONS.audioVolume, 16, themeAudioMuted ? 'icon-muted' : ''));
    btn.title = themeAudioMuted ? 'Theme ambient audio muted - click to unmute' : 'Theme ambient audio on - click to mute';
  }
}

// First real user gesture anywhere unlocks autoplay (browsers block
// audio with sound before any interaction) - a single one-time listener
// covers this regardless of which button/link the person actually clicks.
document.addEventListener('click', function _unlockAudioOnce() {
  startBackgroundAudioIfNeeded();
  document.removeEventListener('click', _unlockAudioOnce);
}, { once: true });

// ── Parallax navigation background ──
// The active theme's background photo (see applyThemeVisuals) is
// rendered oversized behind the whole app; this nudges WHICH portion is
// visible based on which nav page is active (left-listed pages bias the
// visible window left, right-listed pages bias right) and how far the
// person has scrolled within the current page (top of page shows the
// top of the image, scrolled-down shows further down) - purely a
// background-position transition, no extra DOM/JS animation loop needed.
const NAV_PAGE_ORDER = ['dashboard', 'timetable', 'self_study', 'attendance', 'exams', 'events', 'botanarium', 'industrial', 'stock_market', 'files', 'inventory', 'stats', 'progression', 'hall_of_fame', 'finance', 'settings'];
const NAV_PAGE_LABELS = {
  dashboard: 'Dashboard', timetable: 'Timetable', self_study: 'Focus', attendance: 'Attendance',
  exams: 'Exams', events: 'Events', botanarium: 'Botanarium', industrial: 'Industrial',
  stock_market: 'Stock Market', files: 'Files', inventory: 'Inventory & Shop',
  stats: 'Stats', progression: 'Progression', hall_of_fame: 'Hall of Fame', finance: 'Finance', settings: 'Settings'
};
function updateParallaxPosition() {
  const layer = $('#themeBgLayer');
  if (!layer) return;
  const idx = NAV_PAGE_ORDER.indexOf(currentPage);
  const xPct = idx === -1 ? 30 : 10 + (idx / Math.max(1, NAV_PAGE_ORDER.length - 1)) * 70;
  const contentEl = $('#content');
  let yPct = 20;
  if (contentEl && contentEl.scrollHeight > contentEl.clientHeight) {
    yPct = 10 + (contentEl.scrollTop / (contentEl.scrollHeight - contentEl.clientHeight)) * 60;
  }
  layer.style.backgroundPosition = `${xPct}% ${yPct}%`;
}
let _parallaxScrollBound = false;
function bindParallaxScroll() {
  if (_parallaxScrollBound) return;
  const contentEl = $('#content');
  if (!contentEl) return;
  _parallaxScrollBound = true;
  contentEl.addEventListener('scroll', () => requestAnimationFrame(updateParallaxPosition));
}
// ── Theme preview (for locked themes) ──
// Lets someone see what a not-yet-unlocked theme looks like without
// spending an unlock or persisting it. Shows a dismissible banner while
// active; "Exit Preview" (or picking a real unlocked theme) restores
// whatever theme was active before the preview started.
let previewingTheme = null;
let themeBeforePreview = null;

function startThemePreview(themeId) {
  if (!previewingTheme) {
    themeBeforePreview = document.documentElement.getAttribute('data-theme') || 'dark';
  }
  previewingTheme = themeId;
  document.documentElement.setAttribute('data-theme', themeId);
  applyThemeVisuals(themeId);
  showThemePreviewBanner(themeId);
  // Lock every clickable element WITHIN the content area (buttons,
  // links, cards, form fields) so a preview can't be used to sneak in
  // real actions like starting a timer - but deliberately does NOT
  // block the topbar/nav bar, so switching pages to see how the
  // previewed theme looks elsewhere still works. See the
  // body.theme-previewing rule in styles.css.
  document.body.classList.add('theme-previewing');
}

function exitThemePreview() {
  if (themeBeforePreview) {
    document.documentElement.setAttribute('data-theme', themeBeforePreview);
    applyThemeVisuals(themeBeforePreview);
  }
  previewingTheme = null;
  themeBeforePreview = null;
  const banner = $('#themePreviewBanner');
  if (banner) banner.remove();
  document.body.classList.remove('theme-previewing');
}

function showThemePreviewBanner(themeId) {
  let banner = $('#themePreviewBanner');
  const catalog = gamification?.theme_catalog || [];
  const t = catalog.find(x => x.id === themeId);
  const label = t ? t.label : themeId;
  if (!banner) {
    banner = el('div', { id: 'themePreviewBanner', class: 'theme-preview-banner' });
    document.body.appendChild(banner);
  }
  banner.innerHTML = '';
  banner.appendChild(el('span', { text: `Previewing "${label}"${t ? ` (Lv ${t.level})` : ''} - not unlocked yet` }));
  banner.appendChild(el('button', { class: 'btn btn-sm btn-outline', text: 'Exit Preview', onclick: () => { exitThemePreview(); render(); } }));
}

// ── Gamification (XP / Levels / Streaks) ──
async function loadGamification() {
  if (!currentProfile) { gamification = null; gamificationError = null; return null; }
  gamificationError = null;
  let checkIn = null;
  try {
    checkIn = await api(`/api/${currentProfile}/ping_login`, { method: 'POST' });
    gamification = await api(`/api/${currentProfile}/gamification`);
    if (checkIn?.new_today) {
      showDailyCheckInPopup(checkIn, gamification);
    }
  } catch (e) {
    gamification = null;
    gamificationError = e?.message || 'Unable to load progression data';
  }
  updateTopLevelBar();
  updateNerdsBadge();
  return checkIn;
}

// Purely cosmetic level-tier banding for the topbar chip - independent
// from the real unlock system (themes/badges/mastery already have
// their own tier ladders); this just gives the level number itself a
// sense of "rank" that visibly climbs as someone plays, the way a
// battle-pass emblem would. rank_icon sits before the title text.
const TOP_LEVEL_TIERS = [
  { min: 0, label: 'Bronze', color: '#c47b3e', rank_icon: 'BRZ' },
  { min: 25, label: 'Silver', color: '#b8c2cc', rank_icon: 'SLV' },
  { min: 50, label: 'Gold', color: '#f0c44a', rank_icon: 'GLD' },
  { min: 80, label: 'Platinum', color: '#7fe0d0', rank_icon: 'PLT' },
  { min: 125, label: 'Diamond', color: '#8ab8ff', rank_icon: 'DIA' },
  { min: 180, label: 'Mythic', color: '#e0708f', rank_icon: 'MYT' },
];
function topLevelTierFor(level) {
  let cur = TOP_LEVEL_TIERS[0];
  for (const t of TOP_LEVEL_TIERS) { if (level >= t.min) cur = t; else break; }
  return cur;
}

function updateTopLevelBar() {
  const bar = $('#topLevelBar');
  if (!bar) return;
  if (!gamification) {
    bar.classList.add('hidden');
    bar.innerHTML = '';
    bar.onclick = null;
    return;
  }
  bar.classList.remove('hidden');
  const pct = Math.max(0, Math.min(100, gamification.progress_pct || 0));
  const streakMilestone = gamification.streak_current > 0 && gamification.streak_current % 7 === 0;
  const tier = topLevelTierFor(gamification.level);
  bar.innerHTML = '';
  bar.onclick = () => { navigate('progression'); };
  bar.classList.toggle('streak-milestone', streakMilestone);
  bar.style.setProperty('--tier-color', tier.color);

  // Four independent chips (level / tier rank / title / streak) instead
  // of one crowded stacked cluster - each chip sizes itself to its own
  // content and the row simply wraps if the topbar gets narrow, rather
  // than everything fighting for the same fixed-width strip and
  // overlapping. A slim, separate progress track sits underneath -
  // the fill is its own element now instead of doubling as the whole
  // card's background, so there's no risk of it visually colliding
  // with the chips sitting on top of it.
  const streakText = gamification.streak_current > 0
    ? `${gamification.streak_current}-day streak`
    : 'No streak yet';

  const chipRow = el('div', { class: 'top-level-bar-chip-row' }, [
    el('span', { class: 'tlb-chip tlb-chip-level' }, [
      el('span', { class: 'tlb-chip-spark', text: '\u2726' }),
      el('span', { text: `Lv ${gamification.level}` })
    ]),
    el('span', { class: 'tlb-chip tlb-chip-tier', title: `${tier.label} rank` }, [
      el('span', { class: 'tlb-chip-tier-text', text: tier.rank_icon })
    ]),
    el('span', { class: 'tlb-chip tlb-chip-title', text: gamification.title }),
    el('span', { class: `tlb-chip tlb-chip-streak${gamification.streak_current > 0 ? ' has-streak' : ''}` }, [
      uiIcon(ICONS.streak, 13),
      el('span', { text: streakText })
    ]),
  ]);
  bar.appendChild(chipRow);

  bar.appendChild(el('div', { class: 'tlb-progress-track' }, [
    el('div', { class: 'tlb-progress-fill', style: `width:${pct}%` })
  ]));
}

// Lightweight re-fetch of just the progression numbers (Nerds, level, XP) so
// the top-bar balance follows anything that spends or earns Nerds outside the
// normal study flow (Stock Market trades, industrial placements/upgrades).
async function refreshNerdsBadge() {
  if (!currentProfile) return;
  try {
    const g = await api(`/api/${currentProfile}/gamification`);
    gamification = g;
    lastKnownNerds = g.nerds;
    updateNerdsBadge();
  } catch (e) { /* non-fatal: the next full refresh will catch up */ }
}

let nerdsBadgeCoinInterval = null;
function updateNerdsBadge() {
  const badge = $('#nerdsBadge');
  if (!badge) return;
  if (!gamification) {
    badge.classList.add('hidden');
    badge.innerHTML = '';
    if (nerdsBadgeCoinInterval) { clearInterval(nerdsBadgeCoinInterval); nerdsBadgeCoinInterval = null; }
    return;
  }
  badge.classList.remove('hidden');
  // updateNerdsBadge() runs on basically every data refresh - only
  // build the coin + start its interval ONCE and just update the
  // amount text after that, instead of wiping and recreating the <img>
  // (and leaking a new setInterval) every single time.
  let coinImg = badge.querySelector('.nerds-badge-icon-animated');
  let amountEl = badge.querySelector('.nerds-badge-amount');
  if (!coinImg) {
    badge.innerHTML = '';
    coinImg = el('img', { src: '/sprites/nerds/coin_01.png', class: 'nerds-badge-icon-animated' });
    amountEl = el('span', { class: 'nerds-badge-amount' });
    badge.appendChild(coinImg);
    badge.appendChild(amountEl);
    if (nerdsBadgeCoinInterval) clearInterval(nerdsBadgeCoinInterval);
    nerdsBadgeCoinInterval = setInterval(() => {
      const next = (parseInt(coinImg.dataset.frame || '1', 10) % COIN_ANIM_FRAME_COUNT) + 1;
      coinImg.dataset.frame = next;
      coinImg.src = `/sprites/nerds/coin_${String(next).padStart(2, '0')}.png`;
    }, 1000 / COIN_ANIM_FPS);
  }
  amountEl.textContent = Math.round(gamification.nerds || 0).toLocaleString();
}

function showDailyCheckInPopup(checkIn, g) {
  const quests = g?.quests_this_week || [];
  const completedQuests = quests.filter(q => q.done).length;
  const totalQuests = quests.length;
  const content = el('div', {}, [
    el('div', { class: 'modal-header' }, [
      el('div', { class: 'modal-title', text: 'Daily Check-In' }),
      el('button', { class: 'modal-close', onclick: closeModal, text: '×' })
    ]),
    el('div', { class: 'row', style: 'align-items:flex-start;gap:14px;flex-wrap:wrap' }, [
      el('div', { class: 'stat-card', style: 'min-width:120px;flex:0 0 120px' }, [
        el('div', { class: 'stat-label', style: 'font-weight:700', text: checkIn?.new_today ? 'Logged today' : 'Already counted' }),
        el('div', { class: 'text-dim text-sm', text: `${g?.login_days_total || 0} total login day${(g?.login_days_total || 0) === 1 ? '' : 's'}` })
      ]),
      el('div', { class: 'flex-1', style: 'min-width:220px' }, [
        el('div', { style: 'font-weight:800;font-size:1.05rem;margin-bottom:6px', text: 'You are checked in for today.' }),
        el('div', { class: 'text-dim text-sm', text: `Current login streak: ${g?.login_streak_current || 0} day${(g?.login_streak_current || 0) === 1 ? '' : 's'}.` }),
        el('div', { class: 'text-dim text-sm', text: `This week: ${g?.login_days_this_week || 0} login day${(g?.login_days_this_week || 0) === 1 ? '' : 's'} counted toward weekly rewards.` })
      ])
    ]),
    el('div', { class: 'card', style: 'margin-top:16px;padding:16px' }, [
      el('div', { class: 'card-title', text: `Weekly Rewards ${completedQuests}/${totalQuests}` }),
      totalQuests ? el('div', {}, quests.map(q =>
        el('div', { class: 'row', style: 'justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)' }, [
          el('span', { text: `${q.done ? '' : ''} ${q.label}` }),
          el('span', { class: 'text-dim text-sm', text: `+${q.xp} XP` })
        ])
      )) : el('div', { class: 'text-dim text-sm', text: 'No weekly quests are available yet.' })
    ]),
    el('div', { class: 'btn-group', style: 'justify-content:flex-end;margin-top:16px' }, [
      el('button', { class: 'btn', text: 'Continue', onclick: closeModal })
    ])
  ]);
  showModal(content);
}

// Call this after any action that can earn XP (focus logged, timer
// session saved, attendance marked, exam completed). It
// re-fetches gamification, compares against the last level we knew
// about, and - if it went up - shows a celebration overlay. lastKnownLevel
// starts null on a fresh load so the very first fetch never falsely
// fires a celebration.
async function maybeShowLevelUp(opts = {}) {
  if (!currentProfile) return;
  const previous = lastKnownLevel;
  const previousXp = lastKnownXp;
  const previousNerds = lastKnownNerds;
  await loadGamification();
  if (!gamification) return;
  if (!opts.skipXpToast && previousXp !== null && gamification.xp > previousXp) {
    showXpToast(gamification.xp - previousXp, gamification.xp, gamification.level);
  }
  if (previousNerds !== null && gamification.nerds > previousNerds) {
    const nerdsBadge = $('#nerdsBadge');
    if (nerdsBadge) {
      nerdsBadge.classList.add('nerds-gain-pulse');
      setTimeout(() => nerdsBadge.classList.remove('nerds-gain-pulse'), UI_LEVELUP_BAR_PULSE_MS);
    }
  }
  if (previous !== null && gamification.level > previous) {
    showLevelUpCelebration(gamification.level, previous);
    const bar = $('#topLevelBar');
    if (bar) {
      bar.classList.add('level-up-pulse');
      setTimeout(() => bar.classList.remove('level-up-pulse'), UI_LEVELUP_BAR_PULSE_MS);
    }
  }
  lastKnownLevel = gamification.level;
  lastKnownXp = gamification.xp;
  lastKnownNerds = gamification.nerds;
}

function showXpToast(delta, totalXp, level) {
  let container = $('#xpToastContainer');
  if (!container) {
    container = el('div', { id: 'xpToastContainer', class: 'xp-toast-container' });
    document.body.appendChild(container);
  }
  const toast = el('div', { class: 'xp-toast' }, [
    el('div', { class: 'xp-toast-body' }, [
      el('div', { class: 'xp-toast-title', text: `+${Math.round(delta)} XP earned` }),
      el('div', { class: 'xp-toast-subtitle', text: `Level ${level} • ${Math.round(totalXp)} total XP` })
    ])
  ]);
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), UI_TOAST_FADE_OUT_MS);
  }, UI_XP_TOAST_DISPLAY_MS);
}

// Shown after deleting a focus/attendance/exam record. Backed by
// a single-slot server-side trash (see /api/<name>/undo_delete) - this
// Shown after deleting a focus/attendance/exam record. Backed by
// a single-slot server-side trash (see /api/<name>/undo_delete) - this
// is the safety net for accidental deletions, since a delete anywhere
// in the app is otherwise permanent and irreversible.
function showUndoToast(message) {
  let container = $('#xpToastContainer');
  if (!container) {
    container = el('div', { id: 'xpToastContainer', class: 'xp-toast-container' });
    document.body.appendChild(container);
  }
  const toast = el('div', { class: 'xp-toast xp-toast-danger' }, [
    el('div', { class: 'xp-toast-body' }, [
      el('div', { class: 'xp-toast-title', text: message })
    ]),
    el('button', { class: 'btn btn-sm btn-outline', text: 'Undo', onclick: async () => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 220);
      try {
        await api(`/api/${currentProfile}/undo_delete`, { method: 'POST' });
        await loadData();
        render();
      } catch (e) {
        alert('Could not undo: ' + e.message);
      }
    } })
  ]);
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), UI_TOAST_FADE_OUT_MS);
  }, UI_UNDO_TOAST_DISPLAY_MS);
}

// Shown right when a timer/pomodoro session is saved, using the exact
// xp_earned/nerds_earned the backend computed for that specific record
// (rather than the generic before/after gamification diff, which can
// also include unrelated badge/mastery tier-up bonuses). Also answers
// "how much XP per minute" directly, since the rate depends on
// difficulty.
function showSessionXpToast(xpEarned, minutes, difficulty, nerdsEarned) {
  let container = $('#xpToastContainer');
  if (!container) {
    container = el('div', { id: 'xpToastContainer', class: 'xp-toast-container' });
    document.body.appendChild(container);
  }
  const rate = minutes > 0 ? (xpEarned / minutes) : 0;
  const nerdsLine = nerdsEarned > 0 ? ` · +${nerdsEarned}` : '';
  const toast = el('div', { class: 'xp-toast' }, [
    el('div', { class: 'xp-toast-body' }, [
      el('div', { class: 'xp-toast-title', text: `Congrats! +${xpEarned} XP earned${nerdsLine}` }),
      el('div', { class: 'xp-toast-subtitle', text: `${minutes} min at difficulty ${difficulty}/10 ≈ ${fmt(rate, 2)} XP/min` })
    ])
  ]);
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), UI_TOAST_FADE_OUT_MS);
  }, UI_SESSION_XP_TOAST_DISPLAY_MS);
}

function showLevelUpCelebration(newLevel, oldLevel) {
  const newlyUnlocked = (gamification.theme_catalog || []).filter(t => t.level > oldLevel && t.level <= newLevel);
  const overlay = el('div', { class: 'levelup-overlay' }, [
    el('div', { class: 'levelup-card levelup-card-large' }, [
      el('div', { class: 'levelup-title', text: 'Level Up!' }),
      el('div', { class: 'levelup-level', text: `Level ${newLevel}` }),
      el('div', { class: 'levelup-subtitle', text: gamification.title }),
      el('div', { class: 'levelup-xp-line', text: `${Math.round(gamification.xp_into_level)} / ${gamification.xp_for_next} XP toward the next level` }),
      newlyUnlocked.length ? el('div', { class: 'levelup-unlocks' }, [
        el('div', { class: 'text-sm', style: 'margin-bottom:10px', text: 'New unlocks:' }),
        el('div', { class: 'levelup-theme-grid' }, newlyUnlocked.map(t =>
          el('div', { class: 'levelup-theme-card' }, [
            el('div', { class: 'levelup-theme-name', text: t.label }),
            el('div', { class: 'levelup-theme-level', text: `Lv ${t.level}` })
          ])
        ))
      ]) : null,
      el('button', { class: 'btn mt-16', text: 'Nice!', onclick: () => overlay.remove() })
    ])
  ]);
  document.body.appendChild(overlay);
  setTimeout(() => { if (overlay.parentNode) overlay.remove(); }, UI_LEVELUP_OVERLAY_AUTO_DISMISS_MS);
}

function playDangerSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [440, 330].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.15, ctx.currentTime + i * 0.15);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.15 + 0.25);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + i * 0.15);
      osc.stop(ctx.currentTime + i * 0.15 + 0.25);
    });
  } catch (e) { /* audio not available, ignore */ }
}

function dangerConfirm(message) {
  playDangerSound();
  return confirm(`${message}`);
}

function renderXpCard() {
  if (!gamification) return el('div', { class: 'text-dim text-sm', text: gamificationError ? `Progression unavailable: ${gamificationError}` : 'No progression data yet. Check in and log an activity to start earning rewards.' });
  const g = gamification;
  return el('div', {}, [
    el('div', { class: 'row', style: 'justify-content:space-between;align-items:center;margin-bottom:8px' }, [
      el('div', {}, [
        el('div', { style: 'font-size:1.3rem;font-weight:800', text: `Level ${g.level}` }),
        el('div', { class: 'text-dim text-sm', text: g.title })
      ]),
      el('div', { class: 'text-right' }, [
        g.streak_current > 0
          ? el('div', { class: 'row', style: 'gap:5px;align-items:center;justify-content:flex-end;font-weight:700;color:var(--amber)' }, [uiIcon(ICONS.streak, 15), el('span', { text: `${g.streak_current}-day streak` })])
          : el('div', { class: 'text-dim text-sm', text: 'No active streak - Focus today to start one!' }),
        g.streak_best > g.streak_current ? el('div', { class: 'text-dim text-sm', text: `Best: ${g.streak_best} days` }) : null
      ])
    ]),
    el('div', { class: 'xp-progress-track' }, [
      el('div', { class: 'xp-progress-fill', style: `width:${g.progress_pct}%` })
    ]),
    el('div', { class: 'text-dim text-sm mt-8', text: `${Math.round(g.xp_into_level)} / ${g.xp_for_next} XP to Level ${g.level + 1}` })
  ]);
}

const TIER_COLORS = {
  "Bachelor's I": '#8a8a8a', "Bachelor's II": '#a3672f', "Bachelor's III": '#b9c2cc',
  "Master's I": '#e0b23a', "Master's II": '#4fd6c4', "Master's III": '#2ecc71',
  "PhD I": '#5fc9f8', "PhD II": '#c9a4ff', "PhD III": '#ff6ec7', "Laureate": '#ffd700'
};
const TIERS = ["Bachelor's I", "Bachelor's II", "Bachelor's III", "Master's I", "Master's II",
               "Master's III", "PhD I", "PhD II", "PhD III", "Laureate"];

function renderStudyHeatmap(byDate) {
  const dates = Object.keys(byDate);
  if (!dates.length) return el('div', { class: 'text-dim text-sm', text: 'No data yet.' });
  const minDate = new Date(dates.reduce((a, b) => a < b ? a : b) + 'T00:00:00');
  const maxDate = new Date(dates.reduce((a, b) => a > b ? a : b) + 'T00:00:00');
  const maxMinutes = Math.max(...Object.values(byDate));
  const start = new Date(minDate);
  start.setDate(start.getDate() - start.getDay());
  const wrap = el('div', { style: 'display:flex;gap:3px;overflow-x:auto;padding:4px 0' });
  let col = el('div', { style: 'display:flex;flex-direction:column;gap:3px' });
  let cur = new Date(start);
  let dayCount = 0;
  while (cur <= maxDate) {
    const dStr = cur.toISOString().slice(0, 10);
    const mins = byDate[dStr] || 0;
    const intensity = maxMinutes > 0 ? Math.min(1, mins / maxMinutes) : 0;
    const bg = mins === 0 ? 'var(--bg3)' : `color-mix(in srgb, var(--accent) ${Math.round(20 + intensity * 80)}%, var(--bg3))`;
    col.appendChild(el('div', {
      style: `width:11px;height:11px;border-radius:2px;background:${bg}`,
      title: `${dStr}: ${fmtHours(mins)}h`
    }));
    dayCount++;
    if (dayCount % 7 === 0) { wrap.appendChild(col); col = el('div', { style: 'display:flex;flex-direction:column;gap:3px' }); }
    cur.setDate(cur.getDate() + 1);
  }
  if (col.children.length) wrap.appendChild(col);
  return wrap;
}

// ── Custom tooltip (real DOM element, not a CSS pseudo-element) ──
// Used for badge/mastery cards instead of the native `title` attribute,
// which sidesteps any risk of colliding with other ::before/::after
// usages on the same card (e.g. the stat-card accent bar).
let _ctTooltipEl = null;
function _ctTooltip() {
  if (!_ctTooltipEl) {
    _ctTooltipEl = el('div', { class: 'ct-tooltip' });
    document.body.appendChild(_ctTooltipEl);
  }
  return _ctTooltipEl;
}
function attachTooltip(node, text, accentColor) {
  node.addEventListener('mouseenter', (e) => {
    const tip = _ctTooltip();
    tip.textContent = text;
    tip.style.setProperty('--ct-accent', accentColor || 'var(--accent)');
    tip.classList.add('show');
    positionTooltip(tip, e);
  });
  node.addEventListener('mousemove', (e) => positionTooltip(_ctTooltip(), e));
  node.addEventListener('mouseleave', () => { _ctTooltip().classList.remove('show'); });
  return node;
}
function positionTooltip(tip, e) {
  const pad = 14;
  let x = e.clientX + pad, y = e.clientY + pad;
  const rect = tip.getBoundingClientRect();
  if (x + rect.width > window.innerWidth - 8) x = e.clientX - rect.width - pad;
  if (y + rect.height > window.innerHeight - 8) y = e.clientY - rect.height - pad;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}

function _initGlobalTooltips() {
  document.body.addEventListener('mouseover', (e) => {
    const el = e.target.closest && e.target.closest('[title]');
    if (!el) return;
    const text = el.getAttribute('title');
    if (!text) return;
    el.removeAttribute('title');
    const tip = _ctTooltip();
    tip.textContent = text;
    tip.style.setProperty('--ct-accent', 'var(--accent)');
    tip.classList.add('show');
    positionTooltip(tip, e);
    const move = (ev) => positionTooltip(tip, ev);
    const leave = () => {
      tip.classList.remove('show');
      el.setAttribute('title', text);
      el.removeEventListener('mousemove', move);
      el.removeEventListener('mouseleave', leave);
    };
    el.addEventListener('mousemove', move);
    el.addEventListener('mouseleave', leave);
  });
  // Any element removed from the DOM by its own click handler (window
  // close/minimize buttons, etc.) never fires mouseleave, orphaning the
  // shared tooltip on screen. Dismiss on any click, in the capture phase
  // so this runs before the click's own handler can remove the element.
  document.addEventListener('click', () => {
    const t = document.querySelector('.ct-tooltip');
    if (t) t.classList.remove('show');
  }, true);
}

function badgeHint(b) {
  const descriptions = {
    hours: 'Total study minutes completed across all subjects.',
    streak: 'Longest streak of consecutive study days.',
    early_bird: 'Completed sessions started before 08:00.',
    night_owl: 'Completed sessions started at 22:00 or later.',
    attendance: 'Attendance records marked present.',
    exam_ace: 'Exams scored 16/20 or higher.',
    comeback: 'Returns after a 5+ day gap between study days.',
    well_rounded: 'Weeks with both focus and attendance logged.',
    variety: 'Distinct subjects and skills studied.',
    weekend: 'Completed study sessions logged on weekends.',
    marathon: 'Completed study sessions lasting at least 120 minutes.',
    login_streak: 'Longest streak of consecutive login days.',
    music_time: 'Total minutes spent playing music tracks in the File Explorer.',
    video_time: 'Total minutes spent watching videos in the File Explorer.',
    app_time: 'Total minutes spent with the app open, on any page.'
  };
  const base = descriptions[b.id] || b.label;
  const progress = b.max_tier ? 'Max tier reached.' : `Current: ${b.value}. Next tier at ${b.next_threshold}.`;
  return `${base} ${progress}`;
}

function renderBadgesGrid() {
  if (!gamification || !gamification.badges) return el('div', { class: 'text-dim text-sm', text: gamificationError ? 'Badges could not be loaded.' : 'No badges yet. Keep studying and they will appear here.' });
  if (!gamification.badges.length) return el('div', { class: 'text-dim text-sm', text: 'No badges yet. Keep studying and they will appear here.' });
  return el('div', { class: 'stats-grid', style: 'grid-template-columns:repeat(auto-fill,minmax(150px,1fr))' },
    gamification.badges.map(b => {
      const color = b.tier_name ? TIER_COLORS[b.tier_name] : 'var(--border)';
      const card = el('div', { class: 'stat-card', style: `border-color:${color};cursor:help` }, [
        el('div', { class: 'stat-label', style: 'font-weight:700', text: b.label }),
        el('div', { style: `font-weight:800;color:${color};margin-top:6px`, text: b.tier_name || 'Unranked' }),
        el('div', { class: 'text-dim', style: 'font-size:10px', text: b.max_tier ? `Maxed (${b.value})` : `${b.value} / ${b.next_threshold}` })
      ]);
      attachTooltip(card, badgeHint(b), color);
      return card;
    })
  );
}

function renderMasteryGrid(filterType, emptyHint) {
  if (!gamification || !gamification.mastery) return el('div', { class: 'text-dim text-sm', text: gamificationError ? 'Mastery could not be loaded.' : 'No mastery yet.' });
  const items = filterType ? gamification.mastery.filter(m => m.type === filterType) : gamification.mastery;
  if (!items.length) return el('div', { class: 'text-dim text-sm', text: emptyHint || 'Nothing here yet.' });
  return el('div', { class: 'stats-grid', style: 'grid-template-columns:repeat(auto-fill,minmax(150px,1fr))' },
    items.map(m => {
      const color = m.tier_name ? TIER_COLORS[m.tier_name] : 'var(--border)';
      return el('div', { class: 'stat-card', style: `border-color:${color}` }, [
        el('div', { style: 'font-size:1.2rem', text: m.type === 'skill' ? '' : (m.type === 'category' ? '' : '') }),
        el('div', { class: 'stat-label', style: 'margin-top:6px;font-weight:600', text: m.name }),
        el('div', { style: `font-weight:800;color:${color}`, text: m.tier_name || 'Unranked' }),
        el('div', { class: 'text-dim', style: 'font-size:10px', text: m.next_threshold ? `${Math.round(m.minutes)} / ${m.next_threshold} min` : `Maxed (${Math.round(m.minutes)}min)` })
      ]);
    })
  );
}

function renderQuestsCard() {
  if (!gamification || !gamification.quests_this_week) return el('div', { class: 'text-dim text-sm', text: gamificationError ? 'Weekly quests could not be loaded.' : 'Weekly quests will appear after the first sync.' });
  if (!gamification.quests_this_week.length) return el('div', { class: 'text-dim text-sm', text: 'No weekly quests available yet.' });
  return el('div', {}, gamification.quests_this_week.map(q =>
    el('div', { class: 'row', style: 'justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)' }, [
      el('span', { text: `${q.done ? '' : ''} ${q.label}` }),
      el('span', { class: 'text-dim text-sm', text: `+${q.xp} XP` })
    ])
  ));
}

// ── Profiles ──
async function loadProfiles() {
  try {
    const profiles = await api('/api/profiles');
    const sel = $('#profileSelect');
    sel.innerHTML = '';
    if (profiles.length === 0) {
      sel.appendChild(el('option', { value: '', text: 'No profiles - create one in Settings' }));
    } else {
      profiles.forEach(p => {
        sel.appendChild(el('option', { value: p.name, text: `${p.name} (${p.subjects} subjects)` }));
      });
    }
    if (currentProfile && profiles.find(p => p.name === currentProfile)) {
      sel.value = currentProfile;
    } else if (profiles.length > 0) {
      currentProfile = profiles[0].name;
      sel.value = currentProfile;
    }
  } catch (e) {
    console.error('Load profiles:', e);
  }
}

async function switchProfile(name) {
  if (!name) return;
  currentProfile = name;
  cachedConfig = null;
  cachedData = null;
  gamification = null;
  gamificationError = null;
  lastKnownLevel = null;
  lastKnownNerds = null;
  // Reset live-sync bookkeeping for the new profile - otherwise the
  // next poll would compare the new profile's timestamps against the
  // PREVIOUS profile's last-seen values and could spuriously think
  // nothing (or everything) changed.
  lastDataModified = null;
  lastConfigModified = null;
  activeTimer = null;
  updateTopLevelBar();
  updateNerdsBadge();
  await loadConfig();
  try { await api(`/api/${currentProfile}/attendance/autofill`, { method: 'POST' }); } catch (e) { /* non-fatal */ }
  await loadData();
  await loadGamification();
  await refreshActiveTimerFromServer();
  lastKnownLevel = gamification?.level ?? null;
  lastKnownXp = gamification?.xp ?? null;
  lastKnownNerds = gamification?.nerds ?? null;
  pageActivityTicker.start();
  render();
}

async function loadConfig() {
  if (!currentProfile) return;
  try {
    cachedConfig = await api(`/api/${currentProfile}/config`);
  } catch (e) { cachedConfig = null; }
}

// Subjects/skills/categories being added or removed changes mastery
// entries (a brand-new skill needs to appear at 0 progress; a deleted
// one needs to disappear) - but mastery lives in `gamification`, a
// separately-cached object that loadConfig() alone never touches. Using
// this instead of a bare loadConfig() after those specific actions is
// what makes Progression reflect the change immediately instead of
// only after a full page reload.
async function loadConfigAndGamification() {
  await loadConfig();
  await loadGamification();
}

async function loadData() {
  if (!currentProfile) return;
  try {
    // This used to fetch /config first and immediately throw the result
    // away by overwriting it with /data - a wasted network round-trip on
    // every single data refresh. Config has its own loadConfig().
    cachedData = await api(`/api/${currentProfile}/data`);
  } catch (e) { cachedData = null; }
}

async function ensureLoaded() {
  if (!cachedConfig) await loadConfig();
  if (!cachedData) await loadData();
}

// ── Render dispatcher ──
async function render() {
  await ensureLoaded();
  const c = $('#content');
  // Any element a shared tooltip (see attachTooltip) was anchored to is
  // about to be destroyed below - if the mouse never naturally left it
  // (e.g. this render was triggered by a click/preview/nav rather than
  // the mouse actually moving away), 'mouseleave' never fires and the
  // tooltip would otherwise stay stuck on screen indefinitely.
  const tip = document.querySelector('.ct-tooltip');
  if (tip) tip.classList.remove('show');
  c.innerHTML = '<div class="text-center text-dim" style="padding:40px">Loading...</div>';
  try {
    switch (currentPage) {
      case 'dashboard': await renderDashboard(c); break;
      case 'timetable': await renderTimetable(c); break;
      case 'self_study': await renderSelfStudy(c); break;
      case 'attendance': await renderAttendance(c); break;
      case 'exams': await renderExams(c); break;
      case 'events': await renderEvents(c); break;
      case 'botanarium': await renderBotanarium(c); break;
      case 'industrial': await renderIndustrial(c); break;
      case 'stock_market': await renderStockMarket(c); break;
      case 'files': await renderFiles(c); break;
      case 'inventory': await renderInventory(c); break;
      case 'stats': await renderStats(c); break;
      case 'progression': await renderProgression(c); break;
      case 'hall_of_fame': await renderHallOfFame(c); break;
      case 'finance': await renderFinance(c); break;
      case 'settings': await renderSettings(c); break;
    }
  } catch (e) {
    c.innerHTML = `<div class="card"><div class="card-title">Error</div><p>${esc(e.message)}</p></div>`;
  }
  updateParallaxPosition();
}

// ═══════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════
async function renderDashboard(c) {
  const d = cachedData || { self_study: [], attendance: [], exams: [], events: [], timers: [] };
  const cfg = cachedConfig || { subjects: [], skills: [] };

  // Quick stats
  const totalSelfStudy = d.self_study.reduce((s, r) => s + (r.minutes || 0), 0);
  const totalAttendance = d.attendance.filter(r => r.status === 'present').reduce((s, r) => s + (r.minutes || 0), 0);
  const upcomingExams = d.exams.filter(e => e.status === 'scheduled').length;

  c.innerHTML = '';
  c.appendChild(el('h2', { style: 'margin-bottom:16px', text: 'Dashboard' }));

  // Progression card - the "hero" element of the dashboard (see
  // .dashboard-hero in styles.css): everything else here is
  // informational, this is the one thing actively driving the whole
  // game-ified system, so it earns a stronger visual weight.
  c.appendChild(el('div', { class: 'card fade-in xp-card dashboard-hero' }, [renderXpCard()]));

  // Stats row
  const grid = el('div', { class: 'stats-grid' });
  grid.appendChild(el('div', { class: 'stat-card' }, [
    el('div', { class: 'stat-value', text: fmtHours(totalSelfStudy) + 'h' }),
    el('div', { class: 'stat-label', text: 'Focus Hours' })
  ]));
  grid.appendChild(el('div', { class: 'stat-card' }, [
    el('div', { class: 'stat-value', text: fmtHours(totalAttendance) + 'h' }),
    el('div', { class: 'stat-label', text: 'Uni Hours (Attended)' })
  ]));
  grid.appendChild(el('div', { class: 'stat-card' }, [
    el('div', { class: 'stat-value', text: upcomingExams }),
    el('div', { class: 'stat-label', text: 'Upcoming Exams' })
  ]));
  c.appendChild(grid);

  // Quick Timer - the second hero element: the one card someone is
  // actually meant to DO something with on a daily basis.
  c.appendChild(el('div', { class: 'card fade-in dashboard-hero' }, [
    el('div', { class: 'card-title', text: '⏱ Quick Timer' }),
    renderTimerWidget()
  ]));

  // Today's schedule
  const today = todayStr();
  const dayOfWeek = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][new Date(today).getDay()];
  const todayAttendance = d.attendance.filter(r => r.date === today);
  const todayStudy = d.self_study.filter(r => r.date === today);

  c.appendChild(el('div', { class: 'card fade-in' }, [
    el('div', { class: 'card-title', text: `Today (${today} - ${dayOfWeek})` }),
    todayAttendance.length || todayStudy.length ? el('div', {}, [
      ...todayStudy.map(r => {
        const subj = cfg.subjects.find(s => s.id === r.subject_id);
        const skill = cfg.skills.find(s => s.id === r.skill_id);
        const name = subj?.name || skill?.name || 'Unknown';
        return el('div', { class: 'row', style: 'margin-bottom:6px' }, [
          el('span', { class: 'tag tag-done', text: 'Focus' }),
          el('span', { text: `${name} - ${r.minutes}min (${r.status})` })
        ]);
      }),
      ...todayAttendance.map(r => {
        const subj = cfg.subjects.find(s => s.id === r.subject_id);
        return el('div', { class: 'row', style: 'margin-bottom:6px' }, [
          el('span', { class: `tag tag-${r.status}`, text: r.status }),
          el('span', { text: `${subj?.name || 'Unknown'} ${r.type} - ${r.minutes}min` })
        ]);
      })
    ]) : el('div', { class: 'text-dim text-sm', text: 'Nothing logged today.' })
  ]));

  // Recent activity
  const recent = [...d.self_study].sort((a, b) => b.created.localeCompare(a.created)).slice(0, 5);
  c.appendChild(el('div', { class: 'card fade-in' }, [
    el('div', { class: 'card-title', text: 'Recent Activity' }),
    recent.length ? el('table', {}, [
      el('thead', {}, el('tr', {}, [
        el('th', { text: 'Date' }), el('th', { text: 'Subject / Skill' }), el('th', { text: 'Time' }), el('th', { text: 'Status' })
      ])),
      el('tbody', {}, recent.map(r => {
        const subj = cfg.subjects.find(s => s.id === r.subject_id);
        const skill = cfg.skills.find(s => s.id === r.skill_id);
        const name = subj?.name || (skill ? `${skill.name}` : ' - ');
        return el('tr', {}, [
          el('td', { text: r.date }),
          el('td', { text: name }),
          el('td', { text: r.minutes + 'min' }),
          el('td', {}, el('span', { class: `tag tag-${r.status === 'Done' ? 'done' : r.status === 'Partial' ? 'partial' : 'absent'}`, text: r.status }))
        ]);
      }))
    ]) : el('div', { class: 'text-dim text-sm', text: 'No activity yet.' })
  ]));
}

function playChime(freq) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq || 660;
    gain.gain.setValueAtTime(0.18, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.5);
  } catch (e) { /* ignore */ }
}

function formatClock(totalSeconds) {
  totalSeconds = Math.max(0, Math.round(totalSeconds));
  const h = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const s = String(totalSeconds % 60).padStart(2, '0');
  return h === '00' ? `${m}:${s}` : `${h}:${m}:${s}`;
}

// ── Shared, server-authoritative active timer (see also the
// LIVE SYNC block near the top of this file) ──
// `activeTimer` (declared up top) is the ONLY source of truth for
// "is a timer running/paused right now, and what does it look like"
// refreshed on app load, on switching profiles, and right after this
// window's own start/pause/resume/stop actions (see
// refreshActiveTimerFromServer below).

async function refreshActiveTimerFromServer() {
  try {
    const resp = await api(`/api/${currentProfile}/timer/active`);
    activeTimer = resp.timer;
  } catch (e) { /* transient hiccup - the next explicit refresh will catch up */ }
}

// ── Live-ticking numbers (both the mini badge and, if mounted, the
// big Dashboard display) - purely a local per-second repaint computed
// from the last-known server state + wall-clock time. No network call. ──
const TIMER_RING_CIRCUMFERENCE = 2 * Math.PI * 88; // matches the r=88 circles in renderTimerWidget's ring SVG

function setTimerRingProgress(fraction, indeterminate) {
  const ring = document.getElementById('timerRingProgress');
  if (!ring) return;
  if (indeterminate) {
    // No planned-minutes target to measure against - rather than a
    // stalled, meaningless full or empty ring, hold it at a fixed
    // partial arc; the pulsing glow (see .timer-running) is what
    // communicates "actively running" instead of the fill amount.
    ring.style.strokeDashoffset = `${TIMER_RING_CIRCUMFERENCE * 0.72}`;
  } else {
    const f = Math.max(0, Math.min(1, fraction || 0));
    ring.style.strokeDashoffset = `${TIMER_RING_CIRCUMFERENCE * (1 - f)}`;
  }
}

function paintTimerNumbers() {
  const t = activeTimer;
  const displayEl = document.getElementById('timerDisplay');
  const ringWrapEl = document.getElementById('timerRingWrap');
  const modeLabelEl = document.getElementById('timerRingModeLabel');
  if (displayEl) {
    if (!t) {
      displayEl.textContent = '00:00:00';
      if (modeLabelEl) modeLabelEl.textContent = 'Ready to focus';
      if (ringWrapEl) ringWrapEl.classList.remove('timer-running', 'timer-paused', 'timer-break');
      setTimerRingProgress(0);
    } else if (t.mode === 'pomodoro') {
      if (t.status === 'awaiting_rating' || !t.phase_ends_at) {
        displayEl.textContent = '00:00:00';
        if (modeLabelEl) modeLabelEl.textContent = 'Complete!';
        setTimerRingProgress(1);
        if (ringWrapEl) { ringWrapEl.classList.add('timer-running'); ringWrapEl.classList.remove('timer-paused', 'timer-break'); }
      } else {
        const remaining = Math.max(0, (Date.parse(t.phase_ends_at) - Date.now()) / 1000);
        displayEl.textContent = formatClock(remaining);
        const totalPhaseSeconds = (t.phase_minutes || 25) * 60;
        const fraction = totalPhaseSeconds > 0 ? (totalPhaseSeconds - remaining) / totalPhaseSeconds : 0;
        setTimerRingProgress(fraction);
        const onBreak = t.phase !== 'work';
        if (modeLabelEl) modeLabelEl.textContent = onBreak ? 'On Break' : 'Focusing';
        if (ringWrapEl) { ringWrapEl.classList.add('timer-running'); ringWrapEl.classList.remove('timer-paused'); ringWrapEl.classList.toggle('timer-break', onBreak); }
      }
    } else {
      const openExtra = t.open_segment_since ? Math.max(0, (Date.now() - Date.parse(t.open_segment_since)) / 1000) : 0;
      const elapsed = (t.accumulated_seconds || 0) + openExtra;
      displayEl.textContent = formatClock(elapsed);
      if (t.planned_minutes > 0) setTimerRingProgress(elapsed / (t.planned_minutes * 60));
      else setTimerRingProgress(0, true);
      const statusEl = document.getElementById('timerStatusDiv');
      if (statusEl && t.status === 'running' && t.planned_minutes > 0 && elapsed / 60 >= t.planned_minutes) {
        statusEl.innerHTML = '<span style="color:var(--green)">Planned time reached!</span>';
      }
      const paused = t.status === 'paused';
      if (modeLabelEl) modeLabelEl.textContent = paused ? 'Paused' : 'Focusing';
      if (ringWrapEl) {
        ringWrapEl.classList.remove('timer-break');
        ringWrapEl.classList.toggle('timer-running', !paused);
        ringWrapEl.classList.toggle('timer-paused', paused);
      }
    }
  }
  updateMiniTimerBadge();
}

// ── Mini timer badge (topbar) ──
// Keeps a running/paused/awaiting-rating session visible in the topbar
// on every page except the Dashboard (which already shows the full
// widget) - and now reflects whichever device is actually driving the
// session, not just this one.
function updateMiniTimerBadge() {
  const badge = $('#miniTimerBadge');
  if (!badge) return;
  const t = activeTimer;
  if (!t || currentPage === 'dashboard') {
    badge.classList.add('hidden');
    badge.classList.remove('paused');
    badge.innerHTML = '';
    return;
  }
  badge.classList.remove('hidden');
  badge.innerHTML = '';
  let icon, timeText, label, paused = false;
  if (t.mode === 'pomodoro') {
    if (t.status === 'awaiting_rating') {
      icon = ''; timeText = '00:00'; label = 'Done - tap to rate';
    } else {
      icon = t.phase === 'work' ? '' : (t.phase === 'long' ? '' : '');
      const remaining = Math.max(0, (Date.parse(t.phase_ends_at) - Date.now()) / 1000);
      timeText = formatClock(remaining);
      label = t.phase === 'work' ? `Block ${t.phase_block}/${t.pomodoro_total_blocks}` : 'Break';
    }
  } else {
    const openExtra = t.open_segment_since ? Math.max(0, (Date.now() - Date.parse(t.open_segment_since)) / 1000) : 0;
    timeText = formatClock((t.accumulated_seconds || 0) + openExtra);
    paused = t.status === 'paused';
    icon = paused ? '⏸' : '⏱';
    label = paused ? 'Paused' : 'Focusing';
  }
  badge.classList.toggle('paused', paused);
  badge.appendChild(el('span', { text: icon }));
  badge.appendChild(el('span', { class: 'mini-timer-time', text: timeText }));
  badge.appendChild(el('span', { class: 'mini-timer-label', text: label }));
}

function renderTimerWidget() {
  // The circular progress ring is built via a raw SVG string (see
  // .html handling in el()) rather than el()'s normal
  // document.createElement path, since createElement can't produce
  // real SVG-namespaced elements - assigning innerHTML with an <svg>
  // string is what lets the browser infer the correct namespace.
  const display = el('div', { class: 'timer-display', id: 'timerDisplay', text: '00:00:00' });
  const ringModeLabel = el('div', { class: 'timer-ring-mode-label', id: 'timerRingModeLabel', text: 'Ready to focus' });
  const timerRingWrap = el('div', {
    class: 'timer-ring-wrap', id: 'timerRingWrap',
    html: `<svg class="timer-ring-svg" viewBox="0 0 200 200">
      <circle class="timer-ring-track" cx="100" cy="100" r="88"></circle>
      <circle class="timer-ring-progress" id="timerRingProgress" cx="100" cy="100" r="88"></circle>
    </svg>`
  }, [el('div', { class: 'timer-ring-center' }, [display, ringModeLabel])]);
  const phaseLabel = el('div', { class: 'text-center text-dim text-sm', style: 'min-height:20px;font-weight:600' });
  const subjectSel = el('select', {}, [
    el('option', { value: '', text: 'Select subject or skill...' }),
    ...buildSubjectSkillOptionGroups(cachedConfig, { activeOnly: true })
  ]);
  const plannedInput = el('input', { type: 'number', value: '30', min: '1', placeholder: 'Planned minutes' });
  const statusDiv = el('div', { class: 'text-center text-dim text-sm', id: 'timerStatusDiv', style: 'min-height:24px' });
  const startBtn = el('button', { class: 'btn btn-success', text: '▶ Start', onclick: () => startFreeTimer() });
  const pauseBtn = el('button', { class: 'btn btn-amber hidden', text: '⏸ Pause', onclick: () => pauseFreeTimer() });
  const resumeBtn = el('button', { class: 'btn btn-success hidden', text: '▶ Resume', onclick: () => resumeFreeTimer() });
  const stopBtn = el('button', { class: 'btn btn-danger hidden', text: '⏹ Stop & Save', onclick: () => stopActiveTimer() });
  const cancelBtn = el('button', { class: 'btn btn-outline hidden', text: 'Cancel', onclick: () => cancelActiveTimer() });

  // Pomodoro config inputs
  const workInput = el('input', { type: 'number', value: '25', min: '1', style: 'width:70px' });
  const shortBreakInput = el('input', { type: 'number', value: '5', min: '1', style: 'width:70px' });
  const longBreakInput = el('input', { type: 'number', value: '15', min: '1', style: 'width:70px' });
  const blocksInput = el('input', { type: 'number', value: '4', min: '1', style: 'width:70px' });
  const longEveryInput = el('input', { type: 'number', value: '4', min: '1', style: 'width:70px' });
  const estimateDiv = el('div', { class: 'text-dim text-sm mt-8' });
  const pomoStartBtn = el('button', { class: 'btn btn-success', text: '▶ Start Pomodoro', onclick: () => startPomodoroTimer() });
  const pomoStopBtn = el('button', { class: 'btn btn-danger hidden', text: '⏹ Stop & Save', onclick: () => stopActiveTimer() });
  const pomoSkipBtn = el('button', { class: 'btn btn-outline hidden', text: '⏭ Skip Phase', onclick: () => advancePomodoroPhase() });
  const pomoCancelBtn = el('button', { class: 'btn btn-outline hidden', text: 'Cancel', onclick: () => cancelActiveTimer() });

  function estimateTotal() {
    const work = parseInt(workInput.value) || 25;
    const shortB = parseInt(shortBreakInput.value) || 5;
    const longB = parseInt(longBreakInput.value) || 15;
    const blocks = parseInt(blocksInput.value) || 4;
    const every = parseInt(longEveryInput.value) || 4;
    let total = blocks * work;
    for (let i = 1; i < blocks; i++) {
      total += (i % every === 0) ? longB : shortB;
    }
    const h = Math.floor(total / 60), m = total % 60;
    estimateDiv.textContent = `Estimated total: ${h > 0 ? h + 'h ' : ''}${m}min (${blocks} work block${blocks === 1 ? '' : 's'})`;
    return total;
  }
  [workInput, shortBreakInput, longBreakInput, blocksInput, longEveryInput].forEach(inp => inp.addEventListener('input', estimateTotal));

  const modeFreeBtn = el('button', { class: 'btn btn-sm', text: '⏱ Free Timer', onclick: () => setIdleModePreview('free') });
  const modePomoBtn = el('button', { class: 'btn btn-sm btn-outline', text: 'Pomodoro', onclick: () => setIdleModePreview('pomodoro') });
  const modeTabs = el('div', { class: 'btn-group', style: 'margin-bottom:12px' }, [modeFreeBtn, modePomoBtn]);

  const freePanel = el('div', {}, [
    el('div', { class: 'row', style: 'margin-bottom:12px;gap:12px' }, [
      el('div', { style: 'width:120px' }, [el('label', { text: 'Planned (min)' }), plannedInput])
    ]),
    el('div', { class: 'timer-controls' }, [startBtn, pauseBtn, resumeBtn, stopBtn, cancelBtn])
  ]);

  const pomoPanel = el('div', { class: 'hidden' }, [
    el('div', { class: 'row', style: 'gap:10px;flex-wrap:wrap;margin-bottom:4px' }, [
      el('div', {}, [el('label', { text: 'Work (min)' }), workInput]),
      el('div', {}, [el('label', { text: 'Short Break' }), shortBreakInput]),
      el('div', {}, [el('label', { text: 'Long Break' }), longBreakInput]),
      el('div', {}, [el('label', { text: 'Blocks' }), blocksInput]),
      el('div', {}, [el('label', { text: 'Long Every' }), longEveryInput])
    ]),
    estimateDiv,
    el('div', { class: 'timer-controls', style: 'margin-top:8px' }, [pomoStartBtn, pomoStopBtn, pomoSkipBtn, pomoCancelBtn])
  ]);

  // Local-only mode PREVIEW - only meaningful while idle (no timer
  // active anywhere), just deciding which config panel shows before
  // Start is pressed. The instant a timer is active (from ANY device),
  // the widget's mode is dictated entirely by the server's
  // activeTimer.mode instead, and these tabs are hidden.
  let idleModePreview = 'free';
  function setIdleModePreview(m) {
    if (activeTimer) return; // ignore while something's already running
    idleModePreview = m;
    freePanel.classList.toggle('hidden', m !== 'free');
    pomoPanel.classList.toggle('hidden', m !== 'pomodoro');
    modeFreeBtn.classList.toggle('btn-outline', m !== 'free');
    modePomoBtn.classList.toggle('btn-outline', m !== 'pomodoro');
  }

  function currentSubjectPayload() {
    const val = subjectSel.value;
    if (!val) return null;
    return val.startsWith('skill_') ? { skill_id: val.slice(6) } : { subject_id: val };
  }

  function handleStartResponse(resp) {
    activeTimer = resp.timer;
    if (resp.joined_existing) {
      statusDiv.innerHTML = '<span style="color:var(--accent)">↺ Joined a session already running on another device.</span>';
    }
    applyStateToDOM();
    paintTimerNumbers();
  }

  async function startFreeTimer() {
    const subj = currentSubjectPayload();
    if (!subj) { alert('Select a subject or skill'); return; }
    const planned = parseInt(plannedInput.value) || 0;
    try {
      const resp = await api(`/api/${currentProfile}/timer/start`, { method: 'POST', body: JSON.stringify({ ...subj, planned_minutes: planned, mode: 'free' }) });
      handleStartResponse(resp);
    } catch (e) { alert('Could not start timer: ' + e.message); }
  }

  async function startPomodoroTimer() {
    const subj = currentSubjectPayload();
    if (!subj) { alert('Select a subject or skill'); return; }
    const config = {
      work: parseInt(workInput.value) || 25, short: parseInt(shortBreakInput.value) || 5,
      long: parseInt(longBreakInput.value) || 15, blocks: parseInt(blocksInput.value) || 4,
      every: parseInt(longEveryInput.value) || 4
    };
    try {
      const resp = await api(`/api/${currentProfile}/timer/start`, { method: 'POST', body: JSON.stringify({ ...subj, mode: 'pomodoro', pomodoro_config: config }) });
      handleStartResponse(resp);
      if (!resp.joined_existing) playChime(660);
    } catch (e) { alert('Could not start: ' + e.message); }
  }

  async function pauseFreeTimer() {
    if (!activeTimer) return;
    try {
      const resp = await api(`/api/${currentProfile}/timer/${activeTimer.id}/pause`, { method: 'POST' });
      activeTimer = resp.timer; applyStateToDOM(); paintTimerNumbers();
    } catch (e) { alert(e.message); await refreshActiveTimerFromServer(); applyStateToDOM(); }
  }

  async function resumeFreeTimer() {
    if (!activeTimer) return;
    try {
      const resp = await api(`/api/${currentProfile}/timer/${activeTimer.id}/resume`, { method: 'POST' });
      activeTimer = resp.timer; applyStateToDOM(); paintTimerNumbers();
    } catch (e) { alert(e.message); await refreshActiveTimerFromServer(); applyStateToDOM(); }
  }

  async function advancePomodoroPhase() {
    if (!activeTimer) return;
    try {
      const resp = await api(`/api/${currentProfile}/timer/${activeTimer.id}/pomodoro_advance`, { method: 'POST' });
      activeTimer = resp.timer; applyStateToDOM(); paintTimerNumbers(); playChime(activeTimer.status === 'awaiting_rating' ? 880 : 660);
    } catch (e) { alert(e.message); await refreshActiveTimerFromServer(); applyStateToDOM(); }
  }

  function findSubjectOrSkillDifficulty(subjectId, skillId) {
    if (subjectId) return cachedConfig?.subjects.find(s => s.id === subjectId)?.difficulty || 5;
    if (skillId) return cachedConfig?.skills.find(s => s.id === skillId)?.difficulty || 5;
    return 5;
  }

  async function stopActiveTimer() {
    if (!activeTimer) return;
    const t = activeTimer;
    // Purely a client-side estimate to decide whether to show the
    // rating modal at all - the server recomputes the real, final
    // number authoritatively the moment /stop is actually called.
    let estMinutes;
    if (t.mode === 'pomodoro') {
      estMinutes = Math.round(t.work_minutes_done || 0);
    } else {
      const openExtra = t.open_segment_since ? (Date.now() - Date.parse(t.open_segment_since)) / 60000 : 0;
      estMinutes = Math.round((t.accumulated_seconds || 0) / 60 + openExtra);
    }
    if (estMinutes <= 0) {
      try { await api(`/api/${currentProfile}/timer/${t.id}/stop`, { method: 'POST', body: JSON.stringify({ discard: true }) }); }
      catch (e) { /* non-fatal - nothing meaningful to lose */ }
      activeTimer = null;
      await refreshActiveTimerFromServer();
      applyStateToDOM();
      statusDiv.innerHTML = '<span class="text-dim">No study time logged - nothing saved.</span>';
      setTimeout(() => { statusDiv.textContent = ''; }, UI_STATUS_MESSAGE_CLEAR_MS);
      return;
    }
    showSessionRatingModal(estMinutes, t, async (rating) => {
      try {
        const resp = await api(`/api/${currentProfile}/timer/${t.id}/stop`, {
          method: 'POST', body: JSON.stringify({ difficulty: rating.difficulty, self_study_status: rating.status, note: rating.note })
        });
        statusDiv.innerHTML = `<span style="color:var(--green)">Saved: ${resp.actual_minutes}min${resp.day_buckets.length > 1 ? ` across ${resp.day_buckets.length} days` : ''}</span>`;
        activeTimer = null;
        await loadData(); await maybeShowLevelUp({ skipXpToast: true }); render();
        if (resp && resp.xp_earned > 0) showSessionXpToast(resp.xp_earned, resp.actual_minutes, rating.difficulty, resp.nerds_earned || 0);
      } catch (e) {
        statusDiv.innerHTML = `<span style="color:var(--red)">Error: ${esc(e.message)}</span>`;
        await refreshActiveTimerFromServer(); applyStateToDOM();
      }
      setTimeout(() => { statusDiv.textContent = ''; }, UI_STATUS_MESSAGE_CLEAR_MS);
    });
  }

  async function cancelActiveTimer() {
    if (!activeTimer) return;
    if (!confirm('Cancel this session without saving any study time?')) return;
    try { await api(`/api/${currentProfile}/timer/${activeTimer.id}/cancel`, { method: 'POST' }); }
    catch (e) { alert(e.message); }
    activeTimer = null;
    await refreshActiveTimerFromServer();
    applyStateToDOM();
  }

  function showSessionRatingModal(actualMin, timer, onConfirm) {
    const diffInput = el('input', { type: 'range', min: '1', max: '10', value: String(findSubjectOrSkillDifficulty(timer.subject_id, timer.skill_id)) });
    const diffLabel = el('span', { text: diffInput.value + '/10', style: 'font-weight:700' });
    diffInput.oninput = () => diffLabel.textContent = diffInput.value + '/10';
    const statusSel = el('select', {}, [
      el('option', { value: 'Done', text: 'Done - completed as planned' }),
      el('option', { value: 'Partial', text: 'Partial - got through some of it' }),
      el('option', { value: 'Skipped', text: "Skipped - didn't really study" })
    ]);
    const noteInput = el('textarea', { placeholder: 'Optional note...' });
    const content = el('div', {}, [
      el('div', { class: 'modal-header' }, [el('div', { class: 'modal-title', text: '⏱ Rate This Session' })]),
      el('div', { class: 'text-dim text-sm mb-8', text: `You studied for ${actualMin} minute${actualMin === 1 ? '' : 's'}. How did it go?` }),
      el('label', { text: 'Difficulty' }), el('div', { class: 'row' }, [diffInput, diffLabel]),
      el('label', { text: 'Status' }), statusSel,
      el('label', { text: 'Note' }), noteInput,
      el('div', { class: 'btn-group', style: 'margin-top:16px;justify-content:flex-end' }, [
        el('button', { class: 'btn', text: 'Save Session', onclick: () => {
          closeModal();
          onConfirm({ difficulty: parseInt(diffInput.value), status: statusSel.value, note: noteInput.value });
        }})
      ])
    ]);
    showModal(content);
  }

  // ── Paint the widget's DOM to match the current `activeTimer`
  // (module-global) - called on mount and after every local action. ──
  function applyStateToDOM() {
    const t = activeTimer;
    if (!t) {
      modeTabs.classList.remove('hidden');
      setIdleModePreview(idleModePreview);
      subjectSel.disabled = false; plannedInput.disabled = false;
      startBtn.classList.remove('hidden'); pauseBtn.classList.add('hidden');
      resumeBtn.classList.add('hidden'); stopBtn.classList.add('hidden'); cancelBtn.classList.add('hidden');
      pomoStartBtn.classList.remove('hidden'); pomoStopBtn.classList.add('hidden');
      pomoSkipBtn.classList.add('hidden'); pomoCancelBtn.classList.add('hidden');
      [workInput, shortBreakInput, longBreakInput, blocksInput, longEveryInput, subjectSel].forEach(i => i.disabled = false);
      display.textContent = '00:00:00';
      phaseLabel.textContent = '';
      return;
    }
    // Something is active - from THIS device or another. Mode tabs are
    // locked to whichever mode is actually running; subject/skill is
    // shown read-only, matching whichever device originally started it.
    modeTabs.classList.add('hidden');
    const subjVal = t.subject_id || (t.skill_id ? 'skill_' + t.skill_id : '');
    if (subjVal) subjectSel.value = subjVal;
    subjectSel.disabled = true;

    if (t.mode === 'pomodoro') {
      freePanel.classList.add('hidden');
      pomoPanel.classList.remove('hidden');
      [workInput, shortBreakInput, longBreakInput, blocksInput, longEveryInput].forEach(i => i.disabled = true);
      if (t.pomodoro_config) {
        workInput.value = t.pomodoro_config.work; shortBreakInput.value = t.pomodoro_config.short;
        longBreakInput.value = t.pomodoro_config.long; blocksInput.value = t.pomodoro_config.blocks;
        longEveryInput.value = t.pomodoro_config.every;
        estimateTotal();
      }
      pomoStartBtn.classList.add('hidden');
      pomoStopBtn.classList.remove('hidden');
      pomoCancelBtn.classList.remove('hidden');
      if (t.status === 'awaiting_rating') {
        pomoSkipBtn.classList.add('hidden');
        phaseLabel.textContent = 'Pomodoro complete - press Stop & Save to rate it!';
      } else {
        pomoSkipBtn.classList.remove('hidden');
        const icon = t.phase === 'work' ? '' : (t.phase === 'long' ? '' : '');
        const label = t.phase === 'work' ? `Work Block ${t.phase_block}/${t.pomodoro_total_blocks}` : (t.phase === 'long' ? 'Long Break' : 'Short Break');
        phaseLabel.textContent = `${icon} ${label}`;
      }
    } else {
      pomoPanel.classList.add('hidden');
      freePanel.classList.remove('hidden');
      plannedInput.value = t.planned_minutes || plannedInput.value;
      plannedInput.disabled = true;
      startBtn.classList.add('hidden');
      stopBtn.classList.remove('hidden');
      cancelBtn.classList.remove('hidden');
      if (t.status === 'running') {
        pauseBtn.classList.remove('hidden'); resumeBtn.classList.add('hidden');
        statusDiv.textContent = `Running... (${t.planned_minutes}min planned)`;
      } else {
        pauseBtn.classList.add('hidden'); resumeBtn.classList.remove('hidden');
        statusDiv.innerHTML = '<span style="color:var(--amber)">⏸ Paused</span>';
      }
    }
  }

  estimateTotal();
  applyStateToDOM();
  paintTimerNumbers();

  return el('div', { class: 'timer-widget' }, [
    modeTabs,
    el('div', { class: 'row', style: 'margin-bottom:12px;gap:12px' }, [
      el('div', { class: 'flex-1' }, [el('label', { text: 'Subject / Skill' }), subjectSel])
    ]),
    el('div', { class: 'timer-stage' }, [
      timerRingWrap,
      phaseLabel,
      statusDiv
    ]),
    freePanel,
    pomoPanel
  ]);
}


// ═══════════════════════════════════════════
// TIMETABLE
// ═══════════════════════════════════════════
// Rebuilt as a real absolute-positioned calendar. The previous version had
// two bugs: (1) any exam or one-time event without both a start AND end
// time was treated as "all day" by timeInRange() and rendered into every
// single one of the 24 hourly rows for that date (an exam at 09:00 would
// visually appear at 00:00, 01:00, 02:00 ... 23:00). (2) even correctly
// scoped items were drawn once per hour cell they touched, so a 2-hour
// class showed up as two separate duplicate-labelled blocks instead of one
// block spanning two hours. Both are fixed by computing each event's pixel
// position/height once and placing it in a positioned day column.
// Recurrence for a schedule slot: weekly (default), biweekly, triweekly,
// monthly (every 4 weeks). anchor_date picks WHICH week it first shows in.
function scheduleSlotAppliesOnDate(sch, dateStr) {
  // Edited slots are versioned: a changed/removed slot is closed with an
  // effective_to date and (if changed) replaced by a new slot with an
  // effective_from date, so past weeks keep the schedule they really had.
  if (sch.effective_from && dateStr < sch.effective_from) return false;
  if (sch.effective_to && dateStr > sch.effective_to) return false;
  const rec = sch.recurrence || 'weekly';
  if (rec === 'weekly' || !sch.anchor_date) return true;
  const interval = rec === 'biweekly' ? 2 : rec === 'triweekly' ? 3 : rec === 'monthly' ? 4 : 1;
  const mondayOf = (s) => { const d = localDateFromStr(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; };
  const weeks = Math.round((mondayOf(dateStr) - mondayOf(sch.anchor_date)) / (7 * 86400000));
  return weeks >= 0 && weeks % interval === 0;
}
// Global holidays (Settings): apply to every academic year. 'yearly' ones
// repeat on the same month/day each year (ranges may wrap New Year).
function globalHolidayOn(dateStr, cfg) {
  const md = dateStr.slice(5);
  for (const h of (cfg?.global_holidays || [])) {
    const s = h.start_date, e = h.end_date || h.start_date;
    if (!s) continue;
    if (h.yearly) {
      const sm = s.slice(5), em = (e || s).slice(5);
      if (sm <= em ? (md >= sm && md <= em) : (md >= sm || md <= em)) return h;
    } else if (dateStr >= s && dateStr <= e) return h;
  }
  return null;
}
// Finds the attendance record for ONE schedule slot (a lab taught twice a week
// can be present for one part and absent for the other).
function findSlotAttendance(list, subjectId, dateStr, sch) {
  const type = (sch && sch.type) || 'C';
  const sid = (sch && sch.id) || '';
  const cands = (list || []).filter(a => a.subject_id === subjectId && a.date === dateStr && a.type === type);
  return cands.find(a => sid && a.slot_id === sid) || cands.find(a => !a.slot_id) || null;
}
function timeToMinutes(t) {
  if (!t) return null;
  const [h, m] = t.split(':').map(n => parseInt(n) || 0);
  return h * 60 + m;
}
function minutesToTime(mins) {
  mins = Math.max(0, Math.min(24 * 60 - 1, mins));
  const h = Math.floor(mins / 60), m = Math.round(mins % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// Describes a focus record's FULL session for a Timetable block's
// tooltip - used for every block belonging to that session (study or
// break segment alike), so hovering any one piece reads like hovering
// the whole functional unit rather than just that slice of it.
function sessionTooltip(r, label) {
  const segments = (r.segments || []).filter(s => s.start && s.end);
  label = label || 'Focus';
  if (!segments.length) {
    return `${label} - ${r.status} (${r.minutes}min)`;
  }
  const studyBlocks = segments.filter(s => s.type === 'study');
  const breakBlocks = segments.filter(s => s.type === 'break');
  const overallStart = segments.reduce((min, s) => s.start < min ? s.start : min, segments[0].start);
  const overallEnd = segments.reduce((max, s) => s.end > max ? s.end : max, segments[0].end);
  const breakMin = breakBlocks.reduce((sum, s) => sum + Math.max(0, timeToMinutes(s.end) - timeToMinutes(s.start)), 0);
  const parts = [`${label} - ${r.status}`, `${overallStart}–${overallEnd}`, `${r.minutes}min studied`];
  if (breakMin > 0) parts.push(`${breakMin}min break (${breakBlocks.length} block${breakBlocks.length === 1 ? '' : 's'})`);
  if (studyBlocks.length > 1) parts.push(`${studyBlocks.length} study blocks`);
  return parts.join(' · ');
}

async function renderTimetable(c) {
  try { await api(`/api/${currentProfile}/attendance/autofill`, { method: 'POST' }); await loadData(); } catch (e) { /* non-fatal */ }
  const cfg = cachedConfig || { subjects: [], academic_years: [] };
  const d = cachedData || { attendance: [], exams: [], events: [], self_study: [] };
  const subjById = {};
  (cfg.subjects || []).forEach(s => subjById[s.id] = s);
  const skillById = {};
  (cfg.skills || []).forEach(s => skillById[s.id] = s);
  const yearById = {};
  (cfg.academic_years || []).forEach(y => yearById[y.id] = y);

  c.innerHTML = '';
  c.appendChild(el('div', { class: 'row', style: 'margin-bottom:16px;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px' }, [
    el('h2', { text: 'Timetable' }),
    el('div', { class: 'btn-group' }, [
      el('button', { class: 'btn btn-sm btn-outline', text: '+ Add Subject to Schedule', onclick: showAddSubjectModal }),
      el('button', { class: 'btn btn-sm btn-outline', text: '+ Schedule a Skill', onclick: showAddSkillScheduleModal })
    ])
  ]));

  // Year filter - now actually filters (previously the dropdown existed
  // but its value was never read anywhere, so picking a year did nothing).
  const yearSel = el('select', { style: 'width:auto;min-width:150px', onchange: () => { renderAll(); } }, [
    el('option', { value: '', text: 'All years' }),
    ...(cfg.academic_years || []).map(y => el('option', { value: y.id, text: y.label }))
  ]);

  // Week navigation
  function getWeekStart(dt) {
    const date = new Date(dt);
    const day = date.getDay();
    const diff = date.getDate() - day + (day === 0 ? -6 : 1); // Monday start
    date.setDate(diff);
    date.setHours(0, 0, 0, 0);
    return date;
  }
  let currentWeekStart = getWeekStart(new Date());
  const weekLabel = el('span', { style: 'margin:0 12px;font-weight:600;white-space:nowrap' });
  function formatWeekLabel(ws) {
    const we = new Date(ws);
    we.setDate(we.getDate() + 6);
    return `${ws.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${we.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }

  const calendarHost = el('div', { class: 'calendar-wrap fade-in' });

  function subjectInSelectedYear(sub) {
    if (!yearSel.value) return true;
    return sub.year_id === yearSel.value;
  }

  function dateInRange(dateStr, start, end) {
    if (!start || !end) return false;
    return dateStr >= start && dateStr <= end;
  }

  // A subject's recurring weekly schedule used to repeat forever,
  // regardless of the academic year it was assigned to. Now it's bounded
  // to that year's start/end dates, and additionally suppressed (1) inside
  // any of that year's exam periods, where ONLY exams should populate the
  // timetable, and (2) inside any vacation week, which has 0 lesson hours.
  // Exams themselves are never affected by any of this - they can exist
  // inside or outside exam periods/vacations freely.
  function isLessonSuppressed(dateStr, sub) {
    if (globalHolidayOn(dateStr, cfg)) return true;
    const yr = sub.year_id ? yearById[sub.year_id] : null;
    if (!yr) return false;
    if (yr.start_date && yr.end_date && !dateInRange(dateStr, yr.start_date, yr.end_date)) return true;
    if ((yr.exam_periods || []).some(p => dateInRange(dateStr, p.start_date, p.end_date))) return true;
    if ((yr.vacation_weeks || []).some(v => dateInRange(dateStr, v.start_date, v.end_date))) return true;
    return false;
  }

  // Assigns each timed event to a horizontal "lane" so events that
  // overlap in time are laid out side-by-side instead of stacking
  // directly on top of each other. laneCount is scoped to each
  // connected cluster of overlapping events (not the whole day), so a
  // busy 2-hour block doesn't force every other unrelated event that
  // day to also shrink.
  function assignLanes(events) {
    const sorted = [...events].sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
    const laneEnds = []; // laneEnds[i] = end time of the last event placed in lane i
    const placed = sorted.map(ev => {
      let lane = laneEnds.findIndex(endTime => endTime <= ev.start);
      if (lane === -1) { lane = laneEnds.length; laneEnds.push(ev.end); }
      else { laneEnds[lane] = ev.end; }
      return { ev, lane };
    });
    // Group into connected overlap clusters to compute a lane count
    // local to each cluster.
    let clusterMaxEnd = -Infinity;
    let cluster = [];
    const clusters = [];
    placed.forEach(item => {
      if (cluster.length && item.ev.start >= clusterMaxEnd) {
        clusters.push(cluster);
        cluster = [];
        clusterMaxEnd = -Infinity;
      }
      cluster.push(item);
      clusterMaxEnd = Math.max(clusterMaxEnd, item.ev.end);
    });
    if (cluster.length) clusters.push(cluster);
    clusters.forEach(cl => {
      const laneCount = Math.max(...cl.map(c => c.lane)) + 1;
      cl.forEach(c => { c.laneCount = laneCount; });
    });
    return placed;
  }

  function buildDayEvents(dateStr) {
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const dayName = dayNames[localDateFromStr(dateStr).getDay()];
    const timed = [];   // { start, end, label, sub, cls }
    const allDay = [];  // { label, cls }
    const gHol = globalHolidayOn(dateStr, cfg);
    if (gHol) allDay.push({ label: gHol.label || 'Holiday', cls: 'event', kind: 'holiday' });

    // Subject schedule blocks - bounded to the assigned year's dates, and
    // suppressed during that year's exam periods / vacation weeks.
    (cfg.subjects || []).forEach(sub => {
      if (sub.archived) return;
      if (!subjectInSelectedYear(sub)) return;
      if (isLessonSuppressed(dateStr, sub)) return;
      (sub.schedule || []).forEach(sch => {
        if (sch.day !== dayName) return;
        if (!scheduleSlotAppliesOnDate(sch, dateStr)) return;
        const schType = sch.type || 'C';
        // Marked absent for this exact lesson slot - the person wasn't
        // there (they may have self-studied instead, which already
        // shows up separately), so don't clutter the calendar with a
        // lesson that didn't happen for them.
        const attRecord = findSlotAttendance(d.attendance, sub.id, dateStr, sch);
        if (attRecord && attRecord.status === 'teacher_absent') return;
        // Teacher absence isn't the student's absence - the lesson is
        // kept visible (not hidden) but styled as incomplete/barred, the
        // same visual language as a break block, so it still reads as
        // "this slot existed" without looking like a normal completed
        // lesson.
        const isAbsent = !!(attRecord && attRecord.status === 'absent');
        const start = timeToMinutes(sch.start || '08:00');
        const end = timeToMinutes(sch.end || sch.start || '09:00');
        timed.push({
          start, end: Math.max(end, start + 15),
          label: isAbsent ? `${sub.name} (Absent)` : `${sub.name}`, sub: lessonTypeLabel(schType) + (sch.part ? ` (${sch.part})` : ''),
          cls: isAbsent ? 'absent' : schType.toLowerCase(),
          color: sub.color, kind: 'subject', ref: { sub, sch }, dateStr
        });
      });
    });

    // Skill schedule blocks - NOT suppressed by exam periods/vacations;
    // vacations in particular are explicitly meant to still allow
    // focus/self-skilling sessions even though lessons are off.
    (cfg.skills || []).forEach(sk => {
      if (sk.archived) return;
      (sk.schedule || []).forEach(sch => {
        if (sch.day !== dayName) return;
        if (!scheduleSlotAppliesOnDate(sch, dateStr)) return;
        const start = timeToMinutes(sch.start || '08:00');
        const end = timeToMinutes(sch.end || sch.start || '09:00');
        timed.push({
          start, end: Math.max(end, start + 15),
          label: `${sk.name}`, sub: 'Skill',
          cls: 'skill', color: sk.color, kind: 'skillsched', ref: { sk, sch }
        });
      });
    });

    // Exams - end time computed from start_time + duration_minutes, fixing
    // the "shows in every hour of the day" bug.
    (d.exams || []).forEach(ex => {
      if (ex.date !== dateStr) return;
      if (ex.subject_id && subjById[ex.subject_id] && subjById[ex.subject_id].archived) return;
      if (ex.subject_id && subjById[ex.subject_id] && !subjectInSelectedYear(subjById[ex.subject_id])) return;
      const start = timeToMinutes(ex.start_time || '08:00');
      const dur = parseInt(ex.duration_minutes) || 120;
      timed.push({
        start, end: start + dur,
        label: `${ex.name || 'Exam'}`, sub: subjById[ex.subject_id]?.name || '',
        cls: 'exam', color: null, kind: 'exam', ref: ex
      });
    });

    // Logged focus sessions, placed using the time-of-day they
    // were recorded. `created` is when the record was saved, which is
    // the session's end for a timer/pomodoro session and close enough
    // for a manual entry, so it's anchored as the END and worked
    // backward by the session's duration.
    //
    // Timer/pomodoro sessions carry `segments`, the actual study/break
    // sub-blocks recorded while the timer ran. Each segment becomes its
    // own timed block (study normal, break amber), sharing a
    // `groupKey` of the record's id so hovering any one highlights the
    // whole session. Manual entries have no segments and fall back to
    // a single block.
    (d.self_study || []).forEach(r => {
      if (r.date !== dateStr) return;
      const subj = subjById[r.subject_id];
      const skill = skillById[r.skill_id];
      const label = subj ? subj.name : (skill ? skill.name : 'Focus');
      const segments = (r.segments || []).filter(s => s.start && s.end && timeToMinutes(s.end) > timeToMinutes(s.start));

      if (segments.length) {
        segments.forEach((seg, i) => {
          const start = timeToMinutes(seg.start);
          const end = timeToMinutes(seg.end);
          const isBreak = seg.type === 'break';
          timed.push({
            // Use the segment's REAL start/end - no artificial minimum
            // duration here. Segments are drawn back-to-back (a break
            // immediately followed by more study), so padding one of
            // them past its true end pushes it into the next segment's
            // real time slot, which is what caused them to visually
            // overlap/collide. Short segments are instead handled by
            // renderCalendar() dynamically growing the whole week's
            // pixel-per-hour scale so every real block gets a readable
            // minimum height without eating into its neighbor.
            start, end,
            label: isBreak ? 'Break' : `${label}`,
            sub: isBreak ? '' : r.status,
            cls: isBreak ? 'break' : 'selfstudy',
            color: isBreak ? null : (subj?.color || skill?.color || null),
            kind: isBreak ? 'break' : 'selfstudy',
            ref: r, groupKey: r.id, segmentIndex: i, sessionLabel: label
          });
        });
      } else {
        const dur = Math.max(15, r.minutes || 30);
        let endMin = 12 * 60 + 30; // fallback if no usable timestamp
        const timePart = (r.created || '').split('T')[1];
        if (timePart) {
          const [hh, mm] = timePart.split(':').map(n => parseInt(n) || 0);
          endMin = hh * 60 + mm;
        }
        const startMin = Math.max(0, endMin - dur);
        timed.push({
          start: startMin, end: Math.max(startMin + 15, endMin),
          label: `${label}`, sub: r.status,
          cls: 'selfstudy', color: subj?.color || skill?.color || null,
          kind: 'selfstudy', ref: r, groupKey: r.id, sessionLabel: label
        });
      }
    });

    // One-time events - only treated as all-day when there's genuinely no
    // time info (previously ANY missing end_time made it "all day" for
    // every hour row; now it's a single chip shown once, up top).
    // Meetings in particular get their own styling (like a lesson block)
    // rather than being lumped into a generic "event" look.
    (d.events || []).forEach(ev => {
      if (ev.date !== dateStr) return;
      const evCls = ev.type === 'meeting' ? 'meeting' : (ev.type === 'workshop' ? 'workshop' : 'event');
      if (ev.start_time && ev.end_time) {
        const start = timeToMinutes(ev.start_time);
        const end = timeToMinutes(ev.end_time);
        timed.push({ start, end: Math.max(end, start + 15), label: ev.name, sub: ev.type, cls: evCls, color: null, kind: 'oneoff', ref: ev });
      } else if (ev.start_time) {
        const start = timeToMinutes(ev.start_time);
        timed.push({ start, end: start + 60, label: ev.name, sub: ev.type, cls: evCls, color: null, kind: 'oneoff', ref: ev });
      } else {
        allDay.push({ label: ev.name, cls: evCls, kind: 'oneoff', ref: ev });
      }
    });

    return { timed, allDay };
  }

  function renderCalendar() {
    calendarHost.innerHTML = '';
    const days = [];
    for (let i = 0; i < 7; i++) {
      const dt = new Date(currentWeekStart);
      dt.setDate(dt.getDate() + i);
      days.push(dt);
    }
    const dayData = days.map(dt => buildDayEvents(localDateStr(dt)));

    // Fixed full 24-hour range (00:00–24:00).
    let rangeStart = 0, rangeEnd = 24 * 60;
    rangeStart = Math.max(0, rangeStart);
    rangeEnd = Math.min(24 * 60, rangeEnd);
    const totalMins = rangeEnd - rangeStart;

    // pxPerHour normally sits at CAL_BASE_PX_PER_HOUR, but grows for the
    // WHOLE week's grid whenever any real block (most commonly a short
    // Pomodoro break, or a trailing study segment) is shorter than
    // CAL_MIN_BLOCK_PX would need at the base scale. This keeps every
    // block readable at its true, non-overlapping time position instead
    // of the old approach of padding short blocks past their real end
    // time, which pushed them into the next block's slot and made
    // same-session study/break blocks visually collide. Capped at
    // CAL_MAX_PX_PER_HOUR so one freak 1-2 minute entry can't blow the
    // whole calendar out to an unusable height - the trade-off beyond
    // that cap is a thin (but still correctly positioned, non-
    // overlapping) block rather than an ever-taller grid.
    let shortestBlockMinutes = Infinity;
    dayData.forEach(({ timed }) => {
      timed.forEach(ev => {
        const dur = ev.end - ev.start;
        if (dur > 0 && dur < shortestBlockMinutes) shortestBlockMinutes = dur;
      });
    });
    const pxPerHour = Number.isFinite(shortestBlockMinutes)
      ? Math.min(CAL_MAX_PX_PER_HOUR, Math.max(CAL_BASE_PX_PER_HOUR, (CAL_MIN_BLOCK_PX * 60) / shortestBlockMinutes))
      : CAL_BASE_PX_PER_HOUR;
    const totalHeight = (totalMins / 60) * pxPerHour;

    // All-day strip (only rendered if there's something to show)
    const hasAllDay = dayData.some(dd => dd.allDay.length > 0);
    if (hasAllDay) {
      const stripHead = el('div', { class: 'cal-allday-row' }, [el('div', { class: 'cal-time-axis-label', text: 'All day' })]);
      dayData.forEach(({ allDay }) => {
        const cell = el('div', { class: 'cal-allday-cell' });
        allDay.forEach(a => cell.appendChild(el('div', { class: `cal-chip cal-${a.cls}`, text: a.label, onclick: () => a.kind === 'oneoff' && editEvent(a.ref) })));
        stripHead.appendChild(cell);
      });
      calendarHost.appendChild(stripHead);
    }

    // Header row (day names + dates)
    const header = el('div', { class: 'cal-header-row' }, [el('div', { class: 'cal-time-axis-label' })]);
    const todayStr0 = todayStr();
    days.forEach(dt => {
      const dStr = localDateStr(dt);
      const isToday = dStr === todayStr0;
      const isWeekend = dt.getDay() === 0 || dt.getDay() === 6;
      header.appendChild(el('div', { class: `cal-header-cell${isToday ? ' cal-today' : ''}${isWeekend ? ' cal-weekend' : ''}` }, [
        el('div', { class: 'cal-header-day', text: dt.toLocaleDateString('en-US', { weekday: 'short' }) }),
        el('div', { class: 'cal-header-date', text: dt.getDate() })
      ]));
    });
    calendarHost.appendChild(header);

    // Body: time axis + 7 day columns, all absolutely positioned
    const body = el('div', { class: 'cal-body', style: `height:${totalHeight}px;--cal-day-width:calc((100% - var(--cal-axis-width)) / 7)` });

    // Hour gridlines + axis labels
    for (let m = rangeStart; m <= rangeEnd; m += 60) {
      const top = ((m - rangeStart) / totalMins) * totalHeight;
      body.appendChild(el('div', { class: 'cal-hour-line', style: `top:${top}px` }));
      body.appendChild(el('div', { class: 'cal-hour-label', style: `top:${top}px`, text: minutesToTime(m) }));
    }

    // Day columns
    days.forEach((dt, i) => {
      const localDStr = localDateStr(dt);
      const isToday = localDStr === todayStr0;
      const isWeekend = dt.getDay() === 0 || dt.getDay() === 6;
      const col = el('div', {
        class: `cal-day-col${isWeekend ? ' cal-weekend' : ''}`,
        style: `left:calc(var(--cal-axis-width) + (var(--cal-day-width) * ${i}));width:var(--cal-day-width)`
      });

      // Events overlapping in time are laid out side-by-side in lanes
      // (like a normal calendar app) instead of stacking directly on
      // top of each other - a day with several things at once used to
      // render them all at full width, hiding all but the last one.
      assignLanes(dayData[i].timed).forEach(({ ev, lane, laneCount }) => {
        const top = Math.max(0, ((ev.start - rangeStart) / totalMins) * totalHeight);
        // No height floor here on purpose: pxPerHour above is already
        // derived so the week's shortest real block lands at roughly
        // CAL_MIN_BLOCK_PX tall. Adding a floor on top of that would
        // re-introduce the original bug - a block rendering taller than
        // its true time slot and visually eating into whichever
        // block comes right after it. Only pathologically short blocks
        // (shorter than what CAL_MAX_PX_PER_HOUR's cap can comfortably
        // fit) end up as thin slivers instead; they stay perfectly
        // positioned, just less readable, which is the right trade-off.
        const height = ((ev.end - ev.start) / totalMins) * totalHeight;
        const bg = ev.color || null;
        const widthPct = 100 / laneCount;
        const leftPct = lane * widthPct;
        const style = `top:${top}px;height:${height}px;left:calc(${leftPct}% + 1px);width:calc(${widthPct}% - 2px);right:auto;` + (bg ? `background:${bg}22;border-left-color:${bg}` : '');
        // For a session split into multiple study/break blocks, the
        // tooltip describes the WHOLE session (not just this one
        // segment) - hovering any piece should read like hovering the
        // single functional block it represents.
        const tooltip = ev.groupKey ? sessionTooltip(ev.ref, ev.sessionLabel) : `${ev.label}${ev.sub ? ' - ' + ev.sub : ''} (${minutesToTime(ev.start)}–${minutesToTime(ev.end)})`;
        const block = el('div', {
          class: `cal-event cal-${ev.cls}`, style,
          title: tooltip,
          onclick: () => {
            if (ev.kind === 'exam') editExam(ev.ref);
            else if (ev.kind === 'oneoff') editEvent(ev.ref);
            else if (ev.kind === 'subject') showQuickAttendanceModal(ev.ref.sub, ev.ref.sch, ev.dateStr || localDStr);
            else if (ev.kind === 'selfstudy' || ev.kind === 'break') editSelfStudy(ev.ref);
          }
        }, [
          el('div', { class: 'cal-event-title', text: ev.label }),
          height > 32 ? el('div', { class: 'cal-event-sub', text: `${minutesToTime(ev.start)}–${minutesToTime(ev.end)}${ev.sub ? ' · ' + ev.sub : ''}` }) : null
        ]);
        // Sibling-block hover highlighting - a session split into
        // several study/break rectangles should visually light up as
        // ONE unit on hover, even though each piece is a separate DOM
        // node. Grouped purely by groupKey (the focus record id).
        if (ev.groupKey) {
          block.dataset.group = ev.groupKey;
          block.addEventListener('mouseenter', () => {
            calendarHost.querySelectorAll(`.cal-event[data-group="${ev.groupKey}"]`).forEach(sib => sib.classList.add('cal-event-group-hover'));
          });
          block.addEventListener('mouseleave', () => {
            calendarHost.querySelectorAll(`.cal-event[data-group="${ev.groupKey}"]`).forEach(sib => sib.classList.remove('cal-event-group-hover'));
          });
        }
        col.appendChild(block);
      });

      // Current-time indicator
      if (isToday) {
        const now = new Date();
        const nowMins = now.getHours() * 60 + now.getMinutes();
        if (nowMins >= rangeStart && nowMins <= rangeEnd) {
          const top = ((nowMins - rangeStart) / totalMins) * totalHeight;
          col.appendChild(el('div', { class: 'cal-now-line', style: `top:${top}px` }));
        }
      }

      body.appendChild(col);
    });

    calendarHost.appendChild(body);

    if (!(cfg.subjects || []).length && !(d.exams || []).length && !(d.events || []).length) {
      calendarHost.appendChild(el('div', { class: 'text-dim text-center text-sm', style: 'padding:24px', text: 'Nothing scheduled yet. Add a subject, exam, or event to see it here.' }));
    }
  }

  function renderAll() {
    weekLabel.textContent = formatWeekLabel(currentWeekStart);
    renderCalendar();
  }

  c.appendChild(el('div', { class: 'card fade-in' }, [
    el('div', { class: 'row', style: 'margin-bottom:12px;gap:12px;align-items:center;flex-wrap:wrap' }, [
      el('label', { text: 'Year:', style: 'margin:0' }), yearSel,
      el('div', { class: 'flex-1' }),
      el('button', { class: 'btn btn-sm btn-outline', onclick: () => { currentWeekStart.setDate(currentWeekStart.getDate() - 7); renderAll(); }, text: '◀ Prev' }),
      weekLabel,
      el('button', { class: 'btn btn-sm btn-outline', onclick: () => { currentWeekStart.setDate(currentWeekStart.getDate() + 7); renderAll(); }, text: 'Next ▶' }),
      el('button', { class: 'btn btn-sm btn-outline', onclick: () => { currentWeekStart = getWeekStart(new Date()); renderAll(); }, text: 'Today' })
    ]),
    calendarHost
  ]));

  renderAll();
}

// Lets a subject have MORE than one weekly slot of the same type - e.g.
// a Lesson on both Monday and Friday. The backend already stores
// `schedule` as a plain list of {day,type,start,end} entries with no
// uniqueness constraint; this modal is what actually lets someone add
// a second (third, ...) slot instead of being limited to the single
// slot picked at subject creation.
function showManageScheduleModal(subject) {
  // Editing a subject's schedule only takes effect from THIS week onward:
  // the old slot is closed (effective_to = last day of the previous week)
  // and a changed slot is re-created with effective_from = this week's
  // Monday. Past weeks - and the attendance records tied to them - keep
  // the schedule they really had. Fixing the past is a deliberate manual step.
  const mondayOf = (s) => { const d = localDateFromStr(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return localDateStr(d); };
  const weekStart = mondayOf(todayStr());
  const prevDay = (() => { const d = localDateFromStr(weekStart); d.setDate(d.getDate() - 1); return localDateStr(d); })();
  const newSlotId = () => 'sl' + Math.random().toString(36).slice(2, 10);
  const allSlots = (subject.schedule || []).map(s => s.id ? s : { ...s, id: newSlotId() });
  const history = allSlots.filter(s => s.effective_to);
  const originals = allSlots.filter(s => !s.effective_to);
  let slots = originals.map(s => ({ ...s }));
  let editIdx = -1;
  const REC_LABELS = { weekly: 'Every week', biweekly: 'Every 2 weeks', triweekly: 'Every 3 weeks', monthly: 'Monthly (every 4 weeks)' };

  const daySel = el('select', {}, ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'].map(d => el('option', { value: d, text: d[0].toUpperCase() + d.slice(1) })));
  const typeSel = el('select', {}, [
    el('option', { value: 'C', text: 'Lesson' }), el('option', { value: 'TD', text: 'Guided Work' }), el('option', { value: 'TP', text: 'Lab' })
  ]);
  const startInput = el('input', { value: '08:00' });
  const endInput = el('input', { value: '09:30' });
  const recSel = el('select', {}, Object.entries(REC_LABELS).map(([v, t]) => el('option', { value: v, text: t })));
  const anchorInput = el('input', { type: 'date', value: todayStr(), title: 'Any date inside the FIRST week this slot should appear in - later occurrences are counted from that week' });
  let container;

  function loadIntoForm(sc) {
    daySel.value = sc.day; typeSel.value = sc.type || 'C';
    startInput.value = sc.start; endInput.value = sc.end;
    recSel.value = sc.recurrence || 'weekly';
    anchorInput.value = sc.anchor_date || todayStr();
  }
  function rerender() { const fresh = buildContent(); container.replaceWith(fresh); container = fresh; }

  function renderSlotsList() {
    if (!slots.length) return el('div', { class: 'text-dim text-sm mb-8', text: 'No weekly slots yet - add one below.' });
    return el('div', { class: 'mb-16' }, slots.map((sc, i) => el('div', {
      class: 'row', style: 'justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)'
    }, [
      el('span', { class: 'text-sm', text: `${sc.day[0].toUpperCase()}${sc.day.slice(1)} · ${lessonTypeLabel(sc.type)}${sc.part ? ' (' + sc.part + ')' : ''} · ${sc.start}–${sc.end} · ${REC_LABELS[sc.recurrence || 'weekly']}${sc.recurrence && sc.recurrence !== 'weekly' ? ` (from week of ${sc.anchor_date})` : ''}` }),
      el('div', { class: 'btn-group' }, [
        el('button', { class: 'btn btn-sm btn-outline', text: 'Edit', onclick: () => { editIdx = i; loadIntoForm(sc); rerender(); } }),
        sc.part ? null : el('button', { class: 'btn btn-sm btn-outline', text: 'Split', title: 'Split into 2 separate weekly sessions (tracked individually) - then set the second one\'s day/time', onclick: () => {
          const copy = { ...sc, id: newSlotId(), part: '2/2' };
          slots[i] = { ...sc, part: '1/2' };
          slots.splice(i + 1, 0, copy);
          editIdx = i + 1; loadIntoForm(copy); rerender();
        } }),
        el('button', { class: 'btn btn-sm btn-danger', text: 'Remove', onclick: () => { slots.splice(i, 1); if (editIdx === i) editIdx = -1; else if (editIdx > i) editIdx--; rerender(); } })
      ])
    ])));
  }

  const sameSlot = (a, b) => a.day === b.day && (a.type || 'C') === (b.type || 'C') && a.start === b.start && a.end === b.end
    && (a.recurrence || 'weekly') === (b.recurrence || 'weekly') && (a.anchor_date || '') === (b.anchor_date || '') && (a.part || '') === (b.part || '');

  function buildContent() {
    return el('div', {}, [
      el('div', { class: 'modal-header' }, [
        el('div', { class: 'modal-title', text: `Weekly Schedule - ${subject.name}` }),
        el('button', { class: 'modal-close', onclick: closeModal, text: '×' })
      ]),
      el('div', { class: 'text-dim text-sm mb-8', text: 'Each slot can repeat weekly, every 2 or 3 weeks, or monthly - set per slot (e.g. a weekly Lesson with a biweekly Lab). For non-weekly slots pick a date in the first week it should appear so it lines up correctly.' }),
      el('div', { class: 'recommendation info mb-8', text: `Changes here apply from the week of ${weekStart} onward. Earlier weeks keep the schedule they had - correct past attendance by hand if needed.` }),
      renderSlotsList(),
      el('div', { style: 'font-weight:700;margin-bottom:6px', text: editIdx >= 0 ? 'Editing slot' : 'Add slot' }),
      el('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap;align-items:flex-end' }, [
        el('div', {}, [el('label', { text: 'Day' }), daySel]),
        el('div', {}, [el('label', { text: 'Type' }), typeSel]),
        el('div', {}, [el('label', { text: 'Start' }), startInput]),
        el('div', {}, [el('label', { text: 'End' }), endInput]),
        el('div', {}, [el('label', { text: 'Repeats' }), recSel]),
        el('div', {}, [el('label', { text: 'First week of' }), anchorInput]),
        el('button', { class: 'btn btn-sm btn-outline', text: editIdx >= 0 ? 'Update Slot' : '+ Add Slot', onclick: () => {
          if (timeToMinutes(endInput.value) <= timeToMinutes(startInput.value)) { alert('End time must be after start time'); return; }
          const slot = { id: editIdx >= 0 ? slots[editIdx].id : newSlotId(), day: daySel.value, type: typeSel.value, start: startInput.value, end: endInput.value, recurrence: recSel.value };
          if (editIdx >= 0 && slots[editIdx].part) slot.part = slots[editIdx].part;
          if (recSel.value !== 'weekly') slot.anchor_date = anchorInput.value;
          if (editIdx >= 0) { slots[editIdx] = slot; editIdx = -1; } else slots.push(slot);
          rerender();
        } })
      ]),
      el('div', { class: 'btn-group', style: 'margin-top:16px;justify-content:flex-end' }, [
        el('button', { class: 'btn', text: 'Save Schedule', onclick: async () => {
          const result = [...history];
          originals.forEach(o => {
            const cur = slots.find(s => s.id === o.id);
            if (cur && sameSlot(o, cur)) { result.push(o); return; }
            // removed or changed: close the old slot at the end of last week
            // (or drop it entirely if it only began this week)
            if (!(o.effective_from && o.effective_from >= weekStart)) result.push({ ...o, effective_to: prevDay });
            if (cur) result.push({ ...cur, id: newSlotId(), effective_from: weekStart });
          });
          slots.filter(s => !originals.some(o => o.id === s.id)).forEach(s => result.push({ ...s, effective_from: weekStart }));
          try {
            await api(`/api/${currentProfile}/subjects/${subject.id}`, { method: 'PUT', body: JSON.stringify({ schedule: result }) });
            closeModal(); await loadConfig();
            try { await api(`/api/${currentProfile}/attendance/autofill`, { method: 'POST' }); await loadData(); } catch (e) {}
            render();
          } catch (e) { alert(e.message); }
        }})
      ])
    ]);
  }

  container = buildContent();
  showModal(container);
}

function showAddSubjectModal() {
  const cfg = cachedConfig || { academic_years: [], subject_categories: [] };
  const nameInput = el('input', { placeholder: 'Subject name' });
  const colorInput = el('input', { type: 'color', value: '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0') });
  const diffInput = el('input', { type: 'number', min: '1', max: '10', value: '5' });
  const catSel = el('select', {}, [
    el('option', { value: '', text: 'No category' }),
    ...(cfg.subject_categories || []).map(sc => el('option', { value: sc.id, text: sc.name }))
  ]);
  const yearSel = el('select', {}, [
    el('option', { value: '', text: 'No year / unassigned' }),
    ...(cfg.academic_years || []).map(y => el('option', { value: y.id, text: y.label }))
  ]);
  const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const rows = [['C', 'Lesson', '08:00', '09:30'], ['TD', 'Guided Work', '09:45', '11:15'], ['TP', 'Lab', '13:00', '14:30']].map(([code, label, s, e]) => {
    const cb = el('input', { type: 'checkbox', style: 'width:auto' });
    const day = el('select', { disabled: true }, days.map(d => el('option', { value: d, text: d[0].toUpperCase() + d.slice(1) })));
    const start = el('input', { type: 'time', value: s, disabled: true });
    const end = el('input', { type: 'time', value: e, disabled: true });
    const rec = el('select', { disabled: true }, [
      el('option', { value: 'weekly', text: 'Every week' }),
      el('option', { value: 'biweekly', text: 'Every 2 weeks' }),
      el('option', { value: 'triweekly', text: 'Every 3 weeks' }),
      el('option', { value: 'monthly', text: 'Monthly (every 4 weeks)' })
    ]);
    const anchor = el('input', { type: 'date', value: todayStr(), disabled: true, title: 'Any date inside the FIRST week this slot should appear in - later occurrences are counted from that week' });
    function syncDisabled() {
      [day, start, end, rec].forEach(x => x.disabled = !cb.checked);
      anchor.disabled = !cb.checked || rec.value === 'weekly';
    }
    cb.addEventListener('change', syncDisabled);
    rec.addEventListener('change', syncDisabled);
    const box = el('div', { style: 'border:1px solid var(--border);border-radius:var(--r-sm);padding:8px;margin-top:8px' }, [
      el('label', { class: 'row', style: 'text-transform:none;gap:8px;cursor:pointer;margin:0' }, [cb, el('span', { style: 'font-weight:700;font-size:var(--font-s)', text: label })]),
      el('div', { class: 'row', style: 'gap:6px;margin-top:6px' }, [day, start, end]),
      el('div', { class: 'row', style: 'gap:6px;margin-top:6px;align-items:flex-end;flex-wrap:wrap' }, [
        el('div', { class: 'flex-1' }, [el('label', { text: 'Repeats' }), rec]),
        el('div', { class: 'flex-1' }, [el('label', { text: 'First week of' }), anchor])
      ])
    ]);
    return { code, cb, day, start, end, rec, anchor, box };
  });
  const content = el('div', {}, [
    el('div', { class: 'modal-header' }, [
      el('div', { class: 'modal-title', text: 'Add Subject' }),
      el('button', { class: 'modal-close', onclick: closeModal, text: '×' })
    ]),
    el('label', { text: 'Subject Name' }), nameInput,
    el('div', { class: 'row' }, [
      el('div', {}, [el('label', { text: 'Color' }), colorInput]),
      el('div', { class: 'flex-1' }, [el('label', { text: 'Difficulty (1-10)' }), diffInput])
    ]),
    el('label', { text: 'Category' }), catSel,
    el('label', { text: 'Academic Year' }), yearSel,
    el('label', { text: 'Weekly sessions (tick any combination)' }),
    ...rows.map(r => r.box),
    el('div', { class: 'btn-group', style: 'margin-top:16px;justify-content:flex-end' }, [
      el('button', { class: 'btn', text: 'Add', onclick: async () => {
        const name = nameInput.value.trim();
        if (!name) { alert('Enter name'); return; }
        const schedule = [];
        for (const r of rows) {
          if (!r.cb.checked) continue;
          if (timeToMinutes(r.end.value) <= timeToMinutes(r.start.value)) { alert('End time must be after start time'); return; }
          const slot = { day: r.day.value, type: r.code, start: r.start.value, end: r.end.value, recurrence: r.rec.value };
          if (r.rec.value !== 'weekly') slot.anchor_date = r.anchor.value || todayStr();
          schedule.push(slot);
        }
        try {
          await api(`/api/${currentProfile}/subjects`, {
            method: 'POST',
            body: JSON.stringify({ name, color: colorInput.value, difficulty: parseInt(diffInput.value) || 5, year_id: yearSel.value, category_id: catSel.value, schedule })
          });
          closeModal();
          await loadConfigAndGamification();
          try { await api(`/api/${currentProfile}/attendance/autofill`, { method: 'POST' }); await loadData(); } catch (e) {}
          render();
        } catch (e) { alert(e.message); }
      }})
    ])
  ]);
  showModal(content);
}

function showAddSkillScheduleModal() {
  // Adds a recurring weekly block for an EXISTING skill (create the skill
  // itself in Settings first). Unlike subject lessons, skill blocks are
  // never suppressed by exam periods or vacation weeks - they're meant
  // for focus/self-skilling, including during breaks.
  const cfg0 = cachedConfig || { skills: [] };
  const cfg = { ...cfg0, skills: (cfg0.skills || []).filter(s => !s.archived) };
  if (!(cfg.skills || []).length) {
    alert('Add a skill first in Settings, then you can schedule it here.');
    return;
  }
  const skillSel = el('select', {}, (cfg.skills || []).map(s => el('option', { value: s.id, text: s.name })));
  const daySel = el('select', {}, [
    el('option', { value: 'monday', text: 'Monday' }),
    el('option', { value: 'tuesday', text: 'Tuesday' }),
    el('option', { value: 'wednesday', text: 'Wednesday' }),
    el('option', { value: 'thursday', text: 'Thursday' }),
    el('option', { value: 'friday', text: 'Friday' }),
    el('option', { value: 'saturday', text: 'Saturday' }),
    el('option', { value: 'sunday', text: 'Sunday' })
  ]);
  const startInput = el('input', { value: '18:00' });
  const endInput = el('input', { value: '19:00' });

  const content = el('div', {}, [
    el('div', { class: 'modal-header' }, [
      el('div', { class: 'modal-title', text: 'Schedule a Skill Session' }),
      el('button', { class: 'modal-close', onclick: closeModal, text: '×' })
    ]),
    el('label', { text: 'Skill' }), skillSel,
    el('label', { text: 'Day' }), daySel,
    el('div', { class: 'row', style: 'margin-top:8px' }, [
      el('div', { class: 'flex-1' }, [el('label', { text: 'Start' }), startInput]),
      el('div', { class: 'flex-1' }, [el('label', { text: 'End' }), endInput])
    ]),
    el('div', { class: 'btn-group', style: 'margin-top:16px;justify-content:flex-end' }, [
      el('button', { class: 'btn', text: 'Add', onclick: async () => {
        if (timeToMinutes(endInput.value) <= timeToMinutes(startInput.value)) { alert('End time must be after start time'); return; }
        const sk = (cfg.skills || []).find(s => s.id === skillSel.value);
        const newSchedule = [...(sk.schedule || []), { day: daySel.value, type: 'Skill', start: startInput.value, end: endInput.value }];
        try {
          await api(`/api/${currentProfile}/skills/${sk.id}`, { method: 'PUT', body: JSON.stringify({ schedule: newSchedule }) });
          closeModal();
          await loadConfig();
          render();
        } catch (e) { alert(e.message); }
      }})
    ])
  ]);
  showModal(content);
}

// ═══════════════════════════════════════════
// SELF-STUDY
// ═══════════════════════════════════════════
async function renderSelfStudy(c) {
  const cfg = cachedConfig || { subjects: [], skills: [] };
  const d = cachedData || { self_study: [] };

  c.innerHTML = '';
  c.appendChild(el('div', { class: 'row', style: 'margin-bottom:16px;justify-content:space-between;align-items:center' }, [
    el('h2', { text: 'Focus Records' }),
    el('button', { class: 'btn', text: '+ Add Record', onclick: showAddSelfStudyModal })
  ]));

  const records = [...(d.self_study || [])].sort((a, b) => b.date.localeCompare(a.date) || b.created.localeCompare(a.created));

  if (!records.length) {
    c.appendChild(el('div', { class: 'card text-dim text-center', style: 'padding:40px', text: 'No focus records yet. Click "+ Add Record" or use the timer!' }));
    return;
  }

  const table = el('table', {}, [
    el('thead', {}, el('tr', {}, [
      el('th', { text: 'Date' }), el('th', { text: 'Subject/Skill' }), el('th', { text: 'Time' }),
      el('th', { text: 'Difficulty' }), el('th', { text: 'Status' }), el('th', { text: 'Note' }), el("th", { text: "" })
    ])),
    el('tbody', {}, records.map(r => {
      const subj = cfg.subjects.find(s => s.id === r.subject_id);
      const skill = cfg.skills.find(s => s.id === r.skill_id);
      const name = subj?.name || skill?.name || ' - ';
      return el('tr', {}, [
        el('td', { text: r.date }),
        el('td', { text: name }),
        el('td', { text: r.minutes + 'min (' + fmtHours(r.minutes) + 'h)' }),
        el('td', { text: r.difficulty + '/10' }),
        el('td', {}, el('span', { class: `tag tag-${r.status === 'Done' ? 'done' : r.status === 'Partial' ? 'partial' : 'absent'}`, text: r.status })),
        el('td', { class: 'text-sm text-dim', text: r.note || ' - ' }),
        el('td', {}, el('button', { class: 'btn btn-sm btn-outline', text: 'Edit', onclick: () => editSelfStudy(r) }))
      ]);
    }))
  ]);
  c.appendChild(el('div', { class: 'card fade-in' }, [table]));
}

function showAddSelfStudyModal() {
  const now = new Date();
  const dateInput = el('input', { type: 'date', value: todayStr() });
  // Defaults to the current local hour/minute - matches the old
  // implicit behavior (records used to always silently timestamp
  // themselves "now" regardless of the chosen date), but now it's an
  // editable field instead of a hidden assumption, so a backdated
  // entry can get a sensible time instead of inheriting today's clock.
  const timeInput = el('input', { type: 'time', value: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}` });
  const activeSubs = activeSubjects(cachedConfig);
  const pastSubs = (cachedConfig?.subjects || []).filter(s => !s.archived && !activeSubs.includes(s));
  const subjSel = el('select', {}, [
    el('option', { value: '', text: 'Select subject or skill...' }),
    ...buildSubjectSkillOptionGroups(cachedConfig, { activeOnly: true }),
    pastSubs.length ? el('optgroup', { label: 'Past Years' }, pastSubs.map(s => el('option', { value: s.id, text: s.name }))) : null
  ]);
  const minutesInput = el('input', { type: 'number', value: '30', min: '1' });
  const difficultyInput = el('input', { type: 'range', min: '1', max: '10', value: '5' });
  const difficultyLabel = el('span', { text: '5/10' });
  difficultyInput.oninput = () => difficultyLabel.textContent = difficultyInput.value + '/10';
  const statusSel = el('select', {}, [
    el('option', { value: 'Done', text: 'Done' }),
    el('option', { value: 'Partial', text: 'Partial' }),
    el('option', { value: 'Skipped', text: 'Skipped' })
  ]);
  const noteInput = el('textarea', { placeholder: 'Optional note...' });

  const content = el('div', {}, [
    el('div', { class: 'modal-header' }, [
      el('div', { class: 'modal-title', text: 'Add Focus Record' }),
      el('button', { class: 'modal-close', onclick: closeModal, text: '×' })
    ]),
    el('div', { class: 'row' }, [
      el('div', { class: 'flex-1' }, [el('label', { text: 'Date' }), dateInput]),
      el('div', { class: 'flex-1' }, [el('label', { text: 'Start Time' }), timeInput])
    ]),
    el('label', { text: 'Subject / Skill' }), subjSel,
    el('label', { text: 'Minutes' }), minutesInput,
    el('label', { text: 'Difficulty' }), el('div', { class: 'row' }, [difficultyInput, difficultyLabel]),
    el('label', { text: 'Status' }), statusSel,
    el('label', { text: 'Note' }), noteInput,
    el('div', { class: 'btn-group', style: 'margin-top:16px;justify-content:flex-end' }, [
      el('button', { class: 'btn', text: 'Save', onclick: async () => {
        const isSkill = subjSel.value.startsWith('skill_');
        const payload = {
          date: dateInput.value,
          time: timeInput.value,
          minutes: parseInt(minutesInput.value) || 0,
          difficulty: parseInt(difficultyInput.value),
          status: statusSel.value,
          note: noteInput.value
        };
        if (isSkill) payload.skill_id = subjSel.value.slice(6);
        else payload.subject_id = subjSel.value;
        try {
          const resp = await api(`/api/${currentProfile}/self_study`, { method: 'POST', body: JSON.stringify(payload) });
          closeModal();
          await loadData(); await maybeShowLevelUp({ skipXpToast: true }); render();
          if (resp && resp.xp_earned > 0) {
            showSessionXpToast(resp.xp_earned, payload.minutes, payload.difficulty, resp.nerds_earned || 0);
          }
        } catch (e) { alert(e.message); }
      }})
    ])
  ]);
  showModal(content);
}

function editSelfStudy(record) {
  const minutesInput = el('input', { type: 'number', value: record.minutes, min: '0' });
  const difficultyInput = el('input', { type: 'range', min: '1', max: '10', value: record.difficulty });
  const difficultyLabel = el('span', { text: record.difficulty + '/10' });
  difficultyInput.oninput = () => difficultyLabel.textContent = difficultyInput.value + '/10';
  const statusSel = el('select', {}, [
    el('option', { value: 'Done', text: 'Done' }),
    el('option', { value: 'Partial', text: 'Partial' }),
    el('option', { value: 'Skipped', text: 'Skipped' })
  ]);
  statusSel.value = record.status;
  const noteInput = el('textarea', { value: record.note || '' });

  const content = el('div', {}, [
    el('div', { class: 'modal-header' }, [
      el('div', { class: 'modal-title', text: 'Edit Focus Record' }),
      el('button', { class: 'modal-close', onclick: closeModal, text: '×' })
    ]),
    el('label', { text: 'Minutes' }), minutesInput,
    el('label', { text: 'Difficulty' }), el('div', { class: 'row' }, [difficultyInput, difficultyLabel]),
    el('label', { text: 'Status' }), statusSel,
    el('label', { text: 'Note' }), noteInput,
    el('div', { class: 'btn-group', style: 'margin-top:16px;justify-content:flex-end' }, [
      el('button', { class: 'btn btn-danger', text: 'Delete', onclick: async () => {
        if (!confirm('Delete this record?')) return;
        await api(`/api/${currentProfile}/self_study/${record.id}`, { method: 'DELETE' });
        closeModal(); await loadData(); await maybeShowLevelUp(); render();
        showUndoToast('Focus record deleted.');
      }}),
      el('button', { class: 'btn', text: 'Save', onclick: async () => {
        try {
          await api(`/api/${currentProfile}/self_study/${record.id}`, {
            method: 'PUT',
            body: JSON.stringify({
              minutes: parseInt(minutesInput.value) || 0,
              difficulty: parseInt(difficultyInput.value),
              status: statusSel.value,
              note: noteInput.value
            })
          });
          closeModal(); await loadData(); await maybeShowLevelUp(); render();
        } catch (e) { alert(e.message); }
      }})
    ])
  ]);
  showModal(content);
}

// ═══════════════════════════════════════════
// ATTENDANCE
// ═══════════════════════════════════════════
async function renderAttendance(c) {
  const cfg = cachedConfig || { subjects: [] };
  const d = cachedData || { attendance: [] };

  c.innerHTML = '';
  c.appendChild(el('div', { class: 'row', style: 'margin-bottom:16px;justify-content:space-between;align-items:center' }, [
    el('h2', { text: 'Attendance' }),
    el('button', { class: 'btn', text: '+ Mark Attendance', onclick: showAddAttendanceModal })
  ]));

  const records = [...(d.attendance || [])].sort((a, b) => b.date.localeCompare(a.date));

  if (!records.length) {
    c.appendChild(el('div', { class: 'card text-dim text-center', style: 'padding:40px', text: 'No attendance records yet.' }));
    return;
  }

  const table = el('table', {}, [
    el('thead', {}, el('tr', {}, [
      el('th', { text: 'Date' }), el('th', { text: 'Subject' }), el('th', { text: 'Type' }),
      el('th', { text: 'Event' }), el('th', { text: 'Status' }), el('th', { text: 'Time' }), el("th", { text: "" })
    ])),
    el('tbody', {}, records.map(r => {
      const subj = cfg.subjects.find(s => s.id === r.subject_id);
      return el('tr', {}, [
        el('td', { text: r.date }),
        el('td', { text: subj?.name || ' - ' }),
        el('td', {}, el('span', { class: `tag tag-${r.type.toLowerCase()}`, text: lessonTypeLabel(r.type) })),
        el('td', { text: r.event_label || ' - ' }),
        el('td', {}, el('span', { class: `tag tag-${r.status}`, text: r.status === 'teacher_absent' ? 'Teacher Absent' : r.status })),
        el('td', { text: r.minutes + 'min' }),
        el('td', {}, el('button', { class: 'btn btn-sm btn-outline', text: 'Edit', onclick: () => editAttendance(r) }))
      ]);
    }))
  ]);
  c.appendChild(el('div', { class: 'card fade-in' }, [table]));
}

// When a presence/absence default mode is active, manual entries should
// default to the *exception* status - since the default status is
// already being auto-filled in the background, what someone opens this
// modal to log is almost always the opposite case.
function defaultExceptionStatus() {
  const mode = cachedConfig?.attendance_default_mode;
  if (mode === 'mostly_present') return 'absent';
  if (mode === 'mostly_absent') return 'present';
  return 'present';
}

function showAddAttendanceModal() {
  const dateInput = el('input', { type: 'date', value: todayStr() });
  const activeSubs2 = activeSubjects(cachedConfig);
  const pastSubs2 = (cachedConfig?.subjects || []).filter(s => !s.archived && !activeSubs2.includes(s));
  const subjSel = el('select', {}, [
    el('option', { value: '', text: 'Select subject...' }),
    ...activeSubs2.map(s => el('option', { value: s.id, text: s.name })),
    pastSubs2.length ? el('optgroup', { label: 'Past Years' }, pastSubs2.map(s => el('option', { value: s.id, text: s.name }))) : null
  ]);
  const typeSel = el('select', {}, [
    el('option', { value: 'C', text: 'Lesson' }),
    el('option', { value: 'TD', text: 'Guided Work' }),
    el('option', { value: 'TP', text: 'Lab' })
  ]);
  const eventInput = el('input', { placeholder: 'e.g. TD1, Lab 3' });
  const statusSel = el('select', {}, [
    el('option', { value: 'present', text: 'Present' }),
    el('option', { value: 'partial', text: 'Partial' }),
    el('option', { value: 'absent', text: 'Absent' }),
    el('option', { value: 'teacher_absent', text: 'Teacher Absent (lesson cancelled)' })
  ]);
  statusSel.value = defaultExceptionStatus();
  const minutesInput = el('input', { type: 'number', value: '90', min: '0' });

  const content = el('div', {}, [
    el('div', { class: 'modal-header' }, [
      el('div', { class: 'modal-title', text: 'Mark Attendance' }),
      el('button', { class: 'modal-close', onclick: closeModal, text: '×' })
    ]),
    el('label', { text: 'Date' }), dateInput,
    el('label', { text: 'Subject' }), subjSel,
    el('label', { text: 'Type' }), typeSel,
    el('label', { text: 'Event Label' }), eventInput,
    el('label', { text: 'Status' }), statusSel,
    el('label', { text: 'Minutes (actual)' }), minutesInput,
    el('div', { class: 'btn-group', style: 'margin-top:16px;justify-content:flex-end' }, [
      el('button', { class: 'btn', text: 'Save', onclick: async () => {
        try {
          await api(`/api/${currentProfile}/attendance`, {
            method: 'POST',
            body: JSON.stringify({
              date: dateInput.value,
              subject_id: subjSel.value,
              type: typeSel.value,
              event_label: eventInput.value,
              status: statusSel.value,
              minutes: parseInt(minutesInput.value) || 0
            })
          });
          closeModal(); await loadData(); await maybeShowLevelUp(); render();
        } catch (e) { alert(e.message); }
      }})
    ])
  ]);
  showModal(content);
}

function showQuickAttendanceModal(subject, schedule, dateStr) {
  const statusSel = el('select', {}, [
    el('option', { value: 'present', text: 'Present' }),
    el('option', { value: 'partial', text: 'Partial' }),
    el('option', { value: 'absent', text: 'Absent' }),
    el('option', { value: 'teacher_absent', text: 'Teacher Absent (lesson cancelled)' })
  ]);
  const existingAtt = findSlotAttendance((cachedData || {}).attendance, subject.id, dateStr, schedule);
  statusSel.value = existingAtt ? existingAtt.status : defaultExceptionStatus();
  const minutesInput = el('input', { type: 'number', value: Math.max(15, (timeToMinutes(schedule.end || schedule.start || '09:00') - timeToMinutes(schedule.start || '08:00')) || 90), min: '0' });
  const content = el('div', {}, [
    el('div', { class: 'modal-header' }, [
      el('div', { class: 'modal-title', text: 'Mark Attendance' }),
      el('button', { class: 'modal-close', onclick: closeModal, text: '×' })
    ]),
    el('div', { class: 'text-sm text-dim mb-8', text: `${subject.name} • ${lessonTypeLabel(schedule.type || 'C')}${schedule.part ? ` (${schedule.part})` : ''} • ${dateStr}` }),
    el('label', { text: 'Status' }), statusSel,
    el('label', { text: 'Minutes' }), minutesInput,
    el('div', { class: 'btn-group', style: 'margin-top:16px;justify-content:flex-end' }, [
      el('button', { class: 'btn btn-outline', text: 'Cancel', onclick: closeModal }),
      el('button', { class: 'btn', text: 'Save', onclick: async () => {
        try {
          await api(`/api/${currentProfile}/attendance`, {
            method: 'POST',
            body: JSON.stringify({
              date: dateStr,
              subject_id: subject.id,
              type: schedule.type || 'C',
              slot_id: schedule.id || '',
              event_label: `${subject.name} ${lessonTypeLabel(schedule.type || 'C')}${schedule.part ? ' ' + schedule.part : ''}`,
              status: statusSel.value,
              minutes: parseInt(minutesInput.value) || 0
            })
          });
          closeModal(); await loadData(); await maybeShowLevelUp(); render();
        } catch (e) { alert(e.message); }
      }})
    ])
  ]);
  showModal(content);
}

function editAttendance(record) {
  const statusSel = el('select', {}, [
    el('option', { value: 'present', text: 'Present' }),
    el('option', { value: 'partial', text: 'Partial' }),
    el('option', { value: 'absent', text: 'Absent' }),
    el('option', { value: 'teacher_absent', text: 'Teacher Absent (lesson cancelled)' })
  ]);
  statusSel.value = record.status;
  const minutesInput = el('input', { type: 'number', value: record.minutes, min: '0' });
  const eventInput = el('input', { value: record.event_label || '' });

  const content = el('div', {}, [
    el('div', { class: 'modal-header' }, [
      el('div', { class: 'modal-title', text: 'Edit Attendance' }),
      el('button', { class: 'modal-close', onclick: closeModal, text: '×' })
    ]),
    el('label', { text: 'Event Label' }), eventInput,
    el('label', { text: 'Status' }), statusSel,
    el('label', { text: 'Minutes' }), minutesInput,
    el('div', { class: 'btn-group', style: 'margin-top:16px;justify-content:flex-end' }, [
      el('button', { class: 'btn btn-danger', text: 'Delete', onclick: async () => {
        if (!confirm('Delete?')) return;
        await api(`/api/${currentProfile}/attendance/${record.id}`, { method: 'DELETE' });
        closeModal(); await loadData(); await maybeShowLevelUp(); render();
        showUndoToast('Attendance record deleted.');
      }}),
      el('button', { class: 'btn', text: 'Save', onclick: async () => {
        try {
          await api(`/api/${currentProfile}/attendance/${record.id}`, {
            method: 'PUT',
            body: JSON.stringify({ event_label: eventInput.value, status: statusSel.value, minutes: parseInt(minutesInput.value) || 0 })
          });
          closeModal(); await loadData(); await maybeShowLevelUp(); render();
        } catch (e) { alert(e.message); }
      }})
    ])
  ]);
  showModal(content);
}

// ═══════════════════════════════════════════
// EXAMS
// ═══════════════════════════════════════════
async function renderExams(c) {
  const cfg = cachedConfig || { subjects: [], academic_years: [] };
  const d = cachedData || { exams: [] };

  c.innerHTML = '';
  c.appendChild(el('div', { class: 'row', style: 'margin-bottom:16px;justify-content:space-between;align-items:center' }, [
    el('h2', { text: 'Exams' }),
    el('button', { class: 'btn', text: '+ Add Exam', onclick: showAddExamModal })
  ]));

  const records = [...(d.exams || [])].sort((a, b) => a.date.localeCompare(b.date));

  if (!records.length) {
    c.appendChild(el('div', { class: 'card text-dim text-center', style: 'padding:40px', text: 'No exams scheduled yet.' }));
    return;
  }

  const table = el('table', {}, [
    el('thead', {}, el('tr', {}, [
      el('th', { text: 'Date' }), el('th', { text: 'Subject' }), el('th', { text: 'Name' }),
      el('th', { text: 'Type' }), el('th', { text: 'Score' }), el('th', { text: 'Status' }), el('th', { text: '' })
    ])),
    el('tbody', {}, records.map(r => {
      const subj = cfg.subjects.find(s => s.id === r.subject_id);
      const typeLabels = { written: 'Written', tp_exam: 'Lab Exam', oral: 'Oral' };
      const scoreDisplay = r.score !== null && r.score !== undefined ? `${r.score}/20` : (r.ranking ? `(${r.ranking})` : ' - ');
      return el('tr', {}, [
        el('td', { text: r.date }),
        el('td', { text: subj?.name || ' - ' }),
        el('td', { text: r.name }),
        el('td', { text: typeLabels[r.type || 'written'] || r.type || ' - ' }),
        el('td', { text: scoreDisplay }),
        el('td', {}, el('span', { class: `tag tag-${r.status === 'done' ? 'done' : r.status === 'missed' ? 'absent' : 'scheduled'}`, text: r.status })),
        el('td', {}, el('button', { class: 'btn btn-sm btn-outline', text: 'Edit', onclick: () => editExam(r) }))
      ]);
    }))
  ]);
  c.appendChild(el('div', { class: 'card fade-in' }, [table]));
}

function showAddExamModal() {
  const dateInput = el('input', { type: 'date', value: todayStr() });
  const subjSel = el('select', {}, [
    el('option', { value: '', text: 'Select subject...' }),
    ...(cachedConfig?.subjects || []).filter(s => !s.archived).map(s => el('option', { value: s.id, text: s.name }))
  ]);
  const nameInput = el('input', { placeholder: 'Exam name (e.g. Midterm 1)' });
  const typeSel = el('select', {}, [
    el('option', { value: 'written', text: 'Written Exam' }),
    el('option', { value: 'tp_exam', text: 'Lab Exam' }),
    el('option', { value: 'oral', text: 'Oral Exam' })
  ]);
  const startTimeInput = el('input', { value: '08:00' });
  const durationInput = el('input', { type: 'number', value: '120', min: '1' });
  const scoreInput = el('input', { type: 'number', value: '', min: '0', max: '20', placeholder: 'Score (0-20)' });
  const rankingInput = el('input', { placeholder: 'e.g. 15/120' });

  const content = el('div', {}, [
    el('div', { class: 'modal-header' }, [
      el('div', { class: 'modal-title', text: 'Add Exam' }),
      el('button', { class: 'modal-close', onclick: closeModal, text: '×' })
    ]),
    el('label', { text: 'Date' }), dateInput,
    el('label', { text: 'Subject' }), subjSel,
    el('label', { text: 'Exam Name' }), nameInput,
    el('label', { text: 'Type' }), typeSel,
    el('label', { text: 'Start Time' }), startTimeInput,
    el('label', { text: 'Duration (minutes)' }), durationInput,
    el('label', { text: 'Score (0-20, optional)' }), scoreInput,
    el('label', { text: 'Ranking (optional)' }), rankingInput,
    el('div', { class: 'btn-group', style: 'margin-top:16px;justify-content:flex-end' }, [
      el('button', { class: 'btn', text: 'Save', onclick: async () => {
        try {
          const score = scoreInput.value ? parseFloat(scoreInput.value) : null;
          if (score !== null && (score < 0 || score > 20)) { alert('Score must be 0-20'); return; }
          await api(`/api/${currentProfile}/exams`, {
            method: 'POST',
            body: JSON.stringify({
              date: dateInput.value,
              subject_id: subjSel.value,
              name: nameInput.value,
              type: typeSel.value,
              start_time: startTimeInput.value,
              duration_minutes: parseInt(durationInput.value) || 120,
              status: 'scheduled',
              score: score,
              ranking: rankingInput.value || null
            })
          });
          closeModal(); await loadData(); await maybeShowLevelUp(); render();
        } catch (e) { alert(e.message); }
      }})
    ])
  ]);
  showModal(content);
}

function editExam(record) {
  const statusSel = el('select', {}, [
    el('option', { value: 'scheduled', text: 'Scheduled' }),
    el('option', { value: 'done', text: 'Done' }),
    el('option', { value: 'missed', text: 'Missed' })
  ]);
  statusSel.value = record.status;
  const nameInput = el('input', { value: record.name || '' });
  const typeSel = el('select', {}, [
    el('option', { value: 'written', text: 'Written Exam' }),
    el('option', { value: 'tp_exam', text: 'Lab Exam' }),
    el('option', { value: 'oral', text: 'Oral Exam' })
  ]);
  typeSel.value = record.type || 'written';
  const scoreInput = el('input', { type: 'number', value: record.score ?? '', min: '0', max: '20', placeholder: 'Score (0-20)' });
  const rankingInput = el('input', { value: record.ranking || '', placeholder: 'e.g. 15/120' });

  const content = el('div', {}, [
    el('div', { class: 'modal-header' }, [
      el('div', { class: 'modal-title', text: 'Edit Exam' }),
      el('button', { class: 'modal-close', onclick: closeModal, text: '×' })
    ]),
    el('label', { text: 'Name' }), nameInput,
    el('label', { text: 'Type' }), typeSel,
    el('label', { text: 'Status' }), statusSel,
    el('label', { text: 'Score (0-20)' }), scoreInput,
    el('label', { text: 'Ranking' }), rankingInput,
    el('div', { class: 'btn-group', style: 'margin-top:16px;justify-content:flex-end' }, [
      el('button', { class: 'btn btn-danger', text: 'Delete', onclick: async () => {
        if (!confirm('Delete?')) return;
        await api(`/api/${currentProfile}/exams/${record.id}`, { method: 'DELETE' });
        closeModal(); await loadData(); await maybeShowLevelUp(); render();
        showUndoToast('Exam record deleted.');
      }}),
      el('button', { class: 'btn', text: 'Save', onclick: async () => {
        try {
          const score = scoreInput.value ? parseFloat(scoreInput.value) : null;
          if (score !== null && (score < 0 || score > 20)) { alert('Score must be 0-20'); return; }
          await api(`/api/${currentProfile}/exams/${record.id}`, {
            method: 'PUT',
            body: JSON.stringify({
              name: nameInput.value,
              type: typeSel.value,
              status: statusSel.value,
              score: score,
              ranking: rankingInput.value || null
            })
          });
          closeModal(); await loadData(); await maybeShowLevelUp(); render();
        } catch (e) { alert(e.message); }
      }})
    ])
  ]);
  showModal(content);
}

// ═══════════════════════════════════════════
// EVENTS
// ═══════════════════════════════════════════
async function renderEvents(c) {
  const d = cachedData || { events: [] };

  c.innerHTML = '';
  c.appendChild(el('div', { class: 'row', style: 'margin-bottom:16px;justify-content:space-between;align-items:center' }, [
    el('h2', { text: 'Events & Meetings' }),
    el('button', { class: 'btn', text: '+ Add Event', onclick: showAddEventModal })
  ]));

  const records = [...(d.events || [])].sort((a, b) => b.date.localeCompare(a.date));

  if (!records.length) {
    c.appendChild(el('div', { class: 'card text-dim text-center', style: 'padding:40px', text: 'No events yet. Add one-time events like meetings, workshops, etc.' }));
    return;
  }

  const table = el('table', {}, [
    el('thead', {}, el('tr', {}, [
      el('th', { text: 'Date' }), el('th', { text: 'Name' }), el('th', { text: 'Type' }),
      el('th', { text: 'Time' }), el('th', { text: 'Duration' }), el('th', { text: 'Status' }), el("th", { text: "" })
    ])),
    el('tbody', {}, records.map(r => el('tr', {}, [
      el('td', { text: r.date }),
      el('td', { text: r.name }),
      el('td', { text: lessonTypeLabel(r.type) }),
      el('td', { text: `${r.start_time || ''}–${r.end_time || ''}` }),
      el('td', { text: r.minutes ? r.minutes + 'min' : ' - ' }),
      el('td', {}, el('span', { class: `tag tag-${r.status === 'done' ? 'done' : 'scheduled'}`, text: r.status })),
      el('td', {}, el('button', { class: 'btn btn-sm btn-outline', text: 'Edit', onclick: () => editEvent(r) }))
    ]))),
  ]);
  c.appendChild(el('div', { class: 'card fade-in' }, [table]));
}

function showAddEventModal() {
  const dateInput = el('input', { type: 'date', value: todayStr() });
  const nameInput = el('input', { placeholder: 'Event name' });
  const typeSel = el('select', {}, [
    el('option', { value: 'meeting', text: 'Meeting' }),
    el('option', { value: 'workshop', text: 'Workshop' }),
    el('option', { value: 'other', text: 'Other' })
  ]);
  const startInput = el('input', { placeholder: '09:00' });
  const endInput = el('input', { placeholder: '11:00' });
  const minutesInput = el('input', { type: 'number', value: '60', min: '0' });

  const content = el('div', {}, [
    el('div', { class: 'modal-header' }, [
      el('div', { class: 'modal-title', text: 'Add Event' }),
      el('button', { class: 'modal-close', onclick: closeModal, text: '×' })
    ]),
    el('label', { text: 'Date' }), dateInput,
    el('label', { text: 'Name' }), nameInput,
    el('label', { text: 'Type' }), typeSel,
    el('div', { class: 'row' }, [
      el('div', { class: 'flex-1' }, [el('label', { text: 'Start Time' }), startInput]),
      el('div', { class: 'flex-1' }, [el('label', { text: 'End Time' }), endInput])
    ]),
    el('label', { text: 'Duration (minutes)' }), minutesInput,
    el('div', { class: 'btn-group', style: 'margin-top:16px;justify-content:flex-end' }, [
      el('button', { class: 'btn', text: 'Save', onclick: async () => {
        try {
          await api(`/api/${currentProfile}/events`, {
            method: 'POST',
            body: JSON.stringify({
              date: dateInput.value,
              name: nameInput.value,
              type: typeSel.value,
              start_time: startInput.value,
              end_time: endInput.value,
              minutes: parseInt(minutesInput.value) || 0,
              status: 'scheduled'
            })
          });
          closeModal(); await loadData(); await maybeShowLevelUp(); render();
        } catch (e) { alert(e.message); }
      }})
    ])
  ]);
  showModal(content);
}

function editEvent(record) {
  const statusSel = el('select', {}, [
    el('option', { value: 'scheduled', text: 'Scheduled' }),
    el('option', { value: 'done', text: 'Done' }),
    el('option', { value: 'cancelled', text: 'Cancelled' })
  ]);
  statusSel.value = record.status;
  const nameInput = el('input', { value: record.name || '' });

  const content = el('div', {}, [
    el('div', { class: 'modal-header' }, [
      el('div', { class: 'modal-title', text: 'Edit Event' }),
      el('button', { class: 'modal-close', onclick: closeModal, text: '×' })
    ]),
    el('label', { text: 'Name' }), nameInput,
    el('label', { text: 'Status' }), statusSel,
    el('div', { class: 'btn-group', style: 'margin-top:16px;justify-content:flex-end' }, [
      el('button', { class: 'btn btn-danger', text: 'Delete', onclick: async () => {
        if (!confirm('Delete?')) return;
        await api(`/api/${currentProfile}/events/${record.id}`, { method: 'DELETE' });
        closeModal(); await loadData(); await maybeShowLevelUp(); render();
      }}),
      el('button', { class: 'btn', text: 'Save', onclick: async () => {
        try {
          await api(`/api/${currentProfile}/events/${record.id}`, {
            method: 'PUT',
            body: JSON.stringify({ name: nameInput.value, status: statusSel.value })
          });
          closeModal(); await loadData(); await maybeShowLevelUp(); render();
        } catch (e) { alert(e.message); }
      }})
    ])
  ]);
  showModal(content);
}

// ═══════════════════════════════════════════
// STATISTICS
// ═══════════════════════════════════════════
// ═══════════════════════════════════════════
// BOTANARIUM
// ═══════════════════════════════════════════
let botanariumCatalog = null;   // cached /botanarium/catalog response (static-ish, per profile)
let bookOfWonders = null;       // cached /book_of_wonders response (fully static, global)

async function loadBotanariumCatalog() {
  if (!botanariumCatalog) {
    try { botanariumCatalog = await api(`/api/${currentProfile}/botanarium/catalog`); }
    catch (e) { botanariumCatalog = null; }
  }
  return botanariumCatalog;
}
async function loadBookOfWonders() {
  if (!bookOfWonders) {
    try { bookOfWonders = await api('/api/book_of_wonders'); }
    catch (e) { bookOfWonders = null; }
  }
  return bookOfWonders;
}

const COIN_ANIM_FRAME_COUNT = 8;
const COIN_ANIM_FPS = 10;

function coinIcon(size) {
  // Static coin - used anywhere a Nerds cost/amount is shown inline
  // (buy buttons, chips, etc.) so the cost is always visible without
  // needing to hover. The animated version (coinIconAnimated) is only
  // used for the one "this is currently earning/ticking" spot per card.
  return el('img', { src: '/sprites/nerds/coin_01.png', class: 'coin-icon', style: `width:${size||16}px;height:${size||16}px` });
}
// The 8 coin frames are separate PNG files (coin_01.png..coin_08.png),
// not one combined spritesheet strip - so this can't be done with a
// CSS background-position/steps() trick (that only works against a
// single strip image; against 8 separate files it just shows one tiny
// frame stretched/mispositioned, which is the "blinks to nothing" bug).
// The straightforward, genuinely trivial fix for a separate-frame
// sequence like this is exactly what's below: a real <img>, and a
// setInterval that swaps its src through the frame list. No animation
// library needed for something this simple - that's really only worth
// reaching for if you have dozens of these or need easing/blending.
function coinIconAnimated(size) {
  const s = size || 20;
  const img = el('img', { src: '/sprites/nerds/coin_01.png', class: 'coin-icon-animated', style: `width:${s}px;height:${s}px` });
  startCoinAnimation(img);
  return img;
}
function startCoinAnimation(imgEl) {
  let frame = 1;
  const intervalId = setInterval(() => {
    frame = (frame % COIN_ANIM_FRAME_COUNT) + 1;
    imgEl.src = `/sprites/nerds/coin_${String(frame).padStart(2, '0')}.png`;
  }, 1000 / COIN_ANIM_FPS);
  // Stop the interval once the <img> is no longer on the page
  // otherwise every re-render of the topbar badge (which happens on
  // basically every data refresh) would leak another running interval
  // forever, each one still trying to update a detached, invisible node.
  const observer = new MutationObserver(() => {
    if (!document.body.contains(imgEl)) {
      clearInterval(intervalId);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
function nerdsAmount(amount, size) {
  return el('span', { class: 'row', style: 'display:inline-flex;gap:4px;align-items:center;white-space:nowrap' }, [
    coinIcon(size || 14), el('span', { text: Math.round(amount * 10) / 10 })
  ]);
}

async function renderBotanarium(c) {
  c.innerHTML = '<div class="text-center text-dim" style="padding:40px">Loading the Botanarium...</div>';
  let catalog, plantsResp;
  try {
    botanariumCatalog = null;   // seed prices are live market prices - never cache
    catalog = await loadBotanariumCatalog();
    plantsResp = await api(`/api/${currentProfile}/plants`);
  } catch (e) {
    c.innerHTML = `<div class="card"><p>Error loading the Botanarium: ${esc(e.message)}</p></div>`;
    return;
  }
  if (!catalog) { c.innerHTML = `<div class="card"><p>Could not load the plant catalog.</p></div>`; return; }

  c.innerHTML = '';
  c.appendChild(el('div', { class: 'row', style: 'justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:8px' }, [
    el('h2', { text: 'The Botanarium' }),
    el('button', { class: 'btn btn-sm btn-outline', text: 'Clementine\'s Book of Wonders', onclick: showBookOfWonders })
  ]));

  // Botanarium Bank card
  const bank = plantsResp.bank;
  const bankCard = el('div', { class: 'card fade-in' }, [
    el('div', { class: 'card-title', text: 'Botanarium Bank' }),
    el('div', { class: 'text-dim text-sm mb-8', text: 'Every plant\'s passive Nerds are capped by how much you can claim in any rolling 24 hours - that cap is set by your Bank level, not by this week\'s activity, so vacations and slow weeks never waste a plant\'s worth.' }),
    el('div', { class: 'row', style: 'gap:20px;flex-wrap:wrap;align-items:center' }, [
      el('div', {}, [
        el('div', { style: 'font-size:1.3rem;font-weight:800', text: `Bank Level ${bank.level}` }),
        el('div', { class: 'text-dim text-sm', text: `24h claim cap: ` }, ),
      ]),
    ]),
  ]);
  const capLine = el('div', { class: 'row', style: 'gap:6px;align-items:center;margin:6px 0' }, [
    nerdsAmount(bank.daily_claim_cap, 15),
    el('span', { class: 'text-dim text-sm', text: `per 24h · used ${plantsResp.claimed_last_24h} / ${bank.daily_claim_cap} · ${plantsResp.claim_remaining_24h} remaining` })
  ]);
  bankCard.appendChild(capLine);
  if (bank.next_level) {
    const canUpgrade = bank.can_upgrade;
    bankCard.appendChild(el('div', { class: 'row', style: 'gap:10px;align-items:center;flex-wrap:wrap;margin-top:8px' }, [
      el('span', { class: 'text-sm', text: `Next: Level ${bank.next_level} → ${BOTANARIUM_BANK_NEXT_CAP_HINT(catalog, bank.next_level)} cap/24h` }),
      el('span', { class: 'text-dim text-sm', text: `Needs ${bank.next_hours_required}h lifetime study (${bank.lifetime_hours}h so far) + ` }),
      nerdsAmount(bank.next_nerds_cost, 14),
      el('button', { class: `btn btn-sm ${canUpgrade ? '' : 'btn-outline'}`, text: canUpgrade ? 'Upgrade Bank' : 'Not Yet Eligible', disabled: !canUpgrade, onclick: async () => {
        try {
          await api(`/api/${currentProfile}/botanarium/bank/upgrade`, { method: 'POST' });
          await maybeShowLevelUp({ skipXpToast: true });
          render();
        } catch (e) { alert(e.message); }
      } })
    ]));
  } else {
    bankCard.appendChild(el('div', { class: 'text-dim text-sm mt-8', text: 'Your Botanarium Bank is fully upgraded.' }));
  }
  c.appendChild(bankCard);

  // Owned plant cards
  if (plantsResp.plants.length) {
    const claimableCount = plantsResp.plants.filter(p => p.claimable_nerds > 0).length;
    c.appendChild(el('div', { class: 'row', style: 'justify-content:flex-end;align-items:center;gap:10px;margin-bottom:10px' }, [
      claimableCount ? el('span', { class: 'text-dim text-sm', text: `${claimableCount} plant${claimableCount === 1 ? '' : 's'} ready to claim` }) : null,
      el('button', {
        class: 'btn btn-sm btn-success', disabled: !claimableCount,
        onclick: () => claimAllPlants(plantsResp.plants)
      }, [el('span', { text: 'Claim All ' }), coinIconAnimated(14)])
    ]));
    c.appendChild(el('div', { class: 'stats-grid', style: 'grid-template-columns:repeat(auto-fill,minmax(320px,1fr))' },
      plantsResp.plants.map(p => renderPlantCard(p, catalog))
    ));
  }

// Turns a raw mechanic id like "fast_grower" into a display-ready label
// like "Fast Grower" - underscores replaced with spaces, each word
// capitalized. Used anywhere a bonus id needs to be shown to the person
// rather than just referenced internally (e.g. collection reward text).
function formatBonusLabel(id) {
  return String(id).split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// Active collections - themed sets of plants (e.g. every potato
  // variety) that amplify their own members' existing bonus values once
  // every member reaches max level, rather than granting an unrelated
  // flat reward - e.g. every owned potato-family plant's Voluminous/
  // Bountiful/Hardy values climb further once the whole Potato Cellar
  // is complete. Only the "Full Garden" capstone grants a flat reward,
  // since it spans every domain at once.
  if ((plantsResp.collections || []).length) {
    c.appendChild(el('div', { class: 'card fade-in' }, [
      el('div', { class: 'card-title', text: 'Plant Collections' }),
      el('div', { class: 'text-dim text-sm mb-8', text: 'Get every plant in a themed set to its max level. Most collections amplify those plants\' OWN existing bonuses further (hover a card for exactly which ones); "The Full Garden" is the one universal capstone reward. Multiple active collections stack.' }),
      el('div', { class: 'stats-grid', style: 'grid-template-columns:repeat(auto-fill,minmax(220px,1fr))' },
        plantsResp.collections.map(coll => {
          const rewardText = coll.domain_bonus_ids
            ? `+${coll.domain_boost_pct}% to ${coll.domain_bonus_ids.map(formatBonusLabel).join(', ')}`
            : `+${coll.flat_xp_pct}% XP / +${coll.flat_nerds_pct}% Nerds`;
          const card = el('div', {
            class: 'stat-card', style: `opacity:${coll.active ? 1 : .55};cursor:help`
          }, [
            el('div', { style: 'display:flex;justify-content:center' }, [uiIcon(ICONS.collection(coll.id), 36)]),
            el('div', { class: 'stat-label', style: 'margin-top:6px;font-weight:700', text: coll.label }),
            el('div', { class: 'text-dim', style: 'font-size:10px', text: `${coll.plant_ids.length} plants · Lv${coll.required_level}` }),
            el('div', { style: `font-weight:800;color:var(--gold);margin-top:4px;font-size:11px`, text: rewardText })
          ]);
          attachTooltip(card, coll.desc, 'var(--gold)');
          return card;
        })
      )
    ]));
  }

  await appendInventoryCard(c);

  // Not-yet-owned plants (acquire via seed)
  const ownedTypes = new Set(plantsResp.plants.map(p => p.plant_type));
  const notOwned = catalog.catalog.filter(p => !ownedTypes.has(p.id));
  if (notOwned.length) {
    c.appendChild(el('div', { class: 'card fade-in' }, [
      el('div', { class: 'card-title', text: 'Not Yet Planted' }),
      el('div', { class: 'stats-grid', style: 'grid-template-columns:repeat(auto-fill,minmax(220px,1fr))' },
        notOwned.map(p => el('div', { class: 'stat-card' }, [
          el('img', { src: p.sprites[0], class: 'pixel-sprite', style: 'width:64px;height:64px;margin:0 auto', onerror: (e) => { e.target.style.display = 'none'; } }),
          el('div', { class: 'stat-label', style: 'margin-top:8px;font-weight:700', text: p.name }),
          el('div', { class: 'text-dim', style: 'font-size:10px;font-style:italic', text: p.scientific_name }),
          el('div', { class: 'row', style: 'justify-content:center;gap:6px;margin-top:8px', }, [nerdsAmount(p.seed_buy_price, 14)]),
          el('button', { class: 'btn btn-sm mt-8', text: 'Buy Seed & Plant', onclick: () => buySeedAndPlant(p) })
        ]))
      )
    ]));
  }

  // Info panel
  c.appendChild(el('div', { class: 'card fade-in' }, [
    el('div', { class: 'card-title', text: 'How Plant Growth Works' }),
    el('div', { class: 'col', style: 'gap:8px;font-size:var(--font-s)' }, [
      el('div', {}, [el('strong', { text: 'Growth: ' }), el('span', { text: 'Only ONE plant grows at a time - whichever one you\'ve tapped "Select for Growth" on. Every minute you study while it\'s selected banks toward its next level (most plants max out at Level 4; Watermelon maxes at Level 5). Fertilizer is a temporary buff (bought with Nerds) that boosts growth-hour accrual for 24 hours, then wears off - buy it again any time.' })]),
      el('div', {}, [el('strong', { text: 'Bonuses: ' }), el('span', { text: 'Each level permanently unlocks one bonus, unique to that plant. Hover any bonus on a plant\'s card (or check the Book of Wonders) to see exactly what triggers it and by how much. Colors on the card border always mean the same level across every plant.' })]),
      el('div', {}, [el('strong', { text: 'Passive Yield: ' }), el('span', { text: 'Every plant generates Nerds passively over real time, claimable any time - up to 24 hours\' worth banks up (some plants extend this), the rest is lost, so check back regularly. Studying 5+ hours in a week (quality-weighted) boosts the rate above normal for every plant; studying less never lowers it below normal - under-studying is handled entirely by Neglect below, not by this.' })]),
      el('div', {}, [el('strong', { text: 'Harvest: ' }), el('span', { text: 'Once a plant reaches its max level, it can additionally be Harvested for a Fruit item every few growth-hours (separate from, and on top of, passive Nerds yield). Harvesting shows the plant\'s depleted look for 1 hour afterward, during which it can\'t be harvested again - passive yield and Prestige growth keep working normally throughout. A Harvest is refused outright (nothing consumed) if your inventory has no room for it. Fruits are text-only inventory items for now, sellable in the Market.' })]),
      el('div', {}, [el('strong', { text: 'Prestige: ' }), el('span', { text: 'Once a plant hits its max level, continued study hours build toward Prestige tiers instead. Each tier grants one point to permanently boost any one of the plant\'s own 4 (or, for Watermelon, 5) bonuses.' })]),
      el('div', {}, [el('strong', { text: 'Neglect: ' }), el('span', { text: 'Two separate signals. Go too long with NO focus at all, and every plant\'s yield dips a bit (a soft, forgiving nudge). Go too long WITHOUT REAL GROWTH TIME on one specific plant, and that plant visibly wilts and its yield nearly stops - a token session won\'t stop this, it takes real hours. The safe window per plant grows the more plants you own. Some plants soften this penalty (Hardy) or extend the window before it starts at all (Warden).' })]),
      el('div', {}, [el('strong', { text: 'Seeds: ' }), el('span', { text: 'A plant\'s first seed plants it. Any extra seeds (bought, or occasionally earned from that plant\'s own bonuses) can only upgrade its Fast Grower bonus, or be sold in the Market.' })]),
    ]),
    el('div', { class: 'row', style: 'gap:14px;flex-wrap:wrap;margin-top:14px;padding-top:14px;border-top:1px solid var(--border)' }, [
      ...catalog.level_colors.map((color, i) => el('span', { class: 'row', style: 'gap:5px;align-items:center' }, [
        el('span', { style: `width:12px;height:12px;border-radius:50%;background:${color};display:inline-block` }),
        el('span', { class: 'text-dim text-sm', text: `Level ${i + 1}` })
      ])),
      ...catalog.prestige_colors.slice(0, 3).map((color, i) => el('span', { class: 'row', style: 'gap:5px;align-items:center' }, [
        el('span', { style: `width:12px;height:12px;border-radius:50%;background:${color};display:inline-block` }),
        el('span', { class: 'text-dim text-sm', text: catalog.prestige_names[i] })
      ])),
      el('span', { class: 'text-dim text-sm', text: '...and beyond' })
    ])
  ]));
}

function BOTANARIUM_BANK_NEXT_CAP_HINT(catalog, nextLevel) {
  const tier = (catalog.bank_levels || []).find(b => b.level === nextLevel);
  return tier ? tier.daily_claim_cap : '?';
}

// Claims every owned plant's ready passive yield in one go, one request
// per plant in sequence (not parallel) - the Botanarium Bank's rolling
// 24h claim cap is enforced server-side PER CLAIM, so claiming in
// sequence lets each later plant correctly see how much cap the earlier
// ones in this same batch already used, rather than every request
// racing against a stale cap snapshot. A single plant failing (e.g. the
// cap runs out partway through) doesn't stop the rest from being tried.
async function claimAllPlants(plants) {
  const claimable = plants.filter(p => p.claimable_nerds > 0);
  if (!claimable.length) return;
  let totalClaimed = 0;
  let plantsClaimed = 0;
  const seedDrops = [];
  for (const p of claimable) {
    try {
      const resp = await api(`/api/${currentProfile}/plants/${p.id}/claim`, { method: 'POST' });
      if (resp.amount > 0) {
        totalClaimed += resp.amount;
        plantsClaimed++;
        if (resp.seed_dropped) seedDrops.push(resp.seed_item);
      }
    } catch (e) { /* keep going - one plant's failure shouldn't block the rest of the batch */ }
  }
  if (totalClaimed > 0) {
    showSessionXpToast(0, 0, 0, Math.round(totalClaimed * 10) / 10);
  } else {
    alert("Nothing could be claimed - the Botanarium Bank's 24h claim cap may already be reached.");
  }
  if (seedDrops.length) {
    alert(`Bonus seeds dropped: ${seedDrops.map(s => s.replace(/_/g, ' ')).join(', ')}`);
  }
  await maybeShowLevelUp({ skipXpToast: true });
  render();
}

function renderPlantCard(p, catalog) {
  const card = el('div', { class: `stat-card plant-card${p.withered ? ' plant-withered' : ''}${p.is_selected_for_growth ? ' plant-selected-growth' : ''}`, style: `border-color:${p.color};--plant-color:${p.color};text-align:left` });
  const header = el('div', { class: 'row', style: 'gap:12px;align-items:flex-start' }, [
    el('img', { src: p.sprite, class: 'pixel-sprite', style: 'width:72px;height:72px;flex-shrink:0', onerror: (e) => { e.target.style.display = 'none'; } }),
    el('div', { class: 'flex-1' }, [
      el('div', { class: 'row', style: 'gap:6px;align-items:center;flex-wrap:wrap' }, [
        el('div', { style: 'font-weight:800;font-size:1.05rem', text: p.name }),
        p.is_selected_for_growth ? el('span', { class: 'plant-select-badge', text: 'Growing' }) : null
      ]),
      el('div', { class: 'text-dim text-sm', style: 'font-style:italic', text: p.scientific_name }),
      el('div', { style: `display:inline-block;margin-top:4px;padding:2px 9px;border-radius:20px;background:${p.color}22;border:1px solid ${p.color};color:${p.color};font-weight:700;font-size:var(--font-xxs)`, text: p.tier_name })
    ]),
    el('div', { class: 'yield-chip', title: 'Current passive Nerds/hour' }, [
      coinIcon(13), el('span', { text: `${p.yield_per_hour_effective}/h` })
    ])
  ]);
  card.appendChild(header);

  // Select-for-Growth - exactly ONE plant grows from logged study
  // sessions at a time (see _resolve_growth_plant_id server-side).
  // Toggling this is the only way to deliberately choose which one.
  card.appendChild(el('button', {
    class: `btn btn-sm mt-8 ${p.is_selected_for_growth ? '' : 'btn-outline'}`,
    text: p.is_selected_for_growth ? 'Selected for Growth' : 'Select for Growth',
    onclick: async () => {
      try { await api(`/api/${currentProfile}/plants/${p.id}/select`, { method: 'POST' }); render(); }
      catch (e) { alert(e.message); }
    }
  }));

  if (p.withered) {
    const extra = p.globally_neglected ? ' On top of that, you haven\'t studied at all recently, which dents every plant\'s yield too.' : '';
    card.appendChild(el('div', { class: 'recommendation warning mt-8', style: 'margin-bottom:0' }, [
      el('span', { text: `Wilted - this plant hasn't gotten enough study time recently. Its passive yield is cut to a fraction until you give it real attention again.${extra}` })
    ]));
  } else if (p.globally_neglected) {
    card.appendChild(el('div', { class: 'text-dim text-sm mt-8', text: 'No focus logged in a while - every plant\'s yield is temporarily reduced until you study again.' }));
  }

  // Growth bar
  if (p.hours_for_next_level) {
    const pct = Math.min(100, (p.hours_into_level / p.hours_for_next_level) * 100);
    card.appendChild(el('div', { class: 'mt-8' }, [
      el('div', { class: 'xp-progress-track' }, [el('div', { class: 'xp-progress-fill', style: `width:${pct}%;background:${p.color}` })]),
      el('div', { class: 'text-dim text-sm mt-8', text: `${fmt(p.hours_into_level, 1)}h / ${p.hours_for_next_level}h to Level ${p.level + 1}` })
    ]));
  } else if (p.prestige_tier > 0) {
    card.appendChild(el('div', { class: 'text-sm mt-8', text: `${catalog.prestige_names[p.prestige_tier - 1] || 'Prestige'} · ${p.prestige_points_available} buff point${p.prestige_points_available === 1 ? '' : 's'} available` }));
  } else {
    card.appendChild(el('div', { class: 'text-dim text-sm mt-8', text: 'Fully grown - hours now build toward Prestige.' }));
  }

  // Claim
  const claimRow = el('div', { class: 'row', style: 'gap:8px;align-items:center;margin-top:10px' }, [
    el('span', { class: 'text-sm', text: 'Ready to claim:' }),
    nerdsAmount(p.claimable_nerds, 15),
    el('button', { class: 'btn btn-sm btn-success', text: 'Claim', disabled: p.claimable_nerds <= 0, onclick: async () => {
      try {
        const resp = await api(`/api/${currentProfile}/plants/${p.id}/claim`, { method: 'POST' });
        if (resp.amount > 0) {
          showSessionXpToast(0, 0, 0, resp.amount);
          if (resp.seed_dropped) alert(`A ${resp.seed_item.replace('_', ' ')} dropped into your inventory!`);
        } else if (resp.reason) {
          alert(resp.reason);
        }
        await maybeShowLevelUp({ skipXpToast: true });
        render();
      } catch (e) { alert(e.message); }
    } })
  ]);
  card.appendChild(claimRow);

  // Harvest - a separate, max-level-only mechanic from passive Claim.
  // p.harvest is null until the plant reaches its max level.
  if (p.harvest) {
    const h = p.harvest;
    const harvestBox = el('div', { class: 'mt-8', style: 'padding:10px;border-radius:var(--r-sm);background:var(--bg3);border:1px solid var(--border)' });
    harvestBox.appendChild(el('div', { class: 'row', style: 'justify-content:space-between;align-items:center;margin-bottom:6px' }, [
      el('span', { class: 'text-sm', style: 'font-weight:700', text: `${h.fruit_label}` }),
      el('span', { class: 'text-dim text-sm', text: `Harvested ${h.harvest_count}x` })
    ]));
    if (h.locked) {
      harvestBox.appendChild(el('div', { class: 'text-sm', style: 'color:var(--amber)', text: `Recovering - growth resumes in ${h.lockout_remaining_minutes}min` }));
      harvestBox.appendChild(el('div', { class: 'text-dim text-sm mt-8', text: 'This plant shows its just-harvested look until it recovers. Growth toward the NEXT harvest is paused during this window - passive Nerds yield and leveling/prestige growth are unaffected.' }));
    } else {
      const pct = Math.min(100, (h.progress_hours / h.hours_required) * 100);
      harvestBox.appendChild(el('div', { class: 'xp-progress-track' }, [el('div', { class: 'xp-progress-fill', style: `width:${pct}%;background:${p.color}` })]));
      harvestBox.appendChild(el('div', { class: 'row', style: 'justify-content:space-between;align-items:center;margin-top:8px' }, [
        el('span', { class: 'text-dim text-sm', text: `${fmt(h.progress_hours, 1)}h / ${h.hours_required}h` }),
        el('button', { class: 'btn btn-sm btn-success', text: 'Harvest', disabled: !h.ready, onclick: async () => {
          try {
            const resp = await api(`/api/${currentProfile}/plants/${p.id}/harvest`, { method: 'POST' });
            if (resp.qty > 1) alert(`Bonus harvest! Got ${resp.qty}x ${resp.fruit_label}.`);
            render();
          } catch (e) { alert(e.message); }
        } })
      ]));
    }
    card.appendChild(harvestBox);
  }

  // Bonuses - hover any row to see the exact trigger/mechanism, not
  // just the label + value.
  const bonusList = el('div', { class: 'mt-8' }, p.bonuses.map(b => {
    const row = el('div', {
      class: 'row', style: `justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--border);opacity:${b.unlocked ? 1 : .45};cursor:help`
    }, [
      el('span', { class: 'text-sm', text: `${b.unlocked ? '' : ''} ${b.label} (Lv${b.level_required})` }),
      el('span', { class: 'text-sm', style: 'font-weight:700', text: b.unlocked ? `+${b.value}${b.unit}` : ' - ' })
    ]);
    attachTooltip(row, b.desc, p.color);
    return row;
  }));
  card.appendChild(bonusList);

  // Actions: Fertilize (temporary buff), Fast Grower upgrade, Prestige allocation
  const actions = el('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap;margin-top:10px' });
  if (p.fertilizer_active) {
    actions.appendChild(el('div', { class: 'text-sm', style: 'display:flex;align-items:center;gap:6px;color:var(--green);font-weight:700' }, [
      el('span', { text: `Fertilized - +${p.fertilizer_bonus_pct}% growth for ${fmt(p.fertilizer_remaining_hours, 1)}h more` })
    ]));
  } else {
    actions.appendChild(el('button', { class: 'btn btn-sm btn-outline', onclick: async () => {
      try { await api(`/api/${currentProfile}/plants/${p.id}/fertilize`, { method: 'POST' }); await maybeShowLevelUp({ skipXpToast: true }); render(); }
      catch (e) { alert(e.message); }
    } }, [el('span', { text: `Fertilize (+${p.fertilizer_bonus_pct}% growth, 24h) ` }), coinIcon(12), el('span', { text: p.fertilizer_cost })]));
  }
  const fgBonus = p.bonuses.find(b => b.id === 'fast_grower');
  if (fgBonus && fgBonus.unlocked && p.fast_grower_seed_tiers < catalog.fast_grower.max_tiers) {
    const seedCost = catalog.fast_grower.tier_base_cost * Math.pow(2, p.fast_grower_seed_tiers);
    actions.appendChild(el('button', { class: 'btn btn-sm btn-outline', text: `Upgrade Fast Grower (${seedCost} seeds)`, onclick: async () => {
      try { await api(`/api/${currentProfile}/plants/${p.id}/upgrade_fast_grower`, { method: 'POST' }); render(); }
      catch (e) { alert(e.message); }
    } }));
  }
  if (p.prestige_points_available > 0) {
    actions.appendChild(el('button', { class: 'btn btn-sm btn-amber', text: `Allocate Prestige Point (${p.prestige_points_available})`, onclick: () => showPrestigeAllocationModal(p) }));
  }
  if (actions.children.length) card.appendChild(actions);

  return card;
}

function showPrestigeAllocationModal(p) {
  const content = el('div', {}, [
    el('div', { class: 'modal-header' }, [
      el('div', { class: 'modal-title', text: `Allocate a Prestige Point - ${p.name}` }),
      el('button', { class: 'modal-close', onclick: closeModal, text: '×' })
    ]),
    el('div', { class: 'text-dim text-sm mb-8', text: 'Pick which bonus to permanently boost. You have ' + p.prestige_points_available + ' point(s) available.' }),
    el('div', { class: 'col', style: 'gap:8px' }, p.bonuses.map(b => el('button', { class: 'btn btn-outline', style: 'justify-content:space-between', onclick: async () => {
      try {
        await api(`/api/${currentProfile}/plants/${p.id}/allocate_prestige`, { method: 'POST', body: JSON.stringify({ bonus_id: b.id }) });
        closeModal(); render();
      } catch (e) { alert(e.message); }
    } }, [el('span', { text: b.label }), el('span', { class: 'text-dim', text: `+${b.value}${b.unit} now` })])))
  ]);
  showModal(content);
}

async function buySeedAndPlant(plantDef) {
  try {
    await api(`/api/${currentProfile}/shop/buy`, { method: 'POST', body: JSON.stringify({ item_type: plantDef.seed_item, qty: 1 }) });
    await api(`/api/${currentProfile}/inventory/use_seed`, { method: 'POST', body: JSON.stringify({ item_type: plantDef.seed_item }) });
    await maybeShowLevelUp({ skipXpToast: true });
    render();
  } catch (e) { alert(e.message); }
}

// ── Clementine's Book of Wonders ──
function showBookOfWonders() {
  showModal(el('div', { class: 'text-center', style: 'padding:20px' }, [el('div', { class: 'text-dim', text: 'Loading the Book of Wonders...' })]));
  loadBookOfWonders().then(book => {
    if (!book) { closeModal(); alert('Could not load the Book of Wonders.'); return; }
    renderBookIndex(book);
  });
}

function renderBookIndex(book) {
  const content = el('div', { class: 'book-modal' }, [
    el('div', { class: 'modal-header' }, [
      el('div', { class: 'modal-title', text: 'Clementine\'s Book of Wonders' }),
      el('button', { class: 'modal-close', onclick: closeModal, text: '×' })
    ]),
    el('div', { class: 'col', style: 'gap:18px' }, book.categories.map(cat => {
      const subEntries = cat.subcategories.map(sub => {
        const entries = book.entries.filter(e => e.category === cat.id && e.subcategory === sub.id);
        if (!entries.length) return null;
        return el('div', { style: 'margin-bottom:8px' }, [
          el('div', { class: 'text-dim text-sm', style: 'font-weight:700;margin-bottom:4px', text: sub.label }),
          el('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap' }, entries.map(en => el('button', {
            class: 'btn btn-sm btn-outline', text: en.common_name, onclick: () => renderBookEntry(book, en)
          })))
        ]);
      }).filter(Boolean);
      if (!subEntries.length) return null;
      return el('div', {}, [el('div', { style: 'font-weight:800;margin-bottom:8px', text: cat.label }), ...subEntries]);
    }).filter(Boolean))
  ]);
  showModal(content);
  document.getElementById('modalContent').classList.add('book-modal-content');
}

function renderBookGrowthGuide(plantDef, catalog) {
  const thresholds = plantDef.level_hours_thresholds || [];
  return el('div', { class: 'card', style: 'margin-top:18px' }, [
    el('div', { class: 'card-title', text: 'Growth Guide (in-game)' }),
    el('table', {}, [
      el('thead', {}, el('tr', {}, [
        el('th', { text: 'Level' }), el('th', { text: 'Hours to Reach' }),
        el('th', { text: 'Bonus' }), el('th', { text: 'Value' }), el('th', { text: 'How it works' })
      ])),
      el('tbody', {}, (plantDef.level_bonus_defs || []).map((b, i) => el('tr', {}, [
        el('td', {}, el('span', { style: `color:${(catalog.level_colors || [])[i] || 'inherit'};font-weight:700`, text: `Level ${b.level}` })),
        el('td', { text: `${thresholds[i] ?? '?'}h` }),
        el('td', { text: b.label }),
        el('td', {}, el('span', { style: 'font-weight:800;color:var(--gold)', text: `+${b.base_value}${b.unit}` })),
        el('td', { class: 'text-sm', style: 'max-width:340px', text: b.desc })
      ])))
    ])
  ]);
}

async function renderBookEntry(book, entry) {
  const catalog = entry.plant_id ? await loadBotanariumCatalog() : null;
  const plantDef = catalog ? (catalog.catalog || []).find(p => p.id === entry.plant_id) : null;

  const content = el('div', { class: 'book-modal book-entry' }, [
    el('div', { class: 'modal-header' }, [
      el('div', { class: 'modal-title', text: 'Clementine\'s Book of Wonders' }),
      el('button', { class: 'modal-close', onclick: closeModal, text: '×' })
    ]),
    el('button', { class: 'btn btn-sm btn-outline mb-16', text: '← Back to Index', onclick: () => renderBookIndex(book) }),
    el('div', { class: 'book-entry-header' }, [
      el('img', { src: entry.image, class: 'book-entry-image', onerror: (e) => { e.target.style.display = 'none'; } }),
      el('div', {}, [
        el('h2', { text: entry.common_name }),
        el('div', { class: 'text-dim', style: 'font-style:italic;font-size:1.1rem', text: entry.scientific_name }),
        el('div', { class: 'text-dim text-sm', text: `Family: ${entry.family}` })
      ])
    ]),
    el('table', { class: 'book-classification-table' }, [
      el('tbody', {}, entry.classification.map(([rank, val]) => el('tr', {}, [
        el('td', { class: 'text-dim', style: 'font-weight:700', text: rank }), el('td', { text: val })
      ])))
    ]),
    el('div', { class: 'book-two-column' }, [
      el('div', { class: 'book-column' }, [
        el('h3', { text: 'Summary' }),
        el('p', { text: entry.summary }),
        el('h3', { text: 'History' }),
        ...entry.history.split('\n\n').map(para => el('p', { text: para }))
      ]),
      el('div', { class: 'book-column' }, [
        el('h3', { text: 'Fun Facts' }),
        el('ul', { class: 'book-fact-list' }, entry.fun_facts.map(f => el('li', { text: f })))
      ])
    ]),
    plantDef ? renderBookGrowthGuide(plantDef, catalog) : null
  ]);
  showModal(content);
  document.getElementById('modalContent').classList.add('book-modal-content');
}

// ═══════════════════════════════════════════
// INVENTORY
// ═══════════════════════════════════════════
async function appendInventoryCard(c) {
  let inv, shop;
  try {
    inv = await api(`/api/${currentProfile}/inventory`);
    shop = await api(`/api/${currentProfile}/shop/catalog`);
  } catch (e) { return; }
  const items = inv.inventory || [];
  const slotCount = inv.slot_count || 20;
  // Items of the same item_type already stack automatically into one
  // slot (qty goes up rather than taking a second slot) - that's
  // handled server-side. This grid places each stack at its saved
  // slot_index, and lets you drag a stack onto another slot to
  // rearrange - including swapping with whatever's already there.
  const bySlot = {};
  items.forEach(it => { bySlot[it.slot_index] = it; });

  const slotsGrid = el('div', { class: 'item-slot-grid' });
  for (let i = 0; i < slotCount; i++) {
    const item = bySlot[i];
    if (item) {
      const shopItem = (shop.items || []).find(s => s.item_type === item.item_type);
      const slotEl = el('div', {
        class: 'item-slot', title: shopItem ? shopItem.label : item.item_type,
        draggable: true,
        onclick: () => showInventoryItemModal(item, shopItem),
        ondragstart: (e) => { e.dataTransfer.setData('text/plain', item.item_type); e.currentTarget.classList.add('item-slot-dragging'); },
        ondragend: (e) => e.currentTarget.classList.remove('item-slot-dragging'),
        ondragover: (e) => e.preventDefault(),
        ondrop: async (e) => {
          e.preventDefault();
          const draggedType = e.dataTransfer.getData('text/plain');
          if (!draggedType || draggedType === item.item_type) return;
          try { await api(`/api/${currentProfile}/inventory/move`, { method: 'POST', body: JSON.stringify({ item_type: draggedType, to_slot: i }) }); render(); }
          catch (err) { alert(err.message); }
        }
      }, [
        el('img', { src: shopItem ? shopItem.sprite : '', class: 'item-slot-icon', onerror: (e) => { e.target.style.display = 'none'; } }),
        item.qty > 1 ? el('div', { class: 'item-slot-qty', text: item.qty }) : null
      ]);
      slotsGrid.appendChild(slotEl);
    } else {
      slotsGrid.appendChild(el('div', {
        class: 'item-slot item-slot-empty',
        ondragover: (e) => e.preventDefault(),
        ondrop: async (e) => {
          e.preventDefault();
          const draggedType = e.dataTransfer.getData('text/plain');
          if (!draggedType) return;
          try { await api(`/api/${currentProfile}/inventory/move`, { method: 'POST', body: JSON.stringify({ item_type: draggedType, to_slot: i }) }); render(); }
          catch (err) { alert(err.message); }
        }
      }));
    }
  }
  c.appendChild(el('div', { class: 'card fade-in' }, [
    el('div', { class: 'row', style: 'justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:8px' }, [
      el('div', { class: 'card-title', style: 'margin-bottom:0', text: 'Your Items' }),
      el('div', { class: 'row', style: 'gap:10px;align-items:center' }, [
        el('span', { class: 'text-dim text-sm', text: `${items.length} / ${slotCount} slots used (${inv.purchased_slots || 0} purchased)` }),
        inv.next_slot_cost != null
          ? el('button', { class: 'btn btn-sm btn-outline', onclick: async () => {
              try { await api(`/api/${currentProfile}/inventory/buy_slot`, { method: 'POST' }); await maybeShowLevelUp({ skipXpToast: true }); render(); }
              catch (e) { alert(e.message); }
            } }, [el('span', { text: '+ Buy Slot ' }), coinIcon(12), el('span', { text: inv.next_slot_cost })])
          : el('span', { class: 'text-dim text-sm', text: 'Max slots reached' })
      ])
    ]),
    el('div', { class: 'text-dim text-sm mb-8', text: 'Same-type items stack into one slot automatically. Drag a slot onto another to rearrange (or swap) them. When every slot is full, buying a seed, harvesting a fruit, or a passive seed-drop for a NEW item type is refused until a slot is free.' }),
    items.length ? null : el('div', { class: 'text-dim text-sm mb-8', text: 'Your inventory is empty. Buy a seed on the Stock Market\'s Seeds tab, or earn one from a plant\'s own bonuses.' }),
    slotsGrid
  ]));

}

async function renderInventory(c) {
  c.innerHTML = '<div class="text-center text-dim" style="padding:40px">Loading Inventory...</div>';
  try {
    await Promise.resolve();
  } catch (e) {
    c.innerHTML = `<div class="card"><p>Error loading Inventory: ${esc(e.message)}</p></div>`;
    return;
  }

  c.innerHTML = '';
  c.appendChild(el('h2', { style: 'margin-bottom:16px', text: 'Inventory & Shop' }));

  // The old flat buy/sell Market table lived here - it's been merged
  // into the Stock Market page (its seeds and fruits trade there now,
  // with real fluctuating prices, news, and a proper trading floor),
  // so Inventory & Shop only handles what's actually yours: item
  // storage, cosmetic themes, and their upgrades.
  c.appendChild(el('div', { class: 'card fade-in', style: 'text-align:center' }, [
    el('div', { class: 'text-sm' },
      el('span', { text: 'Buying and selling seeds, fruits, and other goods now happens on the ' }),
      el('a', { href: '#', text: 'Stock Market', onclick: (e) => { e.preventDefault(); navigate('stock_market'); } }),
      el('span', { text: ' - with real fluctuating prices, live news, and a full trading floor.' })
    )
  ]));

  // Theme shop - cosmetic themes purchasable with Nerds, separate from
  // the level-unlocked catalog in Progression. Also starts collapsed.
  const purchasableThemes = (gamification?.theme_catalog || []).filter(t => t.price);
  if (purchasableThemes.length) {
    c.appendChild(el('div', { class: 'card fade-in' }, [
      el('div', {
        class: 'row', style: 'justify-content:space-between;align-items:center;cursor:pointer',
        onclick: () => { themeShopExpanded = !themeShopExpanded; localStorage.setItem('st_themeshop_expanded', themeShopExpanded ? '1' : '0'); render(); }
      }, [
        el('div', { class: 'card-title', style: 'margin-bottom:0', text: 'Theme Shop' }),
        el('span', { class: 'text-dim', style: 'font-size:1.1rem', text: themeShopExpanded ? '▾' : '▸' })
      ]),
      themeShopExpanded ? el('div', { class: 'mt-16' }, [
        el('div', { class: 'text-dim text-sm mb-8', text: 'Themes available for purchase outright, on top of the ones you unlock by leveling up. Premium themes (gold border) also carry a small permanent perk while active - hover for details.' }),
        el('div', { class: 'stats-grid', style: 'grid-template-columns:repeat(auto-fill,minmax(160px,1fr))' },
          purchasableThemes.map(t => {
            const owned = (gamification.unlocked_themes || []).includes(t.id);
            const perk = (gamification.theme_perks || {})[t.id];
            const card = el('div', { class: 'stat-card', style: t.premium ? 'border-color:var(--gold)' : '' }, [
              el('div', { style: 'font-size:1.4rem', text: t.premium ? '' : '' }),
              el('div', { class: 'stat-label', style: 'margin-top:6px;font-weight:600', text: t.label }),
              perk ? el('div', { style: 'font-size:9px;color:var(--gold);font-weight:700;margin-top:2px', text: 'Perk' }) : null,
              owned
                ? el('div', { class: 'text-dim', style: 'font-size:10px;margin-top:6px', text: 'Owned' })
                : el('button', { class: 'btn btn-sm mt-8', onclick: async () => {
                    try { await api(`/api/${currentProfile}/shop/buy_theme`, { method: 'POST', body: JSON.stringify({ theme_id: t.id }) }); await maybeShowLevelUp({ skipXpToast: true }); render(); }
                    catch (e) { alert(e.message); }
                  } }, [nerdsAmount(t.price, 13)])
            ]);
            if (perk) attachTooltip(card, perk.desc, 'var(--gold)');
            return card;
          })
        )
      ]) : null
    ]));
  }

  // Every premium theme is listed here, owned or not - so someone can
  // see video/audio upgrades exist for a theme before they've unlocked
  // it. Buy buttons for a not-yet-owned theme are shown but disabled
  // (see ownedTheme below) rather than hidden outright. Vault themes are
  // deliberately excluded while the vault tier stays hidden pre-release
  // (see the Progression page) - they'll get their own upgrade rows
  // again once their Quest Book unlock paths ship.
  const upgradeableThemes = (gamification?.theme_catalog || []).filter(t => t.premium);
  if (upgradeableThemes.length) {
    const prices = gamification.theme_upgrade_prices || { video: 2500, ambient_audio: 900, fish: 750 };
    const owned = gamification.theme_upgrades_owned || [];
    c.appendChild(el('div', { class: 'card fade-in' }, [
      el('div', {
        class: 'row', style: 'justify-content:space-between;align-items:center;cursor:pointer',
        onclick: () => { themeUpgradesExpanded = !themeUpgradesExpanded; localStorage.setItem('st_themeupgrades_expanded', themeUpgradesExpanded ? '1' : '0'); render(); }
      }, [
        el('div', { class: 'card-title', style: 'margin-bottom:0', text: 'Theme Upgrades' }),
        el('div', { class: 'row', style: 'gap:8px;align-items:center' }, [
          el('span', { class: 'text-dim', style: 'font-size:1.1rem', text: themeUpgradesExpanded ? '▾' : '▸' })
        ])
      ]),
      themeUpgradesExpanded ? el('div', { class: 'mt-16' }, [
        el('div', { class: 'text-dim text-sm mb-8', text: 'Premium themes you already own can be upgraded further: a looping video background in place of the static photo, a per-theme ambient audio loop, and - for the handful of themes with animated sprite creatures - unlocking them one at a time. Drop the matching .mp4/.mp3/creature files in yourself and buy the upgrade to enable it.' }),
        el('div', { class: 'col', style: 'gap:10px' },
          upgradeableThemes.map(t => {
            const ownedTheme = (gamification.unlocked_themes || []).includes(t.id);
            const hasVideo = owned.includes(`theme_upgrade_${t.id}_video`);
            const hasAudio = owned.includes(`theme_upgrade_${t.id}_ambient_audio`);
            const fishTotal = THEME_FISH_TOTALS[t.id];
            const fishOwned = fishTotal ? owned.filter(x => x === `theme_upgrade_${t.id}_fish`).length : 0;
            function buyUpgrade(type) {
              return async () => {
                try {
                  await api(`/api/${currentProfile}/shop/buy_theme_upgrade`, { method: 'POST', body: JSON.stringify({ theme_id: t.id, upgrade_type: type }) });
                  await maybeShowLevelUp({ skipXpToast: true });
                  if (document.documentElement.getAttribute('data-theme') === t.id) applyThemeVisuals(t.id);
                  render();
                } catch (e) { alert(e.message); }
              };
            }
            // A theme not yet owned still SHOWS its upgrades (so someone
            // knows they exist and what to save toward), but the buy
            // buttons are disabled/locked rather than actionable - see
            // the lockedBtn wrapper below.
            function lockedBtn(icon, label, price) {
              return el('button', {
                class: 'btn btn-sm btn-outline', disabled: true,
                title: `Unlock or buy "${t.label}" itself first`,
                style: 'opacity:.5;cursor:not-allowed'
              }, [`${icon} ${label} `, nerdsAmount(price, 12)]);
            }
            return el('div', { class: 'row', style: `justify-content:space-between;align-items:center;padding:10px;border-radius:var(--r-sm);background:var(--bg3);flex-wrap:wrap;gap:8px;${ownedTheme ? '' : 'opacity:.85'}` }, [
              el('span', { style: 'font-weight:700', text: `${t.label}${ownedTheme ? '' : ' (not owned)'}` }),
              el('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap' }, [
                hasVideo
                  ? el('span', { class: 'text-dim text-sm', text: 'Video BG' })
                  : (ownedTheme
                      ? el('button', { class: 'btn btn-sm btn-outline', onclick: buyUpgrade('video') }, ['Video BG ', nerdsAmount(prices.video, 12)])
                      : lockedBtn('', 'Video BG', prices.video)),
                hasAudio
                  ? el('span', { class: 'text-dim text-sm', text: 'Ambient Audio' })
                  : (ownedTheme
                      ? el('button', { class: 'btn btn-sm btn-outline', onclick: buyUpgrade('ambient_audio') }, ['Ambient Audio ', nerdsAmount(prices.ambient_audio, 12)])
                      : lockedBtn('', 'Ambient Audio', prices.ambient_audio)),
                fishTotal
                  ? (fishOwned >= fishTotal
                      ? el('span', { class: 'text-dim text-sm', text: `All ${fishTotal} Creatures` })
                      : (ownedTheme
                          ? el('button', { class: 'btn btn-sm btn-outline', onclick: buyUpgrade('fish') }, [`Unlock Creature (${fishOwned}/${fishTotal}) `, nerdsAmount(prices.fish, 12)])
                          : lockedBtn('', `Unlock Creature (${fishOwned}/${fishTotal})`, prices.fish)))
                  : null
              ])
            ]);
          })
        )
      ]) : null
    ]));
  }
}

function showInventoryItemModal(item, shopItem) {
  const plantDef = (botanariumCatalog?.catalog || []).find(p => p.seed_item === item.item_type);
  const content = el('div', {}, [
    el('div', { class: 'modal-header' }, [
      el('div', { class: 'modal-title', text: shopItem ? shopItem.label : item.item_type }),
      el('button', { class: 'modal-close', onclick: closeModal, text: '×' })
    ]),
    el('div', { class: 'text-center' }, [
      el('img', { src: shopItem ? shopItem.sprite : '', style: 'width:64px;height:64px;image-rendering:pixelated' })
    ]),
    el('div', { class: 'text-dim text-sm text-center mb-16', text: `You have ${item.qty}` }),
    el('div', { class: 'btn-group', style: 'justify-content:center' }, [
      plantDef ? el('button', { class: 'btn', text: 'Use (Plant)', onclick: async () => {
        try {
          await api(`/api/${currentProfile}/inventory/use_seed`, { method: 'POST', body: JSON.stringify({ item_type: item.item_type }) });
          closeModal(); render();
        } catch (e) { alert(e.message); }
      } }) : null,
      el('button', { class: 'btn btn-amber', text: `Sell 1 for ${shopItem ? shopItem.sell_price : '?'} Nerds`, onclick: async () => {
        try {
          await api(`/api/${currentProfile}/shop/sell`, { method: 'POST', body: JSON.stringify({ item_type: item.item_type, qty: 1 }) });
          closeModal(); render();
        } catch (e) { alert(e.message); }
      } })
    ])
  ]);
  showModal(content);
}

async function renderStats(c) {
  c.innerHTML = '<div class="text-center text-dim" style="padding:40px">Loading statistics...</div>';
  let stats, activitySummary;
  try {
    stats = await api(`/api/${currentProfile}/stats`);
    activitySummary = await api(`/api/${currentProfile}/activity/summary`).catch(() => null);
  } catch (e) {
    c.innerHTML = `<div class="card"><p>Error loading stats: ${esc(e.message)}</p></div>`;
    return;
  }

  c.innerHTML = '';
  const activeTheme = document.documentElement.getAttribute('data-theme') || 'dark';
  c.appendChild(el('div', { class: 'row', style: 'justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:8px' }, [
    el('h2', { text: 'Statistics' }),
    el('a', {
      class: 'btn btn-outline btn-sm', href: `/api/${currentProfile}/report/weekly?theme=${activeTheme}`,
      text: 'Download Weekly PDF Report'
    })
  ]));

  // Activity Time - how long you've spent on music/video/pages, each
  // feeding its own achievement ladder (Melomaniac/Cinephile/Dedicated
  // - see Progression). The app's own ambient background music is
  // deliberately excluded from "Music" (see musicActivityTicker in
  // app.js); only File Explorer music/video playback counts.
  if (activitySummary) {
    const byPageEntries = Object.entries(activitySummary.by_page_minutes || {}).sort((a, b) => b[1] - a[1]);
    c.appendChild(el('div', { class: 'card fade-in' }, [
      el('div', { class: 'card-title', text: 'Activity Time' }),
      el('div', { class: 'text-dim text-sm mb-8', text: 'Time spent listening to music and watching videos in the File Explorer, and time spent with the app open on each page - each builds toward its own achievement in Progression.' }),
      el('div', { class: 'stats-grid' }, [
        el('div', { class: 'stat-card' }, [
          el('div', { class: 'stat-value', text: fmt(activitySummary.music_hours, 1) + 'h' }),
          el('div', { class: 'stat-label', text: 'Music Listened' })
        ]),
        el('div', { class: 'stat-card' }, [
          el('div', { class: 'stat-value', text: fmt(activitySummary.video_hours, 1) + 'h' }),
          el('div', { class: 'stat-label', text: 'Video Watched' })
        ]),
        el('div', { class: 'stat-card' }, [
          el('div', { class: 'stat-value', text: fmt(activitySummary.app_hours, 1) + 'h' }),
          el('div', { class: 'stat-label', text: '⏳ Total App Time' })
        ])
      ]),
      byPageEntries.length ? el('div', { class: 'mt-16' }, [
        el('div', { style: 'font-weight:700;margin-bottom:6px', text: 'Time by page' }),
        el('table', {}, [
          el('tbody', {}, byPageEntries.map(([page, mins]) => el('tr', {}, [
            el('td', { text: NAV_PAGE_LABELS[page] || page }),
            el('td', { class: 'text-right text-dim', text: mins >= 60 ? `${fmt(mins / 60, 1)}h` : `${Math.round(mins)}min` })
          ])))
        ])
      ]) : null
    ]));
  }

  // Recommendations. NOTE: stats.recommendations (from /stats) already
  // merges heuristic + ML recommendations server-side (see
  // get_heuristic_recommendations()/get_ml_recommendations() in
  // server.py), each tagged with a "source" field. This used to ALSO
  // fetch /ml_recommendations separately and render those a second time
  // whenever there was enough data for ML recs to kick in, the same
  // insight showed up twice (once mislabeled "RULE" via the merged list,
  // once correctly labeled "ML" via the second fetch). Now there's a
  // single source of truth, labeled correctly by r.source.
  if (stats.recommendations && stats.recommendations.length > 0) {
    c.appendChild(el('div', { class: 'card fade-in' }, [
      el('div', { class: 'card-title', text: 'Smart Recommendations' }),
      ...stats.recommendations.map(r => {
        const isMl = (r.source || '').startsWith('ml');
        const tagLabel = r.source === 'ml_predictive' ? 'PREDICTED' : r.source === 'ml_pattern' ? 'PATTERN' : isMl ? 'ML' : 'RULE';
        return el('div', { class: `recommendation ${isMl ? 'info' : r.type}` }, [
          el('span', { text: isMl ? '' : (r.type === 'warning' ? '' : 'ℹ') }),
          el('span', { text: r.msg }),
          el('span', {
            class: 'tag', style: `margin-left:8px;font-size:9px;${isMl ? 'background:var(--accent3)' : 'background:var(--bg4);color:var(--text)'}`,
            text: tagLabel
          })
        ]);
      })
    ]));
  }

  // Focus by subject
  if (Object.keys(stats.self_study.by_subject).length > 0) {
    c.appendChild(el('div', { class: 'card fade-in' }, [
      el('div', { class: 'card-title', text: 'Focus by Subject' }),
      el('table', {}, [
        el('thead', {}, el('tr', {}, [
          el('th', { text: 'Subject' }), el('th', { text: 'Hours' }), el('th', { text: 'Avg Difficulty' })
        ])),
        el('tbody', {}, Object.entries(stats.self_study.by_subject)
          .sort((a, b) => b[1] - a[1])
          .map(([name, mins]) => {
            const avgDiff = stats.self_study.avg_difficulty[name] || 0;
            return el('tr', {}, [
              el('td', { text: name }),
              el('td', { text: fmtHours(mins) + 'h' }),
              el('td', { text: avgDiff + '/10' })
            ]);
          }))
      ])
    ]));
  }

  // Attendance breakdown
  if (stats.attendance.total_events > 0) {
    c.appendChild(el('div', { class: 'card fade-in' }, [
      el('div', { class: 'card-title', text: 'Attendance Breakdown' }),
      el('div', { class: 'row', style: 'gap:24px;flex-wrap:wrap' }, [
        el('div', {}, [
          el('h4', { text: 'By Type (minutes)' }),
          el('table', {}, [
            el('tbody', {}, Object.entries(stats.attendance.by_type).map(([t, m]) =>
              el('tr', {}, [
                el('td', {}, el('span', { class: `tag tag-${t.toLowerCase()}`, text: lessonTypeLabel(t) })),
                el('td', { text: fmtHours(m) + 'h' })
              ])
            ))
          ])
        ]),
        el('div', {}, [
          el('h4', { text: 'Summary' }),
          el('table', {}, [
            el('tbody', {}, [
              el('tr', {}, [el('td', {}, el('span', { class: 'tag tag-present', text: 'Present' })), el('td', { text: stats.attendance.present })]),
              el('tr', {}, [el('td', {}, el('span', { class: 'tag tag-partial', text: 'Partial' })), el('td', { text: stats.attendance.partial })]),
              el('tr', {}, [el('td', {}, el('span', { class: 'tag tag-absent', text: 'Absent' })), el('td', { text: stats.attendance.absent })]),
              stats.attendance.teacher_absent > 0 ? el('tr', {}, [el('td', {}, el('span', { class: 'tag tag-teacher_absent', text: 'Teacher Absent' })), el('td', { text: stats.attendance.teacher_absent })]) : null
            ])
          ]),
          stats.attendance.teacher_absent > 0 ? el('div', { class: 'text-dim text-sm mt-8', text: 'Teacher-absent lessons aren\'t counted toward your attendance rate.' }) : null
        ])
      ])
    ]));
  }

  // Focus status
  if (stats.self_study.status_counts) {
    c.appendChild(el('div', { class: 'card fade-in' }, [
      el('div', { class: 'card-title', text: 'Focus Status' }),
      el('table', {}, [
        el('tbody', {}, Object.entries(stats.self_study.status_counts).map(([s, c]) =>
          el('tr', {}, [
            el('td', {}, el('span', { class: `tag tag-${s === 'Done' ? 'done' : s === 'Partial' ? 'partial' : 'absent'}`, text: s })),
            el('td', { text: c })
          ])
        ))
      ])
    ]));
  }

  // Exams by subject
  if (Object.keys(stats.exams.by_subject).length > 0) {
    c.appendChild(el('div', { class: 'card fade-in' }, [
      el('div', { class: 'card-title', text: 'Exams by Subject' }),
      el('table', {}, [
        el('thead', {}, el('tr', {}, [
          el('th', { text: 'Subject' }), el('th', { text: 'Count' })
        ])),
        el('tbody', {}, Object.entries(stats.exams.by_subject).map(([name, count]) =>
          el('tr', {}, [el('td', { text: name }), el('td', { text: count })])
        ))
      ])
    ]));
  }

  // Exam Scores section
  const examScores = stats.exam_scores || {};
  if (examScores && (examScores.highest !== undefined || examScores.avg_score !== undefined)) {
    const scoreGrid = el('div', { class: 'stats-grid fade-in' });
    if (examScores.avg_score !== undefined && examScores.avg_score !== null) {
      scoreGrid.appendChild(el('div', { class: 'stat-card' }, [
        el('div', { class: 'stat-value', text: fmt(examScores.avg_score, 1) + '/20' }),
        el('div', { class: 'stat-label', text: 'Average Score' })
      ]));
    }
    if (examScores.highest !== undefined && examScores.highest !== null) {
      scoreGrid.appendChild(el('div', { class: 'stat-card' }, [
        el('div', { class: 'stat-value', text: fmt(examScores.highest, 1) + '/20' }),
        el('div', { class: 'stat-label', text: 'Highest Score' })
      ]));
    }
    if (examScores.lowest !== undefined && examScores.lowest !== null) {
      scoreGrid.appendChild(el('div', { class: 'stat-card' }, [
        el('div', { class: 'stat-value', text: fmt(examScores.lowest, 1) + '/20' }),
        el('div', { class: 'stat-label', text: 'Lowest Score' })
      ]));
    }
    if (examScores.score_vs_study_correlation && Object.keys(examScores.score_vs_study_correlation).length > 0) {
      const correlations = Object.entries(examScores.score_vs_study_correlation);
      const avgCorr = correlations.reduce((s, [_, c]) => s + c, 0) / correlations.length;
      scoreGrid.appendChild(el('div', { class: 'stat-card' }, [
        el('div', { class: 'stat-value', text: avgCorr >= 0 ? '+' + fmt(avgCorr, 2) : fmt(avgCorr, 2) }),
        el('div', { class: 'stat-label', text: 'Study-Score Correlation' })
      ]));
    }
    if (scoreGrid.children.length > 0) {
      c.appendChild(el('div', { class: 'card fade-in' }, [
        el('div', { class: 'card-title', text: 'Exam Scores' }),
        scoreGrid
      ]));
    }

    // Score by subject
    if (examScores.by_subject && Object.keys(examScores.by_subject).length > 0) {
      c.appendChild(el('div', { class: 'card fade-in' }, [
        el('div', { class: 'card-title', text: 'Scores by Subject' }),
        el('table', {}, [
          el('thead', {}, el('tr', {}, [
            el('th', { text: 'Subject' }), el('th', { text: 'Scores' }), el('th', { text: 'Average' })
          ])),
          el('tbody', {}, Object.entries(examScores.by_subject).map(([name, scores]) => {
            const avg = scores.length > 0 ? (scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
            return el('tr', {}, [
              el('td', { text: name }),
              el('td', { text: scores.map(s => s + '/20').join(', ') }),
              el('td', { text: scores.length > 0 ? fmt(avg, 1) + '/20' : ' - ' })
            ]);
          }))
        ])
      ]));
    }

    // Attendance ↔ Score impact. The backend has computed this for a
    // while (attendance_score_impact in /stats) but the frontend never
    // rendered it - a fully working feature that was invisible.
    const attImpact = stats.attendance_score_impact || {};
    const impactEntries = Object.entries(attImpact).filter(([, v]) => v.avg_score_when_present !== null || v.avg_score_when_absent !== null);
    if (impactEntries.length > 0) {
      c.appendChild(el('div', { class: 'card fade-in' }, [
        el('div', { class: 'card-title', text: 'Attendance Impact on Scores' }),
        el('div', { class: 'text-dim text-sm mb-8', text: 'Average exam score on days you were present vs. absent, per subject.' }),
        el('table', {}, [
          el('thead', {}, el('tr', {}, [
            el('th', { text: 'Subject' }), el('th', { text: 'Avg. When Present' }), el('th', { text: 'Avg. When Absent' }), el('th', { text: 'Difference' })
          ])),
          el('tbody', {}, impactEntries.map(([name, v]) => el('tr', {}, [
            el('td', { text: name }),
            el('td', { text: v.avg_score_when_present !== null ? `${v.avg_score_when_present}/20 (${v.present_count})` : ' - ' }),
            el('td', { text: v.avg_score_when_absent !== null ? `${v.avg_score_when_absent}/20 (${v.absent_count})` : ' - ' }),
            el('td', {}, v.difference !== null ? el('span', { style: `color:${v.difference >= 0 ? 'var(--green)' : 'var(--red)'};font-weight:700`, text: `${v.difference >= 0 ? '+' : ''}${v.difference}` }) : ' - ')
          ])))
        ])
      ]));
    }
  }

  // ═══════════════════════════════════════════
  // CHARTS - server-rendered seaborn images (replaces the old
  // Chart.js/canvas approach). Much simpler client-side: no chart
  // instances, no canvas ids, no setTimeout races - just <img> tags
  // pointing at /api/<profile>/charts/<id>, which the backend renders
  // fresh on every request styled to match the app's neon-dark theme.
  // ═══════════════════════════════════════════
  c.appendChild(el('div', { class: 'card fade-in' }, [
    el('div', { class: 'card-title', text: 'Visual Analytics' }),
    el('div', { class: 'text-dim text-sm', text: 'Rendered server-side with seaborn - refreshes each time you open this page.' })
  ]));

  const CHART_IDS = [
    ['self_study_by_subject', !!Object.keys(stats.self_study.by_subject).length],
    ['daily_study_hours', !!Object.keys(stats.self_study.by_date).length],
    ['day_of_week', Object.values(stats.by_day_of_week || {}).some(v => v > 0)],
    ['status_breakdown', Object.values(stats.self_study.status_counts || {}).some(v => v > 0)],
    ['attendance_by_type', Object.values(stats.attendance.by_type || {}).some(v => v > 0)],
    ['attendance_summary', stats.attendance.total_events > 0],
    ['difficulty_radar', Object.keys(stats.self_study.avg_difficulty || {}).length > 2],
    ['exam_scores', Object.keys(stats.exam_scores.by_subject || {}).length > 0],
    ['difficulty_vs_score', (stats.difficulty_vs_score || []).length > 1],
    ['predicted_vs_actual', (stats.predicted_vs_actual || []).length > 1],
    ['time_allocation', Object.values(stats.time_allocation || {}).some(v => v > 0)],
    ['xp_over_time', (stats.xp_over_time || []).length > 1],
    ['badges_by_tier', Object.values(stats.badge_tier_counts || {}).some(v => v > 0)],
    ['mastery_levels', (stats.mastery || []).length > 0],
    ['study_heatmap', Object.keys(stats.self_study.by_date || {}).length > 0]
  ];
  const CHART_TITLES = {
    self_study_by_subject: 'Focus Distribution', daily_study_hours: 'Daily Study Hours',
    day_of_week: 'Study by Day of Week', status_breakdown: 'Session Status',
    attendance_by_type: 'Uni Hours by Type', attendance_summary: 'Attendance Summary',
    difficulty_radar: 'Subject Difficulty Profile', exam_scores: 'Exam Scores',
    difficulty_vs_score: 'Difficulty vs Score', predicted_vs_actual: 'ML Model Fit',
    time_allocation: 'Time Allocation',
    xp_over_time: 'XP Growth', badges_by_tier: 'Badges by Tier',
    mastery_levels: 'Mastery Levels', study_heatmap: 'Study Consistency'
  };

  const chartsGrid = el('div', { class: 'stats-grid', style: 'grid-template-columns:repeat(auto-fit,minmax(380px,1fr))' });
  const cacheBust = UI_CHART_CACHE_BUST ? Date.now() : 'static';
  CHART_IDS.forEach(([id, hasData]) => {
    if (!hasData) return;
    const chartCard = el('div', { class: 'card', style: 'padding:12px' }, [
      el('img', {
        src: `/api/${currentProfile}/charts/${id}?t=${cacheBust}&theme=${activeTheme}`,
        style: 'width:100%;height:auto;max-height:640px;object-fit:contain;border-radius:8px;display:block',
        loading: 'lazy',
        alt: CHART_TITLES[id] || id
      })
    ]);
    chartsGrid.appendChild(chartCard);
  });
  c.appendChild(chartsGrid);

  // ═══════════════════════════════════════════
  // COMPREHENSIVE STATS COUNTERS
  // ═══════════════════════════════════════════
  const counterGrid = el('div', { class: 'stats-grid fade-in' });

  const counters = [
    { label: 'Total Focus Hours', value: stats.self_study.total_hours + 'h' },
    { label: 'Study Days Logged', value: Object.keys(stats.self_study.by_date || {}).length },
    { label: 'Avg Daily Study', value: stats.self_study.total_hours > 0 && Object.keys(stats.self_study.by_date || {}).length > 0 ? fmt(stats.self_study.total_hours / Object.keys(stats.self_study.by_date).length, 1) + 'h' : ' - ' },
    { label: 'Unique Subjects Studied', value: Object.keys(stats.self_study.by_subject || {}).length },
    { label: 'Attendance Rate', value: stats.attendance.total_events > 0 ? fmt(stats.attendance.present / stats.attendance.total_events * 100, 0) + '%' : ' - ' },
    { label: 'Present Count', value: stats.attendance.present },
    { label: 'Partial Count', value: stats.attendance.partial },
    { label: 'Absent Count', value: stats.attendance.absent },
    { label: 'Exams Total', value: stats.exams.total },
    { label: 'Exams Completed', value: stats.exams.done },
    { label: 'Exams Missed', value: stats.exams.missed },
    { label: 'Events Total', value: stats.events.total },
    { label: 'Events Done', value: stats.events.done },
    { label: 'Avg Difficulty', value: stats.self_study.avg_difficulty && Object.keys(stats.self_study.avg_difficulty).length > 0 ? fmt(Object.values(stats.self_study.avg_difficulty).reduce((a,b)=>a+b,0) / Object.keys(stats.self_study.avg_difficulty).length, 1) + '/10' : ' - ' },
    { label: 'Highest Score', value: stats.exam_scores?.highest ? stats.exam_scores.highest + '/20' : ' - ' },
    { label: 'Lowest Score', value: stats.exam_scores?.lowest ? stats.exam_scores.lowest + '/20' : ' - ' },
    { label: 'Score Average', value: stats.exam_scores?.avg_score ? fmt(stats.exam_scores.avg_score, 1) + '/20' : ' - ' },
    { label: 'Total Scored Exams', value: stats.exam_scores?.by_subject ? Object.values(stats.exam_scores.by_subject).flat().length : '0' },
    { label: 'Total Attendance Events', value: stats.attendance.total_events },
    { label: 'Uni Hours Attended', value: fmtHours(Object.values(stats.attendance.minutes_by_subject || {}).reduce((a,b)=>a+b,0)) + 'h' },
  ];

  counters.forEach(ct => {
    counterGrid.appendChild(el('div', { class: 'stat-card' }, [
      el('div', { class: 'stat-value', text: String(ct.value) }),
      el('div', { class: 'stat-label', text: ct.label })
    ]));
  });

  c.appendChild(el('div', { class: 'card fade-in mt-16' }, [
    el('div', { class: 'card-title', text: 'All Statistics' }),
    counterGrid
  ]));
}

// ═══════════════════════════════════════════
// HALL OF FAME
// A small, hand-curated list of people who meaningfully supported
// Cultivar's development - donations, major contributions, etc. Purely
// static/local (no server data involved) since this is about honoring
// real people, not a gameplay system. Add a new entry by copy-pasting
// one of the objects below.
//
// `photo` (optional): a filename living at /sprites/hall_of_fame/<file>.png
// (drop the .png in that folder next to server.py - the generic
// /sprites/<path> route already serves anything placed there, no code
// changes needed). Omit it entirely for a member with no photo yet - the
// card falls back to a plain monogram (their name's first letter)
// instead of a placeholder icon.
// ═══════════════════════════════════════════
const HALL_OF_FAME_MEMBERS = [
  {
    name: 'Eray Öztürk',
    nickname: 'Also goes by Codex_Sigmaticus31',
    contribution: 'Donor & Longtime Supporter',
    blurb: '<< Indeed, Allah is with those who are patient.>> - Surat Al-Baqarah 2:153',
    linkedin: 'https://www.linkedin.com/in/eray-%C3%B6zt%C3%BCrk-mech-eng/',
    photo: 'eray_ozturk.png',
  },
  {
    name: 'Yasmine Bouziri',
    nickname: 'Software Engineer',
    contribution: 'Tester & Quality Controller',
    blurb: 'You should enjoy the little detours to the fullest.',
    linkedin: 'https://www.linkedin.com/in/yasmine-bouziri-303404320/',
    photo: 'yasmine_bouziri.png',
  },
  {
    name: 'Roudaina Inoubli',
    nickname: 'Network & Telecom Engineer',
    contribution: 'First Public User',
    blurb: 'i love my radish plant 😊',
    photo: 'roudaina_inoubli.png',
  },
];

async function renderHallOfFame(c) {
  c.innerHTML = '';
  c.appendChild(el('div', { class: 'hof-header fade-in' }, [
    el('h2', { style: 'margin-bottom:4px', text: 'Hall of Fame' }),
    el('div', { class: 'text-dim', text: 'Honoring the people who helped make Cultivar what it is.' })
  ]));

  const grid = el('div', { class: 'hof-grid' });
  HALL_OF_FAME_MEMBERS.forEach((m, i) => {
    const portrait = m.photo
      ? el('img', {
          class: 'hof-card-photo', src: `/sprites/hall_of_fame/${m.photo}`, alt: m.name,
          onerror: (e) => { e.target.replaceWith(el('div', { class: 'hof-card-monogram', text: (m.name || '?').trim().charAt(0).toUpperCase() })); }
        })
      : el('div', { class: 'hof-card-monogram', text: (m.name || '?').trim().charAt(0).toUpperCase() });
    const card = el('div', { class: 'hof-card fade-in', style: `animation-delay:${i * 60}ms` }, [
      el('div', { class: 'hof-card-glow' }),
      portrait,
      el('div', { class: 'hof-card-name', text: m.name }),
      m.nickname ? el('div', { class: 'hof-card-nickname', text: `“${m.nickname}”` }) : null,
      el('div', { class: 'hof-card-role', text: m.contribution }),
      el('div', { class: 'hof-card-blurb', text: m.blurb }),
      m.linkedin ? el('a', {
        class: 'btn btn-sm hof-card-link', href: m.linkedin, target: '_blank', rel: 'noopener noreferrer'
      }, [el('span', { text: 'LinkedIn' })]) : null
    ]);
    grid.appendChild(card);
  });
  c.appendChild(grid);
}

// ═══════════════════════════════════════════
// PROGRESSION
// ═══════════════════════════════════════════
// ═══════════════════════════════════════════
// FINANCE (Nerds income/expense ledger)
// ═══════════════════════════════════════════
async function renderFinance(c) {
  c.innerHTML = '<div class="text-center text-dim" style="padding:40px">Loading Finance Ledger...</div>';
  let ledger;
  try {
    ledger = await api(`/api/${currentProfile}/finance/ledger`);
  } catch (e) {
    c.innerHTML = `<div class="card"><p>Error loading the Finance Ledger: ${esc(e.message)}</p></div>`;
    return;
  }

  c.innerHTML = '';
  c.appendChild(el('h2', { style: 'margin-bottom:16px', text: 'Finance Ledger' }));
  c.appendChild(el('div', { class: 'text-dim text-sm mb-16', text: 'Every Nerds gain and spend, exactly as it happened - focus sessions, level-ups, mastery tiers, plant claims, and Market purchases, grouped by day like a real statement. Entries marked with had a plant bonus applied.' }));

  const grid = el('div', { class: 'stats-grid' });
  grid.appendChild(el('div', { class: 'stat-card' }, [
    coinIcon(20), el('div', { class: 'stat-value', style: 'margin-top:6px', text: fmt(ledger.current_balance, 1) }),
    el('div', { class: 'stat-label', text: 'Current Balance' })
  ]));
  grid.appendChild(el('div', { class: 'stat-card' }, [
    el('div', { class: 'stat-value', style: 'color:var(--green)', text: '+' + fmt(ledger.total_income, 1) }),
    el('div', { class: 'stat-label', text: 'Total Earned (all time)' })
  ]));
  grid.appendChild(el('div', { class: 'stat-card' }, [
    el('div', { class: 'stat-value', style: 'color:var(--red)', text: fmt(ledger.total_expense, 1) }),
    el('div', { class: 'stat-label', text: 'Total Spent (all time)' })
  ]));
  c.appendChild(grid);

  if (!ledger.days.length) {
    c.appendChild(el('div', { class: 'card text-dim text-center', style: 'padding:40px', text: 'No Nerds activity yet. Log a focus session or claim a plant to get started.' }));
    return;
  }

  ledger.days.forEach(day => {
    const dayCard = el('div', { class: 'card fade-in' });
    dayCard.appendChild(el('div', { class: 'row', style: 'justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px' }, [
      el('div', { class: 'card-title', style: 'margin-bottom:0', text: day.date }),
      el('div', { class: 'row', style: 'gap:14px' }, [
        day.income > 0 ? el('span', { class: 'text-sm', style: 'color:var(--green);font-weight:700', text: `+${fmt(day.income, 1)}` }) : null,
        day.expense < 0 ? el('span', { class: 'text-sm', style: 'color:var(--red);font-weight:700', text: fmt(day.expense, 1) }) : null,
        el('span', { class: 'text-sm text-dim', text: `Net: ${day.net >= 0 ? '+' : ''}${fmt(day.net, 1)}` })
      ])
    ]));
    dayCard.appendChild(el('table', {}, [
      el('tbody', {}, day.entries.map(en => {
        const positive = en.amount >= 0;
        return el('tr', {}, [
          el('td', { style: 'width:30px' }, [uiIcon(positive ? ICONS.moneyGained : ICONS.moneySpent, 18)]),
          el('td', {}, [
            el('div', { text: en.label }),
            en.detail ? el('div', { class: 'text-dim text-sm', text: en.detail }) : null
          ]),
          el('td', { class: 'text-right', style: `font-weight:700;color:${positive ? 'var(--green)' : 'var(--red)'};white-space:nowrap`, text: `${positive ? '+' : ''}${fmt(en.amount, 1)}` }),
          el('td', { class: 'text-right text-dim text-sm', style: 'white-space:nowrap', text: fmt(en.balance_after, 1) })
        ]);
      }))
    ]));
    c.appendChild(dayCard);
  });
}

function buildThemeCard(t) {
  const isUnlocked = (gamification.unlocked_themes || []).includes(t.id);
  const isActive = currentThemeId() === t.id && !previewingTheme;
  const isPreviewing = previewingTheme === t.id;
  const perk = (gamification.theme_perks || {})[t.id];
  const stem = (THEME_META[t.id] || {}).background;
  const ownsVideo = themeOwnsUpgrade(t.id, 'video');
  const ownsAudio = themeOwnsUpgrade(t.id, 'ambient_audio');
  const media = el('div', { class: 'theme-card-media', style: 'background:linear-gradient(135deg,var(--bg3),var(--bg4))' });
  if (isActive && ownsVideo && themeBgMode(t.id) === 'video' && stem) {
    const v = el('video', { src: `/sprites/themes/${stem}.mp4`, muted: true, loop: true, autoplay: true, playsInline: true });
    v.addEventListener('error', () => v.remove());
    media.appendChild(v);
  }
  if (stem) {
    const img = el('img', { src: `/api/theme_thumb/${stem}`, alt: '', loading: 'lazy', decoding: 'async' });
    let retried = false;
    img.addEventListener('error', () => {
      // A burst of large images loading at once can make one fail transiently
      // (this is what left some cards gray) - retry once before giving up.
      if (!retried) { retried = true; setTimeout(() => { img.src = `/sprites/themes/${stem}.png?r=${Date.now()}`; }, 600); }
      else img.remove();
    });
    media.insertBefore(img, media.firstChild);
  }
  const status = isUnlocked ? (isActive ? 'Active' : 'Unlocked') : (isPreviewing ? 'Previewing' : (t.price ? 'Preview / Buy in Shop' : `Preview / Lv ${t.level}`));
  const glass = el('div', { class: 'theme-card-glass' });
  glass.appendChild(el('div', { class: 'theme-card-head' }, [
    el('span', { class: 'theme-card-name', text: t.label }),
    el('span', { class: 'theme-card-status', text: status })
  ]));
  if (perk) {
    const info = el('span', { class: 'theme-card-info', text: 'i' });
    attachTooltip(info, perk.desc, 'var(--gold)');
    glass.appendChild(el('div', { class: 'theme-card-perk' }, [el('span', { text: perk.name || 'Perk' }), info]));
  }
  if (isActive && t.premium) {
    const ctl = el('div', { class: 'theme-card-controls', onclick: (e) => e.stopPropagation() });
    const seg = el('div', { class: 'theme-seg' }, [
      el('button', { class: themeBgMode(t.id) === 'picture' || !ownsVideo ? 'on' : '', text: 'Picture', onclick: () => { setThemeBgMode(t.id, 'picture'); applyThemeVisuals(t.id); render(); } }),
      el('button', { class: ownsVideo && themeBgMode(t.id) === 'video' ? 'on' : '', text: 'Video', disabled: !ownsVideo, title: ownsVideo ? 'Use the video background' : 'Buy the Video BG upgrade first', onclick: () => { setThemeBgMode(t.id, 'video'); applyThemeVisuals(t.id); render(); } })
    ]);
    ctl.appendChild(seg);
    const muteBtn = el('button', {
      id: 'themeAudioMuteBtn', class: 'btn btn-sm btn-outline', disabled: !ownsAudio,
      title: ownsAudio ? (themeAudioMuted ? 'Theme audio muted' : 'Theme audio on') : 'Buy the Ambient Audio upgrade first',
      onclick: () => toggleThemeAudioMute()
    }, [uiIcon(ICONS.audioVolume, 15, themeAudioMuted || !ownsAudio ? 'icon-muted' : '')]);
    const slider = el('input', { class: 'audio-volume-slider', type: 'range', min: '0', max: '1', step: '0.01', value: String(themeAudioMuted ? 0 : themeAmbientVolume(t.id)), disabled: !ownsAudio });
    slider.addEventListener('input', () => setThemeAmbientVolume(t.id, slider.value));
    ctl.appendChild(el('div', { class: 'theme-audio-row' }, [muteBtn, slider]));
    if (THEME_FISH_TOTALS[t.id]) {
      const on = themeCreaturesOn(t.id);
      ctl.appendChild(el('button', {
        class: 'btn btn-sm btn-outline', text: `Creatures ${on ? 'On' : 'Off'} (${themeFishUnlockedCount(t.id)}/${THEME_FISH_TOTALS[t.id]})`,
        onclick: () => { localStorage.setItem('st_theme_creatures_' + t.id, on ? '0' : '1'); applyThemeVisuals(t.id); render(); }
      }));
    }
    glass.appendChild(ctl);
  }
  return el('div', {
    class: `theme-card${isActive || isPreviewing ? ' active' : ''}${t.premium ? ' premium' : ''}${isUnlocked ? '' : ' locked'}`,
    onclick: () => {
      if (isUnlocked) { exitThemePreview(); setTheme(t.id); refreshThemeGrid(); }
      else { startThemePreview(t.id); refreshThemeGrid(); }
    }
  }, [media, glass]);
}

// Re-renders ONLY the theme cards, not the whole Progression page.
function refreshThemeGrid() {
  const g = document.getElementById('themeCardGrid');
  if (!g || !gamification) return;
  const frag = document.createDocumentFragment();
  (gamification.theme_catalog || []).forEach(t => frag.appendChild(buildThemeCard(t)));
  g.replaceChildren(frag);
}

async function renderProgression(c) {
  c.innerHTML = '';
  c.appendChild(el('h2', { style: 'margin-bottom:16px', text: 'Progression' }));

  c.appendChild(el('div', { class: 'card fade-in' }, [
    el('div', { class: 'card-title', text: 'Progression & Cosmetics' }),
    gamification ? el('div', {}, [
      renderXpCard(),
      el('div', { class: 'text-sm text-dim mt-16 mb-8', text: 'Themes unlock as you level up. Locked ones show the level you need - keep studying!' }),
      el('div', { class: 'text-sm text-dim mb-8', text: 'Click a locked theme to preview it live - nothing is spent, and a banner lets you exit back to your current theme.' }),
      el('div', { class: 'theme-card-grid', id: 'themeCardGrid' }, (gamification.theme_catalog || []).map(buildThemeCard))
    ]) : el('div', { class: 'text-dim text-sm', text: gamificationError ? `Progression unavailable: ${gamificationError}` : 'Progression will appear after your first check-in.' })
  ]));

  // Vault theme preview - HIDDEN as of this build. The vault tier is
  // fully built and was verified via this dev-only preview, but it's
  // being held back pre-release and will be trickled in one theme at a
  // time as each one gets its own Quest Book unlock path. The section
  // itself (and startThemePreview's ability to preview a vault theme)
  // is left intact in app.js/server.py, just not surfaced here anymore
  // - flip this block back on whenever spot-checking a vault theme is
  // needed again.

  c.appendChild(el('div', { class: 'card fade-in' }, [
    el('div', { class: 'card-title', text: 'Weekly Quests' }),
    renderQuestsCard()
  ]));

  c.appendChild(el('div', { class: 'card fade-in' }, [
    el('div', { class: 'card-title', text: 'Achievements' }),
    el('div', { class: 'text-sm text-dim mb-8', text: "Bachelor's I-III → Master's I-III → PhD I-III → Laureate. Each tier earns more XP." }),
    renderBadgesGrid()
  ]));

  c.appendChild(el('div', { class: 'card fade-in' }, [
    el('div', { class: 'card-title', text: 'Subject Mastery' }),
    renderMasteryGrid('subject', 'Add subjects in Settings to start earning mastery.')
  ]));

  c.appendChild(el('div', { class: 'card fade-in' }, [
    el('div', { class: 'card-title', text: 'Skill Mastery' }),
    renderMasteryGrid('skill', 'Add skills in Settings to start earning mastery.')
  ]));

  c.appendChild(el('div', { class: 'card fade-in' }, [
    el('div', { class: 'card-title', text: 'Skill Category Mastery' }),
    el('div', { class: 'text-sm text-dim mb-8', text: "A category's mastery is an automatic aggregate of all its skills' combined progress." }),
    renderMasteryGrid('category', 'Group skills into a category in Settings to start earning category-level mastery.')
  ]));
}

// ═══════════════════════════════════════════
// UPDATES
// ═══════════════════════════════════════════
async function renderUpdatesCard() {
  const card = $('#updatesCard');
  if (!card) return;
  let status;
  try {
    status = await api('/api/update/check');
  } catch (e) {
    card.innerHTML = '';
    card.appendChild(el('div', { class: 'card-title', text: '\u2B06\uFE0F Updates' }));
    card.appendChild(el('div', { class: 'text-dim text-sm', text: 'Could not check for updates right now.' }));
    return;
  }
  card.innerHTML = '';
  card.appendChild(el('div', { class: 'card-title', text: '\u2B06\uFE0F Updates' }));
  if (!status.ok) {
    card.appendChild(el('div', { class: 'text-dim text-sm', text: status.error || 'Could not check for updates.' }));
    return;
  }
  if (!status.update_available) {
    card.appendChild(el('div', { class: 'text-dim text-sm', text: `You're up to date (${(status.current_sha || '').slice(0, 7)}).` }));
    card.appendChild(el('button', { class: 'btn btn-sm btn-outline mt-8', text: 'Check Again', onclick: renderUpdatesCard }));
    return;
  }
  card.appendChild(el('div', { class: 'text-sm mb-8' }, [
    el('span', { style: 'font-weight:700;color:var(--accent)', text: 'An update is available. ' }),
    el('span', { class: 'text-dim', text: status.message || '' })
  ]));
  card.appendChild(el('div', { class: 'text-dim text-sm mb-8', text: `${(status.current_sha || '').slice(0, 7)} \u2192 ${(status.latest_sha || '').slice(0, 7)}` }));
  if (status.frozen) {
    card.appendChild(el('div', { class: 'text-dim text-sm', text: 'This is a packaged .exe build - please download the latest release manually from the GitHub repo; auto-update only works when running from source (start.bat / launcher.bat).' }));
    return;
  }
  const applyBtn = el('button', { class: 'btn btn-sm', text: 'Download & Install Update', onclick: async () => {
    applyBtn.disabled = true;
    applyBtn.textContent = 'Downloading...';
    try {
      const result = await api('/api/update/apply', { method: 'POST' });
      if (!result.ok) { alert('Update failed: ' + (result.error || 'unknown error')); applyBtn.disabled = false; applyBtn.textContent = 'Download & Install Update'; return; }
      applyBtn.textContent = 'Restarting...';
      await api('/api/update/restart', { method: 'POST' });
      // The server process is about to swap itself out - give it a
      // moment, then reload the page so the person lands on the freshly
      // restarted (and updated) app instead of staring at a dead tab.
      setTimeout(() => { window.location.reload(); }, 3500);
    } catch (e) {
      alert('Update failed: ' + e.message);
      applyBtn.disabled = false;
      applyBtn.textContent = 'Download & Install Update';
    }
  } });
  card.appendChild(applyBtn);
  card.appendChild(el('div', { class: 'text-dim text-sm mt-8', text: 'This restarts the server automatically once applied - this browser tab will reload itself in a few seconds.' }));
}

// ═══════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════
async function renderSettings(c) {
  const cfg = cachedConfig || { subjects: [], skills: [], academic_years: [], skill_categories: [] };
  const liveSkills = (cfg.skills || []).filter(s => !s.archived);

  c.innerHTML = '';
  c.appendChild(el('h2', { style: 'margin-bottom:16px', text: 'Settings' }));

  // Profile management
  c.appendChild(el('div', { class: 'card fade-in' }, [
    el('div', { class: 'card-title', text: 'Profile Management' }),
    el('div', { class: 'row', style: 'gap:8px;margin-bottom:12px' }, [
      el('button', { class: 'btn', text: 'New Profile', onclick: showProfileModal }),
      el('button', { class: 'btn btn-outline', text: 'Rename Current', onclick: showRenameProfileModal }),
      el('button', { class: 'btn btn-outline', text: 'Export Profile', onclick: exportProfile }),
      el('button', { class: 'btn btn-danger', text: 'Delete Current', onclick: deleteCurrentProfile }),
      el('button', { class: 'btn btn-outline', text: 'Wipe Data', onclick: wipeData })
    ])
  ]));

  // Updates - checks the GitHub repo for a newer commit than this
  // install last synced to, and can download + apply + restart in one
  // flow. See renderUpdatesCard() below.
  c.appendChild(el('div', { class: 'card fade-in', id: 'updatesCard' }, [
    el('div', { class: 'card-title', text: '\u2B06\uFE0F Updates' }),
    el('div', { class: 'text-dim text-sm', text: 'Checking...' })
  ]));
  renderUpdatesCard();

  // Preferences - attendance default mode + ML prediction toggle
  c.appendChild(el('div', { class: 'card fade-in' }, [
    el('div', { class: 'card-title', text: 'Preferences' }),
    el('label', { text: 'Attendance Default Mode' }),
    el('div', { class: 'text-dim text-sm mb-8', text: "Pick the kind of student you are. Past scheduled classes are then auto-registered as that status, so you only need to log the exceptions (the opposite status) by hand. Requires subjects to have an academic year and weekly schedule assigned." }),
    (() => {
      const sel = el('select', {}, [
        el('option', { value: 'manual', text: 'Manual - I\'ll mark every class myself' }),
        el('option', { value: 'mostly_present', text: "I'm mostly present - auto-fill Present, I'll log absences" }),
        el('option', { value: 'mostly_absent', text: "I'm mostly absent - auto-fill Absent, I'll log when I attend" })
      ]);
      sel.value = cfg.attendance_default_mode || 'manual';
      sel.addEventListener('change', async () => {
        try {
          await api(`/api/${currentProfile}/config`, { method: 'PUT', body: JSON.stringify({ attendance_default_mode: sel.value }) });
          await loadConfig();
          if (sel.value !== 'manual') {
            await api(`/api/${currentProfile}/attendance/autofill`, { method: 'POST' });
            await loadData();
          }
          render();
        } catch (e) { alert(e.message); }
      });
      return sel;
    })(),
    el('div', { class: 'mt-16' }, [
      el('label', { text: 'Exam Score Prediction (ML)' }),
      el('div', { class: 'text-dim text-sm mb-8', text: 'Uses a small model trained on your own study history to predict exam scores and flag at-risk subjects. Some people find a running "predicted score" stressful - turn it off any time and you\'ll still get attendance/spaced-repetition recommendations.' }),
      (() => {
        const wrap = el('label', { class: 'row', style: 'align-items:center;gap:8px;text-transform:none;font-weight:500;cursor:pointer' });
        const cb = el('input', { type: 'checkbox', style: 'width:auto' });
        cb.checked = cfg.ml_prediction_enabled !== false;
        cb.addEventListener('change', async () => {
          try {
            await api(`/api/${currentProfile}/config`, { method: 'PUT', body: JSON.stringify({ ml_prediction_enabled: cb.checked }) });
            await loadConfig();
            render();
          } catch (e) { alert(e.message); }
        });
        wrap.appendChild(cb);
        wrap.appendChild(el('span', { text: 'Enable exam score predictions' }));
        return wrap;
      })()
    ])
  ]));

  // Academic Years - starts collapsed (see settingsYearsExpanded); once
  // set up at the start of a term this is rarely touched again, so it
  // shouldn't be first in line for scroll real-estate every visit.
  c.appendChild(el('div', { class: 'card fade-in' }, [
    el('div', {
      class: 'row', style: 'justify-content:space-between;align-items:center;cursor:pointer',
      onclick: () => { settingsYearsExpanded = !settingsYearsExpanded; localStorage.setItem('st_settings_years_expanded', settingsYearsExpanded ? '1' : '0'); render(); }
    }, [
      el('div', { class: 'card-title', style: 'margin-bottom:0', text: 'Academic Years' }),
      el('span', { class: 'text-dim', style: 'font-size:1.1rem', text: settingsYearsExpanded ? '▾' : '▸' })
    ]),
    settingsYearsExpanded ? el('div', { class: 'mt-16' }, [
    el('div', { class: 'row', style: 'gap:8px;margin-bottom:12px;flex-wrap:wrap' }, [
      el('input', { id: 'newYearLabel', placeholder: 'Label (e.g. 2026-2027)', style: 'width:180px' }),
      el('input', { id: 'newYearStart', type: 'date', style: 'width:150px' }),
      el('input', { id: 'newYearEnd', type: 'date', style: 'width:150px' }),
      el('button', { class: 'btn btn-sm', text: 'Add Year', onclick: addYear })
    ]),
    !cfg.academic_years.length ? el('div', { class: 'text-dim text-sm', text: 'No academic years yet.' }) :
    el('div', {}, cfg.academic_years.map(y => el('div', { style: 'border:1px solid var(--border);border-radius:var(--r-sm);padding:12px;margin-bottom:10px' }, [
      el('div', { class: 'row', style: 'justify-content:space-between;align-items:center;margin-bottom:8px' }, [
        el('div', {}, [
          el('strong', { text: y.label }),
          el('span', { class: 'text-dim text-sm', text: `  ${y.start_date} → ${y.end_date}`, style: 'margin-left:8px' })
        ]),
        el('div', { class: 'btn-group' }, [
          el('button', { class: 'btn btn-sm btn-outline', text: 'Edit Dates', onclick: () => showEditYearModal(y) }),
          el('button', { class: 'btn btn-sm btn-danger', text: 'Delete Year', onclick: async () => {
            if (!confirm(`Delete "${y.label}"? Subjects assigned to it will keep their date but lose the year link.`)) return;
            await api(`/api/${currentProfile}/years/${y.id}`, { method: 'DELETE' });
            await loadConfig(); render();
          } })
        ])
      ]),
      el('div', { class: 'row', style: 'gap:20px;flex-wrap:wrap;align-items:flex-start' }, [
        // Exam periods - during these dates, ONLY exams show on the
        // Timetable for subjects assigned to this year; regular lessons
        // are hidden. Exams can still be added outside these periods too.
        el('div', { style: 'flex:1;min-width:260px' }, [
          el('div', { style: 'font-weight:600;font-size:var(--font-s);margin-bottom:6px', text: 'Exam Periods' }),
          el('div', { class: 'text-dim text-sm mb-8', text: 'Only exams appear on the Timetable during these dates - lessons are hidden.' }),
          (y.exam_periods || []).length ? el('div', { class: 'mb-8' }, (y.exam_periods || []).map(p => el('div', { class: 'row', style: 'justify-content:space-between;padding:4px 0' }, [
            el('span', { class: 'text-sm', text: `${p.label}: ${p.start_date} → ${p.end_date}` }),
            el('button', { class: 'btn btn-sm btn-danger', text: '×', onclick: async () => {
              await api(`/api/${currentProfile}/years/${y.id}/exam_periods/${p.id}`, { method: 'DELETE' });
              await loadConfig(); render();
            } })
          ]))) : null,
          el('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' }, [
            el('input', { id: `epLabel_${y.id}`, placeholder: 'Label', style: 'width:100px' }),
            el('input', { id: `epStart_${y.id}`, type: 'date', style: 'width:140px' }),
            el('input', { id: `epEnd_${y.id}`, type: 'date', style: 'width:140px' }),
            el('button', { class: 'btn btn-sm btn-outline', text: '+ Add', onclick: async () => {
              const label = $(`#epLabel_${y.id}`).value.trim() || 'Exam Period';
              const start = $(`#epStart_${y.id}`).value, end = $(`#epEnd_${y.id}`).value;
              if (!start || !end) { alert('Pick both dates'); return; }
              await api(`/api/${currentProfile}/years/${y.id}/exam_periods`, { method: 'POST', body: JSON.stringify({ label, start_date: start, end_date: end }) });
              await loadConfig(); render();
            } })
          ])
        ]),
        // Vacation weeks - 0 lesson hours during these dates for subjects
        // assigned to this year, but skills CAN still be scheduled then
        // (focus/self-skilling keeps working over breaks).
        el('div', { style: 'flex:1;min-width:260px' }, [
          el('div', { style: 'font-weight:600;font-size:var(--font-s);margin-bottom:6px', text: 'Holidays & Vacations (this year only)' }),
          el('div', { class: 'text-dim text-sm mb-8', text: 'Year/level-specific breaks. Lessons are hidden; skills can still be scheduled. Nationwide holidays belong in Global Holidays.' }),
          (y.vacation_weeks || []).length ? el('div', { class: 'mb-8' }, (y.vacation_weeks || []).map(v => el('div', { class: 'row', style: 'justify-content:space-between;padding:4px 0' }, [
            el('span', { class: 'text-sm', text: `${v.label}: ${v.start_date} → ${v.end_date}` }),
            el('button', { class: 'btn btn-sm btn-danger', text: '×', onclick: async () => {
              await api(`/api/${currentProfile}/years/${y.id}/vacation_weeks/${v.id}`, { method: 'DELETE' });
              await loadConfig(); render();
            } })
          ]))) : null,
          el('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' }, [
            el('input', { id: `vwLabel_${y.id}`, placeholder: 'Label', style: 'width:100px' }),
            el('input', { id: `vwStart_${y.id}`, type: 'date', style: 'width:140px' }),
            el('input', { id: `vwEnd_${y.id}`, type: 'date', style: 'width:140px' }),
            el('button', { class: 'btn btn-sm btn-outline', text: '+ Add', onclick: async () => {
              const label = $(`#vwLabel_${y.id}`).value.trim() || 'Vacation';
              const start = $(`#vwStart_${y.id}`).value, end = $(`#vwEnd_${y.id}`).value;
              if (!start || !end) { alert('Pick both dates'); return; }
              await api(`/api/${currentProfile}/years/${y.id}/vacation_weeks`, { method: 'POST', body: JSON.stringify({ label, start_date: start, end_date: end }) });
              await loadConfig(); render();
            } })
          ])
        ])
      ])
    ])))
    ]) : null
  ]));

  // Global Holidays - common days off, apply to ALL academic years.
  c.appendChild((() => {
    const holidays = [...(cfg.global_holidays || [])].sort((a, b) => (a.start_date || '').localeCompare(b.start_date || ''));
    const save = async (list) => {
      try { await api(`/api/${currentProfile}/config`, { method: 'PUT', body: JSON.stringify({ global_holidays: list }) }); await loadConfig(); render(); }
      catch (e) { alert(e.message); }
    };
    const lbl = el('input', { placeholder: 'Label (e.g. Independence Day)', style: 'width:210px' });
    const st = el('input', { type: 'date', style: 'width:150px' });
    const en = el('input', { type: 'date', style: 'width:150px', title: 'Leave empty for a single day' });
    const yearly = el('input', { type: 'checkbox', style: 'width:auto', checked: true });
    return el('div', { class: 'card fade-in' }, [
      el('div', { class: 'card-title', text: 'Global Holidays' }),
      el('div', { class: 'text-dim text-sm mb-8', text: 'Days off nearly everyone gets. They apply to every academic year, hide lessons and skip attendance auto-fill. "Repeats yearly" recurs on the same dates each year. Year/level-specific vacations live per academic year above, next to exam periods.' }),
      holidays.length ? el('div', { class: 'mb-8' }, holidays.map(h => el('div', { class: 'row', style: 'justify-content:space-between;padding:4px 0' }, [
        el('span', { class: 'text-sm', text: `${h.label}: ${h.start_date}${h.end_date && h.end_date !== h.start_date ? ' → ' + h.end_date : ''}${h.yearly ? ' (every year)' : ''}` }),
        el('button', { class: 'btn btn-sm btn-danger', text: '×', onclick: () => save((cfg.global_holidays || []).filter(x => x.id !== h.id)) })
      ]))) : el('div', { class: 'text-dim text-sm mb-8', text: 'No global holidays yet.' }),
      el('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap;align-items:center' }, [
        lbl, st, en,
        el('label', { class: 'row', style: 'text-transform:none;gap:6px;margin:0;cursor:pointer' }, [yearly, el('span', { text: 'Repeats yearly' })]),
        el('button', { class: 'btn btn-sm btn-outline', text: '+ Add', onclick: () => {
          if (!st.value) { alert('Pick a start date'); return; }
          if (en.value && en.value < st.value) { alert('End date must not be before start date'); return; }
          save([...(cfg.global_holidays || []), { id: 'gh' + Math.random().toString(36).slice(2, 10), label: lbl.value.trim() || 'Holiday', start_date: st.value, end_date: en.value || st.value, yearly: yearly.checked }]);
        } })
      ])
    ]);
  })());

  // Subjects - category management lives inline at the top of this
  // card, mirroring the Skills card below exactly: a category can be
  // created (and deleted) on its own, with zero subjects assigned to
  // it, the same way Skill Categories always could.
  c.appendChild(el('div', { class: 'card fade-in' }, [
    el('div', { class: 'card-title', text: 'Subjects' }),
    el('div', { class: 'text-dim text-sm mb-8', text: 'Categories group related subjects together (e.g. "Mathematics" holding both "Algebra" and "Analysis"). A category can be reused as a Skill Category too - they\'re independent, so the same real-world topic can label both.' }),
    el('div', { class: 'row', style: 'gap:8px;margin-bottom:8px;flex-wrap:wrap;align-items:flex-end' }, [
      el('div', {}, [el('label', { text: 'New Category', style: 'margin:0 0 4px' }), el('input', { id: 'newSubCatName', placeholder: 'e.g. Mathematics', style: 'width:200px' })]),
      el('button', { class: 'btn btn-sm btn-outline', text: '+ Add Category', onclick: addSubjectCategory })
    ]),
    (cfg.subject_categories || []).length ? el('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap;margin-bottom:8px' },
      cfg.subject_categories.map(sc => el('span', { class: 'tag', style: 'background:var(--bg3);color:var(--text);display:inline-flex;align-items:center;gap:6px' }, [
        el('span', { text: sc.name }),
        el('span', { style: 'cursor:pointer;opacity:.7', text: '×', title: 'Delete category (subjects keep their data, just lose this grouping)', onclick: async () => {
          if (!confirm(`Delete category "${sc.name}"? Its subjects will become uncategorized.`)) return;
          await api(`/api/${currentProfile}/subject_categories/${sc.id}`, { method: 'DELETE' });
          await loadConfig(); render();
        } })
      ]))
    ) : null,
    el('div', { class: 'row', style: 'margin-bottom:12px' }, [el('button', { class: 'btn btn-sm', text: '+ Add Subject', onclick: showAddSubjectModal })]),
    el('div', { class: 'text-dim text-sm mb-8', text: 'Use the filter below to switch which year is shown.' }),
    el('div', { class: 'row', style: 'gap:8px;margin-bottom:10px;flex-wrap:wrap;align-items:center' }, [
      el('label', { text: 'Display year', style: 'margin:0' }),
      (() => {
        const yearFilter = el('select', { id: 'subjectYearFilter', style: 'width:auto' }, [
          el('option', { value: 'all', text: 'All years' }),
          ...cfg.academic_years.map(y => el('option', { value: y.id, text: y.label }))
        ]);
        yearFilter.value = subjectListYearFilter;
        yearFilter.addEventListener('change', () => {
          subjectListYearFilter = yearFilter.value || 'all';
          render();
        });
        return yearFilter;
      })()
    ]),
    (() => {
      const liveSubjects = cfg.subjects.filter(s => !s.archived);
      const subjectsToShow = subjectListYearFilter === 'all'
        ? liveSubjects
        : liveSubjects.filter(s => s.year_id === subjectListYearFilter);
      return subjectsToShow.length ? el('div', { style: 'max-height:320px;overflow:auto;border:1px solid var(--border);border-radius:var(--r-sm)' }, [
        el('table', { style: 'margin:0' }, [
          el('thead', {}, el('tr', {}, [el('th', { text: 'Color' }), el('th', { text: 'Name' }), el('th', { text: 'Diff' }), el('th', { text: 'Category' }), el('th', { text: 'Year' }), el('th', { text: 'Schedule' }), el("th", { text: "" })])),
          el('tbody', {}, subjectsToShow.map(s => {
        const yr = cfg.academic_years.find(y => y.id === s.year_id);
        const catSel = el('select', { style: 'width:auto;min-width:120px', title: 'Assign to a Subject Category - also moves its File Explorer folder' }, [
          el('option', { value: '', text: 'Uncategorized' }),
          ...(cfg.subject_categories || []).map(sc => el('option', { value: sc.id, text: sc.name }))
        ]);
        catSel.value = s.category_id || '';
        catSel.addEventListener('change', async () => {
          try { await api(`/api/${currentProfile}/subjects/${s.id}`, { method: 'PUT', body: JSON.stringify({ category_id: catSel.value }) }); await loadConfig(); render(); }
          catch (e) { alert(e.message); }
        });
        return el('tr', {}, [
          el('td', {}, colorPickerFor('subjects', s)),
          el('td', { text: s.name }),
          el('td', { text: s.difficulty + '/10' }),
          el('td', {}, catSel),
          el('td', { class: 'text-sm text-dim', text: yr ? yr.label : ' - ' }),
          el('td', { class: 'text-sm text-dim', text: (s.schedule || []).filter(sc => !sc.effective_to).map(sc => `${sc.day} ${lessonTypeLabel(sc.type)}${sc.part ? ' ' + sc.part : ''}${sc.recurrence && sc.recurrence !== 'weekly' ? ` (${sc.recurrence})` : ''}`).join(', ') || ' - ' }),
          el('td', {}, el('div', { class: 'btn-group' }, [
            el('button', { class: 'btn btn-sm btn-outline', text: 'Schedule', title: 'Manage schedule (add more than one slot per week)', onclick: () => showManageScheduleModal(s) }),
            el('button', { class: 'btn btn-sm btn-outline', text: 'Files', title: 'Open in File Explorer', onclick: () => { navigate('files'); pendingFileExplorerOpen = { ref_type: 'subject', ref_id: s.id }; render(); } }),
            el('button', { class: 'btn btn-sm btn-danger', text: 'Delete', onclick: async () => {
              if (!dangerConfirm(`Delete "${s.name}"? Its study hours, XP, Nerds and mastery are KEPT (it just disappears from your lists). Its weekly schedule, upcoming exams and files are deleted.`)) return;
              await api(`/api/${currentProfile}/subjects/${s.id}`, { method: 'DELETE' });
              await loadConfigAndGamification(); render();
            } })
          ]))
        ]);
          }))
        ])
      ]) : el('div', { class: 'text-dim text-sm', text: subjectListYearFilter === 'all' ? 'No subjects yet.' : 'No subjects match this year filter.' });
    })()
  ]));

  // Skills
  c.appendChild(el('div', { class: 'card fade-in' }, [
    el('div', { class: 'card-title', text: 'Skills' }),
    el('div', { class: 'text-dim text-sm mb-8', text: 'Categories group related skills together (e.g. "Software Engineering" holding both "Design" and "Programming Languages"). A category levels up automatically from its skills\' combined mastery - no separate tracking needed.' }),
    el('div', { class: 'row', style: 'gap:8px;margin-bottom:8px;flex-wrap:wrap;align-items:flex-end' }, [
      el('div', {}, [el('label', { text: 'New Category', style: 'margin:0 0 4px' }), el('input', { id: 'newSkillCatName', placeholder: 'e.g. Software Engineering', style: 'width:200px' })]),
      el('button', { class: 'btn btn-sm btn-outline', text: '+ Add Category', onclick: addSkillCategory })
    ]),
    cfg.skill_categories.length ? el('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap;margin-bottom:8px' },
      cfg.skill_categories.map(sc => el('span', { class: 'tag', style: 'background:var(--bg3);color:var(--text);display:inline-flex;align-items:center;gap:6px' }, [
        el('span', { text: sc.name }),
        el('span', { style: 'cursor:pointer;opacity:.7', text: '×', title: 'Delete category (skills keep their data, just lose this grouping)', onclick: async () => {
          if (!confirm(`Delete category "${sc.name}"? Its skills will become uncategorized.`)) return;
          await api(`/api/${currentProfile}/skill_categories/${sc.id}`, { method: 'DELETE' });
          await loadConfigAndGamification(); render();
        } })
      ]))
    ) : null,
    el('div', { class: 'row', style: 'gap:8px;margin-bottom:12px;flex-wrap:wrap' }, [
      el('input', { id: 'newSkillName', placeholder: 'Skill name', style: 'width:180px' }),
      el('select', { id: 'newSkillCat', style: 'width:auto' }, [
        el('option', { value: '', text: 'No category' }),
        ...cfg.skill_categories.map(c => el('option', { value: c.id, text: c.name }))
      ]),
      el('button', { class: 'btn btn-sm', text: 'Add Skill', onclick: addSkill })
    ]),
    liveSkills.length ? el('div', { style: 'max-height:320px;overflow:auto;border:1px solid var(--border);border-radius:var(--r-sm)' }, [
      el('table', { style: 'margin:0' }, [
        el('thead', {}, el('tr', {}, [el('th', { text: 'Color' }), el('th', { text: 'Name' }), el('th', { text: 'Category' }), el("th", { text: "" })])),
        el('tbody', {}, liveSkills.map(s => {
          const catSel = el('select', { style: 'width:auto;min-width:120px', title: 'Assign to a Skill Category - also moves its File Explorer folder' }, [
            el('option', { value: '', text: 'Uncategorized' }),
            ...cfg.skill_categories.map(c => el('option', { value: c.id, text: c.name }))
          ]);
          catSel.value = s.category_id || '';
          catSel.addEventListener('change', async () => {
            try { await api(`/api/${currentProfile}/skills/${s.id}`, { method: 'PUT', body: JSON.stringify({ category_id: catSel.value }) }); await loadConfigAndGamification(); render(); }
            catch (e) { alert(e.message); }
          });
          return el('tr', {}, [
          el('td', {}, colorPickerFor('skills', s)),
          el('td', { text: s.name }),
          el('td', {}, catSel),
          el('td', {}, el('div', { class: 'btn-group' }, [
            el('button', { class: 'btn btn-sm btn-outline', text: 'Rename', title: 'Rename skill', onclick: () => showRenameSkillModal(s) }),
            el('button', { class: 'btn btn-sm btn-outline', text: 'Files', title: 'Open in File Explorer', onclick: () => { navigate('files'); pendingFileExplorerOpen = { ref_type: 'skill', ref_id: s.id }; render(); } }),
            el('button', { class: 'btn btn-sm btn-danger', text: 'Delete', onclick: async () => {
              if (!dangerConfirm(`Delete "${s.name}"? Its study hours, XP, Nerds and mastery are KEPT (it just disappears from your lists). Its schedule and files are deleted.`)) return;
              await api(`/api/${currentProfile}/skills/${s.id}`, { method: 'DELETE' });
              await loadConfigAndGamification(); render();
            } })
          ]))
        ]);
        }))
      ])
    ]) : el('div', { class: 'text-dim text-sm', text: 'No skills yet.' })
  ]));

  // Files - the rich freeform file explorer now lives on its own page.
  c.appendChild(el('div', { class: 'card fade-in' }, [
    el('div', { class: 'card-title', text: 'Subject/Skill Files' }),
    el('div', { class: 'text-dim text-sm mb-8', text: 'File uploads, folders, notes, and media playback now live in their own dedicated File Explorer - richer than fits in this settings list.' }),
    el('button', { class: 'btn btn-sm', text: 'Open File Explorer →', onclick: () => navigate('files') })
  ]));

  if (pendingSettingsScroll === 'progression') {
    pendingSettingsScroll = null;
    setTimeout(() => {
      const target = document.getElementById('progressionCard');
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 0);
  }
}

// Inline color picker for a subject/skill row in Settings - saves on change.
function colorPickerFor(kind, item) {
  const ci = el('input', {
    type: 'color', value: /^#[0-9a-fA-F]{6}$/.test(item.color || '') ? item.color : '#4a90d9',
    title: 'Change color', style: 'width:34px;height:26px;padding:0;border:none;background:none;cursor:pointer'
  });
  ci.addEventListener('change', async () => {
    try {
      await api(`/api/${currentProfile}/${kind}/${item.id}`, { method: 'PUT', body: JSON.stringify({ color: ci.value }) });
      await loadConfig(); render();
    } catch (e) { alert(e.message); }
  });
  return ci;
}

function showProfileModal() {
  const nameInput = el('input', { placeholder: 'Profile name (e.g. university_year1)' });
  const content = el('div', {}, [
    el('div', { class: 'modal-header' }, [
      el('div', { class: 'modal-title', text: 'Create Profile' }),
      el('button', { class: 'modal-close', onclick: closeModal, text: '×' })
    ]),
    el('label', { text: 'Profile Name' }), nameInput,
    el('div', { class: 'btn-group', style: 'margin-top:16px;justify-content:flex-end' }, [
      el('button', { class: 'btn', text: 'Create', onclick: async () => {
        const name = nameInput.value.trim();
        if (!name) { alert('Enter a name'); return; }
        try {
          await api('/api/profiles', { method: 'POST', body: JSON.stringify({ name }) });
          currentProfile = name;
          closeModal();
          await loadProfiles();
          await loadConfig();
          await loadData();
          render();
        } catch (e) { alert(e.message); }
      }})
    ])
  ]);
  showModal(content);
}

function showRenameProfileModal() {
  if (!currentProfile) return;
  const nameInput = el('input', { value: currentProfile });
  const content = el('div', {}, [
    el('div', { class: 'modal-header' }, [
      el('div', { class: 'modal-title', text: 'Rename Profile' }),
      el('button', { class: 'modal-close', onclick: closeModal, text: '×' })
    ]),
    el('label', { text: 'New name (letters, numbers, _ and -)' }), nameInput,
    el('div', { class: 'btn-group', style: 'margin-top:16px;justify-content:flex-end' }, [
      el('button', { class: 'btn', text: 'Rename', onclick: async () => {
        const name = nameInput.value.trim();
        if (!name) { alert('Enter a name'); return; }
        try {
          await api(`/api/profiles/${currentProfile}/rename`, { method: 'POST', body: JSON.stringify({ name }) });
          closeModal();
          currentProfile = name;
          await loadProfiles();
          await switchProfile(name);
        } catch (e) { alert(e.message); }
      } })
    ])
  ]);
  showModal(content);
}

async function addYear() {
  const label = $('#newYearLabel').value.trim();
  const start = $('#newYearStart').value;
  const end = $('#newYearEnd').value;
  if (!label || !start || !end) { alert('Fill all fields'); return; }
  try {
    await api(`/api/${currentProfile}/years`, { method: 'POST', body: JSON.stringify({ label, start_date: start, end_date: end }) });
    $('#newYearLabel').value = ''; $('#newYearStart').value = ''; $('#newYearEnd').value = '';
    await loadConfig(); render();
  } catch (e) { alert(e.message); }
}

function showEditYearModal(y) {
  // Lets the bounds (and label) on an already-created academic year be
  // changed directly, instead of the previous delete-and-recreate-only
  // workflow. Same validation as add (end must come after start).
  const labelInput = el('input', { value: y.label, placeholder: 'Label (e.g. 2026-2027)' });
  const startInput = el('input', { type: 'date', value: y.start_date });
  const endInput = el('input', { type: 'date', value: y.end_date });
  const content = el('div', {}, [
    el('div', { class: 'modal-header' }, [
      el('div', { class: 'modal-title', text: 'Edit Academic Year' }),
      el('button', { class: 'modal-close', onclick: closeModal, text: '×' })
    ]),
    el('label', { text: 'Label' }), labelInput,
    el('div', { class: 'row', style: 'margin-top:8px' }, [
      el('div', { class: 'flex-1' }, [el('label', { text: 'Start Date' }), startInput]),
      el('div', { class: 'flex-1' }, [el('label', { text: 'End Date' }), endInput])
    ]),
    el('div', { class: 'text-dim text-sm mt-8', text: 'Exam periods and vacation weeks already set on this year are kept as-is - narrow the year\'s own bounds first if a period would now fall outside them.' }),
    el('div', { class: 'btn-group', style: 'margin-top:16px;justify-content:flex-end' }, [
      el('button', { class: 'btn', text: 'Save', onclick: async () => {
        const label = labelInput.value.trim();
        if (!label) { alert('Enter a label'); return; }
        if (!startInput.value || !endInput.value) { alert('Pick both dates'); return; }
        if (endInput.value <= startInput.value) { alert('End date must be after start date'); return; }
        try {
          await api(`/api/${currentProfile}/years/${y.id}`, {
            method: 'PUT',
            body: JSON.stringify({ label, start_date: startInput.value, end_date: endInput.value })
          });
          closeModal();
          await loadConfig(); render();
        } catch (e) { alert(e.message); }
      }})
    ])
  ]);
  showModal(content);
}

async function addSubjectCategory() {
  const name = $('#newSubCatName').value.trim();
  if (!name) { alert('Enter a category name'); return; }
  try {
    await api(`/api/${currentProfile}/subject_categories`, { method: 'POST', body: JSON.stringify({ name }) });
    $('#newSubCatName').value = '';
    await loadConfig(); render();
  } catch (e) { alert(e.message); }
}

function showRenameSkillModal(skill) {
  const nameInput = el('input', { value: skill.name, placeholder: 'Skill name' });
  const content = el('div', {}, [
    el('div', { class: 'modal-header' }, [
      el('div', { class: 'modal-title', text: 'Rename Skill' }),
      el('button', { class: 'modal-close', onclick: closeModal, text: '×' })
    ]),
    el('label', { text: 'Skill Name' }), nameInput,
    el('div', { class: 'btn-group', style: 'margin-top:16px;justify-content:flex-end' }, [
      el('button', { class: 'btn', text: 'Save', onclick: async () => {
        const newName = nameInput.value.trim();
        if (!newName) { alert('Enter a name'); return; }
        try {
          await api(`/api/${currentProfile}/skills/${skill.id}`, { method: 'PUT', body: JSON.stringify({ name: newName }) });
          closeModal();
          await loadConfigAndGamification(); render();
        } catch (e) { alert(e.message); }
      }})
    ])
  ]);
  showModal(content);
}

async function addSkill() {
  const name = $('#newSkillName').value.trim();
  const categoryId = $('#newSkillCat').value;
  if (!name) { alert('Enter name'); return; }
  try {
    await api(`/api/${currentProfile}/skills`, { method: 'POST', body: JSON.stringify({ name, category_id: categoryId, difficulty: 5 }) });
    $('#newSkillName').value = '';
    await loadConfigAndGamification(); render();
  } catch (e) { alert(e.message); }
}

async function addSkillCategory() {
  const name = $('#newSkillCatName').value.trim();
  if (!name) { alert('Enter a category name'); return; }
  try {
    await api(`/api/${currentProfile}/skill_categories`, { method: 'POST', body: JSON.stringify({ name }) });
    $('#newSkillCatName').value = '';
    await loadConfigAndGamification(); render();
  } catch (e) { alert(e.message); }
}


async function exportProfile() {
  window.location.href = `/api/${currentProfile}/export`;
}

async function deleteCurrentProfile() {
  if (!confirm(`Permanently delete profile "${currentProfile}" and all its data?`)) return;
  await api(`/api/profiles/${currentProfile}`, { method: 'DELETE' });
  currentProfile = null;
  await loadProfiles();
  if (currentProfile) {
    await loadConfig(); await loadData();
  }
  render();
}

async function wipeData() {
  if (!confirm('Wipe all tracking data for this profile? (subjects/years config preserved)')) return;
  // Backend route fixed from /api/profiles/<name>/wipe (GET, and which
  // used to be a no-op that re-saved the same data) to /api/<name>/wipe
  // (POST) - see server.py. Frontend now calls the matching path+method.
  await api(`/api/${currentProfile}/wipe`, { method: 'POST' });
  cachedData = null;
  await loadData();
  render();
}

// ═══════════════════════════════════════════
// FILE EXPLORER - freeform per-subject/skill file navigator
// ═══════════════════════════════════════════
let fileExplorerRef = null;     // { ref_type, ref_id, name, kindLabel }
let fileExplorerPath = '';      // '/'-separated, relative to the item's own root
let fileExplorerData = null;    // last-loaded {folders, files} for current path
let fileExplorerDragPath = null; // path currently being dragged (file or folder)

function fileDownloadUrl(ref, path, attachment) {
  const p = encodeURIComponent(path || '');
  return `/api/${currentProfile}/filetree/${ref.ref_type}/${ref.ref_id}/download?path=${p}${attachment ? '&as_attachment=1' : ''}`;
}
function joinFePath(base, name) { return base ? `${base}/${name}` : name; }
function feParentPath(path) { const i = path.lastIndexOf('/'); return i === -1 ? '' : path.slice(0, i); }

const FILE_KIND_ICONS = { audio: 'AUD', video: 'VID', pdf: 'PDF', epub: 'EPUB', image: 'IMG', text: 'TXT', markdown: 'MD', file: 'FILE' };

// Custom PNG icons (see uiIcon()) for the file kinds/extensions that
// come up constantly in a subject/skill's folder - folders themselves,
// markdown/text notes, PDFs, and the handful of code file types this
// app's own text editor understands. Anything not in this map keeps
// the plain text badge from FILE_KIND_ICONS above. Values are pulled
// from the ICONS manifest, so renaming a file there keeps this in sync
// automatically.
const FILE_ICON_PNG_BY_EXT = {
  '.md': ICONS.fileMarkdown, '.markdown': ICONS.fileMarkdown,
  '.txt': ICONS.fileTxt,
  '.pdf': ICONS.filePdf,
  '.py': ICONS.filePython,
  '.js': ICONS.fileJs, '.jsx': ICONS.fileJs, '.ts': ICONS.fileJs, '.tsx': ICONS.fileJs,
  '.css': ICONS.fileCss, '.scss': ICONS.fileCss,
  '.html': ICONS.fileHtml, '.htm': ICONS.fileHtml,
};
const FILE_ICON_FALLBACK_TEXT = {
  [ICONS.fileMarkdown]: 'MD', [ICONS.fileTxt]: 'TXT', [ICONS.filePdf]: 'PDF', [ICONS.filePython]: 'PY',
  [ICONS.fileJs]: 'JS', [ICONS.fileCss]: 'CSS', [ICONS.fileHtml]: 'HTML',
};
function folderCardIcon() {
  return uiIcon(ICONS.folder, 30, 'fe-card-icon-img', 'DIR');
}
function fileCardIcon(kind, filename) {
  const ext = '.' + (filename.split('.').pop() || '').toLowerCase();
  const pngName = FILE_ICON_PNG_BY_EXT[ext];
  if (pngName) return uiIcon(pngName, 30, 'fe-card-icon-img', FILE_ICON_FALLBACK_TEXT[pngName]);
  return el('div', { class: 'fe-card-icon', text: FILE_KIND_ICONS[kind] || '' });
}

async function renderFiles(c) {
  const cfg = cachedConfig || { subjects: [], skills: [], subject_categories: [], skill_categories: [] };

  if (pendingFileExplorerOpen) {
    const item = pendingFileExplorerOpen.ref_type === 'skill'
      ? (cfg.skills || []).find(s => s.id === pendingFileExplorerOpen.ref_id)
      : (cfg.subjects || []).find(s => s.id === pendingFileExplorerOpen.ref_id);
    if (item) { fileExplorerRef = { ref_type: pendingFileExplorerOpen.ref_type, ref_id: item.id, name: item.name }; fileExplorerPath = ''; }
    pendingFileExplorerOpen = null;
  }

  c.innerHTML = '';
  c.appendChild(el('h2', { style: 'margin-bottom:16px', text: 'File Explorer' }));

  const layout = el('div', { class: 'fe-layout' });

  // ── Sidebar: Category > Subject/Skill tree ──
  const sidebar = el('div', { class: 'fe-sidebar' });
  function sidebarSection(title, categories, items, refType) {
    sidebar.appendChild(el('div', { class: 'fe-sidebar-heading', text: title }));
    const byCategory = new Map();
    const uncategorized = [];
    items.forEach(it => {
      if (it.category_id && categories.find(cc => cc.id === it.category_id)) {
        if (!byCategory.has(it.category_id)) byCategory.set(it.category_id, []);
        byCategory.get(it.category_id).push(it);
      } else uncategorized.push(it);
    });
    // Alphabetical throughout - both the category order and the items
    // within each category/uncategorized bucket - rather than the
    // underlying arrays' creation order (oldest-first), which is what
    // cfg.subject_categories/skill_categories and cfg.subjects/skills
    // are naturally stored in.
    const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    const sortedCategories = [...categories].sort(byName);
    sortedCategories.forEach(cat => {
      const kids = (byCategory.get(cat.id) || []).slice().sort(byName);
      if (!kids.length) return;
      sidebar.appendChild(el('div', { class: 'fe-sidebar-cat', text: `${cat.name}` }));
      kids.forEach(it => sidebar.appendChild(sidebarItemBtn(it, refType)));
    });
    uncategorized.sort(byName).forEach(it => sidebar.appendChild(sidebarItemBtn(it, refType)));
  }
  function sidebarItemBtn(it, refType) {
    const active = fileExplorerRef && fileExplorerRef.ref_type === refType && fileExplorerRef.ref_id === it.id;
    return el('button', {
      class: `fe-sidebar-item${active ? ' active' : ''}`, text: it.name,
      onclick: () => { fileExplorerRef = { ref_type: refType, ref_id: it.id, name: it.name }; fileExplorerPath = ''; render(); }
    });
  }
  sidebarSection('Subjects', cfg.subject_categories || [], (cfg.subjects || []).filter(s => !s.archived), 'subject');
  sidebarSection('Skills', cfg.skill_categories || [], (cfg.skills || []).filter(s => !s.archived), 'skill');
  if (!(cfg.subjects || []).length && !(cfg.skills || []).length) {
    sidebar.appendChild(el('div', { class: 'text-dim text-sm', style: 'padding:8px', text: 'Add a subject or skill in Settings to get a folder here.' }));
  }
  layout.appendChild(sidebar);

  // ── Main panel ──
  const main = el('div', { class: 'fe-main' });
  if (!fileExplorerRef) {
    main.appendChild(el('div', { class: 'empty-state' }, [
      el('div', { text: 'Pick a subject or skill on the left to browse its files.' })
    ]));
  } else {
    let data;
    try {
      data = await api(`/api/${currentProfile}/filetree/${fileExplorerRef.ref_type}/${fileExplorerRef.ref_id}?path=${encodeURIComponent(fileExplorerPath)}`);
    } catch (e) {
      main.appendChild(el('div', { class: 'text-dim', text: `Could not load folder: ${esc(e.message)}` }));
      layout.appendChild(main); c.appendChild(layout); return;
    }
    fileExplorerData = data;

    // Breadcrumb
    const crumbWrap = el('div', { class: 'fe-breadcrumb' });
    crumbWrap.appendChild(el('span', { class: 'fe-crumb', text: fileExplorerRef.name, onclick: () => { fileExplorerPath = ''; render(); } }));
    let acc = '';
    fileExplorerPath.split('/').filter(Boolean).forEach(part => {
      acc = joinFePath(acc, part);
      const p = acc;
      crumbWrap.appendChild(el('span', { class: 'fe-crumb-sep', text: '/' }));
      crumbWrap.appendChild(el('span', { class: 'fe-crumb', text: part, onclick: () => { fileExplorerPath = p; render(); } }));
    });
    main.appendChild(crumbWrap);

    // Toolbar
    const fileInput = el('input', { type: 'file', multiple: true, style: 'display:none', onchange: async (e) => {
      const files = [...e.target.files];
      for (const f of files) {
        const fd = new FormData();
        fd.append('file', f);
        fd.append('path', fileExplorerPath);
        try { await fetch(`/api/${currentProfile}/filetree/${fileExplorerRef.ref_type}/${fileExplorerRef.ref_id}/upload`, { method: 'POST', body: fd }); }
        catch (err) { alert('Upload failed: ' + err.message); }
      }
      fileInput.value = '';
      render();
    } });
    main.appendChild(el('div', { class: 'fe-toolbar' }, [
      el('button', { class: 'btn btn-sm btn-outline', text: '+ New Folder', onclick: () => showFeNewFolderModal() }),
      el('button', { class: 'btn btn-sm btn-outline', text: '+ New File', onclick: () => showFeNewFileModal() }),
      el('button', { class: 'btn btn-sm', text: 'Upload', onclick: () => fileInput.click() }),
      fileInput,
      el('div', { class: 'flex-1' }),
      el('span', { class: 'text-dim text-sm', text: `${data.folders.length} folder${data.folders.length === 1 ? '' : 's'} · ${data.files.length} file${data.files.length === 1 ? '' : 's'}` })
    ]));

    const grid = el('div', { class: 'fe-grid' });

    if (fileExplorerPath) {
      grid.appendChild(el('div', {
        class: 'fe-card fe-folder-card fe-up', title: 'Up one level',
        onclick: () => { fileExplorerPath = feParentPath(fileExplorerPath); render(); },
        ondragover: (e) => e.preventDefault(),
        ondrop: (e) => feHandleDrop(e, feParentPath(fileExplorerPath))
      }, [el('div', { class: 'fe-card-icon', text: 'UP' }), el('div', { class: 'fe-card-name', text: '.. (up)' })]));
    }

    data.folders.forEach(f => {
      grid.appendChild(el('div', {
        class: 'fe-card fe-folder-card', draggable: true, title: f.name,
        onclick: () => { fileExplorerPath = joinFePath(fileExplorerPath, f.name); render(); },
        ondragstart: (e) => { fileExplorerDragPath = joinFePath(fileExplorerPath, f.name); e.dataTransfer.setData('text/plain', fileExplorerDragPath); },
        ondragover: (e) => e.preventDefault(),
        ondrop: (e) => feHandleDrop(e, joinFePath(fileExplorerPath, f.name))
      }, [
        folderCardIcon(),
        el('div', { class: 'fe-card-name', text: f.name }),
        el('div', { class: 'fe-card-meta', text: `${f.file_count} file${f.file_count === 1 ? '' : 's'}` }),
        feCardMenu(joinFePath(fileExplorerPath, f.name), f.name, true)
      ]));
    });

    data.files.forEach(f => {
      const fullPath = joinFePath(fileExplorerPath, f.name);
      grid.appendChild(el('div', {
        class: 'fe-card fe-file-card', draggable: true, title: f.name,
        onclick: () => openFileViewer(fileExplorerRef, fullPath, f),
        ondragstart: (e) => { fileExplorerDragPath = fullPath; e.dataTransfer.setData('text/plain', fullPath); }
      }, [
        fileCardIcon(f.kind, f.name),
        el('div', { class: 'fe-card-name', text: f.name }),
        el('div', { class: 'fe-card-meta', text: `${(f.size / 1024).toFixed(0)}KB${f.has_notes ? ' · Notes' : ''}` }),
        feCardMenu(fullPath, f.name, false, f)
      ]));
    });

    if (!data.folders.length && !data.files.length) {
      grid.appendChild(el('div', { class: 'empty-state', style: 'grid-column:1/-1' }, [
        el('div', { text: 'This folder is empty. Upload a file or create a subfolder.' })
      ]));
    }
    main.appendChild(grid);
  }
  layout.appendChild(main);
  c.appendChild(layout);
}

function feHandleDrop(e, toPath) {
  e.preventDefault();
  const path = fileExplorerDragPath || e.dataTransfer.getData('text/plain');
  if (!path || path === toPath) return;
  api(`/api/${currentProfile}/filetree/${fileExplorerRef.ref_type}/${fileExplorerRef.ref_id}/move`, {
    method: 'POST', body: JSON.stringify({ path, to_path: toPath })
  }).then(() => render()).catch(err => alert(err.message));
}

// Small "..." menu per card - rename/delete for everything, plus
// Play/Queue for audio files right from the grid (see requested "3-dot
// interaction menu" for sibling audio browsing, mirrored here too).
function feCardMenu(path, displayName, isFolder, fileInfo) {
  const btn = el('button', { class: 'fe-card-menu-btn', text: '⋮', onclick: (e) => {
    e.stopPropagation();
    const existing = document.querySelector('.fe-card-menu-popover');
    if (existing) existing.remove();
    const pop = el('div', { class: 'fe-card-menu-popover' });
    if (!isFolder && fileInfo && fileInfo.kind === 'audio') {
      pop.appendChild(el('div', { class: 'fe-menu-item', text: '▶ Play Now', onclick: () => { playAudioTrack(fileExplorerRef, path, displayName); pop.remove(); } }));
      pop.appendChild(el('div', { class: 'fe-menu-item', text: 'Add to Queue', onclick: () => { audioQueueAdd({ ref: fileExplorerRef, path, name: displayName }); pop.remove(); } }));
    }
    if (!isFolder && fileInfo && (fileInfo.kind === 'text' || fileInfo.kind === 'markdown')) {
      pop.appendChild(el('div', { class: 'fe-menu-item', text: 'Edit', onclick: () => { pop.remove(); openTextEditor(fileExplorerRef, path, displayName, fileInfo.kind); } }));
    }
    pop.appendChild(el('div', { class: 'fe-menu-item', text: 'Rename', onclick: () => { pop.remove(); showFeRenameModal(path, displayName); } }));
    pop.appendChild(el('div', { class: 'fe-menu-item fe-menu-danger', text: 'Delete', onclick: async () => {
      pop.remove();
      if (!confirm(`Delete "${displayName}"?${isFolder ? ' This deletes everything inside it too.' : ''}`)) return;
      await api(`/api/${currentProfile}/filetree/${fileExplorerRef.ref_type}/${fileExplorerRef.ref_id}/delete`, { method: 'POST', body: JSON.stringify({ path }) });
      render();
    } }));
    document.body.appendChild(pop);
    const rect = btn.getBoundingClientRect();
    const popWidth = 190; // matches .fe-card-menu-popover's min-width
    pop.style.top = `${rect.bottom + 4}px`;
    // Anchor to the BUTTON's right edge (rect.right), not its left - a
    // popover anchored at rect.left can render far from the ⋮ it came
    // from once its own width is accounted for, especially near the
    // right side of the screen where rect.left is already close to
    // window.innerWidth. Clamp both edges so it never runs off-screen.
    let left = rect.right - popWidth;
    left = Math.max(8, Math.min(left, window.innerWidth - popWidth - 8));
    pop.style.left = `${left}px`;
    setTimeout(() => document.addEventListener('click', () => pop.remove(), { once: true }), 0);
  } });
  return btn;
}

function showFeNewFolderModal() {
  const nameInput = el('input', { placeholder: 'Folder name' });
  const content = el('div', {}, [
    el('div', { class: 'modal-header' }, [el('div', { class: 'modal-title', text: 'New Folder' }), el('button', { class: 'modal-close', onclick: closeModal, text: '×' })]),
    el('label', { text: 'Name' }), nameInput,
    el('div', { class: 'btn-group', style: 'margin-top:16px;justify-content:flex-end' }, [
      el('button', { class: 'btn', text: 'Create', onclick: async () => {
        if (!nameInput.value.trim()) { alert('Enter a name'); return; }
        try {
          await api(`/api/${currentProfile}/filetree/${fileExplorerRef.ref_type}/${fileExplorerRef.ref_id}/mkdir`, { method: 'POST', body: JSON.stringify({ path: fileExplorerPath, name: nameInput.value.trim() }) });
          closeModal(); render();
        } catch (e) { alert(e.message); }
      } })
    ])
  ]);
  showModal(content);
}

function showFeNewFileModal() {
  const nameInput = el('input', { placeholder: 'e.g. notes.md, todo.txt' });
  const typeHint = el('div', { class: 'text-dim text-sm mt-8', text: 'Markdown (.md), plain text (.txt), and common code/config types can be created and edited right in the app.' });
  const content = el('div', {}, [
    el('div', { class: 'modal-header' }, [el('div', { class: 'modal-title', text: 'New Text/Markdown File' }), el('button', { class: 'modal-close', onclick: closeModal, text: '×' })]),
    el('label', { text: 'Filename (with extension)' }), nameInput, typeHint,
    el('div', { class: 'btn-group', style: 'margin-top:16px;justify-content:flex-end' }, [
      el('button', { class: 'btn', text: 'Create & Open', onclick: async () => {
        const filename = nameInput.value.trim();
        if (!filename) { alert('Enter a filename'); return; }
        try {
          const resp = await api(`/api/${currentProfile}/filetree/${fileExplorerRef.ref_type}/${fileExplorerRef.ref_id}/newfile`, { method: 'POST', body: JSON.stringify({ path: fileExplorerPath, name: filename, content: '' }) });
          closeModal();
          const fullPath = joinFePath(fileExplorerPath, resp.filename);
          openTextEditor(fileExplorerRef, fullPath, resp.filename, resp.kind);
          render();
        } catch (e) { alert(e.message); }
      } })
    ])
  ]);
  showModal(content);
}

function showFeRenameModal(path, currentName) {
  const nameInput = el('input', { value: currentName });
  const content = el('div', {}, [
    el('div', { class: 'modal-header' }, [el('div', { class: 'modal-title', text: 'Rename' }), el('button', { class: 'modal-close', onclick: closeModal, text: '×' })]),
    el('label', { text: 'New name' }), nameInput,
    el('div', { class: 'btn-group', style: 'margin-top:16px;justify-content:flex-end' }, [
      el('button', { class: 'btn', text: 'Save', onclick: async () => {
        if (!nameInput.value.trim()) { alert('Enter a name'); return; }
        try {
          await api(`/api/${currentProfile}/filetree/${fileExplorerRef.ref_type}/${fileExplorerRef.ref_id}/rename`, { method: 'POST', body: JSON.stringify({ path, new_name: nameInput.value.trim() }) });
          closeModal(); render();
        } catch (e) { alert(e.message); }
      } })
    ])
  ]);
  showModal(content);
}

// ── File viewers dispatch ──
function openFileViewer(ref, path, fileInfo) {
  if (fileInfo.kind === 'audio') { playAudioTrack(ref, path, fileInfo.name); return; }
  if (fileInfo.kind === 'video') { openVideoViewer(ref, path, fileInfo.name); return; }
  if (fileInfo.kind === 'pdf') { openPdfViewer(ref, path, fileInfo.name); return; }
  if (fileInfo.kind === 'epub') { openEpubViewer(ref, path, fileInfo.name); return; }
  if (fileInfo.kind === 'image') { openImageViewer(ref, path, fileInfo.name); return; }
  if (fileInfo.kind === 'text' || fileInfo.kind === 'markdown') { openTextEditor(ref, path, fileInfo.name, fileInfo.kind); return; }
  // Unrecognized file type (most commonly: a real PDF/video/etc that lost
  // its extension during a rename, e.g. "My Book" instead of "My
  // Book.pdf") - window.open() used to be called here, but in a
  // pywebview desktop window that can navigate the ENTIRE APP away from
  // its own UI to the raw file response instead of opening a real
  // separate window, effectively stranding the person outside the app
  // with no way back to rename/delete the very file that's broken. Stay
  // inside the app instead: offer a direct rename (the most common fix
  // see filetree_rename's extension-preserving behavior) plus a forced
  // download via a temporary <a download> click, which triggers the
  // OS's native save dialog without ever navigating this window away.
  showUnknownFileModal(ref, path, fileInfo);
}

function showUnknownFileModal(ref, path, fileInfo) {
  const content = el('div', {}, [
    el('div', { class: 'modal-header' }, [
      el('div', { class: 'modal-title', text: fileInfo.name }),
      el('button', { class: 'modal-close', onclick: closeModal, text: '×' })
    ]),
    el('div', { class: 'text-dim text-sm mb-16', text: "This file type isn't recognized for in-app preview - most often that means it's missing (or has the wrong) file extension. Renaming it to add the right extension (e.g. \".pdf\") is usually all it takes." }),
    el('div', { class: 'btn-group' }, [
      el('button', { class: 'btn', text: 'Rename', onclick: () => { closeModal(); showFeRenameModal(path, fileInfo.name); } }),
      el('button', { class: 'btn btn-outline', text: 'Download', onclick: () => {
        const a = document.createElement('a');
        a.href = fileDownloadUrl(ref, path, true);
        a.download = fileInfo.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
      } })
    ])
  ]);
  showModal(content);
}

let _localIdCounter = 0;
function _localId(prefix) { return `${prefix}_${++_localIdCounter}_${Date.now()}`; }

// Shared viewer chrome: a fullscreen toggle (the viewer modal is also
// manually resizable - see .fe-viewer-modal's CSS `resize: both`) so a
// PDF/video/image opened on a big monitor isn't stuck at the same small
// default size every other modal uses.
function toggleViewerFullscreen() {
  document.getElementById('modalContent').classList.toggle('fe-viewer-fullscreen');
}
function viewerHeader(title, onClose, extraButtons) {
  return el('div', { class: 'modal-header' }, [
    el('div', { class: 'modal-title truncate', text: title }),
    el('div', { class: 'row', style: 'gap:4px;flex-shrink:0' }, [
      ...(extraButtons || []),
      el('button', { class: 'btn btn-sm btn-outline', text: '⤢', title: 'Toggle fullscreen', onclick: toggleViewerFullscreen }),
      el('button', { class: 'modal-close', onclick: onClose || closeModal, text: '×' })
    ])
  ]);
}

function openImageViewer(ref, path, name) {
  showModal(el('div', { class: 'text-center' }, [
    viewerHeader(name, closeModal),
    el('img', { src: fileDownloadUrl(ref, path), style: 'max-width:100%;max-height:100%;display:inline-block;border-radius:var(--r-sm)' })
  ]));
  document.getElementById('modalContent').classList.add('fe-viewer-modal');
}

// ── Text / Markdown / Code editor - a quick-edit box for the kind of
// small change that doesn't deserve firing up a real code editor.
// Markdown gets a rendered Preview tab (via marked.js); anything else
// gets a syntax-highlighted Preview (via highlight.js) - both loaded
// from CDN in index.html. Edit is always the plain textarea; Save
// writes straight back to the file on disk. ──
const HLJS_EXT_LANG_MAP = { js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', rb: 'ruby', sh: 'bash', yml: 'yaml', md: 'markdown', htm: 'html' };

// ── Editor behavior constants (Tab width, auto-close pairs, bracket
// matching) - shared by every openTextEditor() instance. ──
const EDITOR_TAB_WIDTH = 4;
const EDITOR_AUTOCLOSE_PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };
const EDITOR_AUTOCLOSE_CLOSERS = new Set(Object.values(EDITOR_AUTOCLOSE_PAIRS));
const EDITOR_QUOTE_CHARS = new Set(['"', "'", '`']);
const EDITOR_BRACKET_OPEN_TO_CLOSE = { '(': ')', '[': ']', '{': '}' };
const EDITOR_BRACKET_CLOSE_TO_OPEN = { ')': '(', ']': '[', '}': '{' };

async function openTextEditor(ref, path, name, kind) {
  showModal(el('div', {}, [viewerHeader(name, closeModal), el('div', { class: 'text-dim mt-16', text: 'Loading...' })]));
  document.getElementById('modalContent').classList.add('fe-viewer-modal');

  let content = '';
  let loadError = null;
  try {
    const resp = await api(`/api/${currentProfile}/filetree/${ref.ref_type}/${ref.ref_id}/read_text?path=${encodeURIComponent(path)}`);
    content = resp.content;
  } catch (e) { loadError = e.message; }

  const isMarkdown = kind === 'markdown';
  const ext = (name.split('.').pop() || '').toLowerCase();
  const hljsLang = HLJS_EXT_LANG_MAP[ext] || ext;

  // ── Live-highlighted EDIT mode ──
  // A highlight.js-rendered <pre><code> sits directly behind the
  // textarea (see .fe-code-editor-stack in styles.css); the textarea's
  // own text is made transparent so only its caret shows, while the
  // colored twin underneath re-renders on every keystroke. Uses the
  // low-level hljs.highlight() call (not highlightElement()) since the
  // latter refuses to re-highlight the same element twice without
  // manually clearing its data-highlighted flag first - awkward for
  // something that needs to re-run on every keystroke.
  const highlightCode = el('code');
  const highlightPre = el('pre', { class: 'fe-code-highlight-pre', 'aria-hidden': 'true' }, [highlightCode]);
  // A second, transparent overlay sits ABOVE the syntax-color layer but
  // BELOW the (also transparent) textarea - it only ever draws a small
  // highlighted box around a matched bracket pair (see
  // refreshBracketMatch below), letting the syntax-colored character
  // underneath show through tinted rather than duplicating/covering it.
  const bracketCode = el('code');
  const bracketPre = el('pre', { class: 'fe-bracket-overlay-pre', 'aria-hidden': 'true' }, [bracketCode]);
  const textarea = el('textarea', { class: 'fe-code-editor-input', value: content, spellcheck: 'false' });
  const editorStack = el('div', { class: 'fe-code-editor-stack' }, [highlightPre, bracketPre, textarea]);

  function refreshHighlight() {
    const text = textarea.value;
    let html;
    if (window.hljs) {
      try {
        html = hljsLang && window.hljs.getLanguage(hljsLang)
          ? window.hljs.highlight(text, { language: hljsLang, ignoreIllegals: true }).value
          : window.hljs.highlightAuto(text).value;
      } catch (e) { html = esc(text); }
    } else {
      html = esc(text);
    }
    // A trailing newline renders one fewer visual line in a <pre> than
    // in a <textarea> unless something follows it - keeps the two
    // layers the same height so the caret never drifts below the
    // colored text on the last line.
    highlightCode.innerHTML = text.endsWith('\n') ? html + '\n' : html;
  }

  // ── Bracket matching ── When the (collapsed) cursor sits directly
  // next to a bracket, finds its partner and draws a small box around
  // both - same visual language as a real code editor's "jump to
  // match" highlight.
  function findMatchingBracket(text, pos) {
    const before = text[pos - 1], after = text[pos];
    let idx = -1;
    if (after && EDITOR_BRACKET_OPEN_TO_CLOSE[after]) idx = pos;
    else if (before && EDITOR_BRACKET_OPEN_TO_CLOSE[before]) idx = pos - 1;
    else if (after && EDITOR_BRACKET_CLOSE_TO_OPEN[after]) idx = pos;
    else if (before && EDITOR_BRACKET_CLOSE_TO_OPEN[before]) idx = pos - 1;
    if (idx === -1) return null;
    const ch = text[idx];
    if (EDITOR_BRACKET_OPEN_TO_CLOSE[ch]) {
      const close = EDITOR_BRACKET_OPEN_TO_CLOSE[ch];
      let depth = 0;
      for (let i = idx; i < text.length; i++) {
        if (text[i] === ch) depth++;
        else if (text[i] === close) { depth--; if (depth === 0) return [idx, i]; }
      }
    } else {
      const open = EDITOR_BRACKET_CLOSE_TO_OPEN[ch];
      let depth = 0;
      for (let i = idx; i >= 0; i--) {
        if (text[i] === ch) depth++;
        else if (text[i] === open) { depth--; if (depth === 0) return [i, idx]; }
      }
    }
    return null;
  }
  function refreshBracketMatch() {
    bracketCode.innerHTML = '';
    if (textarea.selectionStart !== textarea.selectionEnd) return;
    const text = textarea.value;
    const match = findMatchingBracket(text, textarea.selectionStart);
    if (!match) return;
    const [a, b] = match;
    let html = '';
    for (let i = 0; i < text.length; i++) {
      html += (i === a || i === b) ? `<span class="fe-bracket-match">${esc(text[i])}</span>` : esc(text[i]);
    }
    bracketCode.innerHTML = text.endsWith('\n') ? html + '\n' : html;
  }

  let highlightRaf = null;
  function scheduleHighlight() {
    if (highlightRaf) return;
    highlightRaf = requestAnimationFrame(() => { highlightRaf = null; refreshHighlight(); refreshBracketMatch(); });
  }
  let bracketRaf = null;
  function scheduleBracketMatch() {
    if (bracketRaf) return;
    bracketRaf = requestAnimationFrame(() => { bracketRaf = null; refreshBracketMatch(); });
  }
  textarea.addEventListener('input', scheduleHighlight);
  textarea.addEventListener('keyup', scheduleBracketMatch);
  textarea.addEventListener('click', scheduleBracketMatch);
  textarea.addEventListener('mouseup', scheduleBracketMatch);
  textarea.addEventListener('scroll', () => {
    highlightPre.scrollTop = textarea.scrollTop; highlightPre.scrollLeft = textarea.scrollLeft;
    bracketPre.scrollTop = textarea.scrollTop; bracketPre.scrollLeft = textarea.scrollLeft;
  });

  // ── Tab / Shift+Tab indent, multi-line aware ──
  function lineBoundsAround(text, start, end) {
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    let lineEnd = text.indexOf('\n', end);
    if (lineEnd === -1) lineEnd = text.length;
    return { lineStart, lineEnd };
  }
  const TAB_SPACES = ' '.repeat(EDITOR_TAB_WIDTH);
  function indentSelection() {
    const text = textarea.value;
    const selStart = textarea.selectionStart, selEnd = textarea.selectionEnd;
    if (!text.slice(selStart, selEnd).includes('\n')) {
      document.execCommand('insertText', false, TAB_SPACES);
      return;
    }
    const { lineStart, lineEnd } = lineBoundsAround(text, selStart, selEnd);
    const newBlock = text.slice(lineStart, lineEnd).split('\n').map(l => TAB_SPACES + l).join('\n');
    textarea.setSelectionRange(lineStart, lineEnd);
    document.execCommand('insertText', false, newBlock);
    textarea.setSelectionRange(selStart + EDITOR_TAB_WIDTH, lineStart + newBlock.length);
  }
  function dedentSelection() {
    const text = textarea.value;
    const selStart = textarea.selectionStart, selEnd = textarea.selectionEnd;
    const { lineStart, lineEnd } = lineBoundsAround(text, selStart, selEnd);
    let firstLineRemoved = 0;
    const newLines = text.slice(lineStart, lineEnd).split('\n').map((line, i) => {
      let removed = 0, out = line;
      if (out.startsWith(TAB_SPACES)) { removed = EDITOR_TAB_WIDTH; out = out.slice(EDITOR_TAB_WIDTH); }
      else if (out.startsWith('\t')) { removed = 1; out = out.slice(1); }
      else { const m = out.match(/^ +/); if (m) { removed = Math.min(m[0].length, EDITOR_TAB_WIDTH); out = out.slice(removed); } }
      if (i === 0) firstLineRemoved = removed;
      return out;
    });
    const newBlock = newLines.join('\n');
    textarea.setSelectionRange(lineStart, lineEnd);
    document.execCommand('insertText', false, newBlock);
    textarea.setSelectionRange(Math.max(lineStart, selStart - firstLineRemoved), lineStart + newBlock.length);
  }

  // ── Keydown: Tab indent, auto-close pairs, type-over, empty-pair
  // backspace - everything routed through document.execCommand rather
  // than assigning textarea.value directly, since a direct .value
  // assignment resets the browser's native undo/redo history, while
  // execCommand goes through the same pipeline as real typing and keeps
  // Ctrl+Z/Ctrl+Y working exactly as expected throughout. This app only
  // ever runs inside Windows' WebView2 (Chromium), so relying on
  // execCommand's still-solid Chromium support is safe here even though
  // it's deprecated for the general web.
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey) dedentSelection(); else indentSelection();
      scheduleHighlight();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const val = textarea.value;
    const selStart = textarea.selectionStart, selEnd = textarea.selectionEnd;

    if (e.key === 'Backspace' && selStart === selEnd && selStart > 0) {
      const before = val[selStart - 1], after = val[selStart];
      if (EDITOR_AUTOCLOSE_PAIRS[before] === after) {
        e.preventDefault();
        textarea.setSelectionRange(selStart - 1, selStart + 1);
        document.execCommand('delete', false);
        scheduleHighlight();
        return;
      }
    }
    if (selStart === selEnd && EDITOR_AUTOCLOSE_CLOSERS.has(e.key) && val[selStart] === e.key) {
      e.preventDefault();
      textarea.setSelectionRange(selStart + 1, selStart + 1);
      scheduleBracketMatch();
      return;
    }
    if (EDITOR_AUTOCLOSE_PAIRS[e.key]) {
      if (EDITOR_QUOTE_CHARS.has(e.key) && selStart === selEnd) {
        const prevChar = val[selStart - 1];
        if (prevChar && /[A-Za-z0-9_]/.test(prevChar)) return; // e.g. "don't" - let it type normally
      }
      e.preventDefault();
      const close = EDITOR_AUTOCLOSE_PAIRS[e.key];
      if (selStart !== selEnd) {
        const selected = val.slice(selStart, selEnd);
        document.execCommand('insertText', false, e.key + selected + close);
        textarea.setSelectionRange(selStart + 1, selStart + 1 + selected.length);
      } else {
        document.execCommand('insertText', false, e.key + close);
        textarea.setSelectionRange(selStart + 1, selStart + 1);
      }
      scheduleHighlight();
    }
  });

  refreshHighlight();

  const previewPane = el('div', { class: 'fe-text-preview hidden' });
  const editTabBtn = el('button', { class: 'btn btn-sm', text: 'Edit' });
  const previewTabBtn = el('button', { class: 'btn btn-sm btn-outline', text: isMarkdown ? 'Preview' : 'Rendered' });
  const statusSpan = el('span', { class: 'text-dim text-sm' });

  function renderPreview() {
    previewPane.innerHTML = '';
    if (isMarkdown && window.marked) {
      previewPane.classList.add('fe-markdown-body');
      previewPane.innerHTML = window.marked.parse(textarea.value);
      if (window.hljs) previewPane.querySelectorAll('pre code').forEach(b => window.hljs.highlightElement(b));
    } else if (window.hljs) {
      const code = el('code', { class: hljsLang ? `language-${hljsLang}` : '' });
      code.textContent = textarea.value;
      const pre = el('pre', {}, [code]);
      previewPane.appendChild(pre);
      window.hljs.highlightElement(code);
    } else {
      previewPane.appendChild(el('pre', { text: textarea.value }));
    }
  }
  function showEditMode() {
    editorStack.classList.remove('hidden'); previewPane.classList.add('hidden');
    editTabBtn.classList.remove('btn-outline'); previewTabBtn.classList.add('btn-outline');
    refreshHighlight();
    refreshBracketMatch();
  }
  function showPreviewMode() {
    renderPreview();
    editorStack.classList.add('hidden'); previewPane.classList.remove('hidden');
    previewTabBtn.classList.remove('btn-outline'); editTabBtn.classList.add('btn-outline');
  }
  editTabBtn.onclick = showEditMode;
  previewTabBtn.onclick = showPreviewMode;

  const saveBtn = el('button', { class: 'btn btn-sm btn-success', text: 'Save', onclick: async () => {
    try {
      await api(`/api/${currentProfile}/filetree/${ref.ref_type}/${ref.ref_id}/write_text`, { method: 'PUT', body: JSON.stringify({ path, content: textarea.value }) });
      statusSpan.textContent = 'Saved';
      setTimeout(() => { statusSpan.textContent = ''; }, 2500);
    } catch (e) { alert('Could not save: ' + e.message); }
  } });

  const body = loadError
    ? el('div', { class: 'recommendation warning mt-16', text: loadError })
    : el('div', { style: 'flex:1;min-height:0;display:flex;flex-direction:column' }, [
        el('div', { class: 'row', style: 'gap:8px;margin:8px 0;align-items:center;flex-shrink:0' }, [
          editTabBtn, previewTabBtn, el('div', { class: 'flex-1' }), statusSpan, saveBtn
        ]),
        editorStack, previewPane
      ]);

  showModal(el('div', { class: 'fe-viewer-text' }, [viewerHeader(name, closeModal), body]));
  document.getElementById('modalContent').classList.add('fe-viewer-modal');
  if (!loadError) showEditMode();
}

// ── EPUB viewer - uses epub.js (loaded from CDN, see index.html) for the
// actual zip/OPF/spine parsing and paginated CSS-reflow rendering; a
// from-scratch EPUB reader would be its own multi-week project on top
// of everything else here. Remembers the last reading position (a CFI
// string) per book via the same .filemeta.json sidecar the PDF/video
// viewers already use. ──
async function openEpubViewer(ref, path, name) {
  let meta = {};
  try { meta = await api(`/api/${currentProfile}/filetree/${ref.ref_type}/${ref.ref_id}/meta?path=${encodeURIComponent(path)}`); } catch (e) {}

  const readerEl = el('div', { class: 'fe-epub-reader' });
  const statusEl = el('div', { class: 'text-dim text-sm', text: 'Loading book…' });
  const progressLabel = el('span', { class: 'text-dim text-sm' });
  let rendition = null;

  const content = el('div', { class: 'fe-viewer-epub' }, [
    viewerHeader(name, closeModal),
    el('div', { class: 'row', style: 'gap:8px;align-items:center;margin-bottom:8px' }, [
      el('button', { class: 'btn btn-sm btn-outline', text: '◀ Prev', onclick: () => rendition && rendition.prev() }),
      el('button', { class: 'btn btn-sm btn-outline', text: 'Next ▶', onclick: () => rendition && rendition.next() }),
      el('div', { class: 'flex-1' }),
      el('span', { class: 'text-dim text-sm', text: '← / → also turn pages' }),
      progressLabel
    ]),
    statusEl,
    readerEl
  ]);
  showModal(content);
  document.getElementById('modalContent').classList.add('fe-viewer-modal', 'fe-viewer-epub-modal');

  if (!window.ePub && window.__libsReady) { statusEl.textContent = 'Loading reader…'; await window.__libsReady; }
  if (!window.ePub) {
    statusEl.textContent = 'Could not load the EPUB reader - this needs an internet connection the first time (it loads from a CDN).';
    return;
  }

  try {
    const book = ePub(fileDownloadUrl(ref, path));
    rendition = book.renderTo(readerEl, { width: '100%', height: '100%', flow: 'paginated' });
    await rendition.display(meta.epub_last_location || undefined);
    statusEl.classList.add('hidden');
    rendition.on('relocated', (location) => {
      api(`/api/${currentProfile}/filetree/${ref.ref_type}/${ref.ref_id}/meta`, {
        method: 'PUT', body: JSON.stringify({ path, epub_last_location: location.start.cfi })
      }).catch(() => {});
    });
    book.locations.generate(1600).then(() => {
      rendition.on('relocated', (location) => {
        const pct = book.locations.percentageFromCfi(location.start.cfi);
        progressLabel.textContent = isFinite(pct) ? `${Math.round(pct * 100)}%` : '';
      });
    }).catch(() => {});
    document.addEventListener('keydown', function _epubKeyNav(e) {
      if (!document.body.contains(readerEl)) { document.removeEventListener('keydown', _epubKeyNav); return; }
      if (e.key === 'ArrowRight') rendition.next();
      if (e.key === 'ArrowLeft') rendition.prev();
    });
  } catch (e) {
    statusEl.classList.remove('hidden');
    statusEl.textContent = 'Could not open this EPUB: ' + e.message;
  }
}

// PDF viewer: native browser rendering (iframe) plus a page-anchored
// notes panel, tabs so several PDFs stay open at once, and an optional
// side-by-side split view. Reuses the browser's own page nav/zoom/
// search instead of reimplementing a renderer, and layers tabs/notes/
// remembered page on top.
//
// The panel lives in its own persistent #pdfViewerHost (see
// index.html), outside the app's shared modal system, so opening or
// closing any other modal never touches it. The panel's × is the one
// "close everything" action (pdfCloseAll); minimizing
// (pdfToggleMinimize) never tears anything down.
let pdfTabs = [];          // [{ id, ref, path, name, page, notes, notesCollapsed, paneEl }]
let pdfActiveTabId = null;
let pdfSplitTabId = null;  // second pane's tab id, or null (single pane)
let pdfHostEls = null;     // { tabBarEl, splitRowEl, panesEl, titleEl } once the host panel is built, or null
let pdfMinimized = false;
let pdfFullscreen = false;

function _pdfTabKey(ref, path) { return `${ref.ref_type}:${ref.ref_id}:${path}`; }

async function openPdfViewer(ref, path, name) {
  const key = _pdfTabKey(ref, path);
  let tab = pdfTabs.find(t => t._key === key);
  if (!tab) {
    let meta = {};
    try { meta = await api(`/api/${currentProfile}/filetree/${ref.ref_type}/${ref.ref_id}/meta?path=${encodeURIComponent(path)}`); } catch (e) {}
    tab = { id: _localId('pdftab'), _key: key, ref, path, name, page: meta.pdf_last_page || 1, offset: meta.pdf_last_offset || 0, zoom: meta.pdf_zoom || 0, notes: meta.pdf_notes || [], notesCollapsed: false, paneEl: null, _pollInterval: null };
    pdfTabs.push(tab);
  }
  pdfActiveTabId = tab.id;
  // Opening a file (as opposed to just switching between already-open
  // tabs) always brings the panel back from a minimized state - that's
  // the whole point of clicking a PDF in the File Explorer.
  pdfMinimized = false;
  renderPdfViewerHost();
}

// Reads whichever page the embedded viewer is CURRENTLY showing (via
// its own same-origin URL hash) and saves it immediately. The
// background poll (see ensurePdfPane) already does this periodically
// while a tab sits open, but relying on that alone means closing a tab
// or the whole panel in between polls could lose up to a few seconds
// of the most recent page - flushing synchronously on every close path
// (tab close, full close, minimize) is what makes "reopen exactly where
// I left off" reliable rather than a matter of timing luck.
function pdfFlushPage(tab) {
  if (tab.viewer) {
    const p = tab.viewer.getPage();
    if (p) tab.page = p;
  }
  pdfSavePageMeta(tab);
}

function pdfCloseTab(id) {
  const closing = pdfTabs.find(t => t.id === id);
  if (closing) {
    pdfFlushPage(closing);
    if (closing._pollInterval) clearInterval(closing._pollInterval);
  }
  pdfTabs = pdfTabs.filter(t => t.id !== id);
  if (pdfSplitTabId === id) pdfSplitTabId = null;
  if (pdfActiveTabId === id) pdfActiveTabId = pdfTabs.length ? pdfTabs[pdfTabs.length - 1].id : null;
  // A tab promoted to "active" above can end up being the SAME tab that
  // was already set as the split partner - splitting a pane with itself
  // rendered as one lone pane forced to half-width by the .split CSS
  // class, with nothing showing in the other half. Also drop the split
  // partner outright once fewer than 2 tabs remain, since split view
  // makes no sense with only one tab open.
  if (pdfSplitTabId === pdfActiveTabId || pdfTabs.length < 2) pdfSplitTabId = null;
  if (!pdfTabs.length) { pdfCloseAll(); return; }
  renderPdfViewerHost();
}
// Fully tears down the PDF viewer session - every tab's page position
// flushed and poll interval stopped, panel hidden and cleared. This is
// the ONE way to actually close the whole viewer now (the panel's ×)
// there's no separate "Close All" anymore since the two were fully
// redundant; minimizing (see pdfToggleMinimize) is the non-destructive
// alternative for "get it out of my way without losing my tabs."
function pdfCloseAll() {
  pdfTabs.forEach(t => { pdfFlushPage(t); if (t._pollInterval) clearInterval(t._pollInterval); });
  pdfTabs = [];
  pdfActiveTabId = null;
  pdfSplitTabId = null;
  pdfMinimized = false;
  pdfFullscreen = false;
  const host = document.getElementById('pdfViewerHost');
  if (host) {
    host.classList.add('hidden');
    host.classList.remove('pdf-viewer-fullscreen', 'pdf-viewer-minimized');
    host.style.width = '';
    host.style.height = '';
    host.innerHTML = '';
  }
  pdfHostEls = null;
}
// Minimize is NON-destructive - every tab's iframe, scroll position,
// and notes stay exactly as they were; only the panel's body is hidden
// via CSS (see .pdf-viewer-host.pdf-viewer-minimized in styles.css).
// Mutually exclusive with fullscreen, and always clears any inline
// width/height the browser's native resize handle left behind - without
// that, the minimized pill would inherit whatever size the panel had
// last been dragged to, which is what produced the misshapen "ellipse"
// with buttons clipped outside its bounds.
function pdfToggleMinimize() {
  pdfMinimized = !pdfMinimized;
  if (pdfMinimized) pdfFullscreen = false;
  pdfTabs.forEach(pdfFlushPage);
  const host = document.getElementById('pdfViewerHost');
  if (host) {
    host.style.width = '';
    host.style.height = '';
    host.classList.toggle('pdf-viewer-minimized', pdfMinimized);
    host.classList.remove('pdf-viewer-fullscreen');
  }
  const btn = document.getElementById('pdfMinimizeBtn');
  if (btn) { btn.textContent = pdfMinimized ? '⤢' : '−'; btn.title = pdfMinimized ? 'Restore' : 'Minimize'; }
  if (!pdfMinimized) setTimeout(() => pdfTabs.forEach(t => t.viewer && t.viewer.restore()), 50);
}
function pdfToggleFullscreen() {
  pdfFullscreen = !pdfFullscreen;
  if (pdfFullscreen) pdfMinimized = false;
  const host = document.getElementById('pdfViewerHost');
  if (host) {
    host.style.width = '';
    host.style.height = '';
    host.classList.toggle('pdf-viewer-fullscreen', pdfFullscreen);
    host.classList.remove('pdf-viewer-minimized');
  }
  const btn = document.getElementById('pdfMinimizeBtn');
  if (btn) { btn.textContent = '−'; btn.title = 'Minimize'; }
}
function pdfSavePageMeta(tab) {
  api(`/api/${currentProfile}/filetree/${tab.ref.ref_type}/${tab.ref.ref_id}/meta`, { method: 'PUT', body: JSON.stringify({ path: tab.path, pdf_last_page: tab.page, pdf_last_offset: tab.offset || 0, pdf_zoom: tab.zoom || 0 }) }).catch(() => {});
}
function pdfSaveNotesMeta(tab) {
  api(`/api/${currentProfile}/filetree/${tab.ref.ref_type}/${tab.ref.ref_id}/meta`, { method: 'PUT', body: JSON.stringify({ path: tab.path, pdf_notes: tab.notes }) }).catch(() => {});
}

// Builds a tab's pane DOM (iframe + notes panel) the FIRST time it's
// needed, then returns the same cached node forever after - this is
// what makes switching tabs/toggling split view free of any reload.
// ── Cultivar PDF engine (built on pdf.js core) ──
// Own viewer layer: lazy page rendering with CSS-instant zoom, real text
// layer (selection/copy), word-level search highlighting backed by a
// background text index, outline + thumbnails, fit modes, ctrl+wheel/pinch
// zoom anchored on the cursor, native-speed printing, and exact resume
// (page + offset + zoom).
const PDFJS_WORKER_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const PDFJS_CMAP_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/';
const PDFJS_FONT_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/standard_fonts/';
const PDF_PX_PER_PT = 96 / 72;            // displayed 100% == 96dpi, like the browser viewer
const PDF_MIN_SCALE = 0.25, PDF_MAX_SCALE = 6;
const PDF_MAX_CANVAS_PIXELS = 16 * 1024 * 1024;

function buildPdfJsViewer(tab, onPageChange) {
  const scroller = el('div', { class: 'pdfjs-scroller', tabindex: '0' });
  const sidebar = el('div', { class: 'pdfjs-sidebar hidden' });
  const resizer = el('div', { class: 'pdfjs-sidebar-resizer hidden', title: 'Drag to resize' });
  const wrap = el('div', { class: 'pdfjs-wrap' }, [sidebar, resizer, scroller]);
  const savedSbW = parseInt(localStorage.getItem('st_pdf_sidebar_w'), 10);
  if (savedSbW >= 120) sidebar.style.width = `${savedSbW}px`;
  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX, startW = sidebar.getBoundingClientRect().width;
    const maxW = Math.max(160, wrap.getBoundingClientRect().width - 200);
    document.body.style.userSelect = 'none';
    function mv(ev) {
      const w = Math.max(120, Math.min(maxW, startW + ev.clientX - startX));
      sidebar.style.width = `${w}px`;
    }
    function up() {
      document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up);
      document.body.style.userSelect = '';
      localStorage.setItem('st_pdf_sidebar_w', String(Math.round(sidebar.getBoundingClientRect().width)));
    }
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  });
  const cleanOutlineTitle = (t) => String(t || '')
    .replace(/[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028-\u202F\u2060-\u206F\uE000-\uF8FF\uFEFF\uFFF0-\uFFFF]/g, '')
    .replace(/\s+/g, ' ').trim();
  const status = el('div', { class: 'text-dim text-sm', style: 'padding:14px', text: 'Loading PDF…' });
  scroller.appendChild(status);

  let pdf = null, baseSizes = [], holders = [], tops = [], observer = null;
  let scale = tab.zoom || 0, current = tab.page || 1, ready = false;
  let saveTimer = null, zoomTimer = null;
  const api_ = { el: wrap, numPages: 0 };

  const clampScale = (s) => Math.max(PDF_MIN_SCALE, Math.min(PDF_MAX_SCALE, s));
  function computeTops() { tops = holders.map(h => h.offsetTop); }
  function pageFromScroll() {
    if (!tops.length) return current;
    const y = scroller.scrollTop + 40;
    let lo = 0, hi = tops.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (tops[mid] <= y) lo = mid; else hi = mid - 1; }
    return lo + 1;
  }
  function syncState() {
    if (!ready || scroller.clientHeight === 0) return;
    const p = pageFromScroll();
    current = p; tab.page = p;
    const h = holders[p - 1];
    if (h) tab.offset = Math.max(0, Math.min(0.98, (scroller.scrollTop - h.offsetTop) / Math.max(1, h.offsetHeight)));
  }
  function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(() => pdfSavePageMeta(tab), 700); }

  scroller.addEventListener('scroll', () => {
    if (!ready || scroller.clientHeight === 0) return;
    const prev = current;
    syncState();
    if (current !== prev) { if (onPageChange) onPageChange(current); markThumb(current); }
    scheduleSave();
  }, { passive: true });

  // ── Page rendering ──
  function unloadPage(h) {
    if (h._task) { try { h._task.cancel(); } catch (e) {} }
    h.querySelectorAll('canvas, .textLayer').forEach(n => n.remove());
    h._renderedScale = null;
  }

  async function renderPage(i) {
    const h = holders[i - 1];
    if (!h || !h._visible || h._busy || h._renderedScale === scale) return;
    h._busy = true;
    const target = scale;
    try {
      const page = await pdf.getPage(i);
      if (!h._visible || target !== scale) return;
      const cssVp = page.getViewport({ scale: target });
      let dpr = Math.min(window.devicePixelRatio || 1, 2);
      let vp = page.getViewport({ scale: target * dpr });
      const px = vp.width * vp.height;
      if (px > PDF_MAX_CANVAS_PIXELS) vp = page.getViewport({ scale: target * dpr * Math.sqrt(PDF_MAX_CANVAS_PIXELS / px) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
      canvas.style.width = `${cssVp.width}px`; canvas.style.height = `${cssVp.height}px`;
      const task = page.render({ canvasContext: canvas.getContext('2d'), viewport: vp });
      h._task = task;
      await task.promise;
      h._task = null;
      if (!h._visible || target !== scale) return;
      h.querySelectorAll('canvas, .textLayer').forEach(n => n.remove());
      h.insertBefore(canvas, h.firstChild);
      h._renderedScale = target;

      try {
        const tl = el('div', { class: 'textLayer' });
        tl.style.width = `${cssVp.width}px`; tl.style.height = `${cssVp.height}px`;
        tl.style.setProperty('--scale-factor', String(target));
        tl.addEventListener('mousedown', () => {
          tl.classList.add('selecting');
          const up = () => { tl.classList.remove('selecting'); document.removeEventListener('mouseup', up); };
          document.addEventListener('mouseup', up);
        });
        h.appendChild(tl);
        const tc = await page.getTextContent();
        if (!h._visible || target !== scale) { tl.remove(); return; }
        await pdfjsLib.renderTextLayer({ textContentSource: tc, container: tl, viewport: cssVp, textDivs: [] }).promise;
        tl.appendChild(el('div', { class: 'endOfContent' }));
        applyHits(tl, i);
      } catch (e) { /* text layer is a bonus - the page still shows */ }
    } catch (e) {
      if (!(e && e.name === 'RenderingCancelledException')) h._renderedScale = target; // don't retry-loop on real errors
    } finally {
      h._busy = false; h._task = null;
      if (h._visible && h._renderedScale !== scale) renderPage(i);
    }
  }

  function layout() {
    if (observer) observer.disconnect();
    scroller.innerHTML = '';
    holders = baseSizes.map(([w, h], idx) => {
      const d = el('div', { class: 'pdfjs-page', style: `width:${w * scale}px;height:${h * scale}px` });
      d.dataset.page = String(idx + 1); d._visible = false; d._renderedScale = null;
      scroller.appendChild(d);
      return d;
    });
    observer = new IntersectionObserver((entries) => {
      entries.forEach(en => {
        const h = en.target, i = parseInt(h.dataset.page, 10);
        if (en.isIntersecting) { h._visible = true; renderPage(i); }
        else { h._visible = false; unloadPage(h); }
      });
    }, { root: scroller, rootMargin: '1400px 0px' });
    holders.forEach(h => observer.observe(h));
    computeTops();
  }

  function goToPage(p, silent, frac) {
    p = Math.max(1, Math.min(api_.numPages || 1, parseInt(p, 10) || 1));
    computeTops();
    current = p; tab.page = p;
    const h = holders[p - 1];
    scroller.scrollTop = h ? h.offsetTop + (frac ? frac * h.offsetHeight : -4) : 0;
    if (onPageChange) onPageChange(p);
    markThumb(p);
    if (!silent) scheduleSave();
  }

  // ── Zoom ──
  function applyScale(newScale, cy) {
    if (!ready) return;
    newScale = clampScale(newScale);
    if (Math.abs(newScale - scale) < 0.0005) return;
    if (cy === undefined) cy = scroller.clientHeight / 2;
    const frac = (scroller.scrollTop + cy) / Math.max(1, scroller.scrollHeight);
    const ratio = newScale / scale;
    scale = newScale; tab.zoom = scale;
    holders.forEach((h, idx) => {
      const [w, hh] = baseSizes[idx];
      h.style.width = `${w * scale}px`; h.style.height = `${hh * scale}px`;
      const cv = h.querySelector('canvas');
      if (cv) { cv.style.width = `${parseFloat(cv.style.width) * ratio}px`; cv.style.height = `${parseFloat(cv.style.height) * ratio}px`; }
      h.querySelectorAll('.textLayer').forEach(n => n.remove());
      if (!cv) h._renderedScale = null;
    });
    scroller.scrollTop = frac * scroller.scrollHeight - cy;
    computeTops();
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => holders.forEach((h, i) => { if (h._visible) { h._renderedScale = null; renderPage(i + 1); } }), 140);
    if (api_.onZoom) api_.onZoom(scale);
    scheduleSave();
  }
  api_.setScale = (s) => applyScale(s);
  api_.getScale = () => scale;
  api_.zoomBy = (f, cy) => applyScale(scale * f, cy);
  api_.fitWidth = () => { const w = (baseSizes[current - 1] || baseSizes[0] || [600])[0]; applyScale((scroller.clientWidth - 28) / w); };
  api_.fitPage = () => {
    const [w, h] = baseSizes[current - 1] || baseSizes[0] || [600, 800];
    applyScale(Math.min((scroller.clientWidth - 28) / w, (scroller.clientHeight - 20) / h));
    goToPage(current, true);
  };
  scroller.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const d = Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 60);
    const rect = scroller.getBoundingClientRect();
    api_.zoomBy(Math.exp(-d * 0.0025 * 1.2), e.clientY - rect.top);
  }, { passive: false });

  // ── Search (background text index + word-level highlights) ──
  let query = '', hits = [], hitPos = -1, searchToken = 0, curHit = null;
  const pageItems = [], indexPromises = [];
  let indexedCount = 0;
  function indexPage(i) {
    if (indexPromises[i]) return indexPromises[i];
    indexPromises[i] = (async () => {
      try {
        const pg = await pdf.getPage(i);
        const tc = await pg.getTextContent();
        pageItems[i] = tc.items.map(x => (x.str || '').toLowerCase());
        pg.cleanup();
      } catch (e) { pageItems[i] = []; }
      indexedCount++;
      if (api_.onIndexProgress) api_.onIndexProgress(indexedCount, api_.numPages);
    })();
    return indexPromises[i];
  }
  function startIndexing() {
    let next = 1;
    const worker = async () => { while (true) { const i = next++; if (i > api_.numPages) return; await indexPage(i); } };
    for (let k = 0; k < 4; k++) worker();
  }
  function countIn(str, q) { let c = 0, p = 0, x; while ((x = str.indexOf(q, p)) !== -1) { c++; p = x + q.length; } return c; }

  function applyHits(tl, pageNum) {
    tl.querySelectorAll('span').forEach(sp => { if (sp._orig !== undefined) { sp.textContent = sp._orig; sp._orig = undefined; } });
    if (!query) return;
    tl.querySelectorAll('span').forEach(sp => {
      const t = sp.textContent, lo = t.toLowerCase();
      if (!lo.includes(query)) return;
      sp._orig = t; sp.textContent = '';
      let pos = 0, idx;
      while ((idx = lo.indexOf(query, pos)) !== -1) {
        if (idx > pos) sp.appendChild(document.createTextNode(t.slice(pos, idx)));
        const m = document.createElement('mark'); m.className = 'pdf-hit'; m.textContent = t.slice(idx, idx + query.length);
        sp.appendChild(m); pos = idx + query.length;
      }
      if (pos < t.length) sp.appendChild(document.createTextNode(t.slice(pos)));
    });
    if (curHit && curHit.page === pageNum) {
      const marks = tl.querySelectorAll('mark.pdf-hit');
      const m = marks[Math.min(curHit.k, marks.length - 1)];
      if (m) m.classList.add('pdf-hit-current');
    }
  }
  function refreshHighlights() {
    holders.forEach((h, i) => { const tl = h.querySelector('.textLayer'); if (tl) applyHits(tl, i + 1); });
  }

  api_.search = async (q, onProgress, onFirst) => {
    if (!pdf) return 0;
    const token = ++searchToken;
    query = (q || '').toLowerCase().trim(); hits = []; hitPos = -1; curHit = null;
    refreshHighlights();
    if (!query) return 0;
    const n = api_.numPages, order = [];
    for (let i = current; i <= n; i++) order.push(i);
    for (let i = 1; i < current; i++) order.push(i);
    let firstFired = false;
    for (let s = 0; s < order.length; s += 16) {
      const batch = order.slice(s, s + 16);
      await Promise.all(batch.map(indexPage));
      if (token !== searchToken) return -1;
      batch.forEach(pg => {
        let k = 0;
        (pageItems[pg] || []).forEach(str => { const c = countIn(str, query); for (let j = 0; j < c; j++) hits.push({ page: pg, k: k++ }); });
      });
      if (onProgress) onProgress(Math.min(order.length, s + 16), hits.length);
      if (!firstFired && hits.length) { firstFired = true; if (onFirst) onFirst(); }
    }
    refreshHighlights();
    return hits.length;
  };
  api_.step = (dir) => {
    if (!hits.length) return null;
    hitPos = (hitPos + dir + hits.length) % hits.length;
    const h = hits[hitPos];
    curHit = h;
    holders.forEach(x => x.querySelectorAll('.pdf-hit-current').forEach(m => m.classList.remove('pdf-hit-current')));
    goToPage(h.page);
    let tries = 0;
    const focus = () => {
      const holder = holders[h.page - 1];
      const marks = holder ? holder.querySelectorAll('mark.pdf-hit') : [];
      if (marks.length) {
        marks.forEach(m => m.classList.remove('pdf-hit-current'));
        const m = marks[Math.min(h.k, marks.length - 1)];
        m.classList.add('pdf-hit-current');
        const r = m.getBoundingClientRect(), sr = scroller.getBoundingClientRect();
        scroller.scrollTop += r.top - sr.top - scroller.clientHeight / 2;
        scroller.scrollLeft += r.left - sr.left - scroller.clientWidth / 2;
      } else if (tries++ < 20) setTimeout(focus, 150);
    };
    setTimeout(focus, 60);
    return { pos: hitPos + 1, total: hits.length };
  };

  // ── Printing ──
  function printViaIframe(url, revoke) {
    return new Promise((resolve, reject) => {
      const f = document.createElement('iframe');
      f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0';
      f.onload = () => setTimeout(() => {
        try { f.contentWindow.focus(); f.contentWindow.print(); resolve(); } catch (e) { reject(e); }
        setTimeout(() => { f.remove(); if (revoke) URL.revokeObjectURL(url); }, 180000);
      }, 700);
      f.src = url;
      document.body.appendChild(f);
    });
  }
  api_.printNative = async (from, to, onProgress) => {
    from = Math.max(1, from || 1); to = Math.min(api_.numPages, to || api_.numPages);
    if (from <= 1 && to >= api_.numPages) return printViaIframe(fileDownloadUrl(tab.ref, tab.path), false);
    if (!window.PDFLib) throw new Error('pdf-lib not loaded');
    if (onProgress) onProgress('Extracting pages…');
    const bytes = await pdf.getData();
    const src = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const out = await PDFLib.PDFDocument.create();
    const idx = []; for (let i = from - 1; i < to; i++) idx.push(i);
    for (let s = 0; s < idx.length; s += 100) {
      const pgs = await out.copyPages(src, idx.slice(s, s + 100));
      pgs.forEach(p => out.addPage(p));
      if (onProgress) onProgress(`Extracting pages… ${Math.min(idx.length, s + 100)}/${idx.length}`);
      await new Promise(r => setTimeout(r, 0));
    }
    const saved = await out.save();
    return printViaIframe(URL.createObjectURL(new Blob([saved], { type: 'application/pdf' })), true);
  };
  api_.printRendered = async (from, to, onProgress) => {
    from = Math.max(1, from || 1); to = Math.min(api_.numPages, to || api_.numPages);
    const old = document.getElementById('pdfPrintHost'); if (old) old.remove();
    const host = el('div', { id: 'pdfPrintHost' }); document.body.appendChild(host);
    const total = to - from + 1, imgs = new Array(total), urls = [];
    let next = from, done = 0;
    const worker = async () => {
      while (true) {
        const i = next++; if (i > to) return;
        const page = await pdf.getPage(i);
        const vp = page.getViewport({ scale: 1.6 });
        const cv = document.createElement('canvas'); cv.width = vp.width; cv.height = vp.height;
        await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
        const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.88));
        const url = URL.createObjectURL(blob); urls.push(url);
        const img = new Image(); img.src = url; imgs[i - from] = img;
        cv.width = cv.height = 0; page.cleanup();
        done++; if (onProgress) onProgress(`Rendering ${done}/${total}`);
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    await Promise.all(imgs.map(im => im.decode().catch(() => {})));
    imgs.forEach(im => host.appendChild(im));
    document.body.classList.add('printing-pdf');
    const cleanup = () => { document.body.classList.remove('printing-pdf'); const h = document.getElementById('pdfPrintHost'); if (h) h.remove(); urls.forEach(u => URL.revokeObjectURL(u)); window.removeEventListener('afterprint', cleanup); };
    window.addEventListener('afterprint', cleanup);
    setTimeout(() => { window.print(); setTimeout(cleanup, 120000); }, 200);
  };

  // ── Sidebar: thumbnails + outline ──
  let sbMode = null, thumbObserver = null, thumbEls = [];
  function markThumb(p) {
    if (!thumbEls.length) return;
    thumbEls.forEach(d => d.classList.toggle('active', d.dataset.page === String(p)));
    const d = thumbEls[p - 1];
    if (d && sbMode === 'thumbs') d.scrollIntoView({ block: 'nearest' });
  }
  function buildThumbs() {
    const box = el('div', { class: 'pdfjs-thumbs' }); thumbEls = [];
    const W = 120;
    if (thumbObserver) thumbObserver.disconnect();
    thumbObserver = new IntersectionObserver((es) => es.forEach(async (en) => {
      if (!en.isIntersecting) return;
      const d = en.target; thumbObserver.unobserve(d);
      try {
        const pg = await pdf.getPage(parseInt(d.dataset.page, 10));
        const v0 = pg.getViewport({ scale: 1 }), vp = pg.getViewport({ scale: (W * 2) / v0.width });
        const cv = document.createElement('canvas'); cv.width = vp.width; cv.height = vp.height; cv.style.width = `${W}px`;
        await pg.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
        d.insertBefore(cv, d.firstChild); pg.cleanup();
      } catch (e) {}
    }), { root: sidebar, rootMargin: '500px 0px' });
    for (let i = 1; i <= api_.numPages; i++) {
      const [w, h] = baseSizes[i - 1];
      const d = el('div', { class: 'pdfjs-thumb' + (i === current ? ' active' : ''), style: `height:${Math.round(W * h / w) + 24}px`, onclick: () => goToPage(i) },
        [el('div', { class: 'pdfjs-thumb-label', text: String(i) })]);
      d.dataset.page = String(i); thumbEls.push(d); box.appendChild(d); thumbObserver.observe(d);
    }
    return box;
  }
  async function buildOutline() {
    const box = el('div', { class: 'pdfjs-outline' });
    let ol = null; try { ol = await pdf.getOutline(); } catch (e) {}
    if (!ol || !ol.length) { box.appendChild(el('div', { class: 'text-dim text-sm', style: 'padding:10px', text: 'This PDF has no bookmarks.' })); return box; }
    async function resolve(dest) {
      try {
        let d = dest; if (typeof d === 'string') d = await pdf.getDestination(d);
        if (!d) return null;
        const ref = d[0];
        if (ref && typeof ref === 'object') return (await pdf.getPageIndex(ref)) + 1;
        if (Number.isInteger(ref)) return ref + 1;
      } catch (e) {}
      return null;
    }
    function render(items, parent, depth) {
      items.forEach(it => {
        const kids = el('div', { class: depth >= 1 ? 'hidden' : '' });
        const arrow = el('span', { class: 'pdfjs-ol-arrow', text: (it.items && it.items.length) ? (depth >= 1 ? '▸' : '▾') : '' });
        const label = el('span', { class: 'pdfjs-ol-label', text: cleanOutlineTitle(it.title) || '(untitled)' });
        const row = el('div', { class: 'pdfjs-ol-row', style: `padding-left:${6 + depth * 14}px` }, [arrow, label]);
        arrow.onclick = (e) => { e.stopPropagation(); kids.classList.toggle('hidden'); arrow.textContent = kids.classList.contains('hidden') ? '▸' : '▾'; };
        label.onclick = async () => { const p = await resolve(it.dest); if (p) goToPage(p); };
        parent.appendChild(row); parent.appendChild(kids);
        if (it.items && it.items.length) render(it.items, kids, depth + 1);
      });
    }
    render(ol, box, 0);
    return box;
  }
  api_.toggleSidebar = async (mode) => {
    if (sbMode === mode) { sbMode = null; sidebar.classList.add('hidden'); resizer.classList.add('hidden'); return null; }
    sbMode = mode; sidebar.classList.remove('hidden'); resizer.classList.remove('hidden'); sidebar.innerHTML = '';
    sidebar.appendChild(mode === 'thumbs' ? buildThumbs() : await buildOutline());
    if (mode === 'thumbs') markThumb(current);
    return mode;
  };
  api_.setNight = (on) => scroller.classList.toggle('pdf-night', !!on);

  // ── Misc API used by the rest of the app ──
  api_.goToPage = goToPage;
  api_.getPage = () => { syncState(); return ready && scroller.clientHeight > 0 ? current : (tab.page || current); };
  api_.restore = () => { if (ready) { computeTops(); goToPage(current, true, tab.offset || 0); } };

  // ── Boot ──
  async function refineSizes() {
    const n = api_.numPages;
    for (let s = 2; s <= n; s += 40) {
      const idxs = []; for (let i = s; i < s + 40 && i <= n; i++) idxs.push(i);
      const pages = await Promise.all(idxs.map(i => pdf.getPage(i)));
      const anchor = holders[current - 1];
      const off = anchor ? scroller.scrollTop - anchor.offsetTop : 0;
      let changed = false;
      pages.forEach((pg, k) => {
        const v = pg.getViewport({ scale: 1 }), idx = idxs[k] - 1, [w, h] = baseSizes[idx];
        if (Math.abs(w - v.width) > 0.5 || Math.abs(h - v.height) > 0.5) {
          baseSizes[idx] = [v.width, v.height];
          holders[idx].style.width = `${v.width * scale}px`; holders[idx].style.height = `${v.height * scale}px`;
          unloadPage(holders[idx]); changed = true;
          if (holders[idx]._visible) renderPage(idxs[k]);
        }
        pg.cleanup();
      });
      if (changed) { computeTops(); if (anchor) scroller.scrollTop = anchor.offsetTop + off; }
      await new Promise(r => setTimeout(r, 0));
    }
  }

  (async () => {
    if (!window.pdfjsLib && window.__libsReady) await window.__libsReady;
    if (!window.pdfjsLib) { status.textContent = 'PDF.js failed to load - it needs an internet connection the first time (loads from a CDN).'; return; }
    try {
      pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_SRC;
      const task = pdfjsLib.getDocument({
        url: fileDownloadUrl(tab.ref, tab.path), cMapUrl: PDFJS_CMAP_URL, cMapPacked: true,
        standardFontDataUrl: PDFJS_FONT_URL, rangeChunkSize: 1 << 20,
      });
      task.onProgress = ({ loaded, total }) => { if (total) status.textContent = `Loading PDF… ${Math.round(loaded / total * 100)}%`; };
      pdf = await task.promise;
      api_.numPages = pdf.numPages;
      const first = await pdf.getPage(1), v = first.getViewport({ scale: 1 });
      baseSizes = Array.from({ length: pdf.numPages }, () => [v.width, v.height]);
      if (!scale) scale = clampScale((scroller.clientWidth - 28) / v.width) || 1.3;
      tab.zoom = scale;
      layout();
      ready = true;
      current = Math.max(1, Math.min(pdf.numPages, current));
      if (api_.onReady) api_.onReady();
      if (api_.onZoom) api_.onZoom(scale);
      let tries = 0;
      const jump = () => {
        if (scroller.clientHeight > 0) goToPage(current, true, tab.offset || 0);
        else if (tries++ < 20) setTimeout(jump, 150);
      };
      jump();
      refineSizes();
      setTimeout(startIndexing, 900);
    } catch (e) { status.textContent = 'Could not open this PDF: ' + e.message; }
  })();
  return api_;
}

function ensurePdfPane(tab) {
  if (tab.paneEl) return tab.paneEl;
  const btn = (text, title, onclick, cls) => el('button', { class: `btn btn-sm btn-outline ${cls || ''}`, text, title, onclick });
  const pageInput = el('input', { type: 'number', min: '1', value: String(tab.page || 1), style: 'width:64px' });
  const totalLabel = el('span', { class: 'text-dim text-sm', text: '/ …' });
  const viewer = buildPdfJsViewer(tab, (p) => { pageInput.value = String(p); });
  tab.viewer = viewer;
  viewer.onReady = () => { totalLabel.textContent = `/ ${viewer.numPages}`; pageInput.max = String(viewer.numPages); };
  pageInput.addEventListener('change', () => viewer.goToPage(pageInput.value));
  pageInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') viewer.goToPage(pageInput.value); });

  // zoom control
  const PRESETS = [50, 75, 100, 125, 150, 200, 300, 400];
  const zoomSel = el('select', { style: 'width:84px', title: 'Zoom' }, [
    el('option', { value: 'cur', text: '100%' }),
    ...PRESETS.map(p => el('option', { value: String(p), text: `${p}%` }))
  ]);
  viewer.onZoom = (s) => {
    const pct = Math.round(s / PDF_PX_PER_PT * 100);
    zoomSel.options[0].textContent = `${pct}%`;
    zoomSel.value = PRESETS.includes(pct) ? String(pct) : 'cur';
  };
  zoomSel.addEventListener('change', () => { if (zoomSel.value !== 'cur') viewer.setScale(parseFloat(zoomSel.value) / 100 * PDF_PX_PER_PT); });

  // find
  const findInput = el('input', { type: 'search', placeholder: 'Find in document…  (Ctrl+F)', style: 'width:210px' });
  const findStatus = el('span', { class: 'text-dim text-sm' });
  let findDebounce = null, lastIndexMsg = '', totalHits = 0, shownPos = 1;
  viewer.onIndexProgress = (done, total) => {
    lastIndexMsg = done < total ? `indexing ${Math.round(done / total * 100)}%` : '';
    if (!findInput.value.trim()) findStatus.textContent = lastIndexMsg;
  };
  async function doFind() {
    const q = findInput.value.trim();
    if (!q) { await viewer.search(''); findStatus.textContent = lastIndexMsg; return; }
    findStatus.textContent = 'Searching…';
    const n = await viewer.search(q,
      (i, c) => { findStatus.textContent = `Searching… ${c} found`; },
      () => { const st = viewer.step(1); if (st) { shownPos = st.pos; findStatus.textContent = `${st.pos} / …`; } });
    if (n === -1) return;
    if (!n) { findStatus.textContent = 'No matches'; return; }
    updateFindCount(n);
  }
  function updateFindCount(n) { totalHits = n; findStatus.textContent = `${shownPos} / ${n}`; }
  function stepFind(dir) {
    const st = viewer.step(dir);
    if (st) { shownPos = st.pos; findStatus.textContent = `${st.pos} / ${st.total}`; }
  }
  findInput.addEventListener('input', () => { clearTimeout(findDebounce); shownPos = 1; findDebounce = setTimeout(doFind, 250); });
  findInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); } if (e.key === 'Escape') { findInput.value = ''; doFind(); } });

  // print
  const printFrom = el('input', { type: 'number', min: '1', placeholder: 'all', style: 'width:60px' });
  const printTo = el('input', { type: 'number', min: '1', placeholder: 'all', style: 'width:60px' });
  const printStatus = el('span', { class: 'text-dim text-sm' });
  async function doPrint(mode) {
    const f = parseInt(printFrom.value, 10) || 1, t = parseInt(printTo.value, 10) || viewer.numPages;
    try {
      if (mode === 'native') {
        try { await viewer.printNative(f, t, (m) => { printStatus.textContent = m; }); printStatus.textContent = ''; }
        catch (e) { printStatus.textContent = 'Native print failed, rendering instead…'; await viewer.printRendered(f, t, (m) => { printStatus.textContent = m; }); printStatus.textContent = ''; }
      } else {
        await viewer.printRendered(f, t, (m) => { printStatus.textContent = m; }); printStatus.textContent = '';
      }
    } catch (e) { printStatus.textContent = 'Print failed: ' + e.message; }
  }

  // notes
  const notesList = el('div', { class: 'fe-notes-list' });
  function renderNotes() {
    notesList.innerHTML = '';
    if (!tab.notes.length) { notesList.appendChild(el('div', { class: 'text-dim text-sm', text: 'No notes yet - jump to a page and add one.' })); return; }
    [...tab.notes].sort((a, b) => a.page - b.page).forEach(n => {
      notesList.appendChild(el('div', { class: 'fe-note-item' }, [
        el('div', { class: 'fe-note-item-header' }, [
          el('span', { class: 'fe-note-jump', text: `p.${n.page}`, onclick: () => viewer.goToPage(n.page) }),
          el('button', { class: 'btn btn-sm btn-outline', text: '×', onclick: () => { tab.notes = tab.notes.filter(x => x !== n); pdfSaveNotesMeta(tab); renderNotes(); } })
        ]),
        el('div', { class: 'text-sm', text: n.text })
      ]));
    });
  }
  const newNoteText = el('textarea', { placeholder: 'Add a note for the current page...', style: 'min-height:40px' });
  renderNotes();
  const notesPanel = el('div', { class: 'fe-notes-panel' }, [
    el('div', { style: 'font-weight:700;margin-bottom:6px', text: 'Notes' }),
    notesList, newNoteText,
    el('button', { class: 'btn btn-sm mt-8', text: '+ Add note', onclick: () => {
      if (!newNoteText.value.trim()) return;
      tab.notes.push({ page: viewer.getPage(), text: newNoteText.value.trim() });
      newNoteText.value = ''; pdfSaveNotesMeta(tab); renderNotes();
    } })
  ]);
  const notesToggleBtn = el('button', {
    class: 'btn btn-sm btn-outline', text: tab.notesCollapsed ? 'Show Notes' : 'Hide Notes',
    onclick: () => {
      tab.notesCollapsed = !tab.notesCollapsed;
      notesPanel.classList.toggle('hidden', tab.notesCollapsed);
      notesToggleBtn.textContent = tab.notesCollapsed ? 'Show Notes' : 'Hide Notes';
    }
  });
  notesPanel.classList.toggle('hidden', tab.notesCollapsed);

  let night = false;
  const nightBtn = btn('🌙', 'Night mode (invert page colors)', () => { night = !night; viewer.setNight(night); nightBtn.classList.toggle('active', night); });

  // keyboard shortcuts inside the viewer
  viewer.el.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); findInput.focus(); findInput.select(); }
    else if (mod && (e.key === '+' || e.key === '=')) { e.preventDefault(); viewer.zoomBy(1.15); }
    else if (mod && e.key === '-') { e.preventDefault(); viewer.zoomBy(1 / 1.15); }
    else if (mod && e.key === '0') { e.preventDefault(); viewer.setScale(PDF_PX_PER_PT); }
    else if (e.key === 'Home' && !mod) { e.preventDefault(); viewer.goToPage(1); }
    else if (e.key === 'End' && !mod) { e.preventDefault(); viewer.goToPage(viewer.numPages); }
    else if (e.key === 'F3') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); }
  });

  const pane = el('div', { class: 'fe-pdf-pane' }, [
    el('div', { class: 'row pdf-toolbar' }, [
      el('span', { class: 'truncate text-sm', style: 'font-weight:700;flex:1;min-width:80px', text: tab.name }),
      btn('☰', 'Thumbnails', () => viewer.toggleSidebar('thumbs')),
      btn('📑', 'Bookmarks / outline', () => viewer.toggleSidebar('outline')),
      btn('◀', 'Previous page', () => viewer.goToPage(viewer.getPage() - 1)),
      pageInput, totalLabel,
      btn('▶', 'Next page', () => viewer.goToPage(viewer.getPage() + 1)),
      btn('−', 'Zoom out', () => viewer.zoomBy(1 / 1.15)),
      zoomSel,
      btn('+', 'Zoom in', () => viewer.zoomBy(1.15)),
      btn('↔', 'Fit width', () => viewer.fitWidth()),
      btn('▭', 'Fit page', () => viewer.fitPage()),
      nightBtn,
      notesToggleBtn
    ]),
    el('div', { class: 'row pdf-toolbar' }, [
      findInput,
      btn('↑', 'Previous match (Shift+Enter)', () => stepFind(-1)),
      btn('↓', 'Next match (Enter)', () => stepFind(1)),
      findStatus,
      el('div', { class: 'flex-1' }),
      el('span', { class: 'text-dim text-sm', text: 'Print pages' }),
      printFrom, el('span', { class: 'text-dim text-sm', text: '–' }), printTo,
      btn('🖨 Print', 'Fast native print (any number of pages)', () => doPrint('native')),
      btn('Print (render)', 'Compatibility mode: renders pages to images', () => doPrint('render')),
      printStatus,
      el('a', { class: 'btn btn-sm btn-outline', text: 'Download', href: fileDownloadUrl(tab.ref, tab.path, true), download: tab.name })
    ]),
    el('div', { class: 'fe-pdf-split' }, [viewer.el, notesPanel])
  ]);
  tab.paneEl = pane;
  return pane;
}

function renderPdfViewerHost() {
  if (!pdfTabs.length) return;
  const host = document.getElementById('pdfViewerHost');
  if (!host) return;
  const activeTab = pdfTabs.find(t => t.id === pdfActiveTabId) || pdfTabs[0];
  pdfActiveTabId = activeTab.id;

  host.classList.remove('hidden');

  if (!pdfHostEls) {
    // Fresh mount - the chrome (header + tab bar + split selector +
    // panes container) is built exactly once per viewing session;
    // everything after this only ever mutates it in place, so no tab's
    // iframe is ever recreated just from switching tabs or toggling
    // split/minimize/fullscreen.
    host.innerHTML = '';
    host.style.width = '';
    host.style.height = '';
    const titleEl = el('div', { class: 'pdf-viewer-title truncate' });
    const minimizeBtn = el('button', { id: 'pdfMinimizeBtn', class: 'btn btn-sm btn-outline', text: '−', title: 'Minimize', onclick: pdfToggleMinimize });
    const fullscreenBtn = el('button', { class: 'btn btn-sm btn-outline', text: '⤢', title: 'Toggle fullscreen', onclick: pdfToggleFullscreen });
    const closeBtn = el('button', { class: 'btn btn-sm btn-outline', text: '×', title: 'Close all open PDFs', onclick: pdfCloseAll });
    const header = el('div', { class: 'pdf-viewer-header' }, [
      titleEl, el('div', { class: 'flex-1' }), minimizeBtn, fullscreenBtn, closeBtn
    ]);
    const tabBarEl = el('div', { class: 'fe-tab-bar' });
    const splitRowEl = el('div', {});
    const panesEl = el('div', { class: 'fe-pdf-panes' });
    const body = el('div', { class: 'pdf-viewer-body' }, [tabBarEl, splitRowEl, panesEl]);
    host.appendChild(header);
    host.appendChild(body);
    pdfHostEls = { tabBarEl, splitRowEl, panesEl, titleEl };
  }
  const { tabBarEl, splitRowEl, panesEl, titleEl } = pdfHostEls;

  titleEl.textContent = `${activeTab.name}${pdfTabs.length > 1 ? ` (+${pdfTabs.length - 1} more)` : ''}`;

  // Tab bar - cheap to fully rebuild every time (just buttons, no
  // iframe/state involved), unlike the panes below.
  tabBarEl.innerHTML = '';
  pdfTabs.forEach(t => {
    tabBarEl.appendChild(el('div', {
      class: `fe-tab${t.id === pdfActiveTabId ? ' active' : ''}`, onclick: () => { pdfActiveTabId = t.id; renderPdfViewerHost(); }
    }, [
      el('span', { class: 'truncate', style: 'max-width:140px', text: t.name }),
      el('span', { class: 'fe-tab-close', text: '×', title: 'Close tab', onclick: (e) => { e.stopPropagation(); pdfCloseTab(t.id); } })
    ]));
  });

  // Split-view selector
  splitRowEl.innerHTML = '';
  splitRowEl.className = pdfTabs.length > 1 ? 'row' : 'hidden';
  splitRowEl.setAttribute('style', 'gap:8px;align-items:center;margin:6px 0');
  if (pdfTabs.length > 1) {
    splitRowEl.appendChild(el('span', { class: 'text-dim text-sm', text: '⊞ Split view with:' }));
    splitRowEl.appendChild(el('select', { style: 'width:auto', onchange: (e) => { pdfSplitTabId = e.target.value || null; renderPdfViewerHost(); } }, [
      el('option', { value: '', text: 'None (single pane)' }),
      ...pdfTabs.filter(t => t.id !== pdfActiveTabId).map(t => el('option', { value: t.id, text: t.name, selected: t.id === pdfSplitTabId }))
    ]));
  }

  // Panes - each tab's pane is created ONCE (see ensurePdfPane) and from
  // here on just shown/hidden, so no tab's iframe ever reloads purely
  // from switching between tabs, minimizing, or toggling split view.
  panesEl.className = `fe-pdf-panes${pdfSplitTabId ? ' split' : ''}`;
  pdfTabs.forEach(t => {
    const pane = ensurePdfPane(t);
    if (pane.parentNode !== panesEl) panesEl.appendChild(pane);
    const shouldShow = t.id === pdfActiveTabId || t.id === pdfSplitTabId;
    pane.classList.toggle('hidden', !shouldShow);
    if (shouldShow && t.viewer) setTimeout(() => t.viewer.restore(), 0);
  });
}

// ── Video viewer: timestamped notes, click a note to seek+play ──
async function openVideoViewer(ref, path, name) {
  let meta = {};
  try { meta = await api(`/api/${currentProfile}/filetree/${ref.ref_type}/${ref.ref_id}/meta?path=${encodeURIComponent(path)}`); } catch (e) {}
  let notes = meta.video_notes || [];

  const video = el('video', { src: fileDownloadUrl(ref, path), controls: true, class: 'fe-video-el' });
  // Counts toward the Cinephile badge - stops automatically whenever
  // the video pauses, including the pause forced by closeModal()'s own
  // cleanup when this viewer is closed, so no extra teardown is needed.
  const videoTicker = _makeActivityTicker('video');
  video.addEventListener('play', () => videoTicker.start());
  video.addEventListener('pause', () => videoTicker.stop());
  const notesList = el('div', { class: 'fe-notes-list' });
  const newNoteText = el('textarea', { placeholder: 'Add a note at the current timestamp...', style: 'min-height:44px' });
  const curTimeLabel = el('span', { class: 'text-dim text-sm', text: '00:00' });
  video.addEventListener('timeupdate', () => { curTimeLabel.textContent = formatClock(video.currentTime); });

  function renderNotes() {
    notesList.innerHTML = '';
    if (!notes.length) { notesList.appendChild(el('div', { class: 'text-dim text-sm', text: 'No notes yet - play the video and add one at any moment.' })); return; }
    [...notes].sort((a, b) => a.t - b.t).forEach(n => {
      notesList.appendChild(el('div', { class: 'fe-note-item' }, [
        el('div', { class: 'fe-note-item-header' }, [
          el('span', { class: 'fe-note-jump', text: formatClock(n.t), onclick: () => { video.currentTime = n.t; video.play(); } }),
          el('button', { class: 'btn btn-sm btn-outline', text: '×', onclick: () => { notes = notes.filter(x => x !== n); saveNotes(); } })
        ]),
        el('div', { class: 'text-sm', text: n.text })
      ]));
    });
  }
  async function saveNotes() {
    try { await api(`/api/${currentProfile}/filetree/${ref.ref_type}/${ref.ref_id}/meta`, { method: 'PUT', body: JSON.stringify({ path, video_notes: notes }) }); } catch (e) {}
    renderNotes();
  }

  const content = el('div', { class: 'fe-viewer-video' }, [
    viewerHeader(name, closeModal),
    video,
    el('div', { class: 'fe-notes-panel mt-8' }, [
      el('div', { class: 'row', style: 'justify-content:space-between;align-items:center' }, [
        el('div', { style: 'font-weight:700', text: 'Timestamped Notes' }),
        curTimeLabel
      ]),
      notesList,
      newNoteText,
      el('button', { class: 'btn btn-sm mt-8', text: '+ Add note @ current time', onclick: () => {
        if (!newNoteText.value.trim()) return;
        notes.push({ t: video.currentTime, text: newNoteText.value.trim() });
        newNoteText.value = '';
        saveNotes();
      } })
    ])
  ]);
  showModal(content);
  document.getElementById('modalContent').classList.add('fe-viewer-modal');
  renderNotes();
}

// ═══════════════════════════════════════════
// PERSISTENT AUDIO PLAYER - module-level state + a single <audio>
// element, mounted into #audioPlayerBar (outside #content, see
// index.html) so it survives every navigate() re-render untouched.
// Playback keeps going no matter what page is open; only closing the
// bar itself (or the tab) stops it.
// ═══════════════════════════════════════════
const audioEl = new Audio();
let audioState = {
  current: null,      // { ref, path, name }
  queue: [],           // [{ ref, path, name }, ...] - plays next, in order
  minimized: false,
  siblingsOpen: false,
};
audioEl.addEventListener('ended', () => audioPlayNext());
audioEl.addEventListener('timeupdate', () => updateAudioProgressUI());
audioEl.addEventListener('loadedmetadata', () => updateAudioProgressUI());
// Counts toward the Melomaniac badge - see musicActivityTicker's
// definition above for why the app's own ambient background music is
// deliberately excluded from this.
audioEl.addEventListener('play', () => musicActivityTicker.start());
audioEl.addEventListener('pause', () => musicActivityTicker.stop());

function playAudioTrack(ref, path, name) {
  audioState.current = { ref, path, name };
  audioEl.src = fileDownloadUrl(ref, path);
  audioEl.play().catch(() => {});
  audioState.minimized = false;
  renderAudioPlayerBar();
}
function audioQueueAdd(track) {
  audioState.queue.push(track);
  if (!audioState.current) { audioPlayNext(); }
  else renderAudioPlayerBar();
}
function audioQueueRemove(idx) {
  audioState.queue.splice(idx, 1);
  renderAudioPlayerBar();
}
function audioPlayNext() {
  const next = audioState.queue.shift();
  if (next) playAudioTrack(next.ref, next.path, next.name);
  else { audioState.current = null; audioEl.pause(); audioEl.removeAttribute('src'); audioEl.load(); renderAudioPlayerBar(); }
}
function audioTogglePlay() {
  if (!audioState.current) return;
  if (audioEl.paused) audioEl.play().catch(() => {}); else audioEl.pause();
  updateAudioProgressUI();
}
function audioSeekRelative(sec) {
  if (!audioState.current) return;
  audioEl.currentTime = Math.max(0, Math.min(audioEl.duration || Infinity, audioEl.currentTime + sec));
}
function audioStopAndClose() {
  audioEl.pause();
  audioEl.removeAttribute('src');
  // Some browsers keep playing already-buffered audio for a moment
  // after pause()+removeAttribute('src') alone - load() forces the
  // element to actually reset and abort any in-flight buffered audio,
  // matching the bar's own instant visual disappearance.
  audioEl.load();
  audioState.current = null;
  audioState.queue = [];
  renderAudioPlayerBar();
}

function updateAudioProgressUI() {
  const fill = document.getElementById('audioProgressFill');
  const curEl = document.getElementById('audioCurTime');
  const durEl = document.getElementById('audioDurTime');
  const playBtn = document.getElementById('audioPlayBtn');
  if (fill && audioEl.duration) fill.style.width = `${(audioEl.currentTime / audioEl.duration) * 100}%`;
  if (curEl) curEl.textContent = formatClock(audioEl.currentTime || 0);
  if (durEl) durEl.textContent = formatClock(audioEl.duration || 0);
  if (playBtn) playBtn.textContent = audioEl.paused ? '▶' : '⏸';
}

async function toggleAudioSiblingsDropdown() {
  const pop = document.getElementById('audioSiblingsPopover');
  if (pop) { pop.remove(); return; }
  if (!audioState.current) return;
  let data;
  try {
    data = await api(`/api/${currentProfile}/filetree/${audioState.current.ref.ref_type}/${audioState.current.ref.ref_id}/siblings?path=${encodeURIComponent(audioState.current.path)}&kind=audio`);
  } catch (e) { return; }
  const box = el('div', { id: 'audioSiblingsPopover', class: 'audio-siblings-popover' }, [
    el('div', { style: 'font-weight:700;margin-bottom:6px', text: 'More in this folder' }),
    ...(data.items.length ? data.items.map(it => el('div', { class: 'fe-menu-item', text: it.name }, )) : [el('div', { class: 'text-dim text-sm', text: 'No other audio files here.' })])
  ]);
  // Wire click handlers separately (avoids re-declaring el() children with closures over `it` awkwardly above)
  data.items.forEach((it, i) => {
    box.children[i + 1].onclick = () => { playAudioTrack(audioState.current.ref, it.path, it.name); box.remove(); };
    box.children[i + 1].style.cursor = 'pointer';
    box.children[i + 1].appendChild(el('button', { class: 'btn btn-sm btn-outline', style: 'float:right', text: '+', title: 'Add to queue', onclick: (e) => { e.stopPropagation(); audioQueueAdd({ ref: audioState.current.ref, path: it.path, name: it.name }); } }));
  });
  document.getElementById('audioPlayerBar').appendChild(box);
  setTimeout(() => document.addEventListener('click', (e) => { if (!box.contains(e.target)) box.remove(); }, { once: true }), 0);
}

function renderAudioPlayerBar() {
  const bar = $('#audioPlayerBar');
  if (!bar) return;
  if (!audioState.current) {
    bar.classList.add('hidden'); bar.innerHTML = '';
    document.body.classList.remove('has-audio-bar', 'has-audio-bar-minimized');
    return;
  }
  bar.classList.remove('hidden');
  bar.classList.toggle('minimized', audioState.minimized);
  document.body.classList.add('has-audio-bar');
  document.body.classList.toggle('has-audio-bar-minimized', audioState.minimized);
  bar.innerHTML = '';

  if (audioState.minimized) {
    bar.appendChild(el('div', { class: 'audio-mini-row' }, [
      el('span', { class: 'truncate', style: 'max-width:160px', text: audioState.current.name }),
      el('button', { class: 'btn btn-sm btn-outline', id: 'audioPlayBtn', text: audioEl.paused ? '▶' : '⏸', onclick: audioTogglePlay }),
      el('button', { class: 'btn btn-sm btn-outline', text: '⤢', title: 'Expand', onclick: () => { audioState.minimized = false; renderAudioPlayerBar(); } })
    ]));
    return;
  }

  bar.appendChild(el('div', { class: 'audio-bar-top' }, [
    el('div', { class: 'audio-bar-track-info' }, [
      el('span', { class: 'truncate', text: audioState.current.name })
    ]),
    el('div', { class: 'row', style: 'gap:4px' }, [
      el('button', { class: 'btn btn-sm btn-outline', text: '⋮', title: 'More from this folder / queue', onclick: toggleAudioSiblingsDropdown }),
      el('button', { class: 'btn btn-sm btn-outline', text: '−', title: 'Minimize', onclick: () => { audioState.minimized = true; renderAudioPlayerBar(); } }),
      el('button', { class: 'btn btn-sm btn-outline', text: '×', title: 'Close', onclick: audioStopAndClose })
    ])
  ]));
  bar.appendChild(el('div', { class: 'audio-bar-controls' }, [
    el('button', { class: 'btn btn-sm btn-outline', text: '⏮ 10s', onclick: () => audioSeekRelative(-10) }),
    el('button', { class: 'btn btn-amber', id: 'audioPlayBtn', text: audioEl.paused ? '▶' : '⏸', onclick: audioTogglePlay }),
    el('button', { class: 'btn btn-sm btn-outline', text: '10s ⏭', onclick: () => audioSeekRelative(10) }),
    el('span', { class: 'text-dim text-sm', id: 'audioCurTime', text: formatClock(audioEl.currentTime || 0) }),
    el('div', { class: 'audio-progress-track', onclick: (e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      if (audioEl.duration) audioEl.currentTime = ((e.clientX - rect.left) / rect.width) * audioEl.duration;
    } }, [el('div', { class: 'audio-progress-fill', id: 'audioProgressFill' })]),
    el('span', { class: 'text-dim text-sm', id: 'audioDurTime', text: formatClock(audioEl.duration || 0) }),
    el('button', { class: 'btn btn-sm btn-outline', text: '⏭ Next', disabled: !audioState.queue.length, onclick: audioPlayNext })
  ]));
  if (audioState.queue.length) {
    bar.appendChild(el('div', { class: 'audio-queue-row' }, [
      el('span', { class: 'text-dim text-sm', text: `Up next (${audioState.queue.length}):` }),
      ...audioState.queue.slice(0, 4).map((t, i) => el('span', { class: 'audio-queue-chip' }, [
        el('span', { text: t.name }),
        el('span', { style: 'cursor:pointer;margin-left:6px;opacity:.7', text: '×', onclick: () => audioQueueRemove(i) })
      ]))
    ]));
  }
  updateAudioProgressUI();
}

// ── Init ──
function reportBootOk() {
  try {
    const token = new URLSearchParams(location.search).get('boot') || '';
    fetch('/api/boot_ok', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }).catch(() => {});
  } catch (e) { /* non-fatal */ }
}

async function init() {
  try {
    const versionLabel = $('#appVersionLabel');
    if (versionLabel) versionLabel.textContent = ` v${APP_VERSION}`;
    api('/api/version').then(v => {
      if (v?.version && v.version !== APP_VERSION) {
        console.warn(`Frontend/backend version mismatch: app.js APP_VERSION=${APP_VERSION}, server.py APP_VERSION=${v.version}`);
      }
    }).catch(() => {});
    await loadProfiles();
    // Fresh install / new laptop: no profile exists yet - create one so the
    // app is usable immediately instead of showing an empty, broken UI.
    if (!currentProfile) {
      try { await api('/api/profiles', { method: 'POST', body: JSON.stringify({ name: 'default' }) }); } catch (e) { /* ignore */ }
      await loadProfiles();
    }
    if (currentProfile) {
      await loadConfig();
      try { await api(`/api/${currentProfile}/attendance/autofill`, { method: 'POST' }); } catch (e) { /* non-fatal */ }
      await loadData();
      await loadGamification({ showCheckIn: true });
      await refreshActiveTimerFromServer();
      lastKnownLevel = gamification?.level ?? null;
      lastKnownXp = gamification?.xp ?? null;
      lastKnownNerds = gamification?.nerds ?? null;
      pageActivityTicker.start();
    }
    loadTheme();
    updateTopLevelBar();
    updateNerdsBadge();
    updateAudioMuteButton();
    updateThemeAudioMuteButton();
    _initGlobalTooltips();
    bindParallaxScroll();
    updateParallaxPosition();
    updateNavOverflow();
    await render();
    setInterval(paintTimerNumbers, UI_MINI_TIMER_TICK_MS);
  } catch (e) {
    console.error(e);
    if (window.__cultivarShowError) window.__cultivarShowError('Startup error: ' + (e && e.message ? e.message : e));
  } finally {
    const splash = document.getElementById('bootSplash');
    if (splash) splash.remove();
    reportBootOk();
  }
}

init();
