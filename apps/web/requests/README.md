# SV-027: task-local requests, holds and returns

This is a mountable module, not shared-app integration. No host entry point, route dispatcher, server, token flow, role configuration, fixture or package dependency is changed. The only implementation paths are this directory and `apps/web/tests/request-lifecycle.test.mjs`.

## Host contract

Load `styles.css`, then import `createRequestApi` from `client.js` and `mountRequests` from `view.js`. Call `createRequestApi({organizationId, transport})`; transport receives `(organizationScopedPath, {method, body, signal})` and must return parsed JSON or throw an error with HTTP `status` and an honest `uncertain` flag for potentially committed writes. It is the existing authenticated host's responsibility to add authentication, JSON encoding, no-store semantics, timeout and access handling. Do not inject a transport that treats non-2xx HTTP as success. This module stores no credentials or browser persistence.

Mount with `mountRequests(element, {api, permissions, role, equipment, equipmentTypes})`. Permissions and role must be the current authenticated membership, never UI-selected authority. Equipment must be current authorized inventory records (`id`, `modelKind`, `version`, `status`); selecting one is not proof it is assignable. Equipment types are authorized strings for the creation form. Empty permissions deny mutation controls. Server authorization is always authoritative.

The host must call `resetAccess()` immediately on identity, organization, role, or view changes; this aborts work and drops protected records, inventory and drafts. Dispose and mount anew with a new API after the host establishes the next authorized context. `dispose()` removes listeners, aborts reads/writes and clears DOM. Repeated mount on the same element automatically disposes its prior module. Closing during a write does not roll back the server; host navigation must disclose that possibility and load server truth upon return.

## Frozen existing contracts

- Create: POST `/organizations/:org/requests` body `{items:[{equipmentType}],note?}`. One entry is one demand unit, 1–20 entries. There is no server creation command key: uncertain creation is not retryable. Reconcile the request list before starting a genuinely new request.
- List: GET `/organizations/:org/requests?limit=100&cursor=...`. All pages are fetched with repeated-cursor detection. The legacy list summaries are never displayed as lifecycle quantities.
- Claim each line: POST `/organizations/:org/requests/:id/items/:line/claim` body `{equipmentId,expectedVersion}`. This expected version belongs to equipment, not lifecycle. Existing exact claim replay semantics are preserved. Multi-item requests are assigned line-by-line, not presented as an atomic bulk operation.
- Read lifecycle: GET `/organizations/:org/requests/:id/lifecycle`, using frozen SV-022 shape with `items`, `summary`, per-line `version`, `assignments`, `holds`, `history`, custody timestamps and `demandCancelled`. UI quantities are derived from these item records, not the legacy summary. Delivered remains cumulative via `receivedAt`.
- Transition: POST `/organizations/:org/requests/:id/items/:line/lifecycle`, body `{action,expectedVersion,commandKey,condition?}`. `action` is dispatch/receive/cancel/return/missing/fail. Return requires an explicitly selected clean/dirty/fault/maintenance/unknown condition. Key/body are frozen for exact retry; every newly requested action receives a new key. A 409 refetches and requires review; 422 exposes readiness blocking. No optimistic assignment release or location move.
- Holds: POST `/organizations/:org/equipment/:id/holds` with `{kind,reason?}`; POST `/organizations/:org/holds/:holdId/clear` with no body; GET `/organizations/:org/holds/clearance-rules` returns `{rules:[{kind,role}]}`. A clear button requires that active hold's matching configured role; no fallback/admin exception. Unknown create/place/clear outcomes require explicit reconciliation rather than assuming replay safety.

## Clearance provenance and remaining evidence decision

Existing `services/api/holds/service.mjs` passes `user:${ctx.userId}` from server auth into `clear_equipment_hold`. `services/api/holds/migrations/0001_holds.up.sql` lines 83–103 checks current configured membership role and records `cleared_by` and `cleared_at`; the immutable hold also retains placement actor, time and reason. The UI displays available actors/times and never calls placement reason new clearance evidence. Lifecycle read currently omits the placement reason; standalone holds GET exposes it, but this module does not promise its presence in lifecycle responses.

There is no separate clearance observation/document/reference field in the existing schema or clear command. Whether actor/time/retained hold provenance meets the maintained PRD's evidence criterion needs acceptance clarification. No hold API or business policy was changed to guess the answer.

## Interaction and truthfulness

Pre-dispatch demand cancellation requires an explicit not-in-transit confirmation. Post-dispatch cancellation is labeled demand-only; assignment remains whatever the server returns. Dirty, fault, maintenance and unknown flags are rendered independently. Missing/failed outcomes never imply availability. No overdue deadline, threshold, reconciliation release or business role is invented. All supported lifecycle transitions are available as explicit commands to an authorized writer; server rejects invalid transitions. No action is silently retried.

The view uses semantic labels, forms, buttons, status/alert regions, details and native keyboard controls; restores focused draft controls where possible and focuses status if an action disappears. Drafts survive refresh/conflict, but are erased on navigation/access reset and denied reads. Busy controls prevent repeated submissions. Layout is a one-column reading order at phone widths, with a pastel card grid on larger screens, visible focus, minimum 44px controls, reduced-motion support and dark text on coral.

## Verification scope

Run `node --test apps/web/tests/request-lifecycle.test.mjs` and `npm run check`. Tests cover transport bodies, cumulative partial demand, safe cancellation, independent holds, roles, exact retry, unsafe creation retry prevention, conflicts, 422, stale reads/writes, access reset, dispose/remount and semantic rendering/focus fallback through a minimal DOM boundary. These DOM-boundary tests do not simulate native keyboard/browser layout.

No new listener or browser fixture was started. Actual browser keyboard, narrow-screen screenshot, backend HTTP integration, shared-host mount, root aggregate tests with restricted fixtures, full request-to-return E2E and production/pilot readiness are not verified by this module. Shared-host integration must wait for the explicit SV-008 handoff and verified SV-022 backend. Do not report this standalone module as a completed integrated journey.

## Review repair verification

The first local commit ec8a5436 was not accepted. Independent review found cross-request draft/confirmation reuse, focus loss across asynchronous node replacement, and stale conflict results overriding newer navigation or failed refreshes. Repairs key drafts by request identity (including automatic create/retry navigation), give status and action families stable focus identities, and gate post-refresh conflict/success phases on the still-current successful load generation. Replacement-aware DOM tests exercise consecutive busy/loading/result renders and request identity changes, rather than merely checking one fallback focus call. Failed/denied/stale conflict refreshes retain their real current state.

The root `npm test` aggregate remains NOT RUN. It imports `tests/board-race.test.mjs` (temporary Git fixtures) and service tests that create runtime roles/listeners, plus native database cluster fixtures. Those operations remain outside this task's preserved verification boundaries. No aggregate passed/failed/skipped counts are claimed.
