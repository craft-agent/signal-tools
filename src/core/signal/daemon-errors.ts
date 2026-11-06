import { ToolError } from "../errors"

/** What every `uncertain` error tells the person to do. */
export const UNCERTAIN_ADVICE = "Check on the phone before trying again."

/** `+` and then six or more digits, each optionally preceded by a space or a dash. */
const PHONE_NUMBER = /\+(?:[ -]?\d){6,}/g

/** How much of signal-cli's own message text an error carries. */
const MAX_DETAIL_LENGTH = 300

/** The JSON-RPC and signal-cli error codes of `signal-cli daemon`. */
export const RpcCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  UserError: -1,
  UntrustedKey: -4,
  RateLimit: -5,
  CaptchaRejected: -6,
} as const

/** Whether a call can change something on Signal: a write that fails after its request was written may have taken effect. */
export type CallEffect = "read" | "write"

/** Replaces anything shaped like a phone number (`+` and 6 or more digits, optionally separated by spaces or dashes) with `[number]`. */
export function maskNumbers(text: string): string {
  return text.replace(PHONE_NUMBER, "[number]")
}

/** signal-cli's own message text for an error: masked, cut, and led by `: `; empty when there is none. */
export function detail(message: string): string {
  const text = maskNumbers(message).trim().slice(0, MAX_DETAIL_LENGTH)
  return text ? `: ${text}` : ""
}

/** A failure that leaves the outcome unknown once the request was written: `uncertain` for a write, `upstream_error` for a read. */
export function afterWriteError(method: string, effect: CallEffect, reason: string): ToolError {
  return effect === "write"
    ? new ToolError("uncertain", `${method} may have taken effect (${reason}). ${UNCERTAIN_ADVICE}`)
    : new ToolError("upstream_error", `${method} failed (${reason}).`)
}

export function rpcError(method: string, effect: CallEffect, code: number | undefined, message: string): ToolError {
  switch (code) {
    case RpcCode.ParseError:
    case RpcCode.InvalidRequest:
      return new ToolError("internal_error", `signal-cli found the ${method} request malformed${detail(message)}`)
    case RpcCode.MethodNotFound:
      return new ToolError("upstream_error", `signal-cli does not know ${method}; update signal-cli.`)
    case RpcCode.InvalidParams:
      return new ToolError("invalid_argument", `signal-cli refused the arguments of ${method}${detail(message)}`)
    case RpcCode.UserError:
      return new ToolError("invalid_argument", `signal-cli refused ${method}${detail(message)}`)
    case RpcCode.UntrustedKey:
      return new ToolError(
        "forbidden",
        `signal-cli refused ${method} because a safety number changed; verify it on the phone${detail(message)}`,
      )
    case RpcCode.RateLimit:
      return new ToolError("rate_limited", `Signal rate-limited ${method}; try again later${detail(message)}`)
    case RpcCode.CaptchaRejected:
      return new ToolError(
        "rate_limited",
        `Signal rejected the captcha for ${method}; try again later${detail(message)}`,
      )
    default:
      return afterWriteError(
        method,
        effect,
        `signal-cli answered with error ${code === undefined ? "without a code" : code}${detail(message)}`,
      )
  }
}

/** Whether a parsed JSON value is an object that is not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
