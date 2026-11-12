import { homedir } from "node:os"
import { isAbsolute, resolve } from "node:path"
import type { ToolOptions, ToolOptionValue } from "../core"
import type { EntryProfile } from "./profile"

/** The folder of a person's downloads under their home directory. */
const DOWNLOADS_DIR = "Downloads"

/** The directories the settings name, resolved to absolute paths. */
export type DirectorySettings = { state_dir: string; download_dir: string; send_dirs: string[] }

/** The user's home directory from `$HOME` (when absolute) or `os.homedir()`. */
function homeDir(env: Record<string, string | undefined>): string {
  const envHome = env.HOME
  if (envHome && isAbsolute(envHome)) return envHome
  return homedir()
}

function pathOption(value: ToolOptionValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined
}

function pathsOption(value: ToolOptionValue | undefined): string[] {
  return typeof value === "object" ? [...value] : []
}

/**
 * Fills in the directory settings from the package's own options, which the
 * starter's parsers have already made absolute: the state directory defaults
 * to `$XDG_STATE_HOME/<profile.name>` (when absolute) or
 * `<home>/.local/state/<profile.name>`, the download directory to
 * `<home>/Downloads/<profile.name>`, where a person looks for what they
 * downloaded, and the directories files may be sent from, besides the working
 * directory, to none.
 */
export function resolveDirectorySettings(
  options: ToolOptions,
  env: Record<string, string | undefined>,
  profile: EntryProfile,
): DirectorySettings {
  const home = homeDir(env)
  const xdg = env.XDG_STATE_HOME
  return {
    state_dir:
      pathOption(options.state_dir) ??
      (xdg && isAbsolute(xdg) ? resolve(xdg, profile.name) : resolve(home, ".local", "state", profile.name)),
    download_dir: pathOption(options.download_dir) ?? resolve(home, DOWNLOADS_DIR, profile.name),
    send_dirs: pathsOption(options.send_dirs),
  }
}

/** The directory properties an entry point passes to `ToolContext`. */
export type ToolDirectories = { stateDir: string; downloadDir: string; sendDirs: string[] }

/** Maps resolved directory settings to the properties of `ToolContext`. */
export function toolDirectories(settings: DirectorySettings): ToolDirectories {
  return { stateDir: settings.state_dir, downloadDir: settings.download_dir, sendDirs: settings.send_dirs }
}
