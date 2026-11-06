# Scoped supply workspace (SV-010)

`view.mjs` exports `mountSupplies(root, {client, synthetic?, makeKey?})`, returning `{ready, refresh, destroy}`. It uses the existing shared design tokens/styles plus `supplies.css`: white canvas, large headline, pastel grouped work, semantic forms, visible focus and 44px controls. No WebGL is required. Counts, unit labels, configuration status, ownership, loading, empty, conflict and revoked-access states come from the API.

`client.mjs` exports `createReplenishmentClient({organizationId, fetchImpl?})`. It uses same-origin, no-store JSON routes, keeps credentials out of browser storage, and accepts the host's existing authenticated fetch implementation. A cookie-based host needs its normal CSRF/origin defense. A bearer-based host should inject its in-memory session headers through `fetchImpl`; this module issues no identity or token.

```js
import {mountSupplies} from './supplies/view.mjs';
import {createReplenishmentClient} from './supplies/client.mjs';
const screen = mountSupplies(root, {
  client: createReplenishmentClient({organizationId: verifiedSession.organizationId, fetchImpl: authenticatedFetch})
});
await screen.ready;
// On route exit, logout, tenant change or access loss:
screen.destroy();
```

Host mounting owns the route and session lifecycle. Call `destroy()` before changing tenant/session. A 401/403 clears rendered records, pending requests and drafts. Use the default UUID key factory outside deterministic tests.

Users configure an explicit par quantity with a reason, check low stock, assign an open task to themselves, record the actual received quantity to complete it, or correct an absolute counted quantity. All quantities are decimal strings in the displayed SKU unit. There are no recommended operational values or automatic refill targets. A zero closure remains explicit and audited. Configuration is versioned. The queue item is the in-app alert; checking again retains its active identity. No emails, SMS, Slack, push notifications, schedule or background delivery is present.

Drafts remain editable after known rejection. Explicit refresh preserves their text while updating displayed stock/task versions. An ambiguous transport/5xx/unreadable mutation response retains its **original command and key**, locks the draft, and exposes an unchanged retry even if refetch removes the completed item from the active queue. Other mutations are blocked until confirmation. Save success followed by refetch failure is labeled saved/stale and blocks another action until refresh succeeds. A reload loses in-memory draft state; the server's task/version/receipt guards still protect against repeated stock addition.

## Shared-app integration gap

This screen and API are **not mounted in the actual shared application**. `index.html` truthfully displays “Not connected” and loads no data or session. No shared file was edited.

Minimum integration work for the existing web/host owner, after separately authorized scope coordination:

1. Add the supply route and `mountSupplies`/`destroy` session lifecycle to `apps/web/src/app.js`; add a semantic navigation entry in `apps/web/index.html` if navigation is meant to expose it.
2. In `apps/web/serve.mjs`, explicitly allow static assets under `/supplies/` and serve `.mjs` as JavaScript. The current file permits only the shared index and `/src/`, and has no `.mjs` MIME mapping. The root demo server also lacks `.mjs` MIME mapping. Neither was changed.
3. In the chosen API host, register the replenishment handler with the **existing** verified authorization instance and the approved auth transport. Main currently provides mountable modules, not a demonstrated running replenishment host. Apply the task-local migration/provision only approved local runtime grants. Existing `/organizations/` proxy paths alone do not mount an upstream handler.
4. Verify same-origin authenticated save/refetch, logout/tenant transitions, actual narrow layout, keyboard focus, contrast and native multi-session races in an authorized environment.

The pending SV-008 seven-path expansion is not implemented, transferred, or bypassed by this work. The unrelated auth repair, operations recovery, scene/wards/assets, maintenance and shared board history remain untouched.

## Tests and synthetic visual fixture

```sh
npm ci --prefix services/api/replenishment --workspaces=false --ignore-scripts
npm test --prefix services/api/replenishment --workspaces=false
node services/api/replenishment/tests/build-preview.mjs
```

The last command builds `services/api/replenishment/tests/synthetic-preview.html` for a separately permitted local visual review. It embeds the actual view/CSS and a clearly labeled, in-memory **test-only** adapter; it is not evidence of auth, SQL, stock mutation, host integration or concurrency. The generated file is ignored and is not a second implementation. Do not use it as operational inventory. Browser navigation to this local-file preview was denied by URL policy in this execution environment; no browser screenshot, narrow-layout or real keyboard verification is claimed.

DOM integration tests instead mount the actual client/view and traverse the real API handler, existing auth and PGlite SQL without opening sockets. Axe reports zero DOM violations with color-contrast disabled (JSDOM has no layout). Existing shared-token contrast checks pass in the root suite, but actual rendered contrast/layout still needs browser review.
