import { ToolError, isToolError } from "../errors"
import { callDaemon, isDaemonNotRunning, syncServiceNotRunning } from "../signal/daemon"
import { isRecord, rpcErrorData } from "../signal/daemon-errors"
import { readSendResults, sendOutcome, type SendResults } from "../signal/daemon-results"
import { GROUP_PREFIX, isGroupChat } from "../signal/ids"
import type { LabelPaths } from "../signal/labels"
import type { PreparedSend } from "./prepare"
import type { Quote } from "./quote"

const SEND_METHOD = "send"

/** How long signal-cli may take to answer a send, which waits for every recipient. */
const SEND_TIMEOUT_MS = 60_000

/** What every `uncertain` send says, whichever way its answer was lost. */
const UNCERTAIN_SEND_MESSAGE = "The message may have been sent. Check the chat on the phone before sending it again."

/** A mention sits at one placeholder character of the quoted text. */
const QUOTED_MENTION_LENGTH = 1

/** The arguments that make the message a reply: the quoted message's time, author, text and mentions. */
function quoteParams(quote: Quote): Record<string, unknown> {
  const mentions = quote.mentions.map(
    (mention) => `${mention.start}:${QUOTED_MENTION_LENGTH}:${mention.uuid ?? mention.number}`,
  )
  return {
    quoteTimestamp: quote.timestamp,
    quoteAuthor: quote.author,
    ...(quote.text ? { quoteMessage: quote.text } : {}),
    ...(mentions.length > 0 ? { quoteMention: mentions } : {}),
  }
}

/**
 * signal-cli's `send` arguments. A person is named by account id, a group by
 * its id without the prefix, and Note to Self by its own flag. No expiry is
 * set: signal-cli applies the chat's disappearing timer itself.
 */
function sendParams({ chat, noteToSelf, quote }: PreparedSend, text: string): Record<string, unknown> {
  const to = noteToSelf
    ? { noteToSelf: true }
    : isGroupChat(chat.id)
      ? { groupId: chat.id.slice(GROUP_PREFIX.length) }
      : { recipient: [chat.id] }
  return { ...to, message: text, ...(quote ? quoteParams(quote) : {}) }
}

/**
 * The per-recipient results of a send that failed as a call, from the
 * `data.response` of its error. Undefined when the error carries no results
 * (none, or an empty list), and the error then stands for its own code. Results
 * that are there but cannot be read throw `uncertain`: some recipient may have
 * got the message.
 */
function failedResults(error: unknown): SendResults | undefined {
  const data = rpcErrorData(error)
  const response = isRecord(data) ? data.response : undefined
  if (!isRecord(response) || response.results === undefined || response.results === null) return undefined
  if (Array.isArray(response.results) && response.results.length === 0) return undefined
  return readSendResults(response, SEND_METHOD)
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

async function sendOnce(paths: LabelPaths, prepared: PreparedSend, text: string, signal?: AbortSignal) {
  let reply: unknown
  try {
    reply = await callDaemon(paths.socket, SEND_METHOD, sendParams(prepared, text), {
      effect: "write",
      timeoutMs: SEND_TIMEOUT_MS,
      signal,
    })
  } catch (error) {
    if (isDaemonNotRunning(error)) throw syncServiceNotRunning(error)
    const failed = failedResults(error)
    if (failed) return withSentTime(sendOutcome(failed, SEND_METHOD))
    throw error
  }
  const results = readSendResults(withSelfResult(reply, prepared.noteToSelf), SEND_METHOD)
  return withSentTime(sendOutcome(results, SEND_METHOD))
}

/**
 * Sends `text` to the prepared chat through the label's daemon and returns
 * what Signal accepted, as the outcome rule of docs/conventions.md "Writes"
 * says: the daemon not running and every failure known to have happened before
 * anything went out keep their codes, and every other failure after the
 * request was written is `uncertain`, with one message.
 */
export async function transmit(
  paths: LabelPaths,
  prepared: PreparedSend,
  text: string,
  signal?: AbortSignal,
): Promise<SendResults> {
  try {
    return await sendOnce(paths, prepared, text, signal)
  } catch (error) {
    if (isToolError(error) && error.code === "uncertain") {
      throw new ToolError("uncertain", UNCERTAIN_SEND_MESSAGE, { cause: error })
    }
    throw error
  }
}
