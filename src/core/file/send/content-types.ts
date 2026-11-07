import { extensionOf } from "../../archive/kind"

/** The type recorded for a file whose extension says nothing: bytes. */
export const UNKNOWN_CONTENT_TYPE = "application/octet-stream"

/**
 * Content types by extension (lower case, without the dot) for the files people
 * send most. They fill the mirror's record of a send only, which keeps a type
 * as it keeps the type of a file sent from another device; they are not sent.
 * signal-cli's `send` takes each attachment as a file path or as a data URI,
 * and only a data URI carries a type (and a file name): for a path signal-cli
 * chooses the type it sends from the file itself. Files go as paths, so the
 * type Signal shows can differ from the one recorded here; a file whose
 * extension is not in the map is recorded as bytes.
 */
const CONTENT_TYPES: ReadonlyMap<string, string> = new Map(
  Object.entries({
    txt: "text/plain",
    log: "text/plain",
    md: "text/markdown",
    csv: "text/csv",
    html: "text/html",
    json: "application/json",
    xml: "application/xml",
    pdf: "application/pdf",
    rtf: "application/rtf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    heic: "image/heic",
    svg: "image/svg+xml",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    wav: "audio/wav",
    ogg: "audio/ogg",
    mp4: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm",
    zip: "application/zip",
    tar: "application/x-tar",
    gz: "application/gzip",
    tgz: "application/gzip",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  }),
)

/** The content type a file named `name` is declared as, from its extension. */
export function contentTypeOf(name: string): string {
  return CONTENT_TYPES.get(extensionOf(name)) ?? UNKNOWN_CONTENT_TYPE
}
