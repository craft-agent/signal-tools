/** The schema version a current mirror has: the number of `MIGRATIONS`. */
export const MIRROR_VERSION = 2

/**
 * `MIGRATIONS[i]` takes a mirror from version `i` to `i + 1`; entry 0 creates
 * the first schema. A change to the schema adds an entry and never edits one,
 * so a mirror of any older version reaches the current one.
 *
 * Times are milliseconds. A boolean is 0 or 1. `attachments`, `quote`,
 * `mentions` and `members` hold JSON (see `mirror-parts.ts`). `deleted` holds
 * only the author and times of messages deleted for everyone, no content, so
 * that a delivery arriving after its delete is dropped.
 */
export const MIGRATIONS: readonly string[] = [
  `
CREATE TABLE chats (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('person', 'group')),
  name TEXT,
  number TEXT,
  members TEXT,
  member INTEGER NOT NULL DEFAULT 1 CHECK (member IN (0, 1)),
  expires_in INTEGER,
  last_ts INTEGER,
  updated INTEGER NOT NULL
);

CREATE TABLE messages (
  chat TEXT NOT NULL,
  author TEXT NOT NULL,
  ts INTEGER NOT NULL,
  from_me INTEGER NOT NULL DEFAULT 0 CHECK (from_me IN (0, 1)),
  author_name TEXT,
  kind TEXT NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'timer')),
  body TEXT,
  attachments TEXT,
  quote TEXT,
  sticker INTEGER NOT NULL DEFAULT 0 CHECK (sticker IN (0, 1)),
  other TEXT,
  expires_in INTEGER NOT NULL DEFAULT 0,
  expire_start INTEGER,
  read_at INTEGER,
  view_once INTEGER NOT NULL DEFAULT 0 CHECK (view_once IN (0, 1)),
  edited INTEGER,
  received INTEGER NOT NULL,
  mentions TEXT,
  PRIMARY KEY (author, ts)
);
CREATE INDEX messages_chat ON messages (chat, ts);
CREATE INDEX messages_edited ON messages (author, edited) WHERE edited IS NOT NULL;

CREATE TABLE edits (
  author TEXT NOT NULL,
  ts INTEGER NOT NULL,
  rev_ts INTEGER NOT NULL,
  body TEXT,
  attachments TEXT,
  mentions TEXT,
  PRIMARY KEY (author, ts, rev_ts)
);
CREATE INDEX edits_rev ON edits (author, rev_ts);

CREATE TABLE reactions (
  author TEXT NOT NULL,
  ts INTEGER NOT NULL,
  reactor TEXT NOT NULL,
  emoji TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (author, ts, reactor)
);

CREATE TABLE deleted (
  author TEXT NOT NULL,
  ts INTEGER NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (author, ts)
);

CREATE TABLE contacts (
  uuid TEXT PRIMARY KEY,
  number TEXT,
  name TEXT,
  profile_name TEXT,
  username TEXT,
  blocked INTEGER NOT NULL DEFAULT 0 CHECK (blocked IN (0, 1)),
  updated INTEGER NOT NULL
);
CREATE INDEX contacts_number ON contacts (number) WHERE number IS NOT NULL;

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`,
  // Version 2: serves a search across every chat, newest first, without sorting all messages.
  "CREATE INDEX messages_ts ON messages (ts, author);",
]
