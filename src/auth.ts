import { Context } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type { Env } from './types';
import { renderLoginPage } from './ui';

/**
 * The fixed string that is HMAC-signed to produce the session cookie payload.
 * Permanent sessions — rotating COOKIE_SECRET invalidates all existing sessions.
 */
const SENTINEL = 'authenticated';

// ---------------------------------------------------------------------------
// HMAC helpers (Web Crypto API — available in the Workers runtime)
// ---------------------------------------------------------------------------

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

function hexToUint8Array(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Cookie parsing
// ---------------------------------------------------------------------------

/**
 * Extracts a named cookie value from a raw `Cookie` header string.
 * Returns null when the named cookie is absent.
 */
function parseCookieValue(cookieHeader: string, name: string): string | null {
  for (const segment of cookieHeader.split(';')) {
    const eqIndex = segment.indexOf('=');
    if (eqIndex === -1) continue;
    const key = segment.slice(0, eqIndex).trim();
    if (key === name) return segment.slice(eqIndex + 1).trim();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API: cookie signing + verification
// ---------------------------------------------------------------------------

/**
 * Returns a signed cookie payload string in the form `<hex_hmac>.<value>`.
 *
 * The HMAC is computed over `value` using HMAC-SHA256 with `secret` and
 * encoded as lowercase hex. Callers set this as the `session` cookie value.
 */
export async function signCookie(secret: string, value: string): Promise<string> {
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return `${bufferToHex(signature)}.${value}`;
}

/**
 * Verifies the `session` cookie in a raw `Cookie` header string.
 *
 * Splits the cookie payload on the first `.`, reconstructs the expected
 * HMAC using `crypto.subtle.verify` (which is timing-safe), and confirms
 * that the data portion matches the expected sentinel.
 *
 * Returns false (never throws) when the cookie is absent, malformed, or
 * the signature does not match.
 */
export async function verifyCookie(secret: string, cookieHeader: string): Promise<boolean> {
  const sessionValue = parseCookieValue(cookieHeader, 'session');
  if (sessionValue === null) return false;

  const dotIndex = sessionValue.indexOf('.');
  if (dotIndex === -1) return false;

  const hex = sessionValue.slice(0, dotIndex);
  const data = sessionValue.slice(dotIndex + 1);

  // Reject cookies whose data portion is not the expected sentinel.
  if (data !== SENTINEL) return false;

  // Reject oddly-lengthed hex strings that would produce a truncated buffer.
  if (hex.length === 0 || hex.length % 2 !== 0) return false;

  try {
    const key = await importHmacKey(secret);
    return crypto.subtle.verify(
      'HMAC',
      key,
      hexToUint8Array(hex),
      new TextEncoder().encode(data),
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Hono middleware
// ---------------------------------------------------------------------------

/**
 * Returns a Hono middleware that enforces cookie-based session auth.
 *
 * GET requests to page routes (paths not starting with `/api/`) receive a
 * 302 redirect to `/login` on failure — the browser can then display the
 * login form. API calls (paths starting with `/api/`) receive a 401 JSON
 * response so the client-side fetch handler can surface an error instead
 * of silently following a redirect.
 */
export function requireAuth(cookieSecret: string): MiddlewareHandler {
  return async (c, next) => {
    const cookieHeader = c.req.header('Cookie') ?? '';
    const isValid = await verifyCookie(cookieSecret, cookieHeader);

    if (isValid) {
      return next();
    }

    if (c.req.path.startsWith('/api/')) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    // Response.redirect() requires an absolute URL in the Workers runtime;
    // constructing the Response directly avoids the URL-parsing restriction.
    return new Response(null, { status: 302, headers: { Location: '/login' } });
  };
}

// ---------------------------------------------------------------------------
// Login route handlers
// ---------------------------------------------------------------------------

/** Renders the login form (no error message). */
export function handleLoginGet(): Response {
  return renderLoginPage();
}

/**
 * Processes a login form submission.
 *
 * On correct password: signs a session cookie and redirects to `/`.
 * On wrong password: re-renders the form with an "Incorrect password" message
 * and returns 401 so the browser stays on the login page.
 */
export async function handleLoginPost(c: Context<{ Bindings: Env }>): Promise<Response> {
  const formData = await c.req.parseBody<{ password?: string }>();
  const submittedPassword = formData.password ?? '';

  if (submittedPassword === c.env.WEB_PASSWORD) {
    const signed = await signCookie(c.env.COOKIE_SECRET, SENTINEL);

    // `Secure` is added whenever the request arrived over HTTPS — always true
    // in production, where Workers are only reachable over TLS. It is omitted
    // for plain-HTTP `wrangler dev` on localhost, where browsers silently drop
    // Secure cookies and would make local login appear to fail.
    const attributes = ['HttpOnly', 'SameSite=Lax', 'Path=/'];
    if (new URL(c.req.url).protocol === 'https:') {
      attributes.push('Secure');
    }

    return new Response(null, {
      status: 302,
      headers: {
        Location: '/',
        'Set-Cookie': `session=${signed}; ${attributes.join('; ')}`,
      },
    });
  }

  return renderLoginPage('Incorrect password', 401);
}
