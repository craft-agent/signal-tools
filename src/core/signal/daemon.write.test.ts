import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { getEventListeners } from "node:events"
import { Socket } from "node:net"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { callDaemon, DaemonConnection } from "./daemon"
import { failureOf, startFakeDaemon, type FakeDaemon } from "./daemon.testing"

const NOT_RUNNING = "The Signal daemon is not running at this account's socket."

let daemon: FakeDaemon | undefined
let restoreTimers: (() => void) | undefined

afterEach(async () => {
  restoreTimers?.()
  restoreTimers = undefined
  await daemon?.close()
  daemon = undefined
})

/** Watches the timers set from now on; `leaked()` lists those never cleared, which would keep a process alive. */
function trackTimers() {
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  const created: unknown[] = []
  const cleared = new Set<unknown>()
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const timer = realSet(...args)
    created.push(timer)
    return timer
  }) as typeof setTimeout
  globalThis.clearTimeout = ((timer: Parameters<typeof clearTimeout>[0]) => {
    cleared.add(timer)
    realClear(timer)
  }) as typeof clearTimeout
  restoreTimers = () => {
    globalThis.setTimeout = realSet
    globalThis.clearTimeout = realClear
  }
  return { created: () => created.length, leaked: () => created.filter((timer) => !cleared.has(timer)) }
}

async function connect() {
  daemon = await startFakeDaemon(() => ({ result: "ok" }))
  const connection = await DaemonConnection.connect(daemon.socketPath)
  return { daemon, connection, socket: connection["socket"], pending: connection["pending"] }
}

describe("a request that cannot be written", () => {
  test("an argument JSON cannot hold is invalid_argument, and nothing is registered or sent", async () => {
    const { daemon, connection, pending } = await connect()
    const timers = trackTimers()
    const controller = new AbortController()
    const error = await failureOf(
      connection.call("send", { size: 10n }, { effect: "write", signal: controller.signal }),
    )
    expect(error).toMatchObject({ name: "ToolError", code: "invalid_argument" })
    expect(error.message).toContain("send")
    expect(timers.created()).toBe(0)
    expect(pending.size).toBe(0)
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
    expect(daemon.calls).toEqual([])
    expect(await connection.call("version")).toBe("ok")
    connection.close()
  })

  for (const [name, fail] of [
    ["a failed write callback", (cb: (error?: Error | null) => void) => cb(new Error("EPIPE"))],
    [
      "a synchronous throw from write",
      () => {
        throw new Error("write exploded")
      },
    ],
  ] as const) {
    describe(name, () => {
      test("is uncertain for a write, and leaves no timer, listener or pending call", async () => {
        const { connection, socket, pending } = await connect()
        socket.write = ((_data: unknown, cb: (error?: Error | null) => void) => {
          fail(cb)
          return false
        }) as typeof socket.write
        const timers = trackTimers()
        const controller = new AbortController()
        const error = await failureOf(connection.call("send", {}, { effect: "write", signal: controller.signal }))
        expect(error).toMatchObject({ name: "ToolError", code: "uncertain" })
        expect(error.message).toContain("send")
        expect(error.message).toContain("phone")
        expect(timers.created()).toBe(1)
        expect(timers.leaked()).toEqual([])
        expect(pending.size).toBe(0)
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
        connection.close()
      })

      test("is upstream_error for a read", async () => {
        const { connection, socket } = await connect()
        socket.write = ((_data: unknown, cb: (error?: Error | null) => void) => {
          fail(cb)
          return false
        }) as typeof socket.write
        const error = await failureOf(connection.call("listContacts"))
        expect(error).toMatchObject({ name: "ToolError", code: "upstream_error" })
        connection.close()
      })
    })
  }
})

describe("connecting", () => {
  test("a synchronous throw from connect is the not-running upstream_error, with nothing left behind", async () => {
    const connectSpy = spyOn(Socket.prototype, "connect").mockImplementation(() => {
      throw new Error("connect exploded")
    })
    try {
      const timers = trackTimers()
      const controller = new AbortController()
      const error = await failureOf(
        DaemonConnection.connect(join(tmpdir(), "sig-missing-dir", "s"), { signal: controller.signal }),
      )
      expect(error).toMatchObject({ code: "upstream_error" })
      expect(error.message).toBe(NOT_RUNNING)
      expect(timers.leaked()).toEqual([])
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)

      const viaCall = await failureOf(
        callDaemon(join(tmpdir(), "sig-missing-dir", "s"), "send", {}, { effect: "write" }),
      )
      expect(viaCall).toMatchObject({ code: "upstream_error" })
    } finally {
      connectSpy.mockRestore()
    }
  })
})
