// token-counter-web client
// - Pulls /api/tokens once per second (data is server-cached, cheap)
// - Interpolates between the last two known data points so the digits drift
//   continuously instead of jumping every poll cycle.
// - Renders the headline number as an "odometer": each digit is a vertical
//   strip 0..9, and the column slides to the target digit. Lower digits move
//   faster than higher ones, which gives that flipping-pages feel.

const POLL_MS = 1000;
const CODEX_WINDOW_SEC = 5 * 60 * 60;
const PRESSURE_CIRCUMFERENCE = 113.097;
const COUNTER_DIGIT_SLOT_EM = 1.08;
const COUNTER_DIGIT_WIDTH_EM = 0.64;
const COUNTER_SEP_WIDTH_EM = 0.22;
const COUNTER_FONT_CARD_RATIO = 0.128;
const COUNTER_MAX_FONT_PX = 156;
const COUNTER_MIN_FONT_PX = 36;
const cardEl = document.querySelector('.card');
const counterEl = document.getElementById('counter');
const deltaEl = document.getElementById('delta');
const dotEl = document.getElementById('status-dot');
const elTpm = document.getElementById('m-tpm');
const elRpm = document.getElementById('m-rpm');
const elTpmTrend = document.getElementById('m-tpm-trend');
const elRpmTrend = document.getElementById('m-rpm-trend');
const elReq = document.getElementById('m-req');
const elCost = document.getElementById('m-cost');
const elFailed = document.getElementById('m-failed');
const pressureEl = document.getElementById('pressure');
const pressureValueEl = document.getElementById('pressure-value');
const pressureFillEl = pressureEl?.querySelector('.pressure__fill');
const capRoot = document.querySelector('.capacity');
const capPct = document.getElementById('cap-pct');
const capCount = document.getElementById('cap-count');
const capReset = document.getElementById('cap-reset');
const capForecast = document.getElementById('cap-forecast');
const capFill = document.getElementById('cap-fill');
const capBarHost = document.getElementById('cap-bar-host');
const capTimeline = document.getElementById('cap-timeline');
const usageBg = document.getElementById('usage-bg');
const usageCtx = usageBg instanceof HTMLCanvasElement ? usageBg.getContext('2d') : null;
const apiUsageEl = document.getElementById('api-usage');

/** @typedef {{ totalTokens:number, totalRequests:number, successCount:number, failureCount:number, totalCost:number, tpm:number, rpm:number, rateWindowSec:number, rateRequestCount:number, rateTokenCount:number, usageChart: { windowSec:number, bucketSec:number, maxTokens:number, maxRequests:number, buckets:Array<{ start:number, tokens:number, requests:number }> }|null, apiUsers:Array<{ name:string, totalTokens:number, totalRequests:number, totalCost:number, recentTokens:number, recentRequests:number, maxBucketTokens:number, buckets:number[] }>, fetchedAt:number, pollIntervalMs:number, ok:boolean, error:string|null, codex: { total:number, available:number, limited:number, sumRemaining:number, totalPool:number, poolRemainingPercent:number, poolRemainingRatio:number, percentAvailable?:number, nextResetAt:number|null, latestResetAt:number|null, accounts?:Array<{ remainingPct:number, remainingPctExact?:number, usedPercent:number, usedPercentExact?:number, resetsAt:number|null, resetAfterSec:number|null, limited:boolean }>, forecast?: { event:string, targetAt:number|null, secondsRemaining:number|null, depletionAt:number|null, fullRechargeAt:number|null, burnPointsPerMinute:number, burnPoolPercentPerHour:number, source:string, sampleSec:number|null } }|null }} Snap */

/** @type {Snap|null} */ let prevSnap = null;
/** @type {Snap|null} */ let lastSnap = null;
let lastSnapClientTs = 0;
let prevSnapClientTs = 0;

let displayedTokens = 0;
let lastDeltaShownAt = 0;
let latestUsageChart = null;
let usageBgRaf = 0;

async function fetchSnap() {
  try {
    const res = await fetch('/api/tokens', { cache: 'no-store' });
    if (!res.ok) throw new Error(`http ${res.status}`);
    /** @type {Snap} */
    const snap = await res.json();
    if (!snap.ok) {
      dotEl.dataset.state = 'error';
      return;
    }
    dotEl.dataset.state = 'live';

    if (lastSnap && snap.fetchedAt !== lastSnap.fetchedAt) {
      // got a fresh server-side sample
      prevSnap = lastSnap;
      prevSnapClientTs = lastSnapClientTs;
      lastSnap = snap;
      lastSnapClientTs = performance.now();

      const dTokens = snap.totalTokens - prevSnap.totalTokens;
      if (dTokens > 0) showDelta(dTokens);
    } else if (!lastSnap) {
      lastSnap = snap;
      lastSnapClientTs = performance.now();
      // seed display so we don't roll up from zero on first paint
      displayedTokens = snap.totalTokens;
      renderCounter(displayedTokens, /*animate*/ false);
    }

    // metric pills update directly (small, no need for odometer parity)
    elTpm.textContent = formatPerMinute(snap.tpm);
    elRpm.textContent = formatPerMinute(snap.rpm);
    elReq.textContent = formatCompact(snap.totalRequests);
    if (elCost) elCost.textContent = formatUsd(snap.totalCost);
    elFailed.textContent = formatCompact(snap.failureCount);

    renderRateTrends(snap);
    renderPressure(snap);
    renderCapacity(snap.codex);
    renderResetTimeline(snap.codex);
    renderUsageBackground(snap.usageChart);
    renderApiUsage(snap.apiUsers);
    fitSmallNumbers();
  } catch (err) {
    dotEl.dataset.state = 'error';
  }
}

let lastCodex = null;

// Codex capacity bar: fills by the remaining percentage of the total account
// pool. Reset countdown is interpolated locally between server polls.
function renderCapacity(codex) {
  if (!capRoot || !capFill || !capPct || !capCount || !capReset) return;
  if (!codex || !Number.isFinite(codex.total) || codex.total === 0) {
    capRoot.dataset.state = 'empty';
    capRoot.dataset.forecast = 'unknown';
    capPct.textContent = '—';
    capCount.textContent = '— / —';
    capReset.textContent = 'no codex accounts';
    if (capForecast) capForecast.textContent = 'forecast —';
    capFill.style.width = '0%';
    if (capBarHost) capBarHost.setAttribute('aria-valuenow', '0');
    lastCodex = null;
    return;
  }

  lastCodex = codex;
  const rawPct = Number.isFinite(codex.poolRemainingPercent)
    ? codex.poolRemainingPercent
    : (codex.percentAvailable || 0) * 100;
  const pct = Math.max(0, Math.min(100, Math.round(rawPct)));

  let state = 'ok';
  if (pct < 10) state = 'critical';
  else if (pct < 25) state = 'warn';
  capRoot.dataset.state = state;
  capRoot.dataset.forecast = codex.forecast?.event || 'unknown';

  capPct.textContent = `${pct}%`;
  capCount.textContent = `${codex.available} / ${codex.total}`;
  capFill.style.width = `${pct}%`;
  if (capBarHost) capBarHost.setAttribute('aria-valuenow', String(pct));

  updateCapacityTimers();
}

function updateCapacityTimers() {
  updateResetText();
  updateForecastText();
  if (lastSnap) {
    renderPressure(lastSnap);
  }
}

function updateResetText() {
  if (!lastCodex || !capReset) return;
  const c = lastCodex;
  if (c.nextResetAt) {
    const remainingSec = Math.max(0, Math.round((c.nextResetAt - Date.now()) / 1000));
    capReset.textContent = `next reset ${formatDuration(remainingSec)}`;
    return;
  }
  if (c.limited > 0) {
    capReset.textContent = `${c.limited} limited`;
    return;
  }
  capReset.textContent = 'all accounts free';
}

function updateForecastText() {
  if (!lastCodex || !capForecast) return;
  const forecast = lastCodex.forecast;
  if (!forecast || !forecast.event || forecast.event === 'unknown') {
    if (capRoot) capRoot.dataset.forecast = 'unknown';
    capForecast.textContent = 'forecast learning';
    return;
  }

  if (capRoot) capRoot.dataset.forecast = forecast.event;
  const targetSec = forecast.targetAt
    ? Math.max(0, Math.round((forecast.targetAt - Date.now()) / 1000))
    : forecast.secondsRemaining;
  const approx = forecast.source === 'window' && forecast.event === 'depletion' ? '~' : '';

  if (forecast.event === 'depletion') {
    capForecast.textContent = `empty in ${approx}${formatDuration(targetSec || 0)}`;
  } else if (forecast.event === 'recharge') {
    capForecast.textContent = `full in ${formatDuration(targetSec || 0)}`;
  } else if (forecast.event === 'full') {
    capForecast.textContent = 'fully charged';
  } else if (forecast.event === 'depleted') {
    capForecast.textContent = 'empty now';
  } else {
    capForecast.textContent = 'forecast learning';
  }
}

setInterval(updateCapacityTimers, 1000);

function renderPressure(snap) {
  if (!pressureEl || !pressureValueEl || !pressureFillEl || !snap) return;
  const pressure = computePressure(snap);
  const pct = Math.round(pressure.score * 100);
  pressureEl.dataset.state = pressure.state;
  pressureValueEl.textContent = `${pct}`;
  pressureFillEl.style.strokeDasharray = String(PRESSURE_CIRCUMFERENCE);
  pressureFillEl.style.strokeDashoffset = String(PRESSURE_CIRCUMFERENCE * (1 - pressure.score));
}

function computePressure(snap) {
  const codex = snap.codex;
  const ratio = Number.isFinite(codex?.poolRemainingRatio)
    ? codex.poolRemainingRatio
    : Math.max(0, Math.min(1, (Number(codex?.poolRemainingPercent) || 0) / 100));
  const capacityPressure = 1 - Math.max(0, Math.min(1, ratio));
  const activityPressure = computeActivityPressure(snap);
  const burnPressure = Math.max(0, Math.min(1, (Number(codex?.forecast?.burnPoolPercentPerHour) || 0) / 45));
  const forecastPressure = computeForecastPressure(codex?.forecast);
  let score = clamp01(
    capacityPressure * 0.38 +
    activityPressure * 0.26 +
    burnPressure * 0.22 +
    forecastPressure * 0.14,
  );

  if (codex?.forecast?.event === 'depletion' && Number(codex.forecast.secondsRemaining) < 3600) {
    score = Math.max(score, 0.84);
  }

  let state = 'calm';
  if (score >= 0.68) state = 'hot';
  else if (score >= 0.36) state = 'busy';
  return { score, state, activityPressure };
}

function computeForecastPressure(forecast) {
  if (!forecast || forecast.event !== 'depletion') return 0;
  const targetSec = forecast.targetAt
    ? Math.max(0, Math.round((forecast.targetAt - Date.now()) / 1000))
    : Number(forecast.secondsRemaining);
  if (!Number.isFinite(targetSec)) return 0;
  return clamp01(1 - targetSec / (2 * 3600));
}

function computeActivityPressure(snap) {
  const chart = snap.usageChart;
  if (!chart || !Array.isArray(chart.buckets) || chart.buckets.length < 3) {
    return Math.max(
      clamp01((Number(snap.tpm) || 0) / 750_000),
      clamp01((Number(snap.rpm) || 0) / 30),
    );
  }

  const history = chart.buckets.slice(-13, -1);
  const bucketMinutes = Math.max(1, (Number(chart.bucketSec) || 300) / 60);
  const avgTokensPerMin = average(history.map((b) => (Number(b.tokens) || 0) / bucketMinutes));
  const avgRequestsPerMin = average(history.map((b) => (Number(b.requests) || 0) / bucketMinutes));
  const tpmPressure = (Number(snap.tpm) || 0) / Math.max(20_000, avgTokensPerMin * 2.5);
  const rpmPressure = (Number(snap.rpm) || 0) / Math.max(1, avgRequestsPerMin * 2.5);
  return clamp01(Math.max(tpmPressure, rpmPressure));
}

function renderRateTrends(snap) {
  renderTrend(elTpmTrend, computeRateTrend(snap, 'tokens'), 'vs prev 5m');
  renderTrend(elRpmTrend, computeRateTrend(snap, 'requests'), 'vs prev 5m');
}

function computeRateTrend(snap, kind) {
  const chart = snap.usageChart;
  if (!chart || !Array.isArray(chart.buckets) || chart.buckets.length < 2) return null;
  const bucketMinutes = Math.max(1, (Number(chart.bucketSec) || 300) / 60);
  const previous = chart.buckets[chart.buckets.length - 2];
  const previousRate = (Number(previous?.[kind]) || 0) / bucketMinutes;
  const currentRate = kind === 'tokens' ? Number(snap.tpm) || 0 : Number(snap.rpm) || 0;
  if (previousRate <= 0 && currentRate <= 0) return { state: 'flat', label: 'quiet' };
  if (previousRate <= 0) return { state: 'up', label: 'new' };
  const pct = ((currentRate - previousRate) / previousRate) * 100;
  if (Math.abs(pct) < 6) return { state: 'flat', label: 'stable' };
  return {
    state: pct > 0 ? 'up' : 'down',
    label: `${pct > 0 ? '↑' : '↓'}${Math.round(Math.abs(pct))}%`,
  };
}

function renderTrend(el, trend, suffix) {
  if (!el) return;
  if (!trend) {
    el.textContent = '';
    el.dataset.state = 'flat';
    return;
  }
  el.textContent = `${trend.label} ${suffix}`;
  el.dataset.state = trend.state;
}

function renderResetTimeline(codex) {
  if (!capTimeline) return;
  const now = Date.now();
  const accounts = Array.isArray(codex?.accounts) ? codex.accounts : [];
  const events = accounts
    .map((account) => {
      const resetsAt = Number(account.resetsAt);
      const remaining = Number.isFinite(account.remainingPctExact)
        ? account.remainingPctExact
        : Number(account.remainingPct) || 0;
      const refill = Math.max(0, 100 - remaining);
      return { resetsAt, refill };
    })
    .filter((event) => Number.isFinite(event.resetsAt) && event.resetsAt > now && event.refill >= 0.5)
    .sort((a, b) => a.resetsAt - b.resetsAt);

  if (!events.length) {
    capTimeline.hidden = true;
    capTimeline.replaceChildren();
    return;
  }

  capTimeline.hidden = false;
  const frag = document.createDocumentFragment();
  for (const event of events) {
    const dot = document.createElement('span');
    const sec = Math.max(0, Math.round((event.resetsAt - now) / 1000));
    const left = clamp01(sec / CODEX_WINDOW_SEC) * 100;
    dot.className = 'capacity__event';
    dot.style.left = `${left}%`;
    dot.style.setProperty('--event-size', `${Math.round(5 + Math.min(1, event.refill / 100) * 9)}px`);
    dot.style.setProperty('--event-alpha', String(0.32 + Math.min(0.58, event.refill / 120)));
    dot.title = `+${Math.round(event.refill)}% in ${formatDurationText(sec)}`;
    frag.appendChild(dot);
  }
  capTimeline.replaceChildren(frag);
}

function formatDuration(sec) {
  if (sec <= 0) return 'now';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatDurationText(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return 'now';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m`;
  return `${sec}s`;
}

function average(values) {
  const list = values.filter((value) => Number.isFinite(value));
  if (!list.length) return 0;
  return list.reduce((sum, value) => sum + value, 0) / list.length;
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function showDelta(d) {
  deltaEl.textContent = `+${formatNum(d)} tokens`;
  deltaEl.classList.add('show');
  lastDeltaShownAt = performance.now();
}

// Smoothly interpolate the headline between snapshots.
// Each new sample arrives every ~5s; we draw at ~10 Hz.
function tick() {
  if (lastSnap && prevSnap) {
    const elapsed = performance.now() - lastSnapClientTs;
    // assume next sample roughly POLL_INTERVAL_MS away from the last one
    const expectedSpan = lastSnap.pollIntervalMs || 5000;
    // project current value forward at the rate observed between prev->last
    const ratePerMs =
      (lastSnap.totalTokens - prevSnap.totalTokens) /
      Math.max(1, lastSnap.fetchedAt - prevSnap.fetchedAt);
    // soft cap projection so we never overshoot the next sample by more than 1 span
    const projected =
      lastSnap.totalTokens + ratePerMs * Math.min(elapsed, expectedSpan * 1.1);
    const target = Math.max(displayedTokens, Math.round(projected));

    if (target !== displayedTokens) {
      displayedTokens = target;
      renderCounter(displayedTokens, /*animate*/ true);
    }
  } else if (lastSnap) {
    // no previous sample yet — just paint current value
    if (displayedTokens !== lastSnap.totalTokens) {
      displayedTokens = lastSnap.totalTokens;
      renderCounter(displayedTokens, true);
    }
  }

  // hide delta after ~3.5s
  if (lastDeltaShownAt && performance.now() - lastDeltaShownAt > 3500) {
    deltaEl.classList.remove('show');
    lastDeltaShownAt = 0;
  }

  requestAnimationFrame(tick);
}

// ---------- formatters ----------

function formatNum(n) {
  return Math.round(n).toLocaleString('en-US');
}

function formatCompact(n) {
  if (!Number.isFinite(n)) return '0';
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  const units = [
    { v: 1e12, s: 'T' },
    { v: 1e9, s: 'B' },
    { v: 1e6, s: 'M' },
    { v: 1e3, s: 'K' },
  ];
  for (const u of units) {
    if (abs >= u.v) {
      const x = n / u.v;
      const digits = x >= 100 ? 0 : x >= 10 ? 1 : 2;
      return x.toFixed(digits).replace(/\.?0+$/, '') + u.s;
    }
  }
  return String(n);
}

function formatPerMinute(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '0.00';
  const abs = Math.abs(num);
  if (abs >= 1000) return Math.round(num).toLocaleString('en-US');
  if (abs >= 100) return num.toFixed(0);
  if (abs >= 10) return num.toFixed(1);
  return num.toFixed(2);
}

function formatMillions(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '0M';
  const millions = num / 1_000_000;
  const digits = millions >= 100 ? 0 : millions >= 10 ? 1 : 2;
  return `${millions.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}M`;
}

function formatUsd(n) {
  const num = Number(n);
  if (!Number.isFinite(num) || num <= 0) return '$0.00';
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 10_000) return `$${Math.round(num).toLocaleString('en-US')}`;
  if (num >= 1_000) return `$${num.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  return `$${num.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// ---------- per-key usage ----------

function renderApiUsage(users) {
  if (!apiUsageEl) return;
  if (!Array.isArray(users) || users.length === 0) {
    apiUsageEl.hidden = true;
    apiUsageEl.replaceChildren();
    return;
  }

  apiUsageEl.hidden = false;
  const maxRecentTokens = Math.max(1, ...users.map((user) => Number(user.recentTokens) || 0));
  const frag = document.createDocumentFragment();
  for (const user of users) {
    const row = document.createElement('article');
    row.className = 'api-user';
    const recentTokens = Number(user.recentTokens) || 0;
    const recentRequests = Number(user.recentRequests) || 0;
    const heat = clamp01(recentTokens / maxRecentTokens);
    row.style.setProperty('--heat', heat.toFixed(3));
    row.dataset.active = recentTokens > 0 || recentRequests > 0 ? 'true' : 'false';
    row.title = `${formatNum(recentTokens)} tokens · ${formatNum(recentRequests)} requests in last 5m`;

    const name = document.createElement('span');
    name.className = 'api-user__name';
    name.textContent = user.name || 'api';

    const spark = document.createElement('span');
    spark.className = 'api-user__spark';
    spark.appendChild(makeSparkline(user.buckets || [], user.maxBucketTokens || 0));

    const value = document.createElement('span');
    value.className = 'api-user__value';

    const tokens = document.createElement('span');
    tokens.className = 'api-user__tokens';
    tokens.textContent = formatMillions(user.totalTokens);

    const cost = document.createElement('span');
    cost.className = 'api-user__cost';
    cost.textContent = formatUsd(user.totalCost);

    value.append(tokens, cost);

    row.append(name, spark, value);
    frag.appendChild(row);
  }
  apiUsageEl.replaceChildren(frag);
}

function makeSparkline(values, maxValue) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 100 24');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('aria-hidden', 'true');

  const list = Array.isArray(values) ? values : [];
  const max = Math.max(1, Number(maxValue) || 0, ...list.map((v) => Number(v) || 0));
  const points = list.length > 1
    ? list.map((v, i) => {
        const x = (i / (list.length - 1)) * 100;
        const y = 22 - Math.pow(Math.max(0, Number(v) || 0) / max, 0.58) * 18;
        return { x, y };
      })
    : [{ x: 0, y: 22 }, { x: 100, y: 22 }];

  const areaPath = document.createElementNS(ns, 'path');
  const linePath = document.createElementNS(ns, 'path');
  const d = sparklinePath(points);
  areaPath.setAttribute('class', 'api-user__spark-area');
  areaPath.setAttribute('d', `${d} L 100 24 L 0 24 Z`);
  linePath.setAttribute('class', 'api-user__spark-line');
  linePath.setAttribute('d', d);
  svg.append(areaPath, linePath);
  return svg;
}

function sparklinePath(points) {
  if (!points.length) return 'M 0 22 L 100 22';
  let d = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const point = points[i];
    const midX = (prev.x + point.x) / 2;
    const midY = (prev.y + point.y) / 2;
    d += ` Q ${prev.x.toFixed(2)} ${prev.y.toFixed(2)} ${midX.toFixed(2)} ${midY.toFixed(2)}`;
  }
  const last = points[points.length - 1];
  d += ` L ${last.x.toFixed(2)} ${last.y.toFixed(2)}`;
  return d;
}

// ---------- usage background ----------

function renderUsageBackground(chart) {
  if (!usageBg || !usageCtx || !chart || !Array.isArray(chart.buckets)) return;
  latestUsageChart = chart;
  scheduleUsageBackgroundDraw();
}

function scheduleUsageBackgroundDraw() {
  if (usageBgRaf) return;
  usageBgRaf = requestAnimationFrame(() => {
    usageBgRaf = 0;
    drawUsageBackground();
  });
}

function drawUsageBackground() {
  if (!usageBg || !usageCtx || !latestUsageChart) return;
  const rect = usageBg.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width));
  const h = Math.max(1, Math.floor(rect.height));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pixelW = Math.floor(w * dpr);
  const pixelH = Math.floor(h * dpr);

  if (usageBg.width !== pixelW || usageBg.height !== pixelH) {
    usageBg.width = pixelW;
    usageBg.height = pixelH;
  }

  const ctx = usageCtx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const buckets = latestUsageChart.buckets;
  if (buckets.length < 2) return;

  const left = -w * 0.035;
  const right = w * 1.035;
  const top = h * 0.14;
  const baseline = h * 0.78;
  const chartH = baseline - top;
  const maxTokens = Math.max(1, latestUsageChart.maxTokens || 0);
  const step = (right - left) / Math.max(1, buckets.length - 1);

  const fade = ctx.createLinearGradient(0, top, 0, baseline);
  fade.addColorStop(0, 'rgba(245, 245, 247, 0.045)');
  fade.addColorStop(0.58, 'rgba(245, 245, 247, 0.018)');
  fade.addColorStop(1, 'rgba(245, 245, 247, 0)');

  ctx.save();
  ctx.globalAlpha = 0.72;
  ctx.strokeStyle = 'rgba(245, 245, 247, 0.035)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = top + (chartH * i) / 4;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  for (let i = 0; i <= 8; i++) {
    const x = (w * i) / 8;
    ctx.beginPath();
    ctx.moveTo(x, top - 20);
    ctx.lineTo(x, baseline + 18);
    ctx.stroke();
  }
  ctx.restore();

  const points = buckets.map((b, i) => {
    const tokenNorm = Math.pow(Math.max(0, b.tokens) / maxTokens, 0.54);
    return {
      x: left + i * step,
      y: baseline - tokenNorm * chartH,
    };
  });

  ctx.save();
  const area = new Path2D();
  area.moveTo(points[0].x, baseline);
  area.lineTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const point = points[i];
    const midX = (prev.x + point.x) / 2;
    const midY = (prev.y + point.y) / 2;
    area.quadraticCurveTo(prev.x, prev.y, midX, midY);
  }
  const last = points[points.length - 1];
  area.lineTo(last.x, last.y);
  area.lineTo(last.x, baseline);
  area.closePath();

  const areaGradient = ctx.createLinearGradient(0, top, 0, baseline);
  areaGradient.addColorStop(0, 'rgba(109, 240, 166, 0.115)');
  areaGradient.addColorStop(0.45, 'rgba(109, 240, 166, 0.045)');
  areaGradient.addColorStop(1, 'rgba(109, 240, 166, 0)');
  ctx.fillStyle = areaGradient;
  ctx.fill(area);

  const line = new Path2D();
  line.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const point = points[i];
    const midX = (prev.x + point.x) / 2;
    const midY = (prev.y + point.y) / 2;
    line.quadraticCurveTo(prev.x, prev.y, midX, midY);
  }
  line.lineTo(last.x, last.y);

  const strokeGradient = ctx.createLinearGradient(left, 0, right, 0);
  strokeGradient.addColorStop(0, 'rgba(245, 245, 247, 0.04)');
  strokeGradient.addColorStop(0.36, 'rgba(109, 240, 166, 0.15)');
  strokeGradient.addColorStop(0.72, 'rgba(245, 245, 247, 0.12)');
  strokeGradient.addColorStop(1, 'rgba(245, 245, 247, 0.035)');
  ctx.strokeStyle = strokeGradient;
  ctx.lineWidth = 1.35;
  ctx.shadowColor = 'rgba(109, 240, 166, 0.12)';
  ctx.shadowBlur = 22;
  ctx.stroke(line);

  ctx.shadowBlur = 0;
  ctx.strokeStyle = fade;
  ctx.lineWidth = 8;
  ctx.globalAlpha = 0.22;
  ctx.stroke(line);
  ctx.restore();
}

// ---------- odometer ----------

// Build the visual representation of `value` with thousands separators.
// We then diff against the existing DOM column-by-column so digits that
// didn't change keep their current strip position (no jitter), while changed
// ones smoothly translate to the new digit.

// Size the counter from the card's inner width, not from the viewport. This
// keeps the headline proportional to the card under browser zoom and resize.
function fitCounter() {
  const parent = counterEl.parentElement;
  if (!parent) return;
  const cs = getComputedStyle(parent);
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const available = parent.clientWidth - padX - 8;
  const units = Number(counterEl.dataset.units) || measureCounterUnits();
  if (available <= 0 || units <= 0) return;

  const preferred = available * COUNTER_FONT_CARD_RATIO;
  const fit = available / units;
  const hardCap = Math.min(COUNTER_MAX_FONT_PX, preferred, fit);
  const target = Math.max(Math.min(COUNTER_MIN_FONT_PX, fit), hardCap);
  counterEl.style.fontSize = `${Math.floor(target)}px`;

  if (counterEl.scrollWidth > available) {
    const fitted = Math.floor(target * (available / counterEl.scrollWidth));
    counterEl.style.fontSize = `${Math.max(1, fitted)}px`;
  }
}

function measureCounterUnits() {
  const cols = Array.from(counterEl.children);
  return cols.reduce((sum, col) => {
    return sum + (col.dataset.kind === 'sep' ? COUNTER_SEP_WIDTH_EM : COUNTER_DIGIT_WIDTH_EM);
  }, 0);
}

function counterUnits(tokens) {
  return tokens.reduce((sum, token) => {
    return sum + (token.kind === 'sep' ? COUNTER_SEP_WIDTH_EM : COUNTER_DIGIT_WIDTH_EM);
  }, 0);
}

function fitSmallNumbers() {
  requestAnimationFrame(() => {
    document.querySelectorAll('.pill__value').forEach((el) => fitTextToParent(el, 11));
    document
      .querySelectorAll('.api-user__tokens, .api-user__cost')
      .forEach((el) => fitTextToParent(el, 9));
  });
}

function fitTextToParent(el, minPx) {
  if (!el || !el.parentElement) return;
  el.style.fontSize = '';
  const parent = el.parentElement;
  const parentStyle = getComputedStyle(parent);
  const available =
    parent.clientWidth -
    parseFloat(parentStyle.paddingLeft || '0') -
    parseFloat(parentStyle.paddingRight || '0') -
    2;
  if (available <= 0) return;
  const natural = el.scrollWidth;
  if (natural <= available) return;
  const baseFont = parseFloat(getComputedStyle(el).fontSize);
  if (!Number.isFinite(baseFont) || baseFont <= 0) return;
  el.style.fontSize = Math.max(minPx, Math.floor(baseFont * (available / natural))) + 'px';
}

function renderCounter(value, animate) {
  const text = formatNum(value);
  const tokens = []; // array of { kind: 'digit'|'sep', char }
  for (const ch of text) {
    if (/\d/.test(ch)) tokens.push({ kind: 'digit', char: ch });
    else tokens.push({ kind: 'sep', char: ch });
  }
  counterEl.dataset.units = String(counterUnits(tokens));

  // Right-align: align by index from the right so existing digits in lower
  // positions don't reshuffle when a new high-order digit appears.
  const need = tokens.length;

  // Add leading columns if needed
  while (counterEl.children.length < need) {
    counterEl.insertBefore(makeColumn('digit', '0'), counterEl.firstChild);
  }
  // Remove leading columns if too many (rare — value shouldn't shrink)
  while (counterEl.children.length > need) {
    counterEl.removeChild(counterEl.firstChild);
  }

  const cols = Array.from(counterEl.children);
  for (let i = 0; i < need; i++) {
    const tok = tokens[i];
    const col = cols[i];
    const currentKind = col.dataset.kind;

    if (tok.kind === 'sep') {
      if (currentKind !== 'sep' || col.textContent !== tok.char) {
        col.replaceWith(makeStaticSep(tok.char));
      }
      continue;
    }

    // digit column
    if (currentKind !== 'digit') {
      const next = makeColumn('digit', tok.char);
      col.replaceWith(next);
      continue;
    }
    setDigit(col, tok.char, animate);
  }

  fitCounter();
}

function makeColumn(kind, ch) {
  const col = document.createElement('span');
  col.className = 'col';
  col.dataset.kind = kind;
  if (kind === 'sep') {
    col.textContent = ch;
    return col;
  }
  const strip = document.createElement('span');
  strip.className = 'col__strip';
  for (let d = 0; d <= 9; d++) {
    const s = document.createElement('span');
    s.textContent = String(d);
    strip.appendChild(s);
  }
  col.appendChild(strip);
  // initial position
  const target = Number(ch);
  strip.dataset.value = String(target);
  // start with no transition, snap into place
  strip.style.transition = 'none';
  strip.style.transform = digitTransform(target);
  // force reflow then re-enable
  // eslint-disable-next-line no-unused-expressions
  strip.offsetHeight;
  strip.style.transition = '';
  return col;
}

function makeStaticSep(ch) {
  const col = document.createElement('span');
  col.className = 'col';
  col.dataset.kind = 'sep';
  col.textContent = ch;
  return col;
}

function setDigit(col, ch, animate) {
  const strip = col.firstChild;
  if (!strip) return;
  const current = Number(strip.dataset.value || '0');
  const target = Number(ch);
  if (current === target) return;

  // Lower digits should animate faster, higher digits slower → "rolling" feel.
  // We approximate digit position by its visual index from the right.
  const allCols = Array.from(counterEl.querySelectorAll('.col[data-kind="digit"]'));
  const idxFromRight = allCols.length - 1 - allCols.indexOf(col);
  // base 600ms, +120ms per place value, capped
  const dur = Math.min(1400, 600 + idxFromRight * 140);

  if (!animate) {
    strip.style.transition = 'none';
    strip.style.transform = digitTransform(target);
    // eslint-disable-next-line no-unused-expressions
    strip.offsetHeight;
    strip.style.transition = '';
  } else {
    strip.style.transitionDuration = `${dur}ms`;
    strip.style.transform = digitTransform(target);
  }
  strip.dataset.value = String(target);
}

function digitTransform(digit) {
  return `translateY(${-digit * COUNTER_DIGIT_SLOT_EM}em)`;
}

// ---------- boot ----------

if (cardEl) {
  cardEl.addEventListener('click', () => {
    const selection = window.getSelection?.();
    if (selection && selection.toString()) return;
    document.body.classList.toggle('focus-mode');
    requestAnimationFrame(() => {
      fitCounter();
      fitSmallNumbers();
    });
  });
}

if (cardEl && 'ResizeObserver' in window) {
  const cardObserver = new ResizeObserver(() => {
    fitCounter();
    fitSmallNumbers();
    scheduleUsageBackgroundDraw();
  });
  cardObserver.observe(cardEl);
}

fetchSnap();
setInterval(fetchSnap, POLL_MS);
requestAnimationFrame(tick);
window.addEventListener('resize', () => {
  fitCounter();
  fitSmallNumbers();
  scheduleUsageBackgroundDraw();
});
