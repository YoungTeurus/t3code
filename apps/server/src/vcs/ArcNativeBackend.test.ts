import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ArcOperations from "./ArcOperations.ts";
import * as ArcCli from "./ArcCli.ts";
import * as ServerConfig from "../config.ts";
import { makeArcNativeBackend } from "./ArcNativeBackend.ts";

describe("Arc native workflow backend", () => {
  it.effect(
    "uses native divergence and keeps an absent revision distinct from a failed query",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-arc-native-" });
        const head = "a".repeat(40);
        const queries: ReadonlyArray<string>[] = [];
        let removed = false;
        const backend = yield* makeArcNativeBackend({
          list: () => Effect.succeed([]),
          ensure: (input) =>
            Effect.sync(() => {
              assert.equal(input.baseRevision, head);
              return {
                root,
                cwd: `${root}/service`,
                branch: input.branch,
                head,
                name: input.taskKey,
                leaseOwner: "owner",
                action: "CREATED" as const,
                isOnRequiredHead: true,
              };
            }),
          recordBranch: () => Effect.void,
          remove: (input) =>
            Effect.sync(() => {
              assert.equal(input.explicit, true);
              removed = true;
            }),
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              ServerConfig.ServerConfig.layerTest(root, { prefix: "t3-arc-native-state-" }),
              Layer.mock(ArcOperations.ArcOperations)({
                context: (cwd) =>
                  Effect.succeed({
                    root,
                    cwd,
                    scope: "service",
                    repository: "arcadia",
                    head,
                    branch: "task",
                    upstream: "users/test/task",
                    identity: root,
                  }),
              }),
              Layer.mock(ArcCli.ArcCli)({
                run: () => Effect.die("native JSON query expected"),
                runJson: (input, schema) => {
                  queries.push(input.args);
                  const range = input.args.at(-1)!;
                  const value =
                    range === "trunk"
                      ? [{ commit: "d".repeat(40), message: "older base" }]
                      : range === "HEAD..users/test/task"
                        ? [{ commit: "b".repeat(40), message: "upstream" }]
                        : range === "users/test/task..HEAD"
                          ? [
                              { commit: head, message: "local" },
                              { commit: "c".repeat(40), message: "earlier" },
                            ]
                          : range === "arcadia/trunk..HEAD"
                            ? [{ commit: head, message: "local" }]
                            : range === "missing"
                              ? []
                              : [{ commit: head, message: "local" }];
                  return Schema.decodeUnknownEffect(schema)(value).pipe(Effect.orDie);
                },
              }),
            ),
          ),
        );
        const remote = yield* backend.statusDetailsRemote!(root, { refreshUpstream: false });
        assert.equal(
          (yield* backend.removeWorktree!({ cwd: root, path: `${root}/other` }).pipe(Effect.result))
            ._tag,
          "Failure",
        );
        assert.equal(removed, false);
        yield* backend.removeWorktree!({ cwd: root, path: `${root}/other`, explicit: true });
        assert.equal(removed, true);
        assert.equal(remote.aheadCount, 2);
        assert.equal(remote.behindCount, 1);
        assert.equal(remote.aheadOfDefaultCount, 1);
        assert.equal(
          (yield* backend.resolveCommit!({ cwd: root, revision: "HEAD" })).commitSha,
          head,
        );
        assert.equal(
          (yield* backend.resolveCommit!({ cwd: root, revision: "missing" }).pipe(Effect.result))
            ._tag,
          "Failure",
        );
        const workspace = yield* backend.createWorktree!({
          cwd: root,
          refName: head,
          baseRefName: "trunk",
          newRefName: "task-2",
          path: null,
        });
        assert.equal(workspace.worktree.refName, "task-2");
        assert.isTrue(queries.every((args) => args[0] === "log" && args.includes("--json")));
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
