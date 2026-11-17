import * as Schema from "effect/Schema";

const ArcPath = Schema.String.check(Schema.isNonEmpty());
const NativeChange = Schema.Struct({
  path: ArcPath,
  status: Schema.String,
  orig_path: Schema.optional(ArcPath),
  source: Schema.optional(Schema.Struct({ path: ArcPath })),
});
const NativeStatus = Schema.Struct({
  status: Schema.Struct({
    staged: Schema.optional(Schema.Array(NativeChange)),
    changed: Schema.optional(Schema.Array(NativeChange)),
    untracked: Schema.optional(Schema.Array(NativeChange)),
    unmerged: Schema.optional(Schema.Array(NativeChange)),
    ignored: Schema.optional(Schema.Array(NativeChange)),
  }),
});
const parseNativeStatus = Schema.decodeUnknownSync(NativeStatus);
const parseStatusGroups = Schema.decodeUnknownSync(
  Schema.Struct({ status: Schema.Record(Schema.String, Schema.Array(Schema.Unknown)) }),
);

export interface ArcChange {
  readonly path: string;
  readonly originalPath?: string;
  readonly index: string | null;
  readonly worktree: string | null;
}

export const decodeArcStatus = (input: unknown): ReadonlyArray<ArcChange> => {
  const groups = parseStatusGroups(input).status;
  for (const [group, entries] of Object.entries(groups))
    if (
      !["staged", "changed", "untracked", "unmerged", "ignored"].includes(group) &&
      entries.length > 0
    )
      throw new TypeError("Arc returned an unsupported group of changed files.");
  const { status } = parseNativeStatus(input);
  const entries = new Map<string, ArcChange>();
  for (const group of ["staged", "changed", "untracked", "unmerged"] as const) {
    for (const change of status[group] ?? []) {
      const previous = entries.get(change.path);
      const originalPath = change.orig_path ?? change.source?.path ?? previous?.originalPath;
      entries.set(change.path, {
        path: change.path,
        ...(originalPath === undefined ? {} : { originalPath }),
        index:
          group === "staged" || group === "unmerged" ? change.status : (previous?.index ?? null),
        worktree: group === "staged" ? (previous?.worktree ?? null) : change.status,
      });
    }
  }
  return [...entries.values()];
};
