import { isToolError } from "../core"
import { checkLabel } from "../core/signal/labels"
import { removeLabel } from "../core/signal/removal"
import { defaultServiceHost, removeServiceLog, uninstallService } from "../core/signal/service"
import { handleCommandError, parseCommandStateDir, parseFlagArgs, printCommandError, usageError } from "./command-args"
import { defaultReadLine, EXIT_FAILED, EXIT_OK, EXIT_USAGE, type CommandIo } from "./command-io"
import { SERVICE_ID, SERVICE_NAME } from "./service"

type RemoveArgs = {
  label: string
  yes: boolean
  stateDir: string
}

function parseRemoveArgs(argv: string[], io: CommandIo): RemoveArgs {
  const args = argv[0] === "remove" ? argv.slice(1) : argv
  const { values, switches, rest } = parseFlagArgs(args, {
    values: ["--account"],
    switches: ["--yes"],
  })
  const stateDir = parseCommandStateDir(rest, io)

  const account = values["--account"]
  if (account === undefined) {
    throw usageError("Option --account is required.")
  }

  return {
    label: checkLabel(account),
    yes: switches.has("--yes"),
    stateDir,
  }
}

/**
 * Runs the `remove` command to permanently delete an account's state directory.
 */
export async function runRemoveCommand(argv: string[], io: CommandIo): Promise<number> {
  let parsed: RemoveArgs
  try {
    parsed = parseRemoveArgs(argv, io)
  } catch (error) {
    return handleCommandError(error, io, { mode: "usage" })
  }

  const { label, yes, stateDir } = parsed

  if (!yes) {
    const isTTY = io.isTTY ?? Boolean(process.stdin.isTTY)
    if (!isTTY) {
      printCommandError(io, "Removing an account without a terminal requires --yes.")
      return EXIT_USAGE
    }

    io.stdout(
      `This will permanently delete the keys, signal-cli data, received message history, and service log for "${label}".\n`,
    )
    const prompt = `To confirm, please type the label name "${label}": `
    const readLine = io.readLine ?? defaultReadLine
    const answer = await readLine(prompt)
    if (answer?.trim() !== label) {
      printCommandError(io, "Removal cancelled.")
      return EXIT_FAILED
    }
  }

  try {
    const host = io.serviceHost ?? defaultServiceHost()
    await removeLabel({
      stateDir,
      label,
      uninstall: async () => {
        try {
          await uninstallService(SERVICE_NAME, label, host)
        } catch (error) {
          // On unsupported platforms, services cannot be installed so removal may proceed.
          if (isToolError(error) && error.code === "invalid_argument") {
            return
          }
          throw error
        }
      },
    })
    await removeServiceLog(SERVICE_ID, label, host)

    io.stdout(
      `Removed "${label}". Also remove this device on the phone (Signal > Settings > Linked devices): a linked device cannot remove itself.\n`,
    )
    return EXIT_OK
  } catch (error) {
    return handleCommandError(error, io, { abortMessage: "Removal was cancelled." })
  }
}
