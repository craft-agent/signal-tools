import { z } from "zod"
import type { LimitRule } from "../pages"
import { localTimeSchema } from "../time"
import { chatRef, messageEntry } from "./message-schema"

/** The methods of `signal_chat_read`. */
export const METHODS = ["list", "view", "search", "around"] as const
/** A method supported by `signal_chat_read`. */
export type Method = (typeof METHODS)[number]

/** The default and the largest `limit` of each method that pages. */
export const LIMITS = {
  list: { default: 30, max: 200 },
  view: { default: 50, max: 300 },
  search: { default: 30, max: 200 },
} as const satisfies Partial<Record<Method, LimitRule>>

/** The default and the largest number of messages `around` returns on each side of its anchor. */
export const AROUND_COUNT = { default: 5, max: 50 } as const satisfies LimitRule

/** The input schema for `signal_chat_read`. */
export const input = z.object({
  method: z
    .enum(METHODS)
    .describe(
      "`list` finds chats; `view` reads the newest messages of one chat between two times, oldest first; `search` finds messages by words, newest first; `around` reads the messages next to one message.",
    ),
  account: z.string().optional().describe("The account label; may be left out when only one account is linked."),
  query: z
    .string()
    .optional()
    .describe(
      "list: only chats whose name or number holds this text. search (required): words that must all appear, in the text, a caption or a file name of a message. Ignores case.",
    ),
  unread: z.boolean().optional().describe("list: only chats with unread messages."),
  last: z.boolean().optional().describe("list: add each chat's last message as `last_message`."),
  chat: z
    .string()
    .optional()
    .describe(
      "view and around (required), search (optional, to look in one chat): the chat id, from `list`: a person's account id or `group:<id>`. A name or number is not a chat.",
    ),
  after: z
    .string()
    .optional()
    .describe(
      "view and search: only messages after this time (exclusive): RFC 3339 with an offset, or a date or time without one, read as local time, such as 2026-11-07 or 2026-11-07T14:03.",
    ),
  before: z
    .string()
    .optional()
    .describe("view and search: only messages before this time (exclusive); the same forms as `after`."),
  id: z
    .string()
    .optional()
    .describe("around (required): the id of the message to read around, `<account id>:<sent time in ms>`."),
  before_count: z
    .number()
    .int()
    .optional()
    .describe(
      `around: how many messages before the one with \`id\` (default ${AROUND_COUNT.default}, at most ${AROUND_COUNT.max}, 0 for none).`,
    ),
  after_count: z
    .number()
    .int()
    .optional()
    .describe(
      `around: how many messages after the one with \`id\` (default ${AROUND_COUNT.default}, at most ${AROUND_COUNT.max}, 0 for none).`,
    ),
  limit: z
    .number()
    .int()
    .optional()
    .describe(
      `How many to return. list: default ${LIMITS.list.default}, at most ${LIMITS.list.max}. view: default ${LIMITS.view.default}, at most ${LIMITS.view.max}. search: default ${LIMITS.search.default}, at most ${LIMITS.search.max}. A larger value is lowered to the most; a result may hold fewer to stay a size a model can read.`,
    ),
  cursor: z.string().optional().describe("The `next` of the previous result, to continue where it stopped."),
})

/** The parsed input to `signal_chat_read`. */
export type ChatReadInput = z.output<typeof input>

const chatEntry = chatRef.extend({
  number: z.string().optional().describe("A person's phone number, when known."),
  unread: z.number().describe("Incoming messages not read yet."),
  last_activity_at: localTimeSchema.optional().describe("The latest message's time, in local time with offset."),
  disappearing_seconds: z.number().optional().describe("The chat's disappearing-message timer, when on."),
  left: z.literal(true).optional().describe("Set for a group the user has left."),
  last_message: messageEntry.nullable().optional().describe("With `last`: the chat's last message, or null."),
})

/** One chat in a `list` result. */
export type ChatEntry = z.infer<typeof chatEntry>

/** The output schema for `signal_chat_read`. */
export const output = z.object({
  chats: z.array(chatEntry).optional().describe("list: the chats, newest activity first."),
  chat: chatRef.optional().describe("view and around: the chat read."),
  messages: z
    .array(messageEntry)
    .optional()
    .describe("view and around: the messages, oldest first. search: the hits, newest first, each with its `chat`."),
  anchor: z.string().optional().describe("around: the id of the message read around, which `messages` includes."),
  trimmed_before: z
    .number()
    .optional()
    .describe("around: how many of the messages asked for before the anchor were left out to stay a readable size."),
  trimmed_after: z
    .number()
    .optional()
    .describe("around: how many of the messages asked for after the anchor were left out to stay a readable size."),
  scanned_to: localTimeSchema
    .optional()
    .describe(
      "search: set when the search stopped at the most messages one call looks through, before reaching the end of the history or the end of the range. It is the sent time of the oldest message looked through; the hits are only those newer than it, and `next` continues from there. A page can hold fewer hits than `limit`, even none.",
    ),
  next: z.string().optional().describe("Pass back as `cursor` to continue; absent when there is no more."),
  note: z.string().describe("Says that what the result carries is data written by other people."),
})

/** The result returned by `signal_chat_read`. */
export type ChatReadOutput = z.input<typeof output>
