# Monitoring and readiness guidance

No metrics endpoint, collector, dashboard, health route, background scheduler or alert transport is
installed by this task. The owner must bind these checks to the assembled service and existing
authorized observability system. Use bounded aggregates and safe correlation IDs; avoid tokens,
raw envelopes, patient-linked data, equipment/user IDs and tenant names in public metric labels.
Confirm tenant-scoped access for any detailed investigation; an operator's equipment-write access
does not grant audit-read access to dead letters.

| Signal | Definition / current source | Response and owner |
| --- | --- | --- |
| Liveness | Process responds within a chosen timeout; static `GET /` only checks the demo | Service owner checks process/resources; do not infer DB or authorized API readiness |
| Readiness | Bounded DB/auth/RLS/migration/verifier/journal checks at actual service boundary | Remove unhealthy instance from traffic; service/DB/security owners investigate privately |
| API errors and latency | Count response status and duration at the assembled equipment HTTP handler; group unexpected 5xx separately from expected 401/403/409/422 | Service owner investigates 5xx, latency and conflict/retry spikes; security owner reviews auth anomalies |
| Ingestion delay | `received_at - observed_at` from accepted immutable observations; retain both clocks and report a distribution over a defined window | Integration owner checks device clock, source/network and backlog; late receipt is not fresh physical verification |
| Source silence | Age of most recent accepted receipt per expected source; a zero-event interval is missing evidence, not zero delay | Integration/ward owners verify expected schedules and device status; no real hardware exists here |
| Stale/unknown equipment | At evaluation time, compare equipment `last_verified_at` to the ward owner's chosen physical-freshness threshold; null is unknown; expose unknown count separately | Ward lead verifies equipment manually; administrative edits and receipt times never refresh physical confidence |
| Dead-letter/replay trends | Tenant `ingestion_dead_letter` reason counts through an authorized audit capability; external journal for pre-auth and transaction failures | Service/security owners investigate; never automatically resubmit rejected raw bodies |
| Journal failures | Safe failure counter at rejectionJournal adapter/HTTP failure boundary | Service owner restores writable protected evidence sink; investigate 503 ingestion-unavailable and retain missing-evidence interval |
| Failed background work | Failure/retry/backlog counts for each future actual job | No job runner currently exists; owner must implement a collector when adding jobs; absent data is unknown |
| Database/backup | Connection saturation, storage, backup success/age and restore evidence age in chosen provider | DB owner handles capacity/recovery; backup completion is not proof of usable recovery |

The service currently returns ingestion `201 accepted`, `200 duplicate`, expected `400/401/403/404/409`
errors and unexpected `503 ingestion-unavailable`. Count duplicates/replays separately from new
observations. Do not count a successful HTTP retry as another equipment observation. The injectable
handler does not project location; SV-014 owns resolution. A recent receipt cannot certify a
current equipment location. Equipment replay/concurrency fixes in PR #12 were absent from this
branch's pinned baseline; they merged into main while SV-017 was being built. Reconcile the
actual release revision before pilot testing; this branch does not rebase another owner's work.

## Aggregate sample evaluator

`node ops/monitor.mjs --input <aggregate.json>` reads at most 16 KiB and produces only named signal
states. Exit 0 means the supplied fresh aggregate is within its supplied thresholds, 1 means an
alert, and 2 means unknown/invalid data. It does not prove service health, open a network connection,
collect data or deliver a notification. Missing, invalid, old or future samples cannot pass.
The checked-in [synthetic example](examples/telemetry.synthetic.json) intentionally becomes stale;
it should return unknown when evaluated after its example window. Tests supply a fixed clock.

Before an owner supplies a real sample, approve window length, denominator and collection rules:

- `apiErrorRatio`: unexpected 5xx / all completed API requests in the same window. If denominator
  is zero or collection fails, report null. Monitor latency separately; this evaluator has no p95 field.
- `ingestionDelaySeconds`: chosen percentile of accepted receipt-minus-observed ages in that window.
  No accepted observations means null; source-silence monitoring remains independently required.
- `staleEquipmentRatio`: physically stale items / total authorized scoped equipment, evaluated using
  an owner-approved age threshold. Unknown equipment has its own count in the eventual collector;
  until the collector can supply a trustworthy scope/denominator and unknown count, report null.
- `backgroundFailures` and `journalFailures`: integer failure counts in the same window. Unavailable
  instrumentation is null; zero requires positive collection evidence. No jobs currently means an
  explicit not-applicable owner decision outside this evaluator, not an invented healthy job runner.
- `measuredAt`: end of the collection window as a UTC instant; `maxSampleAgeSeconds` bounds the age
  at evaluation. Clocks and collection gaps require separate monitoring. Ratios are in [0,1].

All numeric example thresholds are test fixtures, not service guarantees. The plan's proposed
5-second update visibility, 500-ms routine API p95 and workstation/render targets remain pilot
measurements. Agree real warning/page levels, windowing/hysteresis, staffed response and recovery
targets after representative synthetic load tests. Source silence and missing metrics should
alert through an independent collector heartbeat so a stopped collector cannot report green.

## Readiness evidence to retain

Record release revision, private readiness outcomes, authorization failures tested, synthetic
end-to-end response/integrity evidence, measured delay and latency, stale/unknown counts, failed
collection intervals and the response owner. Rehearse alert delivery and escalation through the
chosen system with authorization. No alert or external communication was sent for this task.
