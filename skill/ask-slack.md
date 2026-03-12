Answer this question using the slackcrawl archive: $ARGUMENTS

## What you have access to

slackcrawl mirrors Slack into a local SQLite database and exposes a REST API. You can reach the data two ways:

**1. REST API** (preferred when the server is running)
Base URL: `http://localhost:${PORT:-8080}`
Auth header: `Authorization: Bearer $SLACKCRAWL_API_KEY`

| Endpoint | Use when |
|---|---|
| `GET /health` | Check if server is up (no auth needed) |
| `GET /v1/status` | Data freshness, message/channel counts, last sync time |
| `GET /v1/search?q=TERM&channel=NAME&author=USER&since=YYYY-MM-DD&limit=50&include_threads=true` | Searching message content (FTS5); add `include_threads=true` to expand full thread context for any matching message |
| `GET /v1/messages?channel=NAME&days=7&author=USER&hours=N&limit=100&include_threads=true` | Recent messages with filters; add `include_threads=true` to include full thread replies inline |
| `GET /v1/threads?channel=NAME&thread_ts=TS` | Fetch a single complete thread (root + all replies) by its root timestamp |
| `GET /v1/channels` | List all synced channels and their metadata |
| `GET /v1/members?query=NAME` | Look up a specific person |
| `GET /v1/sql?q=SELECT+...` | Complex aggregations — counts, top contributors, trends |
| `POST /v1/sync` body `{"channel":"NAME"}` | Trigger a fresh sync if data looks stale |

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

1. **Start with `/health`** — if unreachable, fall back to SQLite directly
2. **Always fetch `/v1/channels` first** — you need the channel list to:
   - Resolve a channel name the user mentioned (e.g. "in #infra") to the exact `name` or `id` to pass as `?channel=`
   - Check whether the relevant channel is synced at all before searching
   - Spot channels the user might not have named but that are clearly relevant (e.g. `#deployments`, `#incidents` for a question about outages)
   - The API accepts either channel `name` or channel `id` interchangeably in the `?channel=` param
3. **Match the tool to the question:**
   - "what happened with X?" → try multiple synonyms: `?q=X`, then `?q=synonym1`, `?q=synonym2` — FTS5 is keyword-only, not semantic
   - "what did @alice post?" → `/v1/messages?author=alice&days=30`
   - "which channels are most active?" → `/v1/sql?q=SELECT channel_id, count(*) FROM messages GROUP BY channel_id ORDER BY 2 DESC LIMIT 10`
   - "is the sync up to date?" → `/v1/status`
   - "who works on Y?" → `/v1/search?q=Y` + `/v1/members?query=...`
   - broad temporal question ("last week") → raise `limit` to 200, then summarize in passes
4. **Get full thread context** — whenever a message has `reply_count > 0` or is a thread reply, you need the full conversation to draw conclusions. Two strategies:
   - Add `&include_threads=true` to your `/v1/search` or `/v1/messages` request — the response gains a `threads` array where each entry has `{ thread_ts, channel_id, root, replies }` covering every thread that appeared in results
   - Or call `GET /v1/threads?channel=NAME&thread_ts=TS` directly once you know the specific thread you care about
5. **Page if needed** — use `limit` and `since`/`offset` to avoid truncation on large result sets
6. **Synthesize, don't dump** — summarize findings in plain language; quote only the most relevant message excerpts (channel, author, date, text snippet)
7. **Flag data gaps** — if the relevant channel isn't synced, say so and offer to trigger a sync via `POST /v1/sync`

## Output format

Lead with a direct answer. Then provide supporting evidence as a tight list:
- `#channel` · `@author` · `date` — key quote or summary

If the question can't be answered (data not synced, server down, query too broad), say exactly why and what the user can do to fix it.
