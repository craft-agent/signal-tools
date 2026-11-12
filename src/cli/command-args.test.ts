import { describe, expect, test } from "bun:test"
import { failure } from "../entry/settings.testing"
import { parseCommandStateDir } from "./command-args"
import { PROFILE } from "./testing"

const stateDir = (rest: string[], env: Record<string, string | undefined> = {}) =>
  parseCommandStateDir(rest, { env, profile: PROFILE, stdout() {}, stderr() {} })

describe("parseCommandStateDir", () => {
  test("reads the state directory from a flag or the variable, the flag winning", () => {
    expect(stateDir(["--state-dir", "/flag/state"], { DEMO_STATE_DIR: "/env/state" })).toBe("/flag/state")
    expect(stateDir(["--state-dir=/flag/state"])).toBe("/flag/state")
    expect(stateDir([], { DEMO_STATE_DIR: "/env/state" })).toBe("/env/state")
  })

  test("expands ~ and falls back to the default when none or a blank one is given", () => {
    const env = { HOME: "/home/user" }
    expect(stateDir(["--state-dir=~/state"], env)).toBe("/home/user/state")
    expect(stateDir([], env)).toBe("/home/user/.local/state/demo-tools")
    expect(stateDir(["--state-dir= "], { ...env, DEMO_STATE_DIR: "/env/state" })).toBe(
      "/home/user/.local/state/demo-tools",
    )
    expect(stateDir([], { ...env, XDG_STATE_HOME: "/xdg" })).toBe("/xdg/demo-tools")
  })

  test("refuses a relative state directory, naming where it came from", () => {
    expect(failure(() => stateDir(["--state-dir=rel/path"])).message).toBe("--state-dir must be an absolute path.")
    expect(failure(() => stateDir([], { DEMO_STATE_DIR: "rel/path" })).message).toBe(
      "DEMO_STATE_DIR must be an absolute path.",
    )
  })

  test("takes no other setting, whatever its kind", () => {
    for (const rest of [
      ["--download-dir=/d"],
      ["--send-dirs", "/a"],
      ["--note-text", "x"],
      ["--read-only"],
      ["--tools", "a"],
      ["--confirm=harness"],
    ]) {
      expect(failure(() => stateDir(rest)).message).toStartWith(`Unknown option "${rest[0]!.split("=")[0]}`)
    }
  })

  test("ignores the variables of the settings it does not take, even a bad one", () => {
    expect(stateDir([], { DEMO_DOWNLOAD_DIR: "rel", DEMO_SEND_DIRS: "rel", DEMO_NOTE_TEXT: "x" })).toBe(stateDir([]))
  })
})
