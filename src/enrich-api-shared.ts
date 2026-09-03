// Shared plumbing for the enrichment API handlers: the deps type and the
// LRU cache for query embeddings (used by both /v1/context and /v1/search).

import type { Database } from "bun:sqlite";
import type { EmbeddingClient } from "./ai";
import type { VecIndex } from "./vec";

export interface EnrichApiDeps {
  db: Database;
  workspaceId: string;
  vecIndex: VecIndex | null;
  embedder: EmbeddingClient | null;
  maxLimit: number;
}

// LRU cache for query embeddings
const embedCache = new Map<string, { embedding: Float32Array; ts: number }>();
const CACHE_MAX = 100;
const CACHE_TTL = 10 * 60 * 1000; // 10 min

export async function getQueryEmbedding(
  embedder: EmbeddingClient,
  text: string,
): Promise<Float32Array> {
  const cached = embedCache.get(text);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.embedding;

  const embedding = await embedder.embedOne(text);

  // Evict oldest if at capacity
  if (embedCache.size >= CACHE_MAX) {
    let oldest = "";
    let oldestTs = Infinity;
    for (const [k, v] of embedCache) {
      if (v.ts < oldestTs) {
        oldest = k;
        oldestTs = v.ts;
      }
    }
    if (oldest) embedCache.delete(oldest);
  }

  embedCache.set(text, { embedding, ts: Date.now() });
  return embedding;
}
