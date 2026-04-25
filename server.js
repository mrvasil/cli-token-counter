import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('./public/', import.meta.url));

function cleanEnv(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeManagementUrl(value) {
  const raw = cleanEnv(value);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    url.pathname = normalizeManagementPath(url.pathname);
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return normalizeManagementPath(raw).replace(/\/+$/, '');
  }
}

function normalizeManagementPath(value) {
  return String(value || '')
    .replace(/\/+(usage(?:\/export)?|auth-files|api-call)\/?$/i, '')
    .replace(/\/+$/, '');
}

function inferManagementUrl() {
  const explicit = cleanEnv(process.env.MANAGEMENT_URL) || cleanEnv(process.env.UPSTREAM_BASE);
  if (explicit) return normalizeManagementUrl(explicit);

  const legacyUsageUrl = cleanEnv(process.env.MANAGEMENT_USAGE_URL) || cleanEnv(process.env.UPSTREAM_URL);
  if (legacyUsageUrl) return normalizeManagementUrl(legacyUsageUrl);

  return 'http://127.0.0.1:8317/v0/management';
}

function managementEndpoint(path) {
  return `${MANAGEMENT_URL}/${path.replace(/^\/+/, '')}`;
}

function envUrl(name, fallbackName, fallback) {
  return cleanEnv(process.env[name]) || cleanEnv(process.env[fallbackName]) || fallback;
}

function envNumber(name, fallback, { min = -Infinity, max = Infinity, integer = false } = {}) {
  const raw = cleanEnv(process.env[name]);
  let value = raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(value)) value = fallback;
  value = Math.max(min, Math.min(max, value));
  return integer ? Math.round(value) : value;
}

const MANAGEMENT_URL = inferManagementUrl();
const USAGE_URL = envUrl('MANAGEMENT_USAGE_URL', 'UPSTREAM_URL', managementEndpoint('usage'));
const AUTH_FILES_URL = envUrl('MANAGEMENT_AUTH_FILES_URL', 'AUTH_FILES_URL', managementEndpoint('auth-files'));
const API_CALL_URL = envUrl('MANAGEMENT_API_CALL_URL', 'API_CALL_URL', managementEndpoint('api-call'));
const CODEX_USAGE_URL = cleanEnv(process.env.CODEX_USAGE_URL) || 'https://chatgpt.com/backend-api/wham/usage';
const MANAGEMENT_KEY = cleanEnv(process.env.MANAGEMENT_KEY) || cleanEnv(process.env.TOKEN);
const PORT = envNumber('PORT', 4173, { min: 1, max: 65535, integer: true });
const POLL_INTERVAL_MS = envNumber('POLL_INTERVAL_MS', 5000, { min: 1000, integer: true });
const AUTH_POLL_INTERVAL_MS = envNumber('AUTH_POLL_INTERVAL_MS', 10000, { min: 1000, integer: true });
// Rolling window for true TPM/RPM derived from per-request timestamps.
// Rate is expressed per minute, averaged over the last 5 minutes by default.
const RATE_WINDOW_SEC = envNumber('RATE_WINDOW_SEC', 300, { min: 60, integer: true });
const CHART_WINDOW_SEC = envNumber('CHART_WINDOW_SEC', 4 * 3600, { min: 1800, integer: true });
const CHART_BUCKETS = envNumber('CHART_BUCKETS', 48, { min: 12, max: 96, integer: true });
const CODEX_RATE_HISTORY_MS = envNumber('CODEX_RATE_HISTORY_MS', 15 * 60_000, { min: 60_000, integer: true });
const CODEX_QUOTA_CONCURRENCY = envNumber('CODEX_QUOTA_CONCURRENCY', 6, { min: 1, max: 20, integer: true });
const CODEX_FIVE_HOUR_SEC = 5 * 60 * 60;
const DEFAULT_MODEL_PRICES = {
  'gpt-5.5': {
    prompt: 5,
    cache: 0.5,
    completion: 30,
    longContextThreshold: 272_000,
    longInputMultiplier: 2,
    longOutputMultiplier: 1.5,
  },
  'gpt-5.4': {
    prompt: 2.5,
    cache: 0.25,
    completion: 15,
    longContextThreshold: 272_000,
    longInputMultiplier: 2,
    longOutputMultiplier: 1.5,
  },
  'gpt-5.4-mini': { prompt: 0.75, cache: 0.075, completion: 4.5 },
  // Override via MODEL_PRICES_JSON if your upstream bills Codex differently.
  'gpt-5.3-codex': { prompt: 1.75, cache: 0.175, completion: 14 },
};
const MODEL_PRICES = loadModelPrices();

if (!MANAGEMENT_KEY) {
  console.error('[token-counter] MANAGEMENT_KEY env is empty — management API calls will fail. Set MANAGEMENT_KEY in .env');
}

let usageState = null;
let codexQuotaState = null;
let codexQuotaFetchedAt = null;
let lastUsageError = null;
let lastAuthError = null;
let authPollInFlight = false;
let codexQuotaHistory = [];

function authHeaders() {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${MANAGEMENT_KEY}`,
    'User-Agent': 'token-counter-web/1.0',
  };
}

function loadModelPrices() {
  if (!process.env.MODEL_PRICES_JSON) return DEFAULT_MODEL_PRICES;
  try {
    const parsed = JSON.parse(process.env.MODEL_PRICES_JSON);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return DEFAULT_MODEL_PRICES;
    return mergeModelPrices(DEFAULT_MODEL_PRICES, parsed);
  } catch {
    console.error('[token-counter] MODEL_PRICES_JSON is invalid, using default model prices');
    return DEFAULT_MODEL_PRICES;
  }
}

function mergeModelPrices(defaults, overrides) {
  const merged = { ...defaults };
  for (const [modelName, override] of Object.entries(overrides)) {
    if (!override || typeof override !== 'object' || Array.isArray(override)) continue;
    merged[modelName] = {
      ...(defaults[modelName] || {}),
      ...override,
    };
  }
  return merged;
}

// True per-minute rates from individual request timestamps, not from snapshot deltas.
// Walks every model's details[] and counts entries within the last `windowSec`.
function computeRatesFromUsage(usageJson, windowSec) {
  const nowMs = Date.now();
  const cutoffMs = nowMs - windowSec * 1000;
  let tokens = 0;
  let requests = 0;
  const apis = usageJson?.usage?.apis;
  if (apis && typeof apis === 'object') {
    for (const apiKey of Object.keys(apis)) {
      const models = apis[apiKey]?.models;
      if (!models) continue;
      for (const modelName of Object.keys(models)) {
        const details = models[modelName]?.details;
        if (!Array.isArray(details)) continue;
        for (let i = 0; i < details.length; i++) {
          const ts = Date.parse(details[i].timestamp);
          if (Number.isFinite(ts) && ts >= cutoffMs && ts <= nowMs) {
            requests++;
            tokens += totalTokensFromDetail(details[i]);
          }
        }
      }
    }
  }
  const minutes = windowSec / 60;
  return {
    tpm: tokens / minutes,
    rpm: requests / minutes,
    rateRequestCount: requests,
    rateTokenCount: tokens,
    windowSec,
  };
}

function buildUsageChart(usageJson, windowSec = CHART_WINDOW_SEC, bucketCount = CHART_BUCKETS) {
  const nowMs = Date.now();
  const windowMs = windowSec * 1000;
  const bucketMs = windowMs / bucketCount;
  const startMs = nowMs - windowMs;
  const buckets = Array.from({ length: bucketCount }, (_, i) => ({
    start: Math.round(startMs + i * bucketMs),
    tokens: 0,
    requests: 0,
  }));
  const apis = usageJson?.usage?.apis;
  if (apis && typeof apis === 'object') {
    for (const apiKey of Object.keys(apis)) {
      const models = apis[apiKey]?.models;
      if (!models) continue;
      for (const modelName of Object.keys(models)) {
        const details = models[modelName]?.details;
        if (!Array.isArray(details)) continue;
        for (let i = 0; i < details.length; i++) {
          const ts = Date.parse(details[i].timestamp);
          if (!Number.isFinite(ts) || ts < startMs || ts > nowMs) continue;
          const bucketIndex = Math.min(bucketCount - 1, Math.floor((ts - startMs) / bucketMs));
          buckets[bucketIndex].requests++;
          buckets[bucketIndex].tokens += totalTokensFromDetail(details[i]);
        }
      }
    }
  }
  let maxTokens = 0;
  let maxRequests = 0;
  for (const bucket of buckets) {
    if (bucket.tokens > maxTokens) maxTokens = bucket.tokens;
    if (bucket.requests > maxRequests) maxRequests = bucket.requests;
  }
  return {
    windowSec,
    bucketSec: Math.round(bucketMs / 1000),
    maxTokens,
    maxRequests,
    buckets,
  };
}

function apiUserName(apiKey) {
  const parts = String(apiKey || '').split('-').filter(Boolean);
  return parts[parts.length - 1] || String(apiKey || 'api');
}

function buildApiUserStats(usageJson, windowSec = CHART_WINDOW_SEC, bucketCount = CHART_BUCKETS) {
  const nowMs = Date.now();
  const windowMs = windowSec * 1000;
  const bucketMs = windowMs / bucketCount;
  const startMs = nowMs - windowMs;
  const apis = usageJson?.usage?.apis;
  if (!apis || typeof apis !== 'object') return [];

  const users = [];
  for (const apiKey of Object.keys(apis)) {
    const apiEntry = apis[apiKey];
    const buckets = Array.from({ length: bucketCount }, () => 0);
    const recentCutoffMs = nowMs - RATE_WINDOW_SEC * 1000;
    let recentTokens = 0;
    let recentRequests = 0;
    let totalCost = 0;
    const models = apiEntry?.models;
    if (models && typeof models === 'object') {
      for (const modelName of Object.keys(models)) {
        const details = models[modelName]?.details;
        if (!Array.isArray(details)) continue;
        for (let i = 0; i < details.length; i++) {
          totalCost += costFromDetail(details[i], modelName);
          const ts = Date.parse(details[i].timestamp);
          if (!Number.isFinite(ts) || ts < startMs || ts > nowMs) continue;
          const detailTokens = totalTokensFromDetail(details[i]);
          if (ts >= recentCutoffMs) {
            recentRequests++;
            recentTokens += detailTokens;
          }
          const bucketIndex = Math.min(bucketCount - 1, Math.floor((ts - startMs) / bucketMs));
          buckets[bucketIndex] += detailTokens;
        }
      }
    }

    const maxBucketTokens = buckets.reduce((max, value) => Math.max(max, value), 0);
    users.push({
      name: apiUserName(apiKey),
      apiKey,
      totalTokens: Number(apiEntry?.total_tokens) || 0,
      totalRequests: Number(apiEntry?.total_requests) || 0,
      totalCost,
      recentTokens,
      recentRequests,
      maxBucketTokens,
      buckets,
    });
  }

  users.sort((a, b) => b.totalTokens - a.totalTokens);
  return users;
}

function priceForModel(modelName) {
  return MODEL_PRICES[modelName] || null;
}

function costFromDetail(detail, modelName) {
  const price = priceForModel(modelName);
  if (!price) return 0;
  const tokens = detail?.tokens || {};
  const inputTokens = Math.max(0, Number(tokens.input_tokens) || 0);
  const outputTokens = Math.max(0, Number(tokens.output_tokens) || 0);
  const cachedTokens = Math.max(
    Math.max(0, Number(tokens.cached_tokens) || 0),
    Math.max(0, Number(tokens.cache_tokens) || 0),
  );
  const promptTokens = Math.max(0, inputTokens - cachedTokens);
  const longThreshold = Number(price.longContextThreshold) || Infinity;
  const isLongContext = inputTokens > longThreshold;
  const inputMultiplier = isLongContext ? Number(price.longInputMultiplier) || 1 : 1;
  const outputMultiplier = isLongContext ? Number(price.longOutputMultiplier) || 1 : 1;
  const cacheMultiplier = isLongContext
    ? Number(price.longCacheMultiplier) || inputMultiplier
    : 1;
  const promptCost = (promptTokens / 1_000_000) * (Number(price.prompt) || 0) * inputMultiplier;
  const cacheCost = (cachedTokens / 1_000_000) * (Number(price.cache) || 0) * cacheMultiplier;
  const completionCost = (outputTokens / 1_000_000) * (Number(price.completion) || 0) * outputMultiplier;
  const total = promptCost + cacheCost + completionCost;
  return Number.isFinite(total) && total > 0 ? total : 0;
}

function computeTotalCost(usageJson) {
  let cost = 0;
  const apis = usageJson?.usage?.apis;
  if (apis && typeof apis === 'object') {
    for (const apiKey of Object.keys(apis)) {
      const models = apis[apiKey]?.models;
      if (!models) continue;
      for (const modelName of Object.keys(models)) {
        const details = models[modelName]?.details;
        if (!Array.isArray(details)) continue;
        for (let i = 0; i < details.length; i++) {
          cost += costFromDetail(details[i], modelName);
        }
      }
    }
  }
  return cost;
}

function totalTokensFromDetail(detail) {
  const tokenStats = detail?.tokens;
  const explicitTotal = Number(tokenStats?.total_tokens);
  if (Number.isFinite(explicitTotal)) return explicitTotal;

  const input = Number(tokenStats?.input_tokens) || 0;
  const output = Number(tokenStats?.output_tokens) || 0;
  const reasoning = Number(tokenStats?.reasoning_tokens) || 0;
  const cached = Math.max(
    Number(tokenStats?.cached_tokens) || 0,
    Number(tokenStats?.cache_tokens) || 0,
  );
  return input + output + reasoning + cached;
}

async function pollUsageOnce() {
  const started = Date.now();
  try {
    const res = await fetch(USAGE_URL, { headers: authHeaders() });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const json = await res.json();
    const usage = json.usage || {};
    const rates = computeRatesFromUsage(json, RATE_WINDOW_SEC);
    const usageChart = buildUsageChart(json);
    const apiUsers = buildApiUserStats(json);
    const totalCost = computeTotalCost(json);
    usageState = {
      totalTokens: Number(usage.total_tokens) || 0,
      totalRequests: Number(usage.total_requests) || 0,
      successCount: Number(usage.success_count) || 0,
      failureCount: Number(usage.failure_count) || 0,
      totalCost,
      tpm: rates.tpm,
      rpm: rates.rpm,
      rateWindowSec: rates.windowSec,
      rateRequestCount: rates.rateRequestCount,
      rateTokenCount: rates.rateTokenCount,
      usageChart,
      apiUsers,
      fetchedAt: started,
    };
    lastUsageError = null;
  } catch (err) {
    lastUsageError = err.message || String(err);
    console.error('[poll/usage] failed:', lastUsageError);
  }
}

function decodeJwtPayload(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  const parts = value.split('.');
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function resolveCodexAccountId(file) {
  const idToken = decodeJwtPayload(file?.id_token);
  return idToken?.chatgpt_account_id || idToken?.chatgptAccountId || null;
}

function normalizeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pickFiveHourWindow(rateLimit) {
  const primary = rateLimit?.primary_window || rateLimit?.primaryWindow || null;
  const secondary = rateLimit?.secondary_window || rateLimit?.secondaryWindow || null;
  for (const window of [primary, secondary]) {
    const seconds = normalizeNumber(window?.limit_window_seconds ?? window?.limitWindowSeconds);
    if (seconds === 18000) return window;
  }
  return primary;
}

function quotaRemainingValue(quota) {
  const exact = Number(quota?.remainingPctExact);
  if (Number.isFinite(exact)) return exact;
  return Number(quota?.remainingPct) || 0;
}

function recordCodexQuotaSample(quotaState, at = Date.now()) {
  if (!quotaState || !Array.isArray(quotaState.accounts) || quotaState.accounts.length === 0) return;

  codexQuotaHistory.push({
    at,
    accounts: quotaState.accounts.map((account, index) => ({
      id: account.id || String(index),
      remaining: quotaRemainingValue(account),
      resetsAt: account.resetsAt,
    })),
  });

  const cutoff = at - CODEX_RATE_HISTORY_MS;
  codexQuotaHistory = codexQuotaHistory.filter((sample) => sample.at >= cutoff);
}

function estimateCodexBurnRate(quotaState, now = Date.now()) {
  const recent = codexQuotaHistory.filter((sample) => sample.at <= now);
  let consumedPoints = 0;
  let elapsedSec = 0;

  for (let i = 1; i < recent.length; i++) {
    const prev = recent[i - 1];
    const curr = recent[i];
    const intervalSec = (curr.at - prev.at) / 1000;
    if (!Number.isFinite(intervalSec) || intervalSec <= 0) continue;

    const prevById = new Map(prev.accounts.map((account) => [account.id, account]));
    let intervalConsumption = 0;
    for (const account of curr.accounts) {
      const previous = prevById.get(account.id);
      if (!previous) continue;
      const delta = previous.remaining - account.remaining;
      if (Number.isFinite(delta) && delta > 0 && delta < 100) intervalConsumption += delta;
    }

    consumedPoints += intervalConsumption;
    elapsedSec += intervalSec;
  }

  if (elapsedSec >= 30 && consumedPoints > 0) {
    return {
      pointsPerSec: consumedPoints / elapsedSec,
      pointsPerMinute: (consumedPoints / elapsedSec) * 60,
      sampleSec: elapsedSec,
      source: 'recent',
    };
  }

  let fallbackRate = 0;
  const accounts = Array.isArray(quotaState?.accounts) ? quotaState.accounts : [];
  for (const account of accounts) {
    const used = Number(account.usedPercentExact);
    const resetAfterSec = Number(account.resetAfterSec);
    if (!Number.isFinite(used) || used <= 0) continue;
    if (!Number.isFinite(resetAfterSec)) continue;
    const elapsedWindowSec = Math.max(0, CODEX_FIVE_HOUR_SEC - resetAfterSec);
    if (elapsedWindowSec >= 60) fallbackRate += used / elapsedWindowSec;
  }

  if (fallbackRate > 0) {
    return {
      pointsPerSec: fallbackRate,
      pointsPerMinute: fallbackRate * 60,
      sampleSec: null,
      source: 'window',
    };
  }

  return {
    pointsPerSec: 0,
    pointsPerMinute: 0,
    sampleSec: elapsedSec || null,
    source: 'none',
  };
}

function buildCodexForecast(quotaState, now = Date.now()) {
  const accounts = Array.isArray(quotaState?.accounts) ? quotaState.accounts : [];
  const totalPool = Number(quotaState?.totalPool) || 0;
  const sumRemaining = accounts.reduce((sum, account) => sum + quotaRemainingValue(account), 0);
  const usedPoints = Math.max(0, totalPool - sumRemaining);
  const burn = estimateCodexBurnRate(quotaState, now);
  const fullRechargeAt = usedPoints <= 0.5
    ? now
    : accounts.reduce((latest, account) => {
        if (quotaRemainingValue(account) >= 99.5) return latest;
        const resetsAt = Number(account.resetsAt);
        if (!Number.isFinite(resetsAt) || resetsAt <= now) return latest;
        return latest === null || resetsAt > latest ? resetsAt : latest;
      }, null);

  const depletionAt = burn.pointsPerSec > 0.000001 && sumRemaining > 0
    ? now + (sumRemaining / burn.pointsPerSec) * 1000
    : null;

  let event = 'unknown';
  let targetAt = null;
  if (totalPool <= 0) {
    event = 'unknown';
  } else if (sumRemaining <= 0.5) {
    event = 'depleted';
    targetAt = now;
  } else if (usedPoints <= 0.5) {
    event = 'full';
    targetAt = now;
  } else if (depletionAt && (!fullRechargeAt || depletionAt <= fullRechargeAt)) {
    event = 'depletion';
    targetAt = depletionAt;
  } else if (fullRechargeAt) {
    event = 'recharge';
    targetAt = fullRechargeAt;
  }

  return {
    event,
    targetAt: targetAt ? Math.round(targetAt) : null,
    secondsRemaining: targetAt ? Math.max(0, Math.round((targetAt - now) / 1000)) : null,
    depletionAt: depletionAt ? Math.round(depletionAt) : null,
    fullRechargeAt: fullRechargeAt ? Math.round(fullRechargeAt) : null,
    burnPointsPerMinute: burn.pointsPerMinute,
    burnPoolPercentPerHour: totalPool > 0 ? (burn.pointsPerSec * 3600 / totalPool) * 100 : 0,
    source: burn.source,
    sampleSec: burn.sampleSec,
  };
}

async function fetchCodexQuota(file, index) {
  const authIndex = file.auth_index || file.authIndex;
  const accountId = resolveCodexAccountId(file);
  if (!authIndex || !accountId) {
    throw new Error(`codex account ${index}: missing auth_index or chatgpt account id`);
  }

  const res = await fetch(API_CALL_URL, {
    method: 'POST',
    headers: {
      ...authHeaders(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      auth_index: authIndex,
      method: 'GET',
      url: CODEX_USAGE_URL,
      header: {
        Authorization: 'Bearer $TOKEN$',
        'Content-Type': 'application/json',
        'User-Agent': 'codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal',
        'Chatgpt-Account-Id': accountId,
      },
    }),
  });
  if (!res.ok) throw new Error(`api-call ${res.status}`);

  const apiCall = await res.json();
  const statusCode = Number(apiCall.status_code ?? apiCall.statusCode);
  if (!Number.isFinite(statusCode) || statusCode < 200 || statusCode >= 300) {
    throw new Error(`codex usage ${statusCode || 'unknown'}`);
  }

  let body = null;
  try {
    body = JSON.parse(apiCall.body || '{}');
  } catch {
    throw new Error(`codex account ${index}: invalid usage json`);
  }

  const rateLimit = body?.rate_limit || body?.rateLimit || null;
  const fiveHour = pickFiveHourWindow(rateLimit);
  const usedPercent = normalizeNumber(fiveHour?.used_percent ?? fiveHour?.usedPercent);
  if (usedPercent === null) {
    throw new Error(`codex account ${index}: missing 5h used_percent`);
  }

  const clampedUsed = Math.max(0, Math.min(100, usedPercent));
  const remainingPctExact = 100 - clampedUsed;
  const remainingPct = Math.round(remainingPctExact);
  const resetAtSec = normalizeNumber(fiveHour?.reset_at ?? fiveHour?.resetAt);
  const resetAfterSec = normalizeNumber(fiveHour?.reset_after_seconds ?? fiveHour?.resetAfterSeconds);
  return {
    id: String(authIndex),
    email: file.email || file.account || file.label || null,
    planType: file.id_token?.plan_type || body?.plan_type || body?.planType || null,
    limited: rateLimit?.allowed === false || rateLimit?.limit_reached === true || rateLimit?.limitReached === true,
    resetsAt: resetAtSec ? resetAtSec * 1000 : null,
    resetAfterSec,
    usedPercent: Math.round(clampedUsed),
    usedPercentExact: clampedUsed,
    remainingPct,
    remainingPctExact,
  };
}

async function summarizeCodexQuotas(authFilesJson) {
  const files = Array.isArray(authFilesJson?.files) ? authFilesJson.files : [];
  const codex = files.filter(
    (f) => f && f.provider === 'codex' && f.disabled !== true,
  );
  const quotas = await mapLimited(codex, CODEX_QUOTA_CONCURRENCY, fetchCodexQuota);

  const total = codex.length;
  let limited = 0;
  let nextResetAt = null;
  let latestResetAt = null;
  let sumRemaining = 0;
  const accounts = [];

  for (const quota of quotas) {
    sumRemaining += quota.remainingPct;

    if (quota.limited) {
      limited++;
    }

    if (quota.remainingPct < 100 && quota.resetsAt !== null) {
      if (nextResetAt === null || quota.resetsAt < nextResetAt) nextResetAt = quota.resetsAt;
      if (latestResetAt === null || quota.resetsAt > latestResetAt) latestResetAt = quota.resetsAt;
    }

    accounts.push(quota);
  }

  const totalPool = total * 100;
  const poolRemainingPercent = totalPool > 0
    ? Math.round((sumRemaining / totalPool) * 100)
    : 0;
  const available = total - limited;
  return {
    total,
    available,
    limited,
    sumRemaining,
    totalPool,
    poolRemainingPercent,
    poolRemainingRatio: poolRemainingPercent / 100,
    nextResetAt,
    latestResetAt,
    accounts,
  };
}

async function mapLimited(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function pollAuthOnce() {
  if (authPollInFlight) return;
  authPollInFlight = true;
  try {
    const res = await fetch(AUTH_FILES_URL, { headers: authHeaders() });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const json = await res.json();
    codexQuotaState = await summarizeCodexQuotas(json);
    const now = Date.now();
    codexQuotaFetchedAt = now;
    recordCodexQuotaSample(codexQuotaState, now);
    codexQuotaState.forecast = buildCodexForecast(codexQuotaState, now);
    lastAuthError = null;
  } catch (err) {
    lastAuthError = err.message || String(err);
    console.error('[poll/auth] failed:', lastAuthError);
  } finally {
    authPollInFlight = false;
  }
}

function snapshot() {
  const u = usageState;
  const c = codexQuotaState;
  return {
    ok: !!u,
    error: lastUsageError,
    authError: lastAuthError,
    fetchedAt: u?.fetchedAt ?? null,
    pollIntervalMs: POLL_INTERVAL_MS,
    rateWindowSec: u?.rateWindowSec ?? RATE_WINDOW_SEC,
    totalTokens: u?.totalTokens ?? 0,
    totalRequests: u?.totalRequests ?? 0,
    successCount: u?.successCount ?? 0,
    failureCount: u?.failureCount ?? 0,
    totalCost: u?.totalCost ?? 0,
    tpm: u?.tpm ?? 0,
    rpm: u?.rpm ?? 0,
    rateRequestCount: u?.rateRequestCount ?? 0,
    rateTokenCount: u?.rateTokenCount ?? 0,
    usageChart: u?.usageChart ?? null,
    apiUsers: u?.apiUsers ?? [],
    codex: c
      ? {
          total: c.total,
          available: c.available,
          limited: c.limited,
          sumRemaining: c.sumRemaining,
          totalPool: c.totalPool,
          poolRemainingPercent: c.poolRemainingPercent,
          poolRemainingRatio: c.poolRemainingRatio,
          nextResetAt: c.nextResetAt,
          latestResetAt: c.latestResetAt,
          forecast: c.forecast,
          accounts: c.accounts.map(({ id, ...account }) => account),
          authFetchedAt: codexQuotaFetchedAt,
          authPollIntervalMs: AUTH_POLL_INTERVAL_MS,
        }
      : null,
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function serveStatic(req, res) {
  let urlPath = '/';
  try {
    urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch {
    res.writeHead(400).end('bad request');
    return;
  }
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = normalize(join(ROOT, rel));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const buf = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  } catch {
    res.writeHead(404).end('not found');
  }
}

const server = http.createServer(async (req, res) => {
  const routePath = (req.url || '/').split('?')[0];
  if (routePath === '/api/tokens') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(snapshot()));
    return;
  }
  await serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`[token-counter] http://localhost:${PORT}`);
  pollUsageOnce();
  pollAuthOnce();
  setInterval(pollUsageOnce, POLL_INTERVAL_MS);
  setInterval(pollAuthOnce, AUTH_POLL_INTERVAL_MS);
});
