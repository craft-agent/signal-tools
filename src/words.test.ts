import { describe, expect, test } from "bun:test"
import { templatePlaceholders } from "./core/describe"
import { FACT_TRANSLATIONS } from "./core/facts"
import { FILE_WORDS } from "./core/file/words"
import { MESSAGE_WORDS } from "./core/message/words"
import { translator } from "./core/words"
import { ALL_TOOLS } from "./tools"
import { ALL_TRANSLATIONS } from "./words"

const ja = ALL_TRANSLATIONS.ja!
const toJapanese = translator(ALL_TRANSLATIONS, "ja")

/** Every English word the package writes: the tools' titles and intents, the description words and the shared facts' words. */
function packageWords(): string[] {
  const toolWords = ALL_TOOLS.flatMap((tool) => (tool.intent === undefined ? [tool.title] : [tool.title, tool.intent]))
  return [
    ...toolWords,
    ...Object.values(MESSAGE_WORDS),
    ...Object.values(FILE_WORDS),
    ...Object.keys(FACT_TRANSLATIONS.ja!),
  ]
}

describe("ALL_TRANSLATIONS", () => {
  test("has a Japanese word for exactly the words the package writes", () => {
    expect(Object.keys(ja).sort()).toEqual([...new Set(packageWords())].sort())
  })

  test("translates every template with its placeholders kept and every other word to something else", () => {
    for (const key of Object.keys(ja)) {
      if (templatePlaceholders(key)?.size) expect(toJapanese.template(key, 200)).toBe(ja[key]!)
      else expect(toJapanese.word(key)).not.toBe(key)
    }
  })
})
