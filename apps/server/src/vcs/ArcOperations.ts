import * as NodeBuffer from "node:buffer";

import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  VcsRepositoryDetectionError,
  VcsProcessOutputReadError,
  type VcsError,
  type VcsStatusInput,
  type VcsStatusLocalResult,
  type VcsListRefsInput,
  type VcsListRefsResult,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
  type ReviewDiffPreviewSource,
  type ReviewDiffFileContentsInput,
  type ReviewDiffFileContentsResult,
  type VcsCreateRefInput,
  type VcsSwitchRefInput,
  type VcsPullResult,
} from "@t3tools/contracts";

import * as ArcCli from "./ArcCli.ts";
import { decodeArcStatus, type ArcChange } from "./arcStatus.ts";
import type { VcsRepositoryOperations } from "./VcsOperations.ts";
const { Buffer } = NodeBuffer;

const ArcInfo = Schema.Struct({
  hash: Schema.NonEmptyString,
  repository: Schema.NonEmptyString,
  branch: Schema.optional(Schema.String),
  remote: Schema.optional(Schema.String),
  mount_id: Schema.optional(Schema.String),
  user_login: Schema.optional(Schema.String),
});
const ArcBranches = Schema.Array(
  Schema.Struct({
    name: Schema.NonEmptyString,
    local: Schema.optional(Schema.Boolean),
    current: Schema.optional(Schema.Boolean),
    remote: Schema.optional(Schema.String),
  }),
);
const ArcCommitIds = Schema.Array(Schema.Struct({ commit: Schema.NonEmptyString }));
const ArcSubjects = Schema.Array(Schema.Struct({ message: Schema.String }));

export interface ArcRepositoryContext {
  readonly root: string;
  readonly cwd: string;
  readonly scope: string;
  readonly repository: string;
  readonly head: string;
  readonly branch: string | null;
  readonly upstream: string | null;
  readonly identity: string;
}

export class ArcOperations extends Context.Service<
  ArcOperations,
  VcsRepositoryOperations & {
    readonly context: (cwd: string) => Effect.Effect<ArcRepositoryContext, VcsError>;
    readonly changes: (cwd: string) => Effect.Effect<ReadonlyArray<ArcChange>, VcsError>;
  }
>()("t3/vcs/ArcOperations") {}

const summarize = (patch: string) => {
  let insertions = 0;
  let deletions = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) inHunk = false;
    else if (line.startsWith("@@ ")) inHunk = true;
    else if (inHunk && line.startsWith("+")) insertions++;
    else if (inHunk && line.startsWith("-")) deletions++;
  }
  return { insertions, deletions };
};

const quotePath = (value: string) => JSON.stringify(value);

const make = Effect.gen(function* () {
  const cli = yield* ArcCli.ArcCli;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;

  const failure = (cwd: string, operation: string, cause: unknown) =>
    new VcsProcessOutputReadError({ cwd, operation, command: "arc", stream: "stdout", cause });

  const hashPatch = Effect.fn("ArcOperations.hashPatch")(function* (cwd: string, patch: string) {
    const bytes = yield* crypto
      .digest("SHA-256", Buffer.from(patch))
      .pipe(Effect.mapError((cause) => failure(cwd, "ArcOperations.hashPatch", cause)));
    return Buffer.from(bytes).toString("hex");
  });

  const context = Effect.fn("ArcOperations.context")(function* (cwd: string) {
    const rootResult = yield* cli.run({ cwd, operation: "ArcOperations.root", args: ["root"] });
    const canonical = (value: string) =>
      fs.realPath(value).pipe(
        Effect.catchTags({
          PlatformError: (cause) =>
            cause.reason._tag === "NotFound" ? Effect.succeed(value) : Effect.fail(cause),
        }),
        Effect.mapError((cause) => failure(cwd, "ArcOperations.canonicalPath", cause)),
      );
    const root = yield* canonical(path.resolve(rootResult.stdout.trim()));
    const resolvedCwd = yield* canonical(path.resolve(cwd));
    const scope = path.relative(root, resolvedCwd);
    if (
      !rootResult.stdout.trim() ||
      scope === ".." ||
      scope.startsWith(`..${path.sep}`) ||
      path.isAbsolute(scope)
    ) {
      return yield* new VcsRepositoryDetectionError({
        cwd,
        operation: "ArcOperations.context",
        detail: "The Arc project must belong to its checkout root.",
      });
    }
    const info = yield* cli.runJson(
      { cwd: root, operation: "ArcOperations.info", args: ["info", "--json"] },
      ArcInfo,
    );
    return {
      root,
      cwd: resolvedCwd,
      scope: scope || ".",
      repository: info.repository,
      head: info.hash,
      branch: info.branch || null,
      upstream: info.remote || null,
      identity: `${root}\0${info.mount_id ?? root}`,
    } satisfies ArcRepositoryContext;
  });

  const scopedPath = (ctx: ArcRepositoryContext, file: string) => {
    const absolute = path.resolve(ctx.root, file);
    const relative = path.relative(ctx.cwd, absolute);
    return !path.isAbsolute(file) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
      ? Effect.succeed(absolute)
      : Effect.fail(
          new VcsRepositoryDetectionError({
            cwd: ctx.cwd,
            operation: "ArcOperations.path",
            detail: "The requested path must remain inside the Arc project.",
          }),
        );
  };

  const readChanges = Effect.fn("ArcOperations.readChanges")(function* (ctx: ArcRepositoryContext) {
    const output = yield* cli.runJson(
      {
        cwd: ctx.root,
        operation: "ArcOperations.status",
        args: [
          "status",
          "--json",
          "-u",
          "all",
          "--no-ahead-behind",
          "--no-sync-status",
          "--no-bisect-status",
          "--",
          ctx.scope,
        ],
      },
      Schema.Unknown,
    );
    return yield* Effect.try({
      try: () => decodeArcStatus(output),
      catch: (cause) => failure(ctx.cwd, "ArcOperations.status", cause),
    });
  });

  const readPatch = Effect.fn("ArcOperations.readPatch")(function* (
    ctx: ArcRepositoryContext,
    files: ReadonlyArray<string>,
    revisions: ReadonlyArray<string>,
    ignoreWhitespace = false,
  ) {
    for (const file of files) yield* scopedPath(ctx, file);
    return (yield* cli.run({
      cwd: ctx.root,
      operation: "ArcOperations.diff",
      args: [
        "diff",
        "--git",
        "--binary",
        "--no-color",
        ...(ignoreWhitespace ? ["--ignore-all-space"] : []),
        ...revisions,
        "--",
        ...files,
      ],
      maxOutputBytes: 10_000_000,
    })).stdout;
  });

  const workingFile = Effect.fn("ArcOperations.workingFile")(function* (
    ctx: ArcRepositoryContext,
    file: string,
  ) {
    const absolute = yield* scopedPath(ctx, file);
    const realParent = yield* fs
      .realPath(path.dirname(absolute))
      .pipe(Effect.mapError((cause) => failure(ctx.cwd, "ArcOperations.untracked", cause)));
    yield* scopedPath(ctx, path.relative(ctx.root, realParent));
    const link = yield* fs.readLink(absolute).pipe(Effect.option);
    if (Option.isSome(link)) return { bytes: Buffer.from(link.value), mode: "120000" };
    const info = yield* fs
      .stat(absolute)
      .pipe(Effect.mapError((cause) => failure(ctx.cwd, "ArcOperations.fileStat", cause)));
    if (info.type !== "File" || info.size > 10_000_000)
      return yield* failure(
        ctx.cwd,
        "ArcOperations.fileLimit",
        new Error("The working file is not a regular file or exceeds the 10 MB preview limit."),
      );
    const bytes = yield* fs
      .readFile(absolute)
      .pipe(Effect.mapError((cause) => failure(ctx.cwd, "ArcOperations.untracked", cause)));
    return { bytes, mode: (info.mode & 0o111) !== 0 ? "100755" : "100644" };
  });
  const untrackedPatch = Effect.fn("ArcOperations.untrackedPatch")(function* (
    ctx: ArcRepositoryContext,
    file: string,
  ) {
    const { bytes, mode } = yield* workingFile(ctx, file);
    const a = quotePath(`a/${file}`);
    const b = quotePath(`b/${file}`);
    const decoded = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      catch: (cause) => failure(ctx.cwd, "ArcOperations.untracked", cause),
    }).pipe(Effect.option);
    if (bytes.includes(0) || Option.isNone(decoded))
      return `diff --git ${a} ${b}\nnew file mode ${mode}\nBinary files /dev/null and ${b} differ\n`;
    const text = decoded.value;
    const lines = text.split("\n");
    if (text.endsWith("\n")) lines.pop();
    if (text === "") return `diff --git ${a} ${b}\nnew file mode ${mode}\n`;
    return `diff --git ${a} ${b}\nnew file mode ${mode}\n--- /dev/null\n+++ ${b}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}\n`).join("")}${text.endsWith("\n") ? "" : "\\ No newline at end of file\n"}`;
  });

  const localStatus = Effect.fn("ArcOperations.localStatus")(function* (input: VcsStatusInput) {
    const ctx = yield* context(input.cwd);
    const changes = yield* readChanges(ctx);
    const files = yield* Effect.forEach(
      changes,
      (change) =>
        (change.worktree === "untracked"
          ? untrackedPatch(ctx, change.path)
          : readPatch(ctx, [change.path], ["HEAD"])
        ).pipe(Effect.map((patch) => ({ path: change.path, ...summarize(patch) }))),
      { concurrency: 4 },
    );
    return {
      isRepo: true,
      vcsKind: "arc",
      hasPrimaryRemote: true,
      isDefaultRef: ctx.branch === "trunk",
      refName: ctx.branch,
      hasWorkingTreeChanges: changes.length > 0,
      workingTree: {
        rootPath: ctx.root,
        files,
        insertions: files.reduce((n, f) => n + f.insertions, 0),
        deletions: files.reduce((n, f) => n + f.deletions, 0),
      },
    } satisfies VcsStatusLocalResult;
  });

  const listRefs = Effect.fn("ArcOperations.listRefs")(function* (input: VcsListRefsInput) {
    const ctx = yield* context(input.cwd);
    const branches = yield* cli.runJson(
      {
        cwd: ctx.root,
        operation: "ArcOperations.branches",
        args: [
          "branch",
          "--json",
          "-v",
          ...(input.refKind === "remote" || input.includeMatchingRemoteRefs ? ["-a"] : []),
        ],
      },
      ArcBranches,
    );
    const refs = branches
      .filter(
        (b) =>
          (input.refKind !== "local" || b.local) &&
          (input.refKind !== "remote" || !b.local) &&
          (!input.query || b.name.toLowerCase().includes(input.query.toLowerCase())),
      )
      .map((b) => ({
        name: b.name,
        current: b.current ?? false,
        isRemote: !b.local,
        ...(!b.local ? { remoteName: "arcadia" } : {}),
        ...(b.remote ? { upstreamRef: b.remote } : {}),
        isDefault: b.name === "trunk" || b.name === "arcadia/trunk",
        worktreePath: b.current ? ctx.cwd : null,
      }));
    const cursor = input.cursor ?? 0;
    const page = refs.slice(cursor, cursor + (input.limit ?? 100));
    return {
      refs: page,
      isRepo: true,
      hasPrimaryRemote: true,
      isAtRepositoryRoot: ctx.scope === ".",
      totalCount: refs.length,
      nextCursor: cursor + page.length < refs.length ? cursor + page.length : null,
    } satisfies VcsListRefsResult;
  });

  const getReviewDiffPreview = Effect.fn("ArcOperations.getReviewDiffPreview")(function* (
    input: ReviewDiffPreviewInput,
  ) {
    const ctx = yield* context(input.cwd);
    const sources: ReviewDiffPreviewSource[] = [];
    const selectedPaths = input.file
      ? [input.file.path, ...(input.file.previousPath ? [input.file.previousPath] : [])]
      : [ctx.scope];
    const working = input.file?.sourceKind !== "branch-range";
    if (working) {
      let patch = yield* readPatch(ctx, selectedPaths, ["HEAD"], input.ignoreWhitespace);
      for (const change of yield* readChanges(ctx)) {
        if (change.worktree === "untracked" && (!input.file || input.file.path === change.path))
          patch += yield* untrackedPatch(ctx, change.path);
      }
      sources.push({
        id: "working-tree",
        kind: "working-tree",
        title: "Working tree",
        baseRef: ctx.head,
        headRef: null,
        diff: patch,
        diffHash: yield* hashPatch(ctx.cwd, patch),
        truncated: false,
      });
    }
    if (input.file?.sourceKind !== "working-tree") {
      const baseRef = input.baseRef ?? "arcadia/trunk";
      if (baseRef.startsWith("-"))
        return yield* new VcsRepositoryDetectionError({
          cwd: input.cwd,
          operation: "ArcOperations.baseRef",
          detail: "Invalid Arc revision.",
        });
      const base = (yield* cli.run({
        cwd: ctx.root,
        operation: "ArcOperations.mergeBase",
        args: ["merge-base", "--leftmost", baseRef, "HEAD"],
      })).stdout.trim();
      const patch = yield* readPatch(ctx, selectedPaths, [base, "HEAD"], input.ignoreWhitespace);
      sources.push({
        id: "branch-range",
        kind: "branch-range",
        title: "Branch changes",
        baseRef: base,
        headRef: ctx.head,
        diff: patch,
        diffHash: yield* hashPatch(ctx.cwd, patch),
        truncated: false,
      });
    }
    return {
      cwd: input.cwd,
      generatedAt: yield* DateTime.now,
      sources,
    } satisfies ReviewDiffPreviewResult;
  });

  const getReviewDiffFileContents = Effect.fn("ArcOperations.getReviewDiffFileContents")(function* (
    input: ReviewDiffFileContentsInput,
  ) {
    const ctx = yield* context(input.cwd);
    const read = Effect.fn("ArcOperations.fileContents")(function* (
      file: string,
      revision: string | null,
    ) {
      yield* scopedPath(ctx, file);
      const bytes =
        revision !== null
          ? (yield* cli.run({
              cwd: ctx.root,
              operation: "ArcOperations.show",
              args: ["show", `${revision}:${file}`],
            })).stdoutBytes
          : (yield* workingFile(ctx, file)).bytes;
      return yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        catch: (cause) => failure(ctx.cwd, "ArcOperations.fileContents", cause),
      });
    });
    return {
      oldContents:
        input.changeType === "new" ? "" : yield* read(input.oldPath, input.baseRef ?? ctx.head),
      newContents:
        input.changeType === "deleted"
          ? ""
          : yield* read(
              input.newPath,
              input.sourceKind === "working-tree" ? null : (input.headRef ?? ctx.head),
            ),
    } satisfies ReviewDiffFileContentsResult;
  });

  const validateRef = (cwd: string, ref: string) =>
    ref.length > 0 && !ref.startsWith("-") && !/[\0\r\n]/.test(ref)
      ? Effect.void
      : Effect.fail(
          new VcsRepositoryDetectionError({
            cwd,
            operation: "ArcOperations.ref",
            detail: "Invalid Arc revision or branch name.",
          }),
        );

  const createRef = Effect.fn("ArcOperations.createRef")(function* (input: VcsCreateRefInput) {
    yield* validateRef(input.cwd, input.refName);
    const ctx = yield* context(input.cwd);
    yield* cli.run({
      cwd: ctx.root,
      operation: "ArcOperations.createRef",
      args: input.switchRef ? ["checkout", "-b", input.refName] : ["branch", input.refName],
    });
    return { refName: input.refName };
  });

  const switchRef = Effect.fn("ArcOperations.switchRef")(function* (input: VcsSwitchRefInput) {
    yield* validateRef(input.cwd, input.refName);
    const ctx = yield* context(input.cwd);
    yield* cli.run({
      cwd: ctx.root,
      operation: "ArcOperations.switchRef",
      args: ["checkout", input.refName],
    });
    return { refName: (yield* context(input.cwd)).branch };
  });

  const commit = Effect.fn("ArcOperations.commit")(function (
    cwd: string,
    subject: string,
    body: string,
    options?: { readonly filePaths?: ReadonlyArray<string> },
  ) {
    return Effect.scoped(
      Effect.gen(function* () {
        const ctx = yield* context(cwd);
        const selected =
          options?.filePaths ??
          (yield* readChanges(ctx)).flatMap((change) => [
            change.path,
            ...(change.originalPath ? [change.originalPath] : []),
          ]);
        const files = [...new Set(selected)];
        if (files.length === 0)
          return yield* new VcsRepositoryDetectionError({
            cwd,
            operation: "ArcOperations.commit",
            detail: "No changed Arc files were selected.",
          });
        for (const file of files) yield* scopedPath(ctx, file);
        const messageFile = yield* fs
          .makeTempFileScoped({ prefix: "t3-arc-commit-" })
          .pipe(Effect.mapError((cause) => failure(cwd, "ArcOperations.commitMessage", cause)));
        yield* fs
          .writeFileString(messageFile, `${subject}${body ? `\n\n${body}` : ""}\n`, { mode: 0o600 })
          .pipe(Effect.mapError((cause) => failure(cwd, "ArcOperations.commitMessage", cause)));
        yield* cli.run({
          cwd: ctx.root,
          operation: "ArcOperations.stageSelected",
          args: ["add", "--", ...files],
        });
        yield* cli.run({
          cwd: ctx.root,
          operation: "ArcOperations.commit",
          args: ["commit", "-F", messageFile, "--", ...files],
          timeoutMs: 300_000,
        });
        const after = yield* context(cwd);
        if (after.head === ctx.head)
          return yield* new VcsRepositoryDetectionError({
            cwd,
            operation: "ArcOperations.commit",
            detail: "Arc did not create a new commit.",
          });
        return { commitSha: after.head };
      }),
    );
  });

  const pushCurrentBranch = Effect.fn("ArcOperations.pushCurrentBranch")(function* (cwd: string) {
    const before = yield* context(cwd);
    if (!before.branch)
      return yield* new VcsRepositoryDetectionError({
        cwd,
        operation: "ArcOperations.push",
        detail: "Publishing requires an Arc branch.",
      });
    yield* cli.run({
      cwd: before.root,
      operation: "ArcOperations.push",
      args: before.upstream ? ["push"] : ["push", "-u", before.branch],
      timeoutMs: 300_000,
    });
    const after = yield* context(cwd);
    if (
      after.branch !== before.branch ||
      after.head !== before.head ||
      !after.upstream ||
      (before.upstream !== null &&
        before.upstream.replace(/^arcadia\//u, "") !== after.upstream.replace(/^arcadia\//u, ""))
    )
      return yield* new VcsRepositoryDetectionError({
        cwd,
        operation: "ArcOperations.pushReadback",
        detail: "The Arc checkout changed during publication or has no upstream.",
      });
    yield* validateRef(cwd, after.upstream);
    const published = yield* cli.runJson(
      {
        cwd: after.root,
        operation: "ArcOperations.publishedHead",
        args: ["log", "--json", "--no-walk", after.upstream],
      },
      ArcCommitIds,
    );
    if (published.length !== 1 || published[0]!.commit !== before.head)
      return yield* new VcsRepositoryDetectionError({
        cwd,
        operation: "ArcOperations.pushReadback",
        detail: "The Arc upstream does not point to the published commit.",
      });
    return {
      status: "pushed" as const,
      branch: before.branch,
      ...(after.upstream ? { upstreamBranch: after.upstream } : {}),
    };
  });

  const pullCurrentBranch = Effect.fn("ArcOperations.pullCurrentBranch")(function* (cwd: string) {
    const before = yield* context(cwd);
    if (!before.branch)
      return yield* new VcsRepositoryDetectionError({
        cwd,
        operation: "ArcOperations.pull",
        detail: "Updating requires an Arc branch.",
      });
    yield* cli.run({
      cwd: before.root,
      operation: "ArcOperations.pull",
      args: ["pull", "--ff-only"],
      timeoutMs: 300_000,
    });
    const after = yield* context(cwd);
    return {
      status: before.head === after.head ? "skipped_up_to_date" : "pulled",
      refName: after.branch ?? before.branch,
      upstreamRef: after.upstream,
    } satisfies VcsPullResult;
  });

  return ArcOperations.of({
    context,
    setUpstream: Effect.fn("ArcOperations.setUpstream")(function* (cwd, publishedBranch) {
      const branch = publishedBranch.replace(/^arcadia\//u, "");
      yield* validateRef(cwd, branch);
      const before = yield* context(cwd);
      if (
        !before.branch ||
        !/^users\/[^/]+\/.+/u.test(branch) ||
        (before.upstream !== null && before.upstream.replace(/^arcadia\//u, "") !== branch)
      )
        return yield* failure(
          cwd,
          "ArcOperations.upstreamIdentity",
          new Error("The checkout does not track the requested Arcanum source branch."),
        );
      if (before.upstream === null)
        yield* cli.run({
          cwd: before.root,
          operation: "ArcOperations.setUpstream",
          args: ["branch", "-u", `arcadia/${branch}`, before.branch],
        });
      const after = yield* context(cwd);
      if (
        after.branch !== before.branch ||
        after.head !== before.head ||
        after.upstream?.replace(/^arcadia\//u, "") !== branch
      )
        return yield* failure(
          cwd,
          "ArcOperations.upstreamReadback",
          new Error("The Arcanum source branch binding could not be verified."),
        );
    }),
    branchState: Effect.fn("ArcOperations.branchState")(function* (cwd, branch) {
      yield* validateRef(cwd, branch);
      const ctx = yield* context(cwd);
      const info = yield* cli.runJson(
        { cwd: ctx.root, operation: "ArcOperations.branchInfo", args: ["info", "--json"] },
        ArcInfo,
      );
      const branches = yield* cli.runJson(
        {
          cwd: ctx.root,
          operation: "ArcOperations.branchState",
          args: ["branch", "--json", "-v", "-a"],
        },
        ArcBranches,
      );
      const local = branches.find((candidate) => candidate.local && candidate.name === branch);
      const upstream = local?.remote ?? (ctx.branch === branch ? ctx.upstream : null);
      return {
        exists: local !== undefined,
        upstream,
        publishedBranch:
          upstream?.replace(/^arcadia\//u, "") ??
          (info.user_login ? `users/${info.user_login}/${branch}` : branch),
      };
    }),
    recentCommitSubjects: Effect.fn("ArcOperations.recentCommitSubjects")(function* (cwd) {
      const commits = yield* cli.runJson(
        {
          cwd,
          operation: "ArcOperations.recentCommitSubjects",
          args: ["log", "--json", "-n", "20", "--no-merges", "HEAD"],
        },
        ArcSubjects,
      );
      return commits.map((commit) => commit.message.split("\n")[0]!).filter(Boolean);
    }),
    changes: Effect.fn("ArcOperations.changes")(function* (cwd) {
      return yield* readChanges(yield* context(cwd));
    }),
    localStatus,
    listRefs,
    getReviewDiffPreview,
    getReviewDiffFileContents,
    createRef,
    switchRef,
    commit,
    pushCurrentBranch,
    pullCurrentBranch,
  });
});

export const layer = Layer.effect(ArcOperations, make);
