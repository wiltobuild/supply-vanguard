// Transport is injected by the authenticated host. No token storage or policy defaults.
// Contract (SV-027): transport(path, {method, body, signal, headers?}). `headers` is present only for commands that need one (today:
// {'Idempotency-Key': ...} on /holds/:id/clearances); the host's transport must forward it. Everything else is unchanged.
import {validateClearanceInput} from '../../../packages/domain/holds/index.js';
export class RequestError extends Error {
  constructor(message, {status = 0, uncertain = false} = {}) { super(message); Object.assign(this, {status, uncertain}); }
}
export function createRequestApi({organizationId, transport}) {
  if (!organizationId || typeof transport !== 'function') throw new Error('Organization and authenticated transport required');
  const root = `/organizations/${encodeURIComponent(organizationId)}`;
  const enc = encodeURIComponent;
  const call = async (path, method = 'GET', body, signal, headers) => {
    try { return await transport(root + path, {method, body, signal, ...(headers && {headers})}); }
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
    clear: (id, signal) => call(`/holds/${enc(id)}/clear`, 'POST', undefined, signal),
    // Versioned clearance command (PR #32 contract, schemaVersion 1). The body carries NO actor, tenant, role or time: the server decides those.
    clearWithEvidence: (id, body, idempotencyKey, signal) => call(`/holds/${enc(id)}/clearances`, 'POST', body, signal, {'Idempotency-Key': idempotencyKey})
  };
}

// ---- Clearance evidence (SV-027) ----
// Supplied evidence is a recorded assertion. Nothing here says it is sufficient to clear a hold, and no policy is invented.
export class EvidenceError extends Error {
  constructor(message, field = 'form') { super(message); this.name = 'EvidenceError'; this.field = field; }
}
// Uses the same rules as the server (packages/domain/holds). Messages are fixed text and never repeat what the user typed.
export function prepareClearance({reference, observedAt, note} = {}, now = Date.now()) {
  const evidence = {reference: String(reference ?? '').trim(), observedAt: String(observedAt ?? '').trim()};
  const trimmed = String(note ?? '').trim();
  if (trimmed) evidence.note = trimmed;
  try { return validateClearanceInput({schemaVersion: 1, evidence}, {now}); }
  catch (error) { throw new EvidenceError(error.message, /^evidence\.(reference|observedAt|note)\b/.exec(error.message)?.[1] ?? 'form'); }
}
const codeOf = error => String(error?.code ?? error?.message ?? '');
// A 403 wrong_role means "this user is not the configured clearer" for this kind. It is not a lost session, so it must not wipe the screen.
const isRoleRefusal = error => error?.status === 403 && codeOf(error) === 'wrong_role';
// Fixed, user-facing explanations for the clearance command. They distinguish validation, role, missing rule, conflicts and uncertainty.
export function describeClearError(error) {
  const code = codeOf(error), status = error?.status ?? 0;
  if (error?.uncertain || status >= 500) return {kind: 'uncertain', message: 'The result is unknown: the clearance may have been saved. Retry sends the exact original command and key.'};
  if (status === 400 || code === 'evidence_invalid') return {kind: 'validation', message: 'The server did not accept the evidence. Check the reference, the observed time and the note, then submit again.'};
  if (isRoleRefusal(error)) return {kind: 'role', message: 'Your role is not the one configured to clear this kind of hold. Nothing was changed.'};
  if (status === 422 && code === 'no_clearance_rule') return {kind: 'missing-rule', message: 'No clearance role is configured for this kind of hold, so nobody can clear it yet. An administrator sets this up.'};
  if (status === 409 && code === 'idempotency_conflict') return {kind: 'key-conflict', message: 'That attempt no longer matches its earlier submission. Review the hold, then start a new attempt.'};
  if (status === 409) return {kind: 'conflict', message: 'This hold changed or was already cleared. The latest records were loaded.'};
  if (status === 401 || status === 403) return {kind: 'denied', message: 'Access unavailable. Reconnect through the host application.'};
  return {kind: 'other', message: 'The clearance could not be completed. Nothing was recorded by this screen.'};
}
export const quantities = items => {
  const counts = {requested: items.length, open:0, assigned:0, dispatched:0, received:0, returned:0, cancelled:0, missing:0, failed:0, delivered:0, demandCancelled:0};
  for (const item of items) { if (Object.hasOwn(counts, item.state)) counts[item.state]++; if (item.receivedAt) counts.delivered++; if (item.demandCancelled) counts.demandCancelled++; }
  return counts;
};
export const canClear = (hold, role, rules) => hold.active && !!role && rules.some(rule => rule.kind === hold.kind && rule.role === role);
export function createRequestSession({api, onChange = () => {}, key = () => crypto.randomUUID()}) {
  let generation = 0, controller, closed = false, pending = null;
  const empty = () => ({phase:'idle', requests:[], request:null, requestId:null, rules:[], error:null, busy:false, uncertain:false, retryable:false, clearIssue:null, lastClearance:null});
  let state = empty();
  const emit = patch => { state = {...state, ...patch}; if (!closed) onChange(state); };
  const reset = () => { generation++; controller?.abort(); pending = null; state = empty(); if (!closed) onChange(state); };
  const access = error => [401,403].includes(error.status);
  async function load(id) {
    if (closed || state.busy) return;
    const gen = ++generation; controller?.abort(); controller = new AbortController();
    emit({phase:'loading', request:null, requestId:id ?? null, error:null, clearIssue:null});
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
    emit({busy:true, error:null, clearIssue:null});
    let result;
    try {
      result = await api[frozen.kind](...frozen.args, controller.signal);
      if (closed || gen !== generation) return false;
      pending = null;
      // What a clearance returned. `hold` (its clearance and evidence) is the receipt. The stack is the CURRENT state when the server answered.
      const lastClearance = frozen.kind === 'clearWithEvidence' && result?.hold ? {
        holdId: frozen.args[0], replayed: result.replayed === true, clearance: result.hold.clearance ?? null,
        clearedBy: result.hold.clearedBy ?? null, clearedAt: result.hold.clearedAt ?? null,
        stackBasis: result.summaryBasis === 'current' ? 'current' : 'unlabelled',
        activeKinds: Array.isArray(result.summary?.activeKinds) ? [...result.summary.activeKinds] : null
      } : state.lastClearance;
      emit({busy:false, uncertain:false, retryable:false, clearIssue:null, lastClearance});
      const refreshed = await load(frozen.requestId || (frozen.kind === 'create' ? result.id : state.request?.id));
      if (refreshed === generation && !closed && state.phase === 'ready') emit({phase:'success'});
      return true;
    } catch (error) {
      if (closed || gen !== generation) return false;
      if (access(error) && !(frozen.kind === 'clearWithEvidence' && isRoleRefusal(error))) { pending = null; emit({...empty(), phase:'denied', error}); return false; }
      if (error.uncertain || error.status >= 500) pending = frozen;
      emit({busy:false, phase:'error', error, clearIssue: frozen.kind === 'clearWithEvidence' ? describeClearError(error) : null, uncertain:!!pending, retryable:!!pending && ['lifecycle','claim','clearWithEvidence'].includes(frozen.kind)});
      if (error.status === 409) { const issue = state.clearIssue; const refreshed = await load(frozen.requestId); if (refreshed === generation && !closed && state.phase === 'ready') emit({phase:'conflict', error, clearIssue: issue}); }
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
    // Clear WITH evidence. Validates locally (the same rules as the server, which stays authoritative), freezes the exact body and a fresh
    // Idempotency-Key, and an uncertain failure retries that exact body and key. Throws EvidenceError (nothing sent) for bad input.
    clearWithEvidence(holdId, input) {
      const body = prepareClearance(input);
      return execute({kind:'clearWithEvidence',requestId:state.request?.id,args:[holdId,body,key()]});
    },
    retry: () => state.retryable ? execute(null,true) : Promise.resolve(false),
    // Explicit reconciliation only: non-idempotent create/hold operations are never retried automatically.
    reconcile() { pending = null; emit({uncertain:false,retryable:false}); return load(state.request?.id); },
    reset,
    dispose() { reset(); closed = true; }
  };
}
