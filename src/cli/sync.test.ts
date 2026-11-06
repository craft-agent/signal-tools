import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { ToolError } from "../core"
import { labelPaths } from "../core/signal/labels"
import { NUMBER } from "../core/signal/mirror.testing"
import type { FakeMode } from "../core/signal/signal-cli.testing"
import { eventually, syncFixture, type SyncFixture } from "../core/signal/sync.testing"
import { PROJECT } from "../project"
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, type CommandIo } from "./command-io"
import { runSyncCommand } from "./sync"

const LOG_LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \S/

let fixtures: SyncFixture[] = []

afterEach(() => {
  for (const made of fixtures) made.close()
  fixtures = []
})

type Run = { code: number; stdout: string; stderr: string; t: SyncFixture }

/** A command line run against the fake signal-cli in `mode`, over the fixture's state directory. */
function command(
  mode: FakeMode,
  args: string[] = [],
  overrides: Partial<CommandIo> = {},
  setup: (t: SyncFixture) => void = () => {},
) {
  const t = syncFixture(mode)
  fixtures.push(t)
  setup(t)
  let stdout = ""
  let stderr = ""
  const done = runSyncCommand(["--state-dir", t.stateDir, ...args], {
    env: t.fake.env,
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
    findProgram: async () => t.fake.program,
    ...overrides,
  })
  return { t, done, output: () => ({ stdout, stderr }) }
}

/** Adds a label directory without an account to the fixture's state directory. */
const addLabel = (label: string) => (t: SyncFixture) => mkdirSync(labelPaths(t.stateDir, label).dir)

async function sync(mode: FakeMode, args: string[] = [], overrides: Partial<CommandIo> = {}): Promise<Run> {
  const { t, done, output } = command(mode, args, overrides)
  const code = await done
  return { code, ...output(), t }
}

describe("runSyncCommand", () => {
  test("runs the only account in the foreground, logs with the time, and exits 0 on a stop request", async () => {
    const controller = new AbortController()
    const { t, done, output } = command("daemon-ok", [], { signal: controller.signal })

    await eventually(() => t.meta().status === "running")
    controller.abort()
    const code = await done

    const { stdout, stderr } = output()
    expect(code).toBe(EXIT_OK)
    expect(stdout).toBe("")
    const lines = stderr.split("\n").slice(0, -1)
    expect(lines.length).toBeGreaterThan(2)
    for (const line of lines) expect(line).toMatch(LOG_LINE)
    expect(lines.map((line) => line.slice(25))).toContain("subscribed")
    expect(lines.at(-1)?.slice(25)).toBe("stopped")
    expect(stderr).not.toContain(NUMBER)
    expect(t.meta().status).toBe("stopped")
  })

  test("takes the account by name", async () => {
    const controller = new AbortController()
    const { t, done } = command("daemon-ok", ["--account=main"], { signal: controller.signal })

    await eventually(() => t.meta().status === "running")
    controller.abort()

    expect(await done).toBe(EXIT_OK)
    expect(t.fake.calls()[0]?.config).toBe(t.paths.signalCli)
  })

  test("exits 1 when the sync service fails", async () => {
    const { code, stderr } = await sync("daemon-exit-after-envelopes")

    expect(code).toBe(EXIT_FAILED)
    expect(stderr).toContain("sync ended: signal-cli exited (code 3)")
  })

  test("exits 0 when Signal unlinked the device", async () => {
    const { code, stderr } = await sync("daemon-unlinked")

    expect(code).toBe(EXIT_OK)
    expect(stderr).toContain("staying down until it is linked again")
  })

  test("exits 0 for a label that has no linked account", async () => {
    const { t, done, output } = command("daemon-ok", ["--account", "empty"], {}, addLabel("empty"))

    expect(await done).toBe(EXIT_OK)
    expect(output().stderr).toMatch(/no linked Signal account/)
    expect(t.fake.calls()).toEqual([])
  })

  test("several accounts need a name: usage error listing them", async () => {
    const { t, done, output } = command("daemon-ok", [], {}, addLabel("other"))

    expect(await done).toBe(EXIT_USAGE)
    expect(output().stderr).toBe(
      `${PROJECT.cli}: Several Signal accounts are linked; name one with \`account\`: main, other.\n`,
    )
    expect(t.fake.calls()).toEqual([])
  })

  test("an account that does not exist, or no account at all, is not linked: exit 0", async () => {
    const unknown = await sync("daemon-ok", ["--account", "nobody"])
    expect(unknown.code).toBe(EXIT_OK)
    expect(unknown.stderr).toMatch(/Z no linked Signal account; link a device first\n$/)
    expect(unknown.t.fake.calls()).toEqual([])

    const { t, done, output } = command("daemon-ok", ["--state-dir", "/nonexistent-state-dir-for-test"])
    expect(await done).toBe(EXIT_OK)
    expect(output().stderr).toMatch(/Z no linked Signal account; link a device first\n$/)
    expect(t.fake.calls()).toEqual([])
  })

  test("a malformed account name is a usage error", async () => {
    const { code, stderr } = await sync("daemon-ok", ["--account", "Nobody"])

    expect(code).toBe(EXIT_USAGE)
    expect(stderr).toStartWith(`${PROJECT.cli}: Invalid label`)
  })

  test("reports a missing signal-cli", async () => {
    const { code, stderr, t } = await sync("daemon-ok", [], {
      findProgram: async () => {
        throw new ToolError("not_found", "signal-cli is not installed or not on PATH; install it from somewhere.")
      },
    })

    expect(code).toBe(EXIT_FAILED)
    expect(stderr).toBe(`${PROJECT.cli}: signal-cli is not installed or not on PATH; install it from somewhere.\n`)
    expect(t.fake.calls()).toEqual([])
  })

  test("an aborted signal stops before anything starts", async () => {
    const { code, t } = await sync("daemon-ok", [], { signal: AbortSignal.abort() })

    expect(code).toBe(EXIT_OK)
    expect(t.fake.calls()).toEqual([])
  })

  test("a mistake in the command line is one line on standard error and exit 2", async () => {
    const mistakes = [["--account"], ["--account", "--state-dir"], ["--account="], ["--account", "Bad Label"]]
    mistakes.push(["--bogus"], ["extra"], ["--read-only"], ["--verbose"])
    for (const args of mistakes) {
      const { code, stdout, stderr, t } = await sync("daemon-ok", args)
      expect(code).toBe(EXIT_USAGE)
      expect(stdout).toBe("")
      expect(stderr).toMatch(new RegExp(`^${PROJECT.cli}: [^\\n]+\\n$`))
      expect(t.fake.calls()).toEqual([])
    }
  })
})
