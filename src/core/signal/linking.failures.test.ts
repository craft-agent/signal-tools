import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, writeFileSync } from "node:fs"
import { ToolError, isAbortError } from "../errors"
import { failureOf } from "./daemon.testing"
import { ensureLabelDir } from "./labels"
import type { LinkOptions } from "./linking"
import { linkingFixture, type LinkingFixture } from "./linking.testing"
import { LINKED_ACCOUNT, isRunning, type FakeMode } from "./signal-cli.testing"

let fixtures: LinkingFixture[] = []

function fixture(mode: FakeMode): LinkingFixture {
  const made = linkingFixture(mode)
  fixtures.push(made)
  return made
}

afterEach(() => {
  for (const made of fixtures) made.close()
  fixtures = []
})

/** Fails the test unless every process the fake started has ended. */
function expectNoChildLeft(t: LinkingFixture): void {
  expect(t.fake.calls().length).toBeGreaterThan(0)
  for (const call of t.fake.calls()) expect(isRunning(call.pid)).toBe(false)
}

describe("linkDevice failures", () => {
  test("a failed signal-cli is upstream_error with its masked last lines", async () => {
    const t = fixture("link-fail")
    const error = await failureOf(t.link())

    expect((error as ToolError).code).toBe("upstream_error")
    expect(error.message).toBe("signal-cli could not link the device: Link request error: no device at [number]")
    expect(error.message).not.toContain(LINKED_ACCOUNT.number)
    expect(JSON.stringify(t.logs)).not.toContain(LINKED_ACCOUNT.number)
    expectNoChildLeft(t)
  })

  test("an exit without a registered account did not finish", async () => {
    const t = fixture("link-empty")
    const error = await failureOf(t.link())
    expect((error as ToolError).code).toBe("upstream_error")
    expect(error.message).toBe("Linking did not finish.")
    expect(t.uris).toHaveLength(1)
  })

  test("no scan in time stops signal-cli and says so", async () => {
    const t = fixture("link-hang")
    // Long enough for the fake to start and print the address on a loaded machine.
    const error = await failureOf(t.link({ timeoutMs: 3000 }))

    expect((error as ToolError).code).toBe("upstream_error")
    expect(error.message).toBe("No phone scanned the code in time; run the link again.")
    expect(t.uris).toHaveLength(1)
    expectNoChildLeft(t)
  })

  test("an abort stops signal-cli and rejects with an AbortError", async () => {
    const t = fixture("link-hang")
    const controller = new AbortController()
    const linking = failureOf(t.link({ signal: controller.signal, onLinkUri: () => controller.abort() }))

    expect(isAbortError(await linking)).toBe(true)
    expectNoChildLeft(t)
  })

  test("a signal that aborted already starts nothing", async () => {
    const t = fixture("link-ok")
    const error = await failureOf(t.link({ signal: AbortSignal.abort() }))
    expect(isAbortError(error)).toBe(true)
    expect(t.fake.calls()).toEqual([])
    expect(existsSync(t.paths.dir)).toBe(false)
  })

  test("a failure leaves no label directory behind that did not exist before", async () => {
    const failing: [FakeMode, Partial<LinkOptions>][] = [
      ["link-fail", {}],
      ["link-empty", {}],
      ["link-hang", { timeoutMs: 200 }],
      ["link-ok", { program: "/nonexistent/signal-cli" }],
    ]
    for (const [mode, overrides] of failing) {
      const t = fixture(mode)
      await failureOf(t.link(overrides))
      expect(existsSync(t.paths.dir)).toBe(false)
    }

    const t = fixture("link-hang")
    const controller = new AbortController()
    await failureOf(t.link({ signal: controller.signal, onLinkUri: () => controller.abort() }))
    expect(t.fake.calls().length).toBe(1)
    expect(existsSync(t.paths.dir)).toBe(false)
  })

  test("a failure leaves an existing label directory as it was", async () => {
    for (const mode of ["link-fail", "link-hang"] as const) {
      const t = fixture(mode)
      await ensureLabelDir(t.stateDir, t.paths.label)
      writeFileSync(t.paths.mirror, "")
      await failureOf(t.link({ timeoutMs: 200 }))
      expect(existsSync(t.paths.mirror)).toBe(true)
    }
  })

  test("a program that cannot be started is not_found", async () => {
    const t = fixture("link-ok")
    const error = await failureOf(t.link({ program: "/nonexistent/signal-cli" }))
    expect((error as ToolError).code).toBe("not_found")
  })

  test("a mirror that cannot be read is not guessed about", async () => {
    const t = fixture("link-ok")
    await ensureLabelDir(t.stateDir, t.paths.label)
    writeFileSync(t.paths.mirror, "this is not a database".repeat(50))
    await failureOf(t.link())
    expectNoChildLeft(t)
  })

  test("refuses a bad device name or label before starting anything", async () => {
    const t = fixture("link-ok")
    for (const deviceName of ["", "x".repeat(51), "two\nlines", "bell\u0007", "del\u007f"]) {
      const error = await failureOf(t.link({ deviceName }))
      expect((error as ToolError).code).toBe("invalid_argument")
    }
    expect(((await failureOf(t.link({ label: "Bad Label" }))) as ToolError).code).toBe("invalid_argument")
    expect(t.fake.calls()).toEqual([])
  })

  test("accepts the longest device name, counted in characters", async () => {
    const t = fixture("link-ok")
    await t.link({ deviceName: "é".repeat(50) })
    expect(t.fake.calls()[0]?.args).toEqual(["link", "-n", "é".repeat(50)])
  })
})
