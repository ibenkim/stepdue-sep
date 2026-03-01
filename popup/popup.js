// ─── Azure Config ─────────────────────────────────────────────────────────────
// Update this URL after deploying your Azure Static Web App
// e.g. 'https://epoch-reports.azurestaticapps.net'
const REPORT_BASE_URL = 'https://green-bush-0a2c6481e.1.azurestaticapps.net';
// ──────────────────────────────────────────────────────────────────────────────

const COLOR_GRID_PALETTE = [
  // Purples (current palette family)
  '#595A96','#4a4b80','#8880a8','#B5A0CE','#A4A5C7','#D2C8E3','#9B7DC3','#7B5EA7',
  // Blues
  '#1D4ED8','#2563EB','#3B82F6','#60A5FA','#93C5FD','#5B9BD5','#0EA5E9','#0891B2',
  // Greens + Teals
  '#059669','#10B981','#34D399','#4ADE80','#86EFAC','#06B6D4','#67E8F9','#0D9488',
  // Yellows + Oranges
  '#D97706','#F59E0B','#FCD34D','#EF6C00','#EA580C','#FB923C','#FED7AA','#92400E',
  // Reds + Pinks
  '#DC2626','#EF4444','#E11D48','#EC4899','#F472B6','#FB7185','#F43F5E','#FECDD3',
];

document.addEventListener('DOMContentLoaded', async () => {
  const POLL_INTERVAL_MS = 1000;
  const DOMAIN_PATTERN = /^[\w.-]+\.[a-z]{2,}$/i;

  let timerInterval = null;
  let analyticsInterval = null;
  let currentTab = 'session';

  // categories state — replaces old classifications object
  let categories = [];
  let colorMap = { gray: '#B5A0CE' };
  let editMode = false;
  let pendingCategoryEdit = null; // null = new category, else category id being edited
  let selectedModalColor = '#595A96';
  let colorGridBuilt = false;

  // Dynamic version from manifest
  document.getElementById('version-badge').textContent =
    `v${chrome.runtime.getManifest().version}`;

  // ─── Init ───

  const { categories: storedCats, lockedIn, theme: savedTheme } =
    await chrome.storage.local.get(['categories', 'lockedIn', 'theme']);

  applyTheme(savedTheme || 'light');

  categories = storedCats || [];
  buildColorMap(categories);
  renderCategories(categories);
  updateLockUI(lockedIn);
  if (lockedIn) startTimerPolling();
  loadCurrentDomain();
  initDrag();

  // ─── Theme ───

  function applyTheme(mode) {
    document.body.dataset.theme = mode;
    document.querySelectorAll('.theme-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });
    const slider = document.getElementById('theme-slider');
    if (slider) slider.classList.toggle('right', mode === 'dark');
  }

  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      applyTheme(mode);
      chrome.storage.local.set({ theme: mode });
    });
  });

  // ─── Color Map ───

  function buildColorMap(cats) {
    colorMap = { gray: '#B5A0CE' };
    for (const cat of cats) colorMap[cat.id] = cat.color;
  }

  // ─── Tab Navigation ───

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      if (target === currentTab) return;

      document.querySelector('.tab-btn.active').classList.remove('active');
      document.querySelector('.tab-panel.active').classList.remove('active');

      document.querySelectorAll('.tab-btn').forEach(b => b.setAttribute('aria-selected', 'false'));
      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
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
    const btn = document.getElementById('lock-btn');
    btn.disabled = true;

    const { lockedIn: current } = await chrome.storage.local.get('lockedIn');

    if (current) {
      const response = await chrome.runtime.sendMessage({ type: 'EPOCH_LOCK_OUT' });
      updateLockUI(false);
      stopTimerPolling();
      document.getElementById('status-text').textContent = 'Session saved.';
      if (response && response.sessionId) {
        showReportLinks(response.sessionId);
      }
    } else {
      hideReportLinks();
      await chrome.runtime.sendMessage({ type: 'EPOCH_LOCK_IN' });
      updateLockUI(true);
      startTimerPolling();
    }

    btn.disabled = false;
  });

  function showReportLinks(sessionId) {
    const area = document.getElementById('report-links');
    area.style.display = 'flex';

    document.getElementById('view-report-btn').onclick = async () => {
      const { deviceId } = await chrome.storage.local.get('deviceId');
      const url = REPORT_BASE_URL
        ? `${REPORT_BASE_URL}/report/session.html?id=${sessionId}&deviceId=${encodeURIComponent(deviceId || '')}`
        : chrome.runtime.getURL(`../azure/app/report/session.html?id=${sessionId}`);
      chrome.tabs.create({ url });
    };

    document.getElementById('view-all-btn').onclick = async () => {
      const { deviceId } = await chrome.storage.local.get('deviceId');
      const url = REPORT_BASE_URL && deviceId
        ? `${REPORT_BASE_URL}/report/overview.html?deviceId=${encodeURIComponent(deviceId)}`
        : chrome.runtime.getURL(`../azure/app/report/overview.html?deviceId=${encodeURIComponent(deviceId || '')}`);
      chrome.tabs.create({ url });
    };
  }

  document.getElementById('view-insights-btn').onclick = async () => {
    const { deviceId } = await chrome.storage.local.get('deviceId');
    const url = REPORT_BASE_URL && deviceId
      ? `${REPORT_BASE_URL}/report/analytics.html?deviceId=${encodeURIComponent(deviceId)}`
      : chrome.runtime.getURL(`../azure/app/report/analytics.html?deviceId=${encodeURIComponent(deviceId || '')}`);
    chrome.tabs.create({ url });
  };

  function hideReportLinks() {
    document.getElementById('report-links').style.display = 'none';
  }

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
    timerInterval = setInterval(pollTimer, POLL_INTERVAL_MS);
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
      dot.style.background = colorMap.gray;
      return;
    }

    if (!tabs.length || !tabs[0].url) {
      label.textContent = 'No active tab';
      dot.style.background = colorMap.gray;
      return;
    }

    let domain;
    try { domain = new URL(tabs[0].url).hostname; } catch { domain = null; }

    if (!domain) {
      label.textContent = 'Browser page';
      dot.style.background = colorMap.gray;
      return;
    }

    const color = classifyDomainLocal(domain, categories);
    label.textContent = domain;
    dot.style.background = colorMap[color] || colorMap.gray;
  }

  function classifyDomainLocal(domain, cats) {
    for (const cat of cats) {
      if (Array.isArray(cat.domains) && cat.domains.some(d => domain === d || domain.endsWith('.' + d))) {
        return cat.id;
      }
    }
    return 'gray';
  }

  // ─── Sites Tab — Category Rendering ───

  function renderCategories(cats) {
    const container = document.getElementById('categories-container');
    container.innerHTML = '';
    for (const cat of cats) {
      container.appendChild(buildCategorySection(cat, cats));
    }
    attachDropTargets();
    updateColorSelect(cats);
  }

  function buildCategorySection(cat, allCats) {
    const section = document.createElement('div');
    section.className = 'domain-category collapsed';
    section.dataset.categoryId = cat.id;

    // Header
    const header = document.createElement('div');
    header.className = 'category-header';
    header.setAttribute('role', 'button');
    header.setAttribute('tabindex', '0');

    const dot = document.createElement('div');
    dot.className = 'color-dot';
    dot.style.background = cat.color;

    const nameEl = document.createElement('span');
    nameEl.className = 'category-name';
    nameEl.textContent = cat.name;

    const editBtn = document.createElement('button');
    editBtn.className = 'category-edit-btn';
    editBtn.textContent = '✎';
    editBtn.setAttribute('aria-label', `Edit ${cat.name}`);
    editBtn.addEventListener('click', e => {
      e.stopPropagation();
      openCategoryModal(cat.id);
    });

    const countEl = document.createElement('span');
    countEl.className = 'domain-count';
    countEl.textContent = (cat.domains || []).length;

    const chevron = document.createElement('span');
    chevron.className = 'chevron';
    chevron.textContent = '▾';

    header.appendChild(dot);
    header.appendChild(nameEl);
    header.appendChild(editBtn);
    header.appendChild(countEl);
    header.appendChild(chevron);

    header.addEventListener('click', () => section.classList.toggle('collapsed'));
    header.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') section.classList.toggle('collapsed');
    });

    // Domain list
    const list = document.createElement('div');
    list.className = 'domain-list';

    for (const domain of [...(cat.domains || [])].sort()) {
      list.appendChild(buildDomainItem(domain, cat.id, allCats));
    }

    section.appendChild(header);
    section.appendChild(list);
    return section;
  }

  function buildDomainItem(domain, catId, allCats) {
    const item = document.createElement('div');
    item.className = 'domain-item';

    const nameEl = document.createElement('span');
    nameEl.className = 'domain-item-name';
    nameEl.textContent = domain;
    nameEl.title = domain;

    item.appendChild(nameEl);

    if (editMode) {
      const moveSelect = document.createElement('select');
      moveSelect.className = 'domain-item-move';
      moveSelect.setAttribute('aria-label', `Move ${domain} to category`);
      for (const c of allCats) {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.name;
        if (c.id === catId) opt.selected = true;
        moveSelect.appendChild(opt);
      }
      moveSelect.addEventListener('change', async () => {
        await classifyDomainTo(domain, moveSelect.value);
      });
      item.appendChild(moveSelect);
    }

    const removeBtn = document.createElement('button');
    removeBtn.className = 'domain-remove-btn';
    removeBtn.textContent = '\u00d7';
    removeBtn.setAttribute('aria-label', `Remove ${domain}`);
    removeBtn.addEventListener('click', () => removeDomain(domain, catId));
    item.appendChild(removeBtn);

    return item;
  }

  // ─── Sites Tab — Domain CRUD ───

  async function removeDomain(domain, catId) {
    const { categories: cats } = await chrome.storage.local.get('categories');
    const cat = cats.find(c => c.id === catId);
    if (cat) cat.domains = cat.domains.filter(d => d !== domain);
    await chrome.storage.local.set({ categories: cats });
    categories = cats;
    buildColorMap(cats);
    renderCategories(cats);
    loadCurrentDomain();
    showToast('Domain removed');
  }

  async function classifyDomainTo(domain, targetCatId) {
    const { categories: cats } = await chrome.storage.local.get('categories');
    for (const cat of cats) {
      cat.domains = (cat.domains || []).filter(d => d !== domain);
    }
    const target = cats.find(c => c.id === targetCatId);
    if (target) target.domains.push(domain);
    await chrome.storage.local.set({ categories: cats });
    categories = cats;
    buildColorMap(cats);
    renderCategories(cats);
    loadCurrentDomain();
    showToast(`Moved to ${target?.name || 'category'}`);
  }

  // ─── Sites Tab — Collapsible (via header click, handled in buildCategorySection) ───

  // ─── Sites Tab — Add Domain ───

  document.getElementById('add-btn').addEventListener('click', async () => {
    const input = document.getElementById('domain-input');
    const select = document.getElementById('color-select');
    const domain = input.value.trim().toLowerCase();
    const catId = select.value;

    if (!domain || !DOMAIN_PATTERN.test(domain)) {
      showToast('Enter a valid domain (e.g. example.com)');
      input.focus();
      return;
    }

    const { categories: cats } = await chrome.storage.local.get('categories');
    for (const cat of cats) {
      cat.domains = (cat.domains || []).filter(d => d !== domain);
    }
    const target = cats.find(c => c.id === catId);
    if (target) target.domains.push(domain);

    await chrome.storage.local.set({ categories: cats });
    categories = cats;
    buildColorMap(cats);

    input.value = '';
    renderCategories(cats);
    loadCurrentDomain();
    showToast('Domain added');
  });

  function updateColorSelect(cats) {
    const select = document.getElementById('color-select');
    const prev = select.value;
    select.innerHTML = '';
    for (const cat of cats) {
      const opt = document.createElement('option');
      opt.value = cat.id;
      opt.textContent = cat.name;
      select.appendChild(opt);
    }
    // Restore previous selection if still valid
    if (cats.some(c => c.id === prev)) select.value = prev;
  }

  // ─── Sites Tab — Edit Mode ───

  document.getElementById('modify-list-btn').addEventListener('click', () => {
    editMode = !editMode;
    document.getElementById('modify-list-btn').classList.toggle('active', editMode);
    document.getElementById('modify-list-btn').textContent = editMode ? 'Done' : 'Modify list';
    renderCategories(categories);
  });

  // ─── Sites Tab — Drag & Drop ───

  function initDrag() {
    const strip = document.getElementById('current-domain-strip');
    strip.draggable = true;

    strip.addEventListener('dragstart', e => {
      const domain = document.getElementById('current-domain-label').textContent;
      if (!domain || domain === 'No active tab' || domain === 'Browser page') {
        e.preventDefault();
        return;
      }
      e.dataTransfer.setData('text/plain', domain);
      e.dataTransfer.effectAllowed = 'move';
      strip.classList.add('dragging');
    });

    strip.addEventListener('dragend', () => strip.classList.remove('dragging'));
  }

  function attachDropTargets() {
    document.querySelectorAll('.domain-category').forEach(section => {
      section.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        section.classList.add('drag-over');
      });
      section.addEventListener('dragleave', e => {
        // Only remove if leaving the section entirely
        if (!section.contains(e.relatedTarget)) {
          section.classList.remove('drag-over');
        }
      });
      section.addEventListener('drop', async e => {
        e.preventDefault();
        section.classList.remove('drag-over');
        const domain = e.dataTransfer.getData('text/plain');
        const catId = section.dataset.categoryId;
        if (domain && DOMAIN_PATTERN.test(domain)) {
          await classifyDomainTo(domain, catId);
        }
      });
    });
  }

  // ─── Sites Tab — Category Modal ───

  document.getElementById('add-category-btn').addEventListener('click', () => openCategoryModal(null));
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-confirm').addEventListener('click', confirmCategoryModal);
  document.getElementById('modal-delete').addEventListener('click', async () => {
    if (pendingCategoryEdit) await deleteCategory(pendingCategoryEdit);
    closeModal();
  });

  // Close on overlay click
  document.getElementById('category-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeModal();
  });

  // Close on Escape
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !document.getElementById('category-modal').hidden) closeModal();
  });

  function openCategoryModal(editCatId) {
    pendingCategoryEdit = editCatId;
    const modal = document.getElementById('category-modal');
    const title = document.getElementById('modal-title');
    const confirmBtn = document.getElementById('modal-confirm');
    const deleteBtn = document.getElementById('modal-delete');
    const nameInput = document.getElementById('category-name-input');

    if (!colorGridBuilt) buildColorGrid();

    if (editCatId) {
      const cat = categories.find(c => c.id === editCatId);
      title.textContent = 'Edit Category';
      confirmBtn.textContent = 'Save';
      deleteBtn.hidden = false;
      nameInput.value = cat ? cat.name : '';
      setSelectedColor(cat ? cat.color : '#595A96');
    } else {
      title.textContent = 'New Category';
      confirmBtn.textContent = 'Add';
      deleteBtn.hidden = true;
      nameInput.value = '';
      setSelectedColor('#595A96');
    }

    modal.hidden = false;
    nameInput.focus();
  }

  function closeModal() {
    document.getElementById('category-modal').hidden = true;
    pendingCategoryEdit = null;
  }

  async function confirmCategoryModal() {
    const name = document.getElementById('category-name-input').value.trim();
    if (!name) {
      showToast('Enter a category name');
      document.getElementById('category-name-input').focus();
      return;
    }

    const { categories: cats } = await chrome.storage.local.get('categories');

    if (pendingCategoryEdit) {
      // Edit existing
      const cat = cats.find(c => c.id === pendingCategoryEdit);
      if (cat) {
        cat.name = name;
        cat.color = selectedModalColor;
      }
    } else {
      // Add new
      cats.push({
        id: `cat_${Date.now()}`,
        name,
        color: selectedModalColor,
        domains: []
      });
    }

    const wasEditing = !!pendingCategoryEdit;
    await chrome.storage.local.set({ categories: cats });
    categories = cats;
    buildColorMap(cats);
    renderCategories(cats);
    loadCurrentDomain();
    closeModal();
    showToast(wasEditing ? 'Category updated' : 'Category added');
  }

  async function deleteCategory(catId) {
    const { categories: cats } = await chrome.storage.local.get('categories');
    const filtered = cats.filter(c => c.id !== catId);
    await chrome.storage.local.set({ categories: filtered });
    categories = filtered;
    buildColorMap(filtered);
    renderCategories(filtered);
    loadCurrentDomain();
    showToast('Category deleted');
  }

  function buildColorGrid() {
    const grid = document.getElementById('color-grid');
    grid.innerHTML = '';
    for (const hex of COLOR_GRID_PALETTE) {
      const btn = document.createElement('button');
      btn.className = 'color-swatch';
      btn.style.background = hex;
      btn.title = hex;
      btn.setAttribute('aria-label', hex);
      btn.addEventListener('click', () => setSelectedColor(hex));
      grid.appendChild(btn);
    }
    colorGridBuilt = true;
  }

  function setSelectedColor(hex) {
    selectedModalColor = hex;
    document.getElementById('selected-color-swatch').style.background = hex;
    document.getElementById('selected-color-hex').textContent = hex;
    // Update selected state on swatches
    document.querySelectorAll('.color-swatch').forEach(btn => {
      btn.classList.toggle('selected', btn.title === hex);
    });
  }

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
    analyticsInterval = setInterval(loadAnalytics, POLL_INTERVAL_MS);
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
      const hex = colorMap[entry.color] || colorMap.gray;

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
      const hex = colorMap[seg.color] || colorMap.gray;

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

  // ─── Toast ───

  function showToast(msg) {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toast._timeout);
    toast._timeout = setTimeout(() => toast.classList.remove('show'), 2000);
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
