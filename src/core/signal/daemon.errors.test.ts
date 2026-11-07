import { afterEach, describe, expect, test } from "bun:test"
import type { ErrorCode } from "../errors"
import { callDaemon } from "./daemon"
import { maskNumbers, rpcErrorData } from "./daemon-errors"
import { failureOf, startFakeDaemon, type FakeDaemon } from "./daemon.testing"

const daemons: FakeDaemon[] = []

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.close()))
})

async function startDaemon(reply: Parameters<typeof startFakeDaemon>[0]) {
  const daemon = await startFakeDaemon(reply)
  daemons.push(daemon)
  return daemon
}

async function failWith(code: number, message: string, effect: "read" | "write", method = "send") {
  const daemon = await startDaemon(() => ({ error: { code, message } }))
  return failureOf(callDaemon(daemon.socketPath, method, {}, { effect }))
}

describe("JSON-RPC errors", () => {
  // These mean nothing was done, so a write is no more uncertain than a read.
  const definite: [number, ErrorCode][] = [
    [-32700, "internal_error"],
    [-32600, "internal_error"],
    [-32601, "upstream_error"],
    [-32602, "invalid_argument"],
    [-1, "invalid_argument"],
    [-4, "forbidden"],
    [-5, "rate_limited"],
    [-6, "rate_limited"],
  ]
  for (const [rpcCode, code] of definite) {
    for (const effect of ["read", "write"] as const) {
      test(`${rpcCode} is ${code} for a ${effect}`, async () => {
        const error = await failWith(rpcCode, "refused", effect)
        expect(error).toMatchObject({ name: "ToolError", code })
        expect(error.message).toContain("send")
      })
    }
  }

  // These leave the outcome open.
  for (const rpcCode of [-3, -32603, -42, 7]) {
    test(`${rpcCode} is upstream_error for a read and uncertain for a write`, async () => {
      expect(await failWith(rpcCode, "boom", "read", "listContacts")).toMatchObject({ code: "upstream_error" })
      const error = await failWith(rpcCode, "boom", "write", "send")
      expect(error).toMatchObject({ code: "uncertain" })
      expect(error.message).toContain("phone")
      expect(error.message).toContain("send")
    })
  }

  test("an unknown method tells the person to update signal-cli", async () => {
    const error = await failWith(-32601, "Method not found", "read", "frobnicate")
    expect(error.message).toBe("signal-cli does not know frobnicate; update signal-cli.")
  })

  test("carries signal-cli's text with numbers masked and cut to 300 characters", async () => {
    const error = await failWith(-1, `Cannot reach +1 555-555-0123 ${"x".repeat(500)}`, "read")
    expect(error.message).toContain("[number]")
    expect(error.message).not.toContain("555")
    expect(error.message.length).toBeLessThan(300 + 100)
    expect(error.message).not.toContain("x".repeat(301))
  })

  test("never carries the raw data of an error in its message or cause", async () => {
    const daemon = await startDaemon(() => ({ error: { code: -1, message: "bad", data: { secret: "hunter2" } } }))
    const error = await failureOf(callDaemon(daemon.socketPath, "send"))
    expect(error.message).not.toContain("hunter2")
    expect(error.cause).toBeUndefined()
    expect(JSON.stringify(error)).not.toContain("hunter2")
  })

  test("hands the data of an error reply to a caller that asks for it", async () => {
    const data = { response: { timestamp: 5, results: [] } }
    const daemon = await startDaemon(() => ({ error: { code: -5, message: "limited", data } }))
    const error = await failureOf(callDaemon(daemon.socketPath, "send", {}, { effect: "write" }))
    expect(error).toMatchObject({ code: "rate_limited" })
    expect(rpcErrorData(error)).toEqual(data)
  })

  test("has no data for a reply without any, or for an error that is not a reply", async () => {
    const daemon = await startDaemon(() => ({ error: { code: -5, message: "limited" } }))
    expect(rpcErrorData(await failureOf(callDaemon(daemon.socketPath, "send")))).toBeUndefined()
    expect(rpcErrorData(new Error("x"))).toBeUndefined()
    expect(rpcErrorData(undefined)).toBeUndefined()
  })
})

describe("maskNumbers", () => {
  test("replaces numbers, with or without separators", () => {
    expect(maskNumbers("call +15555550123 now")).toBe("call [number] now")
    expect(maskNumbers("+1 555 555 0123, +1-555-555-0123")).toBe("[number], [number]")
    expect(maskNumbers("+123456")).toBe("[number]")
  })

  test("masks a number longer than fifteen digits whole", () => {
    expect(maskNumbers("+1234567890123456789")).toBe("[number]")
  })

  test("leaves other text alone", () => {
    expect(maskNumbers("code 12345678, +12345, a+b")).toBe("code 12345678, +12345, a+b")
  })
})
