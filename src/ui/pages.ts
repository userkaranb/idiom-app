import { BASE_STYLES, FEED_STYLES, LOGIN_STYLES } from './styles';
import { FEED_CLIENT_SCRIPT } from './client';

/**
 * Wraps page content in the shared HTML document shell.
 *
 * Both pages are plain server-rendered HTML with inline CSS and JS — there is
 * no build step and no static asset pipeline, so everything the browser needs
 * arrives in the single response.
 */
function htmlDocument(options: {
  title: string;
  styles: string;
  body: string;
  script?: string;
}): string {
  const scriptTag = options.script ? `\n  <script>${options.script}</script>` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${options.title}</title>
  <style>${BASE_STYLES}${options.styles}</style>
</head>
<body>
${options.body}${scriptTag}
</body>
</html>`;
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

// ---------------------------------------------------------------------------
// History feed
// ---------------------------------------------------------------------------

/**
 * Renders the history-feed page.
 *
 * The shell ships empty: rows are fetched client-side from `/api/history` so
 * the feed refreshes after an ad-hoc send without a server round trip through
 * a template. The right column (`#detail-panel`) is intentionally empty — it
 * is reserved for the chat panel in a follow-up task.
 */
export function renderPage(): Response {
  const body = `  <div class="layout">
    <main class="main-column">
      <div class="page-header">
        <h1>Idiom History</h1>
        <button id="send-btn" type="button">Ad-hoc Send</button>
      </div>
      <div id="status-msg"></div>
      <div id="history-container">Loading history…</div>
    </main>
    <aside id="detail-panel"></aside>
  </div>`;

  return htmlResponse(
    htmlDocument({
      title: 'Idiom History',
      styles: FEED_STYLES,
      body,
      script: FEED_CLIENT_SCRIPT,
    }),
  );
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Renders the login form, optionally with an error message above it.
 *
 * Lives here rather than in `auth.ts` so that module stays purely about
 * signing, verifying, and gating — no markup.
 */
export function renderLoginPage(errorMessage?: string, status = 200): Response {
  const errorBlock = errorMessage
    ? `<p class="error">${escapeHtml(errorMessage)}</p>`
    : '';

  const body = `  <div class="login-box">
    <h1>Idiom App</h1>
    ${errorBlock}
    <form method="POST" action="/login">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" autofocus required>
      <button type="submit">Log in</button>
    </form>
  </div>`;

  return htmlResponse(
    htmlDocument({ title: 'Idiom App — Login', styles: LOGIN_STYLES, body }),
    status,
  );
}
