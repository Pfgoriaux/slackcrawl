# slackcrawl

Mirrors Slack channels into SQLite and exposes a REST API for AI agents. Optionally turns raw messages into something more useful: thread summaries, extracted decisions, daily digests, and semantic search over embeddings.

No SDKs. Slack, Claude, and OpenAI are all called with plain `fetch`. Runs on [Bun](https://bun.sh).

## What it does

- Syncs all channels the bot is invited to (or a specific list you configure)
- Polls for new messages on a configurable interval (default 10 minutes)
- Stores messages, users, channels, and threads in SQLite with FTS5 full-text search
- Exposes a REST API so AI agents (or humans) can search and query the archive

With AI enrichment enabled (optional — needs a Claude API key and an OpenAI API key):

- Embeds messages with OpenAI `text-embedding-3-small` for semantic search
- Summarizes threads with Claude (2-3 sentences per thread)
- Extracts decisions and action items from those summaries
- Generates daily channel digests
- Builds expertise profiles for users based on their message history
- Provides a `/v1/context` endpoint that bundles all of the above into one call, which is what agents should actually use

Without API keys, nothing changes. Same behavior as before.

## How sync stays complete

The goal is to never lose a message from any channel the bot is in (public or private —
DMs are never touched). Slack's polling API makes that non-trivial, so sync runs at two
cadences:

- **Incremental** (`SLACKCRAWL_SYNC_INTERVAL`, default 10m): fetches new top-level
  messages since the last watermark, **and** re-polls replies for any thread active in
  the last `SLACKCRAWL_THREAD_REPOLL_DAYS` (default 14). This is what catches replies that
  land on threads whose root is older than the polling window — a reply that plain history
  polling would otherwise miss forever.
- **Reconciliation** (`SLACKCRAWL_RECONCILE_INTERVAL`, default 24h, set `0` to disable):
  a full re-scan of every channel. It captures **edits** to old messages, re-polls all
  threads completely, and detects **deletions** — a message that vanished from Slack is
  marked with a `deleted_at` tombstone (kept in the DB, hidden from search/results) rather
  than dropped, so the archive is auditable. You can trigger one on demand with
  `slackcrawl sync --full` or `POST /v1/sync {"full":true}`.

Channels removed from `SLACKCRAWL_CHANNELS` are deactivated, not deleted — their history
is preserved. System/noise messages (joins, topic changes, etc.) are stored but excluded
from search and AI enrichment.

### A note on Slack rate limits

As of 2025-05-29 Slack throttles `conversations.history`/`replies` hard for
non-Marketplace apps **created after that date**: ~1 request/minute and ~15 messages per
page. Internal/custom workspace apps (the `xoxb-` bot this README sets up) generally keep
the older ~50 req/min tier. slackcrawl honors `Retry-After` automatically, but if your app
is on the new tier, raise `SLACKCRAWL_SLACK_MIN_INTERVAL_MS` (e.g. `60000`) so the global
rate limiter paces requests accordingly — initial backfill of a busy workspace will then
take a while.

## Slack bot setup

1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps)
2. Add a Bot User and install it to your workspace
3. Grant these OAuth scopes:
   - `channels:history`, `channels:read`
   - `groups:history`, `groups:read`
   - `users:read`, `users:read.email`, `team:read`
4. Copy the Bot Token (`xoxb-...`)
5. Invite the bot to every channel you want archived (`/invite @yourbot`)

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/Pfgoriaux/slackcrawl/main/install.sh | sh
```

Detects your OS and architecture, downloads the right binary, installs to `/usr/local/bin`. No dependencies.

Or grab a binary manually from the [Releases page](https://github.com/Pfgoriaux/slackcrawl/releases/latest).

## Quick start

```bash
export SLACK_BOT_TOKEN=xoxb-...
export SLACKCRAWL_API_KEY=my-secret

# Check config and token
slackcrawl doctor

# First-time full sync
slackcrawl sync --full

# Start API server (also runs sync loop)
slackcrawl serve
```

### From source (requires Bun 1.0+)

```bash
git clone https://github.com/Pfgoriaux/slackcrawl
cd slackcrawl
bun install
bun run src/index.ts serve
```

To enable AI enrichment, add two more keys:

```bash
export CLAUDE_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...

# Run enrichment manually (or it runs automatically after each sync)
bun run src/index.ts enrich
```

## Deploy to Coolify

Point Coolify at this repo and set environment variables:

```
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACKCRAWL_API_KEYS=data-team:LONG_RANDOM_SECRET,ci-bot:ANOTHER_LONG_SECRET
SLACKCRAWL_CHANNELS=general,team-eng   # optional: leave empty to sync all bot channels
SLACKCRAWL_SYNC_INTERVAL=10m           # optional: incremental polling interval
SLACKCRAWL_RECONCILE_INTERVAL=24h      # optional: full re-scan (edits/deletions)
DATA_DIR=/data

# Optional: enable AI enrichment
CLAUDE_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
```

Mount a persistent volume at `/data`. The default command (`serve`) starts the API server
and the background sync + reconciliation loops. If both AI keys are set, enrichment runs
(bounded per cycle) after each sync.

Notes for production:

- The container runs as a non-root user, ships a compiled binary, and exposes a Docker
  `HEALTHCHECK` against `/health`.
- Let Coolify terminate TLS and proxy to port 8080 — the app speaks plain HTTP and has no
  built-in TLS or HTTP rate limiting. Don't expose 8080 directly to the internet.
- `serve` refuses to start without an API key unless `SLACKCRAWL_ALLOW_NO_AUTH=true`.
- On `SIGTERM` (redeploys) the server drains in-flight requests, lets the current sync/
  enrichment reach a safe point, checkpoints the WAL, and exits cleanly.

## Commands

| Command | Description |
|---------|-------------|
| `slackcrawl serve` | Start REST API + background sync loop (+ enrichment if keys set) |
| `slackcrawl sync [--full] [--channel NAME]` | One-time sync |
| `slackcrawl enrich` | Run AI enrichment manually (needs both API keys) |
| `slackcrawl doctor` | Check token, config, DB, and AI keys |
| `slackcrawl status` | Show DB and enrichment statistics |

## REST API

All endpoints except `/health` and `/v1/schema` require `Authorization: Bearer <key>`,
where `<key>` is any of the configured API keys.

### Authentication

Configure one or more named keys. The name of the matching key is logged with every
request, giving you a per-caller audit trail and the ability to revoke a single key
(e.g. one agent) without rotating everyone else's.

```bash
# Multiple named keys (recommended): give each team/agent its own
export SLACKCRAWL_API_KEYS="data-team:$(openssl rand -hex 24),ci-bot:$(openssl rand -hex 24)"

# Or a single key (name defaults to "default")
export SLACKCRAWL_API_KEY=$(openssl rand -hex 24)
```

Keys must be at least 16 characters; the example placeholder values are rejected. If no
key is set, `serve` refuses to start unless you explicitly set `SLACKCRAWL_ALLOW_NO_AUTH=true`.
Comparison is constant-time. There is no per-channel authorization — any valid key can
read every archived channel — so treat keys as workspace-wide secrets and put the service
behind a TLS-terminating reverse proxy.

All examples below use `$API` as shorthand for `https://your-instance` and assume:

```bash
export API=https://your-instance  # or http://localhost:8080
export SLACKCRAWL_API_KEY=my-very-long-secret-key
```

### Core endpoints

These work with or without AI enrichment.

```
GET  /health
GET  /v1/schema                          OpenAPI 3.0 spec (no auth, for agent discovery)
GET  /v1/search?q=...&channel=...&author=...&since=2026-01-01&limit=50
GET  /v1/messages?channel=general&days=7&author=alice&limit=100
GET  /v1/threads?channel=general&thread_ts=1712345678.000100
GET  /v1/channels[?archived=true]
GET  /v1/members[?query=alice]
GET  /v1/status
POST /v1/sync                          body: {"channel":"general","full":true}
```

#### Health check (no auth)

```bash
curl "$API/health"
```

```json
{"status": "ok", "ready": true, "time": "2026-03-17T10:00:00.000Z"}
```

`status` is always `ok` while the process is alive (use it as the container liveness
probe). `ready` becomes `true` once the first sync has completed and the workspace is
resolved — use it to know when query results are meaningful.

#### List channels

```bash
# Active channels only
curl -H "Authorization: Bearer $SLACKCRAWL_API_KEY" "$API/v1/channels"

# Include archived channels
curl -H "Authorization: Bearer $SLACKCRAWL_API_KEY" "$API/v1/channels?archived=true"
```

```json
{
  "channels": [
    {"id": "C0123ABC", "name": "general", "is_archived": false, "member_count": 42},
    {"id": "C0456DEF", "name": "team-eng", "is_archived": false, "member_count": 15}
  ],
  "total": 2
}
```

#### Browse messages

```bash
# Last 7 days in #general
curl -H "Authorization: Bearer $SLACKCRAWL_API_KEY" \
  "$API/v1/messages?channel=general&days=7"

# Last 6 hours, from a specific user
curl -H "Authorization: Bearer $SLACKCRAWL_API_KEY" \
  "$API/v1/messages?channel=general&hours=6&author=alice"

# Since a specific date, with thread expansion
curl -H "Authorization: Bearer $SLACKCRAWL_API_KEY" \
  "$API/v1/messages?channel=general&since=2026-03-01&include_threads=true&limit=50"
```

```json
{
  "messages": [
    {
      "id": "T123:C0123ABC:1712345678.000100",
      "channel_id": "C0123ABC",
      "ts": "1712345678.000100",
      "username": "alice",
      "text": "deployed v2.3 to staging",
      "thread_ts": null,
      "reply_count": 3,
      "created_at": 1712345678
    }
  ],
  "total": 1,
  "channel": "general"
}
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `channel` | string | Channel name or ID |
| `author` | string | Filter by username |
| `days` | int | Messages from the last N days |
| `hours` | int | Messages from the last N hours |
| `since` | ISO date | Messages after this date (`2026-03-01`) |
| `until` | ISO date | Messages before this date |
| `last` | int | Get the N most recent messages |
| `limit` | int | Max results (default 100) |
| `include_threads` | bool | Expand thread replies inline |

#### Retrieve a thread

```bash
curl -H "Authorization: Bearer $SLACKCRAWL_API_KEY" \
  "$API/v1/threads?channel=general&thread_ts=1712345678.000100"
```

```json
{
  "thread_ts": "1712345678.000100",
  "channel_id": "C0123ABC",
  "root": {
    "id": "T123:C0123ABC:1712345678.000100",
    "username": "alice",
    "text": "deployed v2.3 to staging",
    "ts": "1712345678.000100"
  },
  "replies": [
    {"username": "bob", "text": "looks good, tests passing", "ts": "1712345700.000200"},
    {"username": "alice", "text": "promoting to prod now", "ts": "1712345800.000300"}
  ],
  "total": 3
}
```

#### Search members

```bash
curl -H "Authorization: Bearer $SLACKCRAWL_API_KEY" "$API/v1/members?query=alice"
```

#### Trigger a sync

```bash
# Sync all channels
curl -X POST -H "Authorization: Bearer $SLACKCRAWL_API_KEY" "$API/v1/sync"

# Sync a specific channel
curl -X POST -H "Authorization: Bearer $SLACKCRAWL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"channel": "general"}' \
  "$API/v1/sync"

# Force a full reconciliation (re-scan everything; catches edits & deletions)
curl -X POST -H "Authorization: Bearer $SLACKCRAWL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"full": true}' \
  "$API/v1/sync"
```

#### Status and statistics

```bash
curl -H "Authorization: Bearer $SLACKCRAWL_API_KEY" "$API/v1/status"
```

Returns message counts, DB size, workspace info, and enrichment statistics (how many embeddings, summaries, decisions, etc. have been generated).

---

### Enrichment endpoints (AI-powered)

These return data only after enrichment has run. Without AI keys, they return empty results.

```
GET  /v1/search?q=...&mode=semantic|hybrid
GET  /v1/context?topic=...&channel=...&days=14&limit=10
GET  /v1/decisions?channel=...&since=...&q=...&category=...&limit=50
GET  /v1/digests?channel=...&days=7&date=2026-03-01
GET  /v1/expertise?q=...&limit=20
GET  /v1/expertise?user=U12345
POST /v1/enrich
```

#### Search with semantic and hybrid modes

The `/v1/search` endpoint supports three modes:

- `mode=keyword` (default) -- FTS5 full-text search
- `mode=semantic` -- vector similarity using OpenAI embeddings. Finds conceptually related messages even if they don't share exact words.
- `mode=hybrid` -- runs both, deduplicates, tags each result with its `source` (`"semantic"` or `"keyword"`)

```bash
# Keyword search (default, works without AI keys)
curl -H "Authorization: Bearer $SLACKCRAWL_API_KEY" \
  "$API/v1/search?q=payment+failed&limit=20"

# Semantic search -- finds related messages even without exact keyword match
# e.g. "payment failed" also matches "billing error", "charge declined"
curl -H "Authorization: Bearer $SLACKCRAWL_API_KEY" \
  "$API/v1/search?q=payment+failed&mode=semantic&limit=20"

# Hybrid -- best of both, with thread summaries included
curl -H "Authorization: Bearer $SLACKCRAWL_API_KEY" \
  "$API/v1/search?q=payment+failed&mode=hybrid&include_threads=true&limit=20"
```

Keyword response:

```json
{
  "messages": [
    {
      "id": "T123:C456:1712345678.000100",
      "channel_id": "C456",
      "ts": "1712345678.000100",
      "username": "alice",
      "text": "payment failed for invoice #1234",
      "created_at": 1712345678
    }
  ],
  "total": 1,
  "mode": "keyword"
}
```

Semantic response (includes similarity `score` 0-1):

```json
{
  "messages": [
    {
      "id": "T123:C456:1712345900.000200",
      "username": "bob",
      "text": "stripe webhook returned charge_declined for customer acme-corp",
      "score": 0.87,
      "created_at": 1712345900
    },
    {
      "id": "T123:C456:1712345678.000100",
      "username": "alice",
      "text": "payment failed for invoice #1234",
      "score": 0.92,
      "created_at": 1712345678
    }
  ],
  "total": 2,
  "mode": "semantic"
}
```

Hybrid response (merges both, each result tagged with `source`):

```json
{
  "messages": [
    {"text": "stripe webhook returned charge_declined...", "score": 0.87, "source": "semantic"},
    {"text": "payment failed for invoice #1234", "source": "keyword"}
  ],
  "total": 2,
  "mode": "hybrid"
}
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `q` | string | **Required.** Search query |
| `mode` | string | `keyword` (default), `semantic`, or `hybrid` |
| `channel` | string | Filter by channel name or ID |
| `author` | string | Filter by username |
| `since` | ISO date | Messages after this date |
| `limit` | int | Max results (default 50) |
| `include_threads` | bool | Expand matched threads with replies and AI summaries |

#### The context endpoint (designed for AI agents)

`/v1/context` is the main endpoint agents should use. Pass a topic, get back everything relevant in one call: semantic matches, keyword matches, thread summaries, decisions, digests, and domain experts. It includes a `token_estimate` so the agent knows how large the context payload is before injecting it into a prompt.

```bash
curl -H "Authorization: Bearer $SLACKCRAWL_API_KEY" \
  "$API/v1/context?topic=billing+issues&days=14&limit=10"
```

What happens internally:

1. **Semantic search** -- embeds the topic with OpenAI and finds the closest messages by cosine similarity
2. **Keyword search** -- runs FTS5 full-text search for the same topic
3. **Merge and deduplicate** -- combines both result sets, removes duplicates, tags each with its source
4. **Thread summaries** -- for every matched message that belongs to a thread, fetches the Claude-generated summary
5. **Decisions** -- pulls extracted decisions/action items matching the topic and time window
6. **Digests** -- fetches daily channel digests covering the time window
7. **Experts** -- finds users whose expertise profiles match the topic

```json
{
  "topic": "billing issues",
  "messages": [
    {
      "id": "T123:C456:1712345678.000100",
      "username": "alice",
      "text": "payment failed for invoice #1234, stripe returned card_declined",
      "score": 0.92,
      "source": "semantic"
    },
    {
      "id": "T123:C456:1712346000.000200",
      "username": "bob",
      "text": "seeing the same billing error on acme-corp's account",
      "source": "keyword"
    }
  ],
  "thread_summaries": {
    "C456:1712345678.000100": "Alice reported a payment failure on invoice #1234. Bob confirmed the same issue on acme-corp. Carol traced it to an expired card and applied a retry with the updated payment method."
  },
  "decisions": [
    {
      "decision": "Add automatic card expiry notification 7 days before charge",
      "category": "action_item",
      "participants": ["alice", "carol"],
      "channel_id": "C456",
      "thread_ts": "1712345678.000100"
    }
  ],
  "digests": [
    {
      "channel_id": "C456",
      "date": "2026-03-15",
      "summary": "## Billing\nTwo payment failures reported on enterprise accounts...",
      "key_topics": ["billing", "stripe", "card-expiry"],
      "message_count": 24
    }
  ],
  "experts": [
    {
      "user_id": "U789",
      "username": "carol",
      "summary": "Payments and billing infrastructure. Primarily active in #billing and #team-eng."
    }
  ],
  "token_estimate": 2400,
  "total_messages": 2
}
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `topic` | string | **Required.** What the agent is looking for |
| `channel` | string | Scope to a specific channel |
| `days` | int | Look back N days (default 14) |
| `limit` | int | Max messages to return (default 10) |

#### Decisions and action items

Decisions are extracted by Claude from thread summaries. Each decision is categorized as `decision`, `action_item`, `conclusion`, or `commitment`.

```bash
# All decisions from #general since March 1st
curl -H "Authorization: Bearer $SLACKCRAWL_API_KEY" \
  "$API/v1/decisions?channel=general&since=2026-03-01"

# Only action items mentioning "deploy"
curl -H "Authorization: Bearer $SLACKCRAWL_API_KEY" \
  "$API/v1/decisions?q=deploy&category=action_item&limit=20"
```

```json
{
  "decisions": [
    {
      "id": 1,
      "channel_id": "C0123ABC",
      "thread_ts": "1712345678.000100",
      "decision": "Switch deploy pipeline to use blue-green strategy by end of sprint",
      "category": "action_item",
      "participants": "[\"alice\", \"bob\"]",
      "decided_at": 1712345678
    },
    {
      "id": 2,
      "channel_id": "C0123ABC",
      "thread_ts": "1712345678.000100",
      "decision": "Rollback threshold set to 5% error rate",
      "category": "decision",
      "participants": "[\"bob\"]",
      "decided_at": 1712345678
    }
  ],
  "total": 2
}
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `channel` | string | Filter by channel name or ID |
| `since` | ISO date | Decisions after this date |
| `q` | string | Full-text search within decisions |
| `category` | string | `decision`, `action_item`, `conclusion`, or `commitment` |
| `limit` | int | Max results (default 50) |

#### Daily channel digests

Claude generates a markdown summary for each channel-day with 3+ messages. Digests include key topics, thread highlights, and activity stats.

```bash
# Last 7 days of digests for #general
curl -H "Authorization: Bearer $SLACKCRAWL_API_KEY" \
  "$API/v1/digests?channel=general&days=7"

# A specific date
curl -H "Authorization: Bearer $SLACKCRAWL_API_KEY" \
  "$API/v1/digests?channel=general&date=2026-03-15"
```

```json
{
  "digests": [
    {
      "channel_id": "C0123ABC",
      "date": "2026-03-15",
      "summary": "## Deployment and Infrastructure\nThe team discussed the move to blue-green deployments. Alice shared benchmark results showing 40% faster rollbacks. Bob raised concerns about database migration timing.\n\n## Bug Reports\nTwo P1 bugs filed: a timeout in the payment webhook handler and a race condition in the notification queue.",
      "key_topics": ["deployment", "blue-green", "database-migration", "payment-webhook", "notification-queue"],
      "message_count": 47,
      "thread_count": 8,
      "participant_count": 12
    }
  ],
  "total": 1
}
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `channel` | string | Filter by channel name or ID |
| `days` | int | Look back N days (default 7) |
| `date` | ISO date | Get digest for a specific date (`2026-03-15`) |

#### Expertise profiles

User expertise is built from message history. Each profile has a summary and a list of topics with confidence scores (0-1) and channels where the user is active.

```bash
# Find who knows about payments
curl -H "Authorization: Bearer $SLACKCRAWL_API_KEY" \
  "$API/v1/expertise?q=payments&limit=5"

# Get a specific user's profile
curl -H "Authorization: Bearer $SLACKCRAWL_API_KEY" \
  "$API/v1/expertise?user=U0123XYZ"
```

Search by topic:

```json
{
  "experts": [
    {
      "user_id": "U789",
      "username": "carol",
      "real_name": "Carol Chen",
      "summary": "Payments and billing infrastructure engineer. Deep expertise in Stripe integration and webhook handling.",
      "expertise": [
        {"topic": "stripe", "confidence": 0.95, "channels": ["#billing", "#team-eng"]},
        {"topic": "payment-processing", "confidence": 0.90, "channels": ["#billing"]},
        {"topic": "webhooks", "confidence": 0.75, "channels": ["#team-eng", "#incidents"]}
      ]
    }
  ],
  "total": 1
}
```

Single user profile:

```json
{
  "profile": {
    "user_id": "U789",
    "username": "carol",
    "real_name": "Carol Chen",
    "summary": "Payments and billing infrastructure engineer.",
    "expertise": [
      {"topic": "stripe", "confidence": 0.95, "channels": ["#billing", "#team-eng"]},
      {"topic": "payment-processing", "confidence": 0.90, "channels": ["#billing"]}
    ]
  }
}
```

#### Trigger enrichment manually

```bash
curl -X POST -H "Authorization: Bearer $SLACKCRAWL_API_KEY" "$API/v1/enrich"
```

```json
{"status": "queued"}
```

Returns immediately. Enrichment runs in the background. Use `/v1/status` to check progress.

Timestamps (`ts`, `created_at`) are Unix epoch seconds (UTC).

## How enrichment works

When both `CLAUDE_API_KEY` and `OPENAI_API_KEY` are set, enrichment runs after each sync cycle. You can also trigger it manually with `slackcrawl enrich` or `POST /v1/enrich`.

The pipeline runs five stages in order. Each stage feeds into the next:

```
Raw messages
  |
  v
[Stage 1] Embeddings (OpenAI)        --> enables semantic search
  |
  v
[Stage 2] Thread summaries (Claude)  --> 2-3 sentence summaries
  |
  v
[Stage 3] Decision extraction (Claude) --> runs on summaries, not raw messages
  |
  v
[Stage 4] Channel digests (Claude)   --> uses messages + summaries + decisions
  |
  v
[Stage 5] User profiles (Claude)     --> built from message history
```

### Stage 1: Embeddings

OpenAI `text-embedding-3-small` embeds every message that hasn't been embedded yet. Messages are batched (100 per API call, configurable via `SLACKCRAWL_ENRICH_BATCH`). Long messages are truncated to ~32K characters. Embeddings are stored as Float32 BLOBs in SQLite (~6KB each) and loaded into a contiguous Float32Array in memory for search.

Vector search is brute-force cosine similarity. Embeddings are pre-normalized at insert time, so similarity is a dot product. 50K messages scan in under 50ms. The index rebuilds after each enrichment run.

### Stage 2: Thread summaries

Threads with 2+ replies (configurable via `SLACKCRAWL_ENRICH_MIN_REPLIES`) that don't yet have a summary -- or that have new replies since the last summary -- are sent to Claude. The prompt asks for 2-3 concise sentences covering what was discussed, what was decided, and any action items. Participant names are included when relevant.

If a thread gets new replies after being summarized, it is re-summarized on the next enrichment run.

### Stage 3: Decision extraction

Runs on the thread summary text, not the raw thread messages. This is intentional: summaries are shorter and more focused, which produces cleaner extraction. Claude returns a JSON array of objects, each with a `decision` text, a `category` (`decision`, `action_item`, `conclusion`, or `commitment`), and the `participants` involved.

### Stage 4: Channel digests

For each channel-day with 3+ top-level messages and no existing digest, Claude generates a markdown summary. The input includes the day's messages plus any thread summaries and decisions from earlier stages, giving the digest richer context than raw messages alone. Claude also extracts 3-8 topic tags for filtering.

### Stage 5: User profiles

Runs once per day. Users with 5+ messages get an expertise profile generated from their 50 most recent messages. Claude returns a JSON object with a 1-2 sentence `summary` and up to 10 `expertise` items, each with a `topic`, `confidence` score (0-1), and the `channels` where the user is active on that topic.

### Design properties

- **Idempotent**: every stage tracks what has been processed in `enrichment_log`. Interrupt at any point and it picks up where it left off.
- **Incremental**: only new/changed data is processed. Re-running enrichment on an already-enriched database is nearly free.
- **Cascading**: later stages use output from earlier ones. Thread summaries feed into decision extraction and channel digests. This means the AI works on progressively refined data, not raw noise.
- **Rate-limited**: both Claude and OpenAI clients enforce minimum intervals between calls (500ms and 200ms respectively) and retry with exponential backoff on 429 responses.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `SLACK_BOT_TOKEN` | — | Required. Slack bot token (`xoxb-...`) |
| `SLACKCRAWL_API_KEYS` | — | Comma-separated named keys: `alice:key1,ci-bot:key2`. The matched key's name is logged with every request (audit trail). |
| `SLACKCRAWL_API_KEY` | — | Single API key (name `default`). Merged with `SLACKCRAWL_API_KEYS` if both are set. Keys must be ≥16 chars; example placeholders are rejected. |
| `SLACKCRAWL_ALLOW_NO_AUTH` | `false` | Set `true` to intentionally run unauthenticated. Otherwise `serve` refuses to start with no key. |
| `SLACKCRAWL_CHANNELS` | all bot channels | Comma-separated channel names or IDs to monitor. Removing a channel here stops syncing it but **never deletes its history**. |
| `SLACKCRAWL_SYNC_INTERVAL` | `10m` | Incremental polling interval (`5m`, `1h`, etc.) |
| `SLACKCRAWL_RECONCILE_INTERVAL` | `24h` | Full reconciliation interval. Re-scans everything to catch edits, deletions, and missed replies. `0` disables it. |
| `SLACKCRAWL_THREAD_REPOLL_DAYS` | `14` | Each incremental cycle re-polls replies for threads active within this many days (cheap fix for replies on older threads). |
| `SLACKCRAWL_SLACK_MIN_INTERVAL_MS` | `1200` | Minimum ms between **all** Slack API calls (global rate limiter). Raise for apps under Slack's new ~1 req/min cap (see below). |
| `SLACKCRAWL_SLACK_PAGE_LIMIT` | `200` | Page size for history/replies. Slack silently clamps this to 15 for non-Marketplace apps created after 2025-05-29. |
| `SLACKCRAWL_MAX_LIMIT` | `500` | Hard cap on any `limit`/`last` query param (prevents memory-exhaustion requests). |
| `DATA_DIR` | `~/.slackcrawl` | Directory for the SQLite database |
| `SLACKCRAWL_DB_PATH` | `$DATA_DIR/slackcrawl.db` | Override DB path directly |
| `PORT` | `8080` | HTTP listen port |
| `SLACKCRAWL_HOST` | `0.0.0.0` | HTTP listen host. Bind `127.0.0.1` if not behind a trusted proxy. |
| `CLAUDE_API_KEY` | — | Claude API key. Enables summaries, decisions, digests, profiles |
| `OPENAI_API_KEY` | — | OpenAI API key. Enables embeddings and semantic search |
| `CLAUDE_MODEL` | `claude-sonnet-4-6` | Claude model to use |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | OpenAI embedding model |
| `SLACKCRAWL_ENRICH_BATCH` | `100` | How many messages to embed per API call |
| `SLACKCRAWL_ENRICH_MIN_REPLIES` | `2` | Minimum thread replies before summarizing |
| `SLACKCRAWL_ENRICH_MAX_PER_CYCLE` | `500` | Cap on items processed per enrichment stage per cycle (bounds cost/time; the rest is picked up next cycle). |
| `SLACKCRAWL_CORS_ORIGIN` | `*` | CORS `Access-Control-Allow-Origin` header value |

## DB tables

The core tables (`workspaces`, `channels`, `users`, `messages`, `messages_fts`) exist from the start.

Enrichment adds six more tables, created automatically when the DB opens:

- `enrichment_log` — tracks what has been processed (prevents re-work)
- `thread_summaries` — 2-3 sentence summaries per thread
- `decisions` — extracted decisions and action items, with an FTS5 index
- `channel_digests` — daily channel summaries in markdown
- `message_embeddings` — Float32 vectors stored as BLOBs (about 6KB each)
- `user_profiles` — expertise profiles with topic/confidence/channel data, with an FTS5 index

The schema is created regardless of whether API keys are set. The tables just stay empty until you run enrichment.

## License

MIT
