# 🌶 Hot Sauce Event Finder

A web app that scrapes event details from drinkeatrelax.com so you can quickly find vendor opportunities without manually reading every page.

---

## Setup (one time only)

### 1. Install Node.js
Download and install from: https://nodejs.org  
Pick the **LTS** version (the recommended one).

### 2. Open this folder in VS Code
- Open VS Code
- Go to **File → Open Folder** and select the `hotsauce-event-finder` folder

### 3. Open the terminal in VS Code
- Go to **Terminal → New Terminal** (or press `` Ctrl + ` ``)

### 4. Install dependencies
In the terminal, type:
```
npm install
```
Wait for it to finish (takes about 30 seconds).

---

## Running the app

In the VS Code terminal, type:
```
npm start
```

You'll see:
```
🌶  Hot Sauce Event Finder running!
   Open in browser: http://localhost:3000
```

Open your browser and go to: **http://localhost:3000**

---

## How to use

1. Go to **drinkeatrelax.com/events** and browse events by category
2. Click on any event you're interested in
3. Copy the URL from your browser's address bar
4. Paste it into the app and hit **Scan**
5. The app will extract: event name, date, time, venue, cost, attendance, health permit info, vendor requirements, and contact info
6. Hit **Save to history** to keep track of it
7. Use **Mark interest** to flag events as Maybe / Interested / Skip
8. Export everything to CSV from the **Saved events** tab

### Quick links built into the app:
- Beer, Bourbon & BBQ festivals
- Wine & Food festivals  
- Tacos N' Taps
- Oktoberfest
- Oyster Festival
- 2026 Season Schedule PDF

---

## Stopping the app
In the terminal, press `Ctrl + C`

## Running again later
Just open the terminal in VS Code and type `npm start` again.

---

## Project structure
```
hotsauce-event-finder/
├── src/
│   └── server.js      ← Backend (scrapes the website)
├── public/
│   └── index.html     ← Frontend (what you see in the browser)
├── package.json
└── README.md
```
