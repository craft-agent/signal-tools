import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import type { z } from "zod"
import { ToolError } from "../errors"
import { upsertContacts, upsertGroups } from "../signal/directory"
import { ingestEnvelope } from "../signal/ingest"
import { labelPaths } from "../signal/labels"
import { inTransaction, openMirrorForWrite, setMeta, type Mirror } from "../signal/mirror"
import { ACCOUNT_UUID_META } from "../signal/mirror-meta"
import {
  ALICE,
  BOB,
  GROUP_ID,
  makeTempDir,
  ME,
  NOW,
  OTHER_GROUP_ID,
  dataFrom,
  groupDataFrom,
  sentTo,
} from "../signal/mirror.testing"
import { invoke } from "../tool"
import { signalChatRead } from "./read"
import type { MessageEntry } from "./message-schema"
import type { output } from "./schema"

/** Made-up numbers of people other than the user, whose own number is `NUMBER`. */
export const ALICE_NUMBER = "+15555550177"
export const BOB_NUMBER = "+15555550188"

/** A third made-up person. */
export const CAROL = "44444444-4444-4444-8444-444444444444"

/** The chat ids of the two groups of `fillSampleChats`. */
export const GROUP = `group:${GROUP_ID}`
export const OTHER_GROUP = `group:${OTHER_GROUP_ID}`

/** Alice (5000), Note to Self (4000), Bob (3000), the group Team (2000) and a left group with no message. */
export function fillSampleChats(t: Pick<ChatFixture, "contacts" | "groups" | "ingest">): void {
  t.contacts({ uuid: ALICE, number: ALICE_NUMBER, name: "Alice" }, { uuid: BOB, number: BOB_NUMBER, name: "Bob" })
  t.groups(
    { id: GROUP_ID, name: "Team", members: [{ uuid: ALICE }], isMember: true },
    { id: OTHER_GROUP_ID, name: "Old friends", members: [], isMember: false },
  )
  t.ingest(
    dataFrom(ALICE, 5000, { message: "hello from Alice" }),
    sentTo(ME, 4000, { message: "remember" }),
    dataFrom(BOB, 3000, { message: "hello from Bob" }),
    groupDataFrom(ALICE, 2000, { message: "hello team" }),
  )
}

/** A linked label with a mirror a test fills through the ingest functions, and the tool to read it. */
export type ChatFixture = {
  stateDir: string
  mirror: Mirror
  /** Ingests each payload in a transaction of its own, received at `NOW`. */
  ingest(...payloads: unknown[]): void
  /** The same for one payload, received at `now`. */
  ingestAt(now: number, payload: unknown): void
  /** The messages of a chat as `view` returns them. */
  messages(chat: string, args?: Record<string, unknown>): Promise<MessageEntry[]>
  /** Stores contacts as signal-cli's `listContacts` gives them. */
  contacts(...contacts: Record<string, unknown>[]): void
  /** Stores groups as signal-cli's `listGroups` gives them. */
  groups(...groups: Record<string, unknown>[]): void
  /** Calls the tool. */
  read(args: unknown): Promise<z.output<typeof output>>
  /** The error a call throws. */
  failure(args: unknown): Promise<ToolError>
  /** Closes the test's own writing connection, as when the sync service has stopped. */
  closeMirror(): void
  /** Removes the state directory. */
  close(): void
}

/** A state directory with one linked label `default` and a mirror that knows the user's account id. */
export function createChatFixture(): ChatFixture {
  const stateDir = makeTempDir()
  const paths = labelPaths(stateDir, "default")
  mkdirSync(paths.dir)
  const attachmentsDir = join(paths.dir, "attachments")
  mkdirSync(attachmentsDir)
  const mirror = openMirrorForWrite(paths.mirror)
  setMeta(mirror, { [ACCOUNT_UUID_META]: ME })
  let open = true
  const ingestAt = (now: number, payload: unknown) => {
    inTransaction(mirror, () => ingestEnvelope(mirror, payload, { me: ME, attachmentsDir, now }))
  }
  const read = (args: unknown) => invoke(signalChatRead, args, { cwd: stateDir, stateDir })
  return {
    stateDir,
    mirror,
    ingest(...payloads) {
      for (const payload of payloads) ingestAt(NOW, payload)
    },
    ingestAt,
    async messages(chat, args = {}) {
      return (await read({ method: "view", chat, ...args })).messages ?? []
    },
    contacts: (...contacts) => void upsertContacts(mirror, contacts, NOW),
    groups: (...groups) => void upsertGroups(mirror, groups, NOW),
    read,
    async failure(args) {
      try {
        await read(args)
      } catch (error) {
        if (error instanceof ToolError) return error
        throw error
      }
      throw new Error("Expected the call to fail")
    },
    closeMirror() {
      if (open) mirror.close()
      open = false
    },
    close() {
      if (open) mirror.close()
      open = false
      rmSync(stateDir, { recursive: true, force: true })
    },
  }
}
