import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as Effect from "effect/Effect";
import { GitCommandError } from "@t3tools/contracts";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as SecretResolverLayer from "../secrets/SecretResolver.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makeVcsBackend } from "../vcs/VcsBackend.ts";
import * as ServerConfig from "../config.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { resolveSourceControlHostSecrets } from "./sourceControlHostSecrets.ts";

const decodeArcCommits = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        commit: Schema.NonEmptyString,
        message: Schema.String,
        date: Schema.NonEmptyString,
      }),
    ),
  ),
);

export const makeReviewRangeReader = Effect.gen(function* () {
  const process = yield* VcsProcess.VcsProcess;
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
  return Effect.fn("SourceControlHost.review.rangeCommits")(function* (
    input: Parameters<SourceControlHost.SourceControlHost["Service"]["review"]["rangeCommits"]>[0],
  ) {
    if (!/^[a-f0-9]{40,64}$/i.test(input.base) || !/^[a-f0-9]{40,64}$/i.test(input.head))
      return yield* new GitCommandError({
        cwd: input.cwd,
        command: "vcs-route",
        operation: "rangeCommits",
        detail: "A review range must name two commit hashes.",
      });
    const handle = yield* vcsRegistry.resolve({ cwd: input.cwd });
    const limit = Math.max(1, input.limit);
    const output = yield* process.run({
      cwd: handle.repository.rootPath,
      operation: "SourceControlHost.review.rangeCommits",
      command: handle.kind === "arc" ? "arc" : "git",
      args:
        handle.kind === "arc"
          ? ["log", "--json", "-n", String(limit + 1), `${input.base}..${input.head}`]
          : [
              "log",
              "--format=%H%x00%cI%x00%s",
              "-n",
              String(limit + 1),
              `${input.base}..${input.head}`,
            ],
      maxOutputBytes: 4 * 1024 * 1024,
    });
    const commits =
      handle.kind === "arc"
        ? (yield* decodeArcCommits(output.stdout).pipe(
            Effect.mapError(
              (cause) =>
                new GitCommandError({
                  cwd: input.cwd,
                  command: "arc",
                  operation: "rangeCommits",
                  detail: "Arc returned an unreadable commit range.",
                  cause,
                }),
            ),
          )).map((commit) => ({
            sha: commit.commit,
            subject: commit.message.split("\n")[0] ?? "",
            committedAt: commit.date,
          }))
        : output.stdout
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => {
              const [sha = "", committedAt = "", subject = ""] = line.split("\0");
              return { sha, subject, committedAt };
            });
    return { commits: commits.slice(0, limit), truncated: commits.length > limit };
  });
});

export const layer = Layer.effect(
  SourceControlHost.SourceControlHost,
  Effect.gen(function* () {
    const rangeCommits = yield* makeReviewRangeReader;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const process = yield* VcsProcess.VcsProcess;
    const git = yield* makeVcsBackend;
    const config = yield* ServerConfig.ServerConfig;
    const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
    const secrets = yield* SecretResolver.SecretResolver;
    return SourceControlHost.SourceControlHost.of({
      stateDirectory: config.stateDir,
      settings: {
        get: serverSettings.getSettings,
        getWithSecrets: (kind) =>
          serverSettings.getSettings.pipe(
            Effect.flatMap((settings) =>
              resolveSourceControlHostSecrets(secrets, settings.sourceControlHosts, kind).pipe(
                Effect.map((sourceControlHosts) =>
                  sourceControlHosts === settings.sourceControlHosts
                    ? settings
                    : { ...settings, sourceControlHosts },
                ),
              ),
            ),
          ),
        update: serverSettings.updateSettings,
      },
      process: { run: process.run },
      review: {
        commitDiff: (input) =>
          git
            .getReviewDiffPreview({
              cwd: input.cwd,
              commitSha: input.commit,
              ...(input.file === undefined
                ? {}
                : { file: { ...input.file, sourceKind: "commit" as const } }),
            })
            .pipe(
              Effect.flatMap((preview) => {
                const source = preview.sources[0];
                return source === undefined || source.baseRef === null
                  ? Effect.fail(
                      new GitCommandError({
                        operation: "SourceControlHost.review.commitDiff",
                        command: "vcs-route",
                        cwd: input.cwd,
                        detail: "The commit has no parent to compare against.",
                      }),
                    )
                  : Effect.succeed({
                      parent: source.baseRef,
                      patch: source.diff,
                      truncated: source.truncated,
                      ...(source.files === undefined ? {} : { files: source.files }),
                    });
              }),
            ),
        rangeCommits,
        commitFileContents: (input) =>
          git.getReviewDiffFileContents({
            cwd: input.cwd,
            sourceKind: "commit",
            changeType: input.changeType,
            baseRef: input.parent,
            headRef: input.commit,
            oldPath: input.oldPath,
            newPath: input.newPath,
          }),
      },
      git: {
        execute: git.execute,
        resolveCommit: git.resolveCommit,
        remotes: (cwd) =>
          vcsRegistry.resolve({ cwd }).pipe(Effect.map((handle) => handle.driver.listRemotes(cwd))),
        readConfigValue: git.readConfigValue,
        resolvePrimaryRemoteName: git.resolvePrimaryRemoteName,
        ensureRemote: git.ensureRemote,
        listLocalBranchNames: git.listLocalBranchNames,
        fetchRemoteBranch: git.fetchRemoteBranch,
        fetchRemoteTrackingBranch: git.fetchRemoteTrackingBranch,
        setBranchUpstream: git.setBranchUpstream,
        createBranch: git.createBranch,
        writeConfigValue: git.writeConfigValue,
        switchRef: git.switchRef,
      },
    });
  }),
).pipe(Layer.provide(SecretResolverLayer.layer));
