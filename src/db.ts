// Barrel: everything the rest of the code imports from "./db".
// Split into db-schema / db-types / db-write / db-query to respect the
// conventions.json file-size bound; imports keep pointing here.

export { NOISE_SUBTYPES, SIGNAL_FILTER } from "./db-noise";
export type { MessageFilter, ThreadContext, ThreadRoot } from "./db-query";
export {
  expandThreads,
  getActiveThreadRoots,
  getAllThreadRoots,
  getChannelByNameOrId,
  getChannels,
  getStats,
  getStoredMessageIds,
  getThread,
  getThreadMessageIds,
  getUsers,
  getWorkspace,
  queryMessages,
  searchMessages,
} from "./db-query";
export type { DB } from "./db-schema";
export { openDB } from "./db-schema";
export type { Channel, Message, User, Workspace } from "./db-types";
export {
  deactivateUnlistedChannels,
  markMessagesDeleted,
  updateLastSyncedTs,
  upsertChannel,
  upsertMessage,
  upsertUser,
  upsertWorkspace,
} from "./db-write";
