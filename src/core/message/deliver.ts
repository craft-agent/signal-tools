import { ToolError, isToolError } from "../errors"
import { callDaemon, isDaemonNotRunning, syncServiceNotRunning } from "../signal/daemon"
import { isRecord, rpcErrorData } from "../signal/daemon-errors"
import { readSendResults, sendOutcome, type SendResults } from "../signal/daemon-results"
import { GROUP_PREFIX, isGroupChat } from "../signal/ids"
import type { LabelPaths } from "../signal/labels"
import { UNCERTAIN_MESSAGES, type DeliveryAction } from "./constants"
import type { PreparedChat } from "./prepare"

/** How long signal-cli may take to answer a request that waits for every recipient. */
const DELIVERY_TIMEOUT_MS = 60_000

/** How a delivery is carried out. */
export type DeliveryOptions = {
  /** What the delivery does; it sets the words of an `uncertain` outcome, whichever way the answer was lost. */
  action: DeliveryAction
  /** Cancels the call; one already written to the daemon then ends `uncertain`. */
  signal?: AbortSignal
  /** How long the daemon may take to answer; a minute by default. */
  timeoutMs?: number
}

/**
 * signal-cli's recipient arguments for a chat. A person is named by account
 * id, a group by its id without the prefix, and Note to Self by its own flag.
 */
function recipientParams({ chat, noteToSelf }: PreparedChat): Record<string, unknown> {
  if (noteToSelf) return { noteToSelf: true }
  return isGroupChat(chat.id) ? { groupId: chat.id.slice(GROUP_PREFIX.length) } : { recipient: [chat.id] }
}

/**
 * The per-recipient results of a request that failed as a call, from the
 * `data.response` of its error. Undefined when the error carries no results
 * (none, or an empty list), and the error then stands for its own code. Results
 * that are there but cannot be read throw `uncertain`: some recipient may have
 * got the message.
 */
function failedResults(error: unknown, method: string): SendResults | undefined {
  const data = rpcErrorData(error)
  const response = isRecord(data) ? data.response : undefined
  if (!isRecord(response) || response.results === undefined || response.results === null) return undefined
  if (Array.isArray(response.results) && response.results.length === 0) return undefined
  return readSendResults(response, method)
}

/**
 * Note to Self answers with the timestamp only; it is read as one recipient
 * that got the message. A result that does name its recipients is left as it is.
 */
function withSelfResult(reply: unknown, noteToSelf: boolean): unknown {
  if (!noteToSelf || !isRecord(reply)) return reply
  const { results } = reply
  if (results !== undefined && !(Array.isArray(results) && results.length === 0)) return reply
  return { ...reply, results: [{ recipientAddress: {}, type: "SUCCESS" }] }
}

/** The results, once they carry a sent time a message id can be made of. */
function withSentTime(results: SendResults): SendResults {
  if (!Number.isSafeInteger(results.timestamp) || results.timestamp <= 0) {
    throw new ToolError("uncertain", "signal-cli accepted the send without a usable sent time.")
  }
  return results
}

async function deliverOnce(
  paths: LabelPaths,
  prepared: PreparedChat,
  method: string,
  params: Record<string, unknown>,
  { signal, timeoutMs = DELIVERY_TIMEOUT_MS }: DeliveryOptions,
): Promise<SendResults> {
  let reply: unknown
  try {
    reply = await callDaemon(
      paths.socket,
      method,
      { ...recipientParams(prepared), ...params },
      {
        effect: "write",
        timeoutMs,
        signal,
      },
    )
  } catch (error) {
    if (isDaemonNotRunning(error)) throw syncServiceNotRunning(error)
    const failed = failedResults(error, method)
    if (failed) return withSentTime(sendOutcome(failed, method))
    throw error
  }
  const results = readSendResults(withSelfResult(reply, prepared.noteToSelf), method)
  return withSentTime(sendOutcome(results, method))
}

/**
 * Asks the label's daemon to carry out `method` (a request that goes to the
 * chat's recipients, such as `send` or `remoteDelete`) for the prepared chat,
 * with `params` besides the recipient's, and returns what Signal accepted, as
 * the outcome rule of docs/conventions.md "Writes" says: the daemon not
 * running and every failure known to have happened before anything went out
 * keep their codes, and every other failure after the request was written is
 * `uncertain`, with the message of the options' action.
 */
export async function deliver(
  paths: LabelPaths,
  prepared: PreparedChat,
  method: string,
  params: Record<string, unknown>,
  options: DeliveryOptions,
): Promise<SendResults> {
  try {
    return await deliverOnce(paths, prepared, method, params, options)
  } catch (error) {
    if (isToolError(error) && error.code === "uncertain") {
      throw new ToolError("uncertain", UNCERTAIN_MESSAGES[options.action], { cause: error })
    }
    throw error
  }
}
