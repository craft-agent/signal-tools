import { z } from "zod"
import type { LimitRule } from "../pages"
import { localTimeSchema } from "../time"
import { messageEntry } from "./message-schema"

/** The methods of `signal_chat_read`. */
export const METHODS = ["list", "view"] as const
export type Method = (typeof METHODS)[number]

/** The default and the largest `limit` of each method. */
export const LIMITS = {
  list: { default: 30, max: 200 },
  view: { default: 50, max: 300 },
} as const satisfies Record<Method, LimitRule>

export const input = z.object({
  method: z
    .enum(METHODS)
    .describe("`list` finds chats; `view` reads the newest messages of one chat between two times, oldest first."),
  account: z.string().optional().describe("The account label; may be left out when only one account is linked."),
  query: z.string().optional().describe("list: only chats whose name or number holds this text, ignoring case."),
  unread: z.boolean().optional().describe("list: only chats with unread messages."),
  last: z.boolean().optional().describe("list: add each chat's last message as `last_message`."),
  chat: z
    .string()
    .optional()
    .describe("view: the chat id, from `list`: a person's account id or `group:<id>`. A name or number is not a chat."),
  after: z
    .string()
    .optional()
    .describe(
      "view: only messages after this time (exclusive): RFC 3339 with an offset, or a date or time without one, read as local time, such as 2026-11-07 or 2026-11-07T14:03.",
    ),
  before: z
    .string()
    .optional()
    .describe("view: only messages before this time (exclusive); the same forms as `after`."),
  limit: z
    .number()
    .int()
    .optional()
    .describe(
      `How many to return. list: default ${LIMITS.list.default}, at most ${LIMITS.list.max}. view: default ${LIMITS.view.default}, at most ${LIMITS.view.max}. A larger value is lowered to the most; a result may hold fewer to stay a size a model can read.`,
    ),
  cursor: z.string().optional().describe("The `next` of the previous result, to continue where it stopped."),
})

export type ChatReadInput = z.output<typeof input>

const nameCut = z
  .literal(true)
  .optional()
  .describe("Set when the name was longer than the most a result carries and was cut.")

const chatEntry = z.object({
  id: z.string().describe("The chat id: a person's account id or `group:<id>`."),
  kind: z.enum(["person", "group"]),
  name: z.string().nullable().describe("`Note to Self` for the user's own chat, a group's title, or a person's name."),
  name_cut: nameCut,
  number: z.string().optional().describe("A person's phone number, when known."),
  unread: z.number().describe("Incoming messages not read yet."),
  last_activity_at: localTimeSchema.optional().describe("The latest message's time, in local time with offset."),
  disappearing_seconds: z.number().optional().describe("The chat's disappearing-message timer, when on."),
  left: z.literal(true).optional().describe("Set for a group the user has left."),
  last_message: messageEntry.nullable().optional().describe("With `last`: the chat's last message, or null."),
})

export type ChatEntry = z.infer<typeof chatEntry>

export const output = z.object({
  chats: z.array(chatEntry).optional().describe("list: the chats, newest activity first."),
  chat: z
    .object({ id: z.string(), kind: z.enum(["person", "group"]), name: z.string().nullable(), name_cut: nameCut })
    .optional()
    .describe("view: the chat read."),
  messages: z.array(messageEntry).optional().describe("view: the messages, oldest first."),
  next: z.string().optional().describe("Pass back as `cursor` to continue; absent when there is no more."),
  note: z.string().describe("Says that what the result carries is data written by other people."),
})

export type ChatReadOutput = z.input<typeof output>
