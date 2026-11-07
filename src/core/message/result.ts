import type { FailureReason, RecipientFailure, SendResults } from "../signal/daemon-results"
import { isGroupChat, messageId } from "../signal/ids"
import { formatLocalTime } from "../time"
import type { DeleteOutput, EditOutput, ReactOutput } from "./action-schema"
import type { NotReached, SendOutput } from "./schema"

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
 * For a group, or a request with a failure entry, how many recipients Signal
 * accepted it for and the ones it did not reach, by account id. Never a number.
 */
export function deliveryResult(chat: string, sent: SendResults): { reached?: number; not_reached?: NotReached[] } {
  const result: { reached?: number; not_reached?: NotReached[] } = {}
  if (isGroupChat(chat) || sent.failed.length > 0) result.reached = sent.delivered_count
  if (sent.failed.length > 0) {
    result.not_reached = sent.failed.map((failure) => ({
      ...(failure.recipient ? { id: failure.recipient } : {}),
      reason: reasonOf(failure),
    }))
  }
  return result
}

/** The result of a send Signal accepted: the message's id and time, and who it reached. */
export function sendResult(chat: string, me: string, sent: SendResults): SendOutput {
  return {
    id: messageId(me, sent.timestamp),
    chat,
    time: formatLocalTime(sent.timestamp),
    ...deliveryResult(chat, sent),
  }
}

/** The result of an edit Signal accepted: the edited message's id, when it was edited, and who it reached. */
export function editResult(chat: string, id: string, sent: SendResults, editsLeft: number): EditOutput {
  return {
    id,
    chat,
    time: formatLocalTime(sent.timestamp),
    edits_left: editsLeft,
    ...deliveryResult(chat, sent),
  }
}

/** The result of a delete for everyone Signal accepted: the deleted message's id, and who it reached. */
export function deleteResult(chat: string, id: string, sent: SendResults): DeleteOutput {
  return { id, chat, deleted: true, ...deliveryResult(chat, sent) }
}

/** The result of a reaction Signal accepted: the message, the emoji set or removed, and who it reached. */
export function reactResult(
  chat: string,
  id: string,
  reaction: { emoji: string; remove: boolean },
  sent: SendResults,
): ReactOutput {
  return {
    id,
    chat,
    emoji: reaction.emoji,
    ...(reaction.remove ? { removed: true as const } : {}),
    ...deliveryResult(chat, sent),
  }
}
