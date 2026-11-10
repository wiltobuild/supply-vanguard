// Transport is injected by the authenticated host. No token storage or policy defaults.
export class RequestError extends Error {
  constructor(message, {status = 0, uncertain = false} = {}) { super(message); Object.assign(this, {status, uncertain}); }
}
export function createRequestApi({organizationId, transport}) {
  if (!organizationId || typeof transport !== 'function') throw new Error('Organization and authenticated transport required');
  const root = `/organizations/${encodeURIComponent(organizationId)}`;
  const enc = encodeURIComponent;
  const call = async (path, method = 'GET', body, signal) => {
    try { return await transport(root + path, {method, body, signal}); }
    catch (error) { if (!error.status && method !== 'GET') error.uncertain = true; throw error; }
  };
  return {
    list: signal => call('/requests?limit=100', 'GET', undefined, signal),
    page: (cursor, signal) => call(`/requests?limit=100&cursor=${enc(cursor)}`, 'GET', undefined, signal),
    read: (id, signal) => call(`/requests/${enc(id)}/lifecycle`, 'GET', undefined, signal),
    rules: signal => call('/holds/clearance-rules', 'GET', undefined, signal),
    create: (body, signal) => call('/requests', 'POST', body, signal),
    claim: (id, line, body, signal) => call(`/requests/${enc(id)}/items/${line}/claim`, 'POST', body, signal),
    lifecycle: (id, line, body, signal) => call(`/requests/${enc(id)}/items/${line}/lifecycle`, 'POST', body, signal),
    place: (id, body, signal) => call(`/equipment/${enc(id)}/holds`, 'POST', body, signal),
    clear: (id, signal) => call(`/holds/${enc(id)}/clear`, 'POST', undefined, signal)
  };
}
export const quantities = items => {
  const counts = {requested: items.length, open:0, assigned:0, dispatched:0, received:0, returned:0, cancelled:0, missing:0, failed:0, delivered:0, demandCancelled:0};
  for (const item of items) { if (Object.hasOwn(counts, item.state)) counts[item.state]++; if (item.receivedAt) counts.delivered++; if (item.demandCancelled) counts.demandCancelled++; }
  return counts;
};
export const canClear = (hold, role, rules) => hold.active && !!role && rules.some(rule => rule.kind === hold.kind && rule.role === role);
export function createRequestSession({api, onChange = () => {}, key = () => crypto.randomUUID()}) {
  let generation = 0, controller, closed = false, pending = null;
  const empty = () => ({phase:'idle', requests:[], request:null, requestId:null, rules:[], error:null, busy:false, uncertain:false, retryable:false});
  let state = empty();
  const emit = patch => { state = {...state, ...patch}; if (!closed) onChange(state); };
  const reset = () => { generation++; controller?.abort(); pending = null; state = empty(); if (!closed) onChange(state); };
  const access = error => [401,403].includes(error.status);
  async function load(id) {
    if (closed || state.busy) return;
    const gen = ++generation; controller?.abort(); controller = new AbortController();
    emit({phase:'loading', request:null, requestId:id ?? null, error:null});
    try {
      const [request, ruleResult] = await Promise.all([id ? api.read(id, controller.signal) : Promise.resolve(null), api.rules(controller.signal)]);
      if (closed || gen !== generation) return;
      let page = await api.list(controller.signal), requests = [...page.items], seen = new Set();
      while (page.nextCursor) { if (closed || gen !== generation) return; if (seen.has(page.nextCursor)) throw new Error('Repeated request page'); seen.add(page.nextCursor); page = await api.page(page.nextCursor, controller.signal); requests.push(...page.items); }
      if (closed || gen !== generation) return;
      if (request && (!Array.isArray(request.items) || !request.items.every(i => Number.isInteger(i.version) && Array.isArray(i.holds) && Array.isArray(i.assignments) && Array.isArray(i.history)))) throw new Error('Invalid lifecycle response');
      emit({phase:'ready', requests, request, rules:ruleResult.rules, error:null});
      return gen;
    } catch (error) {
      if (closed || gen !== generation) return;
      if (access(error)) { pending = null; emit({...empty(), phase:'denied', error}); }
      else emit({phase:'error', error});
    }
  }
  async function execute(command, retry = false) {
    if (closed || state.busy) return false;
    if (pending && !retry) throw new Error('Resolve the uncertain operation before starting another action.');
    const gen = ++generation; controller?.abort(); controller = new AbortController();
    const frozen = retry ? pending : JSON.parse(JSON.stringify(command));
    if (!frozen) throw new Error('No exact retry available');
    emit({busy:true, error:null});
    let result;
    try {
      result = await api[frozen.kind](...frozen.args, controller.signal);
      if (closed || gen !== generation) return false;
      pending = null; emit({busy:false, uncertain:false, retryable:false});
      const refreshed = await load(frozen.requestId || (frozen.kind === 'create' ? result.id : state.request?.id));
      if (refreshed === generation && !closed && state.phase === 'ready') emit({phase:'success'});
      return true;
    } catch (error) {
      if (closed || gen !== generation) return false;
      if (access(error)) { pending = null; emit({...empty(), phase:'denied', error}); return false; }
      if (error.uncertain || error.status >= 500) pending = frozen;
      emit({busy:false, phase:'error', error, uncertain:!!pending, retryable:!!pending && ['lifecycle','claim'].includes(frozen.kind)});
      if (error.status === 409) { const refreshed = await load(frozen.requestId); if (refreshed === generation && !closed && state.phase === 'ready') emit({phase:'conflict', error}); }
      return false;
    }
  }
  return {
    get state() { return state; }, load,
    create: body => execute({kind:'create',args:[body]}),
    claim: (id,line,body) => execute({kind:'claim',requestId:id,args:[id,line,body]}),
    transition(id, item, action, {condition, confirmedNotInTransit = false} = {}) {
      if (action === 'cancel' && !item.dispatchedAt && !confirmedNotInTransit) throw new Error('Confirm this item is not in transit before cancellation.');
      const body = {action,expectedVersion:item.version,commandKey:key(),...(action === 'return' && {condition})};
      return execute({kind:'lifecycle',requestId:id,args:[id,item.lineNo,body]});
    },
    place: (id,body) => execute({kind:'place',requestId:state.request?.id,args:[id,body]}),
    clear: id => execute({kind:'clear',requestId:state.request?.id,args:[id]}),
    retry: () => state.retryable ? execute(null,true) : Promise.resolve(false),
    // Explicit reconciliation only: non-idempotent create/hold operations are never retried automatically.
    reconcile() { pending = null; emit({uncertain:false,retryable:false}); return load(state.request?.id); },
    reset,
    dispose() { reset(); closed = true; }
  };
}
