/** What makes this package itself; a project made from the starter sets these once (the setup script does). */
export const PROJECT = {
  /** The plugin, MCP server and program name. */
  name: "signal-tools",
  /** The command line the Hermes plugin calls. */
  cli: "signal-tools-cli",
  /** Every tool ID starts with `<toolPrefix>_`. */
  toolPrefix: "signal",
  /** Every setting's environment variable is `<envPrefix>_<SETTING>`. */
  envPrefix: "SIGNAL_TOOLS",
  /** The toolsets, in the order `all` lists them. */
  toolsets: ["account", "chats", "contacts", "files", "sends", "actions"] as readonly string[],
  /** The toolsets on when a setting names none. */
  defaultToolsets: ["account", "chats", "contacts", "sends"] as readonly string[],
} as const
