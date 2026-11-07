import { z } from "zod"
import { localTimeSchema } from "../time"
import { MAX_EDITS, MAX_TEXT_CHARACTERS } from "./constants"
import { accountArgument, chatArgument, deliveryFields, recordErrors } from "./schema"

const idArgument = z
  .string()
  .describe(
    "The id of the user's own message in that chat, `<account id>:<sent time in ms>` as signal_chat_read gives it.",
  )

export const editInput = z.object({
  account: accountArgument,
  chat: chatArgument,
  id: idArgument,
  text: z
    .string()
    .describe(
      `The whole new text exactly as it should arrive; surrounding blank space is trimmed, and what is left is 1 to ${MAX_TEXT_CHARACTERS} characters.`,
    ),
})

export const editOutput = z.strictObject({
  id: z.string().describe("The edited message's id; an edit does not change it."),
  chat: z.string(),
  time: localTimeSchema.describe("When it was edited, in local time with offset."),
  edits_left: z.number().int().describe(`How many more edits Signal allows of this message, of ${MAX_EDITS} in all.`),
  ...deliveryFields("an edit"),
  errors: recordErrors("the edit was sent"),
})

/** What `signal_message_edit` returns. */
export type EditOutput = z.infer<typeof editOutput>

export const deleteInput = z.object({
  account: accountArgument,
  chat: chatArgument,
  id: idArgument,
})

export const deleteOutput = z.strictObject({
  id: z.string().describe("The deleted message's id."),
  chat: z.string(),
  deleted: z.literal(true),
  ...deliveryFields("a delete"),
  errors: recordErrors("the message was deleted for everyone"),
})

/** What `signal_message_delete` returns. */
export type DeleteOutput = z.infer<typeof deleteOutput>
