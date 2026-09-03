# Changelog

All notable changes to slackcrawl. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versioning is
[semver](https://semver.org/).

## [0.2.0] — 2026-09-03

### Fixed
- **Full reconciliation no longer wedges on deleted threads**: when Slack
  reports `thread_not_found`, the thread is tombstoned and the channel's
  reconcile completes, instead of failing the channel on every cycle
  forever (the dead root could never be auto-tombstoned because the throw
  happened before deletion detection ran). Full reconcile also skips
  already-tombstoned thread roots.
- `/v1/search` (semantic/hybrid) and `/v1/context` no longer return
  tombstoned (deleted-in-Slack) messages via the semantic path, and now
  respect the `channel` filter there.
- A thread re-summary (new replies) now triggers decision re-extraction —
  replacing the old rows instead of silently contradicting the current
  summary forever.
- FTS query-syntax errors vs real DB errors are now distinguished:`
  `/v1/search`, `/v1/decisions`, `/v1/expertise` return 400 only for
  actual FTS syntax problems; genuine failures surface as 500 (and are
  logged, not swallowed) in `/v1/context`.
- `/v1/expertise` tolerates a corrupt `expertise` JSON blob instead of
  returning a 500.
- `enrichUserProfiles` no longer re-queries the full channel list for
  every user (loop-invariant lookup, hoisted and indexed).
- `SLACKCRAWL_SYNC_INTERVAL=0` (continuous re-sync) is now rejected at
  config load instead of hammering the Slack API.
- Docker healthcheck respects a custom `PORT`.
- Docker build uses a strict `--frozen-lockfile` install (no silent
  fallback to unfrozen dependency resolution).

### Added
- Explicit timeouts on all outbound HTTP (Slack 30s, Claude 120s, OpenAI
  60s) — a hung connection can no longer stall the sync loop while
  `/health` stays green.
- Retries with exponential backoff for HTTP 5xx, network errors, and
  timeouts on all three API clients (429 handling honors `Retry-After`
  as before).
- Tests for the sync loop (deleted-thread tombstoning, watermark
  protection, tombstone resurrection) and the REST layer (auth matrix,
  public endpoints, 400-vs-500 behavior) — 31 tests total.
- `CONTEXT.md` domain glossary and ADRs in `docs/adr/`.
- The bundled Claude/pi skill is now a proper `skill/ask-slack/SKILL.md`
  with frontmatter.

### Security
- No CORS by default: responses carry no `Access-Control-Allow-Origin`
  unless `SLACKCRAWL_CORS_ORIGIN` is set (previously defaulted to `*`).
  README gains a security section covering DB-file sensitivity
  (`raw_json`, user emails), auth posture, and the AI-enrichment
  prompt-injection trust boundary.

### Changed
- Lint (biome) fully green; source split into smaller modules to respect
  the 400-line file-size convention (`db-*`, `enrich-db-*`,
  `enrich-api-*`, `enrich-stages`). The `./db` and `./enrich-db` import
  surfaces are unchanged (barrel re-exports).

## [0.1.0] — 2026-08-26

Initial release: Slack sync (incremental + full reconciliation with
tombstones), SQLite + FTS5 store, REST API with Bearer auth, optional
AI enrichment (thread summaries, decisions, digests, embeddings,
expertise profiles), semantic/hybrid search, Docker image, standalone
binaries.
