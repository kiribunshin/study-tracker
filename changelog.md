# v1.2 changes:
- Added the control panel in code for easier debugging and feature optimization.
- Added batch command slogan.

---

# v1.1.1 changes:
- Preview lock: previewing a locked theme now drops a full-screen click-swallowing overlay over the app (`#previewLockOverlay`), so nav buttons, cards, everything underneath is frozen. Only the "Exit Preview" banner (raised above the overlay in z-index) stays clickable.
- Removed the topbar theme `<select>` dropdown and the xpBadge level slider.

---

# v1.1 changes:
- Changed: Badge/mastery tier system renamed: Bachelor's I–III → Master's I–III → PhD I–III → Laureate (10 tiers total), propagated through backend and frontend
- Changed: Achievement tooltips replaced with custom DOM-based tooltips (with tier-color accents) instead of native browser title attributes
- Fixed: Seaborn chart/PDF colors synced to active theme via `THEME_PALETTES` dictionary
- Fixed: missing `/api/<name>/data` GET endpoint (root cause of all empty views)
- Fixed: `el('tbody', {}, ...array.map())` spread-operator bug (truncated table rows to one entry)
- Fixed: boolean-attribute bug in `el()` helper (`setAttribute('disabled', false)` still disabled elements — broke theme dropdown)
- Fixed: timer state destroyed on navigation (moved outside render closure)
- Fixed: Pomodoro `Math.max(1, doneMin)` forced minimum per skipped block
- Fixed: delete operation wiping all records (cascade issue) — added `/api/<name>/undo_delete` trash system with rolling `.bak` backups
- Fixed: timetable self-study block placed at current time instead of session start time
- Added: logged self-study sessions displayed in Timetable calendar
- Added: presence/absence attendance default mode with auto-fill
- Added: free timer pause/resume
- Added: Locked theme preview (click to preview without unlocking, "Exit Preview" banner, auto-revert)
- Added: ML prediction on/off toggle
- Added: scrollable Skills lists; stat-card accent bar CSS fix; capped horizontal bar chart heights; per-subject baseline vs. per-session difficulty clarified in Settings UI
- Removed leisure tracking entirely from backend endpoints, XP formula, badges, quests, stats payload, charts, PDF report, navigation, and frontend (bad implementation and adds uneccessary tedium)
