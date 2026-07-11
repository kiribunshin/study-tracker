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

#### v2.0 - The Botany Update:
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