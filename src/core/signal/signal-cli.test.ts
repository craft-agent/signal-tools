import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { ToolError } from "../errors"
import { failureOf } from "./daemon.testing"
import { labelPaths } from "./labels"
import { findSignalCli, signalCliArgs, signalCliEnv, spawnSignalCli, type SignalCliProcess } from "./signal-cli"
import {
  LINKED_ACCOUNT,
  installFakeSignalCli,
  isRunning,
  type FakeMode,
  type FakeSignalCli,
} from "./signal-cli.testing"

const fakes: FakeSignalCli[] = []
const children: SignalCliProcess[] = []

function fake(mode: FakeMode): FakeSignalCli {
  const installed = installFakeSignalCli(mode)
  fakes.push(installed)
  return installed
}

afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => child.stop()))
  for (const installed of fakes.splice(0)) installed.close()
})

/** Starts the fake and collects its lines; `firstStdout` settles with the first line on standard output. */
function start(installed: FakeSignalCli, stopGraceMs?: number) {
  const stdout: string[] = []
  const stderr: string[] = []
  let seen!: (line: string) => void
  const firstStdout = new Promise<string>((resolve) => (seen = resolve))
  const child = spawnSignalCli(installed.program, signalCliArgs(labelPaths("/tmp/state", "main"), "link"), {
    env: installed.env,
    stopGraceMs,
    onStdoutLine(line) {
      stdout.push(line)
      seen(line)
    },
    onStderrLine: (line) => stderr.push(line),
  })
  children.push(child)
  return { child, stdout, stderr, firstStdout }
}

describe("signalCliEnv", () => {
  test("passes only the variables signal-cli needs", () => {
    const env = {
      PATH: "/bin",
      HOME: "/home/me",
      JAVA_HOME: "/jdk",
      TMPDIR: "/tmp",
      LANG: "C",
      SIGNAL_TOOLS_STATE_DIR: "/state",
      API_KEY: "secret",
    }
    expect(signalCliEnv(env)).toEqual({ PATH: "/bin", HOME: "/home/me", JAVA_HOME: "/jdk", TMPDIR: "/tmp", LANG: "C" })
  })

  test("leaves out variables that are not set", () => {
    expect(signalCliEnv({ PATH: "/bin", HOME: undefined })).toEqual({ PATH: "/bin" })
  })
})

describe("signalCliArgs", () => {
  test("puts the label's directory and the log scrubbing before the command", () => {
    const paths = labelPaths("/state", "main")
    expect(signalCliArgs(paths, "link", "-n", "box")).toEqual([
      "--config",
      "/state/main/signal-cli",
      "--scrub-log",
      "link",
      "-n",
      "box",
    ])
  })
})

describe("findSignalCli", () => {
  test("finds the first executable on PATH", async () => {
    const first = fake("lines")
    const second = fake("lines")
    expect(await findSignalCli({ PATH: [first.dir, second.dir].join(":") })).toBe(first.program)
  })

  test("skips a file that is not executable", async () => {
    const plain = fake("lines")
    chmodSync(plain.program, 0o644)
    const good = fake("lines")
    expect(await findSignalCli({ PATH: [plain.dir, good.dir].join(":") })).toBe(good.program)
  })

  test("skips a directory of that name and empty entries", async () => {
    const good = fake("lines")
    mkdirSync(join(good.dir, "sub", "signal-cli"), { recursive: true })
    expect(await findSignalCli({ PATH: [`:${join(good.dir, "sub")}`, good.dir].join(":") })).toBe(good.program)
  })

  test("falls back to the package manager prefixes, else is not_found", async () => {
    const fallbacks = ["/opt/homebrew/bin", "/usr/local/bin"].map((dir) => join(dir, "signal-cli"))
    const installedAt = fallbacks.find((path) => existsSync(path))
    if (installedAt !== undefined) {
      expect(await findSignalCli({})).toBe(installedAt)
      return
    }
    const error = await failureOf(findSignalCli({ PATH: "" }))
    expect(error).toBeInstanceOf(ToolError)
    expect((error as ToolError).code).toBe("not_found")
    expect(error.message).toBe(
      "signal-cli is not installed or not on PATH; install it from https://github.com/AsamK/signal-cli.",
    )
  })
})

describe("spawnSignalCli", () => {
  test("hands over lines, flushes the last partial one and masks numbers on standard error", async () => {
    const run = start(fake("lines"))
    expect(await run.child.exited).toEqual({ code: 0, signal: null })
    expect(run.stdout).toEqual(["one", "two", "partial"])
    expect(run.stderr).toEqual(["warn [number] here", "last"])
    expect(JSON.stringify(run.stderr)).not.toContain(LINKED_ACCOUNT.number)
  })

  test("runs the program with the given arguments", async () => {
    const installed = fake("lines")
    await start(installed).child.exited
    expect(installed.calls().map((call) => call.args)).toEqual([["link"]])
  })

  test("a throwing callback does not break the process handling", async () => {
    const installed = fake("lines")
    const lines: string[] = []
    const child = spawnSignalCli(installed.program, [], {
      env: installed.env,
      onStdoutLine(line) {
        lines.push(line)
        throw new Error("boom")
      },
      onStderrLine() {
        throw new Error("boom")
      },
    })
    expect(await child.exited).toEqual({ code: 0, signal: null })
    expect(lines).toEqual(["one", "two", "partial"])
  })

  test("reports a program that cannot be started as not_found", async () => {
    const child = spawnSignalCli("/nonexistent/signal-cli", [], { env: {} })
    const error = await failureOf(child.exited)
    expect((error as ToolError).code).toBe("not_found")
    await child.stop()
  })

  test("stop sends SIGTERM and may be called twice", async () => {
    const run = start(fake("link-hang"))
    await run.firstStdout
    const pid = run.child.pid!
    await Promise.all([run.child.stop(), run.child.stop()])
    expect((await run.child.exited).signal).toBe("SIGTERM")
    await run.child.stop()
    expect(isRunning(pid)).toBe(false)
  })

  test("stop sends SIGKILL to a process that ignores SIGTERM once the grace has passed", async () => {
    const run = start(fake("hang-stubborn"), 200)
    await run.firstStdout
    const pid = run.child.pid!
    const began = Date.now()
    await run.child.stop()
    expect((await run.child.exited).signal).toBe("SIGKILL")
    expect(Date.now() - began).toBeGreaterThanOrEqual(150)
    expect(isRunning(pid)).toBe(false)
  })

  test("stop after the process ended resolves at once", async () => {
    const run = start(fake("lines"))
    await run.child.exited
    await run.child.stop()
  })
})
