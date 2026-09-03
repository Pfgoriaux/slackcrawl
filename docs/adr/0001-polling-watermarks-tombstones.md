# ADR 1 — Sync by polling with watermarks and tombstones; never delete mirror data

- Status: accepted (retrospective)
- Date: 2026-09-01
- Deciders: pf
- Builds on: —

## Context

The core product promise is a complete, queryable mirror of a Slack
workspace. Two architectures were on the table: subscribe to the Events
API (real-time, but only sees messages from the moment of installation,
and requires a public HTTPS endpoint) or poll the Web API periodically.

Slack's May 29, 2025 rate-limit change made polling economics genuinely
worse for commercially distributed non-Marketplace apps (~1 req/min,
15 msgs/page on `conversations.history`/`.replies`), while internal
customer-built apps keep Tier 3 (~50/min). A completed archive also has
to survive its own failure modes: partial syncs, crashed cycles,
channels removed from the sync filter, and messages deleted in Slack.

## Decision

We poll: incremental fetches bounded by a per-channel watermark
(`last_synced_ts`), plus thread re-polling from per-thread watermarks,
plus a periodic full reconciliation pass. The watermark advances only
after the entire channel (history + all thread replies) syncs without
error, so a failure can never advance past data we haven't seen. Messages
that vanish from Slack become tombstones (`deleted_at` set) instead of
being deleted; channels that leave `SLACKCRAWL_CHANNELS` are archived,
history intact. Slack's global rate limiter is honored (fixed spacing +
429/Retry-After backoff that pushes the shared slot cursor out for
concurrent workers, configurable via `SLACKCRAWL_SLACK_MIN_INTERVAL_MS`).

## Consequences

- The archive is complete and self-healing; any single missed run is
  corrected by the next cycle or by reconciliation. Nothing user-visible
  is ever destroyed, which is the whole point.
- Backfilling history (pre-installation messages) works for free — the
  Events API can never give us the past.
- Polling latency is bounded by `SLACKCRAWL_SYNC_INTERVAL` (default 10m),
  not real-time. Acceptable: this is a mirror of record, not a live feed.
- On the restricted tier (new non-Marketplace commercial apps), backfill
  is impractically slow at 15 messages/minute. Internal apps (our target)
  are unaffected; we document the tuning knobs.
- Tombstones trade disk and query hygiene (every query filters
  `deleted_at IS NULL`) for guaranteed no data loss.
