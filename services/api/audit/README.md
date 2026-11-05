# Audit search and export (SV-012)

Read-only search and redacted export over the append-only audit tables, behind the SV-005 authorization boundary. Nothing here writes; no migration is needed.

```js
import {createAuditHandler} from './routes.mjs';
http.createServer(createAuditHandler({authorization})).listen(port);   // same pattern as the equipment and request handlers
```

| Request | Permission | Result |
| --- | --- | --- |
| `GET /organizations/:org/audit/events?stream&actor&source&kind&equipment&request&from&to&limit&cursor` | audit:read | `{items, nextCursor}`, newest first. Full detail. |
| `GET /organizations/:org/audit/export?...same filters...&format=json\|csv` | audit:export | A redacted file download, capped at 5000 events. |

Only equipment manager, supply manager and admin hold these permissions today, so viewers and operators get 403. `stream` is `equipment` (default, `equipment_event`) or `request` (`request_event`); `kind` must belong to the chosen stream. `from` is inclusive and `to` exclusive, both UTC ISO timestamps. `limit` is 1 to 100 (default 25). Unknown parameters, bad values and malformed cursors are 400, never ignored. Only GET is accepted.

## Guarantees

- **Immutable:** the API has no write path, and the underlying tables reject UPDATE and DELETE (tested).
- **Exact pagination:** keyset on `(recorded_at, id)` with a cursor carrying the database's microsecond text. Millisecond cursors are refused, so a boundary row can never repeat.
- **Tenant-scoped:** every query filters on the organization from the route (checked against the login's membership) and row-level security backs it up.
- **Export is redacted:** every `note` field at any depth becomes `[redacted]`; the actor becomes a stable per-tenant pseudonym (`user:` plus 12 hex characters from a SHA-256 of the organization and actor, so the same person has the same label inside one export but a different one in another tenant); correlation and idempotency keys are dropped. CSV cells are quoted and any starting with `=`, `+`, `-`, `@`, tab or CR get an apostrophe prefix so spreadsheets will not run them.
- **No silent truncation:** an export matching more than 5000 events is a 422 `export_too_large`; narrow the filters.

## Decisions to review

- **What counts as free text.** I treated `note` fields and the client-supplied correlation and idempotency keys as unsafe to export, because they can hold anything a user typed. Actor identifiers are pseudonymised because exports are meant to leave the system. Tell me if the pilot needs real user identifiers in exports.
- **Search shows everything** to audit readers, including notes and keys, since they can already read the table directly.
- **Two streams only.** Equipment and request events. The supply ledger (SV-009) has its own transaction history and is not included.
- **Exporting is not itself logged,** because the audit tables belong to other tasks. Worth adding if exports must be auditable.
- **No web page.** This is the API only; the `apps/web/audit` screen is left until SV-007 (the web client's connection to the API) lands.

## Tests

`npm test` runs `tests/audit.test.mjs`: pure rules (filters, cursors, redaction, CSV) and HTTP tests on PGlite (skip if it is not installed), with two fixture tenants and a 5001-event bulk tenant. Mutation checks: letting `inventory:read` search, or turning off note redaction, each fail tests.
