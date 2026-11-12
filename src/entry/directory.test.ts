import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { resolveDirectorySettings, toolDirectories } from "./directory"
import type { EntryProfile } from "./profile"

const profile: EntryProfile = {
  name: "demo-tools",
  envPrefix: "DEMO",
  toolsets: { names: ["alpha"], defaults: ["alpha"] },
}

describe("resolveDirectorySettings", () => {
  describe("when the options give a directory", () => {
    test("returns it as given, whatever the environment says", () => {
      const options = { state_dir: "/var/state", download_dir: "/var/files", send_dirs: ["/var/a", "/var/b"] }
      expect(resolveDirectorySettings(options, { XDG_STATE_HOME: "/xdg", HOME: "/home/user" }, profile)).toEqual(
        options,
      )
    })

    test("ignores values that are not of the declared type", () => {
      const options = { state_dir: true, download_dir: 3, send_dirs: "/a" }
      expect(resolveDirectorySettings(options, { HOME: "/home/user" }, profile)).toEqual({
        state_dir: "/home/user/.local/state/demo-tools",
        download_dir: "/home/user/Downloads/demo-tools",
        send_dirs: [],
      })
    })
  })

  describe("state_dir when not given", () => {
    test("uses $XDG_STATE_HOME/<profile.name> when XDG_STATE_HOME is absolute", () => {
      const env = { XDG_STATE_HOME: "/xdg/state", HOME: "/home/user" }
      expect(resolveDirectorySettings({}, env, profile).state_dir).toBe(resolve("/xdg/state", "demo-tools"))
    })

    test("ignores relative XDG_STATE_HOME and falls back to <home>/.local/state/<profile.name>", () => {
      const env = { XDG_STATE_HOME: "relative/xdg", HOME: "/home/user" }
      expect(resolveDirectorySettings({}, env, profile).state_dir).toBe("/home/user/.local/state/demo-tools")
    })

    test("uses <home>/.local/state/<profile.name> when XDG_STATE_HOME is unset", () => {
      expect(resolveDirectorySettings({}, { HOME: "/home/user" }, profile).state_dir).toBe(
        "/home/user/.local/state/demo-tools",
      )
    })

    test("falls back to homedir() when HOME is unset or relative", () => {
      const expected = resolve(homedir(), ".local", "state", "demo-tools")
      expect(resolveDirectorySettings({}, {}, profile).state_dir).toBe(expected)
      expect(resolveDirectorySettings({}, { HOME: "relative/home" }, profile).state_dir).toBe(expected)
    })
  })

  describe("download_dir when not given", () => {
    test("defaults to <home>/Downloads/<profile.name>", () => {
      expect(resolveDirectorySettings({}, { HOME: "/home/user" }, profile).download_dir).toBe(
        "/home/user/Downloads/demo-tools",
      )
    })

    test("falls back to homedir() when HOME is unset or relative", () => {
      const expected = resolve(homedir(), "Downloads", "demo-tools")
      expect(resolveDirectorySettings({}, {}, profile).download_dir).toBe(expected)
      expect(resolveDirectorySettings({}, { HOME: "relative/home" }, profile).download_dir).toBe(expected)
    })
  })

  test("send_dirs is empty when not given, and a copy of the list when given", () => {
    expect(resolveDirectorySettings({}, { HOME: "/home/user" }, profile).send_dirs).toEqual([])
    const given = ["/a"]
    const sendDirs = resolveDirectorySettings({ send_dirs: given }, {}, profile).send_dirs
    expect(sendDirs).toEqual(["/a"])
    expect(sendDirs).not.toBe(given)
  })
})

describe("toolDirectories", () => {
  test("maps the settings to the properties of ToolContext", () => {
    expect(toolDirectories({ state_dir: "/s", download_dir: "/d", send_dirs: ["/a"] })).toEqual({
      stateDir: "/s",
      downloadDir: "/d",
      sendDirs: ["/a"],
    })
  })
})
