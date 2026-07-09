/* StudyTracker v1.1.1 — Frontend */
const API = '';
let currentProfile = null;
let currentPage = 'dashboard';
let cachedConfig = null;
let cachedData = null;
let gamification = null;   // cached /gamification response
let gamificationError = null;
let lastKnownLevel = null; // used to detect level-ups after XP-earning actions
let lastKnownXp = null;
let pendingSettingsScroll = null;
let subjectListYearFilter = 'all';

// ═══════════════════════════════════════════
// ── CONTROL PANEL (frontend) ──
// UI-only timing/behavior constants — the gameplay/economy numbers
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

// ── Helpers ──
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }
function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
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
function nowStr() { return new Date().toISOString().slice(0, 19); }
function localDateStr(d = new Date()) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
function todayStr() { return localDateStr(new Date()); }
function localDateFromStr(dateStr) { return new Date(`${dateStr}T12:00:00`); }

async function api(path, opts = {}) {
  const url = API + path;
  const defaults = { headers: { 'Content-Type': 'application/json' } };
  const res = await fetch(url, { ...defaults, ...opts });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

// ── Navigation ──
function navigate(page) {
  currentPage = page;
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  updateMiniTimerBadge();
  render();
}

// ── Modal ──
function showModal(content) {
  $('#modalContent').innerHTML = '';
  $('#modalContent').appendChild(content);
  $('#modalOverlay').classList.add('show');
}
function closeModal(e) {
  if (e && e.target !== e.currentTarget) return;
  $('#modalOverlay').classList.remove('show');
}

// ── Theme ──
// Themes beyond the free starting set (sakura/light/dark) are unlocked by
// level (see gamification.unlocked_themes). setTheme() guards against
// applying a theme the person hasn't unlocked — this matters because the
// saved theme is also read straight out of localStorage on load, and a
// locked id there (e.g. from an older session, or before a level was
// reached) should never silently apply.
function setTheme(theme, force) {
  const unlocked = gamification?.unlocked_themes;
  if (!force && unlocked && !unlocked.includes(theme)) {
    theme = 'dark';
  }
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('st_theme', theme);
}
function loadTheme() {
  const saved = localStorage.getItem('st_theme') || 'dark';
  setTheme(saved);
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
  showThemePreviewBanner(themeId);
  // Freeze the rest of the app behind a click-swallowing overlay — a
  // preview is meant to be a single frozen look at the theme, not a
  // way to browse the whole app in disguise. The only way out is the
  // "Exit Preview" button on the banner itself, which sits above this
  // overlay in the stacking order.
  const overlay = $('#previewLockOverlay');
  if (overlay) overlay.classList.remove('hidden');
}

function exitThemePreview() {
  if (themeBeforePreview) {
    document.documentElement.setAttribute('data-theme', themeBeforePreview);
  }
  previewingTheme = null;
  themeBeforePreview = null;
  const banner = $('#themePreviewBanner');
  if (banner) banner.remove();
  const overlay = $('#previewLockOverlay');
  if (overlay) overlay.classList.add('hidden');
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
  banner.appendChild(el('span', { text: `👁 Previewing "${label}"${t ? ` (Lv ${t.level})` : ''} — not unlocked yet` }));
  banner.appendChild(el('button', { class: 'btn btn-sm btn-outline', text: 'Exit Preview', onclick: exitThemePreview }));
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
  return checkIn;
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
  const streak = gamification.streak_current > 0 ? `🔥 ${gamification.streak_current}` : 'No streak';
  const nextTheme = (gamification.theme_catalog || []).find(t => t.level > gamification.level);
  const remainingXp = Math.max(0, Math.round((gamification.xp_for_next || 0) - (gamification.xp_into_level || 0)));
  const streakMilestone = gamification.streak_current > 0 && gamification.streak_current % 7 === 0;
  bar.innerHTML = '';
  bar.onclick = () => { navigate('progression'); };
  bar.classList.toggle('streak-milestone', streakMilestone);
  bar.appendChild(el('div', { class: 'top-level-bar-meta' }, [
    el('div', { class: 'top-level-bar-level' }, [
      el('span', { class: 'top-level-bar-level-chip', text: `Lv ${gamification.level}` }),
      el('span', { class: 'top-level-bar-level-burst', text: '✦' })
    ]),
    el('div', { class: 'top-level-bar-title', text: gamification.title })
  ]));
  bar.appendChild(el('div', { class: 'top-level-bar-track' }, [
    el('div', { class: 'top-level-bar-fill', style: `width:${pct}%` })
  ]));
  bar.appendChild(el('div', { class: 'top-level-bar-stats' }, [
    el('span', { text: `${Math.round(gamification.xp_into_level)} / ${gamification.xp_for_next} XP` }),
    el('span', { text: streak }),
    el('span', { class: 'top-level-bar-next', text: nextTheme ? `Next: ${nextTheme.label} (Lv ${nextTheme.level}, ${remainingXp} XP away)` : 'All themes unlocked' })
  ]));
}

function showDailyCheckInPopup(checkIn, g) {
  const quests = g?.quests_this_week || [];
  const completedQuests = quests.filter(q => q.done).length;
  const totalQuests = quests.length;
  const content = el('div', {}, [
    el('div', { class: 'modal-header' }, [
      el('div', { class: 'modal-title', text: '✅ Daily Check-In' }),
      el('button', { class: 'modal-close', onclick: closeModal, text: '×' })
    ]),
    el('div', { class: 'row', style: 'align-items:flex-start;gap:14px;flex-wrap:wrap' }, [
      el('div', { class: 'stat-card', style: 'min-width:120px;flex:0 0 120px' }, [
        el('div', { style: 'font-size:2.2rem', text: '📅' }),
        el('div', { class: 'stat-label', style: 'margin-top:8px;font-weight:700', text: checkIn?.new_today ? 'Logged today' : 'Already counted' }),
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
          el('span', { text: `${q.done ? '✅' : '⬜'} ${q.label}` }),
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

// Call this after any action that can earn XP (self-study logged, timer
// session saved, attendance marked, exam completed). It
// re-fetches gamification, compares against the last level we knew
// about, and — if it went up — shows a celebration overlay. lastKnownLevel
// starts null on a fresh load so the very first fetch never falsely
// fires a celebration.
async function maybeShowLevelUp(opts = {}) {
  if (!currentProfile) return;
  const previous = lastKnownLevel;
  const previousXp = lastKnownXp;
  await loadGamification();
  if (!gamification) return;
  if (!opts.skipXpToast && previousXp !== null && gamification.xp > previousXp) {
    showXpToast(gamification.xp - previousXp, gamification.xp, gamification.level);
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
}

function showXpToast(delta, totalXp, level) {
  let container = $('#xpToastContainer');
  if (!container) {
    container = el('div', { id: 'xpToastContainer', class: 'xp-toast-container' });
    document.body.appendChild(container);
  }
  const toast = el('div', { class: 'xp-toast' }, [
    el('div', { class: 'xp-toast-icon', text: '✨' }),
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

// Shown after deleting a self-study/attendance/exam record. Backed by
// a single-slot server-side trash (see /api/<name>/undo_delete) — this
// Shown after deleting a self-study/attendance/exam record. Backed by
// a single-slot server-side trash (see /api/<name>/undo_delete) — this
// is the safety net for accidental deletions, since a delete anywhere
// in the app is otherwise permanent and irreversible.
function showUndoToast(message) {
  let container = $('#xpToastContainer');
  if (!container) {
    container = el('div', { id: 'xpToastContainer', class: 'xp-toast-container' });
    document.body.appendChild(container);
  }
  const toast = el('div', { class: 'xp-toast' }, [
    el('div', { class: 'xp-toast-icon', text: '🗑️' }),
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
// xp_earned the backend computed for that specific record (rather than
// the generic before/after gamification diff, which can also include
// unrelated badge/mastery tier-up bonuses). Also answers "how much XP
// per minute" directly, since the rate depends on difficulty.
function showSessionXpToast(xpEarned, minutes, difficulty) {
  let container = $('#xpToastContainer');
  if (!container) {
    container = el('div', { id: 'xpToastContainer', class: 'xp-toast-container' });
    document.body.appendChild(container);
  }
  const rate = minutes > 0 ? (xpEarned / minutes) : 0;
  const toast = el('div', { class: 'xp-toast' }, [
    el('div', { class: 'xp-toast-icon', text: '🎉' }),
    el('div', { class: 'xp-toast-body' }, [
      el('div', { class: 'xp-toast-title', text: `Congrats! +${xpEarned} XP earned` }),
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
      el('div', { class: 'levelup-burst', text: '🎉' }),
      el('div', { class: 'levelup-title', text: 'Level Up!' }),
      el('div', { class: 'levelup-level', text: `Level ${newLevel}` }),
      el('div', { class: 'levelup-subtitle', text: gamification.title }),
      el('div', { class: 'levelup-xp-line', text: `${Math.round(gamification.xp_into_level)} / ${gamification.xp_for_next} XP toward the next level` }),
      newlyUnlocked.length ? el('div', { class: 'levelup-unlocks' }, [
        el('div', { class: 'text-sm', style: 'margin-bottom:10px', text: 'New unlocks:' }),
        el('div', { class: 'levelup-theme-grid' }, newlyUnlocked.map(t =>
          el('div', { class: 'levelup-theme-card' }, [
            el('div', { class: 'levelup-theme-icon', text: '🎨' }),
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
  return confirm(`⚠️ ${message}`);
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
        g.streak_current > 0 ? el('div', { style: 'font-weight:700;color:var(--amber)', text: `🔥 ${g.streak_current}-day streak` }) : el('div', { class: 'text-dim text-sm', text: 'No active streak — study today to start one!' }),
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

function badgeHint(b) {
  const descriptions = {
    hours: 'Total study minutes completed across all subjects.',
    streak: 'Longest streak of consecutive study days.',
    early_bird: 'Completed sessions started before 08:00.',
    night_owl: 'Completed sessions started at 22:00 or later.',
    attendance: 'Attendance records marked present.',
    exam_ace: 'Exams scored 16/20 or higher.',
    comeback: 'Returns after a 5+ day gap between study days.',
    well_rounded: 'Weeks with both self-study and attendance logged.',
    variety: 'Distinct subjects and skills studied.',
    weekend: 'Completed study sessions logged on weekends.',
    marathon: 'Completed study sessions lasting at least 120 minutes.',
    login_streak: 'Longest streak of consecutive login days.'
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
        el('div', { style: 'font-size:1.4rem', text: b.icon }),
        el('div', { class: 'stat-label', style: 'margin-top:6px;font-weight:600', text: b.label }),
        el('div', { style: `font-weight:800;color:${color}`, text: b.tier_name || 'Unranked' }),
        el('div', { class: 'text-dim', style: 'font-size:10px', text: b.max_tier ? `Maxed (${b.value})` : `${b.value} / ${b.next_threshold}` })
      ]);
      attachTooltip(card, badgeHint(b), color);
      return card;
    })
  );
}

function renderMasteryGrid() {
  if (!gamification || !gamification.mastery) return el('div', { class: 'text-dim text-sm', text: gamificationError ? 'Mastery could not be loaded.' : 'No mastery yet. Add subjects or skills to start building it.' });
  if (!gamification.mastery.length) return el('div', { class: 'text-dim text-sm', text: 'Add subjects/skills to start earning mastery.' });
  return el('div', { class: 'stats-grid', style: 'grid-template-columns:repeat(auto-fill,minmax(150px,1fr))' },
    gamification.mastery.map(m => {
      const color = m.tier_name ? TIER_COLORS[m.tier_name] : 'var(--border)';
      return el('div', { class: 'stat-card', style: `border-color:${color}` }, [
        el('div', { style: 'font-size:1.2rem', text: m.type === 'skill' ? '🎯' : '📚' }),
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
      el('span', { text: `${q.done ? '✅' : '⬜'} ${q.label}` }),
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
      sel.appendChild(el('option', { value: '', text: 'No profiles — create one in Settings' }));
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
  updateTopLevelBar();
  await loadConfig();
  try { await api(`/api/${currentProfile}/attendance/autofill`, { method: 'POST' }); } catch (e) { /* non-fatal */ }
  await loadData();
  await loadGamification();
  lastKnownLevel = gamification?.level ?? null;
  lastKnownXp = gamification?.xp ?? null;
  render();
}

async function loadConfig() {
  if (!currentProfile) return;
  try {
    cachedConfig = await api(`/api/${currentProfile}/config`);
  } catch (e) { cachedConfig = null; }
}

async function loadData() {
  if (!currentProfile) return;
  try {
    // This used to fetch /config first and immediately throw the result
    // away by overwriting it with /data — a wasted network round-trip on
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
  c.innerHTML = '<div class="text-center text-dim" style="padding:40px">Loading...</div>';
  try {
    switch (currentPage) {
      case 'dashboard': await renderDashboard(c); break;
      case 'timetable': await renderTimetable(c); break;
      case 'self_study': await renderSelfStudy(c); break;
      case 'attendance': await renderAttendance(c); break;
      case 'exams': await renderExams(c); break;
      case 'events': await renderEvents(c); break;
      case 'stats': await renderStats(c); break;
      case 'progression': await renderProgression(c); break;
      case 'settings': await renderSettings(c); break;
    }
  } catch (e) {
    c.innerHTML = `<div class="card"><div class="card-title">Error</div><p>${esc(e.message)}</p></div>`;
  }
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

  // Progression card
  c.appendChild(el('div', { class: 'card fade-in xp-card' }, [renderXpCard()]));

  // Stats row
  const grid = el('div', { class: 'stats-grid' });
  grid.appendChild(el('div', { class: 'stat-card' }, [
    el('div', { class: 'stat-value', text: fmtHours(totalSelfStudy) + 'h' }),
    el('div', { class: 'stat-label', text: 'Self-Study Hours' })
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

  // Quick Timer
  c.appendChild(el('div', { class: 'card fade-in' }, [
    el('div', { class: 'card-title', text: '⏱ Quick Timer' }),
    renderTimerWidget()
  ]));

  // Today's schedule
  const today = todayStr();
  const dayOfWeek = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][new Date(today).getDay()];
  const todayAttendance = d.attendance.filter(r => r.date === today);
  const todayStudy = d.self_study.filter(r => r.date === today);

  c.appendChild(el('div', { class: 'card fade-in' }, [
    el('div', { class: 'card-title', text: `📅 Today (${today} — ${dayOfWeek})` }),
    todayAttendance.length || todayStudy.length ? el('div', {}, [
      ...todayStudy.map(r => {
        const subj = cfg.subjects.find(s => s.id === r.subject_id);
        const skill = cfg.skills.find(s => s.id === r.skill_id);
        const name = subj?.name || skill?.name || 'Unknown';
        return el('div', { class: 'row', style: 'margin-bottom:6px' }, [
          el('span', { class: 'tag tag-done', text: 'Self-Study' }),
          el('span', { text: `${name} — ${r.minutes}min (${r.status})` })
        ]);
      }),
      ...todayAttendance.map(r => {
        const subj = cfg.subjects.find(s => s.id === r.subject_id);
        return el('div', { class: 'row', style: 'margin-bottom:6px' }, [
          el('span', { class: `tag tag-${r.status}`, text: r.status }),
          el('span', { text: `${subj?.name || 'Unknown'} ${r.type} — ${r.minutes}min` })
        ]);
      })
    ]) : el('div', { class: 'text-dim text-sm', text: 'Nothing logged today.' })
  ]));

  // Recent activity
  const recent = [...d.self_study].sort((a, b) => b.created.localeCompare(a.created)).slice(0, 5);
  c.appendChild(el('div', { class: 'card fade-in' }, [
    el('div', { class: 'card-title', text: '📋 Recent Activity' }),
    recent.length ? el('table', {}, [
      el('thead', {}, el('tr', {}, [
        el('th', { text: 'Date' }), el('th', { text: 'Subject / Skill' }), el('th', { text: 'Time' }), el('th', { text: 'Status' })
      ])),
      el('tbody', {}, recent.map(r => {
        const subj = cfg.subjects.find(s => s.id === r.subject_id);
        const skill = cfg.skills.find(s => s.id === r.skill_id);
        const name = subj?.name || (skill ? `🎯 ${skill.name}` : '—');
        return el('tr', {}, [
          el('td', { text: r.date }),
          el('td', { text: name }),
          el('td', { text: r.minutes + 'min' }),
          el('td', {}, el('span', { class: `tag tag-done`, text: r.status }))
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

// ── Persistent timer runtime state ──
// Lives at module scope (not inside renderTimerWidget) so a running or
// paused timer survives navigating to another page and back. Previously
// every piece of this state (accumulatedMs, running, activeTimerId,
// pomo, etc.) lived inside renderTimerWidget's local closure, so simply
// leaving the Dashboard and returning silently wiped out (and orphaned
// the interval of) any timer that was mid-session.
const TS = {
  mode: 'free',              // 'free' | 'pomodoro'
  accumulatedMs: 0,
  segmentStart: null,
  running: false,
  timerSubject: null,
  timerPlanned: 0,
  activeTimerId: null,
  pomo: null,                 // { config, sequence, idx, workMinutesDone, phaseEndsAt, currentPhaseMinutes }
  intervalId: null,
  miniIntervalId: null        // ticks the topbar mini-badge independent of the widget's own mount lifecycle
};

// ── Mini timer badge (topbar) ──
// Keeps a running/paused session visible in the topbar whenever the
// person navigates away from the Dashboard, so they don't lose track
// of it. Ticks on its own interval, separate from the widget's
// per-mount interval, so it keeps working regardless of which page is
// currently rendered.
function startMiniTimerTicker() {
  if (TS.miniIntervalId) return;
  TS.miniIntervalId = setInterval(updateMiniTimerBadge, UI_MINI_TIMER_TICK_MS);
  updateMiniTimerBadge();
}
function stopMiniTimerTicker() {
  if (TS.miniIntervalId) { clearInterval(TS.miniIntervalId); TS.miniIntervalId = null; }
  const badge = $('#miniTimerBadge');
  if (badge) { badge.classList.add('hidden'); badge.classList.remove('paused'); badge.innerHTML = ''; }
}
function updateMiniTimerBadge() {
  const badge = $('#miniTimerBadge');
  if (!badge) return;
  const active = TS.activeTimerId || TS.pomo;
  if (!active || currentPage === 'dashboard') {
    badge.classList.add('hidden');
    badge.innerHTML = '';
    return;
  }
  badge.classList.remove('hidden');
  badge.innerHTML = '';
  let icon, timeText, label, paused = false;
  if (TS.mode === 'pomodoro' && TS.pomo) {
    const step = TS.pomo.sequence[TS.pomo.idx];
    icon = step.phase === 'work' ? '🍅' : (step.phase === 'long' ? '🌴' : '☕');
    const remaining = Math.max(0, Math.floor((TS.pomo.phaseEndsAt - Date.now()) / 1000));
    timeText = formatClock(remaining);
    label = step.phase === 'work' ? `Block ${step.block}/${TS.pomo.config.blocks}` : 'Break';
  } else {
    const elapsed = Math.floor((TS.accumulatedMs + (TS.running && TS.segmentStart ? Date.now() - TS.segmentStart : 0)) / 1000);
    timeText = formatClock(elapsed);
    paused = !TS.running;
    icon = paused ? '⏸' : '⏱';
    label = paused ? 'Paused' : 'Studying';
  }
  badge.classList.toggle('paused', paused);
  badge.appendChild(el('span', { text: icon }));
  badge.appendChild(el('span', { class: 'mini-timer-time', text: timeText }));
  badge.appendChild(el('span', { class: 'mini-timer-label', text: label }));
}

function renderTimerWidget() {
  // A previous mount's interval (if any) is tied to now-detached DOM
  // nodes — stop it before wiring up the fresh elements below so
  // intervals don't pile up every time this page is revisited.
  if (TS.intervalId) { clearInterval(TS.intervalId); TS.intervalId = null; }

  const display = el('div', { class: 'timer-display', text: '00:00:00' });
  const phaseLabel = el('div', { class: 'text-center text-dim text-sm', style: 'min-height:20px;font-weight:600' });
  const subjectSel = el('select', {}, [
    el('option', { value: '', text: 'Select subject...' }),
    ...(cachedConfig?.subjects || []).map(s => el('option', { value: s.id, text: s.name })),
    ...(cachedConfig?.skills || []).map(s => el('option', { value: 'skill_' + s.id, text: `[Skill] ${s.name}` }))
  ]);
  const plannedInput = el('input', { type: 'number', value: '30', min: '1', placeholder: 'Planned minutes' });
  const statusDiv = el('div', { class: 'text-center text-dim text-sm', style: 'min-height:24px' });
  const startBtn = el('button', { class: 'btn btn-success', text: '▶ Start', onclick: startFreeTimer });
  const pauseBtn = el('button', { class: 'btn btn-amber hidden', text: '⏸ Pause', onclick: pauseFreeTimer });
  const resumeBtn = el('button', { class: 'btn btn-success hidden', text: '▶ Resume', onclick: resumeFreeTimer });
  const stopBtn = el('button', { class: 'btn btn-danger hidden', text: '⏹ Stop & Save', onclick: stopFreeTimer });

  // Pomodoro config inputs
  const workInput = el('input', { type: 'number', value: '25', min: '1', style: 'width:70px' });
  const shortBreakInput = el('input', { type: 'number', value: '5', min: '1', style: 'width:70px' });
  const longBreakInput = el('input', { type: 'number', value: '15', min: '1', style: 'width:70px' });
  const blocksInput = el('input', { type: 'number', value: '4', min: '1', style: 'width:70px' });
  const longEveryInput = el('input', { type: 'number', value: '4', min: '1', style: 'width:70px' });
  const estimateDiv = el('div', { class: 'text-dim text-sm mt-8' });
  const pomoStartBtn = el('button', { class: 'btn btn-success', text: '▶ Start Pomodoro', onclick: startPomodoro });
  const pomoStopBtn = el('button', { class: 'btn btn-danger hidden', text: '⏹ Stop & Save', onclick: stopPomodoro });
  const pomoSkipBtn = el('button', { class: 'btn btn-outline hidden', text: '⏭ Skip Phase', onclick: () => advancePomodoroPhase(true) });

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

  function elapsedMs() {
    return TS.accumulatedMs + (TS.running && TS.segmentStart ? (Date.now() - TS.segmentStart) : 0);
  }

  function updateDisplay() {
    const elapsed = Math.floor(elapsedMs() / 1000);
    display.textContent = formatClock(elapsed);
    if (TS.timerPlanned > 0 && elapsed >= TS.timerPlanned * 60) {
      statusDiv.innerHTML = '<span style="color:var(--green)">✓ Planned time reached!</span>';
    }
  }

  async function startFreeTimer() {
    const val = subjectSel.value;
    if (!val) { alert('Select a subject or skill'); return; }
    const isSkill = val.startsWith('skill_');
    TS.timerSubject = isSkill ? { skill_id: val.slice(6) } : { subject_id: val };
    TS.timerPlanned = parseInt(plannedInput.value) || 0;
    try {
      const startResp = await api(`/api/${currentProfile}/timer/start`, { method: 'POST', body: JSON.stringify({ ...TS.timerSubject, planned_minutes: TS.timerPlanned }) });
      TS.activeTimerId = startResp?.timer?.id || null;
    } catch (e) { alert('Could not start timer: ' + e.message); return; }
    TS.accumulatedMs = 0;
    TS.segmentStart = Date.now();
    TS.running = true;
    startBtn.classList.add('hidden');
    pauseBtn.classList.remove('hidden');
    stopBtn.classList.remove('hidden');
    subjectSel.disabled = true;
    plannedInput.disabled = true;
    statusDiv.textContent = `Running... (${TS.timerPlanned}min planned)`;
    TS.intervalId = setInterval(updateDisplay, 1000);
    updateDisplay();
    startMiniTimerTicker();
  }

  function pauseFreeTimer() {
    if (!TS.running) return;
    TS.accumulatedMs += Date.now() - TS.segmentStart;
    TS.running = false;
    TS.segmentStart = null;
    clearInterval(TS.intervalId);
    TS.intervalId = null;
    pauseBtn.classList.add('hidden');
    resumeBtn.classList.remove('hidden');
    statusDiv.innerHTML = '<span style="color:var(--amber)">⏸ Paused</span>';
    updateDisplay();
    updateMiniTimerBadge();
  }

  function resumeFreeTimer() {
    if (TS.running) return;
    TS.segmentStart = Date.now();
    TS.running = true;
    resumeBtn.classList.add('hidden');
    pauseBtn.classList.remove('hidden');
    statusDiv.textContent = `Running... (${TS.timerPlanned}min planned)`;
    TS.intervalId = setInterval(updateDisplay, 1000);
    updateDisplay();
    updateMiniTimerBadge();
  }

  function findSubjectOrSkillDifficulty() {
    if (!TS.timerSubject) return 5;
    if (TS.timerSubject.subject_id) return cachedConfig?.subjects.find(s => s.id === TS.timerSubject.subject_id)?.difficulty || 5;
    if (TS.timerSubject.skill_id) return cachedConfig?.skills.find(s => s.id === TS.timerSubject.skill_id)?.difficulty || 5;
    return 5;
  }

  async function saveSession(actualMin) {
    if (!TS.activeTimerId) {
      statusDiv.innerHTML = `<span style="color:var(--red)">Session wasn't tracked on the server — nothing to save.</span>`;
      return;
    }
    if (actualMin <= 0) {
      // Nothing was actually studied (e.g. every phase was skipped
      // near-instantly) — close out the timer without fabricating a
      // record or asking the person to rate zero minutes of work.
      try {
        await api(`/api/${currentProfile}/timer/${TS.activeTimerId}/stop`, {
          method: 'POST', body: JSON.stringify({ planned_minutes: TS.timerPlanned, actual_minutes: 0, auto_record: false })
        });
      } catch (e) { /* non-fatal — timer entry is cosmetic bookkeeping */ }
      statusDiv.innerHTML = `<span class="text-dim">No study time logged — nothing saved.</span>`;
      TS.activeTimerId = null;
      stopMiniTimerTicker();
      setTimeout(() => { statusDiv.textContent = ''; }, UI_STATUS_MESSAGE_CLEAR_MS);
      return;
    }
    showSessionRatingModal(actualMin, TS.timerSubject, async (rating) => {
      const payload = {
        planned_minutes: TS.timerPlanned, actual_minutes: actualMin,
        difficulty: rating.difficulty, self_study_status: rating.status,
        note: rating.note, auto_record: true
      };
      try {
        const resp = await api(`/api/${currentProfile}/timer/${TS.activeTimerId}/stop`, { method: 'POST', body: JSON.stringify(payload) });
        statusDiv.innerHTML = `<span style="color:var(--green)">✓ Saved: ${actualMin}min</span>`;
        await loadData();
        await maybeShowLevelUp({ skipXpToast: true });
        render();
        if (resp && resp.xp_earned > 0) {
          showSessionXpToast(resp.xp_earned, actualMin, rating.difficulty);
        }
      } catch (e) {
        statusDiv.innerHTML = `<span style="color:var(--red)">Error: ${esc(e.message)}</span>`;
      }
      TS.activeTimerId = null;
      stopMiniTimerTicker();
      setTimeout(() => { statusDiv.textContent = ''; }, UI_STATUS_MESSAGE_CLEAR_MS);
    });
  }

  async function stopFreeTimer() {
    clearInterval(TS.intervalId);
    TS.intervalId = null;
    const actualMin = Math.max(0, Math.round(elapsedMs() / 60000));
    TS.running = false;
    TS.segmentStart = null;
    TS.accumulatedMs = 0;
    startBtn.classList.remove('hidden');
    pauseBtn.classList.add('hidden');
    resumeBtn.classList.add('hidden');
    stopBtn.classList.add('hidden');
    subjectSel.disabled = false;
    plannedInput.disabled = false;
    display.textContent = '00:00:00';
    statusDiv.textContent = '';
    await saveSession(actualMin);
  }

  function showSessionRatingModal(actualMin, subjInfo, onConfirm) {
    const diffInput = el('input', { type: 'range', min: '1', max: '10', value: String(findSubjectOrSkillDifficulty()) });
    const diffLabel = el('span', { text: diffInput.value + '/10', style: 'font-weight:700' });
    diffInput.oninput = () => diffLabel.textContent = diffInput.value + '/10';
    const statusSel = el('select', {}, [
      el('option', { value: 'Done', text: 'Done — completed as planned' }),
      el('option', { value: 'Partial', text: 'Partial — got through some of it' }),
      el('option', { value: 'Skipped', text: "Skipped — didn't really study" })
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

  // ── Pomodoro ──
  function phaseSequence(config) {
    const seq = [];
    for (let i = 1; i <= config.blocks; i++) {
      seq.push({ phase: 'work', block: i });
      if (i < config.blocks) {
        seq.push({ phase: (i % config.every === 0) ? 'long' : 'short', block: i });
      }
    }
    return seq;
  }

  async function startPomodoro() {
    const val = subjectSel.value;
    if (!val) { alert('Select a subject or skill'); return; }
    const isSkill = val.startsWith('skill_');
    TS.timerSubject = isSkill ? { skill_id: val.slice(6) } : { subject_id: val };
    const config = {
      work: parseInt(workInput.value) || 25,
      short: parseInt(shortBreakInput.value) || 5,
      long: parseInt(longBreakInput.value) || 15,
      blocks: parseInt(blocksInput.value) || 4,
      every: parseInt(longEveryInput.value) || 4
    };
    TS.timerPlanned = config.work * config.blocks;
    try {
      const startResp = await api(`/api/${currentProfile}/timer/start`, { method: 'POST', body: JSON.stringify({ ...TS.timerSubject, planned_minutes: TS.timerPlanned }) });
      TS.activeTimerId = startResp?.timer?.id || null;
    } catch (e) { alert('Could not start: ' + e.message); return; }

    TS.pomo = { config, sequence: phaseSequence(config), idx: 0, workMinutesDone: 0 };
    [workInput, shortBreakInput, longBreakInput, blocksInput, longEveryInput, subjectSel].forEach(i => i.disabled = true);
    pomoStartBtn.classList.add('hidden');
    pomoStopBtn.classList.remove('hidden');
    pomoSkipBtn.classList.remove('hidden');
    enterPomodoroPhase();
    startMiniTimerTicker();
  }

  function enterPomodoroPhase(silent) {
    const step = TS.pomo.sequence[TS.pomo.idx];
    const minutes = step.phase === 'work' ? TS.pomo.config.work : (step.phase === 'long' ? TS.pomo.config.long : TS.pomo.config.short);
    if (!silent) {
      TS.pomo.phaseEndsAt = Date.now() + minutes * 60000;
      TS.pomo.currentPhaseMinutes = minutes;
      playChime(step.phase === 'work' ? 660 : 440);
    }
    const icon = step.phase === 'work' ? '🍅' : (step.phase === 'long' ? '🌴' : '☕');
    const label = step.phase === 'work' ? `Work Block ${step.block}/${TS.pomo.config.blocks}` : (step.phase === 'long' ? 'Long Break' : 'Short Break');
    phaseLabel.textContent = `${icon} ${label}`;
    clearInterval(TS.intervalId);
    TS.intervalId = setInterval(pomodoroTick, 1000);
    pomodoroTick();
    updateMiniTimerBadge();
  }

  function pomodoroTick() {
    const remaining = (TS.pomo.phaseEndsAt - Date.now()) / 1000;
    if (remaining <= 0) {
      const step = TS.pomo.sequence[TS.pomo.idx];
      if (step.phase === 'work') TS.pomo.workMinutesDone += TS.pomo.currentPhaseMinutes;
      advancePomodoroPhase(false);
      return;
    }
    display.textContent = formatClock(remaining);
  }

  async function advancePomodoroPhase(manualSkip) {
    clearInterval(TS.intervalId);
    TS.intervalId = null;
    if (manualSkip) {
      const step = TS.pomo.sequence[TS.pomo.idx];
      if (step.phase === 'work') {
        const doneMin = Math.round((TS.pomo.currentPhaseMinutes * 60 - Math.max(0, (TS.pomo.phaseEndsAt - Date.now()) / 1000)) / 60);
        TS.pomo.workMinutesDone += Math.max(0, doneMin);
      }
    }
    TS.pomo.idx++;
    if (TS.pomo.idx >= TS.pomo.sequence.length) {
      await finishPomodoro();
      return;
    }
    enterPomodoroPhase();
  }

  async function finishPomodoro() {
    display.textContent = '00:00:00';
    phaseLabel.textContent = '🎉 Pomodoro complete!';
    playChime(880);
    pomoStartBtn.classList.remove('hidden');
    pomoStopBtn.classList.add('hidden');
    pomoSkipBtn.classList.add('hidden');
    [workInput, shortBreakInput, longBreakInput, blocksInput, longEveryInput, subjectSel].forEach(i => i.disabled = false);
    const workMin = Math.max(0, Math.round(TS.pomo.workMinutesDone));
    TS.pomo = null;
    await saveSession(workMin);
  }

  async function stopPomodoro() {
    clearInterval(TS.intervalId);
    TS.intervalId = null;
    const step = TS.pomo.sequence[TS.pomo.idx];
    if (step && step.phase === 'work') {
      const doneMin = Math.round((TS.pomo.currentPhaseMinutes * 60 - Math.max(0, (TS.pomo.phaseEndsAt - Date.now()) / 1000)) / 60);
      TS.pomo.workMinutesDone += Math.max(0, doneMin);
    }
    const workMin = Math.max(0, Math.round(TS.pomo.workMinutesDone));
    display.textContent = '00:00:00';
    phaseLabel.textContent = '';
    pomoStartBtn.classList.remove('hidden');
    pomoStopBtn.classList.add('hidden');
    pomoSkipBtn.classList.add('hidden');
    [workInput, shortBreakInput, longBreakInput, blocksInput, longEveryInput, subjectSel].forEach(i => i.disabled = false);
    TS.pomo = null;
    await saveSession(workMin);
  }

  const freePanel = el('div', {}, [
    el('div', { class: 'row', style: 'margin-bottom:12px;gap:12px' }, [
      el('div', { style: 'width:120px' }, [el('label', { text: 'Planned (min)' }), plannedInput])
    ]),
    el('div', { class: 'timer-controls' }, [startBtn, pauseBtn, resumeBtn, stopBtn])
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
    el('div', { class: 'timer-controls', style: 'margin-top:8px' }, [pomoStartBtn, pomoStopBtn, pomoSkipBtn])
  ]);

  const modeFreeBtn = el('button', { class: 'btn btn-sm', text: '⏱ Free Timer', onclick: () => switchMode('free') });
  const modePomoBtn = el('button', { class: 'btn btn-sm btn-outline', text: '🍅 Pomodoro', onclick: () => switchMode('pomodoro') });
  const modeTabs = el('div', { class: 'btn-group', style: 'margin-bottom:12px' }, [modeFreeBtn, modePomoBtn]);

  function switchMode(m) {
    // Switching tabs while a timer is actively running/paused in the
    // OTHER mode would silently abandon it, so it's blocked — the
    // person needs to stop/save (or let the Pomodoro finish) first.
    if (m !== TS.mode && (TS.activeTimerId || TS.pomo)) {
      alert('Finish or stop the current session before switching modes.');
      return;
    }
    TS.mode = m;
    freePanel.classList.toggle('hidden', m !== 'free');
    pomoPanel.classList.toggle('hidden', m !== 'pomodoro');
    modeFreeBtn.classList.toggle('btn-outline', m !== 'free');
    modePomoBtn.classList.toggle('btn-outline', m !== 'pomodoro');
    display.textContent = '00:00:00';
    phaseLabel.textContent = '';
  }

  // ── Restore UI from persisted state ──
  // Runs on every mount (including remounts after navigating away and
  // back) so a session already in progress shows correctly instead of
  // resetting to the idle "Start" state.
  function syncUIFromState() {
    modeFreeBtn.classList.toggle('btn-outline', TS.mode !== 'free');
    modePomoBtn.classList.toggle('btn-outline', TS.mode !== 'pomodoro');
    freePanel.classList.toggle('hidden', TS.mode !== 'free');
    pomoPanel.classList.toggle('hidden', TS.mode !== 'pomodoro');

    const subjVal = TS.timerSubject ? (TS.timerSubject.subject_id || ('skill_' + TS.timerSubject.skill_id)) : '';
    if (subjVal) subjectSel.value = subjVal;

    if (TS.mode === 'free' && TS.activeTimerId) {
      subjectSel.disabled = true;
      plannedInput.disabled = true;
      plannedInput.value = TS.timerPlanned || plannedInput.value;
      startBtn.classList.add('hidden');
      stopBtn.classList.remove('hidden');
      if (TS.running) {
        pauseBtn.classList.remove('hidden');
        resumeBtn.classList.add('hidden');
        statusDiv.textContent = `Running... (${TS.timerPlanned}min planned)`;
        TS.intervalId = setInterval(updateDisplay, 1000);
      } else {
        pauseBtn.classList.add('hidden');
        resumeBtn.classList.remove('hidden');
        statusDiv.innerHTML = '<span style="color:var(--amber)">⏸ Paused</span>';
      }
      updateDisplay();
    } else if (TS.mode === 'pomodoro' && TS.pomo) {
      [workInput, shortBreakInput, longBreakInput, blocksInput, longEveryInput, subjectSel].forEach(i => i.disabled = true);
      workInput.value = TS.pomo.config.work;
      shortBreakInput.value = TS.pomo.config.short;
      longBreakInput.value = TS.pomo.config.long;
      blocksInput.value = TS.pomo.config.blocks;
      longEveryInput.value = TS.pomo.config.every;
      pomoStartBtn.classList.add('hidden');
      pomoStopBtn.classList.remove('hidden');
      pomoSkipBtn.classList.remove('hidden');
      enterPomodoroPhase(true);
    }
  }

  estimateTotal();
  syncUIFromState();

  return el('div', {}, [
    modeTabs,
    el('div', { class: 'row', style: 'margin-bottom:12px;gap:12px' }, [
      el('div', { class: 'flex-1' }, [el('label', { text: 'Subject / Skill' }), subjectSel])
    ]),
    freePanel,
    pomoPanel,
    display,
    phaseLabel,
    statusDiv
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

async function renderTimetable(c) {
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
    el('h2', { text: '📅 Timetable' }),
    el('div', { class: 'btn-group' }, [
      el('button', { class: 'btn btn-sm btn-outline', text: '+ Add Subject to Schedule', onclick: showAddSubjectModal }),
      el('button', { class: 'btn btn-sm btn-outline', text: '+ Schedule a Skill', onclick: showAddSkillScheduleModal })
    ])
  ]));

  // Year filter — now actually filters (previously the dropdown existed
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
  // Exams themselves are never affected by any of this — they can exist
  // inside or outside exam periods/vacations freely.
  function isLessonSuppressed(dateStr, sub) {
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

    // Subject schedule blocks — bounded to the assigned year's dates, and
    // suppressed during that year's exam periods / vacation weeks.
    (cfg.subjects || []).forEach(sub => {
      if (!subjectInSelectedYear(sub)) return;
      if (isLessonSuppressed(dateStr, sub)) return;
      (sub.schedule || []).forEach(sch => {
        if (sch.day !== dayName) return;
        const schType = sch.type || 'C';
        // Marked absent for this exact lesson slot — the person wasn't
        // there (they may have self-studied instead, which already
        // shows up separately), so don't clutter the calendar with a
        // lesson that didn't happen for them.
        const markedAbsent = (d.attendance || []).some(a =>
          a.subject_id === sub.id && a.date === dateStr && a.type === schType && a.status === 'absent'
        );
        if (markedAbsent) return;
        const start = timeToMinutes(sch.start || '08:00');
        const end = timeToMinutes(sch.end || sch.start || '09:00');
        timed.push({
          start, end: Math.max(end, start + 15),
          label: `${sub.name}`, sub: schType,
          cls: schType.toLowerCase(),
          color: sub.color, kind: 'subject', ref: { sub, sch }, dateStr
        });
      });
    });

    // Skill schedule blocks — NOT suppressed by exam periods/vacations;
    // vacations in particular are explicitly meant to still allow
    // self-study/self-skilling sessions even though lessons are off.
    (cfg.skills || []).forEach(sk => {
      (sk.schedule || []).forEach(sch => {
        if (sch.day !== dayName) return;
        const start = timeToMinutes(sch.start || '08:00');
        const end = timeToMinutes(sch.end || sch.start || '09:00');
        timed.push({
          start, end: Math.max(end, start + 15),
          label: `🎯 ${sk.name}`, sub: 'Skill',
          cls: 'skill', color: sk.color, kind: 'skillsched', ref: { sk, sch }
        });
      });
    });

    // Exams — end time computed from start_time + duration_minutes, fixing
    // the "shows in every hour of the day" bug.
    (d.exams || []).forEach(ex => {
      if (ex.date !== dateStr) return;
      if (ex.subject_id && subjById[ex.subject_id] && !subjectInSelectedYear(subjById[ex.subject_id])) return;
      const start = timeToMinutes(ex.start_time || '08:00');
      const dur = parseInt(ex.duration_minutes) || 120;
      timed.push({
        start, end: start + dur,
        label: `📝 ${ex.name || 'Exam'}`, sub: subjById[ex.subject_id]?.name || '',
        cls: 'exam', color: null, kind: 'exam', ref: ex
      });
    });

    // Logged self-study sessions — placed using the time-of-day they
    // were actually recorded, so completed work shows up on the
    // Timetable instead of only living in the Self-Study list.
    // `created` is when the record was SAVED — for a timer/pomodoro
    // session that's essentially the moment it ENDED, and for a manual
    // entry it's still much closer to "when I finished" than "when I
    // started." Treating it as the start (as this used to) made every
    // logged session appear to begin right now and run into the future.
    // Anchoring it as the END and working backward by the session's
    // duration is the correct read in both cases.
    (d.self_study || []).forEach(r => {
      if (r.date !== dateStr) return;
      const dur = Math.max(15, r.minutes || 30);
      let endMin = 12 * 60 + 30; // fallback if no usable timestamp
      const timePart = (r.created || '').split('T')[1];
      if (timePart) {
        const [hh, mm] = timePart.split(':').map(n => parseInt(n) || 0);
        endMin = hh * 60 + mm;
      }
      const startMin = Math.max(0, endMin - dur);
      const subj = subjById[r.subject_id];
      const skill = skillById[r.skill_id];
      const label = subj ? subj.name : (skill ? skill.name : 'Self-Study');
      timed.push({
        start: startMin, end: Math.max(startMin + 15, endMin),
        label: `📖 ${label}`, sub: r.status,
        cls: 'selfstudy', color: subj?.color || skill?.color || null,
        kind: 'selfstudy', ref: r
      });
    });

    // One-time events — only treated as all-day when there's genuinely no
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
    const pxPerHour = 44;
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
      // top of each other — a day with several things at once used to
      // render them all at full width, hiding all but the last one.
      assignLanes(dayData[i].timed).forEach(({ ev, lane, laneCount }) => {
        const top = Math.max(0, ((ev.start - rangeStart) / totalMins) * totalHeight);
        const height = Math.max(20, ((ev.end - ev.start) / totalMins) * totalHeight);
        const bg = ev.color || null;
        const widthPct = 100 / laneCount;
        const leftPct = lane * widthPct;
        const style = `top:${top}px;height:${height}px;left:calc(${leftPct}% + 1px);width:calc(${widthPct}% - 2px);right:auto;` + (bg ? `background:${bg}22;border-left-color:${bg}` : '');
        const block = el('div', {
          class: `cal-event cal-${ev.cls}`, style,
          title: `${ev.label}${ev.sub ? ' — ' + ev.sub : ''} (${minutesToTime(ev.start)}–${minutesToTime(ev.end)})`,
          onclick: () => {
            if (ev.kind === 'exam') editExam(ev.ref);
            else if (ev.kind === 'oneoff') editEvent(ev.ref);
            else if (ev.kind === 'subject') showQuickAttendanceModal(ev.ref.sub, ev.ref.sch, ev.dateStr || localDStr);
            else if (ev.kind === 'selfstudy') editSelfStudy(ev.ref);
          }
        }, [
          el('div', { class: 'cal-event-title', text: ev.label }),
          height > 32 ? el('div', { class: 'cal-event-sub', text: `${minutesToTime(ev.start)}–${minutesToTime(ev.end)}${ev.sub ? ' · ' + ev.sub : ''}` }) : null
        ]);
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

function showAddSubjectModal() {
  // Quick add subject to timetable
  const cfg = cachedConfig || { academic_years: [] };
  const nameInput = el('input', { placeholder: 'Subject name' });
  const typeSel = el('select', {}, [
    el('option', { value: 'C', text: 'Cours (C)' }),
    el('option', { value: 'TD', text: 'TD' }),
    el('option', { value: 'TP', text: 'TP' })
  ]);
  const daySel = el('select', {}, [
    el('option', { value: 'monday', text: 'Monday' }),
    el('option', { value: 'tuesday', text: 'Tuesday' }),
    el('option', { value: 'wednesday', text: 'Wednesday' }),
    el('option', { value: 'thursday', text: 'Thursday' }),
    el('option', { value: 'friday', text: 'Friday' }),
    el('option', { value: 'saturday', text: 'Saturday' }),
    el('option', { value: 'sunday', text: 'Sunday' })
  ]);
  const startInput = el('input', { value: '08:00' });
  const endInput = el('input', { value: '09:30' });
  const colorInput = el('input', { type: 'color', value: '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0') });
  // Year assignment was missing from this form entirely, which meant every
  // subject's year_id stayed "" forever and the Timetable's year filter
  // had nothing to filter by. Now wired up (optional).
  const yearSel = el('select', {}, [
    el('option', { value: '', text: 'No year / unassigned' }),
    ...(cfg.academic_years || []).map(y => el('option', { value: y.id, text: y.label }))
  ]);

  const content = el('div', {}, [
    el('div', { class: 'modal-header' }, [
      el('div', { class: 'modal-title', text: 'Add Subject to Timetable' }),
      el('button', { class: 'modal-close', onclick: closeModal, text: '×' })
    ]),
    el('label', { text: 'Subject Name' }), nameInput,
    el('label', { text: 'Color' }), colorInput,
    el('label', { text: 'Academic Year' }), yearSel,
    el('label', { text: 'Type' }), typeSel,
    el('label', { text: 'Day' }), daySel,
    el('div', { class: 'row', style: 'margin-top:8px' }, [
      el('div', { class: 'flex-1' }, [el('label', { text: 'Start' }), startInput]),
      el('div', { class: 'flex-1' }, [el('label', { text: 'End' }), endInput])
    ]),
    el('div', { class: 'btn-group', style: 'margin-top:16px;justify-content:flex-end' }, [
      el('button', { class: 'btn', text: 'Add', onclick: async () => {
        // This creates a new subject with schedule
        const name = nameInput.value.trim();
        if (!name) { alert('Enter name'); return; }
        if (timeToMinutes(endInput.value) <= timeToMinutes(startInput.value)) { alert('End time must be after start time'); return; }
        try {
          await api(`/api/${currentProfile}/subjects`, {
            method: 'POST',
            body: JSON.stringify({
              name,
              color: colorInput.value,
              difficulty: 5,
              year_id: yearSel.value,
              schedule: [{ day: daySel.value, type: typeSel.value, start: startInput.value, end: endInput.value }]
            })
          });
          closeModal();
          await loadConfig();
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
  // never suppressed by exam periods or vacation weeks — they're meant
  // for self-study/self-skilling, including during breaks.
  const cfg = cachedConfig || { skills: [] };
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
    el('h2', { text: '📖 Self-Study Records' }),
    el('button', { class: 'btn', text: '+ Add Record', onclick: showAddSelfStudyModal })
  ]));

  const records = [...(d.self_study || [])].sort((a, b) => b.date.localeCompare(a.date) || b.created.localeCompare(a.created));

  if (!records.length) {
    c.appendChild(el('div', { class: 'card text-dim text-center', style: 'padding:40px', text: 'No self-study records yet. Click "+ Add Record" or use the timer!' }));
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
      const name = subj?.name || skill?.name || '—';
      return el('tr', {}, [
        el('td', { text: r.date }),
        el('td', { text: name }),
        el('td', { text: r.minutes + 'min (' + fmtHours(r.minutes) + 'h)' }),
        el('td', { text: r.difficulty + '/10' }),
        el('td', {}, el('span', { class: `tag tag-${r.status === 'Done' ? 'done' : r.status === 'Partial' ? 'partial' : 'absent'}`, text: r.status })),
        el('td', { class: 'text-sm text-dim', text: r.note || '—' }),
        el('td', {}, el('button', { class: 'btn btn-sm btn-outline', text: '✏️', onclick: () => editSelfStudy(r) }))
      ]);
    }))
  ]);
  c.appendChild(el('div', { class: 'card fade-in' }, [table]));
}

function showAddSelfStudyModal() {
  const dateInput = el('input', { type: 'date', value: todayStr() });
  const subjSel = el('select', {}, [
    el('option', { value: '', text: 'Select subject...' }),
    ...(cachedConfig?.subjects || []).map(s => el('option', { value: s.id, text: s.name })),
    el('option', { value: '', disabled: true, text: '── Skills ──' }),
    ...(cachedConfig?.skills || []).map(s => el('option', { value: 'skill_'+s.id, text: s.name }))
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
      el('div', { class: 'modal-title', text: 'Add Self-Study Record' }),
      el('button', { class: 'modal-close', onclick: closeModal, text: '×' })
    ]),
    el('label', { text: 'Date' }), dateInput,
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
            showSessionXpToast(resp.xp_earned, payload.minutes, payload.difficulty);
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
      el('div', { class: 'modal-title', text: 'Edit Self-Study Record' }),
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
        showUndoToast('Self-study record deleted.');
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
    el('h2', { text: '✅ Attendance' }),
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
        el('td', { text: subj?.name || '—' }),
        el('td', {}, el('span', { class: `tag tag-${r.type.toLowerCase()}`, text: r.type })),
        el('td', { text: r.event_label || '—' }),
        el('td', {}, el('span', { class: `tag tag-${r.status}`, text: r.status })),
        el('td', { text: r.minutes + 'min' }),
        el('td', {}, el('button', { class: 'btn btn-sm btn-outline', text: '✏️', onclick: () => editAttendance(r) }))
      ]);
    }))
  ]);
  c.appendChild(el('div', { class: 'card fade-in' }, [table]));
}

// When a presence/absence default mode is active, manual entries should
// default to the *exception* status — since the default status is
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
  const subjSel = el('select', {}, [
    el('option', { value: '', text: 'Select subject...' }),
    ...(cachedConfig?.subjects || []).map(s => el('option', { value: s.id, text: s.name }))
  ]);
  const typeSel = el('select', {}, [
    el('option', { value: 'C', text: 'Cours (C)' }),
    el('option', { value: 'TD', text: 'TD' }),
    el('option', { value: 'TP', text: 'TP' })
  ]);
  const eventInput = el('input', { placeholder: 'e.g. TD1, Lab 3' });
  const statusSel = el('select', {}, [
    el('option', { value: 'present', text: 'Present' }),
    el('option', { value: 'partial', text: 'Partial' }),
    el('option', { value: 'absent', text: 'Absent' })
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
    el('option', { value: 'absent', text: 'Absent' })
  ]);
  statusSel.value = defaultExceptionStatus();
  const minutesInput = el('input', { type: 'number', value: Math.max(15, (timeToMinutes(schedule.end || schedule.start || '09:00') - timeToMinutes(schedule.start || '08:00')) || 90), min: '0' });
  const content = el('div', {}, [
    el('div', { class: 'modal-header' }, [
      el('div', { class: 'modal-title', text: 'Mark Attendance' }),
      el('button', { class: 'modal-close', onclick: closeModal, text: '×' })
    ]),
    el('div', { class: 'text-sm text-dim mb-8', text: `${subject.name} • ${schedule.type || 'C'} • ${dateStr}` }),
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
              event_label: `${subject.name} ${schedule.type || 'C'}`,
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
    el('option', { value: 'absent', text: 'Absent' })
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
    el('h2', { text: '📝 Exams' }),
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
      const typeLabels = { written: 'Written', tp_exam: 'TP Exam', oral: 'Oral' };
      const scoreDisplay = r.score !== null && r.score !== undefined ? `${r.score}/20` : (r.ranking ? `(${r.ranking})` : '—');
      return el('tr', {}, [
        el('td', { text: r.date }),
        el('td', { text: subj?.name || '—' }),
        el('td', { text: r.name }),
        el('td', { text: typeLabels[r.type || 'written'] || r.type || '—' }),
        el('td', { text: scoreDisplay }),
        el('td', {}, el('span', { class: `tag tag-${r.status === 'done' ? 'done' : r.status === 'missed' ? 'absent' : 'scheduled'}`, text: r.status })),
        el('td', {}, el('button', { class: 'btn btn-sm btn-outline', text: '✏️', onclick: () => editExam(r) }))
      ]);
    }))
  ]);
  c.appendChild(el('div', { class: 'card fade-in' }, [table]));
}

function showAddExamModal() {
  const dateInput = el('input', { type: 'date', value: todayStr() });
  const subjSel = el('select', {}, [
    el('option', { value: '', text: 'Select subject...' }),
    ...(cachedConfig?.subjects || []).map(s => el('option', { value: s.id, text: s.name }))
  ]);
  const nameInput = el('input', { placeholder: 'Exam name (e.g. Midterm 1)' });
  const typeSel = el('select', {}, [
    el('option', { value: 'written', text: 'Written Exam' }),
    el('option', { value: 'tp_exam', text: 'TP Exam (Lab)' }),
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
    el('option', { value: 'tp_exam', text: 'TP Exam (Lab)' }),
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
    el('h2', { text: '🎉 Events & Meetings' }),
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
      el('td', { text: r.type }),
      el('td', { text: `${r.start_time || ''}–${r.end_time || ''}` }),
      el('td', { text: r.minutes ? r.minutes + 'min' : '—' }),
      el('td', {}, el('span', { class: `tag tag-${r.status === 'done' ? 'done' : 'scheduled'}`, text: r.status })),
      el('td', {}, el('button', { class: 'btn btn-sm btn-outline', text: '✏️', onclick: () => editEvent(r) }))
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
async function renderStats(c) {
  c.innerHTML = '<div class="text-center text-dim" style="padding:40px">Loading statistics...</div>';
  let stats;
  try {
    stats = await api(`/api/${currentProfile}/stats`);
  } catch (e) {
    c.innerHTML = `<div class="card"><p>Error loading stats: ${esc(e.message)}</p></div>`;
    return;
  }

  c.innerHTML = '';
  const activeTheme = document.documentElement.getAttribute('data-theme') || 'dark';
  c.appendChild(el('div', { class: 'row', style: 'justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:8px' }, [
    el('h2', { text: '📊 Statistics' }),
    el('a', {
      class: 'btn btn-outline btn-sm', href: `/api/${currentProfile}/report/weekly?theme=${activeTheme}`,
      text: '📄 Download Weekly PDF Report'
    })
  ]));

  // Recommendations. NOTE: stats.recommendations (from /stats) already
  // merges heuristic + ML recommendations server-side (see
  // get_heuristic_recommendations()/get_ml_recommendations() in
  // server.py), each tagged with a "source" field. This used to ALSO
  // fetch /ml_recommendations separately and render those a second time —
  // whenever there was enough data for ML recs to kick in, the same
  // insight showed up twice (once mislabeled "RULE" via the merged list,
  // once correctly labeled "ML" via the second fetch). Now there's a
  // single source of truth, labeled correctly by r.source.
  if (stats.recommendations && stats.recommendations.length > 0) {
    c.appendChild(el('div', { class: 'card fade-in' }, [
      el('div', { class: 'card-title', text: '💡 Smart Recommendations' }),
      ...stats.recommendations.map(r => {
        const isMl = (r.source || '').startsWith('ml');
        const tagLabel = r.source === 'ml_predictive' ? 'PREDICTED' : r.source === 'ml_pattern' ? 'PATTERN' : isMl ? 'ML' : 'RULE';
        return el('div', { class: `recommendation ${isMl ? 'info' : r.type}` }, [
          el('span', { text: isMl ? '🤖' : (r.type === 'warning' ? '⚠️' : 'ℹ️') }),
          el('span', { text: r.msg }),
          el('span', {
            class: 'tag', style: `margin-left:8px;font-size:9px;${isMl ? 'background:var(--accent3)' : 'background:var(--bg4);color:var(--text)'}`,
            text: tagLabel
          })
        ]);
      })
    ]));
  }

  // Overview cards
  const grid = el('div', { class: 'stats-grid fade-in' });
  grid.appendChild(el('div', { class: 'stat-card' }, [
    el('div', { class: 'stat-value', text: stats.self_study.total_hours + 'h' }),
    el('div', { class: 'stat-label', text: 'Total Self-Study' })
  ]));
  grid.appendChild(el('div', { class: 'stat-card' }, [
    el('div', { class: 'stat-value', text: fmtHours((stats.attendance.minutes_by_subject ? Object.values(stats.attendance.minutes_by_subject).reduce((a,b)=>a+b,0) : 0)) + 'h' }),
    el('div', { class: 'stat-label', text: 'Uni Hours Attended' })
  ]));
  grid.appendChild(el('div', { class: 'stat-card' }, [
    el('div', { class: 'stat-value', text: stats.attendance.present }),
    el('div', { class: 'stat-label', text: 'Present Count' })
  ]));
  grid.appendChild(el('div', { class: 'stat-card' }, [
    el('div', { class: 'stat-value', text: stats.attendance.absent }),
    el('div', { class: 'stat-label', text: 'Absent Count' })
  ]));
  grid.appendChild(el('div', { class: 'stat-card' }, [
    el('div', { class: 'stat-value', text: stats.exams.total }),
    el('div', { class: 'stat-label', text: 'Total Exams' })
  ]));
  grid.appendChild(el('div', { class: 'stat-card' }, [
    el('div', { class: 'stat-value', text: stats.events.total }),
    el('div', { class: 'stat-label', text: 'Total Events' })
  ]));
  c.appendChild(grid);

  // Self-study by subject
  if (Object.keys(stats.self_study.by_subject).length > 0) {
    c.appendChild(el('div', { class: 'card fade-in' }, [
      el('div', { class: 'card-title', text: '📖 Self-Study by Subject' }),
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
      el('div', { class: 'card-title', text: '✅ Attendance Breakdown' }),
      el('div', { class: 'row', style: 'gap:24px;flex-wrap:wrap' }, [
        el('div', {}, [
          el('h4', { text: 'By Type (minutes)' }),
          el('table', {}, [
            el('tbody', {}, Object.entries(stats.attendance.by_type).map(([t, m]) =>
              el('tr', {}, [
                el('td', {}, el('span', { class: `tag tag-${t.toLowerCase()}`, text: t })),
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
              el('tr', {}, [el('td', {}, el('span', { class: 'tag tag-absent', text: 'Absent' })), el('td', { text: stats.attendance.absent })])
            ])
          ])
        ])
      ])
    ]));
  }

  // Self-study status
  if (stats.self_study.status_counts) {
    c.appendChild(el('div', { class: 'card fade-in' }, [
      el('div', { class: 'card-title', text: '📊 Self-Study Status' }),
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
      el('div', { class: 'card-title', text: '📝 Exams by Subject' }),
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
        el('div', { class: 'card-title', text: '🎯 Exam Scores' }),
        scoreGrid
      ]));
    }

    // Score by subject
    if (examScores.by_subject && Object.keys(examScores.by_subject).length > 0) {
      c.appendChild(el('div', { class: 'card fade-in' }, [
        el('div', { class: 'card-title', text: '📈 Scores by Subject' }),
        el('table', {}, [
          el('thead', {}, el('tr', {}, [
            el('th', { text: 'Subject' }), el('th', { text: 'Scores' }), el('th', { text: 'Average' })
          ])),
          el('tbody', {}, Object.entries(examScores.by_subject).map(([name, scores]) => {
            const avg = scores.length > 0 ? (scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
            return el('tr', {}, [
              el('td', { text: name }),
              el('td', { text: scores.map(s => s + '/20').join(', ') }),
              el('td', { text: scores.length > 0 ? fmt(avg, 1) + '/20' : '—' })
            ]);
          }))
        ])
      ]));
    }

    // Attendance ↔ Score impact. The backend has computed this for a
    // while (attendance_score_impact in /stats) but the frontend never
    // rendered it — a fully working feature that was invisible.
    const attImpact = stats.attendance_score_impact || {};
    const impactEntries = Object.entries(attImpact).filter(([, v]) => v.avg_score_when_present !== null || v.avg_score_when_absent !== null);
    if (impactEntries.length > 0) {
      c.appendChild(el('div', { class: 'card fade-in' }, [
        el('div', { class: 'card-title', text: '🎯 Attendance Impact on Scores' }),
        el('div', { class: 'text-dim text-sm mb-8', text: 'Average exam score on days you were present vs. absent, per subject.' }),
        el('table', {}, [
          el('thead', {}, el('tr', {}, [
            el('th', { text: 'Subject' }), el('th', { text: 'Avg. When Present' }), el('th', { text: 'Avg. When Absent' }), el('th', { text: 'Difference' })
          ])),
          el('tbody', {}, impactEntries.map(([name, v]) => el('tr', {}, [
            el('td', { text: name }),
            el('td', { text: v.avg_score_when_present !== null ? `${v.avg_score_when_present}/20 (${v.present_count})` : '—' }),
            el('td', { text: v.avg_score_when_absent !== null ? `${v.avg_score_when_absent}/20 (${v.absent_count})` : '—' }),
            el('td', {}, v.difference !== null ? el('span', { style: `color:${v.difference >= 0 ? 'var(--green)' : 'var(--red)'};font-weight:700`, text: `${v.difference >= 0 ? '+' : ''}${v.difference}` }) : '—')
          ])))
        ])
      ]));
    }
  }

  // ═══════════════════════════════════════════
  // CHARTS — server-rendered seaborn images (replaces the old
  // Chart.js/canvas approach). Much simpler client-side: no chart
  // instances, no canvas ids, no setTimeout races — just <img> tags
  // pointing at /api/<profile>/charts/<id>, which the backend renders
  // fresh on every request styled to match the app's neon-dark theme.
  // ═══════════════════════════════════════════
  c.appendChild(el('div', { class: 'card fade-in' }, [
    el('div', { class: 'card-title', text: '📊 Visual Analytics' }),
    el('div', { class: 'text-dim text-sm', text: 'Rendered server-side with seaborn — refreshes each time you open this page.' })
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
    self_study_by_subject: 'Self-Study Distribution', daily_study_hours: 'Daily Study Hours',
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
    { label: 'Total Self-Study Hours', value: stats.self_study.total_hours + 'h' },
    { label: 'Study Days Logged', value: Object.keys(stats.self_study.by_date || {}).length },
    { label: 'Avg Daily Study', value: stats.self_study.total_hours > 0 && Object.keys(stats.self_study.by_date || {}).length > 0 ? fmt(stats.self_study.total_hours / Object.keys(stats.self_study.by_date).length, 1) + 'h' : '—' },
    { label: 'Unique Subjects Studied', value: Object.keys(stats.self_study.by_subject || {}).length },
    { label: 'Attendance Rate', value: stats.attendance.total_events > 0 ? fmt(stats.attendance.present / stats.attendance.total_events * 100, 0) + '%' : '—' },
    { label: 'Present Count', value: stats.attendance.present },
    { label: 'Partial Count', value: stats.attendance.partial },
    { label: 'Absent Count', value: stats.attendance.absent },
    { label: 'Exams Total', value: stats.exams.total },
    { label: 'Exams Completed', value: stats.exams.done },
    { label: 'Exams Missed', value: stats.exams.missed },
    { label: 'Events Total', value: stats.events.total },
    { label: 'Events Done', value: stats.events.done },
    { label: 'Avg Difficulty', value: stats.self_study.avg_difficulty && Object.keys(stats.self_study.avg_difficulty).length > 0 ? fmt(Object.values(stats.self_study.avg_difficulty).reduce((a,b)=>a+b,0) / Object.keys(stats.self_study.avg_difficulty).length, 1) + '/10' : '—' },
    { label: 'Highest Score', value: stats.exam_scores?.highest ? stats.exam_scores.highest + '/20' : '—' },
    { label: 'Lowest Score', value: stats.exam_scores?.lowest ? stats.exam_scores.lowest + '/20' : '—' },
    { label: 'Score Average', value: stats.exam_scores?.avg_score ? fmt(stats.exam_scores.avg_score, 1) + '/20' : '—' },
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
    el('div', { class: 'card-title', text: '📋 All Statistics' }),
    counterGrid
  ]));
}

// ═══════════════════════════════════════════
// PROGRESSION
// ═══════════════════════════════════════════
async function renderProgression(c) {
  c.innerHTML = '';
  c.appendChild(el('h2', { style: 'margin-bottom:16px', text: '🏆 Progression' }));

  c.appendChild(el('div', { class: 'card fade-in' }, [
    el('div', { class: 'card-title', text: '🏆 Progression & Cosmetics' }),
    gamification ? el('div', {}, [
      renderXpCard(),
      el('div', { class: 'text-sm text-dim mt-16 mb-8', text: 'Themes unlock as you level up. Locked ones show the level you need — keep studying!' }),
      el('div', { class: 'text-sm text-dim mb-8', text: 'Click a locked theme to preview it live — nothing is spent, and a banner lets you exit back to your current theme.' }),
      el('div', { class: 'stats-grid', style: 'grid-template-columns:repeat(auto-fill,minmax(140px,1fr))' },
        (gamification.theme_catalog || []).map(t => {
          const isUnlocked = (gamification.unlocked_themes || []).includes(t.id);
          const isActive = document.documentElement.getAttribute('data-theme') === t.id && !previewingTheme;
          const isPreviewing = previewingTheme === t.id;
          return el('div', {
            class: 'stat-card',
            style: `cursor:pointer;opacity:${isUnlocked ? 1 : .7};${isActive || isPreviewing ? 'outline:2px solid var(--accent)' : ''}`,
            onclick: () => {
              if (isUnlocked) { exitThemePreview(); setTheme(t.id); render(); }
              else { startThemePreview(t.id); render(); }
            }
          }, [
            el('div', { style: 'font-size:1.4rem', text: isUnlocked ? '🎨' : '👁' }),
            el('div', { class: 'stat-label', style: 'margin-top:6px;font-weight:600', text: t.label }),
            el('div', { class: 'text-dim', style: 'font-size:10px', text: isUnlocked ? (isActive ? 'Active' : 'Unlocked') : (isPreviewing ? 'Previewing' : `Preview • Lv ${t.level}`) })
          ]);
        })
      )
    ]) : el('div', { class: 'text-dim text-sm', text: gamificationError ? `Progression unavailable: ${gamificationError}` : 'Progression will appear after your first check-in.' })
  ]));

  c.appendChild(el('div', { class: 'card fade-in' }, [
    el('div', { class: 'card-title', text: '✳️ Weekly Quests' }),
    renderQuestsCard()
  ]));

  c.appendChild(el('div', { class: 'card fade-in' }, [
    el('div', { class: 'card-title', text: '🎖 Achievements' }),
    el('div', { class: 'text-sm text-dim mb-8', text: "Bachelor's I-III → Master's I-III → PhD I-III → Laureate. Each tier earns more XP." }),
    renderBadgesGrid()
  ]));

  c.appendChild(el('div', { class: 'card fade-in' }, [
    el('div', { class: 'card-title', text: '🎓 Subject & Skill Mastery' }),
    renderMasteryGrid()
  ]));
}

// ═══════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════
async function renderSettings(c) {
  const cfg = cachedConfig || { subjects: [], skills: [], academic_years: [] };

  c.innerHTML = '';
  c.appendChild(el('h2', { style: 'margin-bottom:16px', text: '⚙️ Settings' }));

  // Profile management
  c.appendChild(el('div', { class: 'card fade-in' }, [
    el('div', { class: 'card-title', text: '👤 Profile Management' }),
    el('div', { class: 'row', style: 'gap:8px;margin-bottom:12px' }, [
      el('button', { class: 'btn', text: 'New Profile', onclick: showProfileModal }),
      el('button', { class: 'btn btn-outline', text: 'Export Profile', onclick: exportProfile }),
      el('button', { class: 'btn btn-danger', text: 'Delete Current', onclick: deleteCurrentProfile }),
      el('button', { class: 'btn btn-outline', text: 'Wipe Data', onclick: wipeData })
    ])
  ]));

  // Preferences — attendance default mode + ML prediction toggle
  c.appendChild(el('div', { class: 'card fade-in' }, [
    el('div', { class: 'card-title', text: '🎛 Preferences' }),
    el('label', { text: 'Attendance Default Mode' }),
    el('div', { class: 'text-dim text-sm mb-8', text: "Pick the kind of student you are. Past scheduled classes are then auto-registered as that status, so you only need to log the exceptions (the opposite status) by hand. Requires subjects to have an academic year and weekly schedule assigned." }),
    (() => {
      const sel = el('select', {}, [
        el('option', { value: 'manual', text: 'Manual — I\'ll mark every class myself' }),
        el('option', { value: 'mostly_present', text: "I'm mostly present — auto-fill Present, I'll log absences" }),
        el('option', { value: 'mostly_absent', text: "I'm mostly absent — auto-fill Absent, I'll log when I attend" })
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
      el('div', { class: 'text-dim text-sm mb-8', text: 'Uses a small model trained on your own study history to predict exam scores and flag at-risk subjects. Some people find a running "predicted score" stressful — turn it off any time and you\'ll still get attendance/spaced-repetition recommendations.' }),
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

  // Academic Years
  c.appendChild(el('div', { class: 'card fade-in' }, [
    el('div', { class: 'card-title', text: '📅 Academic Years' }),
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
        el('button', { class: 'btn btn-sm btn-danger', text: 'Delete Year', onclick: async () => {
          if (!confirm(`Delete "${y.label}"? Subjects assigned to it will keep their date but lose the year link.`)) return;
          await api(`/api/${currentProfile}/years/${y.id}`, { method: 'DELETE' });
          await loadConfig(); render();
        } })
      ]),
      el('div', { class: 'row', style: 'gap:20px;flex-wrap:wrap;align-items:flex-start' }, [
        // Exam periods — during these dates, ONLY exams show on the
        // Timetable for subjects assigned to this year; regular lessons
        // are hidden. Exams can still be added outside these periods too.
        el('div', { style: 'flex:1;min-width:260px' }, [
          el('div', { style: 'font-weight:600;font-size:var(--font-s);margin-bottom:6px', text: '📝 Exam Periods' }),
          el('div', { class: 'text-dim text-sm mb-8', text: 'Only exams appear on the Timetable during these dates — lessons are hidden.' }),
          (y.exam_periods || []).length ? el('div', { class: 'mb-8' }, (y.exam_periods || []).map(p => el('div', { class: 'row', style: 'justify-content:space-between;padding:4px 0' }, [
            el('span', { class: 'text-sm', text: `${p.label}: ${p.start_date} → ${p.end_date}` }),
            el('button', { class: 'btn btn-sm btn-danger', text: '✕', onclick: async () => {
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
        // Vacation weeks — 0 lesson hours during these dates for subjects
        // assigned to this year, but skills CAN still be scheduled then
        // (self-study/self-skilling keeps working over breaks).
        el('div', { style: 'flex:1;min-width:260px' }, [
          el('div', { style: 'font-weight:600;font-size:var(--font-s);margin-bottom:6px', text: '🏖 Vacation Weeks' }),
          el('div', { class: 'text-dim text-sm mb-8', text: 'Lessons are hidden during these dates. Skills can still be scheduled.' }),
          (y.vacation_weeks || []).length ? el('div', { class: 'mb-8' }, (y.vacation_weeks || []).map(v => el('div', { class: 'row', style: 'justify-content:space-between;padding:4px 0' }, [
            el('span', { class: 'text-sm', text: `${v.label}: ${v.start_date} → ${v.end_date}` }),
            el('button', { class: 'btn btn-sm btn-danger', text: '✕', onclick: async () => {
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
  ]));

  // Subjects
  c.appendChild(el('div', { class: 'card fade-in' }, [
    el('div', { class: 'card-title', text: '📚 Subjects' }),
    el('div', { class: 'row', style: 'gap:8px;margin-bottom:12px;flex-wrap:wrap' }, [
      el('input', { id: 'newSubName', placeholder: 'Subject name', style: 'width:180px' }),
      el('input', { id: 'newSubColor', type: 'color', value: '#4a90d9', style: 'width:40px' }),
      el('input', { id: 'newSubDiff', type: 'number', min: '1', max: '10', value: '5', style: 'width:74px', title: 'Baseline difficulty (1 easiest, 10 hardest) — used as the default starting point when rating a session, and as a stable signal for exam-score predictions. Each individual study session logs its own difficulty separately.' }),
      // Year field was missing here entirely — subjects created via
      // Settings could never be assigned a year_id, so the Timetable's
      // year filter always had nothing to match against.
      el('select', { id: 'newSubYear', style: 'width:auto' }, [
        el('option', { value: '', text: 'No year' }),
        ...cfg.academic_years.map(y => el('option', { value: y.id, text: y.label }))
      ]),
      el('select', { id: 'newSubDay', style: 'width:auto' }, [
        el('option', { value: '', text: 'No schedule' }),
        el('option', { value: 'monday', text: 'Monday' }),
        el('option', { value: 'tuesday', text: 'Tuesday' }),
        el('option', { value: 'wednesday', text: 'Wednesday' }),
        el('option', { value: 'thursday', text: 'Thursday' }),
        el('option', { value: 'friday', text: 'Friday' }),
        el('option', { value: 'saturday', text: 'Saturday' }),
        el('option', { value: 'sunday', text: 'Sunday' })
      ]),
      el('select', { id: 'newSubType', style: 'width:auto' }, [
        el('option', { value: 'C', text: 'Cours (C)' }),
        el('option', { value: 'TD', text: 'TD' }),
        el('option', { value: 'TP', text: 'TP' })
      ]),
      el('input', { id: 'newSubStart', type: 'time', value: '08:00', style: 'width:120px' }),
      el('input', { id: 'newSubEnd', type: 'time', value: '09:30', style: 'width:120px' }),
      el('button', { class: 'btn btn-sm', text: 'Add Subject', onclick: addSubject })
    ]),
    el('div', { class: 'text-dim text-sm mb-8', text: "The 1-10 spinner sets this subject's baseline difficulty (used for predictions and as your session-rating default) — it doesn't replace per-session difficulty, which you still rate individually every time you log a session. Use the filter below to switch which year is shown, and scroll through the subject list when there are many." }),
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
      const subjectsToShow = subjectListYearFilter === 'all'
        ? cfg.subjects
        : cfg.subjects.filter(s => s.year_id === subjectListYearFilter);
      return subjectsToShow.length ? el('div', { style: 'max-height:320px;overflow:auto;border:1px solid var(--border);border-radius:var(--r-sm)' }, [
        el('table', { style: 'margin:0' }, [
          el('thead', {}, el('tr', {}, [el('th', { text: 'Color' }), el('th', { text: 'Name' }), el('th', { text: 'Diff' }), el('th', { text: 'Year' }), el('th', { text: 'Schedule' }), el("th", { text: "" })])),
          el('tbody', {}, subjectsToShow.map(s => {
        const yr = cfg.academic_years.find(y => y.id === s.year_id);
        return el('tr', {}, [
          el('td', {}, el('div', { style: `width:20px;height:20px;border-radius:4px;background:${s.color}` })),
          el('td', { text: s.name }),
          el('td', { text: s.difficulty + '/10' }),
          el('td', { class: 'text-sm text-dim', text: yr ? yr.label : '—' }),
          el('td', { class: 'text-sm text-dim', text: (s.schedule || []).map(sc => `${sc.day} ${sc.type}`).join(', ') || '—' }),
          el('td', {}, el('button', { class: 'btn btn-sm btn-danger', text: '✕', onclick: async () => {
            if (!dangerConfirm(`Delete "${s.name}"? This PERMANENTLY deletes every self-study session, attendance record, exam, and file linked to this subject too — including all mastery progress earned for it. This cannot be undone.`)) return;
            await api(`/api/${currentProfile}/subjects/${s.id}`, { method: 'DELETE' });
            await loadConfig(); render();
          } }))
        ]);
          }))
        ])
      ]) : el('div', { class: 'text-dim text-sm', text: subjectListYearFilter === 'all' ? 'No subjects yet.' : 'No subjects match this year filter.' });
    })()
  ]));

  // Skills
  c.appendChild(el('div', { class: 'card fade-in' }, [
    el('div', { class: 'card-title', text: '🎯 Skills' }),
    el('div', { class: 'row', style: 'gap:8px;margin-bottom:12px;flex-wrap:wrap' }, [
      el('input', { id: 'newSkillName', placeholder: 'Skill name', style: 'width:180px' }),
      el('input', { id: 'newSkillCat', placeholder: 'Category', style: 'width:120px' }),
      el('button', { class: 'btn btn-sm', text: 'Add Skill', onclick: addSkill })
    ]),
    cfg.skills.length ? el('div', { style: 'max-height:320px;overflow:auto;border:1px solid var(--border);border-radius:var(--r-sm)' }, [
      el('table', { style: 'margin:0' }, [
        el('thead', {}, el('tr', {}, [el('th', { text: 'Name' }), el('th', { text: 'Category' }), el("th", { text: "" })])),
        el('tbody', {}, cfg.skills.map(s => el('tr', {}, [
          el('td', { text: s.name }),
          el('td', { class: 'text-dim', text: s.category || '—' }),
          el('td', {}, el('button', { class: 'btn btn-sm btn-danger', text: '✕', onclick: async () => {
            if (!dangerConfirm(`Delete "${s.name}"? This PERMANENTLY deletes every self-study session and file linked to this skill too — including all mastery progress earned for it. This cannot be undone.`)) return;
            await api(`/api/${currentProfile}/skills/${s.id}`, { method: 'DELETE' });
            await loadConfig(); render();
          } }))
        ])))
      ])
    ]) : el('div', { class: 'text-dim text-sm', text: 'No skills yet.' })
  ]));

  // Files browser
  c.appendChild(el('div', { class: 'card fade-in' }, [
    el('div', { class: 'card-title', text: '📁 Subject/Skill Files' }),
    el('div', { class: 'text-dim text-sm', text: 'Upload and manage files for each subject and skill in their respective folders under saves/_files/.' }),
    el('div', { class: 'mt-16', id: 'filesList' })
  ]));

  if (pendingSettingsScroll === 'progression') {
    pendingSettingsScroll = null;
    setTimeout(() => {
      const target = document.getElementById('progressionCard');
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 0);
  }
  renderFilesList();
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

async function addSubject() {
  const name = $('#newSubName').value.trim();
  const color = $('#newSubColor').value;
  const diff = parseInt($('#newSubDiff').value) || 5;
  const yearId = $('#newSubYear') ? $('#newSubYear').value : '';
  const day = $('#newSubDay')?.value || '';
  const type = $('#newSubType')?.value || 'C';
  const start = $('#newSubStart')?.value || '';
  const end = $('#newSubEnd')?.value || '';
  if (!name) { alert('Enter name'); return; }
  if ((day || start || end) && (!day || !start || !end)) { alert('Pick a day, start, and end time for the schedule slot'); return; }
  try {
    await api(`/api/${currentProfile}/subjects`, { method: 'POST', body: JSON.stringify({
      name, color, difficulty: diff, year_id: yearId,
      schedule: day ? [{ day, type, start, end }] : []
    }) });
    $('#newSubName').value = '';
    await loadConfig(); render();
  } catch (e) { alert(e.message); }
}

async function addSkill() {
  const name = $('#newSkillName').value.trim();
  const cat = $('#newSkillCat').value.trim();
  if (!name) { alert('Enter name'); return; }
  try {
    await api(`/api/${currentProfile}/skills`, { method: 'POST', body: JSON.stringify({ name, category: cat, difficulty: 5 }) });
    $('#newSkillName').value = ''; $('#newSkillCat').value = '';
    await loadConfig(); render();
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
  // (POST) — see server.py. Frontend now calls the matching path+method.
  await api(`/api/${currentProfile}/wipe`, { method: 'POST' });
  cachedData = null;
  await loadData();
  render();
}

async function renderFilesList() {
  const container = $('#filesList');
  if (!container) return;
  const cfg = cachedConfig;
  if (!cfg) return;
  container.innerHTML = '';

  const allItems = [
    ...(cfg.subjects || []).map(s => ({ type: 'subject', id: s.id, name: s.name })),
    ...(cfg.skills || []).map(s => ({ type: 'skill', id: s.id, name: s.name }))
  ];

  for (const item of allItems) {
    let files = [];
    try {
      files = await api(`/api/${currentProfile}/files/${item.type}/${item.id}`);
    } catch (e) {}

    const fileList = el('div', { style: 'margin-bottom:8px' });
    files.forEach(f => {
      fileList.appendChild(el('div', { class: 'file-item' }, [
        el('span', { class: 'file-icon', text: '📄' }),
        el('span', { class: 'flex-1 truncate', text: f.name }),
        el('span', { class: 'text-dim text-sm', text: Math.round(f.size/1024) + 'KB' }),
        el('button', { class: 'btn btn-sm btn-outline', text: '📥', onclick: () => window.open(`/api/${currentProfile}/files/${item.type}/${item.id}/${f.name}`) }),
        el('button', { class: 'btn btn-sm btn-danger', text: '✕', onclick: async () => {
          await api(`/api/${currentProfile}/files/${item.type}/${item.id}/${f.name}`, { method: 'DELETE' });
          renderFilesList();
        } })
      ]));
    });

    // Upload button
    const fileInput = el('input', { type: 'file', style: 'display:none', onchange: async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const formData = new FormData();
      formData.append('file', file);
      try {
        await fetch(`/api/${currentProfile}/files/${item.type}/${item.id}`, { method: 'POST', body: formData });
        renderFilesList();
      } catch (err) { alert('Upload failed: ' + err.message); }
    }});
    const uploadBtn = el('button', { class: 'btn btn-sm btn-outline', text: '📤 Upload', onclick: () => fileInput.click() });

    container.appendChild(el('div', { style: 'margin-bottom:12px' }, [
      el('div', { style: 'font-weight:600;margin-bottom:4px', text: `${item.name} (${item.type})` }),
      fileList,
      fileInput, uploadBtn
    ]));

  }

  if (allItems.length === 0) {
    container.appendChild(el('div', { class: 'text-dim text-sm', text: 'Add subjects or skills first to upload files.' }));
  }
}

// ── Init ──
async function init() {
  await loadProfiles();
  if (currentProfile) {
    await loadConfig();
    try { await api(`/api/${currentProfile}/attendance/autofill`, { method: 'POST' }); } catch (e) { /* non-fatal */ }
    await loadData();
    await loadGamification({ showCheckIn: true });
    lastKnownLevel = gamification?.level ?? null;
    lastKnownXp = gamification?.xp ?? null;
  }
  loadTheme();
  updateTopLevelBar();
  render();
}

init();
