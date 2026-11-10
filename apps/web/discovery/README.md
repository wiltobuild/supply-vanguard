# Equipment discovery model and list (SV-030)

A standalone, reusable search/filter/group/select model and an accessible list component for finding equipment in a ward. Built from published main `a4438dbf709c0457d575bc9d0de1d0e5f96eed04`; repaired in SV-032 (see below). Everything is in this folder; nothing else was changed (no edits to `apps/web/src/lib.js` or `app.js`, the scene, the API, root files or CI, and no new dependencies).

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

**Refresh protocol (one settlement per refresh).** `beginRefresh()` returns a token and makes it the only token that may settle. This is established **before** any subscriber is notified, so a subscriber cannot settle the previous refresh. Deliver the result with `finishRefresh(token, items)` or an error with `failRefresh(token, 'unavailable' | 'denied' | 'too_large')`. Each call is accepted **once**, for the active pending token only, and the token is consumed before any callback or listener runs. A superseded, repeated, never-issued or late token changes nothing and returns `false`. So a late success after `denied` cannot bring records, selection or highlight back, and a late error after a success is ignored. A genuinely new `beginRefresh()` works as usual. `setItems(items)` is a shortcut for begin plus finish.

**Size bound.** At most 5000 items (`LIMITS.maxItems`). A list of exactly 5000 is shown normally. A larger list is **refused, never truncated**: `finishRefresh` settles the refresh as a `too_large` error (it returns `true` because it settled the refresh), the last loaded list is kept and flagged out of date (or nothing is shown if none was loaded), and the component says the list is too large. The summary can therefore never claim a complete list or a complete "no match" result for data it did not fully load.

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
- Focus is kept where the user was. Result rows and group buttons are reused by key; if a refresh moves a focused control (a reorder), focus is put back on that same control. If the focused record leaves the list, focus moves to the results list. If the focused type group disappears, focus moves to the next remaining group in the old order, else the previous one, else the results list. Only focus that is inside the component is ever managed: a refresh does not move focus from the search box, a filter, the clear button or anything outside the component.
- It is a plain list, so it needs no 3D support.
- `destroy()` clears the highlight and selection through the callbacks, removes every listener and all its DOM, and ends the model. Later calls and events do nothing. Repeated mount/destroy leaves nothing behind. A throwing callback cannot corrupt the model.

## Tests

```sh
node --test apps/web/discovery/tests/*.test.mjs
```

- `model.test.mjs`: 17 pure model tests (matching, independent filters, counts, grouping, selection, revocation, one-settlement refreshes, reentrancy, the size bound, destroy).
- `component.test.mjs`: 13 DOM tests (safe text, states, focus including reorder and group removal, toggles, oversized list, cleanup). Total 30; with jsdom present all 30 run, with none skipped.
- `mutation-check.mjs`: not a test. `node apps/web/discovery/tests/mutation-check.mjs` breaks the module 19 ways, one at a time, and confirms the tests notice each (exit 1 if one survives). It restores the files and verifies them afterwards.

**DOM prerequisite:** the DOM tests need `jsdom`, which this task does not install. They look for a copy already present in the repository's other task folders and are **skipped, with a message,** if none is found. The model tests always run. These tests are not part of the root `npm test`.

## SV-032 repairs

Independent review of the first version (source `6a9424d`) found these, each reproduced and now fixed with a regression test that **failed on the original source** (10 failing, 20 passing, before the fix) and passes now:

1. **Refresh tokens could settle more than once.** After `denied`, a late success on the same token restored records, selection and highlight. Fixed: one settlement per active pending token (see the protocol above).
2. **Reentrant notification.** `beginRefresh` told subscribers before the new token existed, so a subscriber could settle the previous refresh and falsely clear `refreshing`. Fixed: the new token and `refreshing` are set first.
3. **Silent truncation at 5000.** A 5001st item (for example an unknown or stale one) vanished behind a "5000 of 5000" summary and a possibly false complete "no match". Fixed: refused as `too_large`.
4. **Focus lost to the page** when the focused type group disappeared, or when a focused result or group was reordered. Fixed as described under Accessibility.

An old test that encoded the silent truncation (and one that allowed a token to settle twice) was updated to the new contract. Business policy is unchanged: no freshness or readiness rule was added. Selection versus group highlight, access-loss cleanup, safe text rendering and the injected-projection boundary are as before. The renderer still writes everything with `textContent`.

## Not run / still needed

Real browser, keyboard and screen-reader checks; narrow and wide layouts; contrast on the live page; mounting in the shared app; the API's authorization projection; real scene highlighting; any performance or production-data claim.
