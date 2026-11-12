import { describe, expect, test } from "bun:test"
import { parseSettings, parseToolSettings } from "./settings"
import { failure, profile } from "./settings.testing"

const parse = (argv: string[], env: Record<string, string | undefined> = {}) => parseSettings(argv, env, profile)

describe("the send_dirs setting", () => {
  test("is empty by default", () => {
    expect(parse([]).send_dirs).toEqual([])
  })

  test("is comma-separated in a flag and a variable, dropping empty items", () => {
    expect(parse(["--send-dirs", "/a, /b,,"]).send_dirs).toEqual(["/a", "/b"])
    expect(parse([], { DEMO_SEND_DIRS: ",/a,/b" }).send_dirs).toEqual(["/a", "/b"])
  })

  test("expands ~ in each entry", () => {
    expect(parse(["--send-dirs", "~/a,~"], { HOME: "/home/user" }).send_dirs).toEqual(["/home/user/a", "/home/user"])
  })

  test("a flag wins over its variable as a whole, not item by item", () => {
    expect(parse(["--send-dirs=/flag"], { DEMO_SEND_DIRS: "/env/a,/env/b" }).send_dirs).toEqual(["/flag"])
  })

  test("refuses a relative entry in a flag or a variable, naming where it came from", () => {
    expect(failure(() => parse(["--send-dirs", "/a,rel/path"])).message).toContain("--send-dirs")
    expect(failure(() => parse([], { DEMO_SEND_DIRS: "rel/path" })).message).toContain("DEMO_SEND_DIRS")
  })

  test("a flag without a value is refused, naming it", () => {
    expect(failure(() => parse(["--send-dirs"])).message).toContain("--send-dirs")
  })

  test("the tool settings parser reads it too", () => {
    expect(parseToolSettings(["--send-dirs=/a"], {}, profile).send_dirs).toEqual(["/a"])
    expect(parseToolSettings([], { DEMO_SEND_DIRS: "/a,/b" }, profile).send_dirs).toEqual(["/a", "/b"])
  })

  test("a blank value counts as unset in a flag as in a variable", () => {
    expect(parse(["--send-dirs= , "], { DEMO_SEND_DIRS: "/env" }).send_dirs).toEqual([])
    expect(parse(["--send-dirs="], { DEMO_SEND_DIRS: "/env" }).send_dirs).toEqual([])
  })
})
