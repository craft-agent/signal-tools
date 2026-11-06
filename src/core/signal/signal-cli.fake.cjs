#!/usr/bin/env node
// A stand-in for signal-cli in tests. `signal-cli.testing.ts` copies it into a temp
// directory as `signal-cli`, next to a `fake.json` that says how to behave:
// { "mode": "<name>", "accounts": { "linked": { uuid, number }, "other": { uuid, number } } }.
// Every start is recorded in `calls.jsonl`. Add a mode by adding a function to `MODES`.
// The `daemon-*` modes serve JSON-RPC on the `--socket` path (see `serveDaemon`).
"use strict"

const fs = require("node:fs")
const path = require("node:path")

const config = JSON.parse(fs.readFileSync(path.join(__dirname, "fake.json"), "utf8"))

const args = []
let configDir
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--config") configDir = argv[++i]
  else if (argv[i] !== "--scrub-log") args.push(argv[i])
}

fs.appendFileSync(
  path.join(__dirname, "calls.jsonl"),
  `${JSON.stringify({ pid: process.pid, config: configDir, args, env: Object.keys(process.env) })}\n`,
)

const LINK_URI = "sgnl://linkdevice?uuid=fake-device&pub_key=fake-key"
const ACCOUNT_FILE = "100001"

/** Writes the files a finished `link` leaves in `<config>/data`. */
function writeLinkedAccount({ uuid, number }) {
  const dataDir = path.join(configDir, "data")
  fs.mkdirSync(dataDir, { recursive: true })
  const index = { accounts: [{ path: ACCOUNT_FILE, environment: "LIVE", number, uuid }], version: 2 }
  fs.writeFileSync(path.join(dataDir, "accounts.json"), JSON.stringify(index))
  fs.writeFileSync(
    path.join(dataDir, ACCOUNT_FILE),
    JSON.stringify({ registered: true, number, password: "made-up-secret" }),
  )
}

function link(account) {
  process.stdout.write(`${LINK_URI}\n`)
  process.stderr.write(`INFO Waiting for ${account.number} to scan the code\n`)
  writeLinkedAccount(account)
  process.stdout.write(`Associated with: ${account.number}\n`)
}

function hang() {
  setInterval(() => {}, 1000)
}

const EXIT_AFTER_ENVELOPES = 3
const NOT_REGISTERED = "ERROR Not registered: "

/** What the daemon modes serve, from `daemon.json` beside this file: { payloads, contacts, groups, later: { afterMs, payloads } }. */
function readDaemonFixture() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "daemon.json"), "utf8"))
  } catch {
    return {}
  }
}

/**
 * A JSON-RPC 2.0 server, one JSON object per line, on the `--socket` path. It answers
 * `subscribeReceive` (0, then each fixture payload as a `receive` notification),
 * `listContacts` and `listGroups`, and records every request in `rpc.jsonl`.
 * `ignoreTerm` keeps it running on SIGTERM; `exitAfterEnvelopes` makes it exit with
 * code 3 right after it wrote the notifications.
 */
function serveDaemon({ ignoreTerm = false, exitAfterEnvelopes = false } = {}) {
  const net = require("node:net")
  const socketPath = args[args.indexOf("--socket") + 1]
  const fixture = readDaemonFixture()
  const removeSocket = () => fs.rmSync(socketPath, { force: true })

  const write = (client, message, done) => client.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`, done)
  const notify = (client, result, done) =>
    write(client, { method: "receive", params: { subscription: 0, result } }, done)

  const subscribe = (client, id) => {
    write(client, { id, result: 0 })
    const payloads = fixture.payloads || []
    payloads.forEach((payload, index) => {
      const last = index === payloads.length - 1
      notify(client, payload, exitAfterEnvelopes && last ? () => process.exit(EXIT_AFTER_ENVELOPES) : undefined)
    })
    if (exitAfterEnvelopes && payloads.length === 0) process.exit(EXIT_AFTER_ENVELOPES)
    if (fixture.later) {
      setTimeout(() => fixture.later.payloads.forEach((payload) => notify(client, payload)), fixture.later.afterMs)
    }
  }

  const answer = (client, request) => {
    fs.appendFileSync(
      path.join(__dirname, "rpc.jsonl"),
      `${JSON.stringify({ method: request.method, params: request.params })}\n`,
    )
    if (request.method === "subscribeReceive") subscribe(client, request.id)
    else if (request.method === "listContacts") write(client, { id: request.id, result: fixture.contacts || [] })
    else if (request.method === "listGroups") write(client, { id: request.id, result: fixture.groups || [] })
    else write(client, { id: request.id, error: { code: -32601, message: "Method not found" } })
  }

  const server = net.createServer((client) => {
    client.setEncoding("utf8")
    client.on("error", () => {})
    let buffer = ""
    client.on("data", (chunk) => {
      const lines = (buffer + chunk).split("\n")
      buffer = lines.pop()
      for (const line of lines) if (line.trim()) answer(client, JSON.parse(line))
    })
  })
  removeSocket()
  server.listen(socketPath, () => process.stderr.write(`INFO Daemon started for ${config.accounts.linked.number}\n`))
  process.on("exit", removeSocket)
  process.on("SIGTERM", () => {
    if (!ignoreTerm) process.exit(0)
  })
}

const MODES = {
  "link-ok": () => link(config.accounts.linked),
  "link-other": () => link(config.accounts.other),
  "link-fail": () => {
    process.stderr.write(`Link request error: no device at ${config.accounts.linked.number}\n`)
    process.exitCode = 1
  },
  "link-empty": () => {
    process.stdout.write(`${LINK_URI}\n`)
  },
  "link-hang": () => {
    process.stdout.write(`${LINK_URI}\n`)
    hang()
  },
  "hang-stubborn": () => {
    process.on("SIGTERM", () => {})
    process.stdout.write("ready\n")
    hang()
  },
  "daemon-ok": () => serveDaemon(),
  "daemon-exit-after-envelopes": () => serveDaemon({ exitAfterEnvelopes: true }),
  "daemon-ignore-term": () => serveDaemon({ ignoreTerm: true }),
  "daemon-no-socket": () => {
    process.stderr.write("INFO Starting, the socket will not open\n")
    hang()
  },
  "daemon-unlinked": () => {
    process.stderr.write(`${NOT_REGISTERED}${config.accounts.linked.number}\n`)
    process.exitCode = 1
  },
  lines: () => {
    process.stdout.write("one\ntwo\r\npartial")
    process.stderr.write(`warn ${config.accounts.linked.number} here\nlast`)
  },
}

MODES[config.mode]()
