/* Cultivar — Frontend */
// ═══════════════════════════════════════════
// ── VERSION ── Bump this whenever you ship a meaningful change. This
// is the ONE place to edit it on the frontend — it's what the topbar's
// "v..." sub-label (see index.html's #topLevelBar area / logo-sub span)
// and any future about/settings display should read from. The backend
// has its own matching APP_VERSION constant near the top of server.py;
// the two are edited independently but should generally be bumped
// together when you ship a change that touches both.
// ═══════════════════════════════════════════
const APP_VERSION = '2.3.2';
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
let pendingFileExplorerOpen = null; // {ref_type, ref_id} — jump the Files page straight to an item, set from Settings' 📁 buttons
let subjectListYearFilter = 'all';
let activeTimer = null; // last known server timer state — refreshed on load/navigation/actions, not polled

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

// Timetable calendar vertical scale. pxPerHour normally sits at
// CAL_BASE_PX_PER_HOUR; renderCalendar() grows it (up to
// CAL_MAX_PX_PER_HOUR) whenever the current week has a real block
// shorter than CAL_MIN_BLOCK_PX would need at the base scale — this is
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
    // Edit Self-Study note field) show up blank even though the data
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
// Lesson/attendance type codes stay "C"/"TD"/"TP" in stored data (no
// migration needed), but display everywhere as Lesson / Practical Work
// / Lab. Use lessonTypeLabel(code) anywhere a raw code would otherwise
// be shown to the person.
const LESSON_TYPE_LABELS = { C: 'Lesson', TD: 'Practical Work', TP: 'Lab' };
function lessonTypeLabel(code) { return LESSON_TYPE_LABELS[code] || code; }
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
  const mc = $('#modalContent');
  // A previous modal (e.g. the PDF/video viewer) may have left sizing
  // classes or a still-playing <video>/<audio> behind — always reset
  // to a clean slate before mounting new content, rather than only
  // doing that cleanup on explicit close.
  mc.querySelectorAll('video, audio').forEach(m => { try { m.pause(); m.removeAttribute('src'); m.load(); } catch (_) {} });
  mc.className = 'modal';
  mc.innerHTML = '';
  mc.appendChild(content);
  $('#modalOverlay').classList.add('show');
}
function closeModal(e) {
  if (e && e.target !== e.currentTarget) return;
  $('#modalOverlay').classList.remove('show');
  const mc = $('#modalContent');
  // Hiding the overlay is purely visual — a <video>/<audio> element left
  // inside #modalContent keeps playing (and keeps making sound) until
  // its node is actually removed, which used to only happen the NEXT
  // time a modal opened. Stop and clear it immediately on close instead.
  mc.querySelectorAll('video, audio').forEach(m => { try { m.pause(); m.removeAttribute('src'); m.load(); } catch (_) {} });
  mc.className = 'modal';
  mc.innerHTML = '';
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
  updateNerdsBadge();
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
  // updateNerdsBadge() runs on basically every data refresh — only
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
  const nerdsLine = nerdsEarned > 0 ? ` · +${nerdsEarned} 🪙` : '';
  const toast = el('div', { class: 'xp-toast' }, [
    el('div', { class: 'xp-toast-icon', text: '🎉' }),
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

function renderMasteryGrid(filterType, emptyHint) {
  if (!gamification || !gamification.mastery) return el('div', { class: 'text-dim text-sm', text: gamificationError ? 'Mastery could not be loaded.' : 'No mastery yet.' });
  const items = filterType ? gamification.mastery.filter(m => m.type === filterType) : gamification.mastery;
  if (!items.length) return el('div', { class: 'text-dim text-sm', text: emptyHint || 'Nothing here yet.' });
  return el('div', { class: 'stats-grid', style: 'grid-template-columns:repeat(auto-fill,minmax(150px,1fr))' },
    items.map(m => {
      const color = m.tier_name ? TIER_COLORS[m.tier_name] : 'var(--border)';
      return el('div', { class: 'stat-card', style: `border-color:${color}` }, [
        el('div', { style: 'font-size:1.2rem', text: m.type === 'skill' ? '🎯' : (m.type === 'category' ? '🗂' : '📚') }),
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
  lastKnownNerds = null;
  // Reset live-sync bookkeeping for the new profile — otherwise the
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
// one needs to disappear) — but mastery lives in `gamification`, a
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
      case 'botanarium': await renderBotanarium(c); break;
      case 'files': await renderFiles(c); break;
      case 'inventory': await renderInventory(c); break;
      case 'stats': await renderStats(c); break;
      case 'progression': await renderProgression(c); break;
      case 'finance': await renderFinance(c); break;
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
// "is a timer running/paused right now, and what does it look like" —
// refreshed on app load, on switching profiles, and right after this
// window's own start/pause/resume/stop actions (see
// refreshActiveTimerFromServer below).

async function refreshActiveTimerFromServer() {
  try {
    const resp = await api(`/api/${currentProfile}/timer/active`);
    activeTimer = resp.timer;
  } catch (e) { /* transient hiccup — the next explicit refresh will catch up */ }
}

// ── Live-ticking numbers (both the mini badge and, if mounted, the
// big Dashboard display) — purely a local per-second repaint computed
// from the last-known server state + wall-clock time. No network call. ──
function paintTimerNumbers() {
  const t = activeTimer;
  const displayEl = document.getElementById('timerDisplay');
  if (displayEl) {
    if (!t) {
      displayEl.textContent = '00:00:00';
    } else if (t.mode === 'pomodoro') {
      if (t.status === 'awaiting_rating' || !t.phase_ends_at) {
        displayEl.textContent = '00:00:00';
      } else {
        const remaining = Math.max(0, (Date.parse(t.phase_ends_at) - Date.now()) / 1000);
        displayEl.textContent = formatClock(remaining);
      }
    } else {
      const openExtra = t.open_segment_since ? Math.max(0, (Date.now() - Date.parse(t.open_segment_since)) / 1000) : 0;
      const elapsed = (t.accumulated_seconds || 0) + openExtra;
      displayEl.textContent = formatClock(elapsed);
      const statusEl = document.getElementById('timerStatusDiv');
      if (statusEl && t.status === 'running' && t.planned_minutes > 0 && elapsed / 60 >= t.planned_minutes) {
        statusEl.innerHTML = '<span style="color:var(--green)">✓ Planned time reached!</span>';
      }
    }
  }
  updateMiniTimerBadge();
}

// ── Mini timer badge (topbar) ──
// Keeps a running/paused/awaiting-rating session visible in the topbar
// on every page except the Dashboard (which already shows the full
// widget) — and now reflects whichever device is actually driving the
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
      icon = '🎉'; timeText = '00:00'; label = 'Done — tap to rate';
    } else {
      icon = t.phase === 'work' ? '🍅' : (t.phase === 'long' ? '🌴' : '☕');
      const remaining = Math.max(0, (Date.parse(t.phase_ends_at) - Date.now()) / 1000);
      timeText = formatClock(remaining);
      label = t.phase === 'work' ? `Block ${t.phase_block}/${t.pomodoro_total_blocks}` : 'Break';
    }
  } else {
    const openExtra = t.open_segment_since ? Math.max(0, (Date.now() - Date.parse(t.open_segment_since)) / 1000) : 0;
    timeText = formatClock((t.accumulated_seconds || 0) + openExtra);
    paused = t.status === 'paused';
    icon = paused ? '⏸' : '⏱';
    label = paused ? 'Paused' : 'Studying';
  }
  badge.classList.toggle('paused', paused);
  badge.appendChild(el('span', { text: icon }));
  badge.appendChild(el('span', { class: 'mini-timer-time', text: timeText }));
  badge.appendChild(el('span', { class: 'mini-timer-label', text: label }));
}

function renderTimerWidget() {
  const display = el('div', { class: 'timer-display', id: 'timerDisplay', text: '00:00:00' });
  const phaseLabel = el('div', { class: 'text-center text-dim text-sm', style: 'min-height:20px;font-weight:600' });
  const subjectSel = el('select', {}, [
    el('option', { value: '', text: 'Select subject...' }),
    ...(cachedConfig?.subjects || []).map(s => el('option', { value: s.id, text: s.name })),
    ...(cachedConfig?.skills || []).map(s => el('option', { value: 'skill_' + s.id, text: `[Skill] ${s.name}` }))
  ]);
  const plannedInput = el('input', { type: 'number', value: '30', min: '1', placeholder: 'Planned minutes' });
  const statusDiv = el('div', { class: 'text-center text-dim text-sm', id: 'timerStatusDiv', style: 'min-height:24px' });
  const startBtn = el('button', { class: 'btn btn-success', text: '▶ Start', onclick: () => startFreeTimer() });
  const pauseBtn = el('button', { class: 'btn btn-amber hidden', text: '⏸ Pause', onclick: () => pauseFreeTimer() });
  const resumeBtn = el('button', { class: 'btn btn-success hidden', text: '▶ Resume', onclick: () => resumeFreeTimer() });
  const stopBtn = el('button', { class: 'btn btn-danger hidden', text: '⏹ Stop & Save', onclick: () => stopActiveTimer() });
  const cancelBtn = el('button', { class: 'btn btn-outline hidden', text: '✕ Cancel', onclick: () => cancelActiveTimer() });

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
  const pomoCancelBtn = el('button', { class: 'btn btn-outline hidden', text: '✕ Cancel', onclick: () => cancelActiveTimer() });

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
  const modePomoBtn = el('button', { class: 'btn btn-sm btn-outline', text: '🍅 Pomodoro', onclick: () => setIdleModePreview('pomodoro') });
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

  // Local-only mode PREVIEW — only meaningful while idle (no timer
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
    // rating modal at all — the server recomputes the real, final
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
      catch (e) { /* non-fatal — nothing meaningful to lose */ }
      activeTimer = null;
      await refreshActiveTimerFromServer();
      applyStateToDOM();
      statusDiv.innerHTML = '<span class="text-dim">No study time logged — nothing saved.</span>';
      setTimeout(() => { statusDiv.textContent = ''; }, UI_STATUS_MESSAGE_CLEAR_MS);
      return;
    }
    showSessionRatingModal(estMinutes, t, async (rating) => {
      try {
        const resp = await api(`/api/${currentProfile}/timer/${t.id}/stop`, {
          method: 'POST', body: JSON.stringify({ difficulty: rating.difficulty, self_study_status: rating.status, note: rating.note })
        });
        statusDiv.innerHTML = `<span style="color:var(--green)">✓ Saved: ${resp.actual_minutes}min${resp.day_buckets.length > 1 ? ` across ${resp.day_buckets.length} days` : ''}</span>`;
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

  // ── Paint the widget's DOM to match the current `activeTimer`
  // (module-global) — called on mount and after every local action. ──
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
    // Something is active — from THIS device or another. Mode tabs are
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
        phaseLabel.textContent = '🎉 Pomodoro complete — press Stop & Save to rate it!';
      } else {
        pomoSkipBtn.classList.remove('hidden');
        const icon = t.phase === 'work' ? '🍅' : (t.phase === 'long' ? '🌴' : '☕');
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

// Describes a self-study record's FULL session for a Timetable block's
// tooltip — used for every block belonging to that session (study or
// break segment alike), so hovering any one piece reads like hovering
// the whole functional unit rather than just that slice of it.
function sessionTooltip(r, label) {
  const segments = (r.segments || []).filter(s => s.start && s.end);
  label = label || 'Self-Study';
  if (!segments.length) {
    return `${label} — ${r.status} (${r.minutes}min)`;
  }
  const studyBlocks = segments.filter(s => s.type === 'study');
  const breakBlocks = segments.filter(s => s.type === 'break');
  const overallStart = segments.reduce((min, s) => s.start < min ? s.start : min, segments[0].start);
  const overallEnd = segments.reduce((max, s) => s.end > max ? s.end : max, segments[0].end);
  const breakMin = breakBlocks.reduce((sum, s) => sum + Math.max(0, timeToMinutes(s.end) - timeToMinutes(s.start)), 0);
  const parts = [`${label} — ${r.status}`, `${overallStart}–${overallEnd}`, `${r.minutes}min studied`];
  if (breakMin > 0) parts.push(`${breakMin}min break (${breakBlocks.length} block${breakBlocks.length === 1 ? '' : 's'})`);
  if (studyBlocks.length > 1) parts.push(`${studyBlocks.length} study blocks`);
  return parts.join(' · ');
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
        const attRecord = (d.attendance || []).find(a =>
          a.subject_id === sub.id && a.date === dateStr && a.type === schType &&
          (a.status === 'absent' || a.status === 'teacher_absent')
        );
        if (attRecord && attRecord.status === 'absent') return;
        // Teacher absence isn't the student's absence — the lesson is
        // kept visible (not hidden) but styled as incomplete/barred, the
        // same visual language as a break block, so it still reads as
        // "this slot existed" without looking like a normal completed
        // lesson.
        const isTeacherAbsent = !!(attRecord && attRecord.status === 'teacher_absent');
        const start = timeToMinutes(sch.start || '08:00');
        const end = timeToMinutes(sch.end || sch.start || '09:00');
        timed.push({
          start, end: Math.max(end, start + 15),
          label: isTeacherAbsent ? `${sub.name} (Teacher Absent)` : `${sub.name}`, sub: lessonTypeLabel(schType),
          cls: isTeacherAbsent ? 'teacher-absent' : schType.toLowerCase(),
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
    //
    // Timer/Pomodoro sessions additionally carry `segments` — the
    // actual wall-clock study/break sub-blocks recorded while the
    // timer ran (now tracked server-side as the shared timer's own
    // segments — see server.py's timer model). When present,
    // each segment becomes its own timed block (study blocks styled
    // normally, break blocks styled distinctly in amber), all sharing
    // a `groupKey` of the record's id so hovering any one of them can
    // highlight the whole session as a single functional unit even
    // though they're drawn as separate rectangles. Manual entries (no
    // segments) fall back to the single-block behavior as before.
    (d.self_study || []).forEach(r => {
      if (r.date !== dateStr) return;
      const subj = subjById[r.subject_id];
      const skill = skillById[r.skill_id];
      const label = subj ? subj.name : (skill ? skill.name : 'Self-Study');
      const segments = (r.segments || []).filter(s => s.start && s.end && timeToMinutes(s.end) > timeToMinutes(s.start));

      if (segments.length) {
        segments.forEach((seg, i) => {
          const start = timeToMinutes(seg.start);
          const end = timeToMinutes(seg.end);
          const isBreak = seg.type === 'break';
          timed.push({
            // Use the segment's REAL start/end — no artificial minimum
            // duration here. Segments are drawn back-to-back (a break
            // immediately followed by more study), so padding one of
            // them past its true end pushes it into the next segment's
            // real time slot, which is what caused them to visually
            // overlap/collide. Short segments are instead handled by
            // renderCalendar() dynamically growing the whole week's
            // pixel-per-hour scale so every real block gets a readable
            // minimum height without eating into its neighbor.
            start, end,
            label: isBreak ? '☕ Break' : `📖 ${label}`,
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
          label: `📖 ${label}`, sub: r.status,
          cls: 'selfstudy', color: subj?.color || skill?.color || null,
          kind: 'selfstudy', ref: r, groupKey: r.id, sessionLabel: label
        });
      }
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

    // pxPerHour normally sits at CAL_BASE_PX_PER_HOUR, but grows for the
    // WHOLE week's grid whenever any real block (most commonly a short
    // Pomodoro break, or a trailing study segment) is shorter than
    // CAL_MIN_BLOCK_PX would need at the base scale. This keeps every
    // block readable at its true, non-overlapping time position instead
    // of the old approach of padding short blocks past their real end
    // time, which pushed them into the next block's slot and made
    // same-session study/break blocks visually collide. Capped at
    // CAL_MAX_PX_PER_HOUR so one freak 1-2 minute entry can't blow the
    // whole calendar out to an unusable height — the trade-off beyond
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
      // top of each other — a day with several things at once used to
      // render them all at full width, hiding all but the last one.
      assignLanes(dayData[i].timed).forEach(({ ev, lane, laneCount }) => {
        const top = Math.max(0, ((ev.start - rangeStart) / totalMins) * totalHeight);
        // No height floor here on purpose: pxPerHour above is already
        // derived so the week's shortest real block lands at roughly
        // CAL_MIN_BLOCK_PX tall. Adding a floor on top of that would
        // re-introduce the original bug — a block rendering taller than
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
        // segment) — hovering any piece should read like hovering the
        // single functional block it represents.
        const tooltip = ev.groupKey ? sessionTooltip(ev.ref, ev.sessionLabel) : `${ev.label}${ev.sub ? ' — ' + ev.sub : ''} (${minutesToTime(ev.start)}–${minutesToTime(ev.end)})`;
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
        // Sibling-block hover highlighting — a session split into
        // several study/break rectangles should visually light up as
        // ONE unit on hover, even though each piece is a separate DOM
        // node. Grouped purely by groupKey (the self-study record id).
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

// Lets a subject have MORE than one weekly slot of the same type — e.g.
// a Lesson on both Monday and Friday. The backend already stores
// `schedule` as a plain list of {day,type,start,end} entries with no
// uniqueness constraint; this modal is what actually lets someone add
// a second (third, ...) slot instead of being limited to the single
// slot picked at subject creation.
function showManageScheduleModal(subject) {
  let slots = [...(subject.schedule || [])];

  function renderSlotsList() {
    if (!slots.length) return el('div', { class: 'text-dim text-sm mb-8', text: 'No weekly slots yet — add one below.' });
    return el('div', { class: 'mb-16' }, slots.map((sc, i) => el('div', {
      class: 'row', style: 'justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)'
    }, [
      el('span', { class: 'text-sm', text: `${sc.day[0].toUpperCase()}${sc.day.slice(1)} · ${lessonTypeLabel(sc.type)} · ${sc.start}–${sc.end}` }),
      el('button', { class: 'btn btn-sm btn-danger', text: '✕', onclick: () => { slots.splice(i, 1); rerender(); } })
    ])));
  }

  const daySel = el('select', {}, [
    el('option', { value: 'monday', text: 'Monday' }), el('option', { value: 'tuesday', text: 'Tuesday' }),
    el('option', { value: 'wednesday', text: 'Wednesday' }), el('option', { value: 'thursday', text: 'Thursday' }),
    el('option', { value: 'friday', text: 'Friday' }), el('option', { value: 'saturday', text: 'Saturday' }),
    el('option', { value: 'sunday', text: 'Sunday' })
  ]);
  const typeSel = el('select', {}, [
    el('option', { value: 'C', text: 'Lesson' }), el('option', { value: 'TD', text: 'Practical Work' }), el('option', { value: 'TP', text: 'Lab' })
  ]);
  const startInput = el('input', { value: '08:00' });
  const endInput = el('input', { value: '09:30' });

  let container;
  function rerender() {
    const fresh = buildContent();
    container.replaceWith(fresh);
    container = fresh;
  }

  function buildContent() {
    return el('div', {}, [
      el('div', { class: 'modal-header' }, [
        el('div', { class: 'modal-title', text: `Weekly Schedule — ${subject.name}` }),
        el('button', { class: 'modal-close', onclick: closeModal, text: '×' })
      ]),
      el('div', { class: 'text-dim text-sm mb-8', text: 'A subject can have several slots per week — including the same type on different days (e.g. Lesson on Monday AND Friday).' }),
      renderSlotsList(),
      el('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap;align-items:flex-end' }, [
        el('div', {}, [el('label', { text: 'Day' }), daySel]),
        el('div', {}, [el('label', { text: 'Type' }), typeSel]),
        el('div', {}, [el('label', { text: 'Start' }), startInput]),
        el('div', {}, [el('label', { text: 'End' }), endInput]),
        el('button', { class: 'btn btn-sm btn-outline', text: '+ Add Slot', onclick: () => {
          if (timeToMinutes(endInput.value) <= timeToMinutes(startInput.value)) { alert('End time must be after start time'); return; }
          slots.push({ day: daySel.value, type: typeSel.value, start: startInput.value, end: endInput.value });
          rerender();
        } })
      ]),
      el('div', { class: 'btn-group', style: 'margin-top:16px;justify-content:flex-end' }, [
        el('button', { class: 'btn', text: 'Save Schedule', onclick: async () => {
          try {
            await api(`/api/${currentProfile}/subjects/${subject.id}`, { method: 'PUT', body: JSON.stringify({ schedule: slots }) });
            closeModal(); await loadConfig(); render();
          } catch (e) { alert(e.message); }
        }})
      ])
    ]);
  }

  container = buildContent();
  showModal(container);
}

function showAddSubjectModal() {
  // Quick add subject to timetable
  const cfg = cachedConfig || { academic_years: [] };
  const nameInput = el('input', { placeholder: 'Subject name' });
  const typeSel = el('select', {}, [
    el('option', { value: 'C', text: 'Lesson' }),
    el('option', { value: 'TD', text: 'Practical Work' }),
    el('option', { value: 'TP', text: 'Lab' })
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
  const now = new Date();
  const dateInput = el('input', { type: 'date', value: todayStr() });
  // Defaults to the current local hour/minute — matches the old
  // implicit behavior (records used to always silently timestamp
  // themselves "now" regardless of the chosen date), but now it's an
  // editable field instead of a hidden assumption, so a backdated
  // entry can get a sensible time instead of inheriting today's clock.
  const timeInput = el('input', { type: 'time', value: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}` });
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
        el('td', {}, el('span', { class: `tag tag-${r.type.toLowerCase()}`, text: lessonTypeLabel(r.type) })),
        el('td', { text: r.event_label || '—' }),
        el('td', {}, el('span', { class: `tag tag-${r.status}`, text: r.status === 'teacher_absent' ? 'Teacher Absent' : r.status })),
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
    el('option', { value: 'C', text: 'Lesson' }),
    el('option', { value: 'TD', text: 'Practical Work' }),
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
    el('option', { value: 'absent', text: 'Absent' }),
    el('option', { value: 'teacher_absent', text: 'Teacher Absent (lesson cancelled)' })
  ]);
  statusSel.value = defaultExceptionStatus();
  const minutesInput = el('input', { type: 'number', value: Math.max(15, (timeToMinutes(schedule.end || schedule.start || '09:00') - timeToMinutes(schedule.start || '08:00')) || 90), min: '0' });
  const content = el('div', {}, [
    el('div', { class: 'modal-header' }, [
      el('div', { class: 'modal-title', text: 'Mark Attendance' }),
      el('button', { class: 'modal-close', onclick: closeModal, text: '×' })
    ]),
    el('div', { class: 'text-sm text-dim mb-8', text: `${subject.name} • ${lessonTypeLabel(schedule.type || 'C')} • ${dateStr}` }),
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
              event_label: `${subject.name} ${lessonTypeLabel(schedule.type || 'C')}`,
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
      const typeLabels = { written: 'Written', tp_exam: 'Lab Exam', oral: 'Oral' };
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
      el('td', { text: lessonTypeLabel(r.type) }),
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
  // Static coin — used anywhere a Nerds cost/amount is shown inline
  // (buy buttons, chips, etc.) so the cost is always visible without
  // needing to hover. The animated version (coinIconAnimated) is only
  // used for the one "this is currently earning/ticking" spot per card.
  return el('img', { src: '/sprites/nerds/coin_01.png', class: 'coin-icon', style: `width:${size||16}px;height:${size||16}px` });
}
// The 8 coin frames are separate PNG files (coin_01.png..coin_08.png),
// not one combined spritesheet strip — so this can't be done with a
// CSS background-position/steps() trick (that only works against a
// single strip image; against 8 separate files it just shows one tiny
// frame stretched/mispositioned, which is the "blinks to nothing" bug).
// The straightforward, genuinely trivial fix for a separate-frame
// sequence like this is exactly what's below: a real <img>, and a
// setInterval that swaps its src through the frame list. No animation
// library needed for something this simple — that's really only worth
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
  // Stop the interval once the <img> is no longer on the page —
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
    catalog = await loadBotanariumCatalog();
    plantsResp = await api(`/api/${currentProfile}/plants`);
  } catch (e) {
    c.innerHTML = `<div class="card"><p>Error loading the Botanarium: ${esc(e.message)}</p></div>`;
    return;
  }
  if (!catalog) { c.innerHTML = `<div class="card"><p>Could not load the plant catalog.</p></div>`; return; }

  c.innerHTML = '';
  c.appendChild(el('div', { class: 'row', style: 'justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:8px' }, [
    el('h2', { text: '🌿 The Botanarium' }),
    el('button', { class: 'btn btn-sm btn-outline', text: '📖 Clementine\'s Book of Wonders', onclick: showBookOfWonders })
  ]));

  // Botanarium Bank card
  const bank = plantsResp.bank;
  const bankCard = el('div', { class: 'card fade-in' }, [
    el('div', { class: 'card-title', text: '🏦 Botanarium Bank' }),
    el('div', { class: 'text-dim text-sm mb-8', text: 'Every plant\'s passive Nerds are capped by how much you can claim in any rolling 24 hours — that cap is set by your Bank level, not by this week\'s activity, so vacations and slow weeks never waste a plant\'s worth.' }),
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
    c.appendChild(el('div', { class: 'stats-grid', style: 'grid-template-columns:repeat(auto-fill,minmax(320px,1fr))' },
      plantsResp.plants.map(p => renderPlantCard(p, catalog))
    ));
  }

// Turns a raw mechanic id like "fast_grower" into a display-ready label
// like "Fast Grower" — underscores replaced with spaces, each word
// capitalized. Used anywhere a bonus id needs to be shown to the person
// rather than just referenced internally (e.g. collection reward text).
function formatBonusLabel(id) {
  return String(id).split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// Active collections — themed sets of plants (e.g. every potato
  // variety) that amplify their own members' existing bonus values once
  // every member reaches max level, rather than granting an unrelated
  // flat reward — e.g. every owned potato-family plant's Voluminous/
  // Bountiful/Hardy values climb further once the whole Potato Cellar
  // is complete. Only the "Full Garden" capstone grants a flat reward,
  // since it spans every domain at once.
  if ((plantsResp.collections || []).length) {
    c.appendChild(el('div', { class: 'card fade-in' }, [
      el('div', { class: 'card-title', text: '🎖 Plant Collections' }),
      el('div', { class: 'text-dim text-sm mb-8', text: 'Get every plant in a themed set to its max level. Most collections amplify those plants\' OWN existing bonuses further (hover a card for exactly which ones); "The Full Garden" is the one universal capstone reward. Multiple active collections stack.' }),
      el('div', { class: 'stats-grid', style: 'grid-template-columns:repeat(auto-fill,minmax(220px,1fr))' },
        plantsResp.collections.map(coll => {
          const rewardText = coll.domain_bonus_ids
            ? `+${coll.domain_boost_pct}% to ${coll.domain_bonus_ids.map(formatBonusLabel).join(', ')}`
            : `+${coll.flat_xp_pct}% XP / +${coll.flat_nerds_pct}% Nerds`;
          const card = el('div', {
            class: 'stat-card', style: `opacity:${coll.active ? 1 : .55};cursor:help`
          }, [
            el('div', { style: 'font-size:1.3rem', text: coll.active ? '✅' : '🔒' }),
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

  // Not-yet-owned plants (acquire via seed)
  const ownedTypes = new Set(plantsResp.plants.map(p => p.plant_type));
  const notOwned = catalog.catalog.filter(p => !ownedTypes.has(p.id));
  if (notOwned.length) {
    c.appendChild(el('div', { class: 'card fade-in' }, [
      el('div', { class: 'card-title', text: '🌱 Not Yet Planted' }),
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
    el('div', { class: 'card-title', text: 'ℹ️ How Plant Growth Works' }),
    el('div', { class: 'col', style: 'gap:8px;font-size:var(--font-s)' }, [
      el('div', {}, [el('strong', { text: 'Growth: ' }), el('span', { text: 'Only ONE plant grows at a time — whichever one you\'ve tapped "Select for Growth" on. Every minute you study while it\'s selected banks toward its next level (most plants max out at Level 4; Watermelon maxes at Level 5). Fertilizer is a temporary buff (bought with Nerds) that boosts growth-hour accrual for 24 hours, then wears off — buy it again any time.' })]),
      el('div', {}, [el('strong', { text: 'Bonuses: ' }), el('span', { text: 'Each level permanently unlocks one bonus, unique to that plant. Hover any bonus on a plant\'s card (or check the Book of Wonders) to see exactly what triggers it and by how much. Colors on the card border always mean the same level across every plant.' })]),
      el('div', {}, [el('strong', { text: 'Passive Yield: ' }), el('span', { text: 'Every plant generates Nerds passively over real time, claimable any time — up to 24 hours\' worth banks up (some plants extend this), the rest is lost, so check back regularly. Studying 5+ hours in a week (quality-weighted) boosts the rate above normal for every plant; studying less never lowers it below normal — under-studying is handled entirely by Neglect below, not by this.' })]),
      el('div', {}, [el('strong', { text: 'Harvest: ' }), el('span', { text: 'Once a plant reaches its max level, it can additionally be Harvested for a Fruit item every few growth-hours (separate from, and on top of, passive Nerds yield). Harvesting shows the plant\'s depleted look for 1 hour afterward, during which it can\'t be harvested again — passive yield and Prestige growth keep working normally throughout. A Harvest is refused outright (nothing consumed) if your inventory has no room for it. Fruits are text-only inventory items for now, sellable in the Market.' })]),
      el('div', {}, [el('strong', { text: 'Prestige: ' }), el('span', { text: 'Once a plant hits its max level, continued study hours build toward Prestige tiers instead. Each tier grants one point to permanently boost any one of the plant\'s own 4 (or, for Watermelon, 5) bonuses.' })]),
      el('div', {}, [el('strong', { text: 'Neglect: ' }), el('span', { text: 'Two separate signals. Go too long with NO self-study at all, and every plant\'s yield dips a bit (a soft, forgiving nudge). Go too long WITHOUT REAL GROWTH TIME on one specific plant, and that plant visibly wilts and its yield nearly stops — a token session won\'t stop this, it takes real hours. The safe window per plant grows the more plants you own. Some plants soften this penalty (Hardy) or extend the window before it starts at all (Warden).' })]),
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

function renderPlantCard(p, catalog) {
  const card = el('div', { class: `stat-card plant-card${p.withered ? ' plant-withered' : ''}${p.is_selected_for_growth ? ' plant-selected-growth' : ''}`, style: `border-color:${p.color};text-align:left` });
  const header = el('div', { class: 'row', style: 'gap:12px;align-items:flex-start' }, [
    el('img', { src: p.sprite, class: 'pixel-sprite', style: 'width:72px;height:72px;flex-shrink:0', onerror: (e) => { e.target.style.display = 'none'; } }),
    el('div', { class: 'flex-1' }, [
      el('div', { class: 'row', style: 'gap:6px;align-items:center;flex-wrap:wrap' }, [
        el('div', { style: 'font-weight:800;font-size:1.05rem', text: p.name }),
        p.is_selected_for_growth ? el('span', { class: 'plant-select-badge', text: '🌱 Growing' }) : null
      ]),
      el('div', { class: 'text-dim text-sm', style: 'font-style:italic', text: p.scientific_name }),
      el('div', { style: `display:inline-block;margin-top:4px;padding:2px 9px;border-radius:20px;background:${p.color}22;border:1px solid ${p.color};color:${p.color};font-weight:700;font-size:var(--font-xxs)`, text: p.tier_name })
    ]),
    el('div', { class: 'yield-chip', title: 'Current passive Nerds/hour' }, [
      coinIcon(13), el('span', { text: `${p.yield_per_hour_effective}/h` })
    ])
  ]);
  card.appendChild(header);

  // Select-for-Growth — exactly ONE plant grows from logged study
  // sessions at a time (see _resolve_growth_plant_id server-side).
  // Toggling this is the only way to deliberately choose which one.
  card.appendChild(el('button', {
    class: `btn btn-sm mt-8 ${p.is_selected_for_growth ? '' : 'btn-outline'}`,
    text: p.is_selected_for_growth ? '✓ Selected for Growth' : 'Select for Growth',
    onclick: async () => {
      try { await api(`/api/${currentProfile}/plants/${p.id}/select`, { method: 'POST' }); render(); }
      catch (e) { alert(e.message); }
    }
  }));

  if (p.withered) {
    const extra = p.globally_neglected ? ' On top of that, you haven\'t studied at all recently, which dents every plant\'s yield too.' : '';
    card.appendChild(el('div', { class: 'recommendation warning mt-8', style: 'margin-bottom:0' }, [
      el('span', { text: '🥀' }),
      el('span', { text: `Wilted — this plant hasn't gotten enough study time recently. Its passive yield is cut to a fraction until you give it real attention again.${extra}` })
    ]));
  } else if (p.globally_neglected) {
    card.appendChild(el('div', { class: 'text-dim text-sm mt-8', text: 'ℹ️ No self-study logged in a while — every plant\'s yield is temporarily reduced until you study again.' }));
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
    card.appendChild(el('div', { class: 'text-dim text-sm mt-8', text: 'Fully grown — hours now build toward Prestige.' }));
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
          if (resp.seed_dropped) alert(`🌱 A ${resp.seed_item.replace('_', ' ')} dropped into your inventory!`);
        } else if (resp.reason) {
          alert(resp.reason);
        }
        await maybeShowLevelUp({ skipXpToast: true });
        render();
      } catch (e) { alert(e.message); }
    } })
  ]);
  card.appendChild(claimRow);

  // Harvest — a separate, max-level-only mechanic from passive Claim.
  // p.harvest is null until the plant reaches its max level.
  if (p.harvest) {
    const h = p.harvest;
    const harvestBox = el('div', { class: 'mt-8', style: 'padding:10px;border-radius:var(--r-sm);background:var(--bg3);border:1px solid var(--border)' });
    harvestBox.appendChild(el('div', { class: 'row', style: 'justify-content:space-between;align-items:center;margin-bottom:6px' }, [
      el('span', { class: 'text-sm', style: 'font-weight:700', text: `🍈 ${h.fruit_label}` }),
      el('span', { class: 'text-dim text-sm', text: `Harvested ${h.harvest_count}x` })
    ]));
    if (h.locked) {
      harvestBox.appendChild(el('div', { class: 'text-sm', style: 'color:var(--amber)', text: `Recovering — growth resumes in ${h.lockout_remaining_minutes}min` }));
      harvestBox.appendChild(el('div', { class: 'text-dim text-sm mt-8', text: 'This plant shows its just-harvested look until it recovers. Growth toward the NEXT harvest is paused during this window — passive Nerds yield and leveling/prestige growth are unaffected.' }));
    } else {
      const pct = Math.min(100, (h.progress_hours / h.hours_required) * 100);
      harvestBox.appendChild(el('div', { class: 'xp-progress-track' }, [el('div', { class: 'xp-progress-fill', style: `width:${pct}%;background:${p.color}` })]));
      harvestBox.appendChild(el('div', { class: 'row', style: 'justify-content:space-between;align-items:center;margin-top:8px' }, [
        el('span', { class: 'text-dim text-sm', text: `${fmt(h.progress_hours, 1)}h / ${h.hours_required}h` }),
        el('button', { class: 'btn btn-sm btn-success', text: 'Harvest', disabled: !h.ready, onclick: async () => {
          try {
            const resp = await api(`/api/${currentProfile}/plants/${p.id}/harvest`, { method: 'POST' });
            if (resp.qty > 1) alert(`🍈 Bonus harvest! Got ${resp.qty}x ${resp.fruit_label}.`);
            render();
          } catch (e) { alert(e.message); }
        } })
      ]));
    }
    card.appendChild(harvestBox);
  }

  // Bonuses — hover any row to see the exact trigger/mechanism, not
  // just the label + value.
  const bonusList = el('div', { class: 'mt-8' }, p.bonuses.map(b => {
    const row = el('div', {
      class: 'row', style: `justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--border);opacity:${b.unlocked ? 1 : .45};cursor:help`
    }, [
      el('span', { class: 'text-sm', text: `${b.unlocked ? '✓' : '🔒'} ${b.label} (Lv${b.level_required})` }),
      el('span', { class: 'text-sm', style: 'font-weight:700', text: b.unlocked ? `+${b.value}${b.unit}` : '—' })
    ]);
    attachTooltip(row, b.desc, p.color);
    return row;
  }));
  card.appendChild(bonusList);

  // Actions: Fertilize (temporary buff), Fast Grower upgrade, Prestige allocation
  const actions = el('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap;margin-top:10px' });
  if (p.fertilizer_active) {
    actions.appendChild(el('div', { class: 'text-sm', style: 'display:flex;align-items:center;gap:6px;color:var(--green);font-weight:700' }, [
      el('span', { text: '🧪' }),
      el('span', { text: `Fertilized — +${p.fertilizer_bonus_pct}% growth for ${fmt(p.fertilizer_remaining_hours, 1)}h more` })
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
      el('div', { class: 'modal-title', text: `Allocate a Prestige Point — ${p.name}` }),
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
      el('div', { class: 'modal-title', text: '📖 Clementine\'s Book of Wonders' }),
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
    el('div', { class: 'card-title', text: '🌱 Growth Guide (in-game)' }),
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
      el('div', { class: 'modal-title', text: '📖 Clementine\'s Book of Wonders' }),
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
async function renderInventory(c) {
  c.innerHTML = '<div class="text-center text-dim" style="padding:40px">Loading Inventory...</div>';
  let inv, shop, catalog;
  try {
    inv = await api(`/api/${currentProfile}/inventory`);
    shop = await api(`/api/${currentProfile}/shop/catalog`);
    catalog = await loadBotanariumCatalog();
  } catch (e) {
    c.innerHTML = `<div class="card"><p>Error loading Inventory: ${esc(e.message)}</p></div>`;
    return;
  }

  c.innerHTML = '';
  c.appendChild(el('h2', { style: 'margin-bottom:16px', text: '🎒 Inventory & Shop' }));

  const items = inv.inventory || [];
  const slotCount = inv.slot_count || 20;
  // Items of the same item_type already stack automatically into one
  // slot (qty goes up rather than taking a second slot) — that's
  // handled server-side. This grid places each stack at its saved
  // slot_index, and lets you drag a stack onto another slot to
  // rearrange — including swapping with whatever's already there.
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
      el('div', { class: 'card-title', style: 'margin-bottom:0', text: '📦 Your Items' }),
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
    items.length ? null : el('div', { class: 'text-dim text-sm mb-8', text: 'Your inventory is empty. Buy a seed from the Market below, or earn one from a plant\'s own bonuses.' }),
    slotsGrid
  ]));

  // Market
  c.appendChild(el('div', { class: 'card fade-in' }, [
    el('div', { class: 'card-title', text: '🏪 Market' }),
    el('div', { class: 'text-dim text-sm mb-8', text: 'Buy seeds to plant new species in the Botanarium, sell off surplus seeds and harvested fruits for Nerds, or pick up a cosmetic theme. Fruits are sell-only for now.' }),
    (() => {
      const searchInput = el('input', { placeholder: 'Search items...', style: 'max-width:260px;margin-bottom:10px' });
      const tableHost = el('div');
      function renderMarketTable() {
        const q = searchInput.value.trim().toLowerCase();
        const filtered = (shop.items || []).filter(it => !q || it.label.toLowerCase().includes(q));
        tableHost.innerHTML = '';
        tableHost.appendChild(el('table', {}, [
          el('thead', {}, el('tr', {}, [el('th', { text: 'Item' }), el('th', { text: 'Buy' }), el('th', { text: 'Sell' }), el('th', { text: 'You Have' }), el('th', { text: '' })])),
          el('tbody', {}, filtered.map(it => {
            const owned = items.find(x => x.item_type === it.item_type);
            return el('tr', {}, [
              el('td', {}, el('div', { class: 'row', style: 'gap:8px;align-items:center' }, [
                it.sprite ? el('img', { src: it.sprite, style: 'width:28px;height:28px;image-rendering:pixelated', onerror: (e) => { e.target.style.display = 'none'; } }) : el('span', { style: 'width:28px;display:inline-flex;justify-content:center', text: '🍈' }),
                el('span', { text: it.label })
              ])),
              el('td', {}, it.buy_price != null ? nerdsAmount(it.buy_price, 14) : el('span', { class: 'text-dim', text: '—' })),
              el('td', {}, nerdsAmount(it.sell_price, 14)),
              el('td', { text: owned ? owned.qty : 0 }),
              el('td', {}, el('div', { class: 'btn-group' }, [
                it.buy_price != null ? el('button', { class: 'btn btn-sm', text: 'Buy', onclick: async () => {
                  try { await api(`/api/${currentProfile}/shop/buy`, { method: 'POST', body: JSON.stringify({ item_type: it.item_type, qty: 1 }) }); await maybeShowLevelUp({ skipXpToast: true }); render(); }
                  catch (e) { alert(e.message); }
                } }) : null,
                el('button', { class: 'btn btn-sm btn-amber', text: 'Sell 1', disabled: !owned || owned.qty < 1, onclick: async () => {
                  try { await api(`/api/${currentProfile}/shop/sell`, { method: 'POST', body: JSON.stringify({ item_type: it.item_type, qty: 1 }) }); render(); }
                  catch (e) { alert(e.message); }
                } })
              ]))
            ]);
          }))
        ]));
      }
      searchInput.addEventListener('input', renderMarketTable);
      renderMarketTable();
      return el('div', {}, [searchInput, tableHost]);
    })()
  ]));

  // Theme shop — cosmetic themes purchasable with Nerds, separate from
  // the level-unlocked catalog in Progression.
  const purchasableThemes = (gamification?.theme_catalog || []).filter(t => t.price);
  if (purchasableThemes.length) {
    c.appendChild(el('div', { class: 'card fade-in' }, [
      el('div', { class: 'card-title', text: '🎨 Theme Shop' }),
      el('div', { class: 'text-dim text-sm mb-8', text: 'A couple of themes available for purchase outright, on top of the ones you unlock by leveling up.' }),
      el('div', { class: 'stats-grid', style: 'grid-template-columns:repeat(auto-fill,minmax(160px,1fr))' },
        purchasableThemes.map(t => {
          const owned = (gamification.unlocked_themes || []).includes(t.id);
          return el('div', { class: 'stat-card' }, [
            el('div', { style: 'font-size:1.4rem', text: '🎨' }),
            el('div', { class: 'stat-label', style: 'margin-top:6px;font-weight:600', text: t.label }),
            owned
              ? el('div', { class: 'text-dim', style: 'font-size:10px;margin-top:6px', text: 'Owned' })
              : el('button', { class: 'btn btn-sm mt-8', onclick: async () => {
                  try { await api(`/api/${currentProfile}/shop/buy_theme`, { method: 'POST', body: JSON.stringify({ theme_id: t.id }) }); await maybeShowLevelUp({ skipXpToast: true }); render(); }
                  catch (e) { alert(e.message); }
                } }, [nerdsAmount(t.price, 13)])
          ]);
        })
      )
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
// ═══════════════════════════════════════════
// FINANCE (Nerds income/expense ledger)
// ═══════════════════════════════════════════
const FINANCE_SOURCE_ICONS = {
  self_study: '📖', plant_claim: '🌿', market_sell: '💰',
  level_up: '⭐', mastery: '🎓', fertilizer: '🧪',
  bank_upgrade: '🏦', theme_purchase: '🎨', seed_purchase: '🌱'
};

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
  c.appendChild(el('h2', { style: 'margin-bottom:16px', text: '💰 Finance Ledger' }));
  c.appendChild(el('div', { class: 'text-dim text-sm mb-16', text: 'Every Nerds gain and spend, exactly as it happened — self-study sessions, level-ups, mastery tiers, plant claims, and Market purchases, grouped by day like a real statement. Entries marked with 🌿 had a plant bonus applied.' }));

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
    c.appendChild(el('div', { class: 'card text-dim text-center', style: 'padding:40px', text: 'No Nerds activity yet. Log a self-study session or claim a plant to get started.' }));
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
        const icon = FINANCE_SOURCE_ICONS[en.source] || '•';
        const positive = en.amount >= 0;
        return el('tr', {}, [
          el('td', { style: 'width:26px', text: icon }),
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
            el('div', { class: 'text-dim', style: 'font-size:10px', text: isUnlocked ? (isActive ? 'Active' : 'Unlocked') : (isPreviewing ? 'Previewing' : (t.price ? `Preview • Buy in Market` : `Preview • Lv ${t.level}`)) })
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
    el('div', { class: 'card-title', text: '📚 Subject Mastery' }),
    renderMasteryGrid('subject', 'Add subjects in Settings to start earning mastery.')
  ]));

  c.appendChild(el('div', { class: 'card fade-in' }, [
    el('div', { class: 'card-title', text: '🎯 Skill Mastery' }),
    renderMasteryGrid('skill', 'Add skills in Settings to start earning mastery.')
  ]));

  c.appendChild(el('div', { class: 'card fade-in' }, [
    el('div', { class: 'card-title', text: '🗂 Skill Category Mastery' }),
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
    card.appendChild(el('div', { class: 'text-dim text-sm', text: 'This is a packaged .exe build — please download the latest release manually from the GitHub repo; auto-update only works when running from source (start.bat / launcher.bat).' }));
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
      // The server process is about to swap itself out — give it a
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
  card.appendChild(el('div', { class: 'text-dim text-sm mt-8', text: 'This restarts the server automatically once applied — this browser tab will reload itself in a few seconds.' }));
}

// ═══════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════
async function renderSettings(c) {
  const cfg = cachedConfig || { subjects: [], skills: [], academic_years: [], skill_categories: [] };

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

  // Updates — checks the GitHub repo for a newer commit than this
  // install last synced to, and can download + apply + restart in one
  // flow. See renderUpdatesCard() below.
  c.appendChild(el('div', { class: 'card fade-in', id: 'updatesCard' }, [
    el('div', { class: 'card-title', text: '\u2B06\uFE0F Updates' }),
    el('div', { class: 'text-dim text-sm', text: 'Checking...' })
  ]));
  renderUpdatesCard();

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

  // Subjects — category management lives inline at the top of this
  // card, mirroring the Skills card below exactly: a category can be
  // created (and deleted) on its own, with zero subjects assigned to
  // it, the same way Skill Categories always could.
  c.appendChild(el('div', { class: 'card fade-in' }, [
    el('div', { class: 'card-title', text: '📚 Subjects' }),
    el('div', { class: 'text-dim text-sm mb-8', text: 'Categories group related subjects together (e.g. "Mathematics" holding both "Algebra" and "Analysis"). A category can be reused as a Skill Category too — they\'re independent, so the same real-world topic can label both.' }),
    el('div', { class: 'row', style: 'gap:8px;margin-bottom:8px;flex-wrap:wrap;align-items:flex-end' }, [
      el('div', {}, [el('label', { text: 'New Category', style: 'margin:0 0 4px' }), el('input', { id: 'newSubCatName', placeholder: 'e.g. Mathematics', style: 'width:200px' })]),
      el('button', { class: 'btn btn-sm btn-outline', text: '+ Add Category', onclick: addSubjectCategory })
    ]),
    (cfg.subject_categories || []).length ? el('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap;margin-bottom:8px' },
      cfg.subject_categories.map(sc => el('span', { class: 'tag', style: 'background:var(--bg3);color:var(--text);display:inline-flex;align-items:center;gap:6px' }, [
        el('span', { text: sc.name }),
        el('span', { style: 'cursor:pointer;opacity:.7', text: '✕', title: 'Delete category (subjects keep their data, just lose this grouping)', onclick: async () => {
          if (!confirm(`Delete category "${sc.name}"? Its subjects will become uncategorized.`)) return;
          await api(`/api/${currentProfile}/subject_categories/${sc.id}`, { method: 'DELETE' });
          await loadConfig(); render();
        } })
      ]))
    ) : null,
    el('div', { class: 'row', style: 'gap:8px;margin-bottom:12px;flex-wrap:wrap' }, [
      el('input', { id: 'newSubName', placeholder: 'Subject name', style: 'width:180px' }),
      el('input', { id: 'newSubColor', type: 'color', value: '#4a90d9', style: 'width:40px' }),
      el('input', { id: 'newSubDiff', type: 'number', min: '1', max: '10', value: '5', style: 'width:74px', title: 'Baseline difficulty (1 easiest, 10 hardest) — used as the default starting point when rating a session, and as a stable signal for exam-score predictions. Each individual study session logs its own difficulty separately.' }),
      el('select', { id: 'newSubCat', style: 'width:auto' }, [
        el('option', { value: '', text: 'No category' }),
        ...(cfg.subject_categories || []).map(sc => el('option', { value: sc.id, text: sc.name }))
      ]),
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
        el('option', { value: 'C', text: 'Lesson' }),
        el('option', { value: 'TD', text: 'Practical Work' }),
        el('option', { value: 'TP', text: 'Lab' })
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
          el('thead', {}, el('tr', {}, [el('th', { text: 'Color' }), el('th', { text: 'Name' }), el('th', { text: 'Diff' }), el('th', { text: 'Category' }), el('th', { text: 'Year' }), el('th', { text: 'Schedule' }), el("th", { text: "" })])),
          el('tbody', {}, subjectsToShow.map(s => {
        const yr = cfg.academic_years.find(y => y.id === s.year_id);
        const catSel = el('select', { style: 'width:auto;min-width:120px', title: 'Assign to a Subject Category — also moves its File Explorer folder' }, [
          el('option', { value: '', text: 'Uncategorized' }),
          ...(cfg.subject_categories || []).map(sc => el('option', { value: sc.id, text: sc.name }))
        ]);
        catSel.value = s.category_id || '';
        catSel.addEventListener('change', async () => {
          try { await api(`/api/${currentProfile}/subjects/${s.id}`, { method: 'PUT', body: JSON.stringify({ category_id: catSel.value }) }); await loadConfig(); render(); }
          catch (e) { alert(e.message); }
        });
        return el('tr', {}, [
          el('td', {}, el('div', { style: `width:20px;height:20px;border-radius:4px;background:${s.color}` })),
          el('td', { text: s.name }),
          el('td', { text: s.difficulty + '/10' }),
          el('td', {}, catSel),
          el('td', { class: 'text-sm text-dim', text: yr ? yr.label : '—' }),
          el('td', { class: 'text-sm text-dim', text: (s.schedule || []).map(sc => `${sc.day} ${lessonTypeLabel(sc.type)}`).join(', ') || '—' }),
          el('td', {}, el('div', { class: 'btn-group' }, [
            el('button', { class: 'btn btn-sm btn-outline', text: '📅', title: 'Manage schedule (add more than one slot per week)', onclick: () => showManageScheduleModal(s) }),
            el('button', { class: 'btn btn-sm btn-outline', text: '📁', title: 'Open in File Explorer', onclick: () => { navigate('files'); pendingFileExplorerOpen = { ref_type: 'subject', ref_id: s.id }; render(); } }),
            el('button', { class: 'btn btn-sm btn-danger', text: '✕', onclick: async () => {
              if (!dangerConfirm(`Delete "${s.name}"? This PERMANENTLY deletes every self-study session, attendance record, exam, and file linked to this subject too — including all mastery progress earned for it. This cannot be undone.`)) return;
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
    el('div', { class: 'card-title', text: '🎯 Skills' }),
    el('div', { class: 'text-dim text-sm mb-8', text: 'Categories group related skills together (e.g. "Software Engineering" holding both "Design" and "Programming Languages"). A category levels up automatically from its skills\' combined mastery — no separate tracking needed.' }),
    el('div', { class: 'row', style: 'gap:8px;margin-bottom:8px;flex-wrap:wrap;align-items:flex-end' }, [
      el('div', {}, [el('label', { text: 'New Category', style: 'margin:0 0 4px' }), el('input', { id: 'newSkillCatName', placeholder: 'e.g. Software Engineering', style: 'width:200px' })]),
      el('button', { class: 'btn btn-sm btn-outline', text: '+ Add Category', onclick: addSkillCategory })
    ]),
    cfg.skill_categories.length ? el('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap;margin-bottom:8px' },
      cfg.skill_categories.map(sc => el('span', { class: 'tag', style: 'background:var(--bg3);color:var(--text);display:inline-flex;align-items:center;gap:6px' }, [
        el('span', { text: sc.name }),
        el('span', { style: 'cursor:pointer;opacity:.7', text: '✕', title: 'Delete category (skills keep their data, just lose this grouping)', onclick: async () => {
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
    cfg.skills.length ? el('div', { style: 'max-height:320px;overflow:auto;border:1px solid var(--border);border-radius:var(--r-sm)' }, [
      el('table', { style: 'margin:0' }, [
        el('thead', {}, el('tr', {}, [el('th', { text: 'Name' }), el('th', { text: 'Category' }), el("th", { text: "" })])),
        el('tbody', {}, cfg.skills.map(s => {
          const catSel = el('select', { style: 'width:auto;min-width:120px', title: 'Assign to a Skill Category — also moves its File Explorer folder' }, [
            el('option', { value: '', text: 'Uncategorized' }),
            ...cfg.skill_categories.map(c => el('option', { value: c.id, text: c.name }))
          ]);
          catSel.value = s.category_id || '';
          catSel.addEventListener('change', async () => {
            try { await api(`/api/${currentProfile}/skills/${s.id}`, { method: 'PUT', body: JSON.stringify({ category_id: catSel.value }) }); await loadConfigAndGamification(); render(); }
            catch (e) { alert(e.message); }
          });
          return el('tr', {}, [
          el('td', { text: s.name }),
          el('td', {}, catSel),
          el('td', {}, el('div', { class: 'btn-group' }, [
            el('button', { class: 'btn btn-sm btn-outline', text: '✏️', title: 'Rename skill', onclick: () => showRenameSkillModal(s) }),
            el('button', { class: 'btn btn-sm btn-outline', text: '📁', title: 'Open in File Explorer', onclick: () => { navigate('files'); pendingFileExplorerOpen = { ref_type: 'skill', ref_id: s.id }; render(); } }),
            el('button', { class: 'btn btn-sm btn-danger', text: '✕', onclick: async () => {
              if (!dangerConfirm(`Delete "${s.name}"? This PERMANENTLY deletes every self-study session and file linked to this skill too — including all mastery progress earned for it. This cannot be undone.`)) return;
              await api(`/api/${currentProfile}/skills/${s.id}`, { method: 'DELETE' });
              await loadConfigAndGamification(); render();
            } })
          ]))
        ]);
        }))
      ])
    ]) : el('div', { class: 'text-dim text-sm', text: 'No skills yet.' })
  ]));

  // Files — the rich freeform file explorer now lives on its own page.
  c.appendChild(el('div', { class: 'card fade-in' }, [
    el('div', { class: 'card-title', text: '📁 Subject/Skill Files' }),
    el('div', { class: 'text-dim text-sm mb-8', text: 'File uploads, folders, notes, and media playback now live in their own dedicated File Explorer — richer than fits in this settings list.' }),
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
  const categoryId = $('#newSubCat') ? $('#newSubCat').value : '';
  const yearId = $('#newSubYear') ? $('#newSubYear').value : '';
  const day = $('#newSubDay')?.value || '';
  const type = $('#newSubType')?.value || 'C';
  const start = $('#newSubStart')?.value || '';
  const end = $('#newSubEnd')?.value || '';
  if (!name) { alert('Enter name'); return; }
  if ((day || start || end) && (!day || !start || !end)) { alert('Pick a day, start, and end time for the schedule slot'); return; }
  try {
    await api(`/api/${currentProfile}/subjects`, { method: 'POST', body: JSON.stringify({
      name, color, difficulty: diff, year_id: yearId, category_id: categoryId,
      schedule: day ? [{ day, type, start, end }] : []
    }) });
    $('#newSubName').value = '';
    await loadConfigAndGamification(); render();
  } catch (e) { alert(e.message); }
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
  // (POST) — see server.py. Frontend now calls the matching path+method.
  await api(`/api/${currentProfile}/wipe`, { method: 'POST' });
  cachedData = null;
  await loadData();
  render();
}

// ═══════════════════════════════════════════
// FILE EXPLORER — freeform per-subject/skill file navigator
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

const FILE_KIND_ICONS = { audio: '🎵', video: '🎬', pdf: '📕', image: '🖼️', text: '📝', markdown: '📘', file: '📄' };

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
  c.appendChild(el('h2', { style: 'margin-bottom:16px', text: '📁 File Explorer' }));

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
    categories.forEach(cat => {
      const kids = byCategory.get(cat.id) || [];
      if (!kids.length) return;
      sidebar.appendChild(el('div', { class: 'fe-sidebar-cat', text: `🗂 ${cat.name}` }));
      kids.forEach(it => sidebar.appendChild(sidebarItemBtn(it, refType)));
    });
    uncategorized.forEach(it => sidebar.appendChild(sidebarItemBtn(it, refType)));
  }
  function sidebarItemBtn(it, refType) {
    const active = fileExplorerRef && fileExplorerRef.ref_type === refType && fileExplorerRef.ref_id === it.id;
    return el('button', {
      class: `fe-sidebar-item${active ? ' active' : ''}`, text: it.name,
      onclick: () => { fileExplorerRef = { ref_type: refType, ref_id: it.id, name: it.name }; fileExplorerPath = ''; render(); }
    });
  }
  sidebarSection('Subjects', cfg.subject_categories || [], cfg.subjects || [], 'subject');
  sidebarSection('Skills', cfg.skill_categories || [], cfg.skills || [], 'skill');
  if (!(cfg.subjects || []).length && !(cfg.skills || []).length) {
    sidebar.appendChild(el('div', { class: 'text-dim text-sm', style: 'padding:8px', text: 'Add a subject or skill in Settings to get a folder here.' }));
  }
  layout.appendChild(sidebar);

  // ── Main panel ──
  const main = el('div', { class: 'fe-main' });
  if (!fileExplorerRef) {
    main.appendChild(el('div', { class: 'empty-state' }, [
      el('div', { class: 'empty-state-icon', text: '📁' }),
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
      el('button', { class: 'btn btn-sm btn-outline', text: '📁+ New Folder', onclick: () => showFeNewFolderModal() }),
      el('button', { class: 'btn btn-sm btn-outline', text: '📝+ New File', onclick: () => showFeNewFileModal() }),
      el('button', { class: 'btn btn-sm', text: '⬆ Upload', onclick: () => fileInput.click() }),
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
      }, [el('div', { class: 'fe-card-icon', text: '⬆️' }), el('div', { class: 'fe-card-name', text: '.. (up)' })]));
    }

    data.folders.forEach(f => {
      grid.appendChild(el('div', {
        class: 'fe-card fe-folder-card', draggable: true, title: f.name,
        onclick: () => { fileExplorerPath = joinFePath(fileExplorerPath, f.name); render(); },
        ondragstart: (e) => { fileExplorerDragPath = joinFePath(fileExplorerPath, f.name); e.dataTransfer.setData('text/plain', fileExplorerDragPath); },
        ondragover: (e) => e.preventDefault(),
        ondrop: (e) => feHandleDrop(e, joinFePath(fileExplorerPath, f.name))
      }, [
        el('div', { class: 'fe-card-icon', text: '📂' }),
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
        el('div', { class: 'fe-card-icon', text: FILE_KIND_ICONS[f.kind] || '📄' }),
        el('div', { class: 'fe-card-name', text: f.name }),
        el('div', { class: 'fe-card-meta', text: `${(f.size / 1024).toFixed(0)}KB${f.has_notes ? ' · 📝' : ''}` }),
        feCardMenu(fullPath, f.name, false, f)
      ]));
    });

    if (!data.folders.length && !data.files.length) {
      grid.appendChild(el('div', { class: 'empty-state', style: 'grid-column:1/-1' }, [
        el('div', { class: 'empty-state-icon', text: '🗃️' }),
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

// Small "..." menu per card — rename/delete for everything, plus
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
      pop.appendChild(el('div', { class: 'fe-menu-item', text: '➕ Add to Queue', onclick: () => { audioQueueAdd({ ref: fileExplorerRef, path, name: displayName }); pop.remove(); } }));
    }
    if (!isFolder && fileInfo && (fileInfo.kind === 'text' || fileInfo.kind === 'markdown')) {
      pop.appendChild(el('div', { class: 'fe-menu-item', text: '✏️ Edit', onclick: () => { pop.remove(); openTextEditor(fileExplorerRef, path, displayName, fileInfo.kind); } }));
    }
    pop.appendChild(el('div', { class: 'fe-menu-item', text: '✏️ Rename', onclick: () => { pop.remove(); showFeRenameModal(path, displayName); } }));
    pop.appendChild(el('div', { class: 'fe-menu-item fe-menu-danger', text: '🗑 Delete', onclick: async () => {
      pop.remove();
      if (!confirm(`Delete "${displayName}"?${isFolder ? ' This deletes everything inside it too.' : ''}`)) return;
      await api(`/api/${currentProfile}/filetree/${fileExplorerRef.ref_type}/${fileExplorerRef.ref_id}/delete`, { method: 'POST', body: JSON.stringify({ path }) });
      render();
    } }));
    document.body.appendChild(pop);
    const rect = btn.getBoundingClientRect();
    const popWidth = 190; // matches .fe-card-menu-popover's min-width
    pop.style.top = `${rect.bottom + 4}px`;
    // Anchor to the BUTTON's right edge (rect.right), not its left — a
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
  if (fileInfo.kind === 'image') { openImageViewer(ref, path, fileInfo.name); return; }
  if (fileInfo.kind === 'text' || fileInfo.kind === 'markdown') { openTextEditor(ref, path, fileInfo.name, fileInfo.kind); return; }
  // Local app — there's nothing to "download" (the file already lives in
  // the app's own folder), so just let the browser open it however it
  // naturally would; it'll fall back to a save prompt on its own for
  // types it genuinely can't render inline.
  window.open(fileDownloadUrl(ref, path, false), '_blank');
}

let _localIdCounter = 0;
function _localId(prefix) { return `${prefix}_${++_localIdCounter}_${Date.now()}`; }

// Shared viewer chrome: a fullscreen toggle (the viewer modal is also
// manually resizable — see .fe-viewer-modal's CSS `resize: both`) so a
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
      el('button', { class: 'btn btn-sm btn-outline', text: '⛶', title: 'Toggle fullscreen', onclick: toggleViewerFullscreen }),
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

// ── Text / Markdown / Code editor — a quick-edit box for the kind of
// small change that doesn't deserve firing up a real code editor.
// Markdown gets a rendered Preview tab (via marked.js); anything else
// gets a syntax-highlighted Preview (via highlight.js) — both loaded
// from CDN in index.html. Edit is always the plain textarea; Save
// writes straight back to the file on disk. ──
const HLJS_EXT_LANG_MAP = { js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', rb: 'ruby', sh: 'bash', yml: 'yaml', md: 'markdown', htm: 'html' };

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
  // manually clearing its data-highlighted flag first — awkward for
  // something that needs to re-run on every keystroke.
  const highlightCode = el('code');
  const highlightPre = el('pre', { class: 'fe-code-highlight-pre', 'aria-hidden': 'true' }, [highlightCode]);
  const textarea = el('textarea', { class: 'fe-code-editor-input', value: content, spellcheck: 'false' });
  const editorStack = el('div', { class: 'fe-code-editor-stack' }, [highlightPre, textarea]);

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
    // in a <textarea> unless something follows it — keeps the two
    // layers the same height so the caret never drifts below the
    // colored text on the last line.
    highlightCode.innerHTML = text.endsWith('\n') ? html + '\n' : html;
  }
  let highlightRaf = null;
  function scheduleHighlight() {
    if (highlightRaf) return;
    highlightRaf = requestAnimationFrame(() => { highlightRaf = null; refreshHighlight(); });
  }
  textarea.addEventListener('input', scheduleHighlight);
  textarea.addEventListener('scroll', () => {
    highlightPre.scrollTop = textarea.scrollTop;
    highlightPre.scrollLeft = textarea.scrollLeft;
  });
  refreshHighlight();

  const previewPane = el('div', { class: 'fe-text-preview hidden' });
  const editTabBtn = el('button', { class: 'btn btn-sm', text: '✏️ Edit' });
  const previewTabBtn = el('button', { class: 'btn btn-sm btn-outline', text: isMarkdown ? '👁 Preview' : '🎨 Rendered' });
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
  }
  function showPreviewMode() {
    renderPreview();
    editorStack.classList.add('hidden'); previewPane.classList.remove('hidden');
    previewTabBtn.classList.remove('btn-outline'); editTabBtn.classList.add('btn-outline');
  }
  editTabBtn.onclick = showEditMode;
  previewTabBtn.onclick = showPreviewMode;

  const saveBtn = el('button', { class: 'btn btn-sm btn-success', text: '💾 Save', onclick: async () => {
    try {
      await api(`/api/${currentProfile}/filetree/${ref.ref_type}/${ref.ref_id}/write_text`, { method: 'PUT', body: JSON.stringify({ path, content: textarea.value }) });
      statusSpan.textContent = 'Saved ✓';
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

// ── PDF viewer: native browser PDF rendering (iframe) + a page-anchored
// notes panel, now with TABS — opening several PDFs keeps them all
// available in one modal (switch via the tab bar) instead of replacing
// each other, plus an optional side-by-side split view of any two open
// tabs for comparing papers. The browser's own viewer already gives
// page nav, zoom, search, and print for free — reimplementing a PDF
// renderer from scratch would be enormous for what it adds; this layers
// tabs/notes/a remembered "last page" on top of it instead. ──
let pdfTabs = [];          // [{ id, ref, path, name, page, notes }]
let pdfActiveTabId = null;
let pdfSplitTabId = null;  // second pane's tab id, or null (single pane)

function _pdfTabKey(ref, path) { return `${ref.ref_type}:${ref.ref_id}:${path}`; }

async function openPdfViewer(ref, path, name) {
  const key = _pdfTabKey(ref, path);
  let tab = pdfTabs.find(t => t._key === key);
  if (!tab) {
    let meta = {};
    try { meta = await api(`/api/${currentProfile}/filetree/${ref.ref_type}/${ref.ref_id}/meta?path=${encodeURIComponent(path)}`); } catch (e) {}
    tab = { id: _localId('pdftab'), _key: key, ref, path, name, page: meta.pdf_last_page || 1, notes: meta.pdf_notes || [] };
    pdfTabs.push(tab);
  }
  pdfActiveTabId = tab.id;
  renderPdfViewerModal();
}
function pdfCloseTab(id) {
  pdfTabs = pdfTabs.filter(t => t.id !== id);
  if (pdfSplitTabId === id) pdfSplitTabId = null;
  if (pdfActiveTabId === id) pdfActiveTabId = pdfTabs.length ? pdfTabs[pdfTabs.length - 1].id : null;
  if (!pdfTabs.length) { closeModal(); return; }
  renderPdfViewerModal();
}
function pdfSavePageMeta(tab) {
  api(`/api/${currentProfile}/filetree/${tab.ref.ref_type}/${tab.ref.ref_id}/meta`, { method: 'PUT', body: JSON.stringify({ path: tab.path, pdf_last_page: tab.page }) }).catch(() => {});
}
function pdfSaveNotesMeta(tab) {
  api(`/api/${currentProfile}/filetree/${tab.ref.ref_type}/${tab.ref.ref_id}/meta`, { method: 'PUT', body: JSON.stringify({ path: tab.path, pdf_notes: tab.notes }) }).catch(() => {});
}
function renderPdfPane(tab) {
  const pageInput = el('input', { type: 'number', min: '1', value: String(tab.page), style: 'width:64px' });
  const iframe = el('iframe', { src: `${fileDownloadUrl(tab.ref, tab.path)}#page=${tab.page}`, class: 'fe-pdf-iframe' });
  function goToPage() {
    const p = Math.max(1, parseInt(pageInput.value) || 1);
    tab.page = p;
    iframe.src = `${fileDownloadUrl(tab.ref, tab.path)}#page=${p}`;
    pdfSavePageMeta(tab);
  }
  const notesList = el('div', { class: 'fe-notes-list' });
  function renderNotes() {
    notesList.innerHTML = '';
    if (!tab.notes.length) { notesList.appendChild(el('div', { class: 'text-dim text-sm', text: 'No notes yet — jump to a page and add one.' })); return; }
    [...tab.notes].sort((a, b) => a.page - b.page).forEach(n => {
      notesList.appendChild(el('div', { class: 'fe-note-item' }, [
        el('div', { class: 'fe-note-item-header' }, [
          el('span', { class: 'fe-note-jump', text: `p.${n.page}`, onclick: () => { pageInput.value = n.page; goToPage(); } }),
          el('button', { class: 'btn btn-sm btn-outline', text: '✕', onclick: () => { tab.notes = tab.notes.filter(x => x !== n); pdfSaveNotesMeta(tab); renderNotes(); } })
        ]),
        el('div', { class: 'text-sm', text: n.text })
      ]));
    });
  }
  const newNoteText = el('textarea', { placeholder: 'Add a note for the current page...', style: 'min-height:40px' });
  renderNotes();
  return el('div', { class: 'fe-pdf-pane' }, [
    el('div', { class: 'row', style: 'gap:6px;align-items:center;margin-bottom:6px' }, [
      el('span', { class: 'truncate text-sm', style: 'font-weight:700;flex:1', text: tab.name }),
      el('label', { text: 'Page', style: 'margin:0' }), pageInput,
      el('button', { class: 'btn btn-sm btn-outline', text: 'Go', onclick: goToPage })
    ]),
    el('div', { class: 'fe-pdf-split' }, [
      iframe,
      el('div', { class: 'fe-notes-panel' }, [
        el('div', { style: 'font-weight:700;margin-bottom:6px', text: '📝 Notes' }),
        notesList, newNoteText,
        el('button', { class: 'btn btn-sm mt-8', text: '+ Add note', onclick: () => {
          if (!newNoteText.value.trim()) return;
          tab.notes.push({ page: parseInt(pageInput.value) || tab.page, text: newNoteText.value.trim() });
          newNoteText.value = '';
          pdfSaveNotesMeta(tab); renderNotes();
        } })
      ])
    ])
  ]);
}
function renderPdfViewerModal() {
  if (!pdfTabs.length) return;
  const activeTab = pdfTabs.find(t => t.id === pdfActiveTabId) || pdfTabs[0];
  pdfActiveTabId = activeTab.id;

  const tabBar = el('div', { class: 'fe-tab-bar' }, pdfTabs.map(t => el('div', {
    class: `fe-tab${t.id === pdfActiveTabId ? ' active' : ''}`, onclick: () => { pdfActiveTabId = t.id; renderPdfViewerModal(); }
  }, [
    el('span', { class: 'truncate', style: 'max-width:140px', text: t.name }),
    el('span', { class: 'fe-tab-close', text: '×', title: 'Close tab', onclick: (e) => { e.stopPropagation(); pdfCloseTab(t.id); } })
  ])));

  const splitRow = pdfTabs.length > 1 ? el('div', { class: 'row', style: 'gap:8px;align-items:center;margin:8px 0' }, [
    el('span', { class: 'text-dim text-sm', text: '⊞ Split view with:' }),
    el('select', { style: 'width:auto', onchange: (e) => { pdfSplitTabId = e.target.value || null; renderPdfViewerModal(); } }, [
      el('option', { value: '', text: 'None (single pane)' }),
      ...pdfTabs.filter(t => t.id !== pdfActiveTabId).map(t => el('option', { value: t.id, text: t.name, selected: t.id === pdfSplitTabId }))
    ])
  ]) : null;

  const panes = el('div', { class: `fe-pdf-panes${pdfSplitTabId ? ' split' : ''}` }, [
    renderPdfPane(activeTab),
    pdfSplitTabId ? renderPdfPane(pdfTabs.find(t => t.id === pdfSplitTabId) || activeTab) : null
  ]);

  const content = el('div', { class: 'fe-viewer-pdf' }, [
    viewerHeader('📕 PDF Viewer', closeModal, [
      pdfTabs.length > 1 ? el('button', { class: 'btn btn-sm btn-outline', text: 'Close All', onclick: () => { pdfTabs = []; pdfActiveTabId = null; pdfSplitTabId = null; closeModal(); } }) : null
    ]),
    tabBar, splitRow, panes
  ]);
  showModal(content);
  document.getElementById('modalContent').classList.add('fe-viewer-modal', 'fe-viewer-pdf-modal');
}

// ── Video viewer: timestamped notes, click a note to seek+play ──
async function openVideoViewer(ref, path, name) {
  let meta = {};
  try { meta = await api(`/api/${currentProfile}/filetree/${ref.ref_type}/${ref.ref_id}/meta?path=${encodeURIComponent(path)}`); } catch (e) {}
  let notes = meta.video_notes || [];

  const video = el('video', { src: fileDownloadUrl(ref, path), controls: true, class: 'fe-video-el' });
  const notesList = el('div', { class: 'fe-notes-list' });
  const newNoteText = el('textarea', { placeholder: 'Add a note at the current timestamp...', style: 'min-height:44px' });
  const curTimeLabel = el('span', { class: 'text-dim text-sm', text: '00:00' });
  video.addEventListener('timeupdate', () => { curTimeLabel.textContent = formatClock(video.currentTime); });

  function renderNotes() {
    notesList.innerHTML = '';
    if (!notes.length) { notesList.appendChild(el('div', { class: 'text-dim text-sm', text: 'No notes yet — play the video and add one at any moment.' })); return; }
    [...notes].sort((a, b) => a.t - b.t).forEach(n => {
      notesList.appendChild(el('div', { class: 'fe-note-item' }, [
        el('div', { class: 'fe-note-item-header' }, [
          el('span', { class: 'fe-note-jump', text: formatClock(n.t), onclick: () => { video.currentTime = n.t; video.play(); } }),
          el('button', { class: 'btn btn-sm btn-outline', text: '✕', onclick: () => { notes = notes.filter(x => x !== n); saveNotes(); } })
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
        el('div', { style: 'font-weight:700', text: '📝 Timestamped Notes' }),
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
// PERSISTENT AUDIO PLAYER — module-level state + a single <audio>
// element, mounted into #audioPlayerBar (outside #content, see
// index.html) so it survives every navigate() re-render untouched.
// Playback keeps going no matter what page is open; only closing the
// bar itself (or the tab) stops it.
// ═══════════════════════════════════════════
const audioEl = new Audio();
let audioState = {
  current: null,      // { ref, path, name }
  queue: [],           // [{ ref, path, name }, ...] — plays next, in order
  minimized: false,
  siblingsOpen: false,
};
audioEl.addEventListener('ended', () => audioPlayNext());
audioEl.addEventListener('timeupdate', () => updateAudioProgressUI());
audioEl.addEventListener('loadedmetadata', () => updateAudioProgressUI());

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
  // after pause()+removeAttribute('src') alone — load() forces the
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
    el('div', { style: 'font-weight:700;margin-bottom:6px', text: '🎵 More in this folder' }),
    ...(data.items.length ? data.items.map(it => el('div', { class: 'fe-menu-item', text: it.name }, )) : [el('div', { class: 'text-dim text-sm', text: 'No other audio files here.' })])
  ]);
  // Wire click handlers separately (avoids re-declaring el() children with closures over `it` awkwardly above)
  data.items.forEach((it, i) => {
    box.children[i + 1].onclick = () => { playAudioTrack(audioState.current.ref, it.path, it.name); box.remove(); };
    box.children[i + 1].style.cursor = 'pointer';
    box.children[i + 1].appendChild(el('button', { class: 'btn btn-sm btn-outline', style: 'float:right', text: '➕', title: 'Add to queue', onclick: (e) => { e.stopPropagation(); audioQueueAdd({ ref: audioState.current.ref, path: it.path, name: it.name }); } }));
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
      el('span', { text: '🎵' }),
      el('span', { class: 'truncate', style: 'max-width:160px', text: audioState.current.name }),
      el('button', { class: 'btn btn-sm btn-outline', id: 'audioPlayBtn', text: audioEl.paused ? '▶' : '⏸', onclick: audioTogglePlay }),
      el('button', { class: 'btn btn-sm btn-outline', text: '⤢', title: 'Expand', onclick: () => { audioState.minimized = false; renderAudioPlayerBar(); } })
    ]));
    return;
  }

  bar.appendChild(el('div', { class: 'audio-bar-top' }, [
    el('div', { class: 'audio-bar-track-info' }, [
      el('span', { text: '🎵' }),
      el('span', { class: 'truncate', text: audioState.current.name })
    ]),
    el('div', { class: 'row', style: 'gap:4px' }, [
      el('button', { class: 'btn btn-sm btn-outline', text: '⋮', title: 'More from this folder / queue', onclick: toggleAudioSiblingsDropdown }),
      el('button', { class: 'btn btn-sm btn-outline', text: '−', title: 'Minimize', onclick: () => { audioState.minimized = true; renderAudioPlayerBar(); } }),
      el('button', { class: 'btn btn-sm btn-outline', text: '✕', title: 'Close', onclick: audioStopAndClose })
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
        el('span', { style: 'cursor:pointer;margin-left:6px;opacity:.7', text: '✕', onclick: () => audioQueueRemove(i) })
      ]))
    ]));
  }
  updateAudioProgressUI();
}

// ── Init ──
async function init() {
  const versionLabel = $('#appVersionLabel');
  if (versionLabel) versionLabel.textContent = ` v${APP_VERSION}`;
  // Non-fatal: just a console heads-up if the two files were bumped out
  // of sync with each other, since they're edited independently.
  api('/api/version').then(v => {
    if (v?.version && v.version !== APP_VERSION) {
      console.warn(`Frontend/backend version mismatch: app.js APP_VERSION=${APP_VERSION}, server.py APP_VERSION=${v.version}`);
    }
  }).catch(() => {});
  await loadProfiles();
  if (currentProfile) {
    await loadConfig();
    try { await api(`/api/${currentProfile}/attendance/autofill`, { method: 'POST' }); } catch (e) { /* non-fatal */ }
    await loadData();
    await loadGamification({ showCheckIn: true });
    await refreshActiveTimerFromServer();
    lastKnownLevel = gamification?.level ?? null;
    lastKnownXp = gamification?.xp ?? null;
    lastKnownNerds = gamification?.nerds ?? null;
  }
  loadTheme();
  updateTopLevelBar();
  updateNerdsBadge();
  render();
  // Local-only 1s tick that repaints the visible clock numbers from
  // whatever `activeTimer` currently holds — no network call, purely
  // local math against wall-clock time.
  setInterval(paintTimerNumbers, UI_MINI_TIMER_TICK_MS);
}

init();
