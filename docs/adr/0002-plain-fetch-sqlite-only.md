# ADR 2 — Plain fetch over SDKs; SQLite as the only store

- Status: accepted (retrospective)
- Date: 2026-09-01
- Deciders: pf
- Builds on: [ADR 1](0001-polling-watermarks-tombstones.md)

## Context

slackcrawl targets self-hosting (Docker image, single standalone
binary) and an agent-facing REST API. The data is a single workspace's
message archive — millions of rows at most, queried by one process.
Alternatives: Postgres-backed (shared/remote store, ops burden, no
FTS5 out of the box), or Slack/OpenAI/Anthropic SDKs for typed clients
(node_modules weight, version churn, opaque retries).

## Decision

We ship zero runtime dependencies: Slack, Anthropic and OpenAI are
called with plain `fetch` (with our own rate limiting and 429 retry),
and the only store is embedded SQLite (WAL mode, FTS5 for search,
Float32 BLOBs for embeddings, in-process `VecIndex` for semantic search).
The whole thing compiles to a single binary via `bun build --compile`.

## Consequences

- Install is one binary + one env var; the "database" is a file in
  `DATA_DIR`, backed up by copying. No state to manage, no migrations
  server, perfect fit for the Docker/Coolify deployment model.
- FTS5 gives quality full-text search with triggers keeping the index
  in sync — no separate search infrastructure.
- Concurrency is single-process: Bun's synchronous SQLite is not a
  multi-node datastore. Scaling out (multi-workspace, external readers)
  would require moving to Postgres + a real vector index (see the
  `vec.ts` scale note about sqlite-vec) — a breaking change we accept
  not making now.
- Plain fetch means hand-rolled pagination/retry (done once, shared by
  all three providers) instead of SDK niceties. Acceptable: the API
  surface we consume is small and stable.
