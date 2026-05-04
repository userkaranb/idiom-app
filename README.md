# idiom-app

A personal Spanish-immersion Cloudflare Worker. Every day at 13:00 UTC it picks one idiom and one colloquialism tailored to your taste, logs the message, and saves what it sent. When you reply (via WhatsApp in v2, or a fake webhook POST in v1), it learns from your reaction and sharpens future picks.

There is no frontend. The user-facing surface is WhatsApp (v2). In v1 you read output via `wrangler tail` and poke the feedback endpoint with `curl`.

---

## Architecture

### Daily flow (`scheduled()` — Cron Trigger fires once a day)

```
wrangler.toml cron: "0 13 * * *"
         │
         ▼
  scheduled() handler
         │
         ├─ 1. Read D1
         │      ├── profile          (taste model — region, vulgarity, themes, …)
         │      └── idiom_history    (every phrase ever sent — used for deduplication)
         │
         ├─ 2. Scout
         │      Loads seed-phrases.json (in-repo static phrase library).
         │      Filters out phrases already in idiom_history.
         │      Filters remaining by Profile (region / theme / vulgarity).
         │      Returns a short candidate list.
         │
         ├─ 3. Curator  (Anthropic SDK — forced tool use → CuratorVerdict)
         │      Receives candidates + Profile.
         │      Picks exactly one idiom + one colloquialism.
         │      Returns structured JSON: { idiom, colloquialism, justification }.
         │
         ├─ 4. Writer   (Anthropic SDK)
         │      Turns the CuratorVerdict into a user-facing WhatsApp message body.
         │
         ├─ 5. console.log(messageBody)   ← visible via `wrangler tail`
         │
         └─ 6. INSERT into idiom_history  (sent_at, idiom_id, text, justification, …)
```

### Feedback flow (`fetch()` — inbound HTTP, POST /webhook)

```
WhatsApp reply (v2) ─┐
curl POST /webhook   ─┴─▶  fetch() handler
                                │
                                ├─ Feedback agent  (Anthropic SDK)
                                │   Parses freeform reply text → FeedbackResult
                                │   (sentiment, style preferences, theme mentions)
                                │
                                ├─ UPDATE idiom_history  (user_rating, user_feedback)
                                │   on the most-recent row
                                │
                                ├─ Reflector agent  (Anthropic SDK)
                                │   Reads FeedbackResult + current Profile.
                                │   Proposes Profile mutations → ReflectorProposal
                                │   (only fields it has evidence to change are set)
                                │
                                └─ UPDATE profile  (apply ReflectorProposal fields)
```

---

## D1 tables

### `profile` (single row, id = 1)

The user's long-lived taste model. The Reflector updates it after every reply;
the Curator reads it every morning.

| column               | type    | description                                      |
|----------------------|---------|--------------------------------------------------|
| id                   | INTEGER | always 1                                         |
| regional_preference  | TEXT    | "general" / "Mexico" / "Spain" / "Caribbean" …  |
| vulgarity_tolerance  | INTEGER | 0 = none, 1 = mild, 2 = moderate, 3 = high      |
| themes               | TEXT    | JSON array: ["love","work","animals","food"]     |
| common_vs_obscure    | INTEGER | 0 = very common … 10 = very obscure              |
| no_list              | TEXT    | JSON array of phrase ids that bombed             |
| updated_at           | TEXT    | ISO-8601 timestamp of last Reflector update      |

### `idiom_history` (one row per daily send)

Written by the Orchestrator right after composing the message. Scout reads this
table to ensure the same phrase is never sent twice. `user_rating` and
`user_feedback` start null and are filled in by the webhook handler.

| column                 | type    | description                                    |
|------------------------|---------|------------------------------------------------|
| id                     | INTEGER | auto-increment                                 |
| sent_at                | TEXT    | ISO-8601                                       |
| idiom_id               | TEXT    | matches `SeedPhrase.id`                        |
| idiom_text             | TEXT    | the Spanish phrase                             |
| colloquialism_id       | TEXT    | matches `SeedPhrase.id`                        |
| colloquialism_text     | TEXT    | the Spanish phrase                             |
| curator_justification  | TEXT    | Curator's one-sentence rationale               |
| user_rating            | INTEGER | 1–5 once the user rates it; null until then    |
| user_feedback          | TEXT    | freeform reply text; null until received       |

---

## Static phrase library (`seed-phrases.json`)

`SeedPhrase` is the TypeScript shape of one entry in this file. It is **not** a
D1 table — it is a curated JSON file shipped with the repo that Scout loads at
runtime. Each phrase has a stable kebab-case `id` (e.g.
`"el-que-no-llora-no-mama"`) that is stored in `idiom_history` to enable
lifetime deduplication.

---

## TypeScript interfaces at a glance

| Interface          | Where it lives          | What it represents                                      |
|--------------------|-------------------------|---------------------------------------------------------|
| `Profile`          | D1 `profile` row        | User taste model — persisted forever                    |
| `IdiomHistory`     | D1 `idiom_history` row  | One day's send record — persisted forever               |
| `SeedPhrase`       | `seed-phrases.json`     | One candidate phrase from the in-repo library           |
| `CuratorVerdict`   | AI agent output         | Curator's structured pick (idiom + colloquialism)       |
| `FeedbackResult`   | AI agent output         | Feedback agent's parsed reading of a user reply         |
| `ReflectorProposal`| AI agent output         | Reflector's proposed mutations to `Profile`             |
| `Env`              | Cloudflare runtime      | Worker bindings (D1 handle + API key)                   |

`FeedbackResult` is transient — it is never stored in D1. The webhook handler
already holds the relevant `IdiomHistory` row id and writes `user_rating` /
`user_feedback` directly; `FeedbackResult` is then forwarded to the Reflector,
which translates it into a `ReflectorProposal` used to update `Profile`.

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
