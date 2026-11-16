import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

const escape = (text) => String(text).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

export async function startPortal({ capacity = 2, requireDocument = true } = {}) {
  const sessions = new Map();
  const bookings = new Map();
  const requests = [];
  let lostReceipt = false;
  let revision = 1;
  const server = createServer(async (request, response) => {
    const address = new URL(request.url, 'http://localhost');
    const sessionId = request.headers.cookie?.match(/session=([^;]+)/)?.[1];
    let session = sessions.get(sessionId);
    if (!session) {
      session = { id: randomUUID(), csrf: randomUUID(), draft: null };
      sessions.set(session.id, session);
    }
    response.setHeader('set-cookie', `session=${session.id}; HttpOnly; SameSite=Strict`);
    requests.push({ method: request.method, path: address.pathname });
    const json = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (request.method === 'GET' && address.pathname === '/portal') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<form action="/portal/draft" method="post"><input type="hidden" name="csrf" value="${escape(session.csrf)}"><input name="reference"><input name="name"><input name="slot"><input type="hidden" name="revision" value="${revision}"><button>Next</button></form>`);
      return;
    }
    if (request.method === 'GET' && address.pathname === '/portal/bookings') {
      const found = [...bookings.values()].filter((booking) => booking.reference === address.searchParams.get('reference'));
      json(200, { revision, bookings: found }); return;
    }
    if (request.method !== 'POST') { json(404, { error: 'not found' }); return; }
    let body = '';
    for await (const chunk of request) {
      body += chunk;
      if (body.length > 16384) { json(413, { error: 'form too large' }); return; }
    }
    const fields = new URLSearchParams(body);
    if (fields.get('csrf') !== session.csrf) { json(403, { error: 'session expired' }); return; }
    if (address.pathname === '/portal/draft') {
      if (!fields.get('reference') || !fields.get('name') || !fields.get('slot')) {
        json(422, { error: 'missing required fields' }); return;
      }
      session.draft = Object.fromEntries(fields);
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      const documentField = requireDocument ? '<input name="documentType" required>' : '';
      response.end(`<form action="/portal/confirm" method="post"><input name="csrf" type="hidden" value="${escape(session.csrf)}">${documentField}<button>Confirm</button></form>`);
      return;
    }
    if (address.pathname === '/portal/confirm') {
      if (!session.draft) { json(409, { error: 'no draft' }); return; }
      if (requireDocument && !['passport', 'identity-card'].includes(fields.get('documentType'))) {
        json(422, { error: 'documentType required' }); return;
      }
      const active = [...bookings.values()].filter((booking) => booking.slot === session.draft.slot && booking.status === 'confirmed');
      if (active.length >= capacity) { json(409, { error: 'capacity changed', revision }); return; }
      const booking = { reference: session.draft.reference, name: session.draft.name,
        slot: session.draft.slot, receipt: randomUUID(), status: 'confirmed', revision: ++revision };
      bookings.set(booking.receipt, booking);
      session.draft = null;
      if (lostReceipt) { lostReceipt = false; request.socket.destroy(); return; }
      json(201, booking); return;
    }
    if (address.pathname === '/portal/cancel') {
      const booking = bookings.get(fields.get('receipt'));
      if (!booking) { json(404, { error: 'unknown receipt' }); return; }
      booking.status = 'cancelled'; booking.revision = ++revision;
      json(200, booking); return;
    }
    json(404, { error: 'not found' });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    loseNextReceipt() { lostReceipt = true; },
    expireSessions() { sessions.clear(); },
    close() { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); },
  };
}
