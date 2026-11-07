import type { FailureReason, RecipientFailure, SendResults } from "../signal/daemon-results"
import { isGroupChat, messageId } from "../signal/ids"
import { formatLocalTime } from "../time"
import type { SendOutput } from "./schema"

const REASONS: Record<FailureReason, string> = {
  unregistered: "not on Signal",
  identity: "safety number changed; verify it on the phone",
  rate_limit: "Signal rate-limited the send",
  proof_required: "Signal asks for a verification challenge before it sends more",
  network: "network failure; it may still arrive",
  unknown: "failed for a reason Signal did not give",
}

/** A recipient's failure in plain words, with the wait Signal asked for when it gave one. */
function reasonOf({ reason, retry_after_seconds }: RecipientFailure): string {
  return retry_after_seconds === undefined
    ? REASONS[reason]
    : `${REASONS[reason]}; try again in ${retry_after_seconds} seconds`
}

/**
 * The result of a send Signal accepted: the message's id and time, and for a
 * group, or a send with a failure entry, how many recipients it reached and
 * the ones it did not, by account id. Never a number.
 */
export function sendResult(chat: string, me: string, sent: SendResults): SendOutput {
  const result: SendOutput = {
    id: messageId(me, sent.timestamp),
    chat,
    time: formatLocalTime(sent.timestamp),
  }
  if (isGroupChat(chat) || sent.failed.length > 0) result.reached = sent.delivered_count
  if (sent.failed.length > 0) {
    result.not_reached = sent.failed.map((failure) => ({
      ...(failure.recipient ? { id: failure.recipient } : {}),
      reason: reasonOf(failure),
    }))
  }
  return result
}
