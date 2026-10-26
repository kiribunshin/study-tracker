# v3.0.0 Major Update:
This update has been in the works for THREE WHOLE MONTHS, and coincidentally, it is v3!  
It comes packed with a visual rework of the app, adding multiple new systems and tens of QoL updates:
- Added: `Industrial` expansion:
    - A brand new area of the app that allows for infinite creativity, planning and profits!   
      Step in the shoes of inventors and recreate the world as we know it today...
    - You can harvest wood and all sorts of rocks, minerals and elements through the use of ever-expanding tools and machinery!
    - Keep up with the energy requirements of your machinery.
    - You can use the resources you harvested to produce MANY things that can later be processed even further or sold for profit in the `Stock Market`.
    - Invest your focus hours as a currency in the `Tech Tree` to unlock more resources, processes and productivity bonuses!
    - The list of things that can be crafted will be expanded as time goes on and hopefully encompass all fields of human endeavour! 
- Added: `Stock Market`:
    - An OS-like interface that behaves as a tablet with 3 apps: `Stock Market`, `Internet` and `Info`.
    - The `Stock Market` is a dynamic market that evolves cyclically over time and reacts to world events!
    - Prices of all goods in the app are determined here.
    - Sales of large volumes of goods negatively impacts its price.
    - Built-in projection system to help you decide: Sell or keep?
    - The `Internet` lists current news to understand what good's prices are impacted and *why*.

- Added: Audio engine: 
    - 4 gentle fantasy-like tunes in the background that set the mood and do not serve as a distraction from the main purpose of the app (studying). 
    - A dedicated mute button and audio slider.
- Added: Audio, video and PDF time on the `Files` menu is tracked and displayed in the stats area, as well as time on all sections of the app.
- Added: A Hall of Fame where people who have contributed one way or the other towards the development of the app are honored and immortalized.
- Added: A `Claim All` button in the botanarium.

---

- Changed: Reworked the theme system:
    - 26 presently-available themes - themes have their own: color palette, background picture, special effects during browsing, transition effects, etc..
    - Of the 26 available themes, 5 are premium themes - offering more specialized effects, custom bonuses and their own purchasable background video/audio. The audio is less entertainment and more "immersion"; it tries to convey the idea that you really are within the universe the theme is communicating. (a black hole, the embers left in the wake of a phoenix, a tax office from the medieval ages, etc...)
    - Themes now have their own cards in the progression area, ensuring aesthetics and functionality (static picture/video control and theme-specific audio control)
    - Many can now be acquired through the shop interface (same for upgrading the premium ones)
    - A few hidden themes still only in code, locked until a future update...
- Changed: Navbar:
    - Changed the order of menus to allow for the more relevant ones to appear first.
    - Traveling-dot indicator.
    - Underline/glow.
    - Overflowing items on smaller displays collapse into a "More" dropdown menu instead of shrinking in size.
- Changed: Reworked the files system:
    - `.pdf` reading is now through js instead of the built-in browser `.pdf` reader, allowing for more customization and better features including but not limited to: 
        - The `notes` area when reading a `.pdf` is now collapsible to allow the file itself to take up more space.
        - A button when reading `.pdf` files to invert colors for night mode.
        - Browsing the `.pdf` by thumbnails/sections.
        - Downloading and printing the `.pdf` is also present.
        - Resume a `.pdf` where you last left off.
- Changed: Major upgrades to the scheduling, holidays, the adding of subjects and skills, etc..
- Changed: XP/Nerds toasts now have theme-colored accents.
- Changed: Prettified the plant cards in the botanarium.
- Changed: Introduced collapsible menus where necessary (infrequently-seen but voluminous blocks of text)
- Changed: Reworked the dashboard to be more aesthetic.
- Changed: File display is now alphabetical instead of 'oldest first'.
- Changed: The level card in the navbar has been made more aesthetic.
- Changed: Renamed `Self-study` to `Focus` as a step towards generalizing the app's uses.

---

- Fixed: `.pdf` files can now have `:` in their name.
- Fixed: Accented letters and other unique alphabets are now supported.
- Fixed: Bugs related to attendance.
- Fixed: Bugs related to the timetable.
- Fixed: Bugs related to registering previous `Focus` sessions.

---

- WIP: Moving on from emojis to icons. Emojis have been removed but icons are only implemented in part.

This update is so substantial it is basically a relaunch of the app, and the roadmap from here onwards is: Overhaul of the AI/ML system, reworking the stats page, adding a new major system and expanding on the current systems.  
Future updates after all the planned changes are implemented will just be expansions of the already-present and rich feature catalogue.

---

# v2.3.3 changes:
Small QoL update for the code editor:
- Changed: Editor now features rudimentary code editor features: brackets, parentheses, quotes, etc.. now feature autocomplete (writing an opening bracket automatically writes a paired closer for it). Tab now properly indents. Each parenthese/bracket/etc.. has its pair highlighted when selected. 
- Fixed: Massive bug where pop-up menus are anchored to the screen and `x` doesn't close them. `Esc` now also works to close a currently displaying tab.

---

# v2.3.2 changes:
Another hotfix patch
- Changed: Live syntax-highlighting in-editor

---

# v2.3.1 changes:
This is an emergency hotfix patch meant to address bugs in the previous v2.3 update:
- Fixed: Tiny visible area in the text editor, made it now stretch to fill its container.
- Fixed: Spaces are no longer forced to be underscores in filenames (result of `werkzeug.utils.secure_filename`)
- Fixed: Longer filenames are now permitted to be displayed.
- Fixed: The last picked theme now persists across sessions.
- Fixed: Taskbar icon now shows the app icon correctly.
- Fixed: Pillow (`PIL`) and `pywebview` install made better in `start.bat`.

---

# v2.3 changes:
- Added: `File Explorer`: Drastically improved and built upon the existing file system, now having its own section in the `navbar` and is able to:
    - Read `.pdf` files and save notes on specific pages as well as open multiple at once and split-view
    - Play audio files (multiple formats) through an audio player at the bottom and queue other audio files.
    - Play video files (multiple formats) through a video player with a timed note-taking function, allowing you to review videos later with your own time-stamped notes. (Great for longer lectures especially)
    - A rudimentary text editor that allows you to edit anything from `.txt` to `.md`, `.html`, `.css`, `.js`, `.py`, `.sh`, `.json`, etc... with syntax-highlighting and preview for `.md` files. (Richer note-taking)
- Added: `Update Checker` in the settings: You can now routinely check if you're still in sync with the repo. If you are behind, it will prompt to install the update and restart Cultivar.
- Added: `Subject Category`: Subjects can now be grouped by category.
- Changed: Officially rebranded to `Cultivar`!
- Changed: The app now launches in its own independent desktop window, no need for a browser anymore.
- Changed: The `cmd` now disappears entirely when the app is running (still yet to implement a packaged .exe, but this is a step in the right way)
- Fixed: A newly-acquired plant no longer appears as withered.
- Dropped: The idea of cross-device synced use; has proven to be far too problematic in the current architecture with a relatively unimpressive gain.

---

# v2.2.1 changes:
- Changed: Plant prices in the market are now different instead of being a constant across all plants.
- Fixed: `Plant Collections` now displays prettier, formatted text for the bonuses instead of displaying raw variable names and IDs.
- Fixed: Sprites are no longer stretched out (`object-fit: contain`).

---

# v2.2.0 changes:
This patch brings a whopping 31 new plants, now reaching a total of 32. Some bugs were patched.
- Added: Over 31 new plants with distinct bonuses and mechanics aiming for maximum uniqueness.
- Added: Plant Harvest: You can now harvest fruit from all of your plants once they are fully matured and every ~5 growth hours. (Susceptible to change - aka reductions - through specific plant buffs.) 
- Added: `Plant Collections`: Collect multiple plants of the same category and level them up to their max level to earn a powerful permanent buff.
- Added: `Inventory Slots`: You now start with 20 inventory slots and can purchase more slots with increasing amounts of Nerds. Any event that would use up an inventory slot now gets outright refused when all inventory slots are full.
- Changed: Exposed the version variable at the top of app.js and server.py for easier maintenance.  

There are still a few bugs (stretched out textures, missing fruit textures, raw variables written in frontend instead of formatted text) but I wanted to push this out so the main features are there quicker.  

A lot of plants are planned for the future so stay tuned.

---

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
