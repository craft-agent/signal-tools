import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { ToolError } from "../errors"
import { callDaemon, DaemonConnection, isDaemonNotRunning } from "./daemon"
import { failureOf, startFakeDaemon, type FakeDaemon, type FakeReply } from "./daemon.testing"

const SHORT_MS = 200
const MAX_LINE = 1024

let daemon: FakeDaemon | undefined

afterEach(async () => {
  await daemon?.close()
  daemon = undefined
})

async function call(
  reply: FakeReply,
  effect: "read" | "write",
  extra: { timeoutMs?: number; signal?: AbortSignal } = {},
) {
  daemon = await startFakeDaemon(() => reply)
  return failureOf(callDaemon(daemon.socketPath, "send", {}, { effect, timeoutMs: SHORT_MS, ...extra }))
}

describe("a daemon that is not there", () => {
  test("is upstream_error without the path or the OS text", async () => {
    const path = join(tmpdir(), "sig-missing-dir", "s")
    const error = await failureOf(callDaemon(path, "version"))
    expect(error).toMatchObject({ code: "upstream_error" })
    expect(error.message).toBe("The Signal daemon is not running at this account's socket.")
    expect(isDaemonNotRunning(error)).toBe(true)
    expect(error.message).not.toContain("sig-missing-dir")
  })

  test("does not identify another upstream_error by its message", () => {
    const error = new ToolError("upstream_error", "The Signal daemon is not running at this account's socket.")
    expect(isDaemonNotRunning(error)).toBe(false)
  })

  test("is the same for a write: nothing was sent", async () => {
    const path = join(tmpdir(), "sig-missing-dir", "s")
    const error = await failureOf(callDaemon(path, "send", {}, { effect: "write" }))
    expect(error).toMatchObject({ code: "upstream_error" })
  })

  test("aborts before connecting", async () => {
    daemon = await startFakeDaemon(() => ({ result: 1 }))
    const error = await failureOf(DaemonConnection.connect(daemon.socketPath, { signal: AbortSignal.abort() }))
    expect(error.name).toBe("AbortError")
    expect(daemon.calls).toEqual([])
  })

  test("aborts a call that has not started", async () => {
    daemon = await startFakeDaemon(() => ({ result: 1 }))
    const error = await failureOf(
      callDaemon(daemon.socketPath, "send", {}, { effect: "write", signal: AbortSignal.abort() }),
    )
    expect(error.name).toBe("AbortError")
    expect(daemon.calls).toEqual([])
  })
})

describe("time limits", () => {
  test("a read that times out is upstream_error", async () => {
    const error = await call("hang", "read")
    expect(error).toMatchObject({ code: "upstream_error" })
    expect(error.message).toContain("send")
  })

  test("a write that times out is uncertain", async () => {
    const error = await call("hang", "write")
    expect(error).toMatchObject({ code: "uncertain" })
    expect(error.message).toContain("phone")
  })

  test("an answer that comes after the limit is ignored", async () => {
    daemon = await startFakeDaemon(async () => {
      await new Promise((resolve) => setTimeout(resolve, SHORT_MS * 2))
      return { result: 1 }
    })
    const connection = await DaemonConnection.connect(daemon.socketPath)
    const error = await failureOf(connection.call("send", {}, { timeoutMs: 50 }))
    expect(error).toMatchObject({ code: "upstream_error" })
    await new Promise((resolve) => setTimeout(resolve, SHORT_MS * 2))
    connection.close()
  })
})

describe("a daemon that hangs up mid-call", () => {
  test("is upstream_error for a read", async () => {
    expect(await call("close", "read")).toMatchObject({ code: "upstream_error" })
  })

  test("is uncertain for a write", async () => {
    expect(await call("close", "write")).toMatchObject({ code: "uncertain" })
  })
})

describe("cancellation after the request was written", () => {
  test("is an abort error for a read", async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)
    const error = await call("hang", "read", { timeoutMs: 5_000, signal: controller.signal })
    expect(error.name).toBe("AbortError")
  })

  test("is uncertain for a write", async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)
    const error = await call("hang", "write", { timeoutMs: 5_000, signal: controller.signal })
    expect(error).toMatchObject({ name: "ToolError", code: "uncertain" })
  })
})

describe("a daemon that breaks the protocol", () => {
  test("a line that is not JSON closes the connection as an upstream failure", async () => {
    daemon = await startFakeDaemon(() => "hang")
    const connection = await DaemonConnection.connect(daemon.socketPath)
    const pending = connection.call("listContacts", {}, { timeoutMs: 5_000 })
    await new Promise((resolve) => setTimeout(resolve, 50))
    daemon.sendRaw("this is not json\n")
    const error = await failureOf(pending)
    expect(error).toMatchObject({ code: "upstream_error" })
    await connection.closed
  })

  test("a line over the limit closes the connection, and a line within it does not", async () => {
    daemon = await startFakeDaemon(() => "hang")
    const connection = await DaemonConnection.connect(daemon.socketPath, { maxLineLength: MAX_LINE })
    const seen: unknown[] = []
    connection.onNotification((notification) => seen.push(notification.params))
    const pending = connection.call("send", {}, { effect: "write", timeoutMs: 5_000 })
    await new Promise((resolve) => setTimeout(resolve, 50))
    daemon.notify("m", "y".repeat(MAX_LINE / 2))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(seen).toHaveLength(1)
    daemon.sendRaw(Buffer.alloc(MAX_LINE + 1, "x"))
    expect(await failureOf(pending)).toMatchObject({ code: "uncertain" })
    await connection.closed
  })

  test("callDaemon passes the limit on", async () => {
    daemon = await startFakeDaemon(() => ({ result: "x".repeat(MAX_LINE) }))
    const error = await failureOf(
      callDaemon(daemon.socketPath, "send", {}, { effect: "write", maxLineLength: MAX_LINE }),
    )
    expect(error).toMatchObject({ code: "uncertain" })
  })
})
