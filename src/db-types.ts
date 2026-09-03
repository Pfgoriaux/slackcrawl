// ---- Types ----

export interface Workspace {
  id: string;
  name: string;
  domain: string | null;
  synced_at: number | null;
}

export interface Channel {
  id: string;
  workspace_id: string;
  name: string | null;
  is_private: number;
  is_archived: number;
  topic: string | null;
  purpose: string | null;
  member_count: number;
  created_at: number | null;
  synced_at: number | null;
  last_synced_ts: string | null;
}

export interface User {
  id: string;
  workspace_id: string;
  username: string | null;
  real_name: string | null;
  display_name: string | null;
  email: string | null;
  title: string | null;
  is_bot: number;
  is_deleted: number;
  avatar_url: string | null;
  synced_at: number | null;
}

export interface Message {
  id: string;
  workspace_id: string;
  channel_id: string;
  ts: string;
  thread_ts: string | null;
  subtype: string | null;
  user_id: string | null;
  username: string | null;
  text: string | null;
  has_attachments: number;
  has_files: number;
  reactions: string | null;
  reply_count: number;
  reply_users: string | null;
  edited_ts: string | null;
  created_at: number | null;
  deleted_at: number | null;
  raw_json: string | null;
}
