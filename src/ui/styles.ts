/**
 * CSS for the two server-rendered pages.
 *
 * Kept as plain strings rather than a stylesheet asset because the Worker
 * serves its HTML inline with no build step — there is nothing to bundle a
 * `.css` file into, and a second request for a few hundred bytes would cost
 * more than it saves.
 *
 * `BASE_STYLES` holds the reset and the shared tokens; each page sets its own
 * `--bg` so the login screen and the feed keep their distinct grounds.
 */

export const BASE_STYLES = `
    :root {
      --bg: #f0f0f0;
      --surface: #ffffff;
      --text: #333333;
      --heading: #222222;
      --muted: #555555;
      --faint: #999999;
      --border: #dddddd;
      --hairline: #f0f0f0;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    button { font-family: inherit; }
    :focus-visible { outline: 2px solid #1565c0; outline-offset: 2px; }
`;

export const LOGIN_STYLES = `
    :root { --bg: #f5f5f5; }
    body { display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .login-box { background: var(--surface); padding: 32px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); min-width: 300px; }
    h1 { font-size: 1.2rem; margin-bottom: 24px; color: var(--heading); }
    label { display: block; margin-bottom: 8px; font-size: 0.9rem; color: var(--muted); }
    input { width: 100%; padding: 10px; border: 1px solid var(--border); border-radius: 4px; font-size: 1rem; margin-bottom: 16px; }
    input:focus { outline: none; border-color: #666; }
    button { width: 100%; padding: 10px; background: #333; color: white; border: none; border-radius: 4px; font-size: 1rem; cursor: pointer; }
    button:hover { background: #555; }
    .error { color: #c00; font-size: 0.85rem; margin-bottom: 16px; background: #fff0f0; padding: 8px 12px; border-radius: 4px; border: 1px solid #fcc; }
`;

export const FEED_STYLES = `
    .layout { display: grid; grid-template-columns: 1fr 320px; gap: 24px; max-width: 1100px; margin: 0 auto; padding: 24px; }
    .main-column { min-width: 0; }
    #detail-panel { position: sticky; top: 24px; max-height: calc(100vh - 48px); display: flex; flex-direction: column; border-radius: 8px; overflow: hidden; background: var(--surface); box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    #detail-panel:empty { display: none; }
    .page-header { display: flex; align-items: center; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
    h1 { font-size: 1.5rem; color: var(--heading); }
    #send-btn { padding: 9px 18px; background: #2e7d32; color: white; border: none; border-radius: 5px; cursor: pointer; font-size: 0.9rem; font-weight: 500; }
    #send-btn:hover:not(:disabled) { background: #388e3c; }
    #send-btn:disabled { background: #aaa; cursor: not-allowed; }
    #status-msg { font-size: 0.85rem; color: var(--muted); margin-top: 4px; }
    .card { background: var(--surface); border-radius: 8px; padding: 20px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    .card-date { font-size: 0.78rem; color: var(--faint); margin-bottom: 14px; text-transform: uppercase; letter-spacing: 0.04em; }
    .phrase-block { margin-bottom: 16px; padding-bottom: 16px; border-bottom: 1px solid var(--hairline); }
    .phrase-block:last-of-type { border-bottom: none; }
    .phrase-label { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--faint); margin-bottom: 6px; font-weight: 600; }
    .phrase-text { font-weight: 700; font-size: 1rem; color: #111; }
    .region-note { font-size: 0.82rem; color: #777; margin-top: 4px; font-style: italic; }
    .phrase-meaning { margin-top: 6px; font-size: 0.88rem; color: #444; }
    .phrase-example { margin-top: 4px; font-size: 0.88rem; color: var(--muted); font-style: italic; }
    .existing-feedback { font-size: 0.82rem; color: #666; margin-top: 12px; padding: 8px 12px; background: #f9f9f9; border-left: 3px solid #ccc; border-radius: 0 4px 4px 0; }
    .existing-feedback em { font-style: normal; }
    .feedback-form { display: flex; flex-direction: column; gap: 8px; margin-top: 14px; padding-top: 14px; border-top: 1px solid #eee; }
    .feedback-form textarea { width: 100%; padding: 9px; border: 1px solid var(--border); border-radius: 4px; resize: vertical; min-height: 64px; font-size: 0.88rem; font-family: inherit; color: var(--text); }
    .feedback-form textarea:focus { outline: none; border-color: #888; }
    .feedback-form button { align-self: flex-end; padding: 7px 16px; background: #1565c0; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.85rem; font-weight: 500; }
    .feedback-form button:hover:not(:disabled) { background: #1976d2; }
    .feedback-form button:disabled { background: #aaa; cursor: not-allowed; }

    /* Below this width the reserved right column would squeeze the feed to an
       unreadable strip, so the layout collapses to a single column. The empty
       #detail-panel takes no height until the chat panel fills it. */
    @media (max-width: 860px) {
      .layout { grid-template-columns: 1fr; gap: 16px; padding: 16px; }
    }

    /* --- Chat panel -------------------------------------------------------- */
    .card.selected { outline: 2px solid #1565c0; }
    .chat-header { padding: 16px; border-bottom: 1px solid var(--border); }
    .chat-header h2 { font-size: 0.95rem; font-weight: 600; color: var(--heading); margin-bottom: 4px; }
    .chat-header p { font-size: 0.8rem; color: var(--muted); }
    .chat-messages { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
    .chat-bubble { padding: 10px 14px; border-radius: 8px; font-size: 0.88rem; line-height: 1.5; max-width: 100%; }
    .chat-bubble.user { background: #e8f0fe; align-self: flex-end; }
    .chat-bubble.assistant { background: #f5f5f5; align-self: flex-start; }
    .chat-bubble .promote-btn { display: block; margin-top: 8px; padding: 4px 10px; font-size: 0.78rem; background: transparent; border: 1px solid #999; border-radius: 4px; cursor: pointer; color: var(--muted); }
    .chat-bubble .promote-btn:hover:not(:disabled) { background: #f0f0f0; }
    .chat-bubble .promote-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .chat-input-area { padding: 12px; border-top: 1px solid var(--border); display: flex; gap: 8px; }
    .chat-input-area textarea { flex: 1; padding: 8px; border: 1px solid var(--border); border-radius: 4px; font-size: 0.88rem; font-family: inherit; resize: none; min-height: 48px; max-height: 120px; }
    .chat-input-area textarea:focus { outline: none; border-color: #888; }
    .chat-input-area button { padding: 8px 14px; background: #1565c0; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.85rem; align-self: flex-end; }
    .chat-input-area button:hover:not(:disabled) { background: #1976d2; }
    .chat-input-area button:disabled { background: #aaa; cursor: not-allowed; }
    .chat-thinking { font-size: 0.82rem; color: var(--faint); font-style: italic; padding: 4px 0; }
    @media (max-width: 860px) {
      #detail-panel { position: static; max-height: 70vh; }
    }
`;
