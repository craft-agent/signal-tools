import { writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { exec } from "../exec"
import { DaemonConnection } from "./daemon"
import type { LabelPaths } from "./labels"
import { signalCliArgs, signalCliEnv, spawnSignalCli, type SignalCliExit, type SignalCliProcess } from "./signal-cli"
import type { Ended } from "./sync-ending"
import { errorText } from "./sync-status"
import { isAlive, onAbort, readPid, sleep } from "./sync-wait"

/** How many of signal-cli's last lines of standard error are kept to tell why it ended. */
const STDERR_TAIL_LINES = 60

/** Owner read and write only, like the rest of the label's state. */
const PIDFILE_MODE = 0o600

/** How often the socket is tried while the daemon starts. */
const SOCKET_POLL_MS = 500
/** How long one try to connect to the socket may take. */
const CONNECT_TIMEOUT_MS = 2_000

/** How often a signal-cli left by an earlier run is looked at while it stops. */
const STALE_POLL_MS = 100
/** How long a stale daemon may take to be gone after SIGKILL. */
const STALE_KILL_WAIT_MS = 5_000
/** How long `ps` may take to name a process's command. */
const PS_TIMEOUT_MS = 5_000
/** `ps` is run with nothing but where to find it. */
const PS_ENV = { PATH: "/bin:/usr/bin" }

export type DaemonStart = {
  program: string
  env: Record<string, string | undefined>
  paths: LabelPaths
  /** The account's number, for signal-cli's `-a`; it reaches nothing else. */
  number: string
  /** Receives each line of signal-cli's standard error, masked, as `signal-cli: <line>`. */
  log(line: string): void
  stopGraceMs: number
}

/** The signal-cli daemon this run owns: its pid is in the label's pid file for as long as it runs. */
export class Daemon {
  /** The last lines of its standard error, masked. */
  readonly tail: readonly string[]
  /** How it ended, once it did. */
  exit: SignalCliExit | undefined
  /** Why it could not be started, when it could not. */
  startError: string | undefined
  /** Settles once it ended and its output was read; never rejects. */
  readonly ended: Promise<void>
  private readonly child: SignalCliProcess

  constructor(child: SignalCliProcess, tail: readonly string[]) {
    this.child = child
    this.tail = tail
    this.ended = child.exited.then(
      (exit) => {
        this.exit = exit
      },
      (error: unknown) => {
        this.startError = errorText(error)
      },
    )
  }

  /** Sends SIGTERM (SIGKILL after the grace period) and resolves once it is gone. Safe to call again. */
  stop(): Promise<void> {
    return this.child.stop()
  }
}

/**
 * Starts the label's daemon with manual receiving, and writes its pid to the
 * pid file. A daemon whose pid cannot be recorded is stopped again, so none
 * runs unrecorded.
 */
export async function startDaemon({ program, env, paths, number, log, stopGraceMs }: DaemonStart): Promise<Daemon> {
  const tail: string[] = []
  const args = signalCliArgs(
    paths,
    "-a",
    number,
    "daemon",
    "--socket",
    paths.socket,
    "--receive-mode",
    "manual",
    "--no-receive-stdout",
    "--ignore-stories",
    "--ignore-avatars",
    "--ignore-stickers",
  )
  const child = spawnSignalCli(program, args, {
    env: signalCliEnv(env),
    stopGraceMs,
    onStderrLine(line) {
      tail.push(line)
      if (tail.length > STDERR_TAIL_LINES) tail.shift()
      log(`signal-cli: ${line}`)
    },
  })
  const daemon = new Daemon(child, tail)
  try {
    if (child.pid !== undefined) writeFileSync(paths.daemonPid, `${child.pid}\n`, { mode: PIDFILE_MODE })
  } catch (error) {
    await child.stop()
    throw error
  }
  return daemon
}

/** Removes the files of a daemon that is gone: its socket and the pid file. */
export async function removeDaemonFiles(paths: LabelPaths): Promise<void> {
  await Promise.all([rm(paths.socket, { force: true }), rm(paths.daemonPid, { force: true })]).catch(() => {})
}

/**
 * Connects to the daemon's socket, trying every half second, until it
 * connects, the daemon ends, `waitMs` passes or `signal` (a stop request) aborts.
 */
export async function connectWhenReady(
  daemon: Daemon,
  socketPath: string,
  waitMs: number,
  signal: AbortSignal | undefined,
): Promise<DaemonConnection | Ended> {
  const giveUp = new AbortController()
  const timer = setTimeout(() => giveUp.abort(), waitMs)
  const stopListening = onAbort(signal, () => giveUp.abort())
  void daemon.ended.then(() => giveUp.abort())
  try {
    while (!giveUp.signal.aborted) {
      try {
        return await DaemonConnection.connect(socketPath, { signal: giveUp.signal, timeoutMs: CONNECT_TIMEOUT_MS })
      } catch {
        await sleep(SOCKET_POLL_MS, giveUp.signal)
      }
    }
  } finally {
    clearTimeout(timer)
    stopListening()
  }
  if (signal?.aborted) return { kind: "stop" }
  if (daemon.exit || daemon.startError) return { kind: "child" }
  return { kind: "socket", reason: "the daemon's socket never opened" }
}

/** Whether `command` names `config` as an argument of its own, not as the start of a longer path. */
function namesConfig(command: string, config: string): boolean {
  for (let at = command.indexOf(config); at !== -1; at = command.indexOf(config, at + 1)) {
    const next = command[at + config.length]
    if (next === undefined || /\s/.test(next)) return true
  }
  return false
}

/** Whether the process runs with this signal-cli configuration directory. */
async function runsWithConfig(pid: number, config: string): Promise<boolean> {
  try {
    const result = await exec(["ps", "-o", "command=", "-p", String(pid)], { env: PS_ENV, timeoutMs: PS_TIMEOUT_MS })
    return result.code === 0 && namesConfig(result.stdout, config)
  } catch {
    return false
  }
}

/** Resolves true once the process is gone, false when it is still there after `ms`. */
async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (isAlive(pid)) {
    if (Date.now() >= deadline) return false
    await sleep(STALE_POLL_MS)
  }
  return true
}

function signalProcess(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal)
    return true
  } catch {
    return false
  }
}

/**
 * Stops a daemon left running by an earlier run: the pid file names a live
 * process whose command line holds this label's signal-cli directory. Any
 * other pid is not touched. SIGTERM first, SIGKILL after `graceMs`.
 */
export async function stopStaleDaemon(paths: LabelPaths, graceMs: number, log: (line: string) => void): Promise<void> {
  const pid = readPid(paths.daemonPid)
  if (pid === undefined || pid === process.pid || !isAlive(pid)) return
  if (!(await runsWithConfig(pid, paths.signalCli))) {
    log("the pid file names a process that is not this account's daemon; leaving it alone")
    return
  }
  log("stopping a daemon left by an earlier run")
  if (!signalProcess(pid, "SIGTERM") || (await goneWithin(pid, graceMs))) return
  if (signalProcess(pid, "SIGKILL")) await goneWithin(pid, STALE_KILL_WAIT_MS)
}
