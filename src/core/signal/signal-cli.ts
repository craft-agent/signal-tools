import { spawn } from "node:child_process"
import { constants } from "node:fs"
import { access, stat } from "node:fs/promises"
import { delimiter, join } from "node:path"
import { ToolError } from "../errors"
import { maskNumbers } from "./daemon-errors"
import type { LabelPaths } from "./labels"

/** The program's file name on `PATH`. */
const PROGRAM_NAME = "signal-cli"

/** Where signal-cli is looked for after `PATH`: the usual package manager prefixes. */
const FALLBACK_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"]

/** The only variables signal-cli gets: where to find itself and Java, and where to put temporary files. */
const PASSED_VARIABLES = ["PATH", "HOME", "JAVA_HOME", "TMPDIR", "LANG"] as const

/** How long a stopped process may take to exit after SIGTERM before it is sent SIGKILL. */
const DEFAULT_STOP_GRACE_MS = 15_000

/** How long output may still arrive after the process exited, for a grandchild that keeps the pipes open. */
const DRAIN_MS = 100

const NOT_INSTALLED = `${PROGRAM_NAME} is not installed or not on PATH; install it from https://github.com/AsamK/signal-cli.`

/** How a signal-cli process ended: its exit code, or the signal that ended it. */
export type SignalCliExit = { code: number | null; signal: string | null }

export type SignalCliSpawnOptions = {
  /** The process's whole environment; build it with `signalCliEnv`. */
  env: Record<string, string>
  /** Receives each line of standard output, without its line break. */
  onStdoutLine?(line: string): void
  /** Receives each line of standard error, without its line break, with phone numbers masked. */
  onStderrLine?(line: string): void
  /** How long `stop` waits after SIGTERM before it sends SIGKILL; 15 seconds by default. */
  stopGraceMs?: number
}

/** A running signal-cli process. */
export type SignalCliProcess = {
  pid: number | undefined
  /** Settles once the process ended and its output was delivered; rejects when the program could not be started. */
  exited: Promise<SignalCliExit>
  /** Sends SIGTERM, then SIGKILL after the grace period, and resolves once the process is gone. Safe to call again. */
  stop(): Promise<void>
}

/** The environment signal-cli runs with: only what it needs to find itself and Java, and nothing else from `env`. */
export function signalCliEnv(env: Record<string, string | undefined>): Record<string, string> {
  const passed: Record<string, string> = {}
  for (const name of PASSED_VARIABLES) {
    const value = env[name]
    if (value !== undefined) passed[name] = value
  }
  return passed
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The first executable `signal-cli` on `env.PATH`, else in the usual package manager prefixes; `not_found` when there is none. */
export async function findSignalCli(env: Record<string, string | undefined>): Promise<string> {
  const onPath = (env.PATH ?? "").split(delimiter).filter((dir) => dir !== "")
  for (const dir of [...onPath, ...FALLBACK_DIRS]) {
    const candidate = join(dir, PROGRAM_NAME)
    if (await isExecutableFile(candidate)) return candidate
  }
  throw new ToolError("not_found", NOT_INSTALLED)
}

/** The arguments for signal-cli on one label's data directory, followed by `args`. */
export function signalCliArgs(paths: LabelPaths, ...args: string[]): string[] {
  return ["--config", paths.signalCli, "--scrub-log", ...args]
}

/** Splits text into lines on `\n` (dropping a `\r` before it) across chunks, and hands each one over; `flush` hands over the partial last one. */
function lineSplitter(onLine: (line: string) => void): { push(chunk: string): void; flush(): void } {
  let pending = ""
  const emit = (line: string) => {
    try {
      onLine(line.endsWith("\r") ? line.slice(0, -1) : line)
    } catch {
      // A callback's failure must not break the handling of the process.
    }
  }
  return {
    push(chunk) {
      const lines = (pending + chunk).split("\n")
      pending = lines.pop() ?? ""
      for (const line of lines) emit(line)
    },
    flush() {
      if (pending === "") return
      const line = pending
      pending = ""
      emit(line)
    },
  }
}

function spawnError(error: NodeJS.ErrnoException): ToolError {
  return error.code === "ENOENT"
    ? new ToolError("not_found", NOT_INSTALLED, { cause: error })
    : new ToolError("upstream_error", `${PROGRAM_NAME} could not be started (${error.code ?? "error"}).`, {
        cause: error,
      })
}

/**
 * Starts signal-cli without a shell and without standard input, and hands its
 * output over line by line. The caller owns the process: it ends only by
 * itself or through `stop`.
 */
export function spawnSignalCli(
  program: string,
  args: string[],
  { env, onStdoutLine, onStderrLine, stopGraceMs = DEFAULT_STOP_GRACE_MS }: SignalCliSpawnOptions,
): SignalCliProcess {
  const child = spawn(program, args, { env, shell: false, stdio: ["ignore", "pipe", "pipe"] })

  const stdout = lineSplitter((line) => onStdoutLine?.(line))
  const stderr = lineSplitter((line) => onStderrLine?.(maskNumbers(line)))
  child.stdout.setEncoding("utf8").on("data", stdout.push)
  child.stderr.setEncoding("utf8").on("data", stderr.push)

  let killTimer: ReturnType<typeof setTimeout> | undefined
  let drainTimer: ReturnType<typeof setTimeout> | undefined
  let ended: SignalCliExit | undefined

  const exited = new Promise<SignalCliExit>((resolve, reject) => {
    const finish = () => {
      clearTimeout(drainTimer)
      child.stdout.destroy()
      child.stderr.destroy()
      stdout.flush()
      stderr.flush()
      resolve(ended!)
    }
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(killTimer)
      reject(spawnError(error))
    })
    child.on("exit", (code, signal) => {
      clearTimeout(killTimer)
      ended = { code, signal }
      drainTimer = setTimeout(finish, DRAIN_MS)
    })
    child.on("close", (code, signal) => {
      ended ??= { code, signal }
      finish()
    })
  })
  // `stop` and the caller may never look at a start that failed; the rejection still reaches whoever awaits `exited`.
  exited.catch(() => {})

  const stop = async (): Promise<void> => {
    if (ended === undefined && child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
      child.kill("SIGTERM")
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), stopGraceMs)
    }
    await exited.catch(() => {})
  }

  return { pid: child.pid, exited, stop }
}
