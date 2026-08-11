/**
 * Renders the full history-feed page as a static HTML string.
 *
 * All data is fetched client-side from `/api/history` so the page loads
 * instantly and history updates after an ad-hoc send without a server-side
 * template render. No external JS or CSS — everything is inline.
 *
 * Layout: CSS grid `1fr 320px`. The right column (`#detail-panel`) is
 * intentionally empty — it is reserved for the future LLM chat panel.
 */
export function renderPage(): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Idiom History</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f0f0f0; color: #333; }
    .layout { display: grid; grid-template-columns: 1fr 320px; gap: 24px; max-width: 1100px; margin: 0 auto; padding: 24px; }
    .main-column { min-width: 0; }
    #detail-panel { background: transparent; }
    .page-header { display: flex; align-items: center; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
    h1 { font-size: 1.5rem; color: #222; }
    #send-btn { padding: 9px 18px; background: #2e7d32; color: white; border: none; border-radius: 5px; cursor: pointer; font-size: 0.9rem; font-weight: 500; }
    #send-btn:hover:not(:disabled) { background: #388e3c; }
    #send-btn:disabled { background: #aaa; cursor: not-allowed; }
    #status-msg { font-size: 0.85rem; color: #555; margin-top: 4px; }
    .card { background: white; border-radius: 8px; padding: 20px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    .card-date { font-size: 0.78rem; color: #999; margin-bottom: 14px; text-transform: uppercase; letter-spacing: 0.04em; }
    .phrase-block { margin-bottom: 16px; padding-bottom: 16px; border-bottom: 1px solid #f0f0f0; }
    .phrase-block:last-of-type { border-bottom: none; }
    .phrase-label { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em; color: #999; margin-bottom: 6px; font-weight: 600; }
    .phrase-text { font-weight: 700; font-size: 1rem; color: #111; }
    .region-note { font-size: 0.82rem; color: #777; margin-top: 4px; font-style: italic; }
    .phrase-meaning { margin-top: 6px; font-size: 0.88rem; color: #444; }
    .phrase-example { margin-top: 4px; font-size: 0.88rem; color: #555; font-style: italic; }
    .existing-feedback { font-size: 0.82rem; color: #666; margin-top: 12px; padding: 8px 12px; background: #f9f9f9; border-left: 3px solid #ccc; border-radius: 0 4px 4px 0; }
    .existing-feedback em { font-style: normal; }
    .feedback-form { display: flex; flex-direction: column; gap: 8px; margin-top: 14px; padding-top: 14px; border-top: 1px solid #eee; }
    .feedback-form textarea { width: 100%; padding: 9px; border: 1px solid #ddd; border-radius: 4px; resize: vertical; min-height: 64px; font-size: 0.88rem; font-family: inherit; color: #333; }
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
  </style>
</head>
<body>
  <div class="layout">
    <main class="main-column">
      <div class="page-header">
        <h1>Idiom History</h1>
        <button id="send-btn" onclick="sendAdhoc()">Ad-hoc Send</button>
      </div>
      <div id="status-msg"></div>
      <div id="history-container">Loading history…</div>
    </main>
    <aside id="detail-panel"></aside>
  </div>

  <script>
    // Region note labels — mirrors orchestrator.ts regionNote().
    const REGION_NOTES = {
      'Puerto Rico': "you'll hear this constantly in San Juan",
      'Spain': 'common in Spain',
      'Mexico': 'very common in Mexico',
      'Argentina': 'typical in Argentina',
      'Colombia': 'used in Colombia',
    };

    function regionNoteLabel(region) {
      return REGION_NOTES[region] || region;
    }

    function escapeHtml(value) {
      if (value === null || value === undefined) return '';
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function buildPhraseBlockHtml(text, region, meaning, example, label) {
      let html = '<div class="phrase-block">';
      html += '<p class="phrase-label">' + label + '</p>';
      html += '<p class="phrase-text">' + escapeHtml(text) + '</p>';
      if (region && region !== 'general') {
        html += '<p class="region-note">(' + escapeHtml(regionNoteLabel(region)) + ')</p>';
      }
      if (meaning) {
        html += '<p class="phrase-meaning">' + escapeHtml(meaning) + '</p>';
      }
      if (example) {
        html += '<p class="phrase-example">' + escapeHtml(example) + '</p>';
      }
      html += '</div>';
      return html;
    }

    // D1 writes sent_at via SQLite datetime('now'), which yields
    // "YYYY-MM-DD HH:MM:SS" — UTC, but with a space separator and no zone.
    // Safari refuses to parse that form and returns Invalid Date, so normalise
    // to ISO-8601 first. Falls back to the raw string if it still won't parse.
    function formatSentAt(value) {
      var parsed = new Date(String(value).replace(' ', 'T').replace(/Z?$/, 'Z'));
      if (isNaN(parsed.getTime())) return String(value);
      return parsed.toLocaleString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric',
        hour: 'numeric', minute: '2-digit',
      });
    }

    function buildCardHtml(row) {
      const dateLabel = formatSentAt(row.sent_at);
      const idiomHtml = buildPhraseBlockHtml(
        row.idiom_text, row.idiom_region, row.idiom_meaning, row.idiom_example, 'Idiom'
      );
      const collHtml = buildPhraseBlockHtml(
        row.colloquialism_text, row.colloquialism_region, row.colloquialism_meaning, row.colloquialism_example, 'Colloquialism'
      );
      const existingFeedbackHtml = row.user_feedback
        ? '<p class="existing-feedback"><em>Your feedback: ' + escapeHtml(row.user_feedback) + '</em></p>'
        : '';
      const feedbackPreset = escapeHtml(row.user_feedback || '');

      return (
        '<div class="card" data-id="' + row.id + '">' +
          '<p class="card-date">' + escapeHtml(dateLabel) + '</p>' +
          idiomHtml +
          collHtml +
          existingFeedbackHtml +
          '<form class="feedback-form" data-row-id="' + row.id + '">' +
            '<textarea name="text" placeholder="Leave feedback…">' + feedbackPreset + '</textarea>' +
            '<button type="submit">Save</button>' +
          '</form>' +
        '</div>'
      );
    }

    function attachFeedbackHandlers() {
      document.querySelectorAll('.feedback-form').forEach(function(form) {
        form.addEventListener('submit', async function(event) {
          event.preventDefault();
          var rowId = parseInt(form.dataset.rowId, 10);
          var textarea = form.querySelector('textarea');
          var submitBtn = form.querySelector('button[type="submit"]');

          submitBtn.disabled = true;
          submitBtn.textContent = 'Saving…';

          try {
            var res = await fetch('/api/feedback', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ rowId: rowId, text: textarea.value }),
            });
            if (!res.ok) {
              var errorData = await res.json().catch(function() { return {}; });
              throw new Error(errorData.error || 'HTTP ' + res.status);
            }
            submitBtn.textContent = 'Saved!';
            setTimeout(function() {
              submitBtn.textContent = 'Save';
              submitBtn.disabled = false;
            }, 2000);
          } catch (err) {
            submitBtn.textContent = 'Error: ' + err.message;
            submitBtn.disabled = false;
          }
        });
      });
    }

    async function loadHistory() {
      var container = document.getElementById('history-container');
      try {
        var res = await fetch('/api/history');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var rows = await res.json();
        if (rows.length === 0) {
          container.innerHTML = '<p>No history yet.</p>';
          return;
        }
        container.innerHTML = rows.map(buildCardHtml).join('');
        attachFeedbackHandlers();
      } catch (err) {
        container.innerHTML = '<p>Error loading history: ' + escapeHtml(err.message) + '</p>';
      }
    }

    async function sendAdhoc() {
      if (!confirm('This will permanently send a phrase to your phone and consume it from the pool. Continue?')) {
        return;
      }

      var btn = document.getElementById('send-btn');
      var statusMsg = document.getElementById('status-msg');

      btn.disabled = true;
      statusMsg.textContent = 'Sending…';

      var controller = new AbortController();
      var timeoutId = setTimeout(function() { controller.abort(); }, 60000);

      try {
        var res = await fetch('/api/send', {
          method: 'POST',
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        var data = await res.json();
        if (data.ok) {
          statusMsg.textContent = 'Sent! Refreshing…';
          location.reload();
        } else {
          statusMsg.textContent = 'Error: ' + (data.error || 'Unknown error');
          btn.disabled = false;
        }
      } catch (err) {
        clearTimeout(timeoutId);
        statusMsg.textContent = 'Error: ' + err.message;
        btn.disabled = false;
      }
    }

    document.addEventListener('DOMContentLoaded', loadHistory);
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
