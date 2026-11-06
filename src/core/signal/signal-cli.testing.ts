import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { ALICE, ME, NUMBER, makeTempDir } from "./mirror.testing"

/** How the fake signal-cli behaves, chosen per call of the helper; `signal-cli.fake.cjs` holds the modes. */
export type FakeMode =
  | "link-ok"
  | "link-other"
  | "link-empty"
  | "link-fail"
  | "link-hang"
  | "hang-stubborn"
  | "lines"
  | "daemon-ok"
  | "daemon-exit-after-envelopes"
  | "daemon-ignore-term"
  | "daemon-no-socket"
  | "daemon-unlinked"

/** A made-up account, as signal-cli's files name it. */
export type TestAccount = { uuid: string; number: string }

/** The account `link-ok` links, and the one `link-other` links instead. */
export const LINKED_ACCOUNT: TestAccount = { uuid: ME, number: NUMBER }
export const OTHER_ACCOUNT: TestAccount = { uuid: ALICE, number: "+15555550199" }

/** One start of the fake program, as it recorded it. */
export type FakeCall = {
  pid: number
  /** The `--config` directory. */
  config: string
  /** The arguments after `--config <dir>` and `--scrub-log`. */
  args: string[]
  /** The names of the environment variables it started with. */
  env: string[]
}

/** What the fake's daemon modes serve. */
export type DaemonFixture = {
  /** Emitted as `receive` notifications right after `subscribeReceive` is answered; each is a `{ envelope, account }` result. */
  payloads?: unknown[]
  /** The answer to `listContacts` and to `listGroups`. */
  contacts?: unknown[]
  groups?: unknown[]
  /** Emitted `afterMs` after the subscription, for what must arrive while the service runs. */
  later?: { afterMs: number; payloads: unknown[] }
}

/** One request the fake's daemon received. */
export type FakeRpcCall = { method: string; params?: unknown }

export type FakeSignalCli = {
  dir: string
  /** The fake executable's path. */
  program: string
  /**
   * An environment whose `PATH` starts with the fake's directory. The fake is
   * told what to do by a file beside it, not by a variable, since
   * `signalCliEnv` lets only a few variables through.
   */
  env: Record<string, string>
  /** Changes what the fake does from the next start on. */
  setMode(mode: FakeMode): void
  /** Every start so far, in order. */
  calls(): FakeCall[]
  /** Sets what the daemon modes serve, from the next start on. */
  setDaemon(fixture: DaemonFixture): void
  /** Every request the daemon modes received so far, in order. */
  rpcCalls(): FakeRpcCall[]
  /** Removes the directory. */
  close(): void
}

const SCRIPT = fileURLToPath(new URL("./signal-cli.fake.cjs", import.meta.url))

/** Installs a fake `signal-cli` in a fresh temp directory, behaving as `mode` says. */
export function installFakeSignalCli(mode: FakeMode): FakeSignalCli {
  const dir = makeTempDir()
  const program = join(dir, "signal-cli")
  copyFileSync(SCRIPT, program)
  chmodSync(program, 0o755)
  const setMode = (next: FakeMode) =>
    writeFileSync(
      join(dir, "fake.json"),
      JSON.stringify({ mode: next, accounts: { linked: LINKED_ACCOUNT, other: OTHER_ACCOUNT } }),
    )
  setMode(mode)
  const recorded = <T>(file: string): T[] => {
    try {
      const lines = readFileSync(join(dir, file), "utf8").split("\n")
      return lines.filter((line) => line !== "").map((line) => JSON.parse(line) as T)
    } catch {
      return []
    }
  }
  return {
    dir,
    program,
    env: { PATH: `${dir}:${process.env.PATH ?? ""}`, HOME: dir },
    setMode,
    calls: () => recorded<FakeCall>("calls.jsonl"),
    setDaemon: (fixture) => writeFileSync(join(dir, "daemon.json"), JSON.stringify(fixture)),
    rpcCalls: () => recorded<FakeRpcCall>("rpc.jsonl"),
    close: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/** Writes the files signal-cli keeps for one account in its `--config` directory, as a finished link leaves them. */
export function writeSignalCliAccount(
  signalCliDir: string,
  { uuid, number }: TestAccount,
  registered: boolean | null = true,
  file = "100001",
): void {
  const dataDir = join(signalCliDir, "data")
  mkdirSync(dataDir, { recursive: true })
  const index = { accounts: [{ path: file, environment: "LIVE", number, uuid }], version: 2 }
  writeFileSync(join(dataDir, "accounts.json"), JSON.stringify(index))
  writeFileSync(join(dataDir, file), JSON.stringify({ number, ...(registered === null ? {} : { registered }) }))
}

/** Whether a process with this id is still running. */
export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
