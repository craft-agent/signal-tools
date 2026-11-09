import { z } from "zod"
import { MAX_TEXT_CHARACTERS } from "../../message/constants"
import {
  deliveryFields,
  input as messageInput,
  accountArgument,
  chatArgument,
  recordErrors,
} from "../../message/schema"
import { localTimeSchema } from "../../time"
import { MAX_FILES } from "../../outgoing/limits"

/** The pattern of a SHA-256 given as 64 hexadecimal digits, in either case. */
const SHA256_PATTERN = /^[0-9a-fA-F]{64}$/

const fileArgument = z.strictObject({
  path: z
    .string()
    .min(1)
    .describe(
      "The file's path, absolute or relative to the working directory; a leading ~ is not expanded. It must be in the working directory or a send directory, and not a key, secret, program or installer.",
    ),
  sha256: z
    .string()
    .regex(SHA256_PATTERN, "must be 64 hexadecimal digits")
    .optional()
    .describe(
      "The SHA-256 of the file as the user approved it, 64 hexadecimal digits. A file that differs is refused as `stale`. Without it the file is sent as it is when the call runs.",
    ),
})

/** The arguments the `signal_file_send` tool takes. */
export const input = z.object({
  account: accountArgument,
  chat: chatArgument,
  files: z
    .array(fileArgument)
    .min(1)
    .max(MAX_FILES)
    .describe(`1 to ${MAX_FILES} files, each at most once; all together within the size a send takes (100 MiB).`),
  text: z
    .string()
    .optional()
    .describe(
      `A caption sent with the files, exactly as it should arrive; surrounding blank space is trimmed, and what is left is at most ${MAX_TEXT_CHARACTERS} characters. Left out or blank, only the files are sent.`,
    ),
  reply_to: messageInput.shape.reply_to,
})

const sentFile = z.strictObject({
  path: z.string().describe("The file's real path, with links resolved."),
  name: z.string().describe("The name it was sent under."),
  size: z.number().int().describe("Its size in bytes."),
  sha256: z.string().describe("Its SHA-256 as it was sent, in lower-case hexadecimal."),
})

/** What the `signal_file_send` tool returns on success. */
export const output = z.strictObject({
  id: z.string().describe("The sent message's id, `<account id>:<sent time in ms>`."),
  chat: z.string(),
  time: localTimeSchema.describe("When it was sent, in local time with offset."),
  ...deliveryFields("a send"),
  files: z.array(sentFile).describe("The files that were sent, in the order given."),
  errors: recordErrors("the files were sent"),
})

/** The arguments of `signal_file_send`, parsed. */
export type FileSendArguments = z.output<typeof input>

/** What the `signal_file_send` tool returns on success. */
export type FileSendOutput = z.infer<typeof output>
