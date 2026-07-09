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

v1.1, actively used daily, still getting bug-fixed and tuned as I find rough edges.
