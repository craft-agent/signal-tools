import { mergeTranslations, type Translations } from "./core"
import { FACT_TRANSLATIONS } from "./core/facts"
import { FILE_TRANSLATIONS } from "./core/file/words"
import { MESSAGE_TRANSLATIONS } from "./core/message/words"
import { READ_TRANSLATIONS } from "./core/read-words"

/** The translations of every tool's words (titles, description words and the shared facts), per language, which the native plugins use in their approval prompts. */
export const ALL_TRANSLATIONS: Translations = mergeTranslations(
  MESSAGE_TRANSLATIONS,
  FILE_TRANSLATIONS,
  READ_TRANSLATIONS,
  FACT_TRANSLATIONS,
)
