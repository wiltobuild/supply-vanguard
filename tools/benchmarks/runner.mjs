// Read-only API benchmark runner (SV-028). Built-in Node facilities only; transport and clock are injected so tests need no network.
// This file is tooling. It contains no measurements. See README.md for what a run does and does not prove.

export const NOT_RUN = 'NOT RUN';
export const LIMITS = Object.freeze({
  maxEndpoints: 50, maxSamples: 1000, maxWarmup: 100, maxConcurrency: 16,
  maxTimeoutMs: 60000, defaultTimeoutMs: 5000, defaultMaxRequests: 2000, maxRequestsCeiling: 10000,
});
const TOP_KEYS = new Set(['baseUrl', 'endpoints', 'warmup', 'samples', 'concurrency', 'timeoutMs', 'maxRequests', 'labels', 'headers']);
const LABEL = /^[A-Za-z0-9._:/ -]{1,100}$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const ENDPOINT_NAME = /^[A-Za-z0-9._-]{1,64}$/;

const fail = message => { throw new RangeError(message); };
const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
function int(name, value, min, max, fallback) {
  const v = value === undefined ? fallback : value;
  if (!Number.isInteger(v) || v < min || v > max) fail(`${name} must be a whole number from ${min} to ${max}`);
  return v;
}

// Validates everything BEFORE any transport call. Returns a normalized, frozen config.
export function validateConfig(raw) {
  if (!isPlain(raw)) fail('Config must be an object');
  // Names the caller typed are never echoed back in errors: a mistyped or misplaced secret would otherwise reach stderr and logs.
  if (Object.keys(raw).some(key => !TOP_KEYS.has(key))) fail(`Unknown setting in config (allowed: ${[...TOP_KEYS].join(', ')})`);

  let base;
  try { base = new URL(raw.baseUrl); } catch { fail('baseUrl must be an absolute http(s) URL'); }
  if (!['http:', 'https:'].includes(base.protocol)) fail('baseUrl must use http or https');
  if (base.username || base.password) fail('baseUrl must not contain credentials');
  if (base.pathname !== '/' || base.search || base.hash) fail('baseUrl must be an origin only (no path, query or fragment)');
  const origin = base.origin;

  if (!Array.isArray(raw.endpoints) || raw.endpoints.length < 1 || raw.endpoints.length > LIMITS.maxEndpoints) {
    fail(`endpoints must be a list of 1 to ${LIMITS.maxEndpoints} explicit entries`);
  }
  const seen = new Set();
  const endpoints = raw.endpoints.map((entry, i) => {
    if (!isPlain(entry)) fail(`Endpoint ${i + 1} must be an object`);
    if (Object.keys(entry).some(key => !['name', 'path', 'method'].includes(key))) fail(`Endpoint ${i + 1}: unknown setting (allowed: name, path, method)`);
    if (entry.method !== undefined && entry.method !== 'GET') fail(`Endpoint ${i + 1}: only GET is allowed`);
    if (typeof entry.name !== 'string' || !ENDPOINT_NAME.test(entry.name)) fail(`Endpoint ${i + 1}: name must be 1-64 letters, digits, dot, dash or underscore`);
    if (seen.has(entry.name)) fail(`Endpoint ${i + 1}: duplicate name`);
    seen.add(entry.name);
    const p = entry.path;
    if (typeof p !== 'string' || p.length > 300 || !/^\/(?!\/)[\x21-\x7e]*$/.test(p) || p.includes('\\') || p.includes('#')) {
      fail(`Endpoint ${i + 1}: path must start with a single "/" and contain no fragment, backslash or spaces`);
    }
    if (p.split('?')[0].split('/').includes('..')) fail(`Endpoint ${i + 1}: path must not contain ".."`);
    const url = new URL(p, `${origin}/`);
    if (url.origin !== origin) fail(`Endpoint ${i + 1}: path resolves to a different destination`);
    const query = [...url.searchParams.keys()].map(k => `${k}=[redacted]`).join('&');
    return Object.freeze({ name: entry.name, url: url.href, display: url.pathname + (query ? `?${query}` : '') });
  });

  const warmup = int('warmup', raw.warmup, 0, LIMITS.maxWarmup, 0);
  const samples = int('samples', raw.samples, 1, LIMITS.maxSamples, 30);
  const concurrency = int('concurrency', raw.concurrency, 1, LIMITS.maxConcurrency, 1);
  const timeoutMs = int('timeoutMs', raw.timeoutMs, 1, LIMITS.maxTimeoutMs, LIMITS.defaultTimeoutMs);
  const maxRequests = int('maxRequests', raw.maxRequests, 1, LIMITS.maxRequestsCeiling, LIMITS.defaultMaxRequests);
  const total = endpoints.length * (warmup + samples);
  if (total > maxRequests) fail(`Workload of ${total} requests exceeds maxRequests (${maxRequests})`);

  const labels = { revision: 'NOT PROVIDED', environment: 'NOT PROVIDED' };
  if (raw.labels !== undefined) {
    if (!isPlain(raw.labels)) fail('labels must be an object');
    for (const [k, v] of Object.entries(raw.labels)) {
      if (!['revision', 'environment'].includes(k)) fail('Unknown label (allowed: revision, environment)');
      if (typeof v !== 'string' || !LABEL.test(v)) fail(`label ${k} must be 1-100 plain characters (letters, digits, . _ : / space -); never put secrets in labels`);
      labels[k] = v;
    }
  }

  const headers = {};
  if (raw.headers !== undefined) {
    if (!isPlain(raw.headers)) fail('headers must be an object');
    for (const [k, v] of Object.entries(raw.headers)) {
      if (!HEADER_NAME.test(k)) fail('Invalid header name');
      if (typeof v !== 'string' || v.length > 4096 || /[\r\n]/.test(v)) fail('Invalid header value');
      headers[k] = v;
    }
  }
  return Object.freeze({ origin, endpoints: Object.freeze(endpoints), warmup, samples, concurrency, timeoutMs, maxRequests, labels: Object.freeze(labels), headers: Object.freeze(headers) });
}

// Nearest-rank percentile: the value at 1-based rank ceil(p/100 * n) of the ascending sorted samples. No interpolation.
export function percentile(sortedAscending, p) {
  const n = sortedAscending.length;
  if (n === 0) return null;
  if (!(p > 0 && p <= 100)) fail('percentile must be above 0 and at most 100');
  return sortedAscending[Math.min(n, Math.max(1, Math.ceil((p / 100) * n))) - 1];
}

export function defaultClock() {
  return { now: () => performance.now(), setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: handle => clearTimeout(handle) };
}

// Only the status code is looked at. The response body is never read or kept.
function classify(res) {
  const status = res && res.status;
  if (!Number.isInteger(status) || status < 100 || status > 599) return { kind: 'error', cls: 'invalid_response' };
  if (status >= 200 && status < 300) return { kind: 'ok' };
  if (status >= 300 && status < 400) return { kind: 'error', cls: 'redirect_not_followed' };
  return { kind: 'error', cls: `http_${status}` };
}

export async function runBenchmark(rawConfig, { transport, clock = defaultClock(), signal } = {}) {
  if (typeof transport !== 'function') throw new TypeError('A transport function is required');
  const cfg = validateConfig(rawConfig);
  const started = clock.now();
  const stats = cfg.endpoints.map(() => ({ warmupDone: 0, done: 0, ok: 0, timeouts: 0, errors: 0, classes: {}, latencies: [] }));
  const cancelled = () => Boolean(signal && signal.aborted);
  // Transports that are actually still running, including ones abandoned after a timeout or cancel that ignore the abort signal.
  // A new request never starts while this is at the concurrency cap, so the cap holds for real outstanding work.
  let outstanding = 0, stalled = false;

  function attempt(endpoint) {
    return new Promise(resolve => {
      const controller = new AbortController();
      let settled = false, timer;
      const onAbort = () => { controller.abort(); finish({ kind: 'cancelled' }); };
      function finish(outcome) {
        if (settled) return;
        settled = true;
        clock.clearTimer(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(outcome);
      }
      timer = clock.setTimer(() => { controller.abort(); finish({ kind: 'timeout' }); }, cfg.timeoutMs);
      if (signal) {
        if (signal.aborted) return finish({ kind: 'cancelled' });
        signal.addEventListener('abort', onAbort, { once: true });
      }
      let pending;
      try { pending = Promise.resolve(transport({ url: endpoint.url, method: 'GET', headers: cfg.headers, signal: controller.signal, timeoutMs: cfg.timeoutMs })); }
      catch { return finish({ kind: 'error', cls: 'transport_error' }); }
      // The transport's own error text is deliberately dropped: it can contain URLs or credentials.
      outstanding++;
      pending.then(res => { outstanding--; finish(classify(res)); }, () => { outstanding--; finish({ kind: 'error', cls: 'transport_error' }); });
    });
  }

  async function phase(tasks, measured) {
    let next = 0;
    const worker = async () => {
      while (!cancelled() && !stalled && next < tasks.length) {
        if (outstanding >= cfg.concurrency) { stalled = true; return; }   // earlier requests never finished: stop instead of exceeding the cap
        const index = tasks[next++], s = stats[index];
        const t0 = clock.now();
        const outcome = await attempt(cfg.endpoints[index]);
        const elapsed = clock.now() - t0;
        if (outcome.kind === 'cancelled') return;
        if (!measured) { s.warmupDone++; continue; }       // warmup results are discarded, never mixed into the measured samples
        s.done++;
        if (outcome.kind === 'timeout') { s.timeouts++; continue; }
        if (outcome.kind === 'error') { s.errors++; s.classes[outcome.cls] = (s.classes[outcome.cls] || 0) + 1; continue; }
        if (!(elapsed >= 0)) { s.errors++; s.classes.clock_error = (s.classes.clock_error || 0) + 1; continue; }
        s.ok++; s.latencies.push(elapsed);
      }
    };
    await Promise.all(Array.from({ length: Math.min(cfg.concurrency, tasks.length) }, worker));
  }

  const warmTasks = [], measuredTasks = [];
  for (let i = 0; i < cfg.warmup; i++) cfg.endpoints.forEach((_, e) => warmTasks.push(e));
  for (let i = 0; i < cfg.samples; i++) cfg.endpoints.forEach((_, e) => measuredTasks.push(e));
  await phase(warmTasks, false);            // warmup finishes completely before any measured sample starts
  await phase(measuredTasks, true);

  const endpoints = cfg.endpoints.map((endpoint, i) => {
    const s = stats[i], sorted = [...s.latencies].sort((a, b) => a - b);
    const status = s.done === 0 ? NOT_RUN : s.done < cfg.samples ? 'PARTIAL' : 'MEASURED';
    return {
      name: endpoint.name, path: endpoint.display, status,
      warmup: { completed: s.warmupDone },
      measured: { requested: cfg.samples, completed: s.done, succeeded: s.ok, errors: s.errors, timeouts: s.timeouts, errorClasses: { ...s.classes } },
      latencyMs: s.ok === 0
        ? { basis: 'successful samples only', p50: NOT_RUN, p95: NOT_RUN, p99: NOT_RUN, min: NOT_RUN, max: NOT_RUN }
        : { basis: 'successful samples only', p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99), min: sorted[0], max: sorted[sorted.length - 1] },
    };
  });
  const any = endpoints.some(e => e.measured.completed > 0);
  return {
    schemaVersion: 1,
    status: cancelled() ? 'CANCELLED' : stalled ? 'STALLED' : any ? 'COMPLETE' : NOT_RUN,
    labels: { ...cfg.labels },
    target: cfg.origin,
    settings: { warmup: cfg.warmup, samples: cfg.samples, concurrency: cfg.concurrency, timeoutMs: cfg.timeoutMs, percentileMethod: 'nearest-rank' },
    totalElapsedMs: clock.now() - started,
    failuresPresent: stalled || endpoints.some(e => e.measured.errors > 0 || e.measured.timeouts > 0),
    endpoints,
    note: 'Latencies describe only this run against the stated target, revision and environment. They are not a pass or a claim about any other condition.',
  };
}

export function formatText(result) {
  const lines = [
    `Benchmark ${result.status}  revision: ${result.labels.revision}  environment: ${result.labels.environment}`,
    `target: ${result.target}  warmup: ${result.settings.warmup}  samples: ${result.settings.samples}  concurrency: ${result.settings.concurrency}  timeout: ${result.settings.timeoutMs} ms  percentiles: ${result.settings.percentileMethod}`,
  ];
  if (result.failuresPresent) lines.push('WARNING: failures or timeouts occurred. Latencies cover successful samples only; do not read this as all requests succeeding.');
  for (const e of result.endpoints) {
    const m = e.measured, l = e.latencyMs, f = v => (typeof v === 'number' ? v.toFixed(1) : v);
    lines.push(`${e.name} ${e.path} [${e.status}] ok ${m.succeeded}/${m.requested} errors ${m.errors} timeouts ${m.timeouts}  p50 ${f(l.p50)}  p95 ${f(l.p95)}  p99 ${f(l.p99)} ms`);
    const classes = Object.entries(m.errorClasses);
    if (classes.length) lines.push(`  error classes: ${classes.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  lines.push(result.note);
  return lines.join('\n') + '\n';
}

// Production transport: GET only, redirects are NOT followed (a 3xx is reported as an error), body is never read.
export function createFetchTransport(fetchImpl = globalThis.fetch) {
  return async ({ url, headers, signal }) => {
    const res = await fetchImpl(url, { method: 'GET', headers, signal, redirect: 'manual', cache: 'no-store' });
    try { await res.body?.cancel(); } catch { /* ignore: the body is intentionally unused */ }
    return { status: res.status };
  };
}
