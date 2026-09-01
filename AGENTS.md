# slackcrawl

Mirrors Slack channels into SQLite and exposes a REST API for AI agents:
search, thread summaries, decisions, daily digests, semantic search. Open
source (MIT). No SDKs — Slack, Claude and OpenAI are called with plain
`fetch`. Runs on Bun.

## Commands

- `bun install`
- `bun run start` — serve (`src/index.ts serve`)
- `bun run dev` — watch mode
- `bun run typecheck` / `bun run build` — compile a standalone binary
- `./install.sh` — host-side install (Dockerfile provided for Coolify)

## Architecture

- `src/` — everything: Slack sync, SQLite store + FTS5, REST API
- `skill/` — the agent-facing skill doc for this API
- Sync completeness is the product: incremental polls + thread re-polls +
  a reconciliation pass (edits, deletions as tombstones). Read the
  "How sync stays complete" section of `README.md` before touching the
  sync loop.
- AI enrichment (embeddings, summaries, digests) is optional and keyed
  off API keys — without keys, behavior must not change.

## Conventions

- SQLite is the only store; FTS5 for search, embeddings stored beside it
- Plain `fetch` always — no Slack/OpenAI/Anthropic SDK dependency
- Env vars (Slack token first) documented in README; secrets stay in
  `.env`, never committed
- Structural conventions (file-size bounds): see `conventions.json`
