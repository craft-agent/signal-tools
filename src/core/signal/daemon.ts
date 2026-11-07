import { Socket } from "node:net"
import { ToolError } from "../errors"
import { abortError } from "../exec"
import { afterWriteError, isRecord, rpcError, type CallEffect } from "./daemon-errors"

export type { CallEffect }

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000
const DEFAULT_CALL_TIMEOUT_MS = 30_000
const DEFAULT_MAX_LINE_LENGTH = 64 * 1024 * 1024
const NOT_RUNNING_MESSAGE = "The Signal daemon is not running at this account's socket."
const DAEMON_NOT_RUNNING = Symbol("daemon not running")

/** Whether the daemon client failed because no daemon was listening at the account's socket. */
export function isDaemonNotRunning(error: unknown): boolean {
  return error instanceof ToolError && error.cause === DAEMON_NOT_RUNNING
}

/** The error for a daemon that is not running, in the words a call tells the person; `cause` is the client's own error. */
export function syncServiceNotRunning(cause: unknown): ToolError {
  return new ToolError("upstream_error", "The Signal daemon is not running for this account; start its sync service.", {
    cause,
  })
}

export type CallOptions = {
  /** Defaults to `"read"`. */
  effect?: CallEffect
  /** How long the call may take from the moment it starts; 30 seconds by default. */
  timeoutMs?: number
  /** Cancels the call. A read rejects with an `AbortError`; a write already written rejects as `uncertain`. */
  signal?: AbortSignal
}

export type ConnectOptions = {
  /** How long connecting may take; 5 seconds by default. */
  timeoutMs?: number
  signal?: AbortSignal
  /**
   * The longest line the daemon may send before the connection is dropped,
   * counted in characters of the decoded text; 64 * 1024 * 1024 characters by default.
   */
  maxLineLength?: number
}

export type Notification = { method: string; params: unknown }

/** What the daemon, or the loss of the connection, made of one request. */
type Reply =
  { result: unknown } | { error: { code: number | undefined; message: string; data?: unknown } } | { lost: string }

/** The result of a reply, or the error it stands for. */
function resultOf(method: string, effect: CallEffect, reply: Reply): unknown {
  if ("result" in reply) return reply.result
  if ("lost" in reply) throw afterWriteError(method, effect, reply.lost)
  throw rpcError(method, effect, reply.error.code, reply.error.message, reply.error.data)
}

/**
 * A connection to signal-cli's daemon socket: newline-delimited JSON-RPC 2.0.
 * Several calls may be in flight at once; each is answered by its id.
 */
export class DaemonConnection {
  /** Settles once the connection is gone, whoever ended it; it never rejects. */
  readonly closed: Promise<void>

  private readonly socket: Socket
  private readonly maxLineLength: number
  private readonly pending = new Map<number, (reply: Reply) => void>()
  private readonly listeners = new Set<(notification: Notification) => void>()
  private nextId = 1
  /** The pieces of the line being received, and their total length. */
  private lineParts: string[] = []
  private lineLength = 0
  /** Why the connection is gone or going; set by whoever ends it first. */
  private endReason: string | undefined

  private constructor(socket: Socket, maxLineLength: number) {
    this.socket = socket
    this.maxLineLength = maxLineLength
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => this.onData(chunk))
    socket.on("error", (error: NodeJS.ErrnoException) => {
      this.endReason ??= `the connection to signal-cli broke${error.code ? ` (${error.code})` : ""}`
    })
    this.closed = new Promise((resolve) => {
      socket.once("close", () => {
        this.endReason ??= "signal-cli closed the connection"
        const lost: Reply = { lost: this.endReason }
        for (const settle of [...this.pending.values()]) settle(lost)
        resolve()
      })
    })
  }

  /** Connects to the daemon's socket; rejects as `upstream_error` when nothing is listening there. */
  static connect(socketPath: string, options: ConnectOptions = {}): Promise<DaemonConnection> {
    const { timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS, signal, maxLineLength = DEFAULT_MAX_LINE_LENGTH } = options
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError(signal))
        return
      }
      const socket = new Socket()
      let timer: ReturnType<typeof setTimeout> | undefined

      const detach = () => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
        socket.off("connect", onConnect)
        socket.off("error", onFailure)
      }
      const stop = (error: Error) => {
        detach()
        socket.on("error", () => {})
        socket.destroy()
        reject(error)
      }
      const onConnect = () => {
        detach()
        resolve(new DaemonConnection(socket, maxLineLength))
      }
      // The OS error and the path are left out on purpose: the path holds the state directory.
      const onFailure = () => stop(new ToolError("upstream_error", NOT_RUNNING_MESSAGE, { cause: DAEMON_NOT_RUNNING }))
      const onAbort = () => stop(abortError(signal!))

      socket.once("connect", onConnect)
      socket.once("error", onFailure)
      signal?.addEventListener("abort", onAbort, { once: true })
      timer = setTimeout(onFailure, timeoutMs)
      try {
        socket.connect({ path: socketPath })
      } catch {
        onFailure()
      }
    })
  }

  /**
   * Calls a method and returns its result. Failures map to the error codes of
   * docs/conventions.md; once the request was handed to the socket, a write
   * that fails without a definite answer rejects as `uncertain`, a failed
   * socket write included.
   */
  call<T = unknown>(method: string, params?: Record<string, unknown>, options: CallOptions = {}): Promise<T> {
    const { effect = "read", timeoutMs = DEFAULT_CALL_TIMEOUT_MS, signal } = options
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError(signal))
        return
      }
      if (this.endReason !== undefined) {
        reject(new ToolError("upstream_error", `${method} was not sent (${this.endReason}).`))
        return
      }

      const id = this.nextId++
      // Serialized first: a request that cannot be written registers nothing and sends nothing.
      let line: string
      try {
        line = `${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`
      } catch {
        reject(new ToolError("invalid_argument", `${method} was not sent: its arguments cannot be written as JSON.`))
        return
      }

      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (produce: () => unknown) => {
        if (!this.pending.delete(id)) return
        clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
        try {
          resolve(produce() as T)
        } catch (error) {
          reject(error)
        }
      }
      const onAbort = () =>
        finish(() => {
          throw effect === "read" ? abortError(signal!) : afterWriteError(method, effect, "the call was cancelled")
        })

      this.pending.set(id, (reply) => finish(() => resultOf(method, effect, reply)))
      signal?.addEventListener("abort", onAbort, { once: true })
      timer = setTimeout(
        () =>
          finish(() => {
            throw afterWriteError(method, effect, `signal-cli did not answer within ${timeoutMs} ms`)
          }),
        timeoutMs,
      )

      // Not even a failed write proves that no byte left, so it is judged like any failure after the write.
      const onWriteFailure = () =>
        finish(() => {
          throw afterWriteError(method, effect, "could not write to signal-cli")
        })
      try {
        this.socket.write(line, (error) => {
          if (error) onWriteFailure()
        })
      } catch {
        onWriteFailure()
      }
    })
  }

  /**
   * Calls `listener` with every notification, in order; returns the function
   * that stops it. Listeners run synchronously on the connection's read path
   * and a throw is swallowed, so a listener that must stop the connection when
   * it fails (a store that cannot be written, say) closes it itself.
   */
  onNotification(listener: (notification: Notification) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Closes the connection; calls still in flight settle by the rules of `call`. */
  close(): void {
    this.end("the connection was closed")
  }

  private end(reason: string): void {
    this.endReason ??= reason
    this.socket.destroy()
  }

  /** Splits the stream into lines; the pieces of an unfinished line are joined only once it ends. */
  private onData(chunk: string): void {
    let start = 0
    for (let end = chunk.indexOf("\n"); end !== -1; end = chunk.indexOf("\n", start)) {
      const line = this.takeLine(chunk.slice(start, end))
      start = end + 1
      if (line === undefined) return
      this.onLine(line)
      if (this.socket.destroyed) return
    }
    if (start < chunk.length) this.takeLine(chunk.slice(start), true)
  }

  /** Adds a piece to the current line; the whole line once `partial` is false, undefined when it grew too long. */
  private takeLine(piece: string, partial = false): string | undefined {
    this.lineParts.push(piece)
    this.lineLength += piece.length
    if (this.lineLength > this.maxLineLength) {
      this.end("signal-cli sent a line that is too long")
      return undefined
    }
    if (partial) return undefined
    const line = this.lineParts.length === 1 ? piece : this.lineParts.join("")
    this.lineParts = []
    this.lineLength = 0
    return line
  }

  private onLine(line: string): void {
    if (!line.trim()) return
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      message = undefined
    }
    if (!isRecord(message)) {
      this.end("signal-cli sent a line that is not JSON-RPC")
      return
    }

    if (typeof message.id === "number") {
      if ("error" in message) {
        const { code, message: text, data } = isRecord(message.error) ? message.error : ({} as Record<string, unknown>)
        this.pending.get(message.id)?.({
          error: {
            code: typeof code === "number" ? code : undefined,
            message: typeof text === "string" ? text : "",
            data,
          },
        })
      } else if ("result" in message) {
        this.pending.get(message.id)?.({ result: message.result })
      }
    } else if (typeof message.method === "string" && message.id == null) {
      const notification = { method: message.method, params: message.params }
      for (const listener of [...this.listeners]) {
        try {
          listener(notification)
        } catch {
          // A listener's failure is its own; the connection and the other listeners go on.
        }
      }
    }
  }
}

/** One call on its own short connection, closed when the call settles. */
export async function callDaemon<T = unknown>(
  socketPath: string,
  method: string,
  params?: Record<string, unknown>,
  options: CallOptions & { connectTimeoutMs?: number; maxLineLength?: number } = {},
): Promise<T> {
  const { connectTimeoutMs, maxLineLength, ...callOptions } = options
  const connection = await DaemonConnection.connect(socketPath, {
    timeoutMs: connectTimeoutMs,
    signal: callOptions.signal,
    maxLineLength,
  })
  try {
    return await connection.call<T>(method, params, callOptions)
  } finally {
    connection.close()
  }
}
