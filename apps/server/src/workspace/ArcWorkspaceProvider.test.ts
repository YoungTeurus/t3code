import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";
import {
  VcsProcessExitError,
  VcsProcessTimeoutError,
  VcsRepositoryDetectionError,
} from "@t3tools/contracts";

import { makeArcWorkspaces, parseArcWorktrees } from "./ArcWorkspaceProvider.ts";
import * as ArcOperations from "../vcs/ArcOperations.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ServerConfig from "../config.ts";

describe("Arc workspaces", () => {
  it("parses lease and stored branch without treating duplicate name as a new entry", () => {
    assert.deepEqual(
      parseArcWorktrees(
        "worktree /work/task\nname TASK-1\nbranch old-name\nHEAD abc\nname TASK-1\nlease-owner owner-1\nunmounted\nhere\ntrunk\n\n",
      ),
      [
        {
          root: "/work/task",
          name: "TASK-1",
          branch: "old-name",
          head: "abc",
          leaseOwner: "owner-1",
          base: null,
        },
      ],
    );
  });

  it.effect("reuses task identity after a branch rename and rejects another owner's lease", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs
        .makeTempDirectoryScoped({ prefix: "t3-arc-workspace-" })
        .pipe(Effect.flatMap(fs.realPath));
      const source = path.join(directory, "source");
      const workspace = path.join(directory, "task");
      yield* fs.makeDirectory(path.join(source, "service"), { recursive: true });
      yield* fs.makeDirectory(path.join(workspace, "service"), { recursive: true });
      yield* fs.makeDirectory(path.join(workspace, ".arc"));
      yield* fs.writeFileString(path.join(workspace, ".arc", "HEAD"), "fixture");
      let registered = false;
      let leaseOwner: string | null = null;
      let actualBranch = "task-1";
      let mounted = true;
      let remounts = 0;
      const processLayer = Layer.mock(VcsProcess.VcsProcess)({
        run: (input) =>
          Effect.gen(function* () {
            assert.equal(input.command, "ya");
            const command = input.args[2];
            if (command === "remount") {
              assert.equal(input.args[input.args.indexOf("--lease-owner") + 1], leaseOwner);
              remounts++;
              mounted = true;
              yield* fs
                .writeFileString(path.join(workspace, ".arc", "HEAD"), "fixture")
                .pipe(Effect.orDie);
            }
            if (command === "add") {
              registered = true;
              leaseOwner = input.args[input.args.indexOf("--lease-owner") + 1]!;
              return yield* new VcsProcessTimeoutError({
                cwd: input.cwd,
                operation: input.operation,
                command: "ya",
                timeoutMs: 300_000,
              });
            }
            if (command === "lease") {
              const owner = input.args[input.args.indexOf("--owner") + 1]!;
              if (leaseOwner !== null && leaseOwner !== owner)
                return yield* new VcsProcessExitError({
                  cwd: input.cwd,
                  operation: input.operation,
                  command: "ya",
                  exitCode: 1,
                  detail: "Lease is held.",
                });
              leaseOwner = owner;
            }
            if (command === "remove") {
              assert.equal(input.args[input.args.indexOf("--lease-owner") + 1], leaseOwner);
              assert.equal(
                input.args[input.args.indexOf("--lease-renewed") + 1],
                "2026-10-30T00:00:00Z",
              );
              assert.isFalse(input.args.includes("--force"));
              registered = false;
            }
            const stdout =
              command === "list" && registered
                ? `worktree ${workspace}\nname TASK-1\nbranch task-1\nHEAD ${"a".repeat(40)}\nlease-owner ${leaseOwner}\nlease-renewed 2026-10-30T00:00:00Z\n\n`
                : "";
            return {
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdout,
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            };
          }),
      });
      const opsLayer = Layer.mock(ArcOperations.ArcOperations)({
        context: (cwd) =>
          cwd.startsWith(workspace) && !mounted
            ? Effect.fail(
                new VcsRepositoryDetectionError({
                  cwd,
                  operation: "fixtureUnmounted",
                  detail: "Unmounted fixture",
                }),
              )
            : Effect.succeed({
                root: cwd.startsWith(workspace) ? workspace : source,
                cwd,
                scope: "service",
                repository: "arcadia",
                head: "a".repeat(40),
                branch: cwd.startsWith(workspace) ? actualBranch : "trunk",
                upstream: null,
                identity: cwd.startsWith(workspace) ? "task" : "source",
              }),
      });
      yield* Effect.gen(function* () {
        const provider = yield* makeArcWorkspaces();
        const input = {
          cwd: path.join(source, "service"),
          taskKey: "TASK-1",
          branch: "task-1",
          baseRevision: "a".repeat(40),
        };
        const first = yield* provider.ensure(input);
        assert.equal(first.action, "CREATED");
        assert.equal(first.cwd, path.join(workspace, "service"));
        actualBranch = "renamed-task";
        yield* provider.recordBranch(path.join(workspace, "service"), actualBranch);
        const reopened = yield* provider.ensure(input);
        assert.equal(reopened.action, "REUSED");
        assert.equal(reopened.branch, "renamed-task");
        assert.equal(reopened.root, first.root);
        mounted = false;
        yield* fs.remove(path.join(workspace, ".arc", "HEAD"));
        const restarted = yield* makeArcWorkspaces();
        const remounted = yield* restarted.ensure({
          ...input,
          taskKey: "renamed-task",
          branch: "renamed-task",
        });
        assert.equal(remounted.root, first.root);
        assert.equal(remounted.action, "REUSED");
        assert.equal(remounts, 1);
        assert.isFalse(
          (yield* provider.ensure({ ...input, requiredHead: "b".repeat(40) })).isOnRequiredHead,
        );
        leaseOwner = "another-agent";
        const busy = yield* provider.ensure(input).pipe(Effect.result);
        assert.equal(busy._tag, "Failure");
        leaseOwner = first.leaseOwner;
        assert.equal(
          (yield* provider
            .remove({ cwd: input.cwd, path: workspace, explicit: false })
            .pipe(Effect.result))._tag,
          "Failure",
        );
        assert.isTrue(registered);
        yield* provider.remove({ cwd: input.cwd, path: workspace, explicit: true });
        assert.isFalse(registered);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            processLayer,
            opsLayer,
            ServerConfig.ServerConfig.layerTest(source, { prefix: "t3-arc-workspaces-" }),
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
