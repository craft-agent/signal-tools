import { z } from "zod"
import { ToolError } from "../errors"
import { pickLabel } from "../signal/labels"
import { defineTool } from "../tool"
import { checkNumbers } from "./check"
import { CONTACT_NAMES_NOTE, CONTACT_TOOL_ID } from "./constants"
import { listContacts } from "./list"

const input = z.object({
  method: z.enum(["list", "check"]).describe("List local contacts, or check up to three numbers with Signal."),
  account: z.string().optional().describe("The account label; absent picks the only linked label."),
  query: z.string().optional().describe("For list: part of a name, profile name, number or username, ignoring case."),
  limit: z.number().int().min(1).optional().describe("For list: page size, default 30; values above 200 are clamped."),
  cursor: z.string().optional().describe("For list: the opaque next cursor returned by this tool."),
  numbers: z.array(z.string()).optional().describe("For check: one to three phone numbers with + and country code."),
})

export const contact = z.object({
  chat: z.string(),
  name: z.string().nullable(),
  profile_name: z.string().optional(),
  number: z.string().optional(),
  username: z.string().optional(),
  blocked: z.literal(true).optional(),
})

const output = z.object({
  contacts: z.array(contact).optional(),
  next: z.string().optional(),
  numbers: z.array(z.object({ number: z.string(), on_signal: z.boolean(), chat: z.string().optional() })).optional(),
  note: z.string(),
})

export const signalContactRead = defineTool({
  id: CONTACT_TOOL_ID,
  title: "Read contacts",
  description: [
    "List contacts from the local mirror only, without a daemon, or check at most three numbers with Signal.",
    "Check asks through the running sync service's daemon and is the one read that needs it; neither method writes the mirror.",
    CONTACT_NAMES_NOTE,
  ].join(" "),
  toolset: "contacts",
  class: "read",
  input,
  output,
  async execute(args, ctx) {
    if (!ctx.stateDir) throw new ToolError("internal_error", "The entry point did not supply a state directory.")
    if (args.method === "list" && args.numbers !== undefined) {
      throw new ToolError("invalid_argument", "numbers is only used with method check.")
    }
    if (
      args.method === "check" &&
      (args.query !== undefined || args.limit !== undefined || args.cursor !== undefined)
    ) {
      throw new ToolError("invalid_argument", "query, limit and cursor are only used with method list.")
    }
    const paths = await pickLabel(ctx.stateDir, args.account)
    return args.method === "list" ? listContacts(paths, args) : checkNumbers(paths, args.numbers, ctx.signal)
  },
})
