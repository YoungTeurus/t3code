import * as Effect from "effect/Effect";
import { GitCommandError } from "@t3tools/contracts";

import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";

type Backend = GitVcsDriver.GitVcsDriver["Service"];
const checkoutMutations = new Set<keyof Backend>([
  "commit",
  "pushCurrentBranch",
  "pullCurrentBranch",
  "createWorktree",
  "fetchRefIntoBranch",
  "refreshCheckedOutBranch",
  "fetchRemote",
  "fetchRemoteBranch",
  "fetchRemoteTrackingBranch",
  "setBranchUpstream",
  "createBranch",
  "writeConfigValue",
  "removeWorktree",
  "pruneWorktrees",
  "deleteLocalBranch",
  "renameBranch",
  "createRef",
  "switchRef",
  "initRepo",
]);

export const makeVcsBackend = Effect.gen(function* () {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;

  const route = <K extends keyof Backend>(method: K): Backend[K] => {
    const routed = Effect.fn(`VcsBackend.${method}`)(function* (...args: Parameters<Backend[K]>) {
      const first = args[0];
      const cwd = typeof first === "string" ? first : first.cwd;
      const handle = yield* registry.resolve({ cwd }).pipe(
        Effect.catchIf(
          (cause) => cause._tag === "VcsUnsupportedOperationError" && cause.kind === "unknown",
          () => Effect.succeed(null),
        ),
        Effect.mapError(
          (cause) =>
            new GitCommandError({
              cwd,
              operation: `VcsBackend.${method}`,
              command: "vcs-route",
              detail: "Could not resolve the repository backend.",
              cause,
            }),
        ),
      );
      const implementation =
        handle === null || handle.kind === "git" ? git[method] : handle.driver.backend?.[method];
      if (!implementation)
        return yield* new GitCommandError({
          cwd,
          operation: `VcsBackend.${method}`,
          command: handle?.kind ?? "git",
          detail: `The ${handle?.kind ?? "git"} backend does not support ${method}.`,
        });
      // Each key keeps its original argument/result pair across the heterogeneous method table.
      const call = implementation as (
        ...input: Parameters<Backend[K]>
      ) => Effect.Effect<unknown, GitCommandError>;
      const operation = call(...args);
      return yield* handle?.kind === "arc" && checkoutMutations.has(method)
        ? withWorkspaceLease(`arc:${handle.repository.rootPath}`, operation)
        : operation;
    });
    return routed as Backend[K];
  };

  return {
    execute: route("execute"),
    status: route("status"),
    statusDetails: route("statusDetails"),
    statusDetailsLocal: route("statusDetailsLocal"),
    statusDetailsRemote: route("statusDetailsRemote"),
    prepareCommitContext: route("prepareCommitContext"),
    commit: route("commit"),
    pushCurrentBranch: route("pushCurrentBranch"),
    readRangeContext: route("readRangeContext"),
    getReviewDiffPreview: route("getReviewDiffPreview"),
    getReviewDiffFileContents: route("getReviewDiffFileContents"),
    readConfigValue: route("readConfigValue"),
    readBranchBase: route("readBranchBase"),
    resolveBranchName: route("resolveBranchName"),
    listRefs: route("listRefs"),
    pullCurrentBranch: route("pullCurrentBranch"),
    createWorktree: route("createWorktree"),
    fetchRefIntoBranch: route("fetchRefIntoBranch"),
    fetchRefCommit: route("fetchRefCommit"),
    resolveCommit: route("resolveCommit"),
    refreshCheckedOutBranch: route("refreshCheckedOutBranch"),
    ensureRemote: route("ensureRemote"),
    resolvePrimaryRemoteName: route("resolvePrimaryRemoteName"),
    resolveDefaultBranchName: route("resolveDefaultBranchName"),
    fetchRemote: route("fetchRemote"),
    remoteExists: route("remoteExists"),
    remoteBranchExists: route("remoteBranchExists"),
    resolveRemoteTrackingCommit: route("resolveRemoteTrackingCommit"),
    resolveWorktreeBaseRemote: route("resolveWorktreeBaseRemote"),
    fetchWorktreeBaseCommit: route("fetchWorktreeBaseCommit"),
    fetchRemoteBranch: route("fetchRemoteBranch"),
    fetchRemoteTrackingBranch: route("fetchRemoteTrackingBranch"),
    setBranchUpstream: route("setBranchUpstream"),
    createBranch: route("createBranch"),
    writeConfigValue: route("writeConfigValue"),
    removeWorktree: route("removeWorktree"),
    pruneWorktrees: route("pruneWorktrees"),
    listWorktreePaths: route("listWorktreePaths"),
    deleteLocalBranch: route("deleteLocalBranch"),
    renameBranch: route("renameBranch"),
    createRef: route("createRef"),
    switchRef: route("switchRef"),
    initRepo: route("initRepo"),
    listLocalBranchNames: route("listLocalBranchNames"),
  } satisfies Backend;
});
