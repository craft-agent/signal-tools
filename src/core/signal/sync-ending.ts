/** What ended receiving: a stop request, the daemon exiting, its connection closing, a mirror that cannot be written, or a failure. */
export type EndKind = "stop" | "child" | "connection" | "storage" | "socket" | "error"

export type Ended = {
  kind: EndKind
  /** Why, for a failure whose cause is known when it happens. */
  reason?: string
}

/** The one reason a run of receiving ends for: whichever comes first wins. */
export class Ending {
  /** Resolves with the first reason given to `end`. */
  readonly promise: Promise<Ended>
  private readonly controller = new AbortController()
  private resolve: (ended: Ended) => void = () => {}
  private result: Ended | undefined

  constructor() {
    this.promise = new Promise((resolve) => (this.resolve = resolve))
  }

  /** Aborts once receiving has ended, so calls still waiting on the daemon give up. */
  get signal(): AbortSignal {
    return this.controller.signal
  }

  get settled(): boolean {
    return this.result !== undefined
  }

  end(ended: Ended): void {
    if (this.result) return
    this.result = ended
    this.resolve(ended)
    this.controller.abort()
  }
}
