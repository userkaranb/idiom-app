import { Context } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type { Env } from './types';

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

function renderLoginHtml(errorMessage?: string): string {
  const errorBlock = errorMessage
    ? `<p class="error">${errorMessage}</p>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Idiom App — Login</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .login-box { background: white; padding: 32px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); min-width: 300px; }
    h1 { font-size: 1.2rem; margin-bottom: 24px; color: #333; }
    label { display: block; margin-bottom: 8px; font-size: 0.9rem; color: #555; }
    input { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 1rem; margin-bottom: 16px; }
    input:focus { outline: none; border-color: #666; }
    button { width: 100%; padding: 10px; background: #333; color: white; border: none; border-radius: 4px; font-size: 1rem; cursor: pointer; }
    button:hover { background: #555; }
    .error { color: #c00; font-size: 0.85rem; margin-bottom: 16px; background: #fff0f0; padding: 8px 12px; border-radius: 4px; border: 1px solid #fcc; }
  </style>
</head>
<body>
  <div class="login-box">
    <h1>Idiom App</h1>
    ${errorBlock}
    <form method="POST" action="/login">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" autofocus required>
      <button type="submit">Log in</button>
    </form>
  </div>
</body>
</html>`;
}

/** Renders the login form (no error message). */
export function handleLoginGet(): Response {
  return new Response(renderLoginHtml(), {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
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

  return new Response(renderLoginHtml('Incorrect password'), {
    status: 401,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
