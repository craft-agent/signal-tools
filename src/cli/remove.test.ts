import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureLabelDir, listLabels } from "../core/signal/labels"
import type { ServiceHost } from "../core/signal/service"
import { PROJECT } from "../project"
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "./command-io"
import { runRemoveCommand } from "./remove"
import { SERVICE_ID } from "./service"

function fakeHost(home: string): ServiceHost {
  return {
    platform: "darwin",
    home,
    uid: 501,
    env: { PATH: "/bin" },
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
  }
}

describe("CLI remove", () => {
  test("requires --account", async () => {
    let stderr = ""
    const code = await runRemoveCommand([], {
      env: {},
      stdout: () => {},
      stderr: (t) => (stderr += t),
    })

    expect(code).toBe(EXIT_USAGE)
    expect(stderr).toBe(`${PROJECT.cli}: Option --account is required.\n`)
  })

  test("refuses without --yes on non-TTY", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sig-"))
    try {
      await ensureLabelDir(dir, "work")

      let stderr = ""
      const code = await runRemoveCommand(["--account", "work", "--state-dir", dir], {
        env: {},
        isTTY: false,
        stdout: () => {},
        stderr: (t) => (stderr += t),
      })

      expect(code).toBe(EXIT_USAGE)
      expect(stderr).toBe(`${PROJECT.cli}: Removing an account without a terminal requires --yes.\n`)
      expect(await listLabels(dir)).toEqual(["work"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("confirms with prompt match on TTY and removes label", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sig-"))
    try {
      await ensureLabelDir(dir, "work")

      let stdout = ""
      let stderr = ""
      let askedPrompt = ""
      const code = await runRemoveCommand(["--account", "work", "--state-dir", dir], {
        env: {},
        isTTY: true,
        readLine: async (p) => {
          askedPrompt = p
          return "work"
        },
        stdout: (t) => (stdout += t),
        stderr: (t) => (stderr += t),
        serviceHost: fakeHost(dir),
      })

      expect(code).toBe(EXIT_OK)
      expect(askedPrompt).toContain('To confirm, please type the label name "work": ')
      expect(stdout).toContain(
        'Removed "work". Also remove this device on the phone (Signal > Settings > Linked devices): a linked device cannot remove itself.\n',
      )
      expect(stderr).toBe("")
      expect(await listLabels(dir)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("deletes the service log along with the label", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sig-"))
    try {
      await ensureLabelDir(dir, "work")
      const logDir = join(dir, "Library", "Logs", SERVICE_ID)
      await mkdir(logDir, { recursive: true })
      await writeFile(join(logDir, "work.log"), "x")

      const code = await runRemoveCommand(["--account", "work", "--yes", "--state-dir", dir], {
        env: {},
        isTTY: false,
        stdout: () => {},
        stderr: () => {},
        serviceHost: fakeHost(dir),
      })

      expect(code).toBe(EXIT_OK)
      expect(await stat(logDir).catch(() => undefined)).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("cancels on confirmation mismatch on TTY leaving files untouched", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sig-"))
    try {
      await ensureLabelDir(dir, "work")

      let stdout = ""
      let stderr = ""
      const code = await runRemoveCommand(["--account", "work", "--state-dir", dir], {
        env: {},
        isTTY: true,
        readLine: async () => "wrong",
        stdout: (t) => (stdout += t),
        stderr: (t) => (stderr += t),
        serviceHost: fakeHost(dir),
      })

      expect(code).toBe(EXIT_FAILED)
      expect(stderr).toBe(`${PROJECT.cli}: Removal cancelled.\n`)
      expect(await listLabels(dir)).toEqual(["work"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("removes label directly when --yes is supplied", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sig-"))
    try {
      await ensureLabelDir(dir, "work")

      let stdout = ""
      let stderr = ""
      const code = await runRemoveCommand(["--account", "work", "--yes", "--state-dir", dir], {
        env: {},
        isTTY: false,
        stdout: (t) => (stdout += t),
        stderr: (t) => (stderr += t),
        serviceHost: fakeHost(dir),
      })

      expect(code).toBe(EXIT_OK)
      expect(stdout).toContain('Removed "work".')
      expect(stderr).toBe("")
      expect(await listLabels(dir)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("stops removal and deletes nothing on supervisor uninstall failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sig-"))
    try {
      await ensureLabelDir(dir, "work")

      let stderr = ""
      const failingHost: ServiceHost = {
        platform: "darwin",
        home: dir,
        uid: 501,
        env: { PATH: "/bin" },
        run: async () => ({ code: 1, stdout: "", stderr: "launchctl bootout: Operation not permitted" }),
      }

      const code = await runRemoveCommand(["--account", "work", "--yes", "--state-dir", dir], {
        env: {},
        isTTY: false,
        stdout: () => {},
        stderr: (t) => (stderr += t),
        serviceHost: failingHost,
      })

      expect(code).toBe(EXIT_FAILED)
      expect(stderr).toContain("launchctl failed: launchctl bootout: Operation not permitted")
      expect(await listLabels(dir)).toEqual(["work"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("allows removal to proceed when services are unsupported on the platform", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sig-"))
    try {
      await ensureLabelDir(dir, "work")

      let stdout = ""
      let stderr = ""
      const winHost: ServiceHost = {
        platform: "win32",
        home: "C:\\Users\\test",
        uid: 0,
        env: {},
        run: async () => ({ code: 0, stdout: "", stderr: "" }),
      }

      const code = await runRemoveCommand(["--account", "work", "--yes", "--state-dir", dir], {
        env: {},
        isTTY: false,
        stdout: (t) => (stdout += t),
        stderr: (t) => (stderr += t),
        serviceHost: winHost,
      })

      expect(code).toBe(EXIT_OK)
      expect(stdout).toContain('Removed "work".')
      expect(stderr).toBe("")
      expect(await listLabels(dir)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
