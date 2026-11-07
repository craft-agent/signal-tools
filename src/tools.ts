import type { ToolSpec } from "./core"
import { signalAccountRead } from "./core/account/read"
import { signalChatRead } from "./core/chat/read"
import { signalContactRead } from "./core/contact/read"
import { signalFileSave } from "./core/file/save"
import { signalMessageDelete } from "./core/message/delete"
import { signalMessageEdit } from "./core/message/edit"
import { signalMessageReact } from "./core/message/react"
import { signalMessageSend } from "./core/message/send"

/** Every tool spec of the package; entry points register their tools from this list. */
export const ALL_TOOLS: ToolSpec[] = [
  signalAccountRead,
  signalChatRead,
  signalContactRead,
  signalFileSave,
  signalMessageDelete,
  signalMessageEdit,
  signalMessageReact,
  signalMessageSend,
]
