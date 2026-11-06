import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { join } from "node:path"
import { isToolError } from "../errors"
import { getMeta, inTransaction, openMirrorForRead, openMirrorForWrite, setMeta, type Mirror } from "./mirror"
import { MIGRATIONS, MIRROR_VERSION } from "./mirror-schema"
import { columnOf, errorOf, makeTempDir, rowsOf } from "./mirror.testing"

let dir: string
let path: string
const opened: Mirror[] = []

function tracked(mirror: Mirror): Mirror {
  opened.push(mirror)
  return mirror
}

function version(mirror: Mirror): unknown {
  return columnOf(mirror, "PRAGMA user_version")[0]
}

/** A mirror as the first version of these tools wrote it, holding one message and one meta entry. */
function writeVersionOneMirror(): void {
  const raw = new DatabaseSync(path)
  raw.exec("PRAGMA journal_mode = WAL")
  raw.exec(MIGRATIONS[0]!)
  raw.exec("PRAGMA user_version = 1")
  raw.exec("INSERT INTO meta (key, value) VALUES ('kept', 'yes')")
  raw.exec("INSERT INTO messages (chat, author, ts, body, received) VALUES ('c', 'a', 1000, 'old message', 1000)")
  raw.close()
}

/** The names of the indexes of a table. */
function indexes(mirror: Mirror, table: string): unknown[] {
  return columnOf(mirror, `SELECT name FROM pragma_index_list('${table}') ORDER BY name`)
}

/** A file that a newer version of these tools wrote. */
function writeNewerMirror(): void {
  const raw = new DatabaseSync(path)
  raw.exec("CREATE TABLE future (x); PRAGMA user_version = 99")
  raw.close()
}

beforeEach(() => {
  dir = makeTempDir()
  path = join(dir, "mirror.sqlite")
})

afterEach(() => {
  for (const mirror of opened.splice(0)) if (mirror.isOpen) mirror.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("openMirrorForWrite", () => {
  test("creates the file with mode 0600, whatever the umask", () => {
    const old = process.umask(0)
    try {
      tracked(openMirrorForWrite(path))
    } finally {
      process.umask(old)
    }
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  test("narrows an existing file to 0600", () => {
    tracked(openMirrorForWrite(path)).close()
    chmodSync(path, 0o644)
    tracked(openMirrorForWrite(path))
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  test("uses WAL and creates the current schema from nothing", () => {
    const mirror = tracked(openMirrorForWrite(path))
    expect(columnOf(mirror, "PRAGMA journal_mode")).toEqual(["wal"])
    expect(version(mirror)).toBe(MIRROR_VERSION)
    expect(MIGRATIONS).toHaveLength(MIRROR_VERSION)
    const tables = columnOf(mirror, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    expect(tables).toEqual(["chats", "contacts", "deleted", "edits", "messages", "meta", "reactions"])
    expect(indexes(mirror, "messages")).toContain("messages_ts")
  })

  test("migrates a mirror of version 1 to the current one, keeping what it holds and adding the time index", () => {
    writeVersionOneMirror()
    const mirror = tracked(openMirrorForWrite(path))
    expect(MIRROR_VERSION).toBe(2)
    expect(version(mirror)).toBe(MIRROR_VERSION)
    expect(indexes(mirror, "messages")).toEqual([
      "messages_chat",
      "messages_edited",
      "messages_ts",
      "sqlite_autoindex_messages_1",
    ])
    expect(columnOf(mirror, "SELECT sql FROM sqlite_master WHERE name = 'messages_ts'")).toEqual([
      "CREATE INDEX messages_ts ON messages (ts, author)",
    ])
    expect(getMeta(mirror)).toEqual({ kept: "yes" })
    expect(columnOf(mirror, "SELECT body FROM messages")).toEqual(["old message"])
  })

  test("a mirror already at the current version is not migrated again", () => {
    tracked(openMirrorForWrite(path)).close()
    const mirror = tracked(openMirrorForWrite(path))
    expect(version(mirror)).toBe(MIRROR_VERSION)
    expect(indexes(mirror, "messages").filter((name) => name === "messages_ts")).toHaveLength(1)
  })

  test("takes an empty file as a new mirror and keeps its data when opened again", () => {
    writeFileSync(path, "")
    const first = tracked(openMirrorForWrite(path))
    setMeta(first, { kept: "yes" })
    first.close()
    const second = tracked(openMirrorForWrite(path))
    expect(getMeta(second)).toEqual({ kept: "yes" })
    expect(version(second)).toBe(MIRROR_VERSION)
  })

  test("refuses a mirror of a newer version and leaves it untouched", () => {
    writeNewerMirror()
    const before = statSync(path).size
    const error = errorOf(() => openMirrorForWrite(path))
    expect(isToolError(error) && error.code).toBe("upstream_error")
    expect(error.message).toBe("This mirror was written by a newer version of these tools; update them.")
    const raw = new DatabaseSync(path)
    expect(raw.prepare("PRAGMA user_version").get()).toEqual({ user_version: 99 })
    expect(raw.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" })
    raw.close()
    expect(statSync(path).size).toBe(before)
  })
})

describe("openMirrorForRead", () => {
  test("says nothing was received when the file does not exist, and creates nothing", () => {
    const error = errorOf(() => openMirrorForRead(path))
    expect(isToolError(error) && error.code).toBe("not_found")
    expect(error.message).toBe("Nothing has been received for this account yet: its sync service has not run.")
    expect(readdirSync(dir)).toEqual([])
  })

  test("says the same of a file the sync service created but never set up", () => {
    writeFileSync(path, "")
    const error = errorOf(() => openMirrorForRead(path))
    expect(isToolError(error) && error.code).toBe("not_found")
    expect(readdirSync(dir)).toEqual(["mirror.sqlite"])
  })

  test("reads what the writer committed, and refuses to write", () => {
    const writer = tracked(openMirrorForWrite(path))
    setMeta(writer, { seen: 1 })
    const reader = tracked(openMirrorForRead(path))
    expect(getMeta(reader)).toEqual({ seen: "1" })
    expect(errorOf(() => setMeta(reader, { seen: 2 })).message).toContain("readonly")
    expect(errorOf(() => reader.exec("DELETE FROM meta")).message).toContain("readonly")
    expect(getMeta(writer)).toEqual({ seen: "1" })
  })

  test("leaves nothing behind once the writer has stopped", () => {
    tracked(openMirrorForWrite(path)).close()
    expect(readdirSync(dir)).toEqual(["mirror.sqlite"])
    const before = statSync(path)
    openMirrorForRead(path).close()
    expect(readdirSync(dir)).toEqual(["mirror.sqlite"])
    expect(statSync(path).mtimeMs).toBe(before.mtimeMs)
  })

  test("refuses a mirror of an older version, asking for the sync service to be restarted, and migrates nothing", () => {
    writeVersionOneMirror()
    const before = statSync(path)
    const error = errorOf(() => openMirrorForRead(path))
    expect(isToolError(error) && error.code).toBe("upstream_error")
    expect(error.message).toBe(
      "This mirror is from an older version of these tools; restart the account's sync service to bring it up to date.",
    )
    const raw = new DatabaseSync(path)
    expect(raw.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 })
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE name = 'messages_ts'").all()).toEqual([])
    raw.close()
    expect(statSync(path).mtimeMs).toBe(before.mtimeMs)
    expect(existsSync(`${path}-wal`)).toBe(false)
  })

  test("refuses a mirror of a newer version", () => {
    writeNewerMirror()
    const error = errorOf(() => openMirrorForRead(path))
    expect(isToolError(error) && error.code).toBe("upstream_error")
    expect(error.message).toBe("This mirror was written by a newer version of these tools; update them.")
    expect(existsSync(`${path}-wal`)).toBe(false)
  })
})

describe("inTransaction", () => {
  test("commits what the function wrote and returns its result", () => {
    const mirror = tracked(openMirrorForWrite(path))
    expect(inTransaction(mirror, () => setMeta(mirror, { a: "1" }) ?? "done")).toBe("done")
    expect(mirror.isTransaction).toBe(false)
    expect(getMeta(mirror)).toEqual({ a: "1" })
  })

  test("rolls back and rethrows when the function throws", () => {
    const mirror = tracked(openMirrorForWrite(path))
    const failure = new Error("stop")
    const error = errorOf(() =>
      inTransaction(mirror, () => {
        setMeta(mirror, { a: "1" })
        throw failure
      }),
    )
    expect(error).toBe(failure)
    expect(mirror.isTransaction).toBe(false)
    expect(getMeta(mirror)).toEqual({})
  })

  test("rolls back when a statement fails inside it", () => {
    const mirror = tracked(openMirrorForWrite(path))
    const error = errorOf(() =>
      inTransaction(mirror, () => {
        setMeta(mirror, { a: "1" })
        mirror.exec("INSERT INTO chats (id, kind, updated) VALUES ('x', 'channel', 0)")
      }),
    )
    expect(error.message).toContain("CHECK")
    expect(rowsOf(mirror, "SELECT key FROM meta")).toEqual([])
  })
})

describe("meta", () => {
  test("stores values as text, replaces them and removes a key set to null", () => {
    const mirror = tracked(openMirrorForWrite(path))
    expect(getMeta(mirror)).toEqual({})
    setMeta(mirror, { groups_stale: 1, name: "x" })
    expect(getMeta(mirror)).toEqual({ groups_stale: "1", name: "x" })
    setMeta(mirror, { groups_stale: 0, name: null })
    expect(getMeta(mirror)).toEqual({ groups_stale: "0" })
  })
})
