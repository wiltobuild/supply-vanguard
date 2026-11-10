// Accessible equipment discovery list (SV-030). Plain DOM, no dependencies. Every supplied string is written with textContent,
// never as HTML. It is a plain list that needs no 3D support and does not touch the scene. See README.md for the injected interface.
import { createDiscoveryModel, FILTER_NAMES } from './model.js';

const FILTER_LABELS = { location: ['Location', 'All locations'], readiness: ['Readiness', 'Any readiness'], freshness: ['Location freshness', 'Any freshness'] };
let instances = 0;

export function mountDiscovery(container, { onHighlight, onSelect, onRetry, document: doc = container.ownerDocument } = {}) {
  const uid = `discovery-${++instances}`;
  const el = (tag, props = {}, ...kids) => {
    const node = doc.createElement(tag);
    for (const [k, v] of Object.entries(props)) { if (k === 'text') node.textContent = v; else node.setAttribute(k, v); }
    for (const kid of kids) node.append(kid);
    return node;
  };
  const model = createDiscoveryModel({ onHighlight, onSelect });

  const search = el('input', { type: 'search', id: `${uid}-q`, autocomplete: 'off', maxlength: '100' });
  const selects = {};
  const controls = el('div', { class: 'discovery-controls' }, el('label', { for: search.id, text: 'Search by ID, name or type' }), search);
  for (const name of FILTER_NAMES) {
    const select = el('select', { id: `${uid}-${name}`, 'data-filter': name }, el('option', { value: '', text: FILTER_LABELS[name][1] }));
    selects[name] = select;
    controls.append(el('label', { for: select.id, text: FILTER_LABELS[name][0] }), select);
  }
  const clear = el('button', { type: 'button', 'data-action': 'clear', text: 'Clear filters' });
  controls.append(clear);
  const summary = el('p', { class: 'discovery-summary', role: 'status', 'aria-live': 'polite' });
  const state = el('p', { class: 'discovery-state', hidden: '' });
  const retry = el('button', { type: 'button', 'data-action': 'retry', text: 'Try again', hidden: '' });
  const groups = el('ul', { class: 'discovery-groups', 'aria-label': 'Equipment types in these results' });
  const list = el('ul', { class: 'discovery-results', 'aria-label': 'Matching equipment', tabindex: '-1' });
  const root = el('section', { class: 'discovery', 'aria-labelledby': `${uid}-h` },
    el('h2', { id: `${uid}-h`, text: 'Find equipment' }), controls, summary, state, retry, groups, list);
  container.append(root);

  const rows = new Map(), groupRows = new Map();
  const line = (label, value) => el('span', { class: 'discovery-field', text: `${label}: ${value}` });

  function syncOptions(select, values, current) {
    const wanted = ['', ...values, ...(current && !values.includes(current) ? [current] : [])];
    const have = [...select.options].map(o => o.value);
    if (wanted.join('\n') !== have.join('\n')) {
      for (const o of [...select.options].slice(1)) o.remove();
      for (const v of wanted.slice(1)) select.append(el('option', { value: v, text: v }));
    }
    select.value = current;
  }

  function render() {
    const s = model.snapshot(), active = doc.activeElement;
    if (search.value !== s.query) search.value = s.query;
    for (const name of FILTER_NAMES) syncOptions(selects[name], s.options[name], s.filters[name]);

    // Loading, error and empty states. Messages are fixed text; nothing supplied by the caller or by an error is echoed.
    let message = '';
    if (s.phase === 'loading') message = 'Loading equipment…';
    else if (s.phase === 'error' && s.errorCode === 'denied') message = 'You no longer have access to this equipment list.';
    else if (s.phase === 'error') message = s.outdated ? 'Could not refresh. Showing the last loaded list, which may be out of date.' : 'Could not load equipment.';
    else if (!s.authorizedTotal) message = 'No equipment to show.';
    else if (!s.results.length) message = 'No equipment matches these filters.';
    state.textContent = message; state.hidden = !message;
    state.setAttribute('role', s.phase === 'error' ? 'alert' : 'status');
    retry.hidden = !(s.phase === 'error' && typeof onRetry === 'function');
    list.setAttribute('aria-busy', s.refreshing ? 'true' : 'false');

    summary.textContent = s.phase === 'loading' ? '' :
      `${s.results.length} of ${s.authorizedTotal} items match. Location: ${s.counts.located} located, ${s.counts.stale} stale, ${s.counts.unknown} unknown.`;

    // Type groups.
    const wantedGroups = new Set(s.groups.map(g => g.type));
    for (const [type, li] of groupRows) if (!wantedGroups.has(type)) { li.remove(); groupRows.delete(type); }
    s.groups.forEach(g => {
      let li = groupRows.get(g.type);
      if (!li) { li = el('li', {}, el('button', { type: 'button', 'data-group': g.type })); groupRows.set(g.type, li); }
      const b = li.firstChild;
      b.textContent = `${g.type || 'Unspecified type'}: ${g.ids.length} (${g.counts.located} located, ${g.counts.stale} stale, ${g.counts.unknown} unknown)`;
      b.setAttribute('aria-pressed', s.highlight && s.highlight.type === g.type ? 'true' : 'false');
    });
    reorder(groups, s.groups.map(g => groupRows.get(g.type)));

    // Results: nodes are reused by ID so a focused button is never replaced while its record is still listed.
    const wantedIds = new Set(s.results.map(i => i.id));
    let lostFocus = false;
    for (const [id, li] of rows) if (!wantedIds.has(id)) { if (li.contains(active)) lostFocus = true; li.remove(); rows.delete(id); }
    s.results.forEach(item => {
      let li = rows.get(item.id);
      if (!li) { li = el('li', {}, el('button', { type: 'button', 'data-id': item.id })); rows.set(item.id, li); }
      const b = li.firstChild;
      b.replaceChildren(el('strong', { text: item.label }), line('ID', item.id), line('Type', item.equipmentType || 'not recorded'),
        line('Location', item.locationId || 'not recorded'), line('Location freshness', item.freshness), line('Readiness', item.readiness));
      b.setAttribute('aria-pressed', s.selectedId === item.id ? 'true' : 'false');
    });
    reorder(list, s.results.map(i => rows.get(i.id)));
    if (lostFocus) list.focus();   // the focused record left the list: keep keyboard users inside the results, not on <body>
  }
  function reorder(parent, wanted) {
    wanted.forEach((node, index) => { if (parent.children[index] !== node) parent.insertBefore(node, parent.children[index] || null); });
  }

  const on = (target, type, handler) => { target.addEventListener(type, handler); return () => target.removeEventListener(type, handler); };
  const cleanups = [
    on(search, 'input', () => model.setQuery(search.value)),
    ...FILTER_NAMES.map(name => on(selects[name], 'change', () => model.setFilter(name, selects[name].value))),
    on(clear, 'click', () => { model.clearFilters(); search.focus(); }),
    on(retry, 'click', () => { if (typeof onRetry === 'function') onRetry(); }),
    on(list, 'click', event => {
      const b = event.target.closest && event.target.closest('[data-id]');
      if (b) model.selectInstance(model.snapshot().selectedId === b.dataset.id ? null : b.dataset.id);
    }),
    on(groups, 'click', event => {
      const b = event.target.closest && event.target.closest('[data-group]');
      if (!b) return;
      const open = model.snapshot().highlight;
      model.highlightGroup(open && open.type === b.dataset.group ? null : b.dataset.group);
    }),
    model.subscribe(render),
  ];
  render();

  let destroyed = false;
  return {
    // Refresh protocol: begin, then deliver either the new authorized items or an error. Superseded refreshes are ignored.
    beginRefresh: () => model.beginRefresh(),
    finishRefresh: (token, items) => model.finishRefresh(token, items),
    failRefresh: (token, code) => model.failRefresh(token, code),
    setItems: items => model.setItems(items),
    snapshot: () => model.snapshot(),
    // Clears highlight and selection (through the callbacks), removes every listener and all DOM, and ends the model.
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cleanups.forEach(fn => fn());
      model.destroy();
      rows.clear(); groupRows.clear();
      root.remove();
    },
  };
}
