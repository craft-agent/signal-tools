import { renderANSI } from "uqr"
import { DEFAULT_LABEL, checkLabel } from "../core/signal/labels"
import { linkDevice } from "../core/signal/linking"
import { findSignalCli } from "../core/signal/signal-cli"
import { PROJECT } from "../project"
import { handleCommandError, parseCommandStateDir, parseFlagArgs } from "./command-args"
import { EXIT_OK, type CommandIo } from "./command-io"

const SCAN_INSTRUCTION = "On your phone, open Signal > Settings > Linked devices > Link new device, and scan this code:"

/** Light modules around the code, which a scanner needs; uqr's ANSI renderer paints them white on any theme. */
const QR_BORDER = 2

type ValueFlag = "--account" | "--device-name"
type SwitchFlag = "--show-uri" | "--verbose"

const VALUE_FLAGS: readonly ValueFlag[] = ["--account", "--device-name"]
const SWITCH_FLAGS: readonly SwitchFlag[] = ["--show-uri", "--verbose"]

type LinkCommand = {
  label: string
  deviceName: string
  stateDir: string
  showUri: boolean
  verbose: boolean
}

/** Reads the command line: the flags of `link` itself, and the settings flags, of which only the state directory is taken. */
function parseLink(argv: string[], io: CommandIo): LinkCommand {
  const { values, switches, rest } = parseFlagArgs(argv, { values: VALUE_FLAGS, switches: SWITCH_FLAGS })
  return {
    label: checkLabel(values["--account"] ?? DEFAULT_LABEL),
    deviceName: values["--device-name"] ?? PROJECT.name,
    stateDir: parseCommandStateDir(rest, io),
    showUri: switches.has("--show-uri"),
    verbose: switches.has("--verbose"),
  }
}

function endWithLineBreak(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`
}

/**
 * The `link` command: links this machine as a device of the person's phone
 * under a label (`--account`, `default` without it), after the person scans
 * the QR code it prints. `--device-name` is the name the phone lists the
 * device under, `--show-uri` also prints the address the code stands for, and
 * `--verbose` prints signal-cli's own messages. Resolves to the exit code.
 */
export async function runLink(argv: string[], io: CommandIo): Promise<number> {
  let command: LinkCommand
  try {
    command = parseLink(argv, io)
  } catch (error) {
    return handleCommandError(error, io, { mode: "usage" })
  }

  try {
    const result = await linkDevice({
      stateDir: command.stateDir,
      label: command.label,
      deviceName: command.deviceName,
      program: await (io.findProgram ?? findSignalCli)(io.env),
      env: io.env,
      signal: io.signal,
      onLinkUri(uri) {
        io.stdout(`${SCAN_INSTRUCTION}\n\n${endWithLineBreak(renderANSI(uri, { border: QR_BORDER }))}`)
        if (command.showUri) io.stdout(`\n${uri}\n`)
      },
      log: command.verbose ? (line) => io.stderr(`${line}\n`) : undefined,
    })
    io.stdout(`\nLinked "${result.label}".\n`)
    if (result.movedAside) io.stdout(`The keys of the earlier, unlinked device were moved to ${result.movedAside}.\n`)
    io.stdout(`Start receiving with: ${PROJECT.cli} service install --account ${result.label}\n`)
    return EXIT_OK
  } catch (error) {
    return handleCommandError(error, io, { abortMessage: "Linking was cancelled." })
  }
}
