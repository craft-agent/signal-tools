import type { Translations } from "../words"

/** The English words the message tools and their descriptions write; each is a key of `MESSAGE_TRANSLATIONS`. */
export const MESSAGE_WORDS = {
  chat: "Chat",
  person: "Person",
  group: "Group",
  members: "Members",
  member: "{count} member",
  membersCount: "{count} members",
  files: "Files",
  file: "{count} file",
  filesCount: "{count} files",
  noText: "(no text)",
  from: "From",
  you: "you",
  sendIntent: "About to send a message",
  sendHeadline: "About to send a message to {chat}",
  sendHeadlineNote: "About to send a message to Note to Self",
  replyTo: "Reply to",
  sendText: "Message text",
} as const

/** The translations of `MESSAGE_WORDS` and of the four message tools' titles. */
export const MESSAGE_TRANSLATIONS: Translations = {
  ja: {
    [MESSAGE_WORDS.chat]: "チャット",
    [MESSAGE_WORDS.person]: "個人",
    [MESSAGE_WORDS.group]: "グループ",
    [MESSAGE_WORDS.members]: "メンバー",
    [MESSAGE_WORDS.member]: "{count} 人",
    [MESSAGE_WORDS.membersCount]: "{count} 人",
    [MESSAGE_WORDS.files]: "ファイル",
    [MESSAGE_WORDS.file]: "{count} 個",
    [MESSAGE_WORDS.filesCount]: "{count} 個",
    [MESSAGE_WORDS.noText]: "（本文なし）",
    [MESSAGE_WORDS.from]: "送信者",
    [MESSAGE_WORDS.you]: "あなた",
    [MESSAGE_WORDS.sendIntent]: "メッセージを送信しようとしています",
    [MESSAGE_WORDS.sendHeadline]: "{chat} にメッセージを送信しようとしています",
    [MESSAGE_WORDS.sendHeadlineNote]: "自分用メモにメッセージを送信しようとしています",
    [MESSAGE_WORDS.replyTo]: "返信先",
    [MESSAGE_WORDS.sendText]: "メッセージの本文",
    "Send a message": "メッセージを送信する",
    "Edit a message": "メッセージを編集する",
    "React to a message": "メッセージにリアクションする",
    "Delete a message for everyone": "全員に対してメッセージを削除する",
  },
}
