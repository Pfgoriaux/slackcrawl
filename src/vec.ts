// In-memory brute-force cosine similarity vector search.
// Pre-normalizes at load time so cosine similarity = dot product, and selects top-k
// with a bounded insertion buffer (no full O(N log N) sort).
//
// Scaling note: this holds every embedding in RAM (~6 KB per message at 1536 dims).
// That's fine into the low hundreds of thousands of messages. Past ~200–300K, or if
// the process memory matters, move embeddings into `sqlite-vec` (a SQLite extension)
// so search runs inside the DB alongside FTS instead of in a JS heap copy. The storage
// format here (Float32 BLOB per message) maps directly onto sqlite-vec's vec0 tables.

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

    // Brute-force dot products (vectors are pre-normalized, so dot = cosine).
    // Maintain a bounded top-k via insertion into a small sorted buffer instead of
    // sorting all N scores — O(N·k) beats O(N·log N) materialization at scale and
    // allocates only k entries, not N.
    const n = this.ids.length;
    const k = Math.min(limit, n);
    const topIdx = new Int32Array(k);
    const topScore = new Float64Array(k);
    let filled = 0;
    let minScore = -Infinity; // smallest score currently in the buffer

    for (let i = 0; i < n; i++) {
      let dot = 0;
      const offset = i * this.dims;
      for (let d = 0; d < this.dims; d++) {
        dot += q[d] * this.vectors[offset + d];
      }
      if (filled < k) {
        // Insert in sorted (descending) position.
        let j = filled - 1;
        while (j >= 0 && topScore[j] < dot) { topScore[j + 1] = topScore[j]; topIdx[j + 1] = topIdx[j]; j--; }
        topScore[j + 1] = dot; topIdx[j + 1] = i;
        filled++;
        if (filled === k) minScore = topScore[k - 1];
      } else if (dot > minScore) {
        let j = k - 2;
        while (j >= 0 && topScore[j] < dot) { topScore[j + 1] = topScore[j]; topIdx[j + 1] = topIdx[j]; j--; }
        topScore[j + 1] = dot; topIdx[j + 1] = i;
        minScore = topScore[k - 1];
      }
    }

    const out: { messageId: string; score: number }[] = new Array(filled);
    for (let i = 0; i < filled; i++) out[i] = { messageId: this.ids[topIdx[i]], score: topScore[i] };
    return out;
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
