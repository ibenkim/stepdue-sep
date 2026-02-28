(function () {
  if (window.location.protocol === 'chrome:' ||
      window.location.protocol === 'chrome-extension:') return;

  // Color palette
  const COLORS = {
    red:    { r: 0x59, g: 0x5A, b: 0x96 },
    green:  { r: 0xA4, g: 0xA5, b: 0xC7 },
    yellow: { r: 0xD2, g: 0xC8, b: 0xE3 },
    gray:   { r: 0xB5, g: 0xA0, b: 0xCE }
  };
  const MERGE = { r: 0xEF, g: 0xEF, b: 0xF8 };

  function blendColor(colorName, t) {
    const c = COLORS[colorName] || COLORS.gray;
    const r = Math.round(c.r * t + MERGE.r * (1 - t));
    const g = Math.round(c.g * t + MERGE.g * (1 - t));
    const b = Math.round(c.b * t + MERGE.b * (1 - t));
    return `rgb(${r},${g},${b})`;
  }

  // Local fisheye state
  let localSegments = null;
  let rafId = null;
  let barHovered = false;

  function fisheye(ageSeconds) {
    return Math.exp(-ageSeconds / 43.3);
  }

  function buildBarDataLocal() {
    const now = Date.now();
    const segs = localSegments;
    if (!segs || segs.length === 0) return null;

    const result = [];
    for (const seg of segs) {
      const end = seg.end || now;
      const duration = end - seg.start;
      if (duration <= 0) continue;

      const midpoint = (seg.start + end) / 2;
      const ageSeconds = (now - midpoint) / 1000;
      const weight = fisheye(ageSeconds);
      const flex = duration * weight;
      const blend = Math.max(0, Math.min(1, weight));

      result.push({ color: seg.color, flex, blend });
    }

    return { segments: result };
  }

  // Returns marker position as % from left (0-100), or null if out of range.
  // thresholdSeconds: how far back in time the marker represents.
  function getMarkerPosition(thresholdSeconds) {
    const now = Date.now();
    const cutoff = now - thresholdSeconds * 1000;
    const segs = localSegments;
    if (!segs || segs.length === 0) return null;

    let totalFlex = 0;
    let recentFlex = 0;

    for (const seg of segs) {
      const segEnd = seg.end || now;
      const segStart = seg.start;
      if (segEnd <= segStart) continue;

      if (segEnd <= cutoff) {
        // Entire segment is older than threshold
        const mid = (segStart + segEnd) / 2;
        const age = (now - mid) / 1000;
        totalFlex += (segEnd - segStart) * fisheye(age);
      } else if (segStart >= cutoff) {
        // Entire segment is newer than threshold
        const mid = (segStart + segEnd) / 2;
        const age = (now - mid) / 1000;
        const f = (segEnd - segStart) * fisheye(age);
        totalFlex += f;
        recentFlex += f;
      } else {
        // Segment spans the cutoff — split it
        const oldMid = (segStart + cutoff) / 2;
        const oldAge = (now - oldMid) / 1000;
        totalFlex += (cutoff - segStart) * fisheye(oldAge);

        const recMid = (cutoff + segEnd) / 2;
        const recAge = (now - recMid) / 1000;
        const recF = (segEnd - cutoff) * fisheye(recAge);
        totalFlex += recF;
        recentFlex += recF;
      }
    }

    if (totalFlex === 0) return null;
    const pos = (1 - recentFlex / totalFlex) * 100;
    if (pos <= 0 || pos >= 100) return null;
    return pos;
  }

  const MARKER_THRESHOLDS = [
    { label: '30s', seconds: 30 },
    { label: '1m',  seconds: 60 },
    { label: '5m',  seconds: 300 },
    { label: '15m',  seconds: 900 },
    { label: '30m',  seconds: 1800 },
    { label: '1h',  seconds: 3600 }
  ];

  // DOM setup
  const host = document.createElement('div');
  host.id = 'stepdue-bar-host';
  const shadow = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = `
    :host {
      all: initial;
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      z-index: 2147483647;
      display: none;
    }

    :host(.stepdue-active) {
      display: block;
    }

    #stepdue-wrapper {
      position: relative;
      width: 100%;
    }

    #stepdue-bar {
      display: flex;
      width: 100%;
      height: 6px;
      background: rgba(255, 255, 255, 0.08);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.15),
        0 1px 3px rgba(0, 0, 0, 0.1);
      pointer-events: auto;
      cursor: default;
    }

    .segment {
      height: 100%;
    }

    .segment + .segment {
      border-left: 0.5px solid rgba(0, 0, 0, 0.08);
    }

    #stepdue-markers {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 32px;
      pointer-events: none;
      display: none;
    }

    .time-marker {
      position: absolute;
      top: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      transform: translateX(-50%);
    }

    .marker-line {
      width: 1px;
      height: 10px;
      background: rgba(0, 0, 0, 0.45);
    }

    .marker-label {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 10px;
      font-weight: 500;
      color: #333;
      margin-top: 3px;
      white-space: nowrap;
      background: rgba(255, 255, 255, 0.88);
      padding: 1px 5px;
      border-radius: 4px;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
    }

    @media (prefers-color-scheme: dark) {
      #stepdue-bar {
        background: rgba(0, 0, 0, 0.2);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.08),
          0 1px 3px rgba(0, 0, 0, 0.2);
      }
      .marker-line  { background: rgba(255, 255, 255, 0.5); }
      .marker-label {
        background: rgba(0, 0, 0, 0.72);
        color: rgba(255, 255, 255, 0.85);
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
      }
    }
  `;

  const wrapper = document.createElement('div');
  wrapper.id = 'stepdue-wrapper';

  const bar = document.createElement('div');
  bar.id = 'stepdue-bar';

  const markersEl = document.createElement('div');
  markersEl.id = 'stepdue-markers';

  // Pre-create marker elements
  const markerEls = MARKER_THRESHOLDS.map(({ label }) => {
    const el = document.createElement('div');
    el.className = 'time-marker';
    el.innerHTML = `<div class="marker-line"></div><div class="marker-label">${label}</div>`;
    markersEl.appendChild(el);
    return el;
  });

  wrapper.appendChild(bar);
  wrapper.appendChild(markersEl);
  shadow.appendChild(style);
  shadow.appendChild(wrapper);

  function inject() {
    if (document.documentElement) {
      document.documentElement.appendChild(host);
    } else {
      requestAnimationFrame(inject);
    }
  }
  inject();

  // Hover detection
  bar.addEventListener('mouseenter', () => {
    barHovered = true;
    markersEl.style.display = 'block';
  });
  bar.addEventListener('mouseleave', () => {
    barHovered = false;
    markersEl.style.display = 'none';
  });

  function showBar() { host.classList.add('stepdue-active'); }
  function hideBar()  { host.classList.remove('stepdue-active'); }

  function renderBar(data) {
    if (!data || !data.segments || data.segments.length === 0) {
      bar.innerHTML = '';
      return;
    }

    const newCount = data.segments.length;
    const oldCount = bar.children.length;

    if (newCount === oldCount) {
      data.segments.forEach((s, i) => {
        const child = bar.children[i];
        child.style.flex = s.flex;
        child.style.backgroundColor = blendColor(s.color, s.blend);
      });
    } else {
      bar.innerHTML = '';
      for (const s of data.segments) {
        const seg = document.createElement('div');
        seg.className = 'segment';
        seg.style.flex = s.flex;
        seg.style.backgroundColor = blendColor(s.color, s.blend);
        bar.appendChild(seg);
      }
    }

    showBar();
  }

  function updateMarkers() {
    MARKER_THRESHOLDS.forEach(({ seconds }, i) => {
      const pos = getMarkerPosition(seconds);
      const el = markerEls[i];
      if (pos === null) {
        el.style.display = 'none';
      } else {
        el.style.display = 'flex';
        el.style.left = pos + '%';
      }
    });
  }

  // rAF loop
  function startRafLoop() {
    if (rafId) return;

    function tick() {
      if (!document.hidden) {
        const data = buildBarDataLocal();
        if (data) renderBar(data);
        if (barHovered) updateMarkers();
      }
      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);
  }

  function stopRafLoop() {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'EPOCH_SYNC_SEGMENTS') {
      localSegments = msg.payload.segments;
      showBar();
      startRafLoop();
    }
    if (msg.type === 'EPOCH_HIDE') {
      stopRafLoop();
      localSegments = null;
      bar.innerHTML = '';
      hideBar();
    }
  });

  chrome.runtime.sendMessage({ type: 'EPOCH_GET_STATE' }, (state) => {
    if (state && state.segments) {
      localSegments = state.segments;
      showBar();
      startRafLoop();
    }
  });
})();
