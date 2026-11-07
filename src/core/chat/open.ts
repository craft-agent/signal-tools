import { ToolError } from "../errors"
import { pickLabel, type LabelPaths } from "../signal/labels"
import { getMeta, openMirrorForRead, type Mirror } from "../signal/mirror"
import { ACCOUNT_UUID_META } from "../signal/mirror-meta"
import type { ToolContext } from "../tool"

/**
 * Runs `read` on the mirror of the account `account` picks (see `pickLabel`),
 * opened read-only, with the user's own account id when the mirror has
 * recorded it. All of `read` runs in one read transaction, so what it reads
 * belongs to one moment. The mirror is closed afterwards, whatever `read` does.
 * `read` also gets the label's paths, for a caller that goes on to use them.
 */
export async function withMirror<T>(
  ctx: Pick<ToolContext, "stateDir">,
  account: string | undefined,
  read: (mirror: Mirror, me: string | null, paths: LabelPaths) => T,
): Promise<T> {
  if (!ctx.stateDir) throw new ToolError("internal_error", "The entry point did not supply a state directory.")
  const paths = await pickLabel(ctx.stateDir, account)
  const mirror = openMirrorForRead(paths.mirror)
  try {
    // One deferred read transaction: every query of the call sees the same moment, however the service writes meanwhile.
    mirror.exec("BEGIN")
    try {
      return read(mirror, getMeta(mirror)[ACCOUNT_UUID_META] ?? null, paths)
    } finally {
      if (mirror.isTransaction) mirror.exec("ROLLBACK")
    }
  } finally {
    mirror.close()
  }
}
