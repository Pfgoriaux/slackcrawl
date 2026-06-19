import type { Database } from "bun:sqlite";
import { SlackClient, tsToUnix, messageId, type SlackMessage } from "./slack";
import {
  upsertWorkspace, upsertChannel, upsertUser, upsertMessage,
  updateLastSyncedTs, getChannelByNameOrId, deactivateUnlistedChannels,
  getActiveThreadRoots, getAllThreadRoots, getStoredMessageIds, markMessagesDeleted,
} from "./db";

export interface SyncOptions {
  full?: boolean;       // full reconciliation: refetch all history + replies, detect edits & deletions
  channels?: string[];  // filter to these names/IDs (empty = all bot channels)
  threadRepollDays?: number; // re-poll replies for threads active within N days (incremental)
}

export async function runSync(db: Database, client: SlackClient, opts: SyncOptions = {}) {
  const full = opts.full ?? false;
  console.log(`[sync] starting (${full ? "full reconciliation" : "incremental"})`);

  // 1. Workspace
  const ws = await client.getWorkspaceInfo();
  upsertWorkspace(db, { id: ws.id, name: ws.name, domain: ws.domain });
  console.log(`[sync] workspace: ${ws.name} (${ws.id})`);

  // 2. Users
  await syncUsers(db, client, ws.id);

  // 3. Channels
  const channels = await syncChannels(db, client, ws.id, opts.channels ?? []);
  console.log(`[sync] ${channels.length} channels to sync`);

  // 4. Messages (a few channels concurrently; the SlackClient's global rate limiter
  //    keeps total request rate within Slack's limits regardless of concurrency).
  const repollSince = Math.floor(Date.now() / 1000) - (opts.threadRepollDays ?? 14) * 86400;
  let failed = 0;
  for (const batch of chunk(channels, 4)) {
    const results = await Promise.allSettled(
      batch.map((ch) => syncChannel(db, client, ws.id, ch.id, ch.name ?? ch.id, full, repollSince)),
    );
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === "rejected") {
        failed++;
        console.error(`[sync] channel ${batch[i].name ?? batch[i].id} failed:`, r.reason);
      }
    }
  }

  console.log(`[sync] done${failed ? ` (${failed} channel(s) failed — will retry next cycle)` : ""}`);
}

async function syncUsers(db: Database, client: SlackClient, workspaceId: string) {
  let count = 0;
  for await (const u of client.listUsers()) {
    upsertUser(db, {
      id: u.id,
      workspace_id: workspaceId,
      username: u.name,
      real_name: u.real_name,
      display_name: u.profile.display_name,
      email: u.profile.email,
      title: u.profile.title,
      is_bot: u.is_bot ? 1 : 0,
      is_deleted: u.deleted ? 1 : 0,
      avatar_url: u.profile.image_192 || u.profile.image_72 || null,
    });
    count++;
  }
  console.log(`[sync] ${count} users`);
}

async function syncChannels(
  db: Database,
  client: SlackClient,
  workspaceId: string,
  filterNames: string[],
) {
  // Normalise filter set (remove # prefix, lowercase for matching).
  const filterSet = new Set(filterNames.map((c) => c.replace(/^#/, "").toLowerCase()));

  const all = [];
  for await (const ch of client.listChannels()) {
    const passes = filterSet.size === 0
      || filterSet.has(ch.id.toLowerCase())
      || filterSet.has(ch.name?.toLowerCase());

    if (!passes) continue; // not in the active filter

    // Only channels the bot is actually a member of have readable history.
    if (!ch.is_member) {
      if (filterSet.size > 0) {
        console.warn(`[sync] #${ch.name ?? ch.id} is in the filter but the bot is not a member — invite it to archive it`);
      }
      continue;
    }

    upsertChannel(db, {
      id: ch.id,
      workspace_id: workspaceId,
      name: ch.name,
      is_private: ch.is_private ? 1 : 0,
      is_archived: ch.is_archived ? 1 : 0,
      topic: ch.topic?.value || null,
      purpose: ch.purpose?.value || null,
      member_count: ch.num_members,
      created_at: ch.created,
      last_synced_ts: null,
    });

    all.push(ch);
  }

  if (filterSet.size > 0 && all.length === 0) {
    console.warn("[sync] warning: no channels matched SLACKCRAWL_CHANNELS — check names/IDs and bot membership");
  }

  // Channels that left the active filter are deactivated, NOT deleted — their history is kept.
  if (filterSet.size > 0 && all.length > 0) {
    const deactivated = deactivateUnlistedChannels(db, workspaceId, all.map((c) => c.id));
    if (deactivated.length) {
      console.log(`[sync] ${deactivated.length} channel(s) no longer in filter — kept archived (history preserved): ${deactivated.join(", ")}`);
    }
  }

  return all;
}

async function syncChannel(
  db: Database,
  client: SlackClient,
  workspaceId: string,
  channelId: string,
  channelName: string,
  full: boolean,
  repollSince: number,
) {
  const existing = getChannelByNameOrId(db, workspaceId, channelId);
  // Incremental: only fetch top-level messages newer than what we already have.
  const oldest = full ? undefined : (existing?.last_synced_ts ?? undefined);

  console.log(`[sync] #${channelName} (${channelId})${full ? " [full]" : oldest ? ` since ${oldest}` : " [first sync]"}`);

  let msgCount = 0;
  let newestSeen: string | undefined;
  const newThreadRoots = new Set<string>();
  const seenTs = full ? new Set<string>() : null; // deletion detection only in full mode

  for await (const msg of client.iterHistory(channelId, { oldest })) {
    upsertMsg(db, workspaceId, channelId, msg);
    msgCount++;
    seenTs?.add(msg.ts);

    if (!msg.thread_ts && msg.reply_count && msg.reply_count > 0) newThreadRoots.add(msg.ts);
    if (!newestSeen || msg.ts > newestSeen) newestSeen = msg.ts;
  }

  // Determine which threads to (re-)poll for replies.
  //  - full: every known thread root, fetched in full (oldest undefined)
  //  - incremental: threads with recent activity + any new roots, fetched from their
  //    stored watermark so we only pull genuinely new replies. This is the fix for
  //    replies arriving on threads whose root is outside the incremental window.
  const repoll = new Map<string, string | undefined>(); // thread_ts -> oldest
  const roots = full ? getAllThreadRoots(db, channelId) : getActiveThreadRoots(db, channelId, repollSince);
  for (const r of roots) {
    repoll.set(r.thread_ts, full ? undefined : (r.stored_max_reply_ts ?? r.thread_ts));
  }
  for (const ts of newThreadRoots) {
    if (!repoll.has(ts)) repoll.set(ts, full ? undefined : ts);
  }

  let replyCount = 0;
  for (const [threadTs, replyOldest] of repoll) {
    try {
      const replies = await client.getReplies(channelId, threadTs, { oldest: replyOldest });
      for (const msg of replies) {
        upsertMsg(db, workspaceId, channelId, msg);
        seenTs?.add(msg.ts);
        replyCount++;
      }
    } catch (err) {
      // A thread that fails to fetch must NOT advance the watermark past it, or we'd
      // never retry. Throw so the channel is marked failed and retried next cycle.
      throw new Error(`thread ${threadTs} in #${channelName}: ${err}`);
    }
  }

  // Deletion detection: anything stored but not seen in a full pass is gone from Slack.
  if (full && seenTs) {
    const stored = getStoredMessageIds(db, channelId);
    const missing = stored.filter((id) => {
      const ts = id.slice(id.lastIndexOf(":") + 1);
      return !seenTs.has(ts);
    });
    if (missing.length) {
      markMessagesDeleted(db, missing);
      console.log(`[sync] #${channelName}: ${missing.length} message(s) tombstoned (deleted in Slack)`);
    }
  }

  // Advance the watermark only after the whole channel (history + threads) succeeded.
  if (newestSeen) updateLastSyncedTs(db, channelId, newestSeen);
  console.log(`[sync] #${channelName}: ${msgCount} top-level, ${replyCount} replies`);
}

function upsertMsg(db: Database, workspaceId: string, channelId: string, msg: SlackMessage) {
  if (!msg.ts) return;
  upsertMessage(db, {
    id: messageId(workspaceId, channelId, msg.ts),
    workspace_id: workspaceId,
    channel_id: channelId,
    ts: msg.ts,
    thread_ts: msg.thread_ts ?? null,
    subtype: msg.subtype ?? null,
    user_id: msg.user ?? null,
    username: msg.username ?? null,
    text: msg.text ?? null,
    has_attachments: msg.attachments?.length ? 1 : 0,
    has_files: msg.files?.length ? 1 : 0,
    reactions: msg.reactions ? JSON.stringify(msg.reactions) : null,
    reply_count: msg.reply_count ?? 0,
    reply_users: msg.reply_users ? JSON.stringify(msg.reply_users) : null,
    edited_ts: msg.edited?.ts ?? null,
    created_at: tsToUnix(msg.ts),
    deleted_at: null,
    raw_json: JSON.stringify(msg),
  });
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
