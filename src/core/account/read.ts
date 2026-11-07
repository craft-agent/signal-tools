import { existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { ToolError } from "../errors"
import { readLinkedAccount } from "../signal/account"
import { labelPaths, listLabels, pickLabel, type LabelPaths } from "../signal/labels"
import { getMeta, openMirrorForRead } from "../signal/mirror"
import {
  ERROR_META,
  LAST_RECEIVED_AT_META,
  REFRESHED_AT_META,
  STARTED_AT_META,
  STATUS_META,
  SUBSCRIBED_AT_META,
} from "../signal/mirror-meta"
import { isAlive, readPid } from "../signal/sync-wait"
import { formatLocalTime, localTimeSchema } from "../time"
import { defineTool } from "../tool"

const input = z.object({
  account: z.string().optional().describe("The account label; absent lists every label."),
})

const account = z.object({
  label: z.string().describe("The label used to select this account."),
  linked: z.enum(["linked", "unlinked", "not linked"]).describe("Whether this device is linked to the phone."),
  service: z
    .enum(["running", "starting", "stopped", "failed", "not running", "never run"])
    .describe("The recorded sync service state, corrected for a service process that is no longer alive."),
  last_received_at: localTimeSchema.nullable().describe("When a message was last received, in local time with offset."),
  subscribed_at: localTimeSchema
    .nullable()
    .describe("When the service subscribed to incoming messages, in local time with offset."),
  refreshed_at: localTimeSchema
    .nullable()
    .describe("When contacts and groups were last refreshed, in local time with offset."),
  error: z
    .string()
    .nullable()
    .describe("The recorded service error or mirror-version refusal, without message content or account identifiers."),
  action: z
    .enum(["link", "start_service", "check_service"])
    .nullable()
    .describe("The person's next step, or null when none is needed."),
  hint: z.string().nullable().describe("One sentence explaining the person's next step, or null."),
})

type Account = z.infer<typeof account>

const output = z.object({
  accounts: z.array(account).describe("Accounts sorted by label; no phone numbers, account ids or keys."),
})

function timestamp(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") return null
  const date = new Date(Number(value))
  return Number.isFinite(date.getTime()) ? formatLocalTime(date.getTime()) : null
}

function nextStep(result: Account, mirrorRefused: boolean): void {
  if (result.linked === "not linked") {
    result.action = "link"
    result.hint = "Link this device from the phone."
  } else if (result.linked === "unlinked") {
    result.action = "link"
    result.hint = "Signal unlinked this device; link it again from the phone."
  } else if (mirrorRefused) {
    result.action = "start_service"
    result.hint =
      "Restart the sync service to bring the mirror up to date; update the tools first if the mirror is newer."
  } else if (result.service === "failed") {
    result.action = "check_service"
    result.hint = "Check the sync service's status and log to find why it failed."
  } else if (result.service !== "running" && result.service !== "starting") {
    result.action = "start_service"
    result.hint = "Start the sync service to receive messages for this account."
  }
}

function readAccount(paths: LabelPaths): Account {
  const linked = readLinkedAccount(paths)
  const result: Account = {
    label: paths.label,
    linked: linked === null ? "not linked" : linked.registered === false ? "unlinked" : "linked",
    service: "never run",
    last_received_at: null,
    subscribed_at: null,
    refreshed_at: null,
    error: null,
    action: null,
    hint: null,
  }
  let mirrorRefused = false
  if (existsSync(paths.mirror)) {
    try {
      const mirror = openMirrorForRead(paths.mirror)
      try {
        const meta = getMeta(mirror)
        const status = meta[STATUS_META]
        if (status === "unlinked") {
          const startedAt = meta[STARTED_AT_META]
          const relinked =
            linked?.registered === true &&
            (startedAt === undefined ||
              (statSync(join(paths.signalCli, "data", "accounts.json"), { throwIfNoEntry: false })?.mtimeMs ??
                Number.NEGATIVE_INFINITY) > Number(startedAt))
          result.linked = relinked ? "linked" : "unlinked"
          result.service = "stopped"
        } else if (status === "running" || status === "starting") {
          const pid = readPid(paths.syncLock)
          result.service = pid !== undefined && isAlive(pid) ? status : "not running"
        } else {
          result.service = status === "failed" ? "failed" : "stopped"
        }
        result.last_received_at = timestamp(meta[LAST_RECEIVED_AT_META])
        result.subscribed_at = timestamp(meta[SUBSCRIBED_AT_META])
        result.refreshed_at = timestamp(meta[REFRESHED_AT_META])
        result.error = meta[ERROR_META] ?? null
      } finally {
        mirror.close()
      }
    } catch (error) {
      if (!(error instanceof ToolError) || (error.code !== "upstream_error" && error.code !== "not_found")) throw error
      if (error.code === "upstream_error") {
        result.service = "failed"
        result.error = error.message
        mirrorRefused = true
      }
    }
  }
  nextStep(result, mirrorRefused)
  return result
}

export const signalAccountRead = defineTool({
  id: "signal_account_read",
  title: "Read account status",
  description: [
    "Report account linking, sync service health and the person's next step for one label or every label.",
    "Reads local state only, needs no network or daemon, and never writes anything.",
    "Other people's text never appears here; no message content, phone numbers, account ids or keys are returned.",
  ].join(" "),
  toolset: "account",
  class: "read",
  input,
  output,
  async execute(args, ctx) {
    const stateDir = ctx.stateDir
    if (!stateDir) throw new ToolError("internal_error", "The entry point did not supply a state directory.")
    const paths =
      args.account !== undefined
        ? [await pickLabel(stateDir, args.account)]
        : (await listLabels(stateDir)).map((label) => labelPaths(stateDir, label))
    return { accounts: paths.map(readAccount) }
  },
})
