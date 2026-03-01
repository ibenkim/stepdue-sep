# stepdue — Complete App Specification

## What It Is
Chrome extension + Azure backend. Real-time browsing accountability tool for students. Tracks time on websites during study sessions, classifies sites as distractions/on-task/utility, shows live visualization bar on every webpage, stores sessions in cloud, provides analytics dashboard.

## Architecture Overview
- **Chrome Extension (Manifest v3)**: service worker (background.js), side panel UI (popup/), content script injected on every page (content/)
- **Azure Functions (Node.js)**: REST API for session storage/retrieval/classification
- **Azure Blob Storage**: persistent session data per device
- **Azure Static Web App**: hosted report pages (session detail, overview, analytics)

## Extension Components

### background.js (service worker, 450 lines)
Core engine. Manages session lifecycle, domain classification, segment tracking.

**Session lifecycle:**
1. User clicks "Lock In" → stores startTime, creates first segment for current tab, sets lockedIn=true, starts 1-sec alarm
2. Tab switches/URL changes → ends current segment, starts new one with new domain+color
3. Every 1 sec → broadcasts bar data (fisheye-weighted segments) to all content scripts
4. User clicks "Stop" → ends session, builds report, POSTs to Azure (fire-and-forget), saves locally

**Domain classification — 4 default categories:**
- RED (Distractions): youtube.com, reddit.com, twitter.com, x.com, tiktok.com, instagram.com, facebook.com, twitch.tv, netflix.com, hulu.com, disneyplus.com
- GREEN (On-Task): docs.google.com, notion.so, quizlet.com, khanacademy.org, coursera.org, edx.org, canvas.instructure.com, scholar.google.com, github.com, stackoverflow.com, wolframalpha.com, desmos.com, overleaf.com
- YELLOW (Utility): mail.google.com, gmail.com, calendar.google.com, outlook.com, drive.google.com, slack.com, discord.com, zoom.us, meet.google.com, google.com, wikipedia.org
- GRAY (Unclassified): anything not in above lists

**Keyword-based reclassification (for ambiguous domains like YouTube):**
- GREEN keywords: tutorial, lecture, explained, how to, learn, course, university, professor, calculus, chemistry, biology, history of, programming, algorithm, math, physics, documentation, lesson, study guide, textbook, science, engineering, medicine, anatomy, economics, linguistics, machine learning, data science, research, analysis, introduction to, overview of, mit, stanford, harvard, crash course, full course, complete guide
- RED keywords: gaming, funny, fails, reaction, vlog, challenge, meme, prank, compilation, minecraft, fortnite, stream highlights, unboxing, roast, best moments, highlights reel, let's play, gameplay

**Device identification:** random UUID generated on install, stored in chrome.storage.local. No user accounts/login.

**Chrome API listeners:**
- `chrome.tabs.onActivated` → tab switch → new segment
- `chrome.tabs.onUpdated` → URL change → new segment
- `chrome.alarms.onAlarm` → 1-sec tick → broadcast bar data
- `chrome.runtime.onMessage` → handles EPOCH_GET_STATE, EPOCH_LOCK_IN, EPOCH_LOCK_OUT, EPOCH_GET_ANALYTICS
- `chrome.storage.onChanged` → category updates → rebroadcast

**Constants:**
- API base: `https://epoch-api-kyl.azurewebsites.net`
- Content classification cache: 500 entries max

### content/content.js (369 lines) — Live Visualization Bar
Renders real-time colored bar at top of every webpage using shadow DOM.

**Bar behavior:**
- 6px height, fixed top, z-index 2147483647 (max)
- Colored segments show browsing history during session
- Fisheye weighting: recent segments appear larger, older ones compress. Weight = exp(-ageSeconds / 43.3)
- Color blending: segments fade from full color toward background as they age. Right edge past 50% of bar → full color. Before 50% → fading. Min blend 0.15.
- Time markers on hover: 30s, 1m, 5m, 15m, 30m, 1h
- 60fps rendering via requestAnimationFrame
- Respects prefers-color-scheme: dark

**Color palette (RGB):**
- RED: #595A96 (89,90,150)
- GREEN: #A4A5C7 (164,165,199)
- YELLOW: #D2C8E3 (210,200,227)
- GRAY: #B5A0CE (181,160,206)
- Background blend target (light): #EFEFF8 (239,239,248)

**Messages received from service worker:**
- EPOCH_SYNC_SEGMENTS → update local segments array, render bar
- EPOCH_HIDE → stop rendering, hide bar

### popup/ — Side Panel UI (popup.html 130 lines, popup.js 763 lines, popup.css 994 lines)

**3-tab interface:**

**Session tab:**
- Lock In / Stop button (toggle)
- Timer display (MM:SS format, polls every 1 sec)
- Per-domain time chart (horizontal bars sorted by time)
- Report links after session ends: View Session Report, All Sessions, Insights

**Sites tab:**
- Current domain strip showing active tab's domain + classification color
- Drag-and-drop: drag current domain onto category to reclassify
- Category sections (collapsible) listing domains with remove buttons
- Add domain form: text input + category dropdown. Validates format: /^[\w.-]+\.[a-z]{2,}$/i
- "Add category" button → modal with name + 40-color palette picker
- "Modify list" toggle → edit mode with move-to-category dropdowns
- Edit/delete categories via modal

**Analytics tab:**
- Session start time + duration
- Activity timeline: list of domain visits with timestamps + durations
- Polls every 1 sec during active session

**Theme toggle:** light/dark mode, stored in chrome.storage.local
**Toast notifications:** fixed bottom-center, auto-hide 2s

**Report URLs base:** `https://green-bush-0a2c6481e.1.azurestaticapps.net`

## Azure Backend

### API Endpoints (azure/api/)

| Method | Route | Purpose |
|--------|-------|---------|
| POST | /api/sessions | Save session report to blob storage |
| GET | /api/sessions?deviceId=X | Get device's session index (list of summaries) |
| GET | /api/sessions/{deviceId}/{id} | Get full session report by ID |
| POST | /api/classify | Classify page content (YouTube API + keyword fallback) |

All endpoints: anonymous auth, CORS allow-origin *.

**POST /api/sessions:**
- Receives full session report JSON
- Saves to blob: `sessions/{deviceId}/{id}.json`
- Updates device index: `sessions/{deviceId}/index.json` (prepends new entry, newest first)
- Index entry = subset: { id, sessionStart, sessionEnd, totalMs, categorySummary, createdAt }

**POST /api/classify:**
- Input: { title, url, domain }
- YouTube videos (domain=youtube.com + has video ID): calls YouTube Data API v3, maps categoryId 26/27/28→GREEN, 25→YELLOW, others→RED
- Non-YouTube or no API key: keyword matching against title
- Returns { category, source }

**Dependencies:** @azure/functions ^4.5.0, @azure/storage-blob ^12.26.0
**Storage account:** epochstoragekyl (Azure Blob Storage)
**Container:** sessions

### Static Web App (azure/app/)

**report/session.html (268 lines) — Single Session Report**
- URL params: id, deviceId
- Fetches GET /api/sessions/{deviceId}/{id}
- Shows: date, start time, duration, stacked category bar with legend+percentages, top 10 domains with horizontal bars, full activity timeline

**report/overview.html (258 lines) — All Sessions**
- URL param: deviceId
- Fetches GET /api/sessions?deviceId={deviceId}
- Shows: total sessions count, total focus time (green+yellow), avg session duration, aggregated time distribution bar, session list with mini bar charts (clickable → session.html)

**report/analytics.html (637 lines) — Advanced Analytics**
- URL param: deviceId
- Phase 1 (from index): session count, total focus time (green only), avg duration, avg focus score, total distraction time, focus score trend (last 30 sessions as vertical bars), time distribution, best time of day (hour buckets), day of week patterns
- Phase 2 (async, fetches top 20 full sessions): top 10 distractor domains, distraction patterns (early/middle/late in session)
- Focus score formula: (green / (green + red)) * 100
- Score colors: green ≥70%, yellow 40-70%, red <40%

**staticwebapp.config.json:** SPA fallback to index.html except /report/* routes. Cache-Control: no-cache.

## Data Models

**Session Report (full):**
```
{
  id: UUID,
  deviceId: UUID,
  sessionStart: ms_timestamp,
  sessionEnd: ms_timestamp,
  totalMs: number,
  categorySummary: { red: ms, green: ms, yellow: ms, gray: ms },
  perDomain: [{ domain, color, totalMs, visitCount }],
  segments: [{ domain, color, start: ms, end: ms }],
  createdAt: ISO-8601
}
```

**Category (user-configurable):**
```
{
  id: string,        // "red", "green", "yellow", "gray", or "cat_<timestamp>"
  name: string,      // "Distractions", "On-Task", etc.
  color: hex_string, // "#595A96"
  domains: string[]  // ["youtube.com", "reddit.com"]
}
```

**Segment (live, in-memory):**
```
{ color, domain, start: ms, end: ms|null }
```

## Chrome Storage Schema
```
sessions: array              // previous session reports (local backup)
settings: { enabled: bool }
categories: array            // user category configs
lockedIn: boolean
deviceId: UUID
contentClassifications: {}   // cache {key: color}
sessionData_live: object     // current session (survives service worker restart)
lastSessionId: string
theme: "light" | "dark"
```

## Permissions
- tabs: query active tabs
- storage: chrome.storage.local
- alarms: 1-sec tick
- sidePanel: side panel UI
- host_permissions: *.azurewebsites.net/*, *.azurestaticapps.net/*

## UI Colors
- Primary purple: #595A96 (light) / #8686C0 (dark)
- 40-color palette for custom categories (purples, blues, greens, yellows, reds, pinks)

## Key Technical Details
- No user auth. Device UUID only.
- Fisheye bar algorithm: exponential decay weighting makes recent browsing visually dominant
- Content script uses shadow DOM for style isolation from host page
- Service worker persists sessionData_live to storage to survive Chrome killing the worker
- Reports load in two phases (analytics.html): fast index-based stats first, then async full-session fetches for detailed analysis
- Side panel polls service worker every 1 sec during active session
- Session POSTs to Azure are fire-and-forget (non-blocking)
- All report pages share same color scheme and formatting functions

## File Inventory
```
manifest.json                           — extension config, permissions, component registration
background.js                           — service worker: session tracking, classification, API calls
content/content.js                      — injected bar renderer (shadow DOM, fisheye, 60fps)
content/content.css                     — fallback bar styles
popup/popup.html                        — side panel markup (3 tabs, modal, theme toggle)
popup/popup.js                          — side panel logic (session control, site management, analytics)
popup/popup.css                         — side panel styles (light/dark themes, 994 lines)
azure/api/index.js                      — function registration entry point
azure/api/package.json                  — deps: @azure/functions, @azure/storage-blob
azure/api/host.json                     — Azure Functions runtime config
azure/api/local.settings.json           — local dev storage connection string
azure/api/keywords.json                 — centralized keyword lists (green/red)
azure/api/src/functions/sessions.js     — POST/GET session endpoints
azure/api/src/functions/session.js      — GET single session endpoint
azure/api/src/functions/classify.js     — content classification endpoint
azure/app/index.html                    — redirect to overview.html
azure/app/staticwebapp.config.json      — SWA routing config
azure/app/report/session.html           — single session report page
azure/app/report/overview.html          — all sessions overview page
azure/app/report/analytics.html         — advanced analytics dashboard
icon.png                                — extension icon
.env                                    — Azure subscription/tenant IDs
.gitignore                              — git ignore rules
```
