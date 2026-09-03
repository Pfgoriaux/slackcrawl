import type { Database } from "bun:sqlite";
import { SIGNAL_FILTER } from "./db-noise";

export function upsertEmbedding(
  db: Database,
  messageId: string,
  embedding: Float32Array,
  model: string,
) {
  const buf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  db.run(
    `INSERT INTO message_embeddings(message_id, embedding, model) VALUES (?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET embedding=excluded.embedding, model=excluded.model`,
    [messageId, buf, model],
  );
}

export function getUnembeddedMessages(db: Database, limit: number): { id: string; text: string }[] {
  return db
    .query<{ id: string; text: string }, [number]>(`
    SELECT m.id, m.text
    FROM messages m
    WHERE m.text IS NOT NULL AND m.text != ''
      AND ${SIGNAL_FILTER}
      AND NOT EXISTS (SELECT 1 FROM message_embeddings me WHERE me.message_id = m.id)
    ORDER BY m.created_at DESC
    LIMIT ?
  `)
    .all(limit);
}

export function getAllEmbeddings(db: Database): { message_id: string; embedding: Buffer }[] {
  return db
    .query<{ message_id: string; embedding: Buffer }, []>(
      "SELECT message_id, embedding FROM message_embeddings",
    )
    .all();
}
