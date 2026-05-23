# idiom-app

A personal Spanish-immersion Cloudflare Worker. Every day at 13:00 UTC it picks one idiom and one colloquialism tailored to your taste, logs the message, and saves what it sent. The message is delivered as a push notification via [ntfy.sh](https://ntfy.sh).

There is no frontend. The user-facing surface is a push notification on your phone. You can also read raw output via `wrangler tail` and poke the trigger endpoint with `curl` for debugging.

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
         |      +-- profile          (taste model: region, vulgarity, themes, ...)
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
         +- 6. POST https://ntfy.sh/<NTFY_TOPIC>
         |      Delivers the message as a push notification.
         |
         +- 7. INSERT into idiom_history  (sent_at, idiom_id, text, justification, ...)
```

### Inbound / feedback channel

The previous Twilio implementation had a `/webhook` route that received SMS
replies, ran them through `feedback.ts` (parsed the user's rating), then
`reflector.ts` (proposed profile mutations), and wrote the result back to D1.

**ntfy.sh free tier is publish-only.** There is no URL the Worker can expose
for the ntfy app to POST replies back to — the push notification flows one
direction only (server → phone). The `/webhook` route was removed because
there is nothing left to call it.

The `feedback.ts` and `reflector.ts` agents are **preserved** and their unit
tests continue to pass. The `user_rating` and `user_feedback` columns in
`idiom_history` are also kept. When an inbound channel is added (e.g. Telegram
bot commands, or ntfy's paid action-button callbacks), those agents plug
straight in — the integration point would be a new route in `src/index.ts`
that calls `handleFeedback` → `handleReflect` → `repos.idiomHistory.update()`.

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
| vulgarity_tolerance  | INTEGER | 0 = none, 1 = mild, 2 = moderate, 3 = high      |
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
| user_rating            | INTEGER | reserved for future feedback channel           |
| user_feedback          | TEXT    | reserved for future feedback channel           |

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
| `Env`               | Cloudflare runtime       | Worker bindings (D1 handle + Anthropic API key + ntfy topic)            |

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

### ntfy.sh setup

1. **Pick a topic name.** On the free tier, the URL is the shared secret — use
   a long random string (e.g. `idiom-app-xk7q2mw9p4`). Anyone who knows the
   topic name can subscribe, so treat it like a password.

2. **Set the secret:**
   ```bash
   wrangler secret put NTFY_TOPIC
   ```

3. **Subscribe on your phone.** Install the [ntfy mobile app](https://ntfy.sh),
   tap **Subscribe to topic**, and enter your topic name. Notifications will
   appear as soon as the Worker POSTs.

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

| Name               | How to set                              | Description                                     |
|--------------------|-----------------------------------------|-------------------------------------------------|
| `DB`               | `[[d1_databases]]` in `wrangler.toml`  | D1 database binding                             |
| `ANTHROPIC_API_KEY`| `wrangler secret put ANTHROPIC_API_KEY`| Anthropic API key for all LLM calls             |
| `NTFY_TOPIC`       | `wrangler secret put NTFY_TOPIC`       | ntfy.sh topic name (acts as shared secret)      |
| `TRIGGER_SECRET`   | `wrangler secret put TRIGGER_SECRET`   | Bearer token for POST /trigger                  |
