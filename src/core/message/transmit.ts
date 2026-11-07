import type { SendResults } from "../signal/daemon-results"
import type { LabelPaths } from "../signal/labels"
import { deliver } from "./deliver"
import type { PreparedSend } from "./prepare"
import { quoteParams } from "./quote"

const SEND_METHOD = "send"

/** What a send carries besides its text. */
export type TransmitOptions = {
  /** Paths of the files to attach, which signal-cli reads while the call runs. */
  attachments?: readonly string[]
  /** How long the daemon may take to answer; the delivery's own limit by default. */
  timeoutMs?: number
}

/**
 * Sends `text` and the attachments to the prepared chat, as a reply when it
 * has a quote, and returns what Signal accepted (see `deliver`). An empty
 * `text` sends no message, only the attachments. No expiry is set: signal-cli
 * applies the chat's disappearing timer itself.
 */
export function transmit(
  paths: LabelPaths,
  prepared: PreparedSend,
  text: string,
  signal?: AbortSignal,
  { attachments = [], timeoutMs }: TransmitOptions = {},
): Promise<SendResults> {
  const params = {
    ...(text === "" ? {} : { message: text }),
    ...(attachments.length > 0 ? { attachment: [...attachments] } : {}),
    ...(prepared.quote ? quoteParams(prepared.quote) : {}),
  }
  return deliver(paths, prepared, SEND_METHOD, params, { action: "send", signal, timeoutMs })
}
