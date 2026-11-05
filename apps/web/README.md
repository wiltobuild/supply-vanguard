# Shared equipment client (SV-007)

The equipment service owns inventory. This client does not load or save equipment in browser storage. The existing ward, procedural source, GLBs, responsive layout and list fallback remain in use. Browser-only supply counts inside the original viewer are a separate synthetic demo.

## Run locally

Use Node 22+ and an existing authorized, loopback equipment API implementing `services/api/equipment/routes.mjs`. This task does not introduce another server/auth implementation or provision identities. A trusted local bootstrap must supply an already issued short-lived synthetic session and its organization ID, following `services/api/auth/README.md`. Never use real identities or patient data.

```powershell
$env:API_ORIGIN = 'http://127.0.0.1:4181' # your existing equipment API origin
npm run dev --prefix apps/web
```

Open `http://127.0.0.1:4180`, enter the authorized organization and session token, and connect. Credentials stay in memory, are cleared from the input on connection, and disappear on reload/disconnect. There is no token issuance endpoint, credential persistence, account setup or production identity provider here. The local web proxy accepts only a loopback HTTP upstream and forwards the existing API contract. Without `API_ORIGIN`, it returns an explicit service error. Root `npm run dev` remains the original static-only server; use the task-local command for API development. Production hosting must mount the approved API under the same origin; this local proxy is not a production server.

## Behavior

- Visible clients normally poll every five seconds. Transient network, 408/429 and server failures retry after 5, 10, 20 and then at most once every 30 seconds. Authentication/permission failures and cancelled reads wait for explicit recovery. Hidden/offline clients pause background reads, and reads never overlap. Reconnect, returning to a tab and Refresh perform a fresh authoritative read. Pagination is collected before replacing state. Failed reads retain a clearly labelled last response through retries; only a successful read clears the warning. Initial failure never substitutes sample inventory.
- A separate one-second clock updates observation freshness, verification counts and the next-to-verify panel, including five-minute and thirty-minute threshold crossings when equipment records are unchanged. It updates existing text, classes and visibility without replacing focused controls or draft fields.
- A status/note save sends the captured draft version. A conflict refetches current state while preserving the draft; **Use latest version and review draft** adopts the latest version explicitly. Review the displayed current status and your draft, then save again. **Cancel edits** restores the last fetched record. Navigation and Back retain the current draft until another asset is selected.
- Physical location is a separate, explicit manual observation. Status/note changes do not touch verified location or its freshness. Stable equipment/location IDs, model kind and provenance reach the existing scene through a small compatibility projection. Unmapped locations stay in the list and are omitted from scene placements.
- Every accepted mutation/replay refetches the current inventory. An old idempotent response snapshot never replaces a newer record. Repeated clicks are blocked while saving. Stopping a save or losing its response can leave the commit outcome uncertain; refresh and inspect shared state before making another change. Cancellation cannot undo a server commit.
- Session expiry, permission failures, invalid transitions, server/network errors, loading, refresh cancellation and retry are explicit. Recent activity is labelled as this tab's confirmed actions; this client does not query the separate shared audit API. Disconnect clears inventory and activity from this tab.

## Verify

```powershell
npm ci --prefix services/api/auth --ignore-scripts --no-audit --no-fund
npm test
npm run check
npm test --prefix apps/web
```

The task suite uses the unchanged public auth/equipment handlers, real HTTP through the local web proxy, migrations, seed and in-memory PGlite. It tests independent clients, competing/stale writes, explicit recovery, reconnect, status/location separation, scene ID placement, replay refetch, repeated clicks, uncertain cancellation, authorization failures, response errors, pagination and public asset serving. Current main includes the merged SV-023 receipt implementation. The fixture conditionally loads the receipt migration when present inside BEGIN/COMMIT and grants SELECT/INSERT only to its throwaway test role; no production role or auth policy is changed. The replay test now verifies the real original receipt snapshot after a newer commit, without substituting a response. PGlite serializes connections; native PostgreSQL parallel-session/location-lock testing belongs to the server checks.

Deterministic injected-clock tests cover freshness thresholds, unchanged poll responses, preserved view-control objects/draft values, persistent warnings during retries, capped retry delays, auth/cancellation separation, and hidden/offline/in-flight suppression. These view-boundary tests are not real browser focus tests. The branch integrates main `9113df98c2601820f7a13c471b9d4c226458654c`, including its fifteen added illustrative scene assets; existing scene files are not modified by this task.

Browser QA attempted on Windows on November 5, 2026: Chrome extension controls failed with `Cannot read properties of undefined (reading 'timeoutMs')`; the in-app browser timed out reaching loopback; native Chrome capture failed with `copy Direct3D surface to SoftwareBitmap failed: Not implemented (0x80004001)`. Therefore no browser success, screenshots, narrow viewport/keyboard/navigation or live WebGL validation is claimed. Existing fallback code and scene-placement checks pass, but browser review remains required before approval.

Resumed browser attempt at 23:03 UTC on November 5, against an isolated OS-assigned loopback port, still failed in supported Chrome tab creation with the same `timeoutMs` error. No alternate automation route was used to bypass the unavailable controls.
