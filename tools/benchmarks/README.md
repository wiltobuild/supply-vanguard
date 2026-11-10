# Read-only API benchmark runner (SV-028)

Tooling to measure how fast read-only GET endpoints respond. Built-in Node 22 only: no new dependencies, no root, CI, app, backend, migration or ops changes. Everything lives in this folder.

> **No measurements have been made.** This is source-only preparation. Nothing here was run against a live server, and no latency number in this repository comes from this tool. A real measurement needs a specifically approved exact candidate (commit), runtime and environment, agreed with the people who own SV-016. Running this tool does not pass or close any SV-016 gate (browser, accessibility, performance or integration acceptance).

## What it does

For each endpoint you list, it sends `warmup` requests (discarded), then `samples` measured requests, and reports:

- sample counts, successes, errors and timeouts, with error classes (`http_500`, `redirect_not_followed`, `transport_error`, `invalid_response`, `clock_error`)
- p50, p95 and p99 latency in milliseconds, plus min and max
- the revision and environment labels you supply (`NOT PROVIDED` if you give none)
- `NOT RUN` wherever there is nothing to report (no successful sample, or the run was cancelled before it started)

## Safety rules (enforced before any request is sent)

- **GET only.** Any other method (or any extra field) is rejected.
- **Explicit allowlist.** Only the endpoints you list. It never discovers endpoints. Each path must start with one `/`, with no `..`, fragment, backslash, spaces or scheme, and must stay on the `baseUrl` origin. The origin comparison is a second layer: the path rule already blocks every case the origin check could catch.
- **Redirects are not followed.** A 3xx is counted as an error (`redirect_not_followed`).
- **Bounded:** at most 50 endpoints, 1000 samples, 100 warmups, 16 concurrent requests, 60 s timeout, and a total workload cap (`maxRequests`, default 2000, ceiling 10000).
- **No secrets in output.** Header names and values, query values, response bodies and transport error text never appear in results or messages. Query values are shown as `[redacted]`. Labels accept only plain characters, so do not put secrets in them.

## Conventions

- **Timing:** monotonic clock (`performance.now()`), elapsed milliseconds per request.
- **Percentiles:** nearest-rank on the ascending successful samples: the value at rank `ceil(p/100 * n)`. No interpolation. With 1 sample, every percentile is that sample.
- **Latency basis:** successful (2xx) samples only. Failures and timeouts are counted separately, and the text summary prints a warning whenever any occurred, so a run with failures is never read as all requests succeeding.
- **Warmup:** all warmup requests, across all endpoints, finish before the first measured request starts. Warmup results are discarded.
- **Concurrency and stalled transports:** the cap counts transports that are actually still running, including ones that ignore the abort signal after a timeout or cancel. A timeout frees no slot while the transport is still outstanding. If outstanding requests fill the cap, the run stops with status `STALLED` (unfinished endpoints are `PARTIAL` or `NOT RUN`, `failuresPresent` is true, the CLI exits 1) instead of starting more requests or hanging. A late answer from an abandoned request is never counted as a success.
- **Error messages:** validation and command line errors are fixed text. They never repeat names, arguments, environment variable names or transport exception text you supplied, so a secret typed in the wrong place cannot reach stderr or logs.
- **Cancellation:** abort the run (Ctrl+C in the CLI). No new request starts, in-flight ones are aborted, and the result status is `CANCELLED` with unfinished endpoints marked `PARTIAL` or `NOT RUN`.

## Config

```json
{
  "baseUrl": "https://example.test",
  "endpoints": [
    {"name": "equipment-list", "path": "/organizations/ORG_ID/equipment?limit=25"}
  ],
  "warmup": 5,
  "samples": 50,
  "concurrency": 2,
  "timeoutMs": 5000,
  "labels": {"revision": "main 80a9041", "environment": "local-synthetic"},
  "headerEnv": {"authorization": "SV_BENCH_AUTH"}
}
```

`headerEnv` reads each header value from the named environment variable at run time, so no credential is stored in the config file or printed. A missing variable is reported by name only.

## Use

```sh
node tools/benchmarks/cli.mjs --config my-config.json --format text   # or json
```

Exit code 0 only when the run completed with no errors or timeouts; 1 for failures, a stall or cancellation; 2 for an invalid config.

From code, inject the transport and clock (this is how the tests avoid any network):

```js
import {runBenchmark} from './runner.mjs';
const result = await runBenchmark(config, {transport, clock, signal});
```

## Tests

```sh
node --test tools/benchmarks/tests/*.test.mjs
```

Deterministic: injected transport and a fake clock, no network, server, database, token or credential. They cover warmup exclusion, percentile boundaries, errors and timeouts, cancellation, invalid settings, bounded concurrency and redaction. They are not part of the root `npm test`.
