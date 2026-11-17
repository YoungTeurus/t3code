import type { ProjectSearchSource } from "@t3tools/contracts";

/** How search UIs name results that came from a server-side index instead of the checkout. */
export function describeSearchSource(source: ProjectSearchSource | null | undefined) {
  if (source === null || source === undefined) return null;
  const label = source.revision ? `${source.index} ${source.revision}` : source.index;
  return {
    label,
    note: `From the ${label} index. Local changes are not included.`,
    detail:
      "Results come from a server index, not this checkout. Local edits and new files are not included, deleted files may still appear, line numbers can differ, and the index lags behind recent commits.",
  };
}
