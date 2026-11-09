import type { Translations } from "../words"

/** The English words the file tools' descriptions write; each is a key of `FILE_TRANSLATIONS`. */
export const FILE_WORDS = {
  sendIntent: "About to send files",
  sendOneHeadline: "About to send {file} to {chat}",
  sendOneHeadlineNote: "About to send {file} to Note to Self",
  sendHeadline: "About to send files to {chat}",
  sendHeadlineNote: "About to send files to Note to Self",
  caption: "Caption",
  saveIntent: "About to save a message's files",
  saveHeadline: "About to save files from {chat}",
  saveHeadlineNote: "About to save files from Note to Self",
  unpack: "Unpack",
  unpackValue: "Archives, after inspection",
} as const

/** The translations of `FILE_WORDS` and of the file tools' titles. */
export const FILE_TRANSLATIONS: Translations = {
  ja: {
    [FILE_WORDS.sendIntent]: "ファイルを送信しようとしています",
    [FILE_WORDS.sendOneHeadline]: "{chat} に {file} を送信しようとしています",
    [FILE_WORDS.sendOneHeadlineNote]: "自分用メモに {file} を送信しようとしています",
    [FILE_WORDS.sendHeadline]: "{chat} にファイルを送信しようとしています",
    [FILE_WORDS.sendHeadlineNote]: "自分用メモにファイルを送信しようとしています",
    [FILE_WORDS.caption]: "キャプション",
    [FILE_WORDS.saveIntent]: "メッセージのファイルを保存しようとしています",
    [FILE_WORDS.saveHeadline]: "{chat} のメッセージのファイルを保存しようとしています",
    [FILE_WORDS.saveHeadlineNote]: "自分用メモのメッセージのファイルを保存しようとしています",
    [FILE_WORDS.unpack]: "展開",
    [FILE_WORDS.unpackValue]: "検査を通ったアーカイブ",
    "Send files": "ファイルを送信する",
    "Save a message's files": "メッセージのファイルを保存する",
  },
}
