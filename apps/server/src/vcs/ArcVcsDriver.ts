import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { VcsRepositoryDetectionError, VcsUnsupportedOperationError } from "@t3tools/contracts";

import * as ArcCli from "./ArcCli.ts";
import * as ArcOperations from "./ArcOperations.ts";
import type * as VcsDriver from "./VcsDriver.ts";
import { makeArcCheckpoints } from "../checkpointing/ArcCheckpointStore.ts";
import { makeArcWorkspaces } from "../workspace/ArcWorkspaceProvider.ts";
import { makeArcNativeBackend } from "./ArcNativeBackend.ts";

const findArcRoot = Effect.fn("ArcVcsDriver.findArcRoot")(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let candidate = path.resolve(cwd);
  while (true) {
    if (
      yield* fs.exists(path.join(candidate, ".arc", "HEAD")).pipe(
        Effect.mapError(
          (cause) =>
            new VcsRepositoryDetectionError({
              cwd,
              operation: "ArcVcsDriver.findArcRoot",
              detail: "Could not inspect the Arc checkout metadata.",
              cause,
            }),
        ),
      )
    )
      return candidate;
    const parent = path.dirname(candidate);
    if (candidate === parent) return null;
    candidate = parent;
  }
});

const Tree = Schema.Array(Schema.Struct({ name: Schema.String, type: Schema.String }));
const IgnoredStatus = Schema.Struct({
  status: Schema.Struct({
    ignored: Schema.optional(Schema.Array(Schema.Struct({ path: Schema.String }))),
  }),
});

export const makeArcVcsDriver = Effect.fn("ArcVcsDriver.make")(function* (checkpointRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cli = yield* ArcCli.ArcCli;
  const ops = yield* ArcOperations.ArcOperations;
  const checkpoints = yield* makeArcCheckpoints(checkpointRoot);
  const workspace = yield* makeArcWorkspaces();
  const backend = yield* makeArcNativeBackend(workspace);
  const freshness = Effect.fn("ArcVcsDriver.freshness")(function* () {
    return {
      source: "live-local" as const,
      observedAt: yield* DateTime.now,
      expiresAt: Option.none(),
    };
  });
  const detectRepository: VcsDriver.VcsDriver["Service"]["detectRepository"] = Effect.fn(
    "ArcVcsDriver.detectRepository",
  )(function* (cwd) {
    if (
      (yield* findArcRoot(cwd).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      )) === null
    )
      return null;
    const ctx = yield* ops.context(cwd);
    return {
      kind: "arc" as const,
      rootPath: ctx.root,
      metadataPath: path.join(ctx.root, ".arc"),
      freshness: yield* freshness(),
    };
  });
  const listWorkspaceFiles: VcsDriver.VcsDriver["Service"]["listWorkspaceFiles"] = Effect.fn(
    "ArcVcsDriver.listWorkspaceFiles",
  )(function* (cwd) {
    const ctx = yield* ops.context(cwd);
    if (ctx.scope === ".") return { paths: [], truncated: true, freshness: yield* freshness() };
    const tree = yield* cli.runJson(
      {
        cwd: ctx.root,
        operation: "ArcVcsDriver.listWorkspaceFiles",
        args: ["ls-tree", "--json", "-r", ctx.head, ctx.scope],
      },
      Tree,
    );
    const changed = yield* ops.changes(cwd);
    const files = new Set([
      ...tree.filter((entry) => entry.type !== "tree").map((entry) => entry.name),
      ...changed
        .filter((entry) => entry.worktree === "untracked" || entry.index === "new file")
        .map((entry) => entry.path),
    ]);
    const paths: string[] = [];
    for (const file of files) {
      const relative = path.relative(ctx.cwd, path.resolve(ctx.root, file));
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        return yield* new VcsRepositoryDetectionError({
          cwd,
          operation: "ArcVcsDriver.listWorkspaceFiles",
          detail: "Arc returned a file outside the project scope.",
        });
      paths.push(relative);
    }
    return { paths, truncated: false, freshness: yield* freshness() };
  });
  const filterIgnoredPaths: VcsDriver.VcsDriver["Service"]["filterIgnoredPaths"] = Effect.fn(
    "ArcVcsDriver.filterIgnoredPaths",
  )(function* (cwd, relativePaths) {
    if (relativePaths.length === 0) return [];
    const ctx = yield* ops.context(cwd);
    const paths = relativePaths.map((file) => path.relative(ctx.root, path.resolve(ctx.cwd, file)));
    for (const file of relativePaths) {
      const relative = path.relative(ctx.cwd, path.resolve(ctx.cwd, file));
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        return yield* new VcsRepositoryDetectionError({
          cwd,
          operation: "ArcVcsDriver.filterIgnoredPaths",
          detail: "Ignore classification must remain inside the project scope.",
        });
    }
    const ignored: string[] = [];
    for (let start = 0; start < paths.length; start += 100) {
      const result = yield* cli.runJson(
        {
          cwd: ctx.root,
          operation: "ArcVcsDriver.filterIgnoredPaths",
          args: [
            "status",
            "--json",
            "--ignored",
            "-u",
            "all",
            "--no-ahead-behind",
            "--no-sync-status",
            "--no-bisect-status",
            "--",
            ...paths.slice(start, start + 100),
          ],
        },
        IgnoredStatus,
      );
      ignored.push(...(result.status.ignored ?? []).map((entry) => entry.path.replace(/\/$/, "")));
    }
    return relativePaths.filter(
      (_, i) => !ignored.some((file) => paths[i] === file || paths[i]!.startsWith(`${file}/`)),
    );
  });
  return {
    execute: cli.run,
    operations: ops,
    workspace,
    backend,
    checkpoints,
    detectRepository,
    isInsideWorkTree: Effect.fn("ArcVcsDriver.isInsideWorkTree")(function* (cwd) {
      return (yield* detectRepository(cwd)) !== null;
    }),
    listWorkspaceFiles,
    listRemotes: Effect.fn("ArcVcsDriver.listRemotes")(function* (cwd) {
      const ctx = yield* ops.context(cwd);
      return {
        remotes: [
          {
            name: "arcadia",
            url: `https://a.yandex-team.ru/${encodeURIComponent(ctx.repository)}`,
            pushUrl: Option.none(),
            isPrimary: true,
          },
        ],
        freshness: yield* freshness(),
      };
    }),
    filterIgnoredPaths,
    initRepository: () =>
      Effect.fail(
        new VcsUnsupportedOperationError({
          kind: "arc",
          operation: "ArcVcsDriver.initRepository",
          detail: "Open an existing Arc checkout or create an isolated arc-wt workspace.",
        }),
      ),
  } satisfies VcsDriver.VcsDriver["Service"];
});
