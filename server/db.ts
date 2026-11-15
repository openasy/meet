import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Forward-only migrations (ADR 0010): append new entries, never edit or remove old ones.
// Nothing of a call's media or chat is here: LiveKit carries them and keeps nothing. Guests leave as little as can be:
// the name they typed and, if they gave one, their email, until the call ends; never an IP address.
const MIGRATIONS = [
  `-- A meeting is a link: made by hand, by Calendar for an invitation, by Chat for a channel, or a person's own room.
   -- invited is a JSON list of email addresses, from the invitation.
   CREATE TABLE meetings (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     source TEXT NOT NULL CHECK (source IN ('calendar', 'chat', 'hand', 'room')),
     channel TEXT,
     reference TEXT,
     organizer_email TEXT NOT NULL,
     organizer_name TEXT NOT NULL,
     starts_at TEXT,
     ends_at TEXT,
     invited TEXT,
     allow_recording INTEGER NOT NULL DEFAULT 0,
     created_by TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX meetings_starts ON meetings (starts_at);
   CREATE INDEX meetings_organizer ON meetings (organizer_email);
   CREATE UNIQUE INDEX meetings_room ON meetings (organizer_email) WHERE source = 'room';
   CREATE UNIQUE INDEX meetings_reference ON meetings (source, reference) WHERE reference IS NOT NULL;
   -- A call: one time a meeting's room was open in LiveKit, from the first person in to the last one out.
   CREATE TABLE calls (
     id INTEGER PRIMARY KEY,
     meeting_id TEXT NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
     room_sid TEXT,
     started_at TEXT NOT NULL,
     ended_at TEXT
   );
   CREATE INDEX calls_meeting ON calls (meeting_id, started_at);
   CREATE INDEX calls_open ON calls (ended_at) WHERE ended_at IS NULL;
   -- Who was in a call. identity is LiveKit's: u:<member id> or g:<lobby id>. A guest's name is cleared when the call
   -- ends; only that a guest was there stays, for the counts.
   CREATE TABLE attendance (
     call_id INTEGER NOT NULL REFERENCES calls (id) ON DELETE CASCADE,
     identity TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('member', 'guest')),
     email TEXT,
     name TEXT,
     joined_at TEXT NOT NULL,
     left_at TEXT,
     PRIMARY KEY (call_id, identity)
   );
   -- People asking to join from outside. ticket_hash is the SHA-256 of the secret their browser holds; the lobby entry
   -- is deleted a day after the call ends or the knock goes unanswered.
   CREATE TABLE lobby (
     id TEXT PRIMARY KEY,
     meeting_id TEXT NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
     ticket_hash TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     email TEXT,
     state TEXT NOT NULL CHECK (state IN ('waiting', 'admitted', 'denied', 'expired', 'left')),
     decided_by TEXT,
     decided_at TEXT,
     created_at TEXT NOT NULL
   );
   CREATE INDEX lobby_meeting ON lobby (meeting_id, state);
   -- Recordings made by Egress. people is a JSON list of the members who were in the call while it ran and saw the mark;
   -- guests are only counted.
   CREATE TABLE recordings (
     id TEXT PRIMARY KEY,
     meeting_id TEXT REFERENCES meetings (id) ON DELETE SET NULL,
     egress_id TEXT UNIQUE,
     title TEXT NOT NULL,
     started_by_email TEXT NOT NULL,
     started_by_name TEXT NOT NULL,
     group_id TEXT NOT NULL,
     group_name TEXT NOT NULL,
     keep_days INTEGER NOT NULL,
     state TEXT NOT NULL CHECK (state IN ('recording', 'saving', 'ready', 'failed')),
     file TEXT NOT NULL,
     size INTEGER NOT NULL DEFAULT 0,
     duration_s INTEGER NOT NULL DEFAULT 0,
     people TEXT NOT NULL DEFAULT '[]',
     guests INTEGER NOT NULL DEFAULT 0,
     error TEXT,
     started_at TEXT NOT NULL,
     ended_at TEXT,
     delete_on TEXT
   );
   CREATE INDEX recordings_started ON recordings (started_at);
   -- The groups a person's identity provider sent at their last sign-in.
   CREATE TABLE person_groups (user_id TEXT PRIMARY KEY, groups TEXT NOT NULL, at TEXT NOT NULL);
   -- What flowed through the media server, from the browsers' own counts, a sample a minute; two days are kept.
   CREATE TABLE media_samples (at TEXT PRIMARY KEY, total_kbps INTEGER NOT NULL, relayed_kbps INTEGER NOT NULL, people INTEGER NOT NULL);`,
];

/** Opens the product's single SQLite file in WAL mode (ADR 0011) and migrates it forward. */
export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number };
  for (let v = row.v; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v + 1, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}
