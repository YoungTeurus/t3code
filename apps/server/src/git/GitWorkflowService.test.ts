import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as VcsDriver from "../vcs/VcsDriver.ts";
import { VcsProcessOutputReadError } from "@t3tools/contracts";
import * as ArcCli from "../vcs/ArcCli.ts";
import * as ArcOperations from "../vcs/ArcOperations.ts";
import { makeArcNativeBackend } from "../vcs/ArcNativeBackend.ts";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";

import * as ServerConfig from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("GitWorkflowService", (it) => {
  it.effect("distinguishes an absent Arc worktree prefix from a failed revision query", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-arc-has-commit-" });
      const head = "a".repeat(40);
      const backend = yield* makeArcNativeBackend({
        list: () => Effect.die("No workspace lookup expected"),
        ensure: () => Effect.die("No workspace creation expected"),
        recordBranch: () => Effect.die("No branch mutation expected"),
        remove: () => Effect.die("No workspace removal expected"),
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            ServerConfig.layerTest(cwd, { prefix: "t3-arc-has-commit-state-" }),
            Layer.mock(ArcOperations.ArcOperations)({}),
            Layer.mock(ArcCli.ArcCli)({
              runJson: (input, schema) => {
                const revision = input.args.at(-1);
                if (revision === "unreadable")
                  return Effect.fail(
                    new VcsProcessOutputReadError({
                      cwd,
                      operation: "test.query",
                      command: "arc",
                      stream: "stdout",
                      cause: new Error("Query failed"),
                    }),
                  );
                return Schema.decodeUnknownEffect(schema)(
                  revision === "refs/heads/t3"
                    ? []
                    : [{ commit: revision === "malformed" ? "invalid" : head, message: "commit" }],
                ).pipe(Effect.orDie);
              },
            }),
          ),
        ),
      );
      const unexpectedCheckpoint = () => Effect.die("No checkpoint operation expected");
      const driver = yield* VcsDriver.VcsDriver.pipe(
        Effect.provide(
          Layer.mock(VcsDriver.VcsDriver)({
            backend,
            checkpoints: {
              captureCheckpoint: unexpectedCheckpoint,
              hasCheckpointRef: unexpectedCheckpoint,
              restoreCheckpoint: unexpectedCheckpoint,
              diffCheckpoints: unexpectedCheckpoint,
              listAuthoredPaths: unexpectedCheckpoint,
              deleteCheckpointRefs: unexpectedCheckpoint,
            },
          }),
        ),
      );
      const observedAt = yield* DateTime.now;
      const workflow = yield* GitWorkflowService.GitWorkflowService.pipe(
        Effect.provide(
          GitWorkflowService.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(GitManager.GitManager)({}),
                Layer.mock(GitVcsDriver.GitVcsDriver)({}),
                Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
                  resolve: () =>
                    Effect.succeed({
                      kind: "arc",
                      driver,
                      repository: {
                        kind: "arc",
                        rootPath: cwd,
                        metadataPath: `${cwd}/.arc`,
                        freshness: { source: "live-local", observedAt, expiresAt: Option.none() },
                      },
                    }),
                }),
              ),
            ),
          ),
        ),
      );
      assert.isTrue(yield* workflow.hasCommit({ cwd, refName: head }));
      assert.isFalse(yield* workflow.hasCommit({ cwd, refName: "refs/heads/t3" }));
      for (const refName of ["unreadable", "malformed"]) {
        const result = yield* workflow.hasCommit({ cwd, refName }).pipe(Effect.result);
        assert.equal(result._tag, "Failure");
      }
    }).pipe(Effect.scoped),
  );

  it.effect("finds a name among the refs of every namespace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ref-named-" });
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      for (const args of [
        ["init", "-b", "main"],
        ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
        ["update-ref", "refs/remotes/upstream/feature/topic", "HEAD"],
        ["symbolic-ref", "refs/remotes/origin/alias", "refs/heads/main"],
        ["update-ref", "refs/mirror/origin/mirrored", "HEAD"],
      ]) {
        yield* driver.execute({ operation: "test.setupRepo", cwd, args });
      }
      const found = yield* Effect.forEach(
        ["main", "feature/topic", "alias", "mirrored", "t3/renamed", "feature/*"],
        (refName) => workflow.hasRefNamed({ cwd, refName }),
      );
      assert.deepEqual(found, [true, true, true, true, false, false]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        GitWorkflowService.layer.pipe(
          Layer.provide(
            Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
              resolve: () => Effect.succeed({ kind: "git" } as VcsDriverRegistry.VcsDriverHandle),
            }),
          ),
          Layer.provide(Layer.mock(GitManager.GitManager)({})),
          Layer.provideMerge(GitVcsDriver.layer),
          Layer.provideMerge(VcsProcess.layer),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-ref-named-" }).pipe(
              Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
            ),
          ),
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
  );
});
