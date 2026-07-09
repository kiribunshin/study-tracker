# StudyTracker

A personal study tracker I built for myself because I wanted something that actually understands my schedule instead of a generic to-do app.

## What it does

- Tracks self-study sessions (with a free timer or Pomodoro mode), attendance, exams, and one-off events like meetings
- Turns your studying into a little RPG — XP, levels, a 10-tier badge system (Bachelor's → Master's → PhD → Laureate), weekly quests, streaks
- Unlockable themes as you level up (15 of them, from clean and minimal to full cyberpunk)
- A real weekly timetable that auto-fills from your class schedule and shows your logged sessions, exams, and meetings side by side
- Smart recommendations — a small ML model (that you can turn off if it stresses you out) predicts exam scores and flags subjects you're neglecting
- Seaborn-rendered charts and a downloadable weekly PDF report, both themed to match whatever look you've got active
- Presence/absence auto-fill so you're not manually marking every single class you attend

## Stack

Flask backend, vanilla JS/HTML/CSS frontend, no framework bloat. Runs locally via `start.bat`.

## Status

v1.1, actively used daily, still getting bug-fixed and tuned as I find rough edges:


- Changed: Badge/mastery tier system renamed: Bachelor's I–III → Master's I–III → PhD I–III → Laureate (10 tiers total), propagated through backend and frontend
- Changed: Achievement tooltips replaced with custom DOM-based tooltips (with tier-color accents) instead of native browser title attributes
- Fixed: Seaborn chart/PDF colors synced to active theme via THEME_PALETTES dictionary
- Fixed: missing /api/<name>/data GET endpoint (root cause of all empty views)
- Fixed: el('tbody', {}, ...array.map()) spread-operator bug (truncated table rows to one entry)
- Fixed: boolean-attribute bug in el() helper (setAttribute('disabled', false) still disabled elements — broke theme dropdown)
- Fixed: timer state destroyed on navigation (moved outside render closure)
- Fixed: Pomodoro Math.max(1, doneMin) forced minimum per skipped block
- Fixed: delete operation wiping all records (cascade issue) — added /api/<name>/undo_delete trash system with rolling .bak backups
- Fixed: timetable self-study block placed at current time instead of session start time
- Added: logged self-study sessions displayed in Timetable calendar
- Added: presence/absence attendance default mode with auto-fill
- Added: free timer pause/resume
- Added: Locked theme preview (click to preview without unlocking, "Exit Preview" banner, auto-revert)
- Added: ML prediction on/off toggle
- Added: scrollable Skills lists; stat-card accent bar CSS fix; capped horizontal bar chart heights; per-subject baseline vs. per-session difficulty clarified in Settings UI
- Removed leisure tracking entirely from backend endpoints, XP formula, badges, quests, stats payload, charts, PDF report, navigation, and frontend (bad implementation and adds uneccessary tedium)
