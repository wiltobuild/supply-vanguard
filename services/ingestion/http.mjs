// Adapter only: the hosting application supplies authorization, source verifier and journal.
export function createIngestionHandler(ingestion) {
  return async (request, response) => {
    const send = result => {
      const {status, ...body} = result;
      response.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(status === 401 ? {'WWW-Authenticate': 'Bearer'} : {})});
      response.end(JSON.stringify(body));
    };
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname !== '/observations') return send({status: 404, code: 'not-found'});
      if (request.method !== 'POST') return send({status: 405, code: 'method-not-allowed'});
      if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') return send(await ingestion.rejectExternal('content-type', '', 415));
      const chunks = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 16_384) {
          // Bounded evidence; do not retain or keep buffering an unbounded hostile request.
          send(await ingestion.rejectExternal('payload-too-large', Buffer.concat(chunks), 413));
          return;
        }
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      let envelope;
      try { envelope = JSON.parse(bytes.toString('utf8')); }
      catch { return send(await ingestion.rejectExternal('malformed', bytes)); }
      send(await ingestion.ingest({request, organizationId: url.searchParams.get('organizationId'), envelope}));
    } catch {
      // A journal/database failure must not look like a successfully retained rejection.
      if (!response.headersSent) send({status: 503, code: 'ingestion-unavailable'});
      else response.destroy();
    }
  };
}
