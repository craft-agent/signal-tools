import { describe, expect, test } from "bun:test"
import { lstat, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ToolError } from "../errors"
import { ensureLabelDir, labelPaths } from "./labels"
import { removeLabel } from "./removal"

describe("removeLabel", () => {
  test("throws not_found when label does not exist", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "sig-"))
    try {
      let uninstalled = false
      const error = await removeLabel({
        stateDir,
        label: "nonexistent",
        uninstall: async () => {
          uninstalled = true
        },
      }).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(ToolError)
      expect((error as ToolError).code).toBe("not_found")
      expect(uninstalled).toBe(false)
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test("refuses when label directory is a symlink", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "sig-"))
    const targetDir = await mkdtemp(join(tmpdir(), "sig-target-"))
    try {
      const linkPath = join(stateDir, "linklabel")
      await symlink(targetDir, linkPath)

      const error = await removeLabel({
        stateDir,
        label: "linklabel",
        uninstall: async () => {},
      }).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(ToolError)
      expect((error as ToolError).code).toBe("invalid_argument")
      expect((error as ToolError).message).toContain("is not a directory")
    } finally {
      await rm(stateDir, { recursive: true, force: true })
      await rm(targetDir, { recursive: true, force: true })
    }
  })

  test("refuses when daemon process is still running after polling", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "sig-"))
    try {
      const paths = await ensureLabelDir(stateDir, "work")
      // Current process PID is alive
      await writeFile(paths.daemonPid, `${process.pid}\n`, "utf8")

      let uninstalled = false
      const start = Date.now()
      const error = await removeLabel({
        stateDir,
        label: "work",
        uninstall: async () => {
          uninstalled = true
        },
        pollTimeoutMs: 50,
        pollIntervalMs: 10,
      }).catch((e: unknown) => e)

      expect(Date.now() - start).toBeGreaterThanOrEqual(40)
      expect(uninstalled).toBe(true)
      expect(error).toBeInstanceOf(ToolError)
      expect((error as ToolError).code).toBe("invalid_argument")
      expect((error as ToolError).message).toBe("The sync service for this label is still running; stop it first.")
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test("refuses while the sync lock names a live process, and removes once it is gone", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "sig-"))
    try {
      const paths = await ensureLabelDir(stateDir, "work")
      await writeFile(paths.syncLock, `${process.pid}\n`, "utf8")
      const options = { stateDir, label: "work", uninstall: async () => {}, pollTimeoutMs: 50, pollIntervalMs: 10 }

      const error = await removeLabel(options).catch((e: unknown) => e)
      expect((error as ToolError).message).toBe("The sync service for this label is still running; stop it first.")

      await rm(paths.syncLock)
      await removeLabel(options)
      await expect(lstat(paths.dir)).rejects.toThrow()
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test("removes label directory successfully when daemon stops during uninstall", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "sig-"))
    try {
      const paths = await ensureLabelDir(stateDir, "work")
      await writeFile(paths.daemonPid, `${process.pid}\n`, "utf8")

      let uninstalled = false
      await removeLabel({
        stateDir,
        label: "work",
        uninstall: async () => {
          uninstalled = true
          await rm(paths.daemonPid, { force: true })
        },
        pollTimeoutMs: 100,
        pollIntervalMs: 10,
      })

      expect(uninstalled).toBe(true)
      const exists = await ensureLabelDir(stateDir, "work")
        .then(() => false)
        .catch(() => true)
      // Since it was removed, directory does not exist initially
      expect(exists).toBe(false)
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test("removes label directory and all contents recursively", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "sig-"))
    try {
      const paths = await ensureLabelDir(stateDir, "default")
      await writeFile(join(paths.dir, "somefile.txt"), "hello", "utf8")

      let uninstalled = false
      await removeLabel({
        stateDir,
        label: "default",
        uninstall: async () => {
          uninstalled = true
        },
      })

      expect(uninstalled).toBe(true)
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })
})
