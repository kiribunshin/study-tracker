<div align="center">

```
 ░█▀▀░█░█░█░░░▀█▀░▀█▀░█░█░█▀█░█▀▄
 ░█░░░█░█░█░░░░█░░░█░░▀▄▀░█▀█░█▀▄
 ░▀▀▀░▀▀▀░▀▀▀░░▀░░▀▀▀░░▀░░▀░▀░▀░▀
   live to love · love to learn · learn to live
```

![Version](https://img.shields.io/badge/version-3.0.0-00e5ff?style=for-the-badge)
![Python](https://img.shields.io/badge/python-3.10+-3776AB?style=for-the-badge&logo=python&logoColor=white)
![Flask](https://img.shields.io/badge/flask-backend-000000?style=for-the-badge&logo=flask&logoColor=white)
![JavaScript](https://img.shields.io/badge/vanilla_JS-no_framework-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)
![Platform](https://img.shields.io/badge/Windows_%7C_Linux-desktop-7c3aed?style=for-the-badge)
![Local](https://img.shields.io/badge/100%25-local_%26_offline--first-39ff8f?style=for-the-badge)

**A desktop study tracker that understands your timetable, turns your effort into XP, and then gives that effort something to *build*.**

</div>

---

## What is Cultivar?

I built Cultivar for myself because generic to-do apps don't know what guided work, a lab, or an exam period is. It started as a timetable-aware study tracker and grew into a full game layer on top of real work: **every hour you study feeds a progression system, a garden, a factory and a stock market.** Study more, build more. Nothing is simulated without effort behind it.

It runs as a native desktop window (`pywebview`), the server only ever listens on `127.0.0.1`, and your data stays in plain JSON files on your machine.

## Features

### The study core
- **Focus timer**: free timer or full Pomodoro, shared server-side so it survives restarts. Sessions are split into study/break segments and drawn on your timetable.
- **A real timetable**: recurring lessons (weekly, biweekly, every 3 weeks, monthly) with Lesson / Guided Work / Lab types, academic years, exam periods, vacations and global holidays. Past classes auto-fill attendance based on whether you're "mostly present" or "mostly absent", so you only log exceptions. Teacher absentions never count against you.
- **Exams and events**: scored out of 20, with ranking, and one-off meetings/workshops on the same calendar.
- **Smart recommendations**: a small regression model trained on *your own* exam history predicts scores and ranks subjects by urgency; spaced-repetition nudges and attendance warnings sit alongside it. Don't like predictions? One toggle turns the ML off.
- **File Explorer** per subject/skill: PDF reader (own engine with search, outline, thumbnails, notes, resume-where-you-left), EPUB reader, video player with timestamped notes, audio player with queue, and an in-app Markdown/code editor with live syntax highlighting.

### The RPG layer
- **XP and uncapped levels**, weighted by difficulty and session quality, with titles that climb as you do.
- **Many achievements** and **mastery for every subject, skill and category**, all on a 10-tier ladder: *Bachelor's I-III → Master's I-III → PhD I-III → Laureate*.
- **Weekly quests, login streaks, study streaks**, and **Nerds**, the spendable currency, with a full **Finance Ledger** showing every gain and spend by day.
- **Customization**: You decide what your subjects, skills and their respective categories are. No presets and pre-builds, you are your own judge.

### The Botanarium
- **32 plants** (watermelon, potatoes, peppers, squashes, alliums, roots, corn and more), each with **unique level bonuses** that react to *how* you study: season, time of day, session length, difficulty, streaks.
- One plant grows at a time from your study hours. Fertilize it, harvest fruit at max level, then push into **Prestige tiers** and spend points on its bonuses.
- Plants generate passive Nerds through the **Botanarium Bank**, wilt if neglected, and complete **themed collections** (Potato Cellar, Pepper Rack, Melon Patch...) that amplify each other.
- **Clementine's Book of Wonders** is the in-game plant encyclopedia, with classification, history and fun facts.

### The Industrial system
- A card-based production line (think Minecraft/Factorio/RimWorld logic, minus the grid): **miners and foresters** upgrade up a tool ladder from bare hands to planetary mining systems.
- A **200+ node tech tree** whose research is paid in **your real study hours**.
- **Warehouses, a shared power grid, fuel-burning generators, and processors** that build exact quantities via production requests, from Brickworks and smelters up to vehicles, electronics, CPUs and tanks.
- A built-in **Wiki** documents every item, recipe and machine.

### The Stock Market
- An **in-universe retro computer** with a boot sequence, windows, and three apps: **Internet** (daily world news), **Stock Market** and **Info**.
- Every item you produce is a commodity with **seasonal cycles, daily world events** (wars, strikes, breakthroughs), **supply-chain pass-through**, substitute goods, a daily **Exchange Spotlight**, and slippage when you dump too much.

### Themes and polish
- **25+ themes** unlocked by level or bought with Nerds, from clean light/dark to cyberpunk circuit boards. Premium ones add particle engines, animated sprites, video backgrounds, ambient audio, page-transition effects and small **gameplay perks**.
- **Seaborn charts** and a downloadable **weekly PDF report**, both themed to whatever look is active.
- **One-click updater** from GitHub, safe for your saves.

### Open-source and open to suggestions
- Suggestions that make it into the app will add you to the growing hall of fame.

## Stack

Flask backend · vanilla JS/HTML/CSS frontend · pywebview desktop shell · scikit-learn · seaborn/matplotlib · pdf.js, marked, highlight.js, epub.js. No frontend framework, no cloud, no account.

## Run it

```bash
# Windows
start.bat

# Linux - still very experimental and prone to errors
./start.sh
```

Dependencies are checked and installed automatically on first launch.

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
