import { ToolError } from "../errors"
import { isRecord, UNCERTAIN_ADVICE } from "./daemon-errors"

export type FailureReason = "unregistered" | "identity" | "rate_limit" | "proof_required" | "network" | "unknown"

export type RecipientFailure = {
  /** The recipient's account id (UUID), or null when signal-cli named it by number or username only. */
  recipient: string | null
  reason: FailureReason
  retry_after_seconds?: number
}

export type SendResults = {
  /** The sent time in milliseconds. */
  timestamp: number
  /** The account ids (UUIDs) of the recipients that got the message; never a number. */
  delivered: string[]
  /** How many recipients got the message: `delivered.length` plus those signal-cli named by number or username only. */
  delivered_count: number
  failed: RecipientFailure[]
}

const SUCCESS = "SUCCESS"

/** An account id as signal-cli writes it: 8-4-4-4-12 hexadecimal digits. Anything else is not kept as an id. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const FAILURE_REASONS: Record<string, FailureReason> = {
  UNREGISTERED_FAILURE: "unregistered",
  IDENTITY_FAILURE: "identity",
  RATE_LIMIT_FAILURE: "rate_limit",
  PROOF_REQUIRED_FAILURE: "proof_required",
  NETWORK_FAILURE: "network",
}

function unreadable(method: string): ToolError {
  return new ToolError(
    "uncertain",
    `signal-cli answered ${method} in a form that could not be read, so the message may have gone out. ${UNCERTAIN_ADVICE}`,
  )
}

/**
 * Reads the result of a send, one entry per recipient. A result that is not
 * shaped as signal-cli documents is `uncertain`, since the request already
 * went out.
 */
export function readSendResults(result: unknown, method: string): SendResults {
  if (!isRecord(result) || typeof result.timestamp !== "number" || !Array.isArray(result.results)) {
    throw unreadable(method)
  }
  const sent: SendResults = { timestamp: result.timestamp, delivered: [], delivered_count: 0, failed: [] }
  for (const entry of result.results as unknown[]) {
    if (!isRecord(entry) || !isRecord(entry.recipientAddress) || typeof entry.type !== "string") {
      throw unreadable(method)
    }
    const { uuid } = entry.recipientAddress
    const recipient = typeof uuid === "string" && UUID.test(uuid) ? uuid : null
    if (entry.type === SUCCESS) {
      sent.delivered_count += 1
      if (recipient) sent.delivered.push(recipient)
      continue
    }
    const { retryAfterSeconds } = entry
    sent.failed.push({
      recipient,
      reason: FAILURE_REASONS[entry.type] ?? "unknown",
      ...(typeof retryAfterSeconds === "number" && retryAfterSeconds >= 0
        ? { retry_after_seconds: retryAfterSeconds }
        : {}),
    })
  }
  return sent
}

/**
 * The outcome rule of docs/conventions.md "Writes": the results when at least
 * one recipient got the message (the failures listed in them). When nobody
 * did, a failure known to have happened before anything went out throws its
 * code; every other case, including a result without recipients, throws
 * `uncertain`.
 */
export function sendOutcome(results: SendResults, method: string): SendResults {
  if (results.delivered_count > 0) return results
  const reasons = new Set(results.failed.map((failure) => failure.reason))
  if (reasons.size === 0 || reasons.has("network") || reasons.has("unknown")) {
    throw new ToolError(
      "uncertain",
      `${method} may have taken effect: signal-cli did not confirm a delivery to any recipient. ${UNCERTAIN_ADVICE}`,
    )
  }
  if (reasons.has("identity")) {
    throw new ToolError(
      "forbidden",
      `${method} did not go out because a recipient's safety number changed; verify it on the phone, then try again.`,
    )
  }
  if (reasons.has("rate_limit") || reasons.has("proof_required")) {
    const waits = results.failed.flatMap((failure) => failure.retry_after_seconds ?? [])
    const wait = waits.length > 0 ? ` Try again in ${Math.max(...waits)} seconds.` : " Try again later."
    throw new ToolError("rate_limited", `Signal rate-limited ${method}, so it did not go out.${wait}`)
  }
  throw new ToolError("not_found", `${method} did not go out: no recipient is registered on Signal.`)
}
