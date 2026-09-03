# slackcrawl

## Language

**Mirror**: the local SQLite copy of the Slack workspace. The product *is* the mirror — Slack is the source of truth, slackcrawl is the searchable, agent-queryable copy.
_Avoid_: "cache", "backup" (implies snapshots rather than continuous sync)

**Tombstone**: a message row marked `deleted_at` after reconciliation proved it no longer exists in Slack. Deleted in Slack ≠ deleted in the mirror — full context is never destroyed.
_Avoid_: "soft delete", "flagged message"

**Watermark** (`last_synced_ts`): the newest message timestamp successfully synced for a channel. Incremental syncs fetch only above it; it advances **only** after the whole channel (history + threads) succeeds, so a failed fetch can never skip data.
_Avoid_: "cursor" (confusable with Slack's pagination cursor), "high-water mark"

**Signal / Noise** (message subtypes): **signal** = real human/bot conversation; **noise** = system events (joins, topic changes, reminders). Noise is stored (nothing is lost) but excluded from search and enrichment paths via `SIGNAL_FILTER`.
_Avoid_: "junk", "system messages" for noise

**Reconciliation**: the periodic full pass that refetches history and thread replies from scratch to catch edits, deletions → tombstones, and anything incremental sync missed.
_Avoid_: "audit", "full sync" (that's a different thing: `--full` IS the reconciliation, but call the concept reconciliation)

**Thread re-poll**: fetching replies for threads with recent activity, from each thread's stored watermark, during incremental sync. Fixes replies arriving on old threads outside the history window.

**Enrichment**: the optional second stage over the mirror — embeddings, thread summaries, decisions, digests, user expertise profiles. Keyed off AI API keys; absent keys must not change core behavior.
_Avoid_: "AI layer"

**Digest**: an AI-generated daily summary of one channel (`channel_digests`), with topic tags.

**Decision**: an extracted action item / conclusion / commitment from a thread summary (`decisions`). "Decision" is both a row and one of four categories.
_Avoid_: "action point"

## Relationships

- A **Workspace** holds many **Channels**; a **Channel** holds many **Messages**
- A **Message** is a **Thread root** (no `thread_ts`, `reply_count > 0`) or a **Reply** (`thread_ts` set to the root's `ts`)
- **Enrichment** products attach to the mirror: **Digests** per (channel, date), **Decisions** per thread, summaries per thread, embeddings per message

## Flagged ambiguities

- "Sync" meant both the incremental poll and the full reconciliation. Resolved: **sync** (incremental) vs **reconciliation** (full pass). `--full` triggers the latter.
- "Deleted" meant both removed-from-Slack and removed-from-mirror. Resolved: **tombstone** for the first; the mirror never does the second.
