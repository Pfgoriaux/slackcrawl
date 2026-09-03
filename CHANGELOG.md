# Changelog

All notable changes to slackcrawl. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versioning is
[semver](https://semver.org/).

## [Unreleased]

### Fixed
- `/v1/search` (semantic/hybrid) and `/v1/context` no longer return
  tombstoned (deleted-in-Slack) messages via the semantic path, and now
  respect the `channel` filter there.
- `SLACKCRAWL_SYNC_INTERVAL=0` (continuous re-sync) is now rejected at
  config load instead of hammering the Slack API.

### Added
- Test suite (`bun test`) and CI (typecheck + lint + test + build on
  push/PR).
- `CONTEXT.md` domain glossary and ADRs in `docs/adr/`.

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
