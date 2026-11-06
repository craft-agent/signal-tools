import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { ToolError } from "../core"
import { labelPaths } from "../core/signal/labels"
import { linkingFixture, type LinkingFixture } from "../core/signal/linking.testing"
import { LINKED_ACCOUNT, writeSignalCliAccount, type FakeMode } from "../core/signal/signal-cli.testing"
import { PROJECT } from "../project"
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "./cli"
import type { CommandIo } from "./command-io"
import { runLink } from "./link"

const SCAN_INSTRUCTION = "On your phone, open Signal > Settings > Linked devices > Link new device, and scan this code:"
const URI = "sgnl://linkdevice?uuid=fake-device&pub_key=fake-key"
/** The explicit white and black backgrounds the code is painted with, so it scans on any terminal theme. */
const QR_COLORS = [/\x1b\[47m/, /\x1b\[40m/]

let fixtures: LinkingFixture[] = []

afterEach(() => {
  for (const made of fixtures) made.close()
  fixtures = []
})

type Run = { code: number; stdout: string; stderr: string; t: LinkingFixture }

/** Runs `link` against the fake signal-cli in `mode`, with the fixture's state directory. */
async function link(mode: FakeMode, args: string[] = [], overrides: Partial<CommandIo> = {}): Promise<Run> {
  const t = linkingFixture(mode)
  fixtures.push(t)
  let stdout = ""
  let stderr = ""
  const code = await runLink(["--state-dir", t.stateDir, ...args], {
    env: t.fake.env,
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
    findProgram: async () => t.fake.program,
    ...overrides,
  })
  return { code, stdout, stderr, t }
}

describe("runLink", () => {
  test("prints the QR code and the next step, and never the number", async () => {
    const { code, stdout, stderr, t } = await link("link-ok")

    expect(code).toBe(EXIT_OK)
    expect(stdout).toContain(SCAN_INSTRUCTION)
    for (const color of QR_COLORS) expect(stdout).toMatch(color)
    expect(stdout).not.toContain(URI)
    expect(stdout).toContain('Linked "default".')
    expect(stdout).toContain(`Start receiving with: ${PROJECT.cli} service install --account default`)
    expect(stdout.indexOf(SCAN_INSTRUCTION)).toBeLessThan(stdout.indexOf("Linked"))
    expect(stderr).toBe("")
    expect(stdout + stderr).not.toContain(LINKED_ACCOUNT.number)
    expect(t.fake.calls()[0]?.args).toEqual(["link", "-n", PROJECT.name])
    expect(t.fake.calls()[0]?.config).toBe(labelPaths(t.stateDir, "default").signalCli)
  })

  test("takes the label and the device name, and shows the address on request", async () => {
    const { code, stdout, t } = await link("link-ok", ["--account", "work", "--device-name=Desk", "--show-uri"])

    expect(code).toBe(EXIT_OK)
    expect(stdout).toContain(`${URI}\n`)
    expect(stdout).toContain('Linked "work".')
    expect(stdout).toContain("service install --account work")
    expect(t.fake.calls()[0]?.args).toEqual(["link", "-n", "Desk"])
    expect(t.fake.calls()[0]?.config).toBe(join(t.stateDir, "work", "signal-cli"))
  })

  test("prints signal-cli's masked messages only with --verbose", async () => {
    const quiet = await link("link-ok")
    expect(quiet.stderr).toBe("")

    const loud = await link("link-ok", ["--verbose"])
    expect(loud.stderr).toBe("INFO Waiting for [number] to scan the code\n")
  })

  test("says where the keys of an unlinked device went", async () => {
    const t = linkingFixture("link-ok")
    fixtures.push(t)
    writeSignalCliAccount(t.paths.signalCli, LINKED_ACCOUNT, false)
    let stdout = ""
    const code = await runLink(["--state-dir", t.stateDir, "--account", t.paths.label], {
      env: t.fake.env,
      stdout: (text) => (stdout += text),
      stderr: () => {},
      findProgram: async () => t.fake.program,
    })

    expect(code).toBe(EXIT_OK)
    expect(stdout).toMatch(new RegExp(`moved to ${t.paths.signalCli}\\.unlinked-\\d{14}\\.\\n`))
  })

  test("reports a failure on standard error as one line and exits 1", async () => {
    const { code, stdout, stderr } = await link("link-fail")

    expect(code).toBe(EXIT_FAILED)
    expect(stderr).toBe(
      `${PROJECT.cli}: signal-cli could not link the device: Link request error: no device at [number]\n`,
    )
    expect(stdout).not.toContain("Linked")
    expect(stdout + stderr).not.toContain(LINKED_ACCOUNT.number)
  })

  test("reports a missing signal-cli", async () => {
    const { code, stderr } = await link("link-ok", [], {
      findProgram: async () => {
        throw new ToolError("not_found", "signal-cli is not installed or not on PATH; install it from somewhere.")
      },
    })
    expect(code).toBe(EXIT_FAILED)
    expect(stderr).toBe(`${PROJECT.cli}: signal-cli is not installed or not on PATH; install it from somewhere.\n`)
  })

  test("reports a cancellation", async () => {
    const { code, stderr, t } = await link("link-hang", [], { signal: AbortSignal.abort() })
    expect(code).toBe(EXIT_FAILED)
    expect(stderr).toBe(`${PROJECT.cli}: Linking was cancelled.\n`)
    expect(t.fake.calls()).toEqual([])
  })

  test("a mistake in the command line is one line on standard error and exit 2", async () => {
    const mistakes = [
      ["--account"],
      ["--account", "--show-uri"],
      ["--device-name="],
      ["--account", "Bad Label"],
      ["--show-uri=yes"],
      ["--bogus"],
      ["extra"],
      ["--read-only"],
    ]
    for (const args of mistakes) {
      const { code, stdout, stderr, t } = await link("link-ok", args)
      expect(code).toBe(EXIT_USAGE)
      expect(stdout).toBe("")
      expect(stderr).toMatch(new RegExp(`^${PROJECT.cli}: [^\\n]+\\n$`))
      expect(t.fake.calls()).toEqual([])
    }
  })
})
