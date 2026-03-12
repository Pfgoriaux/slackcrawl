import type { Database } from "bun:sqlite";
import { SlackClient, tsToUnix, messageId, type SlackMessage } from "./slack";
import {
  upsertWorkspace, upsertChannel, upsertUser, upsertMessage,
  updateLastSyncedTs, getChannelByNameOrId, getChannels, pruneChannels,
} from "./db";

export interface SyncOptions {
  full?: boolean;       // ignore incremental cursor, fetch all history
  channels?: string[];  // filter to these names/IDs (empty = all bot channels)
}

export async function runSync(db: Database, client: SlackClient, opts: SyncOptions = {}) {
  console.log(`[sync] starting (full=${opts.full ?? false})`);

  // 1. Workspace
  const ws = await client.getWorkspaceInfo();
  upsertWorkspace(db, { id: ws.id, name: ws.name, domain: ws.domain });
  console.log(`[sync] workspace: ${ws.name} (${ws.id})`);

  // 2. Users
  await syncUsers(db, client, ws.id);

  // 3. Channels
  const channels = await syncChannels(db, client, ws.id, opts.channels ?? []);
  console.log(`[sync] ${channels.length} channels to sync`);

  // 4. Messages (batches of 4 channels at a time)
  for (const batch of chunk(channels, 4)) {
    await Promise.all(
      batch.map((ch) => syncChannel(db, client, ws.id, ch.id, ch.name ?? ch.id, opts.full ?? false)),
    );
  }

  console.log("[sync] done");
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

    if (!passes) continue; // skip entirely — don't store in DB

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
    console.warn("[sync] warning: no channels matched SLACKCRAWL_CHANNELS — check names/IDs");
  }

  // Remove any channels (and their messages) that are no longer in the filter.
  if (filterSet.size > 0 && all.length > 0) {
    pruneChannels(db, workspaceId, all.map((c) => c.id));
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
) {
  const existing = getChannelByNameOrId(db, workspaceId, channelId);
  // For incremental sync, use the newest message we've seen as the starting point
  // so we only fetch messages newer than what we already have.
  const oldest = full ? undefined : (existing?.last_synced_ts ?? undefined);

  console.log(`[sync] #${channelName} (${channelId})${oldest ? ` since ${oldest}` : " full"}`);

  let msgCount = 0;
  let cursor = "";
  let newestSeen: string | undefined;
  const threadSet = new Set<string>();

  do {
    const page = await client.getHistory(channelId, { oldest, cursor, limit: 200 });

    for (const msg of page.messages) {
      upsertMsg(db, workspaceId, channelId, msg);
      msgCount++;

      if (msg.reply_count && msg.reply_count > 0) threadSet.add(msg.ts);

      if (!newestSeen || msg.ts > newestSeen) newestSeen = msg.ts;
    }

    cursor = page.has_more ? page.next_cursor : "";
    if (cursor) await sleep(1200); // Tier 3: 50 req/min
  } while (cursor);

  // Sync threads
  for (const threadTs of threadSet) {
    try {
      const replies = await client.getReplies(channelId, threadTs);
      for (const msg of replies) upsertMsg(db, workspaceId, channelId, msg);
      await sleep(1200);
    } catch (err) {
      console.warn(`[sync] thread ${threadTs} in ${channelId}: ${err}`);
    }
  }

  if (newestSeen) updateLastSyncedTs(db, channelId, newestSeen);
  console.log(`[sync] #${channelName}: ${msgCount} messages`);
}

function upsertMsg(db: Database, workspaceId: string, channelId: string, msg: SlackMessage) {
  if (!msg.ts) return;
  upsertMessage(db, {
    id: messageId(workspaceId, channelId, msg.ts),
    workspace_id: workspaceId,
    channel_id: channelId,
    ts: msg.ts,
    thread_ts: msg.thread_ts ?? null,
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
    raw_json: JSON.stringify(msg),
  });
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
