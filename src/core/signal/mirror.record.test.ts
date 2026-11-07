import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, readdirSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { isToolError } from "../errors"
import { inTransaction, openMirrorForRecord, openMirrorForWrite, setMeta, type Mirror } from "./mirror"
import { MIGRATIONS } from "./mirror-schema"
import { columnOf, errorOf, makeTempDir } from "./mirror.testing"

let dir: string
let path: string
const opened: Mirror[] = []

beforeEach(() => {
  dir = makeTempDir()
  path = join(dir, "mirror.sqlite")
})

afterEach(() => {
  for (const mirror of opened.splice(0)) if (mirror.isOpen) mirror.close()
  rmSync(dir, { recursive: true, force: true })
})

function tracked(mirror: Mirror): Mirror {
  opened.push(mirror)
  return mirror
}

describe("openMirrorForRecord", () => {
  test("opens a current mirror for writing, which can be written while the sync service holds it open", () => {
    const service = tracked(openMirrorForWrite(path))
    const recorder = tracked(openMirrorForRecord(path))
    inTransaction(recorder, () => setMeta(recorder, { recorded: 1 }))
    expect(columnOf(service, "SELECT value FROM meta WHERE key = 'recorded'")).toEqual(["1"])
    expect(columnOf(recorder, "PRAGMA busy_timeout")).toEqual([10_000])
  })

  test("refuses a missing mirror as not_found and creates nothing", () => {
    const error = errorOf(() => openMirrorForRecord(path))
    expect(isToolError(error) && error.code).toBe("not_found")
    expect(readdirSync(dir)).toEqual([])
  })

  test("refuses a mirror that was never set up as not_found, leaving it as it was", () => {
    new DatabaseSync(path).close()
    const before = statSync(path)
    const error = errorOf(() => openMirrorForRecord(path))
    expect(isToolError(error) && error.code).toBe("not_found")
    expect(statSync(path).mtimeMs).toBe(before.mtimeMs)
  })

  test("refuses a mirror of an older version and migrates nothing", () => {
    const raw = new DatabaseSync(path)
    raw.exec(`PRAGMA journal_mode = WAL; ${MIGRATIONS[0]}; PRAGMA user_version = 1`)
    raw.close()
    const error = errorOf(() => openMirrorForRecord(path))
    expect(isToolError(error) && error.code).toBe("upstream_error")
    expect(error.message).toContain("older version")
    const check = new DatabaseSync(path)
    expect(columnOf(check, "PRAGMA user_version")).toEqual([1])
    expect(columnOf(check, "SELECT name FROM sqlite_master WHERE name = 'messages_ts'")).toEqual([])
    check.close()
  })

  test("refuses a mirror of a newer version", () => {
    const raw = new DatabaseSync(path)
    raw.exec("CREATE TABLE future (x); PRAGMA user_version = 99")
    raw.close()
    const error = errorOf(() => openMirrorForRecord(path))
    expect(isToolError(error) && error.code).toBe("upstream_error")
    expect(error.message).toContain("newer version")
    expect(existsSync(`${path}-wal`)).toBe(false)
  })
})
