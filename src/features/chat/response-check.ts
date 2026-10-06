/**
 * Response check — did the reply's own account of itself match what this
 * client asked for?
 *
 * Two partial sides, fed by engine events:
 *
 *  - `requested`: the launch selection (`launch`), i.e. the model/effort the
 *    run actually started with, after channel remap.
 *  - `served`: what the response reported (`served`) — claude's assistant
 *    snapshot model, the serving model the pi runtime recovered, or a codex
 *    reroute target.
 *
 * A side that never reported stays `null` and can never produce a verdict:
 * an unreported field is unknown, not a pass. Comparisons tolerate the
 * naming variants a gateway legitimately introduces (a provider prefix, a
 * `-latest`/date snapshot suffix, `xhigh` vs `extra-high`) — a snapshot
 * difference is a "variant", not a substitution — while a genuine
 * difference stays a mismatch.
 */

export interface SelectionSide {
  model: string | null;
  effort: string | null;
}

/** Requested vs served selection for the run the tail indicator shows. */
export interface ResponseCheckState {
  requested: SelectionSide;
  served: SelectionSide;
}

export type SelectionVerdict = "match" | "variant" | "mismatch" | "unknown";

export interface ResponseCheckView {
  model: SelectionVerdict;
  effort: SelectionVerdict;
  /** "mismatch" when any reported side disagrees, "match" when at least one
   *  reported side agrees and none disagrees, "unknown" when nothing was
   *  reported to compare. */
  verdict: "match" | "mismatch" | "unknown";
  /** False when there is nothing to show: no comparable side at all. */
  visible: boolean;
}

const EMPTY_SIDE: SelectionSide = { model: null, effort: null };

/** "provider/model" and the picker's "[1m]" tag are the same model. */
function bareModel(id: string): string {
  const trimmed = id.trim().toLowerCase();
  const bare = trimmed.includes("/")
    ? trimmed.slice(trimmed.lastIndexOf("/") + 1)
    : trimmed;
  return bare.replace(/\[1m\]$/, "");
}

/** `-latest` and dated snapshots name the same family. */
function snapshotFree(model: string): string {
  return model
    .replace(/-latest$/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-\d{4}-\d{2}-\d{2}$/, "");
}

export function compareModel(
  requested: string | null,
  served: string | null,
): SelectionVerdict {
  if (!requested || !served) return "unknown";
  const a = bareModel(requested);
  const b = bareModel(served);
  if (a === b) return "match";
  return snapshotFree(a) === snapshotFree(b) ? "variant" : "mismatch";
}

/** Separator/case-insensitive; `extra-high` is the same level as `xhigh`. */
function effortKey(level: string): string {
  const key = level.trim().toLowerCase().replace(/[-_\s]/g, "");
  return key === "extrahigh" ? "xhigh" : key;
}

export function compareEffort(
  requested: string | null,
  served: string | null,
): SelectionVerdict {
  if (!requested || !served) return "unknown";
  return effortKey(requested) === effortKey(served) ? "match" : "mismatch";
}

export function checkResponseSelection(
  check: ResponseCheckState | null | undefined,
): ResponseCheckView {
  const requested = check?.requested ?? EMPTY_SIDE;
  const served = check?.served ?? EMPTY_SIDE;
  const model = compareModel(requested.model, served.model);
  const effort = compareEffort(requested.effort, served.effort);
  const verdict =
    model === "mismatch" || effort === "mismatch"
      ? "mismatch"
      : model !== "unknown" || effort !== "unknown"
        ? "match"
        : "unknown";
  return { model, effort, verdict, visible: verdict !== "unknown" };
}
