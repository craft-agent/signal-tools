import { rmSync } from "node:fs"
import { labelPaths, type LabelPaths } from "./labels"
import { linkDevice, type LinkOptions, type LinkResult } from "./linking"
import { makeTempDir } from "./mirror.testing"
import { installFakeSignalCli, type FakeMode, type FakeSignalCli } from "./signal-cli.testing"

export const LABEL = "main"

/** A variable the fake must never see: `signalCliEnv` keeps it out. */
export const STRAY_VARIABLE = "SIGNAL_TOOLS_STRAY_SECRET"

/** A linking test's surroundings: a state directory, a fake signal-cli, and what `linkDevice` reported to its callbacks. */
export type LinkingFixture = {
  fake: FakeSignalCli
  stateDir: string
  paths: LabelPaths
  /** Every address handed to `onLinkUri`. */
  uris: string[]
  /** Every line handed to `log`. */
  logs: string[]
  /** Links `LABEL` with the fake, unless `overrides` say otherwise. */
  link(overrides?: Partial<LinkOptions>): Promise<LinkResult>
  close(): void
}

/** Sets up a linking test whose fake signal-cli behaves as `mode`; call `close` afterwards. */
export function linkingFixture(mode: FakeMode): LinkingFixture {
  const fake = installFakeSignalCli(mode)
  const stateDir = makeTempDir()
  const uris: string[] = []
  const logs: string[] = []
  return {
    fake,
    stateDir,
    paths: labelPaths(stateDir, LABEL),
    uris,
    logs,
    link: (overrides = {}) =>
      linkDevice({
        stateDir,
        label: LABEL,
        deviceName: "My box",
        program: fake.program,
        env: { ...fake.env, [STRAY_VARIABLE]: "secret" },
        onLinkUri: (uri) => uris.push(uri),
        log: (line) => logs.push(line),
        ...overrides,
      }),
    close() {
      fake.close()
      rmSync(stateDir, { recursive: true, force: true })
    },
  }
}
