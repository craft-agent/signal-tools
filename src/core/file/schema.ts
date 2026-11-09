import { z } from "zod"

export const input = z.object({
  account: z.string().optional().describe("The account label; absent picks the only linked label."),
  chat: z.string().describe("The chat id the message is in, from signal_chat_read."),
  id: z
    .string()
    .describe(
      "The message's id, `<account id>:<sent time in ms>`, as signal_chat_read gives it; the message has files.",
    ),
  unpack: z
    .boolean()
    .optional()
    .describe(
      "Also unpack each archive (zip, tar, gzipped tar) among the files, after inspecting it again. Ask for it only when the user wants the contents.",
    ),
})

/** The arguments of `signal_file_save`, parsed. */
export type FileSaveArguments = z.output<typeof input>

const entry = z.strictObject({
  name: z.string().describe("The entry's path in the archive, cleaned of control and invisible characters."),
  size: z.number().int(),
  dir: z.literal(true).optional().describe("Set for a directory."),
})

const archive = z.strictObject({
  format: z.enum(["zip", "tar", "tgz"]),
  files: z.number().int().describe("How many entries are files."),
  total_size: z.number().int().describe("The bytes the files unpack to."),
  entries: z.array(entry),
  entries_cut: z
    .literal(true)
    .optional()
    .describe("Set when `entries` lists only the first entries, to keep the result short; `files` counts them all."),
})

const savedFile = z.strictObject({
  name: z.string().describe("The name it is saved under, which may differ from the one it was sent with."),
  path: z.string().describe("Where it is saved."),
  type: z.string().optional().describe("The content type its sender gave it."),
  size: z.number().int().describe("Its size in bytes."),
  sha256: z.string().describe("Its SHA-256, in lower-case hexadecimal."),
  already_saved: z.literal(true).optional().describe("Set when the same file was already there and was kept."),
  archive: archive.optional().describe("What an archive holds, after inspection."),
  unpacked: z.string().optional().describe("The folder an archive was unpacked into."),
  already_unpacked: z
    .literal(true)
    .optional()
    .describe("Set when that folder was already there and nothing was written."),
})

export const output = z.strictObject({
  chat: z.string(),
  id: z.string(),
  folder: z.string().describe("The folder the message's files are saved in."),
  files: z.array(savedFile),
  refused: z
    .array(z.strictObject({ name: z.string(), reason: z.string() }))
    .optional()
    .describe("Files that were not saved, with the reason: a program, an installer, a risky archive."),
  missing: z
    .array(z.strictObject({ name: z.string(), reason: z.string() }))
    .optional()
    .describe("Files signal-cli does not have."),
  private_note: z.string().optional().describe("Set for a disappearing message: show its files to the user only."),
  note: z.string(),
  errors: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "Steps that failed after files were saved, keyed by step: `quarantine`, `unpack:<name>`, `save:<name>`; what was saved stays.",
    ),
})

/** What the tool returns. */
export type FileSaveOutput = z.infer<typeof output>
export type SavedFile = FileSaveOutput["files"][number]
