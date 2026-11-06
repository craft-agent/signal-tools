import type { ToolSpec } from "./core"
import { signalAccountRead } from "./core/account/read"

/** Every tool spec of the package; entry points register their tools from this list. */
export const ALL_TOOLS: ToolSpec[] = [signalAccountRead]
