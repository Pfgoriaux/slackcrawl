Answer this question using the slackcrawl archive: $ARGUMENTS

## What you have access to

slackcrawl mirrors Slack into a local SQLite database and exposes a REST API. You can reach the data two ways:

**1. REST API** (preferred when the server is running)
Base URL: `http://localhost:${PORT:-8080}`
Auth header: `Authorization: Bearer $SLACKCRAWL_API_KEY`

### Core endpoints

| Endpoint | Use when |
|---|---|
| `GET /health` | Check if server is up (no auth needed) |
| `GET /v1/status` | Data freshness, message/channel counts, last sync time |
| `GET /v1/search?q=TERM&channel=NAME&author=USER&since=YYYY-MM-DD&limit=50&mode=hybrid&include_threads=true` | Searching message content; add `include_threads=true` to expand full thread context for any matching message |
| `GET /v1/messages?channel=NAME&days=7&author=USER&hours=N&limit=100&include_threads=true` | Recent messages with filters; add `include_threads=true` to include full thread replies inline |
| `GET /v1/threads?channel=NAME&thread_ts=TS` | Fetch a single complete thread (root + all replies) by its root timestamp |
| `GET /v1/channels` | List all synced channels and their metadata |
| `GET /v1/members?query=NAME` | Look up a specific person |
| `GET /v1/sql?q=SELECT+...` | Complex aggregations — counts, top contributors, trends |
| `POST /v1/sync` body `{"channel":"NAME"}` | Trigger a fresh sync if data looks stale |

### Search modes

The `/v1/search` endpoint supports a `mode` parameter:

- `mode=keyword` (default) — FTS5 full-text search, fast and exact
- `mode=semantic` — vector similarity search using embeddings (requires AI enrichment)
- `mode=hybrid` — combines both keyword and semantic, deduplicates, returns results from either source

**Prefer `mode=hybrid`** when AI enrichment is enabled — it catches both exact matches and conceptually related messages.

### AI enrichment endpoints

These return data only after enrichment has run (requires `CLAUDE_API_KEY` and `OPENAI_API_KEY`). Without AI keys, they return empty results.

| Endpoint | Use when |
|---|---|
| `GET /v1/context?topic=TOPIC&channel=NAME&days=14&limit=10` | **Best single endpoint for agents.** Returns semantic + keyword matches, thread summaries, decisions, digests, and relevant experts for a topic. Includes a `token_estimate` so you know how much context you're injecting |
| `GET /v1/decisions?channel=NAME&since=YYYY-MM-DD&q=TERM&category=action_item&limit=50` | Extracted decisions and action items from thread summaries |
| `GET /v1/digests?channel=NAME&days=7&date=YYYY-MM-DD` | Daily channel digests in markdown |
| `GET /v1/expertise?q=TOPIC&limit=20` | Find people with expertise on a topic |
| `GET /v1/expertise?user=USER_ID` | Get a specific user's expertise profile |
| `POST /v1/enrich` | Trigger AI enrichment manually |

**2. Direct SQLite** (fallback if server is down)
DB path: `$SLACKCRAWL_DB_PATH` or `~/.slackcrawl/slackcrawl.db` or `$DATA_DIR/slackcrawl.db`

Schema: `workspaces`, `channels`, `users`, `messages` (columns: id, channel_id, ts, thread_ts, text, user_id, username, reply_count, has_attachments, has_files, raw_json, created_at), `messages_fts` (FTS5 virtual table).

CLI fallback: `bun run src/index.ts status` or `bun run src/index.ts sync`

## Proactive search rules

These rules apply **always**, even when the operator does not explicitly ask you to search Slack.

### On every message from the operator
1. Extract the key nouns, verbs, and technical terms from what the operator just said
2. Run `/v1/search` for each meaningful keyword (skip stop words like "the", "can", "is")
3. If any results are found, surface the most relevant ones **before** answering — they are context the operator may not know exists in Slack
4. Example: operator says "we're having issues with the payment webhook" → search for `payment`, `webhook`, `payment webhook`, `stripe` (or whatever payment provider), `callback`

### Daily (or at the start of each new session)
1. Collect **all keywords** from the full conversation history — every operator message and your own replies
2. De-duplicate and batch into groups of related terms
3. Run a fresh search for each group with `&since=YESTERDAY` to catch new Slack activity that post-dates earlier searches
4. Report any new findings that are relevant to topics already discussed

This ensures the operator always has up-to-date Slack context without having to ask for it explicitly.

---

## How to answer

1. **Start with `/health`** — if unreachable, fall back to SQLite directly. Check `/v1/status` to see if AI enrichment is active (look for enrichment stats in the response)
2. **Always fetch `/v1/channels` first** — you need the channel list to:
   - Resolve a channel name the user mentioned (e.g. "in #infra") to the exact `name` or `id` to pass as `?channel=`
   - Check whether the relevant channel is synced at all before searching
   - Spot channels the user might not have named but that are clearly relevant (e.g. `#deployments`, `#incidents` for a question about outages)
   - The API accepts either channel `name` or channel `id` interchangeably in the `?channel=` param
3. **Match the tool to the question:**
   - "what happened with X?" → `/v1/context?topic=X` if enrichment is available, otherwise try multiple synonyms: `?q=X&mode=hybrid`, then `?q=synonym1`, `?q=synonym2`
   - "what decisions were made about X?" → `/v1/decisions?q=X`
   - "give me a summary of #channel" → `/v1/digests?channel=NAME&days=7`
   - "what did @alice post?" → `/v1/messages?author=alice&days=30`
   - "who knows about Y?" → `/v1/expertise?q=Y`
   - "which channels are most active?" → `/v1/sql?q=SELECT channel_id, count(*) FROM messages GROUP BY channel_id ORDER BY 2 DESC LIMIT 10`
   - "is the sync up to date?" → `/v1/status`
   - "who works on Y?" → `/v1/search?q=Y&mode=hybrid` + `/v1/members?query=...`
   - broad temporal question ("last week") → raise `limit` to 200, then summarize in passes
4. **Prefer `/v1/context` for topic-based questions** — it bundles semantic matches, keyword matches, thread summaries, decisions, digests, and experts into one call. Check the `token_estimate` field to gauge how much context you're about to use. Fall back to individual endpoints only when you need more control (e.g. specific author filters, date ranges, or SQL aggregations)
5. **Get full thread context** — whenever a message has `reply_count > 0` or is a thread reply, you need the full conversation to draw conclusions. Two strategies:
   - Add `&include_threads=true` to your `/v1/search` or `/v1/messages` request — the response gains a `threads` array where each entry has `{ thread_ts, channel_id, root, replies }` covering every thread that appeared in results
   - Or call `GET /v1/threads?channel=NAME&thread_ts=TS` directly once you know the specific thread you care about
6. **Page if needed** — use `limit` and `since`/`offset` to avoid truncation on large result sets
7. **Synthesize, don't dump** — summarize findings in plain language; quote only the most relevant message excerpts (channel, author, date, text snippet)
8. **Flag data gaps** — if the relevant channel isn't synced, say so and offer to trigger a sync via `POST /v1/sync`

## Output format

Lead with a direct answer. Then provide supporting evidence as a tight list:
- `#channel` · `@author` · `date` — key quote or summary

If the question can't be answered (data not synced, server down, query too broad), say exactly why and what the user can do to fix it.
