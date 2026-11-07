import type { SendResults } from "../signal/daemon-results"
import type { LabelPaths } from "../signal/labels"
import { deliver } from "./deliver"
import type { PreparedSend } from "./prepare"
import { quoteParams } from "./quote"

const SEND_METHOD = "send"

/**
 * Sends `text` to the prepared chat, as a reply when it has a quote, and
 * returns what Signal accepted (see `deliver`). No expiry is set: signal-cli
 * applies the chat's disappearing timer itself.
 */
export function transmit(
  paths: LabelPaths,
  prepared: PreparedSend,
  text: string,
  signal?: AbortSignal,
): Promise<SendResults> {
  const params = { message: text, ...(prepared.quote ? quoteParams(prepared.quote) : {}) }
  return deliver(paths, prepared, SEND_METHOD, params, { action: "send", signal })
}
