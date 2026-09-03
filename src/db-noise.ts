export const NOISE_SUBTYPES = [
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "channel_archive",
  "channel_unarchive",
  "group_join",
  "group_leave",
  "group_topic",
  "group_purpose",
  "group_name",
  "group_archive",
  "group_unarchive",
  "bot_add",
  "bot_remove",
  "pinned_item",
  "unpinned_item",
  "reminder_add",
];
const NOISE_LIST = NOISE_SUBTYPES.map((s) => `'${s}'`).join(", ");
/** SQL fragment (prefix the column with table alias `m`) keeping only real, live messages. */
export const SIGNAL_FILTER = `m.deleted_at IS NULL AND (m.subtype IS NULL OR m.subtype NOT IN (${NOISE_LIST}))`;
