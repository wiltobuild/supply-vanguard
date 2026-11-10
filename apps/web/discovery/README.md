# Equipment discovery model and list (SV-030)

A standalone, reusable search/filter/group/select model and an accessible list component for finding equipment in a ward. Built from published main `a4438dbf709c0457d575bc9d0de1d0e5f96eed04`. Everything is in this folder; nothing else was changed (no edits to `apps/web/src/lib.js` or `app.js`, the scene, the API, root files or CI, and no new dependencies).

> **Status: source-only preparation.** It is not mounted in the app, not connected to the API and not connected to the 3D scene. Mounting, the API's authorization projection and real scene highlighting need later coordination with the shared-host owner (SV-008) and approved browser and accessibility acceptance. Nothing here claims an end-to-end result, performance, real tracking or production data. SV-016's final gates are unchanged.

## Files

- `model.js`: pure model (no DOM, network, timers or globals).
- `component.js`: plain-DOM list built on the model. All supplied text is written with `textContent`, never as HTML.
- `discovery.css`: styling with the shared design tokens (44 px targets, focus ring, reduced motion).
- `tests/`: deterministic synthetic tests.

## Injected interface

`mountDiscovery(container, options)` returns `{beginRefresh, finishRefresh, failRefresh, setItems, snapshot, destroy}`.

**Options**
- `onHighlight(ids)`: called with the stable IDs of the highlighted group (`[]` when nothing is highlighted).
- `onSelect(id | null)`: called with the selected instance's ID, or `null`.
- `onRetry()`: optional. Shows a "Try again" button in the error state.
- `document`: optional, defaults to the container's document.

**Input: an already-authorized projection.** The caller decides what the user may see and passes only that. Each item is plain strings:

| field | meaning |
|---|---|
| `id` | stable equipment ID (required; later duplicates are dropped) |
| `label` | display name (falls back to `id`) |
| `equipmentType` | e.g. `infusion` (`''` if unknown) |
| `locationId` | canonical location ID (`''` if unknown) |
| `readiness` | the caller's readiness value, opaque to this code (`unknown` if missing) |
| `freshness` | the caller's location-freshness value, e.g. `fresh`, `aging`, `stale`, `unknown` (`unknown` if missing) |

This code invents **no** freshness threshold, readiness rule, role policy, coordinate or live tracking. It only searches, filters, counts, groups and selects the values it is given.

**Refresh protocol.** `beginRefresh()` returns a token; deliver the result with `finishRefresh(token, items)` or an error with `failRefresh(token, 'unavailable' | 'denied')`. Only the newest token may deliver, so a slow older response can never overwrite or resurrect records (the call returns `false` and does nothing). `setItems(items)` is a shortcut for begin plus finish.

## Behavior

- **Search** matches stable ID, label and equipment type, case-insensitively. Every word must appear.
- **Filters** (location, readiness, freshness) are independent: each compares only its own field to the value supplied, and they combine with search. Filter options come from the whole authorized list, not from the other filters.
- **Counts.** Unknown and stale items stay in the matching totals. Each matching item is counted once: *unknown* (no location recorded, or freshness `unknown`), else *stale* (freshness `stale`), else *located*. `total = located + stale + unknown`. This is a presentation of supplied values about **location**; it is not a readiness rule, and readiness is shown as its own field.
- **Groups** are by equipment type, with per-group counts. The matching IDs are output through `snapshot().matchingIds` and group IDs through `onHighlight`, for later scene integration.
- **Selection vs highlight.** The selected instance and the highlighted group are separate. Selecting needs an authorized ID, not a matching one. Selection survives filter changes while the ID is still authorized.
- **Obsolete highlights are cleared** when the search or any filter changes, when records disappear, when access is lost, when the list cannot be confirmed (refresh error) and on destroy.
- **Revoked records.** A refresh drops IDs that are no longer in the authorized list from results, selection, highlight and the DOM. `denied` clears everything. Any other failure keeps the last list, marked "may be out of date", and drops the highlight.
- **States.** Loading, empty (no equipment, or nothing matches), and error with fixed messages. Error text from callers is never shown.
- **Clear filters** resets search and all filters and returns focus to the search box.

## Accessibility and cleanup

- Native controls only: a labelled search box, labelled selects, `<button>`s. No positive `tabindex`.
- Group and instance buttons use `aria-pressed`. The summary is a polite live region. The error state is an alert. The list has `aria-busy` while refreshing.
- Result rows are reused by ID, so a focused row is not replaced by a refresh. If the focused record leaves the list, focus moves to the results list instead of falling to the page.
- It is a plain list, so it needs no 3D support.
- `destroy()` clears the highlight and selection through the callbacks, removes every listener and all its DOM, and ends the model. Later calls and events do nothing. Repeated mount/destroy leaves nothing behind. A throwing callback cannot corrupt the model.

## Tests

```sh
node --test apps/web/discovery/tests/*.test.mjs
```

- `model.test.mjs`: pure model tests (matching, independent filters, counts, grouping, selection, revocation, stale refreshes, destroy).
- `component.test.mjs`: DOM tests (safe text, states, focus, toggles, cleanup).

**DOM prerequisite:** the DOM tests need `jsdom`, which this task does not install. They look for a copy already present in the repository's other task folders and are **skipped, with a message,** if none is found. The model tests always run. These tests are not part of the root `npm test`.

## Not run / still needed

Real browser, keyboard and screen-reader checks; narrow and wide layouts; contrast on the live page; mounting in the shared app; the API's authorization projection; real scene highlighting; any performance or production-data claim.
