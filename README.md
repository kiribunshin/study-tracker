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

### v2.0 - The Botany Update:
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

### v2.1 changes:
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

### v2.2.0 changes:
This patch brings a whopping 31 new plants, now reaching a total of 32. Some bugs were patched.
- Added: Over 31 new plants with distinct bonuses and mechanics aiming for maximum uniqueness.
- Added: Plant Harvest: You can now harvest fruit from all of your plants once they are fully matured and every ~5 growth hours. (Susceptible to change - aka reductions - through specific plant buffs.) 
- Added: `Plant Collections`: Collect multiple plants of the same category and level them up to their max level to earn a powerful permanent buff.
- Added: `Inventory Slots`: You now start with 20 inventory slots and can purchase more slots with increasing amounts of Nerds. Any event that would use up an inventory slot now gets outright refused when all inventory slots are full.
- Changed: Exposed the version variable at the top of app.js and server.py for easier maintenance.  

There are still a few bugs (stretched out textures, missing fruit textures, raw variables written in frontend instead of formatted text) but I wanted to push this out so the main features are there quicker.  

A lot of plants are planned for the future so stay tuned.