// Equipment discovery model (SV-030). Pure and dependency-free: no DOM, fetch, timers or globals.
// It consumes an ALREADY-AUTHORIZED projection supplied by the caller and invents no freshness threshold,
// readiness rule, role policy, coordinate or live tracking. It only searches, filters, counts, groups and selects values it is given.
//
// Projection item (all fields are plain strings supplied by the caller):
//   { id, label, equipmentType, locationId, readiness, freshness }
//   id            stable equipment ID (required; later duplicates are dropped)
//   label         display name (falls back to id)
//   equipmentType e.g. "infusion" ('' if unknown)
//   locationId    canonical location ID ('' if unknown)
//   readiness     caller-defined readiness value, opaque to this module ('unknown' if missing)
//   freshness     canonical location-freshness value, e.g. fresh | aging | stale | unknown ('unknown' if missing)

export const FILTER_NAMES = Object.freeze(['location', 'readiness', 'freshness']);
export const ERROR_CODES = Object.freeze(['unavailable', 'denied']);
export const LIMITS = Object.freeze({ maxItems: 5000, maxQuery: 100, maxValue: 64 });
const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

export function normalizeItem(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const id = text(raw.id, 64).trim();
  if (!id) return null;
  return Object.freeze({
    id, label: text(raw.label, 200).trim() || id, equipmentType: text(raw.equipmentType, 64).trim(),
    locationId: text(raw.locationId, 64).trim(), readiness: text(raw.readiness, 64).trim() || 'unknown', freshness: text(raw.freshness, 32).trim() || 'unknown',
  });
}

// Location knowledge, taken only from the supplied values. This is NOT readiness.
//   unknown : no location recorded, or freshness is "unknown"
//   stale   : freshness is "stale"
//   located : everything else (a location is recorded and its freshness is not stale or unknown)
export function locationState(item) {
  if (!item.locationId || item.freshness === 'unknown') return 'unknown';
  return item.freshness === 'stale' ? 'stale' : 'located';
}

// Every term in the query must appear (case-insensitive) in the ID, label or equipment type.
export function matches(items, query = '', filters = {}) {
  const terms = String(query).trim().toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter(item => {
    for (const name of FILTER_NAMES) {
      const wanted = filters[name];
      if (wanted && (name === 'location' ? item.locationId : item[name]) !== wanted) return false;
    }
    if (!terms.length) return true;
    const haystack = `${item.id} ${item.label} ${item.equipmentType}`.toLowerCase();
    return terms.every(t => haystack.includes(t));
  });
}

// Unknown and stale items stay in the totals. total === located + stale + unknown.
export function countLocationStates(items) {
  const counts = { total: items.length, located: 0, stale: 0, unknown: 0 };
  for (const item of items) counts[locationState(item)]++;
  return counts;
}

export function groupByType(items) {
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.equipmentType)) groups.set(item.equipmentType, []);
    groups.get(item.equipmentType).push(item);
  }
  return [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([type, members]) => ({ type, ids: members.map(m => m.id), counts: countLocationStates(members) }));
}

const unique = values => [...new Set(values.filter(Boolean))].sort();
export const optionsFor = items => ({ location: unique(items.map(i => i.locationId)), readiness: unique(items.map(i => i.readiness)), freshness: unique(items.map(i => i.freshness)) });

export function createDiscoveryModel({ onHighlight, onSelect } = {}) {
  let items = [], byId = new Map(), query = '', filters = { location: '', readiness: '', freshness: '' };
  let selectedId = null, highlight = null, highlightedIds = [];
  let phase = 'loading', errorCode = null, outdated = false, refreshing = true, generation = 0, destroyed = false;
  const listeners = new Set();

  // A throwing callback must never corrupt model state, so callbacks are isolated.
  const safe = (fn, value) => { if (typeof fn === 'function') { try { fn(value); } catch { /* caller's problem */ } } };
  const emitHighlight = ids => { if (ids.join('\n') !== highlightedIds.join('\n')) { highlightedIds = ids; safe(onHighlight, [...ids]); } };
  const setSelected = id => { if (id !== selectedId) { selectedId = id; safe(onSelect, id); } };
  const current = () => matches(items, query, filters);
  const changed = () => { for (const listener of [...listeners]) safe(listener); };

  // Recompute everything derived from the authorized items: selection and highlight can only point at records that still exist.
  function reconcile() {
    if (selectedId !== null && !byId.has(selectedId)) setSelected(null);
    if (highlight === null) return emitHighlight([]);
    const ids = current().filter(i => i.equipmentType === highlight.type).map(i => i.id);
    if (!ids.length) highlight = null;
    emitHighlight(ids);
  }
  function clearHighlight() { highlight = null; emitHighlight([]); }
  function load(rawItems) {
    const next = [], seen = new Set();
    for (const raw of Array.isArray(rawItems) ? rawItems.slice(0, LIMITS.maxItems) : []) {
      const item = normalizeItem(raw);
      if (item && !seen.has(item.id)) { seen.add(item.id); next.push(item); }
    }
    items = next; byId = new Map(next.map(i => [i.id, i]));
  }

  const model = {
    // Start a refresh. Only the most recent token may deliver data or an error: older results are ignored.
    beginRefresh() { if (destroyed) return 0; refreshing = true; changed(); return ++generation; },
    finishRefresh(token, rawItems) {
      if (destroyed || token !== generation) return false;
      load(rawItems); phase = 'ready'; errorCode = null; outdated = false; refreshing = false;
      reconcile(); changed(); return true;
    },
    // "denied" means access was lost: everything is dropped. Any other failure keeps the last list, flagged outdated, and drops the highlight.
    failRefresh(token, code) {
      if (destroyed || token !== generation) return false;
      phase = 'error'; refreshing = false; errorCode = ERROR_CODES.includes(code) ? code : 'unavailable';
      if (errorCode === 'denied') { load([]); outdated = false; setSelected(null); } else outdated = items.length > 0;
      clearHighlight(); changed(); return true;
    },
    setItems(rawItems) { return model.finishRefresh(model.beginRefresh(), rawItems); },
    setQuery(value) { if (destroyed) return; query = text(value, LIMITS.maxQuery); clearHighlight(); reconcile(); changed(); },
    setFilter(name, value) {
      if (destroyed || !FILTER_NAMES.includes(name)) return;
      filters = { ...filters, [name]: text(value, LIMITS.maxValue) }; clearHighlight(); reconcile(); changed();
    },
    clearFilters() { if (destroyed) return; query = ''; filters = { location: '', readiness: '', freshness: '' }; clearHighlight(); reconcile(); changed(); },
    // The selected instance and the highlighted group are separate. Selecting needs an authorized ID, not a matching one.
    selectInstance(id) {
      if (destroyed) return;
      if (id === null) setSelected(null); else if (typeof id === 'string' && byId.has(id)) setSelected(id); else return;
      changed();
    },
    highlightGroup(type) {
      if (destroyed) return;
      if (type === null) clearHighlight();
      else if (typeof type === 'string' && current().some(i => i.equipmentType === type)) { highlight = { type }; reconcile(); } else return;
      changed();
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    snapshot() {
      const results = current();
      return Object.freeze({
        phase, errorCode, refreshing, outdated, query, filters: { ...filters }, options: optionsFor(items),
        authorizedTotal: items.length, results, counts: countLocationStates(results), matchingIds: results.map(i => i.id),
        groups: groupByType(results), selectedId, highlight: highlight ? { type: highlight.type, ids: [...highlightedIds] } : null,
      });
    },
    // Clears the highlight and selection through the callbacks, drops all data and listeners. Later calls do nothing.
    destroy() {
      if (destroyed) return;
      clearHighlight(); setSelected(null);
      destroyed = true; generation++; items = []; byId = new Map(); listeners.clear(); onHighlight = onSelect = undefined;
    },
  };
  return model;
}
