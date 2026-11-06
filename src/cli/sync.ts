import { isToolError } from "../core"
import { pickLabel } from "../core/signal/labels"
import { findSignalCli } from "../core/signal/signal-cli"
import { runSync } from "../core/signal/sync"
import { NOT_LINKED_MESSAGE } from "../core/signal/sync-status"
import { handleCommandError, parseCommandStateDir, parseFlagArgs } from "./command-args"
import { EXIT_OK, type CommandIo } from "./command-io"

const ACCOUNT_FLAG = "--account"

type SyncCommand = {
  label: string
  stateDir: string
}

/** Reads the command line: `--account` and the settings flags, of which only the state directory is taken. */
async function parseSync(argv: string[], io: CommandIo): Promise<SyncCommand> {
  const { values, rest } = parseFlagArgs(argv, { values: [ACCOUNT_FLAG] })
  const stateDir = parseCommandStateDir(rest, io)
  return { label: (await pickLabel(stateDir, values[ACCOUNT_FLAG])).label, stateDir }
}

/** `<time> <line>` on one line of standard error, for a service's log. */
function logLine(io: CommandIo): (line: string) => void {
  return (line) => io.stderr(`${new Date().toISOString()} ${line}\n`)
}

/**
 * The `sync` command: runs the sync service of one account in the foreground
 * (`--account`, or the only linked one): it keeps the account's mirror
 * current until it is stopped, and logs to standard error. Resolves to the
 * exit code: 0 on a stop request and when there is nothing to run (no linked
 * account, or Signal unlinked the device), 1 after any other failure, 2 for
 * a mistake in the command line (several accounts without `--account`
 * included).
 */
export async function runSyncCommand(argv: string[], io: CommandIo): Promise<number> {
  let command: SyncCommand
  try {
    command = await parseSync(argv, io)
  } catch (error) {
    // No such account is "not linked", which is nothing to run, not a failure to restart.
    if (isToolError(error) && error.code === "not_found") {
      logLine(io)(NOT_LINKED_MESSAGE)
      return EXIT_OK
    }
    return handleCommandError(error, io, { mode: "auto" })
  }

  try {
    const outcome = await runSync({
      stateDir: command.stateDir,
      label: command.label,
      program: await (io.findProgram ?? findSignalCli)(io.env),
      env: io.env,
      signal: io.signal,
      log: logLine(io),
    })
    return outcome.exitCode
  } catch (error) {
    return handleCommandError(error, io)
  }
}
