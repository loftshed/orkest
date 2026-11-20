export const CHIEF_TABLES = `
  CREATE TABLE IF NOT EXISTS chief_desk_items (
    id TEXT PRIMARY KEY, room_id TEXT, at TEXT NOT NULL,
    data TEXT NOT NULL CHECK(json_valid(data)), message_id TEXT
  ) STRICT;
  CREATE TABLE IF NOT EXISTS chief_desk_acked (
    id TEXT PRIMARY KEY, tx TEXT NOT NULL, at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS chief_ack_txs (
    id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('committed','complete')),
    session TEXT, desk_ids TEXT NOT NULL CHECK(json_valid(desk_ids)),
    inbox_ids TEXT NOT NULL CHECK(json_valid(inbox_ids)), at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS chief_imports (
    source TEXT PRIMARY KEY, digest TEXT NOT NULL
  ) STRICT;
`;

const FOUNDRY_TABLES = `
  CREATE TABLE IF NOT EXISTS foundry_states (
    key TEXT PRIMARY KEY, state_path TEXT NOT NULL, identity TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 1),
    state TEXT NOT NULL CHECK(json_valid(state)), updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS foundry_ops (
    key TEXT NOT NULL, op TEXT NOT NULL, revision INTEGER NOT NULL, receipt TEXT CHECK(json_valid(receipt)), PRIMARY KEY(key, op)
  ) STRICT;
`;

export const MAILBOX_RECORDS = `CREATE TABLE IF NOT EXISTS mailbox_records (
    collection TEXT NOT NULL CHECK(collection IN ('peer','inbox')),
    owner TEXT NOT NULL, key TEXT NOT NULL,
    body TEXT NOT NULL CHECK(json_valid(body)), updated_ms INTEGER NOT NULL,
    PRIMARY KEY(collection, owner, key)
  ) STRICT;`;

export const MAILBOX_CUTOVER =
  "CREATE TABLE IF NOT EXISTS mailbox_cutover(singleton INTEGER PRIMARY KEY CHECK(singleton=1), digest TEXT NOT NULL) STRICT";

export function ensureFoundryTables(db) {
  db.exec(FOUNDRY_TABLES);
  if (!db.tagStore.get`SELECT 1 FROM pragma_table_info('foundry_ops') WHERE name='receipt'`)
    db.exec("ALTER TABLE foundry_ops ADD COLUMN receipt TEXT CHECK(json_valid(receipt))");
}

export const CHIEF_NOTIFICATION_INTENTS = `
  CREATE TABLE IF NOT EXISTS chief_notification_intents(
    id TEXT PRIMARY KEY, profile TEXT NOT NULL, event TEXT NOT NULL, created_ms INTEGER NOT NULL
  ) STRICT;
`;
