import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ToolError } from "../errors"
import { readLinkedAccount } from "./account"
import { labelPaths, type LabelPaths } from "./labels"
import { makeTempDir } from "./mirror.testing"
import { LINKED_ACCOUNT, OTHER_ACCOUNT, writeSignalCliAccount } from "./signal-cli.testing"

let stateDir: string
let paths: LabelPaths
let dataDir: string

beforeEach(() => {
  stateDir = makeTempDir()
  paths = labelPaths(stateDir, "main")
  dataDir = join(paths.signalCli, "data")
})

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

/** Writes an accounts file naming `entries`, and a keys file `100001` holding `keys`. */
function writeAccounts(entries: unknown[], keys: unknown = { registered: true }) {
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, "accounts.json"), JSON.stringify({ accounts: entries, version: 2 }))
  writeFileSync(join(dataDir, "100001"), typeof keys === "string" ? keys : JSON.stringify(keys))
}

const entry = { path: "100001", environment: "LIVE", number: LINKED_ACCOUNT.number, uuid: LINKED_ACCOUNT.uuid }

describe("readLinkedAccount", () => {
  test("is null when signal-cli holds nothing", () => {
    expect(readLinkedAccount(paths)).toBeNull()
    mkdirSync(dataDir, { recursive: true })
    expect(readLinkedAccount(paths)).toBeNull()
  })

  test("reads a registered account", () => {
    writeSignalCliAccount(paths.signalCli, LINKED_ACCOUNT)
    expect(readLinkedAccount(paths)).toEqual({ ...LINKED_ACCOUNT, registered: true })
  })

  test("reads an account Signal has unlinked", () => {
    writeSignalCliAccount(paths.signalCli, LINKED_ACCOUNT, false)
    expect(readLinkedAccount(paths)?.registered).toBe(false)
  })

  test("leaves registered unknown when the keys file does not say", () => {
    writeSignalCliAccount(paths.signalCli, LINKED_ACCOUNT, null)
    expect(readLinkedAccount(paths)).toEqual({ ...LINKED_ACCOUNT, registered: null })
  })

  test("lowercases the uuid and drops one that is not a uuid", () => {
    writeAccounts([{ ...entry, uuid: LINKED_ACCOUNT.uuid.toUpperCase() }])
    expect(readLinkedAccount(paths)?.uuid).toBe(LINKED_ACCOUNT.uuid)
    writeAccounts([{ ...entry, uuid: "not-a-uuid" }])
    expect(readLinkedAccount(paths)?.uuid).toBeNull()
  })

  test("refuses more than one account without naming a number", () => {
    writeAccounts([entry, { ...entry, number: OTHER_ACCOUNT.number, uuid: OTHER_ACCOUNT.uuid }])
    let error: unknown
    try {
      readLinkedAccount(paths)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(ToolError)
    expect((error as ToolError).code).toBe("upstream_error")
    expect((error as ToolError).message).toBe("signal-cli holds more than one account in this label's directory.")
  })

  test("is null when the path of the keys file is not a plain file name", () => {
    for (const path of ["../outside", "sub/100001", ".hidden", "..", "", "a\\b", 7, undefined]) {
      writeAccounts([{ ...entry, path }])
      expect(readLinkedAccount(paths)).toBeNull()
    }
  })

  test("is null when a file is missing, unreadable or malformed", () => {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, "accounts.json"), "{ not json")
    expect(readLinkedAccount(paths)).toBeNull()

    writeFileSync(join(dataDir, "accounts.json"), JSON.stringify({ accounts: [entry], version: 2 }))
    expect(readLinkedAccount(paths)).toBeNull() // the keys file is missing

    writeAccounts([entry], "{ not json")
    expect(readLinkedAccount(paths)).toBeNull()

    for (const index of [[], { accounts: "x" }, { accounts: [null] }, { accounts: [{ ...entry, number: 5 }] }]) {
      writeAccounts([], {})
      writeFileSync(join(dataDir, "accounts.json"), JSON.stringify(index))
      expect(readLinkedAccount(paths)).toBeNull()
    }
  })

  test("is null when the keys file is a directory", () => {
    writeAccounts([entry])
    rmSync(join(dataDir, "100001"))
    mkdirSync(join(dataDir, "100001"))
    expect(readLinkedAccount(paths)).toBeNull()
  })
})
