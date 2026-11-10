import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureLabelDir, labelPaths } from "../core/signal/labels"
import type { ServiceHost } from "../core/signal/service"
import { LINKED_ACCOUNT, writeSignalCliAccount } from "../core/signal/signal-cli.testing"
import { PROJECT } from "../project"
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, type CommandIo } from "./command-io"
import { runServiceCommand, SERVICE_ID, SERVICE_LAUNCHER } from "./service"

function fakeHost(home: string, overrides: Partial<ServiceHost> = {}): ServiceHost {
  return {
    platform: "darwin",
    home,
    uid: 501,
    env: { PATH: "/bin" },
    sleep: async () => {},
    run: async (argv) =>
      argv[1] === "print"
        ? { code: 113, stdout: "", stderr: "Could not find service" }
        : { code: 0, stdout: "", stderr: "" },
    ...overrides,
  }
}

describe("CLI service", () => {
  test("picks the only linked label when --account is absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sig-"))
    try {
      const paths = await ensureLabelDir(dir, "default")
      writeSignalCliAccount(paths.signalCli, LINKED_ACCOUNT, true)

      let stdout = ""
      let stderr = ""
      const code = await runServiceCommand(["install", "--state-dir", dir], {
        env: {},
        stdout: (t) => (stdout += t),
        stderr: (t) => (stderr += t),
        serviceHost: fakeHost(dir),
        self: { program: "/bin/node", script: "/bin/cli.js" },
      })

      expect(code).toBe(EXIT_OK)
      expect(stdout).toContain('Installed sync service for "default"')
      expect(stderr).toBe("")

      const plist = await readFile(join(dir, "Library", "LaunchAgents", `${SERVICE_ID}.default.plist`), "utf8")
      const launcherPath = join(dir, "Library", "Application Support", SERVICE_ID, `${SERVICE_LAUNCHER}-default`)
      expect(plist).toContain(
        `<array>\n\t\t<string>${launcherPath}</string>\n\t\t<string>/bin/node</string>\n\t\t<string>/bin/cli.js</string>`,
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("fails with usage listing accounts when --account is absent and several exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sig-"))
    try {
      const p1 = await ensureLabelDir(dir, "first")
      const p2 = await ensureLabelDir(dir, "second")
      writeSignalCliAccount(p1.signalCli, LINKED_ACCOUNT, true)
      writeSignalCliAccount(p2.signalCli, LINKED_ACCOUNT, true)

      let stdout = ""
      let stderr = ""
      const code = await runServiceCommand(["install", "--state-dir", dir], {
        env: {},
        stdout: (t) => (stdout += t),
        stderr: (t) => (stderr += t),
        serviceHost: fakeHost(dir),
      })

      expect(code).toBe(EXIT_USAGE)
      expect(stderr).toContain("Several Signal accounts are linked; name one with --account: first, second.")
      expect(stdout).toBe("")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("fails when --account is absent and no accounts are linked", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sig-"))
    try {
      let stderr = ""
      const code = await runServiceCommand(["install", "--state-dir", dir], {
        env: {},
        stdout: () => {},
        stderr: (t) => (stderr += t),
        serviceHost: fakeHost(dir),
      })

      expect(code).toBe(EXIT_FAILED)
      expect(stderr).toContain("No Signal account is linked yet; link a device first.")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("refuses install when label is not linked", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sig-"))
    try {
      const paths = await ensureLabelDir(dir, "work")
      // registered = false
      writeSignalCliAccount(paths.signalCli, LINKED_ACCOUNT, false)

      let stderr = ""
      const code = await runServiceCommand(["install", "--account", "work", "--state-dir", dir], {
        env: {},
        stdout: () => {},
        stderr: (t) => (stderr += t),
        serviceHost: fakeHost(dir),
        self: { program: "/bin/node", script: "/bin/cli.js" },
      })

      expect(code).toBe(EXIT_FAILED)
      expect(stderr).toBe(
        `${PROJECT.cli}: This label is not linked; link it first with: ${PROJECT.cli} link --account work\n`,
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("appends tracking URL on Windows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sig-"))
    try {
      const paths = await ensureLabelDir(dir, "default")
      writeSignalCliAccount(paths.signalCli, LINKED_ACCOUNT, true)

      let stderr = ""
      const host = fakeHost(dir, { platform: "win32" })
      const code = await runServiceCommand(["install", "--state-dir", dir], {
        env: {},
        stdout: () => {},
        stderr: (t) => (stderr += t),
        serviceHost: host,
      })

      expect(code).toBe(EXIT_FAILED)
      expect(stderr).toContain(
        "Running the sync service is supported on macOS and Linux only. Windows support is tracked in https://github.com/craft-agent/signal-tools/issues/11.",
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("prints required install information on Linux", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sig-"))
    try {
      const paths = await ensureLabelDir(dir, "default")
      writeSignalCliAccount(paths.signalCli, LINKED_ACCOUNT, true)

      let stdout = ""
      const host = fakeHost(dir, {
        platform: "linux",
        env: { PATH: "/bin", XDG_CONFIG_HOME: join(dir, ".config") },
      })
      const code = await runServiceCommand(["install", "--state-dir", dir], {
        env: {},
        stdout: (t) => (stdout += t),
        stderr: () => {},
        serviceHost: host,
        self: { program: "/bin/node", script: "/bin/cli.js" },
      })

      expect(code).toBe(EXIT_OK)
      expect(stdout).toContain('Installed sync service for "default"')
      expect(stdout).toContain(
        "View logs with: journalctl --user -u io-github-craft-agent-signal-tools-default.service",
      )
      expect(stdout).toContain("The service starts automatically at logon and restarts after a failure.")
      expect(stdout).toContain(
        "Install the service again after updating Node or this package, as it records both paths.",
      )
      expect(stdout).toContain('Run "loginctl enable-linger" to keep the service running while logged out.')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("status and uninstall output format", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sig-"))
    try {
      const paths = await ensureLabelDir(dir, "default")
      writeSignalCliAccount(paths.signalCli, LINKED_ACCOUNT, true)

      let statusOut = ""
      let loaded = false
      const host = fakeHost(dir, {
        run: async (argv) => {
          if (argv[1] === "bootstrap") loaded = true
          if (argv[1] === "bootout") loaded = false
          if (argv[1] === "print") {
            return loaded
              ? { code: 0, stdout: "state = running\npid = 1234\nlast exit code = 0\n", stderr: "" }
              : { code: 113, stdout: "", stderr: "Could not find service" }
          }
          return { code: 0, stdout: "", stderr: "" }
        },
      })

      // Install first
      await runServiceCommand(["install", "--state-dir", dir], {
        env: {},
        stdout: () => {},
        stderr: () => {},
        serviceHost: host,
        self: { program: "/bin/node", script: "/bin/cli.js" },
      })

      // Status
      const statusCode = await runServiceCommand(["status", "--state-dir", dir], {
        env: {},
        stdout: (t) => (statusOut += t),
        stderr: () => {},
        serviceHost: host,
      })

      expect(statusCode).toBe(EXIT_OK)
      expect(statusOut).toContain("Installed: yes")
      expect(statusOut).toContain("Running: yes")
      expect(statusOut).toContain("PID: 1234")
      expect(statusOut).toContain("Last exit: 0")
      expect(statusOut).toContain("Log:")

      // Uninstall
      let uninstallOut = ""
      const unCode = await runServiceCommand(["uninstall", "--state-dir", dir], {
        env: {},
        stdout: (t) => (uninstallOut += t),
        stderr: () => {},
        serviceHost: host,
      })
      expect(unCode).toBe(EXIT_OK)
      expect(uninstallOut).toBe('Uninstalled sync service for "default".\n')
      expect(await stat(join(dir, "Library", "Application Support", SERVICE_ID)).catch(() => undefined)).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
