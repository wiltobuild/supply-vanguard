import {AuthError} from '../auth/index.mjs';
import {SupplyError} from './index.mjs';

async function body(request) {
  let size = 0, chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16384) throw new SupplyError(413, 'body_too_large');
    chunks.push(chunk);
  }
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!input || Array.isArray(input) || typeof input !== 'object') throw new Error();
    return input;
  } catch { throw new SupplyError(400, 'invalid_json'); }
}
// Mount in the host server. Identity verification is supplied by the existing authorization module.
export function createSuppliesHandler({supplies}) {
  return async (request, response) => {
    const send = (status, payload) => {
      response.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store',
        ...(status === 401 ? {'WWW-Authenticate': 'Bearer'} : {})});
      response.end(JSON.stringify(payload));
    };
    try {
      const url = new URL(request.url, 'http://localhost');
      const match = /^\/organizations\/([^/]+)\/supplies\/(skus|bins|transactions)(?:\/([^/]+)\/history)?$/.exec(url.pathname);
      if (!match) return send(404, {error: 'not_found'});
      const [, organizationId, resource, binId] = match;
      const options = {after: url.searchParams.get('after'), limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 50};
      if (request.method === 'GET') {
        if (resource === 'bins' && binId) return send(200, await supplies.history(request, organizationId, binId, options));
        if (!binId && resource === 'skus') return send(200, await supplies.listSkus(request, organizationId, options));
        if (!binId && resource === 'bins') return send(200, await supplies.listBins(request, organizationId, options));
      }
      if (request.method === 'POST' && !binId) {
        const input = await body(request);
        const method = {skus: 'createSku', bins: 'createBin', transactions: 'postStock'}[resource];
        const result = await supplies[method](request, organizationId, input);
        return send(result.replayed ? 200 : 201, result);
      }
      return send(405, {error: 'method_not_allowed'});
    } catch (error) {
      const known = error instanceof SupplyError || error instanceof AuthError;
      return send(known ? error.status : 500, {error: known ? error.code : 'internal_error'});
    }
  };
}
