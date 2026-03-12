// In-memory brute-force cosine similarity vector search.
// Pre-normalizes at load time so cosine similarity = dot product.

import type { Database } from "bun:sqlite";
import { getAllEmbeddings } from "./enrich-db";

export class VecIndex {
  private ids: string[] = [];
  private dims = 0;
  private vectors: Float32Array = new Float32Array(0); // contiguous: [vec0...vec1...vecN]

  get size() { return this.ids.length; }

  /** Load all embeddings from DB and build in-memory index. */
  load(db: Database) {
    const rows = getAllEmbeddings(db);
    if (rows.length === 0) {
      this.ids = [];
      this.vectors = new Float32Array(0);
      this.dims = 0;
      return;
    }

    // Detect dimension from first row
    this.dims = rows[0].embedding.byteLength / 4; // Float32 = 4 bytes
    this.ids = new Array(rows.length);
    this.vectors = new Float32Array(rows.length * this.dims);

    for (let i = 0; i < rows.length; i++) {
      this.ids[i] = rows[i].message_id;
      const vec = new Float32Array(
        rows[i].embedding.buffer,
        rows[i].embedding.byteOffset,
        this.dims,
      );
      // Copy into contiguous array
      this.vectors.set(vec, i * this.dims);
    }

    // Pre-normalize all vectors
    for (let i = 0; i < rows.length; i++) {
      this.normalizeInPlace(i);
    }

    console.log(`[vec] loaded ${rows.length} vectors (${this.dims}d)`);
  }

  /** Search for the top-k most similar vectors to a query. Query must be a Float32Array. */
  search(query: Float32Array, limit = 10): { messageId: string; score: number }[] {
    if (this.ids.length === 0 || this.dims === 0) return [];

    // Normalize query
    const q = new Float32Array(query);
    let norm = 0;
    for (let i = 0; i < this.dims; i++) norm += q[i] * q[i];
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < this.dims; i++) q[i] /= norm;
    }

    // Brute-force dot products (vectors are pre-normalized, so dot = cosine)
    const scores: { idx: number; score: number }[] = [];
    for (let i = 0; i < this.ids.length; i++) {
      let dot = 0;
      const offset = i * this.dims;
      for (let d = 0; d < this.dims; d++) {
        dot += q[d] * this.vectors[offset + d];
      }
      scores.push({ idx: i, score: dot });
    }

    // Partial sort: find top-k
    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, limit).map((s) => ({
      messageId: this.ids[s.idx],
      score: s.score,
    }));
  }

  private normalizeInPlace(i: number) {
    const offset = i * this.dims;
    let norm = 0;
    for (let d = 0; d < this.dims; d++) {
      norm += this.vectors[offset + d] * this.vectors[offset + d];
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let d = 0; d < this.dims; d++) {
        this.vectors[offset + d] /= norm;
      }
    }
  }
}
