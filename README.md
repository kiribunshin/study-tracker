# Cultivar

A personal study tracker I built for myself because I wanted something that actually understands my schedule instead of a generic to-do app.

## What it does

- Tracks habits, skills and study sessions (with a free timer or Pomodoro mode), attendance, exams, and one-off events like meetings
- Turns your studying into an RPG: XP, levels, a 10-tier badge system (Bachelor's I/II/III → Master's I/II/III → PhD I/II/III → Laureate), weekly quests, streaks
- Buy and level up over 32 plants with unique and special bonuses in the flagship Botanarium, learn more about them in Clementine's Book of Wonders!
- A proper industrial system akin to that of Minecraft, Factorio, RimWorld, etc..
- Tracks habits, skills and study sessions (with a free timer or Pomodoro mode), attendance, exams, and one-off events like meetings
- Turns your studying into an RPG: XP, levels, a 10-tier badge system (Bachelor's I/II/III → Master's I/II/III → PhD I/II/III → Laureate), weekly quests, streaks
- Buy and level up over 32 plants with unique and special bonuses in the flagship Botanarium, learn more about them in Clementine's Book of Wonders!
- Unlockable themes as you level up (15 of them, from clean and minimal to full cyberpunk)
- A real weekly timetable that auto-fills from your class schedule and shows your logged sessions, exams, and meetings side by side
- Smart recommendations: A small ML model (that you can turn off if it stresses you out) predicts exam scores and flags subjects you're neglecting
- Seaborn-rendered charts and a downloadable weekly PDF report, both themed to match whatever look you've got active and packed with informative graphs that help shed light on your next step

## Stack

Flask backend, vanilla JS/HTML/CSS frontend, no framework bloat. Runs locally via `start.bat`.

## Status

### v3.0.0 Major Update:
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
