import { z } from "zod"
import { localTimeSchema } from "../time"
import { MAX_TEXT_CHARACTERS } from "./constants"

/** The argument every write takes to pick the account. */
export const accountArgument = z.string().optional().describe("The account label; absent picks the only linked label.")

/** The argument every write takes to name its chat. */
export const chatArgument = z
  .string()
  .describe(
    "The chat id, from signal_chat_read or signal_contact_read check: a person's account id, or `group:<id>`. The user's own account id is Note to Self.",
  )

export const input = z.object({
  account: accountArgument,
  chat: chatArgument,
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

/** The recipients a request did not reach. */
export type NotReached = z.infer<typeof notReached>

/** What a request to a chat's recipients reports besides its own result; `request` names it ("a send", "an edit"). */
export function deliveryFields(request: string) {
  return {
    reached: z
      .number()
      .int()
      .optional()
      .describe(`A group (or ${request} with a failure entry): how many recipients Signal accepted it for.`),
    not_reached: z
      .array(notReached)
      .optional()
      .describe("The recipients it did not reach, by account id, with the reason in plain words."),
  }
}

/** The `errors` of a result: `done` says what went out ("the message was sent") although it could not be written to the mirror. */
export function recordErrors(done: string) {
  return z
    .strictObject({ record: z.string() })
    .optional()
    .describe(`Set when ${done} but could not be written to the mirror.`)
}

export const output = z.strictObject({
  id: z.string().describe("The sent message's id, `<account id>:<sent time in ms>`."),
  chat: z.string(),
  time: localTimeSchema.describe("When it was sent, in local time with offset."),
  ...deliveryFields("a send"),
  errors: recordErrors("the message was sent"),
})

/** What the tool returns. */
export type SendOutput = z.infer<typeof output>
