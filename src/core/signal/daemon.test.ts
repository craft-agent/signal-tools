import { afterEach, describe, expect, test } from "bun:test"
import { callDaemon, DaemonConnection, type Notification } from "./daemon"
import { failureOf, startFakeDaemon, type FakeDaemon, type FakeReply } from "./daemon.testing"

let daemon: FakeDaemon | undefined
const connections: DaemonConnection[] = []

async function connect(reply: (method: string, params: unknown) => FakeReply | Promise<FakeReply>) {
  daemon = await startFakeDaemon(reply)
  const connection = await DaemonConnection.connect(daemon.socketPath)
  connections.push(connection)
  return { daemon, connection }
}

afterEach(async () => {
  for (const connection of connections.splice(0)) connection.close()
  await daemon?.close()
  daemon = undefined
})

describe("DaemonConnection.call", () => {
  test("sends a JSON-RPC request and returns the result", async () => {
    const { daemon, connection } = await connect(() => ({ result: { version: "0.14" } }))
    const result = await connection.call("version", { verbose: true })
    expect(result).toEqual({ version: "0.14" })
    expect(daemon.calls).toEqual([{ method: "version", params: { verbose: true } }])
  })

  test("sends no params when there are none", async () => {
    const { daemon, connection } = await connect(() => ({ result: null }))
    expect(await connection.call("listAccounts")).toBeNull()
    expect(daemon.calls[0]?.params).toBeUndefined()
  })

  test("answers concurrent calls by id, whatever order the answers come in", async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { connection } = await connect(async (method) => {
      if (method === "slow") await gate
      return { result: method }
    })
    const slow = connection.call("slow")
    const fast = connection.call("fast")
    expect(await fast).toBe("fast")
    release()
    expect(await slow).toBe("slow")
  })

  test("ignores answers to ids it never asked, and blank lines", async () => {
    const { daemon, connection } = await connect((method) => {
      daemon?.sendRaw('\n\n{"jsonrpc":"2.0","id":999,"result":"stray"}\n{"jsonrpc":"2.0","id":"x","result":1}\n')
      return { result: method }
    })
    expect(await connection.call("first")).toBe("first")
  })

  test("reads a line that arrives in pieces, multibyte characters included", async () => {
    const { daemon, connection } = await connect(() => "hang")
    const seen: Notification[] = []
    connection.onNotification((notification) => seen.push(notification))
    const bytes = Buffer.from('{"jsonrpc":"2.0","method":"m","params":"é"}\n')
    const cut = bytes.indexOf(0xc3) + 1
    daemon.sendRaw(bytes.subarray(0, cut))
    await Bun.sleep(20)
    expect(seen).toEqual([])
    daemon.sendRaw(bytes.subarray(cut))
    await Bun.sleep(20)
    expect(seen).toEqual([{ method: "m", params: "é" }])
  })

  test("rejects a call on a connection that is closed", async () => {
    const { connection } = await connect(() => ({ result: 1 }))
    connection.close()
    const error = await failureOf(connection.call("version"))
    expect(error).toMatchObject({ name: "ToolError", code: "upstream_error" })
    expect(error.message).toContain("version")
    await connection.closed
  })
})

describe("DaemonConnection notifications", () => {
  test("delivers every notification in order and leaves calls alone", async () => {
    const { daemon, connection } = await connect(() => ({ result: "ok" }))
    const seen: Notification[] = []
    connection.onNotification((notification) => seen.push(notification))
    daemon.notify("receive", { n: 1 })
    daemon.notify("receive", { n: 2 })
    expect(await connection.call("version")).toBe("ok")
    await Bun.sleep(20)
    expect(seen).toEqual([
      { method: "receive", params: { n: 1 } },
      { method: "receive", params: { n: 2 } },
    ])
  })

  test("keeps going when a listener throws, and stops after unsubscribe", async () => {
    const { daemon, connection } = await connect(() => ({ result: "ok" }))
    const seen: unknown[] = []
    connection.onNotification(() => {
      throw new Error("listener failed")
    })
    const stop = connection.onNotification((notification) => seen.push(notification.params))
    daemon.notify("receive", 1)
    await Bun.sleep(20)
    stop()
    daemon.notify("receive", 2)
    await Bun.sleep(20)
    expect(seen).toEqual([1])
    expect(await connection.call("version")).toBe("ok")
  })
})

describe("DaemonConnection.close", () => {
  test("settles `closed` and rejects calls in flight", async () => {
    const { connection } = await connect(() => "hang")
    const read = connection.call("listContacts", {}, { timeoutMs: 5_000 })
    const write = connection.call("send", {}, { effect: "write", timeoutMs: 5_000 })
    await Bun.sleep(20)
    connection.close()
    expect(await failureOf(read)).toMatchObject({ code: "upstream_error" })
    expect(await failureOf(write)).toMatchObject({ code: "uncertain" })
    await connection.closed
  })
})

describe("callDaemon", () => {
  test("makes one call on its own connection and closes it", async () => {
    daemon = await startFakeDaemon((method) => ({ result: method }))
    expect(await callDaemon(daemon.socketPath, "version")).toBe("version")
    expect(await callDaemon(daemon.socketPath, "other", { a: 1 })).toBe("other")
    expect(daemon.calls.map((call) => call.method)).toEqual(["version", "other"])
  })
})
