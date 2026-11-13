import type { Mirror } from "../signal/mirror"
import { excludedCondition } from "./excluded"
import { placeholders } from "./sql"

/** How many account ids one query takes, well under SQLite's limit on parameters. */
const IDS_PER_QUERY = 500

/** How a result writes the user's own account in place of a name. */
export const OWN_NAME = "me"

/** What the mirror knows about one account: the name the user knows it by, its number, the name it last wrote messages under. */
type Person = { name: string | null; number: string | null; author: string | null }

type ContactRow = {
  uuid: string
  number: string | null
  name: string | null
  profile_name: string | null
  username: string | null
}

function inChunks<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size))
  return chunks
}

/**
 * Who the accounts in a result are. Names come from the contacts table in a
 * few queries per `load`, never one per account, and the user's own account is
 * never named here: a result writes it as `me` and never carries its number.
 * A person whose private chat is excluded is never looked up either, and no
 * name stored in an excluded chat is used for anyone: they resolve as an
 * account the mirror knows nothing about.
 */
export class People {
  readonly #mirror: Mirror
  readonly #excluded: ReadonlySet<string>
  readonly #known = new Map<string, Person>()
  readonly #ownNumber: string | null
  /** The user's own account id, or null when the mirror has not recorded it. */
  readonly me: string | null

  constructor(mirror: Mirror, me: string | null, excluded: ReadonlySet<string>) {
    this.#mirror = mirror
    this.#excluded = excluded
    this.me = me
    // The account's own number is read even when Note to Self is excluded: it is the account's own data, and only guards against writing it into a result.
    const own =
      me === null
        ? undefined
        : (mirror.prepare("SELECT number FROM contacts WHERE uuid = ?").get(me) as
            { number: string | null } | undefined)
    this.#ownNumber = own?.number ?? null
  }

  /** Reads the accounts in `ids` that are not known yet. */
  load(ids: Iterable<string>): void {
    const unknown = [...new Set(ids)].filter((id) => id !== this.me && !this.#excluded.has(id) && !this.#known.has(id))
    for (const chunk of inChunks(unknown, IDS_PER_QUERY)) this.#loadChunk(chunk)
  }

  #loadChunk(ids: string[]): void {
    const marks = placeholders(ids.length)
    const contacts = this.#mirror
      .prepare(`SELECT uuid, number, name, profile_name, username FROM contacts WHERE uuid IN (${marks})`)
      .all(...ids) as ContactRow[]
    for (const id of ids) this.#known.set(id, { name: null, number: null, author: null })
    for (const row of contacts) {
      this.#known.set(row.uuid, {
        name: row.name ?? row.profile_name ?? row.username ?? null,
        number: row.number,
        author: null,
      })
    }
    const nameless = ids.filter((id) => this.#known.get(id)?.name == null)
    if (nameless.length === 0) return
    const left = excludedCondition("chat", this.#excluded)
    const authors = this.#mirror
      .prepare(
        `SELECT author, author_name, MAX(ts) FROM messages
         WHERE author IN (${placeholders(nameless.length)}) AND author_name IS NOT NULL${left ? ` AND ${left.sql}` : ""} GROUP BY author`,
      )
      .all(...nameless, ...(left?.params ?? [])) as { author: string; author_name: string }[]
    for (const row of authors) {
      const person = this.#known.get(row.author)
      if (person) person.author = row.author_name
    }
  }

  /**
   * The name to show for an account: the contact's name, else the profile
   * name, the username, the number (`knownNumber` when the contacts have
   * none), and the name it last wrote messages under. Null when none is
   * known, and for the user's own account. Call `load` first.
   */
  displayName(id: string, knownNumber: string | null = null): string | null {
    const person = this.#known.get(id)
    if (!person) return null
    return person.name ?? person.number ?? knownNumber ?? person.author
  }

  /**
   * The name an account goes by, never its number: the contact's name, else
   * the name it last wrote messages under. Null when none is known, and for the
   * user's own account. Call `load` first.
   */
  name(id: string): string | null {
    const person = this.#known.get(id)
    return person ? (person.name ?? person.author) : null
  }

  /**
   * How a result names an account: `me` for the user's own, else its display
   * name, else the account id. An account whose chat is excluded has no display
   * name, so it shows `storedName`, the name its message was stored with, when
   * the caller has one. Call `load` first.
   */
  who(id: string, storedName: string | null = null): string {
    if (id === this.me) return OWN_NAME
    const stored = this.#excluded.has(id) ? storedName : null
    return this.displayName(id) ?? stored ?? id
  }

  /** The number the contacts hold for an account; null when none, and for the user's own account. Call `load` first. */
  number(id: string): string | null {
    return this.#known.get(id)?.number ?? null
  }

  /** Whether `number` is the user's own, which a result never carries. */
  isOwnNumber(number: string): boolean {
    return this.#ownNumber !== null && number === this.#ownNumber
  }
}
