# slackcrawl

Mirrors Slack channels into SQLite and exposes a REST API for AI agents:
search, thread summaries, decisions, daily digests, semantic search. Open
source (MIT), self-hosted: one binary, one file database, zero runtime
dependencies — Slack, Anthropic and OpenAI are called with plain `fetch`.
Runs on Bun.

Completeness is the product: everything in this repo defends the promise
that the mirror never silently loses or drops data.

## Commands

- `bun install`
- `bun run start` — serve (`src/index.ts serve`)
- `bun run dev` — watch mode
- `bun test` — unit tests (no network, no Slack token needed)
- `bun run lint` / `bun run fix` — biome check / auto-fix
- `bun run typecheck` / `bun run build` — compile a standalone binary
- `./install.sh` — host-side install (Dockerfile provided for Coolify)

## Architecture

- `src/` — everything. `db-*` / `enrich-db-*` are split modules behind
  barrel re-exports: import from `./db` and `./enrich-db`, not the splits
- Sync completeness: read the "How sync stays complete" section of
  `README.md` before touching the sync loop — the watermark and
  tombstone logic carries ADR-1's guarantees
- AI enrichment (embeddings, summaries, digests) is optional and keyed
  off API keys — without keys, behavior must not change

Context layer:

- Domain language: see `CONTEXT.md` — read before naming anything.
- Decisions: see `docs/adr/` — never re-litigate a decided ADR,
  supersede it instead. Watermarks/tombstones and plain-fetch/SQLite
  are decided (ADR-1, ADR-2).
- Structural rules (file sizes, naming): see `conventions.json`.

## Conventions

- SQLite is the only store; FTS5 for search, embeddings stored beside it
- Plain `fetch` always — no Slack/OpenAI/Anthropic SDK dependency
- Env vars documented in README + `.env.example`; secrets stay in
  `.env`, never committed
- Commits: conventional prefixes (`feat:`, `fix:`, `chore:`, `docs:`)
