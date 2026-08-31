# idiom-app

A personal Spanish-immersion Cloudflare Worker. Every day at 13:00 UTC it picks one idiom and one colloquialism tailored to your taste, composes a message, and delivers it as a push notification via a Telegram bot. Reply to the bot and the app evolves your taste profile automatically.

There is no frontend. The user-facing surface is your Telegram chat with the bot. You can also read raw output via `wrangler tail` and poke the trigger endpoint with `curl` for debugging.

---

## Architecture

### Daily flow (`scheduled()` — Cron Trigger fires once a day)

```
wrangler.toml cron: "0 13 * * *"
         |
         v
  scheduled() handler
         |
         +- 1. Read D1
         |      +-- profile          (taste model: region, themes, ...)
         |      +-- idiom_history    (every phrase ever sent, used for dedup)
         |
         +- 2. Scout  (LLM call)
         |      Receives Profile as a prompt constraint.
         |      Receives seen idiom ids from idiom_history to exclude.
         |      Generates a pool of fresh SeedPhrase candidates.
         |
         +- 3. Curator  (Anthropic SDK -- forced tool use -> CuratorVerdict)
         |      Receives Scout's candidate list + Profile.
         |      Picks exactly one idiom + one colloquialism.
         |      Returns structured JSON: { idiom, colloquialism, justification }.
         |
         +- 4. Writer   (Anthropic SDK)
         |      Turns the CuratorVerdict into a user-facing message body.
         |
         +- 5. console.log(messageBody)   <- visible via `wrangler tail`
         |
         +- 6. POST https://api.telegram.org/bot<TOKEN>/sendMessage
         |      Delivers the message as a Telegram push notification.
         |
         +- 7. INSERT into idiom_history  (sent_at, idiom_id, text, justification, ...)
```

### Feedback flow (`POST /webhook` — Telegram calls this when you reply)

```
You reply to the bot in Telegram
         |
         v
  POST /webhook  (Telegram calls this URL)
         |
         +- 1. Verify X-Telegram-Bot-Api-Secret-Token header == TELEGRAM_WEBHOOK_SECRET
         |      (403 if missing or wrong)
         |
         +- 2. Confirm message.chat.id == TELEGRAM_CHAT_ID
         |      (403 if not — only the configured owner's messages are processed)
         |
         +- 3. Skip non-text messages (stickers, images, etc.) with 200 {skipped:true}
         |      (acks to Telegram so it stops retrying; no profile mutation)
         |
         +- 4. parseFeedback  (Anthropic SDK — forced tool use)
         |      Parses your freeform reply into structured signals:
         |      sentiment, wants_more_colloquial, theme_mentions, etc.
         |
         +- 5. reflect  (Anthropic SDK — forced tool use)
         |      Proposes mutations to your Profile based on the parsed feedback.
         |
         +- 6. applyReflectorChanges  (D1 write)
         |      Applies the proposed mutations to the profile row.
         |
         +- 7. recordFeedback  (D1 write — only if history row exists)
                Stores your raw reply text against the most-recent idiom_history row.
```

---

## D1 tables

There are exactly **two** D1 tables. Everything else (Scout candidates, agent
verdicts) is transient — computed at runtime and never persisted.

### `profile` (single row, id = 1)

The user's long-lived taste model. The Reflector updates it after every reply;
the Curator and Scout read it every morning.

| column               | type    | description                                      |
|----------------------|---------|--------------------------------------------------|
| id                   | INTEGER | always 1                                         |
| regional_preference  | TEXT    | "general" / "Mexico" / "Spain" / "Caribbean" ... |
| themes               | TEXT    | JSON array: ["love","work","animals","food"]     |
| common_vs_obscure    | INTEGER | 0 = very common ... 10 = very obscure            |
| no_list              | TEXT    | JSON array of phrase ids that bombed             |
| updated_at           | TEXT    | ISO-8601 timestamp of last Reflector update      |

### `idiom_history` (one row per daily send)

Written by the Orchestrator right after composing the message. Scout reads
`idiom_id` and `colloquialism_id` from all past rows to ensure the same phrase
is never generated again.

| column                 | type    | description                                    |
|------------------------|---------|------------------------------------------------|
| id                     | INTEGER | auto-increment                                 |
| sent_at                | TEXT    | ISO-8601                                       |
| idiom_id               | TEXT    | stable kebab-case id assigned by Scout         |
| idiom_text             | TEXT    | the Spanish phrase                             |
| colloquialism_id       | TEXT    | stable kebab-case id assigned by Scout         |
| colloquialism_text     | TEXT    | the Spanish phrase                             |
| curator_justification  | TEXT    | Curator's one-sentence rationale               |
| user_rating            | INTEGER | reserved for future use                        |
| user_feedback          | TEXT    | populated by /webhook after a reply            |

---

## TypeScript interfaces at a glance

| Interface           | Role                     | Where it lives / what it represents                                     |
|---------------------|--------------------------|-------------------------------------------------------------------------|
| `Profile`           | D1 row                   | User taste model — persisted forever                                    |
| `IdiomHistory`      | D1 row                   | One day's send record — persisted forever                               |
| `SeedPhrase`        | LLM output (transient)   | Shape of one phrase generated by Scout; never stored directly           |
| `CuratorVerdict`    | LLM output (transient)   | Curator's structured pick (idiom + colloquialism + justification)        |
| `FeedbackResult`    | LLM output (transient)   | Feedback agent's parsed reading of a user reply                         |
| `ReflectorProposal` | LLM output (transient)   | Reflector's proposed mutations to `Profile`                             |
| `Env`               | Cloudflare runtime       | Worker bindings (D1 handle + Anthropic API key + Telegram credentials)  |

---

## Getting started

```bash
# Install dependencies
npm install

# Create the D1 database (one-time)
wrangler d1 create idiom-app
# Copy the database_id printed above into wrangler.toml

# Apply the schema (one-time)
wrangler d1 execute idiom-app --file=schema.sql

# Store the Anthropic API key
wrangler secret put ANTHROPIC_API_KEY

# Run locally (HTTP only)
npm run dev

# Trigger the scheduled handler locally
wrangler dev --test-scheduled

# Run tests
npm test

# Deploy
npm run deploy
```

### Telegram bot setup

1. **Create the bot.** Install Telegram on your phone, then message
   [@BotFather](https://t.me/BotFather), send `/newbot`, and follow the prompts.
   Copy the bot token (format: `123456:ABC...`).

2. **Store the bot token:**
   ```bash
   wrangler secret put TELEGRAM_BOT_TOKEN
   ```

3. **Open a chat with the bot.** Find the bot by its username in Telegram and
   tap **Start** — this creates the chat that will receive daily messages.

4. **Get your chat ID.** Message [@userinfobot](https://t.me/userinfobot) and it
   will reply with your numeric user ID. That number is your `TELEGRAM_CHAT_ID`.

5. **Store the chat ID:**
   ```bash
   wrangler secret put TELEGRAM_CHAT_ID
   ```

6. **Generate a webhook secret** (keeps the `/webhook` endpoint private):
   ```bash
   openssl rand -hex 32
   ```

7. **Store the webhook secret:**
   ```bash
   wrangler secret put TELEGRAM_WEBHOOK_SECRET
   ```

8. **Deploy the Worker:**
   ```bash
   npm run deploy
   ```

9. **Register the webhook with Telegram** (one-time, run after deploy):
   ```bash
   curl -X POST 'https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook' \
     -H 'Content-Type: application/json' \
     -d '{
       "url": "https://idiom-app.userkaranb.workers.dev/webhook",
       "secret_token": "<TELEGRAM_WEBHOOK_SECRET>",
       "allowed_updates": ["message"]
     }'
   ```

### Ad-hoc trigger

The daily flow normally runs on cron at 13:00 UTC. To invoke it on demand
against the deployed Worker (useful for end-to-end testing without waiting):

```bash
curl -X POST https://idiom-app.<your-subdomain>.workers.dev/trigger \
  -H "Authorization: Bearer $TRIGGER_SECRET"
```

Returns `{"ok":true}` on success, `{"ok":false,"error":"..."}` with HTTP 500
on failure. The endpoint is gated on a shared secret stored as a Wrangler
secret (`wrangler secret put TRIGGER_SECRET`), so the public URL cannot be
abused.

---

## Env bindings

| Name                      | How to set                                       | Description                                              |
|---------------------------|--------------------------------------------------|----------------------------------------------------------|
| `DB`                      | `[[d1_databases]]` in `wrangler.toml`           | D1 database binding                                      |
| `ANTHROPIC_API_KEY`       | `wrangler secret put ANTHROPIC_API_KEY`         | Anthropic API key for all LLM calls                      |
| `TELEGRAM_BOT_TOKEN`      | `wrangler secret put TELEGRAM_BOT_TOKEN`        | Bot token from @BotFather (format: `123456:ABC...`)      |
| `TELEGRAM_CHAT_ID`        | `wrangler secret put TELEGRAM_CHAT_ID`          | Numeric chat ID of the owner; obtain from @userinfobot   |
| `TELEGRAM_WEBHOOK_SECRET` | `wrangler secret put TELEGRAM_WEBHOOK_SECRET`   | Shared secret for POST /webhook; generate with `openssl rand -hex 32` |
| `TRIGGER_SECRET`          | `wrangler secret put TRIGGER_SECRET`            | Bearer token for POST /trigger                           |
