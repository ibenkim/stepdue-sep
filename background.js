// ─── Azure Config ─────────────────────────────────────────────────────────────
// Update AZURE_FUNCTION_URL after deploying your Function App
// e.g. 'https://epoch-api.azurewebsites.net'
const AZURE_FUNCTION_URL = 'https://epoch-api-kyl.azurewebsites.net';
// ──────────────────────────────────────────────────────────────────────────────

const DEFAULT_CATEGORIES = [
  {
    id: 'red', name: 'Distractions', color: '#595A96',
    domains: [
      'youtube.com', 'reddit.com', 'twitter.com', 'x.com',
      'tiktok.com', 'instagram.com', 'facebook.com', 'twitch.tv',
      'netflix.com', 'hulu.com', 'disneyplus.com'
    ]
  },
  {
    id: 'green', name: 'On-Task', color: '#A4A5C7',
    domains: [
      'docs.google.com', 'notion.so', 'quizlet.com', 'khanacademy.org',
      'coursera.org', 'edx.org', 'canvas.instructure.com',
      'scholar.google.com', 'github.com', 'stackoverflow.com',
      'wolframalpha.com', 'desmos.com', 'overleaf.com'
    ]
  },
  {
    id: 'yellow', name: 'Utility', color: '#D2C8E3',
    domains: [
      'mail.google.com', 'gmail.com', 'calendar.google.com',
      'outlook.com', 'drive.google.com', 'slack.com', 'discord.com',
      'zoom.us', 'meet.google.com', 'google.com', 'wikipedia.org'
    ]
  }
];

let sessionData = { startTime: null, segments: [] };

// Restore session data if service worker was restarted mid-session
chrome.storage.local.get(['sessionData_live', 'lockedIn']).then(({ sessionData_live, lockedIn }) => {
  if (lockedIn && sessionData_live && sessionData_live.startTime) {
    sessionData = sessionData_live;
  }
});

// Migrate old classifications format → new categories array
chrome.storage.local.get(['classifications', 'categories']).then(({ classifications, categories }) => {
  if (categories) return;
  if (classifications) {
    const migrated = DEFAULT_CATEGORIES.map(d => ({
      ...d,
      domains: classifications[d.id] || d.domains
    }));
    chrome.storage.local.set({ categories: migrated });
  }
});

function saveSessionData() {
  chrome.storage.local.set({ sessionData_live: { startTime: sessionData.startTime, segments: sessionData.segments } });
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('stepdue loaded');

  chrome.storage.local.set({
    sessions: [],
    settings: { enabled: true },
    categories: DEFAULT_CATEGORIES,
    lockedIn: false
  });

  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

async function getDeviceId() {
  const { deviceId } = await chrome.storage.local.get('deviceId');
  if (deviceId) return deviceId;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ deviceId: id });
  return id;
}

function buildSessionReport(data, deviceId) {
  const now = Date.now();
  const segments = data.segments.map(s => ({
    domain: s.domain,
    color: s.color,
    start: s.start,
    end: s.end || now
  }));

  const domainMap = new Map();
  let totalMs = 0;
  const categorySummary = {};

  for (const seg of segments) {
    if (!seg.domain) continue;
    const ms = seg.end - seg.start;
    if (ms <= 0) continue;
    totalMs += ms;
    categorySummary[seg.color] = (categorySummary[seg.color] || 0) + ms;
    if (!domainMap.has(seg.domain)) {
      domainMap.set(seg.domain, { domain: seg.domain, color: seg.color, totalMs: 0, visitCount: 0 });
    }
    const e = domainMap.get(seg.domain);
    e.totalMs += ms;
    e.visitCount++;
  }

  return {
    id: crypto.randomUUID(),
    deviceId,
    sessionStart: data.startTime,
    sessionEnd: now,
    totalMs,
    categorySummary,
    perDomain: [...domainMap.values()].sort((a, b) => b.totalMs - a.totalMs),
    segments,
    createdAt: new Date().toISOString()
  };
}

async function postSession(report) {
  if (!AZURE_FUNCTION_URL) return;
  try {
    const res = await fetch(`${AZURE_FUNCTION_URL}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report)
    });
    if (!res.ok) console.warn('[stepdue] Azure upload failed:', res.status);
  } catch {
    // Non-blocking — local storage is the fallback
  }
}

function extractDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function classifyDomain(domain, categories) {
  if (!domain) return 'gray';
  for (const cat of categories) {
    if (cat.domains && cat.domains.some(d => domain === d || domain.endsWith('.' + d))) {
      return cat.id;
    }
  }
  return 'gray';
}

async function getActiveTabInfo() {
  const { categories } = await chrome.storage.local.get('categories');
  const cats = categories || DEFAULT_CATEGORIES;
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tabs.length === 0) return { color: 'gray', domain: null, title: null, url: null };
  const tab = tabs[0];
  const domain = extractDomain(tab.url);
  return { color: classifyDomain(domain, cats), domain, title: tab.title, url: tab.url };
}

// ─── Content Classification ────────────────────────────────────────────────────

const GREEN_KEYWORDS = [
  'tutorial', 'lecture', 'explained', 'how to', 'learn', 'course',
  'university', 'professor', 'calculus', 'chemistry', 'biology',
  'history of', 'programming', 'algorithm', 'math', 'physics',
  'documentation', 'lesson', 'study guide', 'textbook', 'science',
  'engineering', 'medicine', 'anatomy', 'economics', 'linguistics',
  'machine learning', 'data science', 'research', 'analysis',
  'introduction to', 'overview of', 'mit ', 'stanford ', 'harvard ',
  'crash course', 'full course', 'complete guide'
];

const RED_KEYWORDS = [
  'gaming', 'funny', 'fails', 'reaction', 'vlog', 'challenge',
  'meme', 'prank', 'compilation', 'minecraft', 'fortnite',
  'stream highlights', 'unboxing', 'roast', 'best moments',
  'highlights reel', 'let\'s play', 'gameplay'
];

function keywordClassify(title) {
  const lower = title.toLowerCase();
  for (const kw of RED_KEYWORDS) {
    if (lower.includes(kw)) return 'red';
  }
  for (const kw of GREEN_KEYWORDS) {
    if (lower.includes(kw)) return 'green';
  }
  return null; // no match — keep domain default
}

function getContentCacheKey(domain, url) {
  if (domain === 'youtube.com' || domain === 'www.youtube.com') {
    try {
      const videoId = new URL(url).searchParams.get('v');
      return videoId ? `yt:${videoId}` : null;
    } catch { return null; }
  }
  return `url:${url}`;
}

function updateSegmentColor(segmentStart, newColor) {
  const seg = sessionData.segments.find(s => s.start === segmentStart && !s.end);
  if (!seg || seg.color === newColor) return;
  seg.color = newColor;
  saveSessionData();
  broadcastBarData();
}

async function classifyTabContent(segmentStart, domain, baseColor, title, url) {
  if (!title || !url) return;

  // Only override YouTube (always classifiable) or gray/unclassified domains
  const isYoutube = domain === 'youtube.com' || domain === 'www.youtube.com';
  if (!isYoutube && baseColor !== 'gray') return;

  const cacheKey = getContentCacheKey(domain, url);
  if (!cacheKey) return;

  // Check local cache first
  const { contentClassifications } = await chrome.storage.local.get('contentClassifications');
  const cache = contentClassifications || {};

  if (cache[cacheKey] !== undefined) {
    updateSegmentColor(segmentStart, cache[cacheKey]);
    return;
  }

  // Classify by title keywords — no API key or network call needed
  const category = keywordClassify(title);
  if (!category) return;

  // Persist to cache (cap at 500 entries)
  cache[cacheKey] = category;
  const keys = Object.keys(cache);
  if (keys.length > 500) delete cache[keys[0]];
  await chrome.storage.local.set({ contentClassifications: cache });

  updateSegmentColor(segmentStart, category);
}

function buildBarData() {
  const now = Date.now();
  const segs = sessionData.segments;
  if (segs.length === 0) return { segments: [], elapsed: 0 };

  const totalElapsed = now - sessionData.startTime;
  const result = [];

  for (const seg of segs) {
    const end = seg.end || now;
    const duration = end - seg.start;
    if (duration <= 0) continue;

    const midpoint = (seg.start + end) / 2;
    const ageSeconds = (now - midpoint) / 1000;
    const weight = 1 / (1 + ageSeconds / 30);
    const flex = duration * weight;

    result.push({ color: seg.color, flex });
  }

  return { segments: result, elapsed: Math.floor(totalElapsed / 1000) };
}

async function broadcastToAll(message) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    try {
      await chrome.tabs.sendMessage(tab.id, message);
    } catch {
      // Tab may not have content script
    }
  }
}

async function broadcastBarData() {
  const { lockedIn } = await chrome.storage.local.get('lockedIn');
  if (!lockedIn) {
    await broadcastToAll({ type: 'EPOCH_HIDE' });
    return;
  }

  // Send raw segments so content.js can animate at 60fps locally
  await broadcastToAll({
    type: 'EPOCH_SYNC_SEGMENTS',
    payload: {
      startTime: sessionData.startTime,
      segments: sessionData.segments.map(s => ({
        color: s.color,
        domain: s.domain,
        start: s.start,
        end: s.end
      }))
    }
  });
}

// Tab switch — close current segment, open new one
chrome.tabs.onActivated.addListener(async () => {
  const { lockedIn } = await chrome.storage.local.get('lockedIn');
  if (!lockedIn) return;

  const now = Date.now();
  const { color: newColor, domain: newDomain, title: newTitle, url: newUrl } = await getActiveTabInfo();

  const last = sessionData.segments[sessionData.segments.length - 1];
  if (last && !last.end) last.end = now;

  sessionData.segments.push({ color: newColor, domain: newDomain, start: now, end: null });
  saveSessionData();
  broadcastBarData();
  classifyTabContent(now, newDomain, newColor, newTitle, newUrl);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url && changeInfo.status !== 'complete') return;
  const { lockedIn } = await chrome.storage.local.get('lockedIn');
  if (!lockedIn) return;

  const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (activeTabs[0]?.id !== tabId) return;

  const now = Date.now();
  const { color: newColor, domain: newDomain, title: newTitle, url: newUrl } = await getActiveTabInfo();

  const last = sessionData.segments[sessionData.segments.length - 1];
  if (last && last.color === newColor && last.domain === newDomain) return;

  if (last && !last.end) last.end = now;
  sessionData.segments.push({ color: newColor, domain: newDomain, start: now, end: null });
  saveSessionData();
  broadcastBarData();
  classifyTabContent(now, newDomain, newColor, newTitle, newUrl);
});

// 1-second tick for live updates (fisheye weights shift over time)
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'stepdue-tick') {
    broadcastBarData();
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'EPOCH_GET_STATE') {
    chrome.storage.local.get('lockedIn').then(({ lockedIn }) => {
      if (!lockedIn) {
        sendResponse(null);
      } else {
        const now = Date.now();
        const elapsed = sessionData.startTime
          ? Math.floor((now - sessionData.startTime) / 1000)
          : 0;
        sendResponse({
          startTime: sessionData.startTime,
          segments: sessionData.segments.map(s => ({
            color: s.color,
            domain: s.domain,
            start: s.start,
            end: s.end
          })),
          elapsed
        });
      }
    });
    return true;
  }

  if (msg.type === 'EPOCH_LOCK_IN') {
    const now = Date.now();

    chrome.storage.local.set({ lockedIn: true }).then(async () => {
      const { color, domain, title, url } = await getActiveTabInfo();
      sessionData = {
        startTime: now,
        segments: [{ color, domain, start: now, end: null }]
      };
      saveSessionData();
      chrome.alarms.create('stepdue-tick', { periodInMinutes: 1 / 60 });
      broadcastBarData();
      classifyTabContent(now, domain, color, title, url);
      sendResponse({ lockedIn: true });
    });
    return true;
  }

  if (msg.type === 'EPOCH_LOCK_OUT') {
    const now = Date.now();
    // Capture session before clearing
    const capturedData = {
      startTime: sessionData.startTime,
      segments: sessionData.segments.map(s => ({ ...s, end: s.end || now }))
    };

    chrome.alarms.clear('stepdue-tick');
    sessionData = { startTime: null, segments: [] };

    (async () => {
      const deviceId = await getDeviceId();
      const report = buildSessionReport(capturedData, deviceId);
      const { sessions: existing } = await chrome.storage.local.get('sessions');
      await chrome.storage.local.set({
        sessions: [...(existing || []), report],
        lockedIn: false,
        lastSessionId: report.id,
        sessionData_live: null
      });
      postSession(report); // fire and forget — non-blocking
      broadcastToAll({ type: 'EPOCH_HIDE' });
      sendResponse({ lockedIn: false, sessionId: report.id });
    })();
    return true;
  }

  if (msg.type === 'EPOCH_GET_ANALYTICS') {
    if (!sessionData.startTime) {
      sendResponse({ sessionStart: null, perDomain: [], timeline: [] });
      return true;
    }
    const now = Date.now();
    const domainMap = new Map();
    for (const seg of sessionData.segments) {
      if (!seg.domain) continue;
      const ms = (seg.end || now) - seg.start;
      if (ms <= 0) continue;
      if (!domainMap.has(seg.domain)) {
        domainMap.set(seg.domain, { domain: seg.domain, color: seg.color, totalMs: 0, visitCount: 0 });
      }
      const e = domainMap.get(seg.domain);
      e.totalMs += ms;
      e.visitCount++;
      e.color = seg.color;
    }
    const perDomain = [...domainMap.values()].sort((a, b) => b.totalMs - a.totalMs);
    const timeline = sessionData.segments
      .filter(s => s.domain)
      .map(s => ({ domain: s.domain, color: s.color, start: s.start, end: s.end || now }));
    sendResponse({ sessionStart: sessionData.startTime, perDomain, timeline });
    return true;
  }
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.categories) {
    broadcastBarData();
  }
});
