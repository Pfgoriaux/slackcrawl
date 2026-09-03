// Barrel: everything the rest of the code imports from "./enrich-db".
// Split to respect the conventions.json file-size bound.

export type { Decision } from "./enrich-db-decisions";
export {
  deleteDecisionsByThread,
  getDecisionsByThread,
  insertDecision,
  queryDecisions,
} from "./enrich-db-decisions";
export type { ChannelDigest } from "./enrich-db-digests";
export { getChannelDigests, getUndigestedDates, upsertChannelDigest } from "./enrich-db-digests";
export { getAllEmbeddings, getUnembeddedMessages, upsertEmbedding } from "./enrich-db-embeddings";
export type { UserProfile } from "./enrich-db-profiles";
export {
  getUserProfile,
  getUsersNeedingProfiles,
  searchExpertise,
  upsertUserProfile,
} from "./enrich-db-profiles";
export { initEnrichmentSchema, markEnriched } from "./enrich-db-schema";
export { getEnrichmentStats } from "./enrich-db-stats";
export type { ThreadSummary } from "./enrich-db-summaries";
export {
  getThreadSummaries,
  getThreadSummary,
  getUnsummarizedThreads,
  upsertThreadSummary,
} from "./enrich-db-summaries";
