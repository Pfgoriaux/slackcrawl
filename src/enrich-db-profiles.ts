import type { Database } from "bun:sqlite";
import { SIGNAL_FILTER } from "./db-noise";

export interface UserProfile {
  user_id: string;
  expertise: string | null;
  summary: string | null;
  updated_at: number;
}

export function upsertUserProfile(db: Database, p: Omit<UserProfile, "updated_at">) {
  db.run(
    `INSERT INTO user_profiles(user_id, expertise, summary) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET expertise=excluded.expertise, summary=excluded.summary, updated_at=unixepoch()`,
    [p.user_id, p.expertise, p.summary],
  );
}

export function getUserProfile(db: Database, userId: string): UserProfile | null {
  return db
    .query<UserProfile, [string]>("SELECT * FROM user_profiles WHERE user_id = ?")
    .get(userId);
}

export function searchExpertise(
  db: Database,
  query: string,
  limit = 20,
): (UserProfile & { user_id: string })[] {
  return db
    .query<UserProfile & { user_id: string }, [string, number]>(
      `SELECT up.* FROM user_profiles_fts
     JOIN user_profiles up ON user_profiles_fts.rowid = up.rowid
     WHERE user_profiles_fts MATCH ?
     ORDER BY rank LIMIT ?`,
    )
    .all(query, limit);
}

export function getUsersNeedingProfiles(
  db: Database,
  limit = 200,
): { user_id: string; username: string; message_count: number }[] {
  return db
    .query<{ user_id: string; username: string; message_count: number }, [number]>(`
    SELECT m.user_id, COALESCE(u.username, m.username) as username, COUNT(*) as message_count
    FROM messages m
    LEFT JOIN users u ON m.user_id = u.id
    WHERE m.user_id IS NOT NULL
      AND ${SIGNAL_FILTER}
      AND (
        NOT EXISTS (SELECT 1 FROM user_profiles up WHERE up.user_id = m.user_id)
        OR (SELECT updated_at FROM user_profiles up2 WHERE up2.user_id = m.user_id) < unixepoch() - 86400
      )
    GROUP BY m.user_id
    HAVING message_count >= 5
    ORDER BY message_count DESC
    LIMIT ?
  `)
    .all(limit);
}
