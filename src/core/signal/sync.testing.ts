import { existsSync, rmSync } from "node:fs"
import { labelPaths, type LabelPaths } from "./labels"
import { getMeta, openMirrorForRead, type Mirror } from "./mirror"
import { makeTempDir } from "./mirror.testing"
import {
  LINKED_ACCOUNT,
  installFakeSignalCli,
  isRunning,
  writeSignalCliAccount,
  type DaemonFixture,
  type FakeMode,
  type FakeSignalCli,
} from "./signal-cli.testing"
import { runSync, type SyncOptions, type SyncOutcome } from "./sync"

export const LABEL = "main"

/** Timeouts short enough for a test; the values are not what the defaults are. */
const TEST_OPTIONS = {
  socketWaitMs: 10_000,
  drainMs: 2_000,
  stopGraceMs: 1_000,
  diskWaitMs: 10,
  minFreeBytes: 0,
}

/** How long a test waits for something the service does on its own. */
const EVENTUALLY_MS = 8_000

/** A sync test's surroundings: a state directory with a linked account, a fake signal-cli daemon, and what the service logged. */
export type SyncFixture = {
  fake: FakeSignalCli
  stateDir: string
  paths: LabelPaths
  /** Every line handed to `log`. */
  logs: string[]
  /** Serves `fixture` from the fake's daemon. */
  serve(fixture: DaemonFixture): void
  /** Runs the service on `LABEL`, with test timeouts, unless `overrides` say otherwise. */
  run(overrides?: Partial<SyncOptions>): Promise<SyncOutcome>
  /** Starts a run that a test stops itself; `stop` aborts it. */
  start(overrides?: Partial<SyncOptions>): { outcome: Promise<SyncOutcome>; stop(): void }
  /** The mirror's `meta`, read the way a tool reads it; empty while there is no mirror yet. */
  meta(): Record<string, string>
  /** The process ids of the fake's starts. */
  pids(): number[]
  close(): void
}

/** Sets up a sync test whose fake signal-cli behaves as `mode`, with an account linked; call `close` afterwards. */
export function syncFixture(mode: FakeMode): SyncFixture {
  const fake = installFakeSignalCli(mode)
  const stateDir = makeTempDir()
  const paths = labelPaths(stateDir, LABEL)
  writeSignalCliAccount(paths.signalCli, LINKED_ACCOUNT)
  const logs: string[] = []

  const run: SyncFixture["run"] = (overrides = {}) =>
    runSync({
      stateDir,
      label: LABEL,
      program: fake.program,
      env: fake.env,
      log: (line) => logs.push(line),
      ...TEST_OPTIONS,
      ...overrides,
    })

  return {
    fake,
    stateDir,
    paths,
    logs,
    serve: (fixture) => fake.setDaemon(fixture),
    run,
    start(overrides = {}) {
      const controller = new AbortController()
      return { outcome: run({ signal: controller.signal, ...overrides }), stop: () => controller.abort() }
    },
    meta() {
      if (!existsSync(paths.mirror)) return {}
      let mirror: Mirror
      try {
        mirror = openMirrorForRead(paths.mirror)
      } catch {
        return {} // being set up
      }
      try {
        return getMeta(mirror)
      } finally {
        mirror.close()
      }
    },
    pids: () => fake.calls().map((call) => call.pid),
    close() {
      fake.close()
      rmSync(stateDir, { recursive: true, force: true })
    },
  }
}

/** Polls until `condition` holds, failing the test after `ms`. */
export async function eventually(condition: () => boolean, ms = EVENTUALLY_MS): Promise<void> {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the condition")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** Whether every process the fake started has ended. */
export function allGone(pids: number[]): boolean {
  return pids.every((pid) => !isRunning(pid))
}
