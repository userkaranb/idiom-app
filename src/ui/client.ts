/**
 * Browser-side script for the history feed, as a string embedded in the page.
 *
 * There is no build step, so this ships as-is to the browser: plain ES5-ish
 * JavaScript, no modules, no framework. It is kept in its own file purely so
 * the page shell in `pages.ts` stays readable — nothing here runs in the
 * Worker.
 *
 * Region notes are NOT computed here. `/api/history` returns a pre-rendered
 * `*_region_note` per phrase, derived from `regionNote()` in orchestrator.ts,
 * so the wording has a single source of truth shared with the Telegram message.
 */
export const FEED_CLIENT_SCRIPT = `
    function escapeHtml(value) {
      if (value === null || value === undefined) return '';
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
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

    function buildPhraseBlockHtml(text, regionNote, meaning, example, label) {
      var html = '<div class="phrase-block">';
      html += '<p class="phrase-label">' + label + '</p>';
      html += '<p class="phrase-text">' + escapeHtml(text) + '</p>';
      if (regionNote) {
        html += '<p class="region-note">(' + escapeHtml(regionNote) + ')</p>';
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

    function buildCardHtml(row) {
      var idiomHtml = buildPhraseBlockHtml(
        row.idiom_text, row.idiom_region_note, row.idiom_meaning, row.idiom_example, 'Idiom'
      );
      var collHtml = buildPhraseBlockHtml(
        row.colloquialism_text, row.colloquialism_region_note, row.colloquialism_meaning, row.colloquialism_example, 'Colloquialism'
      );
      var existingFeedbackHtml = row.user_feedback
        ? '<p class="existing-feedback"><em>Your feedback: ' + escapeHtml(row.user_feedback) + '</em></p>'
        : '';

      return (
        '<div class="card" data-id="' + row.id + '">' +
          '<p class="card-date">' + escapeHtml(formatSentAt(row.sent_at)) + '</p>' +
          idiomHtml +
          collHtml +
          existingFeedbackHtml +
          '<form class="feedback-form" data-row-id="' + row.id + '">' +
            '<textarea name="text" placeholder="Leave feedback…">' + escapeHtml(row.user_feedback || '') + '</textarea>' +
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

    document.getElementById('send-btn').addEventListener('click', sendAdhoc);
    document.addEventListener('DOMContentLoaded', loadHistory);
`;
