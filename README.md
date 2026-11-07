# signal-tools

Signal tools for coding agents: chats, messages, contacts, received files and sends.

| Harness        | Delivery                                       | Pinned by                      |
| -------------- | ---------------------------------------------- | ------------------------------ |
| OpenCode V2    | native plugin (npm package, with skills)       | the version in the package     |
| OpenCode V1    | native plugin (npm package, no skills)         | the version in the package     |
| Claude Code    | plugin: MCP server and skills                  | the release tag, as the ref    |
| Codex          | plugin: MCP server and skills                  | the release tag, as the ref    |
| Grok Build     | plugin: MCP server and skills                  | the release tag, as `@ref`     |
| Antigravity    | plugin: MCP server and skills                  | the release tag's tree URL     |
| Hermes Agent   | native plugin (Python, calls the command line) | the release commit, as the SHA |
| other MCP host | MCP server from npm                            | the version in the package     |

The tools need [Node.js](https://nodejs.org/) 24 or later.
[`docs/conventions.md`](docs/conventions.md) describes how the tools are named
and how they behave.

## Install

Install from a release, never from the default branch: a release is a tag whose
commit carries the built `dist/`, and the default branch does not. In the
commands below, `<version>` is a release's version (`1.2.3`) and `<sha>` is the
commit its tag names:

```sh
gh api repos/craft-agent/signal-tools/commits/v<version> --jq .sha
```

### OpenCode

OpenCode V2 takes the package and its options in `opencode.json`:

```json
{
  "plugins": [{ "package": "@craftsamo/signal-tools@<version>", "options": { "read_only": false } }],
  "permissions": [{ "action": "signal_*", "resource": "*", "effect": "ask" }]
}
```

OpenCode V1 takes the package as a string, or as a pair with its options:

```json
{
  "plugin": [["@craftsamo/signal-tools@<version>", { "read_only": false }]],
  "permission": { "signal_*": "ask" }
}
```

OpenCode allows any action no rule names, so the plugin's request is granted
silently unless a rule says `ask`. Read tools never ask, so the `signal_*` glob
is safe.

V1 registers no skills. Unpack the package and copy its `skills/*` folders into
`~/.config/opencode/skills/`:

```sh
npm pack @craftsamo/signal-tools@<version>
tar -xzf craftsamo-signal-tools-<version>.tgz
mkdir -p ~/.config/opencode/skills
cp -r package/skills/* ~/.config/opencode/skills/
rm -rf package craftsamo-signal-tools-<version>.tgz
```

### Claude Code

```sh
claude plugin marketplace add craft-agent/signal-tools#v<version>
claude plugin install signal-tools@craft-agent
```

### Codex

```sh
codex plugin marketplace add craft-agent/signal-tools --ref v<version>
codex plugin add signal-tools@craft-agent
```

Codex turns `-` into `_` in server names, so it shows the tools as
`mcp__signal_tools__signal_*`. It starts the MCP server in the plugin's
install directory, which is never the caller's working tree.

### Grok Build

```sh
grok plugin install craft-agent/signal-tools@v<version> --trust
```

Grok starts the MCP server in the session's working directory.

### Antigravity

Install from the tree of the release tag, never from the default branch, which
has no built `dist/`; Antigravity clones the tag into
`~/.gemini/config/plugins/signal-tools`.

```sh
agy plugin install https://github.com/craft-agent/signal-tools/tree/v<version>
```

### Hermes Agent

Hermes installs a commit, not a tag, and the plugin installs disabled:

```sh
hermes plugins install craft-agent/signal-tools --ref <sha>
hermes plugins enable signal-tools
```

If a Hermes gateway is already running, restart it (`hermes gateway restart`) to
load the plugin.

### Any other MCP host

Add the server to the host's MCP configuration. Flags go in `args`:

```json
{
  "mcpServers": {
    "signal-tools": {
      "command": "npx",
      "args": ["-y", "@craftsamo/signal-tools@<version>", "--read-only"]
    }
  }
}
```

## Tools and skills

Each toolset comes with a skill that tells an agent how to use its tools.

### Account (`account`)

| Tool                  | What it does                                                                        | Class |
| --------------------- | ----------------------------------------------------------------------------------- | ----- |
| `signal_account_read` | each label: linked or not, the sync service's state, the last receive and next step | read  |

It reads local state only: no daemon, no network, and no number, account id
or key in its result. The skill is
[`signal-account`](skills/signal-account/SKILL.md), shown as
`signal-tools:signal-account` in Claude Code and `signal-tools:account` in
Hermes.

### Chats (`chats`)

| Tool               | What it does                                                                                                                                       | Class |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `signal_chat_read` | by `method`: `list` finds chats, `view` reads one chat's messages, `search` finds messages by words, `around` reads the messages next to a message | read  |

It reads the account's local mirror only: no daemon, no network, and no number
of the account's own, attachment id or key in its result. History starts when
the device was linked. Times are local with their offset, a chat is always its
id, a long result is paged with `next`, and everything it returns is data
written by other people. The skill is
[`signal-chats`](skills/signal-chats/SKILL.md), shown as
`signal-tools:signal-chats` in Claude Code and `signal-tools:chats` in Hermes.

### Contacts (`contacts`)

| Tool                  | What it does                                                   | Class |
| --------------------- | -------------------------------------------------------------- | ----- |
| `signal_contact_read` | lists local contacts or checks up to three numbers with Signal | read  |

Listing needs no daemon; checking numbers needs the running sync service.
Neither writes the mirror. The skill is
[`signal-contacts`](skills/signal-contacts/SKILL.md), shown as
`signal-tools:signal-contacts` in Claude Code and `signal-tools:contacts` in
Hermes.

> > > > > > > eb4147b (docs: add the contacts skill and list the contact tool)

## Adding a tool

1. Write the spec in `src/core/<domain>/<verb>.ts` with `defineTool`: an ID
   `<prefix>_<domain>_<verb>`, a title and description, the Zod argument and
   output schemas, its toolset and write class, and `execute(args, context)`.
   A write tool also gives `targets(args, context)`: what the call writes to,
   as a permission rule should name it.
2. Test it beside the spec (`<verb>.test.ts`), calling it through `invoke` as
   the entry points do. A tool that runs a program is tested against a fake of
   that program on `PATH`; no test reaches a real service.
3. List it in `src/tools.ts`. A new toolset goes into `toolsets` in
   `src/project.ts` (and `defaultToolsets` when it is on by default).
4. Add or update the toolset's skill, `skills/<prefix>-<toolset>/SKILL.md`.
5. Run `pnpm run build && pnpm run manifests` to list the tool in
   `plugin.yaml`, then describe it under "Tools and skills".

[`docs/conventions.md`](docs/conventions.md) has the rules each step follows.

## Reads and writes

Every read tool is named `<prefix>_<domain>_read`. Reads can run unasked;
writes are confirmed by the harness.

| Harness     | Reads without asking                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| OpenCode    | always; the plugin asks only before a write                                                                  |
| Claude Code | the rule `mcp__plugin_signal-tools_signal-tools__*_read` in `permissions.allow` of `~/.claude/settings.json` |
| Codex       | always; Codex runs tools that declare `readOnlyHint` unasked, as the read tools do                           |
| Grok Build  | `grok --allow 'MCPTool(signal-tools__*_read)' --allow 'MCPTool(signal_*_read)'` (both rules; see below)      |
| Antigravity | the rule `mcp(signal-tools_signal-tools/<tool id>)` in `permissions.allow`, one for each read tool           |
| Hermes      | always; the plugin asks only before a write                                                                  |

Where a write is asked about, and where it is not:

- **OpenCode** grants any action no rule names, so a write runs unasked unless
  a rule asks for it: add the `signal_*` rule shown under [OpenCode](#opencode).
- **Codex** under `codex exec`, and **Grok Build** under `grok -p`, refuse a
  write they cannot ask about, unless it is allowed beforehand.
- **Grok Build** calls the plugin's tools through its `use_tool` tool, and the
  agent often names a tool without its server first. Grok checks the rules
  against the name as given, so the server-qualified rule alone does not match
  that first call. The second rule matches the short name; a write still
  matches neither.
- **Antigravity** asks before any MCP tool no rule allows, reads included, and
  names the plugin's server `signal-tools_signal-tools` (plugin,
  then server). `agy -p` refuses a tool it cannot ask about.
- **Hermes** `hermes chat -q` refuses a write it cannot ask about; `hermes -z`
  and `--yolo` skip approval, so writes then run unasked.

## Settings

Every entry point takes the same settings. A flag wins over its environment
variable, and an option or setting wins over the variable too.

| Setting         | Flag              | Variable                     | Meaning                                                                       |
| --------------- | ----------------- | ---------------------------- | ----------------------------------------------------------------------------- |
| `toolsets`      | `--toolsets`      | `SIGNAL_TOOLS_TOOLSETS`      | the toolsets that are on, or `all`; default those `src/project.ts` names      |
| `read_only`     | `--read-only`     | `SIGNAL_TOOLS_READ_ONLY`     | registers no tool that writes; wins over every other setting                  |
| `tools`         | `--tools`         | `SIGNAL_TOOLS_TOOLS`         | single tools to add by ID, whatever their toolset                             |
| `exclude_tools` | `--exclude-tools` | `SIGNAL_TOOLS_EXCLUDE_TOOLS` | single tools to remove by ID; wins over `tools` and `toolsets`                |
| `confirm`       | `--confirm`       | `SIGNAL_TOOLS_CONFIRM`       | MCP server only: `harness` (default) or `elicitation`, as the conventions say |
| `state_dir`     | `--state-dir`     | `SIGNAL_TOOLS_STATE_DIR`     | where every label's state lives; default `$XDG_STATE_HOME/signal-tools`       |

Lists are comma-separated in a flag or a variable. Where each harness reads them:

- **OpenCode** takes the plugin `options` shown above, with lists as arrays,
  `read_only` as a boolean and `state_dir` as a path, and falls back to the
  variables. V2 runs plugins in its background service, which keeps the
  environment it started with: a variable set where `opencode run` starts has
  no effect until the service is restarted in that environment
  (`opencode service restart`). V1 runs plugins in its own process.
- **Hermes** takes `plugins.entries.signal-tools.settings` in
  `config.yaml`:

  ```yaml
  plugins:
    entries:
      signal-tools:
        settings:
          read_only: false
          exclude_tools: []
  ```

  The plugin passes its own environment to the command line it runs, so the
  variables work too. A running gateway keeps the environment it started with;
  restart it (`hermes gateway restart`) after changing one.

- **Claude Code, Grok Build and Antigravity** start the plugin's server without
  flags and pass it the client's environment, so set the variables in the
  environment the harness runs in.
- **Codex** passes a plugin's MCP server only a few basic variables (such as
  `PATH` and `HOME`), so the variables have no effect there. To change
  settings, or to give the server a variable it needs, add the server under
  `[mcp_servers]` in Codex's `config.toml` instead of using the plugin: flags
  go in `args`, `env_vars` names the variables to forward from Codex's
  environment, and `env` sets fixed values.

  ```toml
  [mcp_servers.signal-tools]
  command = "npx"
  args = ["-y", "@craftsamo/signal-tools@<version>", "--read-only"]
  env_vars = ["SIGNAL_TOOLS_STATE_DIR"]
  ```

### Accounts and the sync service

The tools use a Signal account as a linked device of the user's phone, the
way Signal Desktop does, through [signal-cli](https://github.com/AsamK/signal-cli),
which you install yourself. They never read another client's data.

- **Each linked device has a label**, 1 to 24 lowercase letters, digits and
  `_` (`default` when linking names none). A tool's `account` argument picks
  the label; leave it out when only one device is linked.
- **Each label keeps its state in one directory**, `<state_dir>/<label>/`
  (mode 700): signal-cli's data and keys, the daemon's socket, the mirror of
  received messages, and the copies of files being sent. `state_dir` defaults
  to `$XDG_STATE_HOME/signal-tools`, or `~/.local/state/signal-tools`. Keep it
  out of backups you share: the keys read and send as you.
- **A sync service receives for each label** and keeps its mirror, and the
  read tools read only the mirror. History starts when the device is linked;
  messages that arrive while the service is down wait on Signal's server, for
  as long as Signal keeps undelivered messages.
- **Signal unlinks a device unused for 45 days**, and every linked device
  when the phone has been offline for 30; a running service keeps the device
  in use. An unlinked label is linked again from the phone.
- **signal-cli releases age out.** A release more than about three months old
  may stop working with Signal's servers, so keep it updated.

### Linking a device and running the sync service

The tools are tested against signal-cli 0.14. Install it first: on macOS
`brew install signal-cli`; elsewhere a
[release](https://github.com/AsamK/signal-cli/releases) (the JVM build needs
Java 25 or later). macOS and Linux are supported; Windows is
[#11](https://github.com/craft-agent/signal-tools/issues/11).

```sh
# Link: on the phone, Signal > Settings > Linked devices > Link new device,
# then scan the code this prints.
signal-tools-cli link --account work

# Start receiving at logon, and restart after a failure.
signal-tools-cli service install --account work
signal-tools-cli service status --account work
```

`--account` may be left out when only one label exists (`link` names a new
one `default`), and every command takes `--state-dir` like the tools.

| Command                                        | What it does                                                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `link [--account <label>] [--device-name <n>]` | links this machine as a device of the phone, showing the code to scan; `--show-uri` also prints the address the code stands for |
| `sync [--account <label>]`                     | runs the sync service in the foreground, logging to standard error, until it is stopped                                         |
| `service install \| uninstall \| status`       | registers the sync service as a launchd agent (macOS) or a systemd user unit (Linux), removes it, or reports it                 |
| `remove --account <label> [--yes]`             | uninstalls the service and deletes the label's keys, signal-cli's data and history, after the label is typed back               |

- **The service records this package's paths**, so run `service install`
  again after updating the package. On macOS its log is
  `~/Library/Logs/io.github.craft-agent.signal-tools/<label>.log`; on Linux,
  `journalctl --user -u <unit>` as `service status` shows, and
  `loginctl enable-linger` keeps it running while you are logged out.
- **A phone takes at most five linked devices**, and each label is one of
  them.
- **Removing a label does not unlink it on the phone**: a linked device cannot
  take itself off, so remove it under Settings > Linked devices as well.
- **To link a label again** after Signal unlinked it, run `link` again: the
  old keys are moved aside and the history is kept, as long as the phone holds
  the same account. A different account gets a label of its own.
- `signal_account_read` tells an agent which of these steps a label needs.

## Layout

- `src/project.ts` — the package's name, tool ID prefix, setting prefix and
  toolsets.
- `src/core/` — the tool contract and the tools, free of any harness and of
  the project's names.
- `src/tools.ts` — the list of every tool, which each entry point registers.
- `src/mcp/` — the MCP server, built to `dist/mcp.js` and run by
  `signal-tools`.
- `src/opencode/` — the OpenCode plugin, built to `dist/opencode.js`.
- `src/cli/` — the command line the Hermes plugin calls, built to `dist/cli.js`
  and run by `signal-tools-cli`.
- `src/hermes/`, `plugin.yaml` and `__init__.py` — the Hermes plugin.
- `skills/` — one skill per toolset, `skills/<name>/SKILL.md`, which every
  harness that takes skills loads from the package or plugin root.
- `plugin.json`, `mcp.json`, `.mcp.json`, `.claude-plugin/`, `.agents/plugins/`,
  `.antigravity-plugin/` and `mcp_config.json` — the plugin manifests of the
  other harnesses. The root `.mcp.json` is the configuration Grok Build reads
  (with `${CLAUDE_PLUGIN_ROOT}`, the variable both Grok Build and Claude Code
  expand); when working on this repository in Claude Code, decline the project
  MCP server it offers from that file.

How a release is made is in [`RELEASING.md`](RELEASING.md).

## License

[MIT](LICENSE)
