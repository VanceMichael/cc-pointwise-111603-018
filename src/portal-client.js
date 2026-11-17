const DEFAULT_TIMEOUT = 2000;
const DEFAULT_DOCUMENT = 'identity-card';

export class PortalClientError extends Error {
  constructor(message, { status = null, body = null, uncertain = false, cause } = {}) {
    super(message, { cause });
    this.name = 'PortalClientError';
    this.status = status;
    this.body = body;
    this.uncertain = uncertain;
  }
}

function parseBody(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

function cookieFrom(response) {
  const headers = response.headers;
  const values = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [headers.get('set-cookie')].filter(Boolean);
  for (const value of values) {
    const pair = value.match(/^(session=[^;]+)/);
    if (pair) return pair[1];
  }
  return null;
}

function csrfFrom(html) {
  return String(html).match(/name="csrf"[^>]*value="([^"]+)"/)?.[1]
    ?? String(html).match(/value="([^"]+)"[^>]*name="csrf"/)?.[1]
    ?? null;
}

/**
 * A small browser-like client for the local portal. It deliberately returns
 * status codes instead of treating every HTTP response as success: a receipt
 * only exists on a 201 confirm response (or in the bookings lookup).
 */
export class PortalClient {
  constructor(baseUrl, { timeout = DEFAULT_TIMEOUT } = {}) {
    const address = new URL(baseUrl);
    if (!['127.0.0.1', 'localhost'].includes(address.hostname)) {
      throw new Error('local portal required');
    }
    this.baseUrl = address;
    this.timeout = timeout;
  }

  _address(path, search = null) {
    const address = new URL(path, this.baseUrl);
    if (address.origin !== this.baseUrl.origin) throw new Error('portal origin changed');
    if (search) {
      for (const [key, value] of Object.entries(search)) address.searchParams.set(key, value);
    }
    return address;
  }

  async _fetch(path, { method = 'GET', session = null, form = null, search = null } = {}) {
    const headers = {};
    if (session?.cookie) headers.cookie = session.cookie;
    let body;
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form);
    }
    let response;
    try {
      response = await fetch(this._address(path, search), {
        method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(this.timeout),
      });
    } catch (error) {
      throw new PortalClientError(`portal unavailable: ${method} ${path}`, {
        uncertain: true, cause: error,
      });
    }
    const text = await response.text();
    const newCookie = cookieFrom(response);
    if (session && newCookie) session.cookie = newCookie;
    return { status: response.status, ok: response.ok, text, body: parseBody(text),
      cookie: newCookie, revision: parseBody(text)?.revision ?? null };
  }

  async open() {
    const response = await this._fetch('/portal');
    if (response.status !== 200) {
      throw new PortalClientError(`portal session failed: ${response.status}`, {
        status: response.status, body: response.body,
      });
    }
    const csrf = csrfFrom(response.text);
    if (!csrf) throw new PortalClientError('portal csrf missing', { status: response.status });
    return { cookie: response.cookie, csrf, revision: response.revision };
  }

  async draft(session, values = {}) {
    for (const field of ['reference', 'name', 'slot']) {
      if (!values[field]) throw new TypeError(`portal draft requires ${field}`);
    }
    return this._fetch('/portal/draft', { method: 'POST', session,
      form: { csrf: session.csrf, ...values } });
  }

  async confirm(session, documentType = DEFAULT_DOCUMENT) {
    const value = documentType && typeof documentType === 'object'
      ? documentType.documentType ?? DEFAULT_DOCUMENT
      : documentType ?? DEFAULT_DOCUMENT;
    return this._fetch('/portal/confirm', { method: 'POST', session,
      form: { csrf: session.csrf, documentType: value } });
  }

  async cancel(receipt, session = null) {
    if (!receipt) throw new TypeError('portal cancel requires receipt');
    const current = session ?? await this.open();
    return this._fetch('/portal/cancel', { method: 'POST', session: current,
      form: { csrf: current.csrf, receipt } });
  }

  async bookings(reference) {
    if (!reference) throw new TypeError('portal booking lookup requires reference');
    return this._fetch('/portal/bookings', { search: { reference } });
  }

  async lookup(reference) { return this.bookings(reference); }

  async submit(values, { documentType = DEFAULT_DOCUMENT, session = null } = {}) {
    const current = session ?? await this.open();
    const drafted = await this.draft(current, values);
    if (drafted.status !== 200) return { session: current, draft: drafted, confirm: null };
    const confirmed = await this.confirm(current, documentType);
    return { session: current, draft: drafted, confirm: confirmed };
  }

  async enroll(values, options = {}) { return this.submit(values, options); }
}

export { DEFAULT_DOCUMENT };
