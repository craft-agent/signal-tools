import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createTestMirror, rowsOf, type TestMirror } from "../signal/mirror.testing"
import { rangeConditions } from "./range"
import { SCAN_LIMITS, chunkStatement, type ScanScope } from "./search"

let t: TestMirror

beforeEach(() => {
  t = createTestMirror()
})

afterEach(() => {
  t.close()
})

/** What SQLite says it will do for a chunk of the scan, one line per step. */
function plan(scope: ScanScope, after?: { ts: number; author: string }): string[] {
  const { sql, params } = chunkStatement(scope, after)
  const rows = rowsOf(t.mirror, `EXPLAIN QUERY PLAN ${sql}`, ...params, SCAN_LIMITS.chunk + 1)
  return rows.map((row) => String(row.detail))
}

const everyChat: ScanScope = { conditions: ["kind = 'message'"], params: [] }

describe("the scan of a search across every chat", () => {
  test("is served in order by the time index, with no sort", () => {
    const steps = plan(everyChat)
    expect(steps.join("\n")).toContain("messages_ts")
    expect(steps.join("\n")).not.toContain("TEMP B-TREE")
  })

  test("seeks to where the last chunk ended instead of reading the history before it", () => {
    const steps = plan(everyChat, { ts: 5000, author: "a" })
    expect(steps).toEqual([expect.stringMatching(/^SEARCH messages USING INDEX messages_ts \(\(ts,\s*author\)</)])
  })

  test("keeps to the index with a range of times", () => {
    const bounds = rangeConditions({ after: 1000, before: 9000 })
    const steps = plan(
      { conditions: ["kind = 'message'", ...bounds.conditions], params: bounds.params },
      { ts: 5000, author: "a" },
    )
    expect(steps.join("\n")).toContain("messages_ts")
    expect(steps.join("\n")).not.toContain("TEMP B-TREE")
  })
})
