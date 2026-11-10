import {AuthError} from '../auth/index.mjs';
import {SupplyError} from './rules.mjs';

async function body(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16384) throw new SupplyError(413, 'body_too_large');
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error();
    return parsed;
  } catch { throw new SupplyError(400, 'invalid_json'); }
}
// Host must supply verified authorization and same-origin authentication/CSRF protections.
export function createReplenishmentHandler({replenishment}) {
  return async (request, response) => {
    const send = (status, value) => {
      response.writeHead(status, {'Content-Type':'application/json', 'Cache-Control':'no-store',
        ...(status === 401 ? {'WWW-Authenticate':'Bearer'} : {})});
      response.end(JSON.stringify(value));
    };
    try {
      const url = new URL(request.url,'http://localhost');
      const match = /^\/organizations\/([^/]+)\/replenishment\/(bins|tasks|history|configure|detect|assign|complete|correct)$/.exec(url.pathname);
      if (!match) return send(404,{error:'not_found'});
      const [,org,method] = match;
      if (request.method === 'GET' && ['bins','tasks','history'].includes(method)) {
        const options = {after:url.searchParams.get('after'),limit:url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 50};
        const result = method === 'history' ? await replenishment.history(request,org,url.searchParams.get('binId'),options) :
          await replenishment[method === 'bins' ? 'listBins' : 'listTasks'](request,org,options);
        return send(200,result);
      }
      if (request.method === 'POST' && ['configure','detect','assign','complete','correct'].includes(method)) {
        const result = await replenishment[method](request,org,await body(request));
        return send(result.replayed ? 200 : 201,result);
      }
      return send(405,{error:'method_not_allowed'});
    } catch (error) {
      const known = error instanceof AuthError || error instanceof SupplyError;
      return send(known ? error.status : 500,{error:known ? error.code : 'internal_error'});
    }
  };
}
