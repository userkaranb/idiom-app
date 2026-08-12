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

    // Lookup table populated by buildCardHtml so openChatPanel can read row
    // data without parsing it back out of the DOM.
    var rowDataById = {};

    function buildCardHtml(row) {
      rowDataById[row.id] = row;

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

    // -------------------------------------------------------------------------
    // Chat panel state — reset whenever a different card is selected.
    // -------------------------------------------------------------------------

    var currentRowId = null;
    var currentRowData = null;
    var conversationMessages = [];

    function openChatPanel(rowId, cardEl) {
      currentRowId = rowId;
      currentRowData = rowDataById[rowId];
      conversationMessages = [];

      // Highlight the selected card and clear any previous selection.
      document.querySelectorAll('.card.selected').forEach(function(card) {
        card.classList.remove('selected');
      });
      cardEl.classList.add('selected');

      var panel = document.getElementById('detail-panel');
      panel.innerHTML =
        '<div class="chat-header">' +
          '<h2>' + escapeHtml(currentRowData.idiom_text) + ' / ' + escapeHtml(currentRowData.colloquialism_text) + '</h2>' +
          '<p>Click Send to ask anything about these phrases…</p>' +
        '</div>' +
        '<div class="chat-messages" id="chat-messages"></div>' +
        '<div class="chat-input-area">' +
          '<textarea id="chat-input" placeholder="Ask a question…" rows="2"></textarea>' +
          '<button id="chat-send">Send</button>' +
        '</div>';

      document.getElementById('chat-send').addEventListener('click', sendChatMessage);
      document.getElementById('chat-input').addEventListener('keydown', function(event) {
        // Enter without Shift submits; Shift+Enter inserts a newline.
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          sendChatMessage();
        }
      });
    }

    function appendChatBubble(role, text, promoteBtn) {
      var messagesEl = document.getElementById('chat-messages');
      var bubble = document.createElement('div');
      bubble.className = 'chat-bubble ' + role;
      var textEl = document.createElement('span');
      textEl.className = 'chat-bubble-text';
      textEl.textContent = text;
      bubble.appendChild(textEl);
      if (promoteBtn) {
        bubble.appendChild(promoteBtn);
      }
      messagesEl.appendChild(bubble);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return bubble;
    }

    async function sendChatMessage() {
      var inputEl = document.getElementById('chat-input');
      var sendBtn = document.getElementById('chat-send');
      var messagesEl = document.getElementById('chat-messages');

      var text = inputEl.value.trim();
      if (!text) return;

      inputEl.value = '';
      sendBtn.disabled = true;

      // Append the user turn to the in-memory thread before sending so the
      // server receives the full updated history including this message.
      conversationMessages.push({ role: 'user', content: text });

      // Build the "Save as feedback" button now so we can pass it to the bubble
      // renderer, but leave it disabled until the assistant response arrives.
      var promoteBtn = document.createElement('button');
      promoteBtn.className = 'promote-btn';
      promoteBtn.textContent = 'Save as feedback';
      promoteBtn.disabled = true;
      var promotedText = text; // capture for the closure
      promoteBtn.addEventListener('click', function() {
        promoteMessage(promotedText, promoteBtn);
      });

      appendChatBubble('user', text, promoteBtn);

      // Thinking indicator
      var thinkingEl = document.createElement('p');
      thinkingEl.className = 'chat-thinking';
      thinkingEl.textContent = 'Thinking…';
      messagesEl.appendChild(thinkingEl);
      messagesEl.scrollTop = messagesEl.scrollHeight;

      try {
        var res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rowId: currentRowId, messages: conversationMessages }),
        });

        thinkingEl.remove();

        if (!res.ok) {
          var errorData = await res.json().catch(function() { return {}; });
          throw new Error(errorData.error || 'HTTP ' + res.status);
        }

        var data = await res.json();
        var replyText = data.response;

        conversationMessages.push({ role: 'assistant', content: replyText });
        appendChatBubble('assistant', replyText, null);

        // Now that the assistant has replied, the user's promote button is live.
        promoteBtn.disabled = false;
      } catch (err) {
        thinkingEl.remove();
        var errorBubble = document.createElement('p');
        errorBubble.className = 'chat-thinking';
        errorBubble.textContent = 'Error: ' + err.message;
        messagesEl.appendChild(errorBubble);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        // Roll back the optimistic push so the user can retry without duplicate turns.
        conversationMessages.pop();
      } finally {
        sendBtn.disabled = false;
      }
    }

    async function promoteMessage(text, promoteBtn) {
      promoteBtn.disabled = true;
      promoteBtn.textContent = 'Saving…';

      try {
        var res = await fetch('/api/promote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rowId: currentRowId, text: text }),
        });

        if (!res.ok) {
          var errorData = await res.json().catch(function() { return {}; });
          throw new Error(errorData.error || 'HTTP ' + res.status);
        }

        var data = await res.json();
        promoteBtn.textContent = 'Saved ✓';

        // Reflect the updated feedback in the card so it stays in sync.
        var card = document.querySelector('.card[data-id="' + currentRowId + '"]');
        if (card) {
          var feedbackEl = card.querySelector('.existing-feedback');
          var newFeedbackHtml = '<p class="existing-feedback"><em>Your feedback: ' + escapeHtml(data.feedback) + '</em></p>';
          if (feedbackEl) {
            feedbackEl.outerHTML = newFeedbackHtml;
          } else {
            var feedbackForm = card.querySelector('.feedback-form');
            if (feedbackForm) {
              feedbackForm.insertAdjacentHTML('beforebegin', newFeedbackHtml);
            }
          }
          // Keep rowDataById in sync so the panel header re-opens correctly.
          if (rowDataById[currentRowId]) {
            rowDataById[currentRowId].user_feedback = data.feedback;
          }
        }
      } catch (err) {
        promoteBtn.textContent = 'Error';
        promoteBtn.disabled = false;
      }
    }

    // Event delegation for card clicks — opens the chat panel for that row.
    // Clicks inside the feedback form or on promote/submit buttons are ignored
    // so those interactions are not accidentally intercepted.
    document.addEventListener('click', function(event) {
      var card = event.target.closest('.card');
      if (!card) return;
      if (event.target.closest('.feedback-form') || event.target.closest('.promote-btn')) return;
      var rowId = parseInt(card.dataset.id, 10);
      // Clicking the already-selected card does nothing — the thread persists.
      if (rowId === currentRowId) return;
      openChatPanel(rowId, card);
    });

    document.getElementById('send-btn').addEventListener('click', sendAdhoc);
    document.addEventListener('DOMContentLoaded', loadHistory);
`;
