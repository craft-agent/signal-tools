# Tool conventions

The rules every tool in this package follows, so tools read alike across
domains and harnesses. Each rule carries the reason it was chosen; a change
to a rule changes this file first, with its reason.

## Names

- **Tool IDs are `<prefix>_<domain>_<verb>`**: `<prefix>_note_read` and
  `<prefix>_note_create` for a `note` domain. The prefix is `toolPrefix` in
  `src/project.ts`; it keeps a name unambiguous where a harness lists every
  tool in one namespace. When the domain has a well-known command line,
  follow its word order, so a name maps to a command anyone can look up.
- **The same ID in every entry point.** Permission rules and skills are
  written once, and an ID is a public interface: renaming one is a breaking
  change.
- **Verbs are plain**: `create`, `edit`, `delete`, `add`, `remove`, and these
  with a fixed meaning:

  | Verb      | Means                                                        |
  | --------- | ------------------------------------------------------------ |
  | `read`    | the one read tool of a domain (below)                        |
  | `resolve` | find which object a call means                               |
  | `ensure`  | create when missing, reuse when present; never a second copy |

- **One read tool per domain, one write tool per operation.**
  `<prefix>_<domain>_read` takes a `method` argument (`view`, `list`, …). A
  model picks tools worse as their number grows, and reads share one set of
  annotations, so folding them loses nothing. Writes stay apart because a
  merged write tool would carry its strictest class: creating something would
  ask like overwriting it.
- **Names stay within 40 characters**, so a client prefix such as
  `mcp__<server>__` still fits a 64-character limit. `defineTool` enforces
  the shape and the length; `src/tools.test.ts` enforces the prefix.

## Arguments

- **snake_case**, for arguments and for the keys of a result alike: one style
  for everything a model reads.
- **Lists change through flat arguments**: `add_tags`, `remove_tags`. Shallow
  schemas are read reliably by every model the harnesses run. An argument that
  replaces a whole list, where one is needed, is named for the list (`tags`)
  and its description says it replaces.
- **Unknown arguments are refused.** Every entry point validates the
  arguments as strict, so a misspelt one fails as `invalid_argument` instead
  of being ignored.
- **The tools' own install directory is never the working tree.** A harness
  may start a tool inside the directory the package is installed in.
  `ToolContext.ownDir` names it; a tool that reads the working tree refuses
  to treat that directory as the caller's, saying so.

## Results

- **A tool returns its data as a plain object**, with no `ok` envelope. Each
  entry point renders it: the MCP server as `structuredContent` with the
  tool's `outputSchema` plus the same JSON as text, a native plugin as a JSON
  string.
- **A failure throws.** Every harness then sees a failed call (`isError` over
  MCP) rather than a success that carries an error.
- **One exception: what a call created is never lost.** Once a tool has
  created something, a later step of the same call that fails does not throw.
  The result names what was created and lists the failed steps under
  `errors`, keyed by step (`StepErrors`).
- **Text a tool reads is returned as it is.** Content from files or services
  is data, never instructions; every read tool's description and the skills
  say so. Nothing is wrapped or rewritten.
- **Times are local, with their offset, to the millisecond**:
  `2026-11-07T14:03:12.345+09:00`. A model judges "yesterday" or "this
  morning" by the user's clock, and the offset keeps the instant exact. A time
  argument takes RFC 3339 with an offset, or a date or a time without one
  (`2026-11-07`, `2026-11-07T14:03`), read as local time; a local time a
  clock change skips or repeats is read as JavaScript's `Date` reads it.
- **A list comes in pages.** It takes `limit`, with a default and a largest
  value per method (above the largest is clamped, below 1 refused), and
  `cursor` to continue; a page with more returns `next`, an opaque string to
  pass back as `cursor`. A cursor holds where the page ended, not a count, so
  what arrives between two pages does not shift the next one.
- **A result stays under 50,000 characters of JSON** by returning fewer
  items and a `next`, since some harnesses refuse a result over 60,000. Text
  is never cut to fit, because a cut message reads as what was said: only a
  single item that alone exceeds the budget is cut, and it says so
  (`text_cut: true`).

## Errors

A thrown error carries a `code` a caller can branch on, and a message that
says what to do next.

| Code               | When                                                                       |
| ------------------ | -------------------------------------------------------------------------- |
| `not_found`        | the object does not exist, or the caller cannot see it                     |
| `forbidden`        | the caller lacks the permission the call needs                             |
| `invalid_argument` | the arguments cannot describe a valid call                                 |
| `stale`            | what the call relied on changed before it could finish                     |
| `unauthenticated`  | the service or program the tool calls is not logged in                     |
| `rate_limited`     | the service refused the call for its rate limit                            |
| `declined`         | the person declined a confirmation the tool asked for                      |
| `upstream_error`   | the service or program the tool calls failed; the message carries its text |
| `uncertain`        | a write may have taken effect; check before trying it again                |
| `internal_error`   | a bug in a tool or an entry point, such as a result off its schema         |

A project adds a code to `src/core/errors.ts` and to this table together.

## Write classes

Every tool belongs to one class, and the class sets its MCP annotations.
`openWorldHint` is `true` for every tool.

| Class             | Examples                              | `readOnlyHint` | `destructiveHint` | `idempotentHint` |
| ----------------- | ------------------------------------- | -------------- | ----------------- | ---------------- |
| read              | view, list, resolve                   | `true`         | —                 | `true`           |
| add               | create, add                           | `false`        | `false`           | `false`          |
| idempotent change | ensure, adding a tag                  | `false`        | `false`           | `true`           |
| overwrite         | editing a body or title, removing one | `false`        | `true`            | `true`           |
| administrative    | delete, visibility, publishing        | `false`        | `true`            | `false`          |

- **Overwriting counts as destructive**: it loses what was there, and
  harnesses that confirm only destructive tools should still ask before it.
- **A tool takes the strictest class its arguments can reach.**
- **The harness confirms writes.** Every MCP client asks before it runs a
  write tool, so the tool does not ask again by default. Administrative tools
  also carry `_meta["anthropic/requiresUserInteraction"]: true`, which makes
  Claude Code ask even under an allow rule.
- **A native plugin asks the harness's own permission before every non-read
  call**, since the tools a native plugin adds pass through no harness
  approval of their own.
- **It asks for everything the call writes to.** A write tool's `targets`
  resolver names what the call writes to, as the permission rules name it
  (a path, an account, a record). Anything it cannot tell, every tool
  without a resolver, and a target holding `*` or `?` (which a harness would
  store as a pattern) is `*`, and `*` is never stored. An "always" answer then
  covers only what it named, never a write somewhere else.
- **`confirm: "elicitation"` adds the tool's own form** for administrative
  tools, where the client offers form-mode elicitation. It is for people who
  switch the client's approvals off: the tool states what will happen in plain
  words and stops on anything but an accept. Where the client does not offer
  elicitation the setting adds nothing, and the harness's approval is then the
  only confirmation.
- **Annotations are hints, not a boundary.** The `read_only` setting
  (below) is what keeps writes out.

## Toolsets and settings

Every entry point takes the same settings:

- **Toolsets**: one per domain, listed in `src/project.ts` with the ones on by
  default. A small default keeps the model's choice sharp.
- **`read_only`** registers no write tool, and wins over every other setting.
- **`tools` / `exclude_tools`** add or remove single tools; an exclusion wins
  over an inclusion.
- **`confirm`** is `harness` (the default) or `elicitation`; it says who asks
  before an administrative tool acts (see "Write classes"). The default leaves
  the question to the harness, whose approval every user already knows.
- **`state_dir`**: where every account's state lives (see "Accounts and state").

## The core contract

- A tool spec declares its ID, description, argument schema, output schema,
  toolset and write class; every entry point derives the same metadata from
  it. A write tool also declares `targets(args, context)`, which names what
  the call writes to.
- `execute(args, context)` gets the working directory, an abort signal, an
  optional `ownDir` (the directory the tools are installed in, never the
  working tree) and an optional `confirm(request) => Promise<boolean>` hook.
  Nothing in it names a harness. An entry point supplies `confirm` when the
  `elicitation` setting is on; without it the harness's approval stands, and a
  tool that needs a confirmation treats a missing hook as the harness having
  approved the call.
- `src/core/` uses only the `node:*` modules and plain dependencies, never a
  runtime's own globals (`Bun.spawn`, `Bun.file`, …), so the same code runs on
  Node and on Bun. It knows no project either: names, prefixes and toolsets
  come from `src/project.ts` through the entry points.

## Programs a tool runs

- **Every program a tool runs goes through one runner** built on `exec`, with
  an explicit environment: what the program needs to find itself and
  authenticate is passed through, and nothing else, so a stray variable
  cannot redirect a call. Prompts and colors are switched off, so nothing
  waits on a person and output parses the same everywhere.
- **Every call has a time limit**, and a call that is stopped, by that limit
  or by cancellation, has its child process killed: `SIGTERM`, then `SIGKILL`
  after two seconds. A hung program neither holds a harness forever nor
  outlives its call.
- **The runner maps the program's failures to the error codes above.**

## Tests

- Tests sit beside the code they test (`*.test.ts`) and run on `bun test`;
  CI also starts the built MCP server, plugin and command line under Node and
  lists their tools, so a runtime-only API cannot slip in unnoticed.
- No test reaches a real service. A tool that runs a program is tested
  against a fake of that program on `PATH`.
- A test file stays within about 300 lines, split by topic
  (`<name>.<topic>.test.ts`), so one commit can carry a change and its test.

## Accounts and state

- **One label is one linked device.** The tools join a Signal account the
  way Signal Desktop does, as a linked device of the user's phone, through
  [signal-cli](https://github.com/AsamK/signal-cli); they never read another
  client's data. Linking is a person's step (a QR code scanned on the phone),
  and it names the label the device is known by.
- **A label is 1 to 24 lowercase letters, digits and `_`**, starting and
  ending with a letter or a digit; linking names it `default` when no label
  is given. A label is also a directory name, so the set is kept to what every
  file system takes as it is.
- **Each label keeps all of its state in one directory**,
  `<state root>/<label>/`, created with mode 700: signal-cli's data and keys,
  the daemon's socket, the mirror, and the short-lived copies of files being
  sent. The state root is the `state_dir` setting, by default
  `$XDG_STATE_HOME/signal-tools`, or `~/.local/state/signal-tools` without
  it. One directory per label means a label is moved, backed up or removed as
  a whole, and nothing of one account sits in another's.
- **`account` picks the label.** Left out, it picks the only linked label;
  with several, the call fails as `invalid_argument` and lists them. One
  account is the common case and needs no argument, while several never
  depend on which one a tool guesses.
- **A label reaches only its own account.** A chat id is looked up only in
  that label's mirror, and a call to Signal goes only through that label's
  daemon, so no argument can carry a call to an account the label does not
  name.
- **The keys never leave the state directory.** Nothing from signal-cli's
  data reaches a result, an error or a log, and no tool reads or writes the
  state directory except through the mirror, the daemon client and the
  outbox. The keys stand for the account itself: whoever holds them reads and
  sends as the user, on every device.

## The daemon client

- **Every call to signal-cli goes through one client**, as every program goes
  through one runner: JSON-RPC 2.0 on the label's UNIX socket, a time limit
  with cancellation, signal-cli's error codes mapped to the codes above, and
  nothing but the label's own socket reached. A tool never opens the socket
  itself.
- **A call's success is not a send's success.** signal-cli answers a send
  that failed for some recipients as a successful call, with a result per
  recipient (an untrusted safety number, a rate limit); the client reads every
  one, so a failure is never reported as a delivery.

## The sync service

- **The sync service alone receives.** One service per label runs that
  label's daemon as its child with `--receive-mode manual`, subscribes, and
  writes every message to the mirror. With manual receiving nothing is
  fetched before the service subscribes, so while it is down messages wait on
  Signal's server instead of being taken by whichever call comes first.
- **The service and its daemon always stop together.** signal-cli confirms a
  message to Signal's server before it hands it on, and does not hand it on
  again; a daemon that outlived its service would take messages the mirror
  never sees. A mirror that cannot be written stops receiving at once, for
  the same reason.
- **An unlinked device stops the service.** With no linked device, or once
  Signal has unlinked it (removed on the phone, or unused for 45 days), the
  service exits and stays down until the device is linked again, rather than
  restarting against an account it can no longer reach.
- **The service sends no read receipts or typing indicators of its own**, so
  the phone keeps its notifications and nobody learns that a message was read
  by a tool.

## The mirror

- **History starts at the link.** signal-cli receives no history when a
  device is linked, so nothing older can be read, and the skills say so.
- **A message is its author and its sent time** in milliseconds, the pair
  Signal itself uses to quote, react to, edit and delete a message; the id a
  tool takes or returns carries both, since two members of a group can send
  in the same millisecond. A chat is a person's account id (a UUID) or `group:<id>`. Names
  and numbers are never accepted as a chat: anyone can choose any name, and a
  number tells nothing of the account behind it until Signal is asked, which
  is the number check's job.
- **The mirror keeps what Signal shows the user.** Messages they receive, and
  messages they send from other devices (Note to Self included); a send
  through the tools is recorded once Signal accepts it, since signal-cli does
  not report its own sends back. An edit keeps every earlier version. Delete
  for everyone removes the message, its files, its earlier versions, its
  reactions and every quote of it, as its sender meant. A mention reads as
  `@name`.
- **Disappearing and view-once messages are kept and marked.** A read says
  when one disappears, or that it has: its sender meant it not to be kept, so
  a tool returns it for the user only. The marks and the note that such a
  message is not to be quoted or passed on unless the user asks are fields of
  their own; the text stays as it was sent.
- **Every read opens the mirror read-only and needs no daemon**, so reading
  works while the service is down and can never change what was received.
  Read-only means every write refused (`query_only`), never migrating, and
  never creating the mirror; the connection itself is SQLite's ordinary one,
  since a read-only connection cannot open a WAL database once its `-shm`
  file is gone, and a WAL reader takes part in the shared-memory locking
  that lets it read while the service writes.
- **Other people's words are data.** Message text, names, captions and file
  names are written by other people; every read tool's description and the
  skills say so, and nothing a message says is followed as an instruction.

## Files

- **Files go in and out only through the directories a setting names**,
  judged by real path, so a link that leads elsewhere counts as elsewhere.
  The state directory and the tools' own install directory are never among
  them. Which settings, and their defaults, are settled with the tools that
  save and send files.

## Writes

- **A write's arguments are the whole change**: the chat by id, the text as
  it should arrive (surrounding blank space trimmed), the files by path.
  Nothing is chosen at run time from the current state. The harness shows the
  arguments when it asks, so what it shows is what goes out.
- **A send's outcome is never guessed.** A result means Signal accepted the
  message: for a group, per member, with the members it did not reach listed,
  since what reached some members cannot be taken back by throwing. A failure
  known to happen before anything reached anyone (the daemon not running,
  arguments Signal refuses, a recipient not on Signal, a changed safety
  number, a rate limit) throws its code. Every other failure throws
  `uncertain`: the message may have gone out, the mirror cannot tell, and it
  is checked on the phone before any second send. A resend that guessed wrong
  reaches the other person twice.

## Toolsets

- **One per domain**: `account`, `chats`, `contacts`, `files`, `sends`, and
  `actions` for what the user does to messages beyond sending them.
- **`account`, `chats`, `contacts` and `sends` are on by default.** They cover
  reading a chat and answering it. Saving received files writes to disk and
  opens archives, and the actions change messages other people have already
  read, so each is one setting away.
