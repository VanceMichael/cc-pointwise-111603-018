import test from 'node:test';
import assert from 'node:assert/strict';
import { startPortal } from '../source/portal.js';

async function session(portal) {
  const response = await fetch(`${portal.url}/portal`);
  const html = await response.text();
  return { cookie: response.headers.get('set-cookie').split(';')[0],
    csrf: html.match(/name="csrf" value="([^"]+)"/)[1] };
}

async function post(portal, credentials, path, values) {
  return fetch(`${portal.url}${path}`, { method: 'POST', headers: {
    cookie: credentials.cookie, 'content-type': 'application/x-www-form-urlencoded',
  }, body: new URLSearchParams({ csrf: credentials.csrf, ...values }) });
}

test('portal distinguishes draft, validation and confirmed receipt', async () => {
  const portal = await startPortal();
  try {
    const credentials = await session(portal);
    const draft = await post(portal, credentials, '/portal/draft', { reference: 'visit-1', name: 'Local Guest', slot: 'A' });
    assert.match(await draft.text(), /documentType/);
    assert.equal((await post(portal, credentials, '/portal/confirm', {})).status, 422);
    const confirmed = await post(portal, credentials, '/portal/confirm', { documentType: 'passport' });
    assert.equal(confirmed.status, 201);
    const booking = await confirmed.json();
    assert.ok(booking.receipt);
    const lookup = await fetch(`${portal.url}/portal/bookings?reference=visit-1`);
    assert.equal((await lookup.json()).bookings[0].receipt, booking.receipt);
    assert.equal((await post(portal, credentials, '/portal/cancel', { receipt: booking.receipt })).status, 200);
    portal.expireSessions();
    assert.equal((await post(portal, credentials, '/portal/cancel', { receipt: booking.receipt })).status, 403);
  } finally { await portal.close(); }
});
