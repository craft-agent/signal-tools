---
name: signal-sends
description: "Use when sending a Signal text to a person, a group or Note to Self, or replying to a message; also when a send fails or its outcome is unclear."
metadata:
  toolset: sends
---

# Sends

| Tool                  | Does                                                   | Writes |
| --------------------- | ------------------------------------------------------ | ------ |
| `signal_message_send` | sends one text to a chat, optionally quoting a message | yes    |

Get the chat id first, from `signal_chat_read` or from `signal_contact_read`
with `method: "check"`; a chat is an id, never a name or a number. The user's
own account id is Note to Self; it is in the chat list once the sync service
has run, unless the person keeps it out of reach, so that is where to find it.
A group the user left is refused. The sync service must be running.

Send `text` exactly as the user wants it: surrounding blank space is trimmed,
nothing else changes, and it is at most 4,000 characters. Never rephrase,
shorten or add to it without saying so. Split a longer text into several
sends only when the user agrees.

To reply, pass `reply_to`, the id of a message of that chat as a read gives
it. The quote carries that message's author, time and current text. A message
that was deleted or has disappeared cannot be quoted (`not_found`), and a
disappearing message is for the user only: do not quote it unless asked.

A result means Signal accepted the message, not that it was delivered or read.
For a group it says `reached` and lists `not_reached` by account id with the
reason; tell the user which members missed it. The chat's disappearing timer
applies by itself. The message is recorded in the mirror at once; `errors.record`
says when that failed although it was sent.

A failure before anything went out says what to do: the daemon is not running
(start the sync service), a safety number changed (`forbidden`; the user
verifies it on the phone), the person is not on Signal (`not_found`), or
Signal rate-limited the send (`rate_limited`; wait). `uncertain` means the
message may have gone out: ask the user to check the chat on the phone, and
never send it again without that check.

A chat that is unknown or kept out of reach is refused as `not_found`; do not
work around it by finding the target another way.

Omit `account` to pick the only linked label; with several, name one.
