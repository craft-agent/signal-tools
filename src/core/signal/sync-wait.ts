import { readFileSync } from "node:fs"

/** Calls `fn` when `signal` aborts, at once when it already has; returns the function that stops listening. */
export function onAbort(signal: AbortSignal | undefined, fn: () => void): () => void {
  if (!signal) return () => {}
  if (signal.aborted) {
    fn()
    return () => {}
  }
  signal.addEventListener("abort", fn, { once: true })
  return () => signal.removeEventListener("abort", fn)
}

/** Resolves after `ms`, or as soon as `signal` aborts; leaves no timer or listener behind. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let stopListening = () => {}
    const timer = setTimeout(() => {
      stopListening()
      resolve()
    }, ms)
    stopListening = onAbort(signal, () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/** Resolves once `promise` settles or `ms` passed, whichever is first; leaves no timer behind and never rejects. */
export async function settledOrTimeout(promise: Promise<unknown>, ms: number): Promise<void> {
  const timer = new AbortController()
  try {
    await Promise.race([promise.catch(() => {}), sleep(ms, timer.signal)])
  } finally {
    timer.abort()
  }
}

/** The process id in a pid file, or undefined when there is no file or it holds no process id. */
export function readPid(path: string): number | undefined {
  try {
    const pid = Number(readFileSync(path, "utf8").trim())
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

/** Whether a process with this id exists (also when it belongs to someone else). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** A flag that wakes the one waiting for it, and remembers a notification that came while nobody waited. */
export class Wakeup {
  private wake: (() => void) | undefined
  private notifiedFlag = false

  /** Whether something was notified since the last `clear` or the last `wait`. */
  get notified(): boolean {
    return this.notifiedFlag
  }

  notify(): void {
    this.notifiedFlag = true
    this.wake?.()
  }

  clear(): void {
    this.notifiedFlag = false
  }

  /** Resolves on a notification (at once for one already made), after `ms`, or when `until` settles. */
  async wait(ms: number, until: Promise<unknown>): Promise<void> {
    if (!this.notifiedFlag) {
      const woken = new AbortController()
      this.wake = () => woken.abort()
      try {
        await Promise.race([until.catch(() => {}), sleep(ms, woken.signal)])
      } finally {
        this.wake = undefined
        woken.abort()
      }
    }
    this.notifiedFlag = false
  }
}
