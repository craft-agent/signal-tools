import { Buffer } from "node:buffer"
import { isReservedDeviceName, plainPathProblem } from "../archive/entry-names"
import { hasMisleadingCharacters } from "../archive/name-characters"
import { foldCase } from "../fold"

/** The most bytes a file name may take: what every file system takes. */
const MAX_NAME_BYTES = 255

/** The longest extension kept apart when a name is shortened or numbered, dot included, in bytes. */
const MAX_EXTENSION_BYTES = 32

/** Characters that separate paths or that Windows does not allow in a name. */
const UNSAFE_CHARACTERS = /[/\\:<>"|?*]/

const TRAILING_DOTS_AND_SPACES = /[. ]+$/

/** File extensions by the content types of the files people send. */
const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/avif": ".avif",
  "image/bmp": ".bmp",
  "image/tiff": ".tiff",
  "image/svg+xml": ".svg",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "video/3gpp": ".3gp",
  "video/mpeg": ".mpeg",
  "audio/mpeg": ".mp3",
  "audio/aac": ".aac",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/ogg": ".ogg",
  "audio/opus": ".opus",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "application/pdf": ".pdf",
  "application/json": ".json",
  "application/zip": ".zip",
  "application/x-tar": ".tar",
  "application/gzip": ".gz",
  "text/plain": ".txt",
  "text/csv": ".csv",
  "text/html": ".html",
  "text/markdown": ".md",
  "text/vcard": ".vcf",
}

function byteLength(text: string): number {
  return Buffer.byteLength(text)
}

/** The extension a content type stands for, with its dot, or none. */
function extensionOf(type: string | undefined): string {
  return type === undefined ? "" : (EXTENSIONS[type.split(";")[0]!.trim().toLowerCase()] ?? "")
}

/** A name apart from its last extension (a dot and up to 32 bytes), which stays when the name is shortened. */
function splitExtension(name: string): [base: string, extension: string] {
  const dot = name.lastIndexOf(".")
  if (dot <= 0 || dot === name.length - 1) return [name, ""]
  const extension = name.slice(dot)
  return byteLength(extension) > MAX_EXTENSION_BYTES ? [name, ""] : [name.slice(0, dot), extension]
}

/** `base + suffix + extension` with the base cut, by whole characters, until it fits in 255 bytes. */
function fitted(base: string, suffix: string, extension: string): string {
  const room = MAX_NAME_BYTES - byteLength(suffix) - byteLength(extension)
  const characters = Array.from(base)
  while (characters.length > 0 && byteLength(characters.join("")) > room) characters.pop()
  return characters.join("").replace(TRAILING_DOTS_AND_SPACES, "") + suffix + extension
}

/** The name a file with none is saved under: its place among the message's files and an extension for its type. */
function fallbackName(index: number, type: string | undefined): string {
  return `file-${index}${extensionOf(type)}`
}

/**
 * The name a file is saved under, from the name its sender gave it:
 * NFC, with path separators, `:` and `<>"|?*`, control characters and the
 * bidi controls shown as `_`, trailing dots and spaces dropped (Windows
 * drops them), a leading dot hidden behind `_`, a Windows device name such
 * as `CON.txt` prefixed with `_`, and at most 255 bytes of UTF-8 with the
 * extension kept. A file with no usable name is `file-<n>` (`n` counting from
 * 1 among the message's files) with an extension for its content type, when
 * one is known. The result always passes the rules for a plain path component
 * that `inspectArchive` holds archive entries to.
 */
export function safeFileName(raw: string | undefined, index: number, type: string | undefined): string {
  if (raw === undefined) return fallbackName(index, type)
  let name = Array.from(raw.normalize("NFC"), (character) =>
    UNSAFE_CHARACTERS.test(character) || hasMisleadingCharacters(character) ? "_" : character,
  )
    .join("")
    .trim()
    .replace(TRAILING_DOTS_AND_SPACES, "")
  if (name === "") return fallbackName(index, type)
  if (name.startsWith(".") || isReservedDeviceName(name)) name = `_${name}`
  const [base, extension] = splitExtension(name)
  name = byteLength(name) > MAX_NAME_BYTES ? fitted(base, "", extension) : name
  return plainPathProblem(name, false) === undefined ? name : fallbackName(index, type)
}

/** `name` numbered for a second file of the same name: `photo (2).jpg`, still within 255 bytes. */
export function numberedName(name: string, number: number): string {
  const [base, extension] = splitExtension(name)
  return fitted(base, ` (${number})`, extension)
}

/** The name of the folder an archive is unpacked into, `<name>.unpacked`, or `<name> (2).unpacked` for the second, within 255 bytes. */
export function unpackedName(name: string, number = 1): string {
  return fitted(name, `${number === 1 ? "" : ` (${number})`}.unpacked`, "")
}

/** The names with any that repeats (also in another case, which some file systems fold) numbered `(2)`, `(3)`, … */
export function uniqueNames(names: readonly string[]): string[] {
  const taken = new Set<string>()
  return names.map((name) => {
    let candidate = name
    for (let number = 2; taken.has(foldCase(candidate)); number++) candidate = numberedName(name, number)
    taken.add(foldCase(candidate))
    return candidate
  })
}
