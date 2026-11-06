export function createReplenishmentClient({organizationId, fetchImpl = globalThis.fetch}) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(organizationId)) throw Error('Organization ID required');
  const base = `/organizations/${organizationId}/replenishment/`;
  async function call(path, input) {
    let response;
    try {
      response = await fetchImpl(base + path,{method:input ? 'POST' : 'GET',credentials:'same-origin',cache:'no-store',
        headers:input ? {'Content-Type':'application/json'} : {},...(input ? {body:JSON.stringify(input)} : {})});
    } catch { throw Object.assign(Error('Connection interrupted. Retry the unchanged request to check its result.'),{uncertain:Boolean(input)}); }
    let result;
    try { result = await response.json(); }
    catch { throw Object.assign(Error('Response unreadable. Retry the unchanged request.'),{uncertain:Boolean(input)}); }
    if (!response.ok) throw Object.assign(Error(result.error || 'Request failed'),{status:response.status,uncertain:Boolean(input) && response.status >= 500});
    return result;
  }
  return Object.freeze({
    listBins: after => call(`bins${after ? '?after='+encodeURIComponent(after) : ''}`),
    listTasks: after => call(`tasks${after ? '?after='+encodeURIComponent(after) : ''}`),
    history: (binId,after) => call(`history?binId=${encodeURIComponent(binId)}${after ? '&after='+encodeURIComponent(after) : ''}`),
    command: (operation,input) => call(operation,input)
  });
}
