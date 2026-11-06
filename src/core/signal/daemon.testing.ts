import { mkdtempSync, rmSync } from "node:fs"
import { createServer, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** What the fake daemon does with a request: answer it, never answer, or hang up. */
export type FakeReply = { result: unknown } | { error: { code: number; message: string } } | "hang" | "close"

export type FakeDaemon = {
  socketPath: string
  /** Every request received, in order. */
  calls: { method: string; params: unknown }[]
  /** Sends a notification to every connected client. */
  notify(method: string, params: unknown): void
  /** Sends data as it is, without a line break added, to every connected client. */
  sendRaw(data: string | Uint8Array): void
  /** Closes the server and its clients and removes the socket's directory. */
  close(): Promise<void>
}

/** The error a promise rejects with, for a test that checks it; fails when the promise resolves. */
export async function failureOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    if (error instanceof Error) return error
    throw error
  }
  throw new Error("expected the promise to reject")
}

/** A fake signal-cli daemon on a UNIX socket in a fresh, short temp directory. */
export async function startFakeDaemon(
  reply: (method: string, params: unknown) => FakeReply | Promise<FakeReply>,
): Promise<FakeDaemon> {
  const dir = mkdtempSync(join(tmpdir(), "sig-"))
  const socketPath = join(dir, "s")
  const clients = new Set<Socket>()
  const calls: FakeDaemon["calls"] = []

  const answer = async (client: Socket, line: string) => {
    const request = JSON.parse(line) as { id: number; method: string; params?: unknown }
    calls.push({ method: request.method, params: request.params })
    const outcome = await reply(request.method, request.params)
    if (outcome === "hang") return
    if (outcome === "close") {
      client.destroy()
      return
    }
    client.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, ...outcome })}\n`)
  }

  const server = createServer((client) => {
    clients.add(client)
    client.setEncoding("utf8")
    client.on("error", () => {})
    client.on("close", () => clients.delete(client))
    let buffer = ""
    client.on("data", (chunk: string) => {
      buffer += chunk
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) if (line.trim()) void answer(client, line)
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))

  return {
    socketPath,
    calls,
    notify(method, params) {
      const line = `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`
      for (const client of clients) client.write(line)
    },
    sendRaw(data) {
      for (const client of clients) client.write(data)
    },
    async close() {
      for (const client of clients) client.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
