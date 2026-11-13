import type { ToolContext, ToolSpec } from "./core"
import { approvalPrompt, standIn } from "./entry/description"
import { approvalOf } from "./entry/pin"
import { promptTranslator, promptWords } from "./entry/words"
import { ALL_TRANSLATIONS } from "./words"

/** The languages the prompts are checked in: English, and Japanese by its tag. */
export const LANGUAGES = [undefined, "ja"] as const

/**
 * The approval prompt of a call as the OpenCode plugin draws it, in `language`
 * (English without one); `timeoutMs` is how long the description may take.
 */
export async function promptOf(
  spec: ToolSpec,
  args: Record<string, unknown>,
  ctx: ToolContext,
  language?: string,
  timeoutMs?: number,
): Promise<string> {
  const t = promptTranslator(ALL_TRANSLATIONS, language)
  const approval = await approvalOf(spec, args, ctx, timeoutMs, t)
  if (approval.refused) throw approval.refused
  return approvalPrompt(standIn(spec, t), approval.resources, approval.description, promptWords(t))
}

/** `text` with each directory in `names` (a temporary one) replaced by its placeholder, so the text is the same on every run. */
export function withPlaceholders(text: string, names: Record<string, string>): string {
  return Object.entries(names).reduce((out, [placeholder, dir]) => out.replaceAll(dir, placeholder), text)
}
