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

## Slack bot setup

1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps)
2. Add a Bot User and install it to your workspace
3. Grant these OAuth scopes:
   - `channels:history`, `channels:read`
   - `groups:history`, `groups:read`
   - `users:read`, `team:read`
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
SLACKCRAWL_API_KEY=your-secret-key
SLACKCRAWL_CHANNELS=general,team-eng   # optional: leave empty to sync all bot channels
SLACKCRAWL_SYNC_INTERVAL=10m           # optional: polling interval (default 10m)
DATA_DIR=/data

# Optional: enable AI enrichment
CLAUDE_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
```

Mount a persistent volume at `/data`. The default command (`serve`) starts the API server and the background sync loop. If both AI keys are set, enrichment runs automatically after each sync.

## Commands

| Command | Description |
|---------|-------------|
| `slackcrawl serve` | Start REST API + background sync loop (+ enrichment if keys set) |
| `slackcrawl sync [--full] [--channel NAME]` | One-time sync |
| `slackcrawl enrich` | Run AI enrichment manually (needs both API keys) |
| `slackcrawl doctor` | Check token, config, DB, and AI keys |
| `slackcrawl status` | Show DB and enrichment statistics |

## REST API

All endpoints except `/health` require `Authorization: Bearer <SLACKCRAWL_API_KEY>`.

### Core endpoints

These work with or without AI enrichment.

```
GET  /health

GET  /v1/search?q=...&channel=...&author=...&since=2026-01-01&limit=50
GET  /v1/messages?channel=general&days=7&author=alice&limit=100
GET  /v1/messages?channel=general&hours=6
GET  /v1/threads?channel=general&thread_ts=1712345678.000100
GET  /v1/channels[?archived=true]
GET  /v1/members[?query=alice]
GET  /v1/status
POST /v1/sync                          body: {"channel":"general"}
GET  /v1/sql?q=SELECT+count(*)+FROM+messages
```

### Enrichment endpoints

These return data only after enrichment has run. Without AI keys, they return empty results.

```
GET  /v1/context?topic=billing&channel=general&days=14&limit=10
GET  /v1/decisions?channel=general&since=2026-01-01&q=deploy&category=action_item&limit=50
GET  /v1/digests?channel=general&days=7&date=2026-03-01
GET  /v1/expertise?q=payments&limit=20
GET  /v1/expertise?user=U12345
POST /v1/enrich
```

### Search modes

The `/v1/search` endpoint now supports a `mode` parameter:

- `mode=keyword` (default) — FTS5 full-text search, same as before
- `mode=semantic` — vector similarity search using embeddings
- `mode=hybrid` — combines both, deduplicates, returns results from either source

```bash
curl -H "Authorization: Bearer $SLACKCRAWL_API_KEY" \
  "https://your-instance/v1/search?q=payment+failed&mode=hybrid&limit=20"
```

### The context endpoint

`/v1/context` is what agents should actually hit. Pass a topic, get back semantic matches, keyword matches, thread summaries, decisions, digests, and relevant experts. It includes a `token_estimate` so the agent knows how much context it's about to inject.

```bash
curl -H "Authorization: Bearer $SLACKCRAWL_API_KEY" \
  "https://your-instance/v1/context?topic=billing+issues&days=14&limit=10"
```

Response shape:

```json
{
  "topic": "billing issues",
  "messages": [...],
  "thread_summaries": {"C456:1712345678.000100": "Alice reported..."},
  "decisions": [...],
  "digests": [...],
  "experts": [{"user_id": "U123", "username": "alice", "summary": "..."}],
  "token_estimate": 2400,
  "total_messages": 8
}
```

### Example: search

```bash
curl -H "Authorization: Bearer $SLACKCRAWL_API_KEY" \
  "https://your-instance/v1/search?q=payment+failed&days=7&limit=20"
```

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

Timestamps (`ts`, `created_at`) are Unix epoch seconds (UTC).

## How enrichment works

When both `CLAUDE_API_KEY` and `OPENAI_API_KEY` are set, enrichment runs after each sync cycle. You can also trigger it manually with `bun run src/index.ts enrich` or `POST /v1/enrich`.

The pipeline runs five stages in order. Later stages use output from earlier ones:

1. **Embeddings** -- Batch un-embedded messages to OpenAI, 100 per call. Cheapest stage. Stored as Float32 BLOBs in SQLite, loaded into memory for search.
2. **Thread summaries** -- Threads with 2+ replies that don't have a summary (or have new replies since the last one) go to Claude. 2-3 sentences each.
3. **Decision extraction** -- Runs on the summary text, not the raw thread. Pulls out decisions, action items, conclusions, commitments.
4. **Channel digests** -- Days with 3+ top-level messages and no existing digest get a markdown summary from Claude. Thread summaries and decisions feed in as extra context.
5. **User profiles** -- Once per day. Users with 5+ messages get an expertise profile from their recent activity: topics, confidence scores, active channels.

Every stage is idempotent. Interrupt it, and it picks up where it left off next run.

Vector search is brute-force cosine similarity. Embeddings load into a contiguous Float32Array, pre-normalized, so similarity is just a dot product. 50K messages scans in under 50ms. The index rebuilds after each enrichment run.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `SLACK_BOT_TOKEN` | — | Required. Slack bot token (`xoxb-...`) |
| `SLACKCRAWL_API_KEY` | — | API key for REST endpoints. Leave empty only for local-only use |
| `SLACKCRAWL_CHANNELS` | all bot channels | Comma-separated channel names or IDs to monitor |
| `SLACKCRAWL_SYNC_INTERVAL` | `10m` | Polling interval (`5m`, `1h`, etc.) |
| `DATA_DIR` | `~/.slackcrawl` | Directory for the SQLite database |
| `SLACKCRAWL_DB_PATH` | `$DATA_DIR/slackcrawl.db` | Override DB path directly |
| `PORT` | `8080` | HTTP listen port |
| `SLACKCRAWL_HOST` | `0.0.0.0` | HTTP listen host |
| `CLAUDE_API_KEY` | — | Claude API key. Enables summaries, decisions, digests, profiles |
| `OPENAI_API_KEY` | — | OpenAI API key. Enables embeddings and semantic search |
| `CLAUDE_MODEL` | `claude-sonnet-4-20250514` | Claude model to use |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | OpenAI embedding model |
| `SLACKCRAWL_ENRICH_BATCH` | `100` | How many messages to embed per API call |
| `SLACKCRAWL_ENRICH_MIN_REPLIES` | `2` | Minimum thread replies before summarizing |

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
