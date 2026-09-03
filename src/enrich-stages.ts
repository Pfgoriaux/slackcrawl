// Enrichment stages 4-5: channel digests and user profiles.
// Split out of enrich.ts to respect the file-size convention.

import type { Database } from "bun:sqlite";
import type { ClaudeClient } from "./ai";
import type { Config } from "./config";
import { getChannels, queryMessages } from "./db";
import {
  getThreadSummaries,
  getUndigestedDates,
  getUsersNeedingProfiles,
  markEnriched,
  upsertChannelDigest,
  upsertUserProfile,
} from "./enrich-db";
import { parseJSON, splitTopics } from "./enrich-helpers";

// ---- Stage 4: Channel Digests ----

export async function enrichChannelDigests(
  db: Database,
  cfg: Config,
  claude: ClaudeClient,
): Promise<number> {
  const undigested = getUndigestedDates(db, cfg.enrichMaxPerCycle);
  if (undigested.length === 0) return 0;

  console.log(`[enrich] ${undigested.length} channel-dates to digest`);
  let count = 0;

  for (const { channel_id, date, msg_count } of undigested) {
    try {
      const dayStart = Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000);
      const dayEnd = dayStart + 86400;

      const messages = queryMessages(db, {
        channelId: channel_id,
        since: dayStart,
        until: dayEnd,
        limit: 200,
      });

      if (messages.length < 3) continue;

      // Gather any existing thread summaries for context
      const summaries = getThreadSummaries(db, channel_id, dayStart);
      const summaryContext =
        summaries.length > 0
          ? `\n\nThread summaries from this day:\n${summaries.map((s) => `- ${s.summary}`).join("\n")}`
          : "";

      const msgText = messages
        .map((m) => `[${m.username ?? "unknown"}] ${m.text ?? ""}`)
        .join("\n");

      const participants = new Set(messages.map((m) => m.username).filter(Boolean));
      const threadCount = new Set(messages.filter((m) => m.thread_ts).map((m) => m.thread_ts)).size;

      const { text, inputTokens, outputTokens } = await claude.complete(
        `Channel messages for ${date}:\n${msgText}${summaryContext}`,
        `You are creating a daily digest for a Slack channel. Summarize the day's activity in markdown format.
Include:
- Key topics discussed
- Important decisions or conclusions
- Notable threads

Return the summary in markdown (2-4 paragraphs). Also extract 3-8 key topic tags.
Format: first the markdown summary, then on a new line "TOPICS:" followed by comma-separated tags.`,
      );

      const [summary, topicLine] = splitTopics(text.trim());
      const keyTopics = topicLine
        ? topicLine
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : [];

      upsertChannelDigest(db, {
        channel_id,
        date,
        summary,
        key_topics: JSON.stringify(keyTopics),
        message_count: msg_count,
        thread_count: threadCount,
        participant_count: participants.size,
      });
      markEnriched(
        db,
        "digest",
        `${channel_id}:${date}`,
        cfg.claudeModel,
        inputTokens + outputTokens,
      );
      count++;
    } catch (err) {
      console.error(`[enrich] digest failed (${channel_id}:${date}):`, err);
    }
  }

  return count;
}

// ---- Stage 5: User Profiles ----

export async function enrichUserProfiles(
  db: Database,
  cfg: Config,
  claude: ClaudeClient,
): Promise<number> {
  const users = getUsersNeedingProfiles(db, cfg.enrichMaxPerCycle);
  if (users.length === 0) return 0;

  // Channel lookup is loop-invariant: fetch once, index by id.
  // (Previously this did a full getChannels() scan per user, plus O(channels)
  // .find() lookups per message.)
  const channelNameById = new Map(getChannels(db).map((c) => [c.id, c.name]));

  console.log(`[enrich] ${users.length} user profiles to generate`);
  let count = 0;

  for (const user of users) {
    try {
      // Get recent messages for this user
      const messages = queryMessages(db, {
        username: user.username,
        limit: 100,
      });

      if (messages.length < 5) continue;

      // Get channels they're active in
      const channelIds = [...new Set(messages.map((m) => m.channel_id))];
      const channelNames = channelIds.map((id) => channelNameById.get(id)).filter(Boolean);

      const msgSample = messages
        .slice(0, 50)
        .map((m) => `[#${channelNameById.get(m.channel_id) ?? m.channel_id}] ${m.text ?? ""}`)
        .join("\n");

      const { text, inputTokens, outputTokens } = await claude.complete(
        `User: ${user.username}\nActive channels: ${channelNames.join(", ")}\n\nRecent messages:\n${msgSample}`,
        `Analyze this Slack user's messages and create an expertise profile.
Return JSON with:
- "expertise": array of {topic: string, confidence: number (0-1), channels: string[]}
- "summary": 1-2 sentence description of their role/expertise

Return ONLY valid JSON, no markdown fences. Max 10 expertise items.`,
      );

      const profile = parseJSON<{ expertise: unknown[]; summary: string }>(text.trim(), {
        expertise: [],
        summary: "",
      });

      upsertUserProfile(db, {
        user_id: user.user_id,
        expertise: JSON.stringify(profile.expertise),
        summary: profile.summary || null,
      });
      markEnriched(db, "user_profile", user.user_id, cfg.claudeModel, inputTokens + outputTokens);
      count++;
    } catch (err) {
      console.error(`[enrich] user profile failed (${user.user_id}):`, err);
    }
  }

  return count;
}
