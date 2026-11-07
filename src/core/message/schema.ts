import { z } from "zod"
import { localTimeSchema } from "../time"
import { MAX_TEXT_CHARACTERS } from "./constants"

export const input = z.object({
  account: z.string().optional().describe("The account label; absent picks the only linked label."),
  chat: z
    .string()
    .describe(
      "The chat id, from signal_chat_read or signal_contact_read check: a person's account id, or `group:<id>`. The user's own account id is Note to Self.",
    ),
  text: z
    .string()
    .describe(
      `The text exactly as it should arrive; surrounding blank space is trimmed, and what is left is 1 to ${MAX_TEXT_CHARACTERS} characters.`,
    ),
  reply_to: z
    .string()
    .optional()
    .describe("The id of a message of that chat to quote, `<account id>:<sent time in ms>` as a read gives it."),
})

const notReached = z.strictObject({
  id: z.string().optional().describe("The member's account id; absent when Signal did not name one."),
  reason: z.string(),
})

export const output = z.strictObject({
  id: z.string().describe("The sent message's id, `<account id>:<sent time in ms>`."),
  chat: z.string(),
  time: localTimeSchema.describe("When it was sent, in local time with offset."),
  reached: z
    .number()
    .int()
    .optional()
    .describe("A group (or a send with a failure entry): how many recipients Signal accepted it for."),
  not_reached: z
    .array(notReached)
    .optional()
    .describe("The recipients it did not reach, by account id, with the reason in plain words."),
  errors: z
    .strictObject({ record: z.string() })
    .optional()
    .describe("Set when the message was sent but could not be written to the mirror."),
})

/** What the tool returns. */
export type SendOutput = z.infer<typeof output>
