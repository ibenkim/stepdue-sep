const DEFAULT_CLASSIFICATIONS = {
  red: [
    'youtube.com', 'reddit.com', 'twitter.com', 'x.com',
    'tiktok.com', 'instagram.com', 'facebook.com', 'twitch.tv',
    'netflix.com', 'hulu.com', 'disneyplus.com'
  ],
  green: [
    'docs.google.com', 'notion.so', 'quizlet.com', 'khanacademy.org',
    'coursera.org', 'edx.org', 'canvas.instructure.com',
    'scholar.google.com', 'github.com', 'stackoverflow.com',
    'wolframalpha.com', 'desmos.com', 'overleaf.com'
  ],
  yellow: [
    'mail.google.com', 'gmail.com', 'calendar.google.com',
    'outlook.com', 'drive.google.com', 'slack.com', 'discord.com',
    'zoom.us', 'meet.google.com', 'google.com', 'wikipedia.org'
  ]
};

let sessionData = { startTime: null, segments: [] };

chrome.runtime.onInstalled.addListener(() => {
  console.log('stepdue loaded');

  chrome.storage.local.set({
    sessions: [],
    settings: { enabled: true },
    classifications: DEFAULT_CLASSIFICATIONS,
    lockedIn: false
  });

  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

function extractDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function classifyDomain(domain, classifications) {
  if (!domain) return 'gray';

  for (const [color, domains] of Object.entries(classifications)) {
    if (domains.some(d => domain === d || domain.endsWith('.' + d))) {
      return color;
    }
  }
  return 'gray';
}

async function getActiveTabInfo() {
  const { classifications } = await chrome.storage.local.get('classifications');
  const cls = classifications || DEFAULT_CLASSIFICATIONS;
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tabs.length === 0) return { color: 'gray', domain: null };
  const domain = extractDomain(tabs[0].url);
  return { color: classifyDomain(domain, cls), domain };
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
  const { color: newColor, domain: newDomain } = await getActiveTabInfo();

  const last = sessionData.segments[sessionData.segments.length - 1];
  if (last && !last.end) last.end = now;

  sessionData.segments.push({ color: newColor, domain: newDomain, start: now, end: null });
  broadcastBarData();
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url && changeInfo.status !== 'complete') return;
  const { lockedIn } = await chrome.storage.local.get('lockedIn');
  if (!lockedIn) return;

  const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (activeTabs[0]?.id !== tabId) return;

  const now = Date.now();
  const { color: newColor, domain: newDomain } = await getActiveTabInfo();

  const last = sessionData.segments[sessionData.segments.length - 1];
  if (last && last.color === newColor && last.domain === newDomain) return;

  if (last && !last.end) last.end = now;
  sessionData.segments.push({ color: newColor, domain: newDomain, start: now, end: null });
  broadcastBarData();
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
      const { color, domain } = await getActiveTabInfo();
      sessionData = {
        startTime: now,
        segments: [{ color, domain, start: now, end: null }]
      };
      chrome.alarms.create('stepdue-tick', { periodInMinutes: 1 / 60 });
      broadcastBarData();
      sendResponse({ lockedIn: true });
    });
    return true;
  }

  if (msg.type === 'EPOCH_LOCK_OUT') {
    if (sessionData.segments.length > 0) {
      const last = sessionData.segments[sessionData.segments.length - 1];
      if (!last.end) last.end = Date.now();
    }

    chrome.alarms.clear('stepdue-tick');
    sessionData = { startTime: null, segments: [] };

    chrome.storage.local.set({ lockedIn: false }).then(() => {
      broadcastToAll({ type: 'EPOCH_HIDE' });
      sendResponse({ lockedIn: false });
    });
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
  if (changes.classifications) {
    broadcastBarData();
  }
});
