const COLOR_HEX = {
  red:    '#595A96',
  green:  '#A4A5C7',
  yellow: '#D2C8E3',
  gray:   '#B5A0CE'
};

document.addEventListener('DOMContentLoaded', async () => {
  let timerInterval = null;
  let analyticsInterval = null;
  let currentTab = 'session';

  // ─── Init ───

  const { classifications, lockedIn } =
    await chrome.storage.local.get(['classifications', 'lockedIn']);

  updateLockUI(lockedIn);
  if (classifications) renderDomainLists(classifications);
  if (lockedIn) startTimerPolling();
  loadCurrentDomain();

  // ─── Tab Navigation ───

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      if (target === currentTab) return;

      document.querySelector('.tab-btn.active').classList.remove('active');
      document.querySelector('.tab-panel.active').classList.remove('active');

      btn.classList.add('active');
      document.getElementById(`tab-${target}`).classList.add('active');

      if (currentTab === 'analytics') stopAnalyticsPolling();
      currentTab = target;

      if (target === 'sites') loadCurrentDomain();
      if (target === 'analytics') {
        loadAnalytics();
        startAnalyticsPolling();
      }
    });
  });

  // ─── Session Tab ───

  document.getElementById('lock-btn').addEventListener('click', async () => {
    const { lockedIn: current } = await chrome.storage.local.get('lockedIn');

    if (current) {
      await chrome.runtime.sendMessage({ type: 'EPOCH_LOCK_OUT' });
      updateLockUI(false);
      stopTimerPolling();
    } else {
      await chrome.runtime.sendMessage({ type: 'EPOCH_LOCK_IN' });
      updateLockUI(true);
      startTimerPolling();
    }
  });

  function updateLockUI(locked) {
    const btn = document.getElementById('lock-btn');
    const statusText = document.getElementById('status-text');
    if (locked) {
      btn.textContent = 'Stop';
      btn.classList.add('active');
    } else {
      btn.textContent = 'Lock In';
      btn.classList.remove('active');
      statusText.textContent = 'Not in session';
    }
  }

  function startTimerPolling() {
    pollTimer();
    timerInterval = setInterval(pollTimer, 1000);
  }

  function stopTimerPolling() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  }

  async function pollTimer() {
    const state = await chrome.runtime.sendMessage({ type: 'EPOCH_GET_STATE' });
    if (state && state.elapsed != null) {
      const mins = Math.floor(state.elapsed / 60);
      const secs = state.elapsed % 60;
      document.getElementById('status-text').textContent =
        'Session active \u2014 ' + String(mins).padStart(2, '0') + ':' + String(secs).padStart(2, '0');
      const analytics = await chrome.runtime.sendMessage({ type: 'EPOCH_GET_ANALYTICS' });
      renderChart(analytics ? analytics.perDomain : []);
    } else {
      renderChart([]);
    }
  }

  // ─── Sites Tab — Current Domain ───

  async function loadCurrentDomain() {
    const dot = document.getElementById('current-domain-dot');
    const label = document.getElementById('current-domain-label');

    let tabs;
    try {
      tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    } catch {
      label.textContent = 'No active tab';
      dot.style.background = COLOR_HEX.gray;
      return;
    }

    if (!tabs.length || !tabs[0].url) {
      label.textContent = 'No active tab';
      dot.style.background = COLOR_HEX.gray;
      return;
    }

    let domain;
    try { domain = new URL(tabs[0].url).hostname; } catch { domain = null; }

    if (!domain) {
      label.textContent = 'Browser page';
      dot.style.background = COLOR_HEX.gray;
      return;
    }

    const { classifications: cls } = await chrome.storage.local.get('classifications');
    const color = classifyDomainLocal(domain, cls || {});

    label.textContent = domain;
    dot.style.background = COLOR_HEX[color] || COLOR_HEX.gray;
  }

  function classifyDomainLocal(domain, cls) {
    for (const [color, domains] of Object.entries(cls)) {
      if (Array.isArray(domains) && domains.some(d => domain === d || domain.endsWith('.' + d))) {
        return color;
      }
    }
    return 'gray';
  }

  // ─── Sites Tab — Domain Lists ───

  function renderDomainLists(classifications) {
    for (const color of ['red', 'green', 'yellow']) {
      const list = document.getElementById(`list-${color}`);
      const countEl = document.getElementById(`count-${color}`);
      const domains = classifications[color] || [];

      countEl.textContent = domains.length;
      list.innerHTML = '';

      for (const domain of [...domains].sort()) {
        const item = document.createElement('div');
        item.className = 'domain-item';

        const nameEl = document.createElement('span');
        nameEl.className = 'domain-item-name';
        nameEl.textContent = domain;
        nameEl.title = domain;

        const removeBtn = document.createElement('button');
        removeBtn.className = 'domain-remove-btn';
        removeBtn.textContent = '\u00d7';
        removeBtn.setAttribute('aria-label', `Remove ${domain}`);
        removeBtn.addEventListener('click', () => removeDomain(domain, color));

        item.appendChild(nameEl);
        item.appendChild(removeBtn);
        list.appendChild(item);
      }
    }
  }

  async function removeDomain(domain, color) {
    const { classifications: cls } = await chrome.storage.local.get('classifications');
    cls[color] = (cls[color] || []).filter(d => d !== domain);
    await chrome.storage.local.set({ classifications: cls });
    renderDomainLists(cls);
    loadCurrentDomain();
  }

  // ─── Sites Tab — Collapsible Categories ───

  document.querySelectorAll('.category-header').forEach(header => {
    header.addEventListener('click', () => {
      header.closest('.domain-category').classList.toggle('collapsed');
    });
  });

  // ─── Sites Tab — Add Domain ───

  document.getElementById('add-btn').addEventListener('click', async () => {
    const input = document.getElementById('domain-input');
    const select = document.getElementById('color-select');
    const domain = input.value.trim().toLowerCase();
    const color = select.value;

    if (!domain) return;

    const { classifications: cls } = await chrome.storage.local.get('classifications');

    for (const c of Object.keys(cls)) {
      cls[c] = cls[c].filter(d => d !== domain);
    }

    cls[color].push(domain);
    await chrome.storage.local.set({ classifications: cls });

    input.value = '';
    renderDomainLists(cls);
    loadCurrentDomain();
  });

  // ─── Analytics Tab ───

  async function loadAnalytics() {
    const data = await chrome.runtime.sendMessage({ type: 'EPOCH_GET_ANALYTICS' });

    if (data && data.sessionStart) {
      const startDate = new Date(data.sessionStart);
      document.getElementById('analytics-start').textContent =
        startDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      const durationSec = Math.floor((Date.now() - data.sessionStart) / 1000);
      document.getElementById('analytics-duration').textContent = formatDuration(durationSec);
    } else {
      document.getElementById('analytics-start').textContent = '\u2014';
      document.getElementById('analytics-duration').textContent = '\u2014';
    }

    renderTimeline(data ? data.timeline : []);
  }

  function startAnalyticsPolling() {
    analyticsInterval = setInterval(loadAnalytics, 1000);
  }

  function stopAnalyticsPolling() {
    if (analyticsInterval) { clearInterval(analyticsInterval); analyticsInterval = null; }
  }

  function renderChart(perDomain) {
    const container = document.getElementById('site-chart');

    if (!perDomain || perDomain.length === 0) {
      container.innerHTML = '<div class="no-data">Start a session to see analytics.</div>';
      return;
    }

    const maxMs = perDomain[0].totalMs;
    container.innerHTML = '';

    for (const entry of perDomain) {
      const widthPct = maxMs > 0 ? (entry.totalMs / maxMs) * 100 : 0;
      const hex = COLOR_HEX[entry.color] || COLOR_HEX.gray;

      const row = document.createElement('div');
      row.className = 'chart-row';

      const domainEl = document.createElement('span');
      domainEl.className = 'chart-domain';
      domainEl.textContent = entry.domain;
      domainEl.title = entry.domain;

      const barWrap = document.createElement('div');
      barWrap.className = 'chart-bar-wrap';

      const barFill = document.createElement('div');
      barFill.className = 'chart-bar-fill';
      barFill.style.width = widthPct + '%';
      barFill.style.background = hex;

      barWrap.appendChild(barFill);

      const timeEl = document.createElement('span');
      timeEl.className = 'chart-time';
      timeEl.textContent = formatMs(entry.totalMs);

      row.appendChild(domainEl);
      row.appendChild(barWrap);
      row.appendChild(timeEl);
      container.appendChild(row);
    }
  }

  function renderTimeline(timeline) {
    const container = document.getElementById('timeline');

    if (!timeline || timeline.length === 0) {
      container.innerHTML = '<div class="no-data">No activity yet.</div>';
      return;
    }

    container.innerHTML = '';

    for (const seg of timeline) {
      const tsStr = new Date(seg.start).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      });

      const durationMs = seg.end - seg.start;
      const hex = COLOR_HEX[seg.color] || COLOR_HEX.gray;

      const entry = document.createElement('div');
      entry.className = 'timeline-entry';

      const tsEl = document.createElement('span');
      tsEl.className = 'timeline-ts';
      tsEl.textContent = tsStr;

      const dotEl = document.createElement('div');
      dotEl.className = 'timeline-dot';
      dotEl.style.background = hex;

      const domainEl = document.createElement('span');
      domainEl.className = 'timeline-domain';
      domainEl.textContent = seg.domain || 'Unknown';
      domainEl.title = seg.domain || '';

      const durEl = document.createElement('span');
      durEl.className = 'timeline-dur';
      durEl.textContent = formatMs(durationMs);

      entry.appendChild(tsEl);
      entry.appendChild(dotEl);
      entry.appendChild(domainEl);
      entry.appendChild(durEl);
      container.appendChild(entry);
    }
  }

  // ─── Utilities ───

  function formatMs(ms) {
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  function formatDuration(totalSec) {
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }
});
