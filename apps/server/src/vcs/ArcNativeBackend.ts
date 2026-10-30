import * as NodeBuffer from "node:buffer";

import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { GitCommandError, type VcsError } from "@t3tools/contracts";

import * as ArcCli from "./ArcCli.ts";
import * as ArcOperations from "./ArcOperations.ts";
import type * as GitVcsDriver from "./GitVcsDriver.ts";
import type { WorkspaceProvider } from "../workspace/WorkspaceProvider.ts";
import * as ServerConfig from "../config.ts";

type Backend = GitVcsDriver.GitVcsDriver["Service"];
const Commits = Schema.Array(
  Schema.Struct({ commit: Schema.NonEmptyString, message: Schema.String }),
);
const Base = Schema.Struct({ branch: Schema.String, base: Schema.String });
const decodeBase = Schema.decodeEffect(Schema.fromJsonString(Base));
const encodeBase = Schema.encodeEffect(Schema.fromJsonString(Base));

export const makeArcNativeBackend = Effect.fn("ArcNativeBackend.make")(function* (
  workspace: WorkspaceProvider,
) {
  const ops = yield* ArcOperations.ArcOperations;
  const cli = yield* ArcCli.ArcCli;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const error = (cwd: string, operation: string, cause?: unknown) =>
    new GitCommandError({
      cwd,
      operation: `ArcNativeBackend.${operation}`,
      command: "arc",
      detail: "The native Arc operation could not be completed.",
      ...(cause === undefined ? {} : { cause }),
    });
  const io = <A, E, R>(cwd: string, operation: string, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError((cause) => error(cwd, operation, cause)));
  const native = <A>(cwd: string, operation: string, effect: Effect.Effect<A, VcsError>) =>
    io(cwd, operation, effect);
  const validate = (cwd: string, ref: string) =>
    ref && !ref.startsWith("-") && !/[\0\r\n]/.test(ref)
      ? Effect.void
      : Effect.fail(error(cwd, "revision"));
  const log = Effect.fn("ArcNativeBackend.log")(function* (
    cwd: string,
    revision: string,
    noWalk = false,
  ) {
    yield* validate(cwd, revision);
    return yield* native(
      cwd,
      "log",
      cli.runJson(
        {
          cwd,
          operation: "ArcNativeBackend.log",
          args: ["log", "--json", ...(noWalk ? ["--no-walk"] : []), revision],
          maxOutputBytes: 4 * 1024 * 1024,
        },
        Commits,
      ),
    );
  });
  const resolveCommit: Backend["resolveCommit"] = Effect.fn("ArcNativeBackend.resolveCommit")(
    function* (input) {
      const commits = yield* log(input.cwd, input.revision, true);
      if (commits.length !== 1 || !/^[0-9a-f]{40,64}$/i.test(commits[0]!.commit))
        return yield* error(input.cwd, "resolveCommit");
      return { commitSha: commits[0]!.commit };
    },
  );
  const statusDetailsRemote: Backend["statusDetailsRemote"] = Effect.fn(
    "ArcNativeBackend.statusDetailsRemote",
  )(function* (cwd, options) {
    const ctx = yield* native(cwd, "context", ops.context(cwd));
    if (ctx.upstream && options?.refreshUpstream !== false) {
      yield* native(
        cwd,
        "fetchUpstream",
        cli.run({
          cwd: ctx.root,
          operation: "ArcNativeBackend.fetchUpstream",
          args: ["fetch", ctx.upstream.replace(/^arcadia\//, "")],
          timeoutMs: 60_000,
        }),
      );
    }
    const [ahead, behind, defaultAhead] = yield* Effect.all(
      [
        ctx.upstream ? log(ctx.root, `${ctx.upstream}..HEAD`) : Effect.succeed([]),
        ctx.upstream ? log(ctx.root, `HEAD..${ctx.upstream}`) : Effect.succeed([]),
        ctx.branch === "trunk" ? Effect.succeed([]) : log(ctx.root, "arcadia/trunk..HEAD"),
      ],
      { concurrency: 3 },
    );
    const after = yield* native(cwd, "context", ops.context(cwd));
    if (after.branch !== ctx.branch || after.head !== ctx.head || after.upstream !== ctx.upstream)
      return yield* error(cwd, "statusChanged");
    return {
      isRepo: true,
      defaultBranch: "trunk",
      isDefaultBranch: ctx.branch === "trunk",
      branch: ctx.branch,
      upstreamRef: ctx.upstream,
      hasUpstream: ctx.upstream !== null,
      aheadCount: ahead.length,
      behindCount: behind.length,
      aheadOfDefaultCount: defaultAhead.length,
    };
  });
  const statusDetailsLocal: Backend["statusDetailsLocal"] = Effect.fn(
    "ArcNativeBackend.statusDetailsLocal",
  )(function* (cwd, options) {
    const ctx = yield* native(cwd, "context", ops.context(cwd));
    const local = yield* native(cwd, "localStatus", ops.localStatus({ cwd }));
    const remote =
      options?.includeDivergence === false
        ? {
            hasUpstream: ctx.upstream !== null,
            aheadCount: 0,
            behindCount: 0,
            aheadOfDefaultCount: 0,
          }
        : yield* statusDetailsRemote(cwd);
    return {
      isRepo: local.isRepo,
      vcsKind: "arc",
      hasOriginRemote: local.hasPrimaryRemote,
      isDefaultBranch: local.isDefaultRef,
      branch: local.refName,
      upstreamRef: ctx.upstream,
      hasWorkingTreeChanges: local.hasWorkingTreeChanges,
      workingTree: local.workingTree,
      ...remote,
    };
  });
  const status: Backend["status"] = Effect.fn("ArcNativeBackend.status")(function* (input) {
    const local = yield* native(input.cwd, "localStatus", ops.localStatus(input));
    const remote = yield* statusDetailsRemote(input.cwd);
    return {
      ...local,
      hasUpstream: remote.hasUpstream,
      aheadCount: remote.aheadCount,
      behindCount: remote.behindCount,
      aheadOfDefaultCount: remote.aheadOfDefaultCount,
      upstreamRef: remote.upstreamRef,
      pr: null,
    };
  });
  const metadataPath = Effect.fn("ArcNativeBackend.metadataPath")(function* (
    cwd: string,
    branch: string,
  ) {
    const ctx = yield* native(cwd, "context", ops.context(cwd));
    const hash = yield* io(
      cwd,
      "metadataHash",
      crypto.digest("SHA-256", NodeBuffer.Buffer.from(`${ctx.root}\0${branch}`)),
    );
    return path.join(
      config.stateDir,
      "arc-branch-bases",
      `${NodeBuffer.Buffer.from(hash).toString("hex")}.json`,
    );
  });
  const readBranchBase: Backend["readBranchBase"] = Effect.fn("ArcNativeBackend.readBranchBase")(
    function* (cwd, branch) {
      const file = yield* metadataPath(cwd, branch);
      if (!(yield* io(cwd, "baseExists", fs.exists(file)))) return null;
      const value = yield* io(
        cwd,
        "readBase",
        fs.readFileString(file).pipe(Effect.flatMap(decodeBase)),
      );
      if (value.branch !== branch) return yield* error(cwd, "baseIdentity");
      return value.base;
    },
  );
  const saveBase = Effect.fn("ArcNativeBackend.saveBase")(function* (
    cwd: string,
    branch: string,
    base: string,
  ) {
    const file = yield* metadataPath(cwd, branch);
    yield* io(
      cwd,
      "baseDirectory",
      fs.makeDirectory(path.dirname(file), { recursive: true, mode: 0o700 }),
    );
    const temp = `${file}.${yield* io(cwd, "uuid", crypto.randomUUIDv4())}.tmp`;
    const text = yield* io(cwd, "encodeBase", encodeBase({ branch, base }));
    yield* io(cwd, "writeBase", fs.writeFileString(temp, text, { flag: "wx", mode: 0o600 }));
    yield* io(cwd, "publishBase", fs.rename(temp, file)).pipe(
      Effect.ensuring(fs.remove(temp, { force: true }).pipe(Effect.ignore)),
    );
  });
  const listRefs: Backend["listRefs"] = Effect.fn("ArcNativeBackend.listRefs")(function* (input) {
    const ctx = yield* native(input.cwd, "context", ops.context(input.cwd));
    const refs = yield* native(input.cwd, "listRefs", ops.listRefs(input));
    const entries = yield* native(input.cwd, "workspaces", workspace.list(input.cwd));
    return {
      ...refs,
      refs: refs.refs.map((ref) => ({
        ...ref,
        worktreePath: ref.current
          ? ctx.cwd
          : entries.find((entry) => entry.branch === ref.name)
            ? path.join(entries.find((entry) => entry.branch === ref.name)!.root, ctx.scope)
            : null,
      })),
    };
  });
  const prepareCommitContext: Backend["prepareCommitContext"] = Effect.fn(
    "ArcNativeBackend.prepareCommitContext",
  )(function* (cwd, selected, options) {
    const changes = yield* native(cwd, "changes", ops.changes(cwd));
    const files = changes.filter(
      (change) => selected === undefined || selected.includes(change.path),
    );
    if (files.length === 0) return null;
    let patch = "";
    if (options?.includePatch !== false) {
      for (const change of files) {
        const preview = yield* native(
          cwd,
          "commitDiff",
          ops.getReviewDiffPreview({
            cwd,
            file: {
              path: change.path,
              previousPath: change.originalPath ?? null,
              sourceKind: "working-tree",
            },
          }),
        );
        patch += preview.sources.map((source) => source.diff).join("\n");
      }
    }
    return {
      stagedSummary: files
        .map((change) => `${change.index ?? change.worktree}\t${change.path}`)
        .join("\n"),
      stagedPatch: patch,
    };
  });
  const createBranch: Backend["createBranch"] = Effect.fn("ArcNativeBackend.createBranch")(
    function* (input) {
      yield* validate(input.cwd, input.branch);
      const start = yield* resolveCommit({ cwd: input.cwd, revision: input.startPoint });
      yield* native(
        input.cwd,
        "createBranch",
        cli.run({
          cwd: input.cwd,
          operation: "ArcNativeBackend.createBranch",
          args: ["branch", input.branch, start.commitSha],
        }),
      );
      yield* saveBase(input.cwd, input.branch, input.startPoint);
    },
  );
  const createRef: Backend["createRef"] = Effect.fn("ArcNativeBackend.createRef")(
    function* (input) {
      const before = yield* native(input.cwd, "context", ops.context(input.cwd));
      const result = yield* native(input.cwd, "createRef", ops.createRef(input));
      yield* saveBase(input.cwd, result.refName, before.branch ?? before.head);
      return result;
    },
  );
  const renameBranch: Backend["renameBranch"] = Effect.fn("ArcNativeBackend.renameBranch")(
    function* (input) {
      yield* validate(input.cwd, input.oldBranch);
      yield* validate(input.cwd, input.newBranch);
      const base = yield* readBranchBase(input.cwd, input.oldBranch);
      yield* native(
        input.cwd,
        "renameBranch",
        cli.run({
          cwd: input.cwd,
          operation: "ArcNativeBackend.renameBranch",
          args: ["branch", "-m", input.oldBranch, input.newBranch],
        }),
      );
      if (base !== null) yield* saveBase(input.cwd, input.newBranch, base);
      yield* native(input.cwd, "recordBranch", workspace.recordBranch(input.cwd, input.newBranch));
      return { branch: input.newBranch };
    },
  );
  const createWorktree: Backend["createWorktree"] = Effect.fn("ArcNativeBackend.createWorktree")(
    function* (input) {
      const baseRef = input.baseRefName ?? input.refName;
      const branch = input.newRefName ?? input.refName;
      const base = yield* resolveCommit({ cwd: input.cwd, revision: input.refName });
      const result = yield* native(
        input.cwd,
        "createWorkspace",
        workspace.ensure({
          cwd: input.cwd,
          taskKey: branch,
          branch,
          baseRevision: base.commitSha,
          ...(input.path ? { path: input.path } : {}),
        }),
      );
      yield* saveBase(result.cwd, result.branch, baseRef);
      return { worktree: { path: result.cwd, refName: result.branch } };
    },
  );
  const readRangeContext: Backend["readRangeContext"] = Effect.fn(
    "ArcNativeBackend.readRangeContext",
  )(function* (cwd, baseRef) {
    const commits = yield* log(cwd, `${baseRef}..HEAD`);
    const preview = yield* native(cwd, "rangeDiff", ops.getReviewDiffPreview({ cwd, baseRef }));
    return {
      commitSummary: commits
        .map((commit) => `${commit.commit} ${commit.message.split("\n")[0]}`)
        .join("\n"),
      diffSummary: "",
      diffPatch: preview.sources
        .filter((source) => source.kind === "branch-range")
        .map((source) => source.diff)
        .join("\n"),
    };
  });
  const resolveBranchName: Backend["resolveBranchName"] = Effect.fn(
    "ArcNativeBackend.resolveBranchName",
  )(function* (cwd, refName) {
    const refs = yield* native(
      cwd,
      "resolveBranchName",
      ops.listRefs({ cwd, refKind: "local", query: refName, limit: 100 }),
    );
    return refs.refs.find((ref) => ref.name === refName)?.name ?? null;
  });
  const fetchRemote: Backend["fetchRemote"] = Effect.fn("ArcNativeBackend.fetchRemote")(
    function* (input) {
      if (input.remoteName !== "arcadia") return yield* error(input.cwd, "remoteIdentity");
      if (input.refName) yield* validate(input.cwd, input.refName);
      yield* native(
        input.cwd,
        "fetchRemote",
        cli.run({
          cwd: input.cwd,
          operation: "ArcNativeBackend.fetchRemote",
          args: ["fetch", ...(input.refName ? [input.refName.replace(/^arcadia\//, "")] : [])],
          timeoutMs: 60_000,
        }),
      );
    },
  );
  const resolveRemoteTrackingCommit: Backend["resolveRemoteTrackingCommit"] = Effect.fn(
    "ArcNativeBackend.resolveRemoteTrackingCommit",
  )(function* (input) {
    if (input.fallbackRemoteName !== "arcadia") return yield* error(input.cwd, "remoteIdentity");
    const remoteRefName = input.refName === "trunk" ? "arcadia/trunk" : input.refName;
    return {
      ...(yield* resolveCommit({ cwd: input.cwd, revision: remoteRefName })),
      remoteRefName,
    };
  });
  const remoteBranchExists: Backend["remoteBranchExists"] = Effect.fn(
    "ArcNativeBackend.remoteBranchExists",
  )(function* (input) {
    if (input.remoteName !== "arcadia") return false;
    let cursor: number | undefined;
    do {
      const page = yield* native(
        input.cwd,
        "remoteBranchExists",
        ops.listRefs({ cwd: input.cwd, refKind: "remote", query: input.refName, cursor }),
      );
      if (
        page.refs.some(
          (ref) => ref.name === input.refName || ref.name === `arcadia/${input.refName}`,
        )
      )
        return true;
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return false;
  });
  return {
    status,
    statusDetails: statusDetailsLocal,
    statusDetailsLocal,
    statusDetailsRemote,
    listRefs,
    resolveCommit,
    resolveBranchName,
    readBranchBase,
    createBranch,
    createRef,
    renameBranch,
    createWorktree,
    removeWorktree: Effect.fn("ArcNativeBackend.removeWorktree")(function* (input) {
      if (input.explicit !== true)
        return yield* error(
          input.cwd,
          "removeWorkspace",
          "Arc workspace removal requires an explicit request; automatic cleanup keeps it registered.",
        );
      yield* native(
        input.cwd,
        "removeWorkspace",
        workspace.remove({
          cwd: input.cwd,
          path: input.path,
          explicit: true,
          ...(input.force === undefined ? {} : { force: input.force }),
        }),
      );
    }),
    readRangeContext,
    prepareCommitContext,
    switchRef: (input) => native(input.cwd, "switchRef", ops.switchRef(input)),
    commit: (cwd, subject, body, options) =>
      native(cwd, "commit", ops.commit(cwd, subject, body, options?.stage)),
    pushCurrentBranch: (cwd) => native(cwd, "push", ops.pushCurrentBranch(cwd)),
    pullCurrentBranch: (cwd) => native(cwd, "pull", ops.pullCurrentBranch(cwd)),
    getReviewDiffPreview: (input) => native(input.cwd, "diff", ops.getReviewDiffPreview(input)),
    getReviewDiffFileContents: (input) =>
      native(input.cwd, "fileContents", ops.getReviewDiffFileContents(input)),
    listLocalBranchNames: (cwd) =>
      native(cwd, "branches", ops.listRefs({ cwd, refKind: "local", limit: 10_000 })).pipe(
        Effect.map((value) => value.refs.map((ref) => ref.name)),
      ),
    listWorktreePaths: (cwd) =>
      native(cwd, "workspaces", workspace.list(cwd)).pipe(
        Effect.map((entries) => entries.map((entry) => entry.root)),
      ),
    resolvePrimaryRemoteName: () => Effect.succeed("arcadia"),
    resolveDefaultBranchName: () => Effect.succeed("trunk"),
    remoteExists: (input) => Effect.succeed(input.remoteName === "arcadia"),
    remoteBranchExists,
    fetchRemote,
    resolveRemoteTrackingCommit,
    setBranchUpstream: Effect.fn("ArcNativeBackend.setBranchUpstream")(function* (input) {
      const ctx = yield* native(input.cwd, "upstreamContext", ops.context(input.cwd));
      if (input.remoteName !== "arcadia" || ctx.branch !== input.branch)
        return yield* error(input.cwd, "upstreamIdentity");
      yield* native(input.cwd, "setUpstream", ops.setUpstream(input.cwd, input.remoteBranch));
    }),
    resolveWorktreeBaseRemote: (input) =>
      Effect.succeed({
        remoteName: "arcadia",
        branchName: input.refName.replace(/^arcadia\//, ""),
      }),
    fetchWorktreeBaseCommit: Effect.fn("ArcNativeBackend.fetchWorktreeBaseCommit")(
      function* (input) {
        yield* fetchRemote({ cwd: input.cwd, remoteName: "arcadia", refName: input.refName });
        return yield* resolveRemoteTrackingCommit({ ...input, fallbackRemoteName: "arcadia" });
      },
    ),
    fetchRemoteTrackingBranch: (input) =>
      fetchRemote({ cwd: input.cwd, remoteName: input.remoteName, refName: input.remoteBranch }),
    deleteLocalBranch: Effect.fn("ArcNativeBackend.deleteLocalBranch")(function* (input) {
      yield* validate(input.cwd, input.refName);
      yield* native(
        input.cwd,
        "deleteLocalBranch",
        cli.run({
          cwd: input.cwd,
          operation: "ArcNativeBackend.deleteLocalBranch",
          args: ["branch", input.force ? "-D" : "-d", input.refName],
        }),
      );
      if ((yield* resolveBranchName(input.cwd, input.refName)) !== null)
        return yield* error(input.cwd, "deleteBranchReadback");
    }),
  } satisfies Partial<Backend>;
});
