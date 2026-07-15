# v2.1 changes:
This patch comes with many fixes to bugs in v2.0 as well as inherited bugs from previous versions.
- Added: Clementine's Book of Wonders now lists all the hours needed for plant levels as well as the significance of their respective bonuses.
- Added: Plant neglect:
    - Global neglect: This kicks in when it's been 14 days since the last logged session, applying a 25% reduction to all plant passive Nerds yield.
    - Specific neglect: A plant that hasn't gotten care (growth hours) in a specific amount of days begins producing Nerds at an extremely reduced rate. This scales with the number of plants you own as to not feel overwhelming.
- Added: `Finance` - You can see when and where you got all your Nerds.
- Added: Teacher/Professor absence can now be marked in lessons and the stats will handle it accordingly.
- Changed: A plant must be selected (specified) in the Botanarium so that study hours count towards its growth hours. Otherwise, either the most recently incremented plant or a random plant will be selected automatically for growth.
- Changed: The fertilizer is now a temporary system, requiring renewal for its effects to still be implemented.
- Changed: Made it clearer when adding multiple of the same lesson-type per week.
- Changed: Renamed Cours/TD/TP to their English alternatives: Lesson/Practical Work/Lab.
- Fixed: Adding a note as the timer ends should now work - it previously did not save.
- Fixed: When editing a present note, its current text will be displayed as it would in a normal text editor.
- Fixed: When an old self-study session is logged, the time is now specified as `Start Time` and should display correctly in the timetable.
- Fixed: Studying past midnight should now display normally in the timetable.
- Fixed: "Partial" now appears as yellow under the `Recent Activity` section of the `Dashboard`.

---

# v2.0 - The Botany Update:
- Added: The Botanarium - A space where the plant lover in you can thrive:
    - Care for plants: You can buy seeds and grow plants through hours studied.
    - Watch them blossom: Each plant has its unique sprites, allowing you to watch it grow from a seed to a blossoming beauty (Level 1 → Level 5).
    - Benefit from them: Each plant passively generates Nerds and gives unique themed bonuses and buffs depending on its growth stage.
    - Go far and beyond: Beyond level 5, plants can Prestige: Prestige levels require a lot of study rewards and offer points that you can spend to increase a plant's bonuses.
    - The Botanarium Bank: Passive Nerd generation has a daily limit imposed by the Botanarium Bank. Level it up through lifetime study hours and Nerds to increase the daily cap.
    - Clementine's Book of Wonders: Clementine, our PhD. Botanist, has blessed us with her Book of Wonders - Access it to know more about each plant you have and understand the origin of its unique bonuses.
    - Added: Watermelon, a summer fruit with uniquely themed bonuses - it can bring a lot of value to your summer work sessions!
-  Added: Inventory & Shop: As a result of your operations in the Botanarium, you may acquire items which can be bought (or sold for a chunk of change).
- Added: Theme Shop: A shop with purchasable themes distinct from those you are able to acquire through level-ups.
- Changed: Nerds now have a unique rotating coin icon instead of a coin emoji.
- Changed: Skill Categories are now more meaningful than just text: They can be assigned or selected through a drop down and are now part of the progression system, gaining hours from all the skills that fall under their jurisdiction (i.e. French and Japanese would both contribute to the progression of a Languages category).
- Changed: Adding an older self-study record now prompts you for the time the study session was had, and defaults to the current hour and minute.
- Fixed: At times, the website would require a manual refresh to register changes to any gamification-related data, added a `loadConfigAndGamification()` helper that is wired into `Add Subject`, `Add Skill`, `Add Category`, `Delete Subject` and `Delete Skill`. Progression should now update immediately and seamlessly.

---

# v1.3.1 changes:
- Fixed: timetable study/break distinction bug

---

# v1.3 changes:
- Added: Economy Update:
    - Earn the currency, Nerds, through hours spent studying (similar formula to XP gained) and as a bonus for level-ups and reaching higher mastery tiers in different subjects/skills. The currency is, for now, useless, but can be accumulated for planned future additions.
    - The difficulty of the study/work session has a positive correlation with Nerds earned: up to a 50% bonus in Nerds earned for the most difficult of work sessions!
-  The timetable now displays break segments as well as work segments, this is meant to better visually communicate the real time spent working for any work session. All pre-saved study entries prior to this update will import as the classic single block in the timetable.

---

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
