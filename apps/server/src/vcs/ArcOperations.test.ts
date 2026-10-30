import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";

import * as ArcOperations from "./ArcOperations.ts";
import * as ArcCli from "./ArcCli.ts";
import * as VcsProcess from "./VcsProcess.ts";

const patch =
  "diff --git a/project/file.txt b/project/file.txt\n--- a/project/file.txt\n+++ b/project/file.txt\n@@ -1 +1 @@\n-old\n+new\n";

describe("Arc operations", () => {
  it.effect("renders untracked links and modes without following their targets", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-arc-diff-" });
      const cwd = path.join(root, "project");
      yield* fs.makeDirectory(cwd);
      yield* fs.symlink("/outside/missing", path.join(cwd, "link"));
      yield* fs.writeFileString(path.join(cwd, "executable"), "run\n");
      yield* fs.chmod(path.join(cwd, "executable"), 0o755);
      yield* fs.writeFile(path.join(cwd, "binary"), new Uint8Array([0xff, 0xfe]));
      const dependencies = ArcOperations.layer.pipe(
        Layer.provide(ArcCli.layer),
        Layer.provide(
          Layer.mock(VcsProcess.VcsProcess)({
            run: (input) =>
              Effect.sync(() => {
                const stdout =
                  input.args[0] === "root"
                    ? `${root}\n`
                    : input.args[0] === "info"
                      ? JSON.stringify({
                          hash: "a".repeat(40),
                          repository: "arcadia",
                          branch: "task",
                        })
                      : input.args[0] === "status"
                        ? JSON.stringify({
                            status: {
                              untracked: ["link", "executable", "binary"].map((name) => ({
                                path: `project/${name}`,
                                status: "untracked",
                                type: "file",
                              })),
                            },
                          })
                        : "";
                input.onStdoutChunk?.(Buffer.from(stdout));
                return {
                  exitCode: ChildProcessSpawner.ExitCode(0),
                  stdout,
                  stderr: "",
                  stdoutTruncated: false,
                  stderrTruncated: false,
                };
              }),
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const ops = yield* ArcOperations.ArcOperations;
        const preview = yield* ops.getReviewDiffPreview({
          cwd,
          file: { path: "project/link", previousPath: null, sourceKind: "working-tree" },
        });
        assert.include(preview.sources[0]!.diff, "new file mode 120000");
        assert.include(preview.sources[0]!.diff, "+/outside/missing");
        const executable = yield* ops.getReviewDiffPreview({
          cwd,
          file: { path: "project/executable", previousPath: null, sourceKind: "working-tree" },
        });
        assert.include(executable.sources[0]!.diff, "new file mode 100755");
        assert.equal((yield* ops.localStatus({ cwd })).workingTree.files.length, 3);
        const contents = yield* ops.getReviewDiffFileContents({
          cwd,
          oldPath: "project/link",
          newPath: "project/link",
          changeType: "new",
          sourceKind: "working-tree",
          baseRef: null,
          headRef: null,
        });
        assert.equal(contents.newContents, "/outside/missing");
      }).pipe(Effect.provide(dependencies));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("switches in the existing checkout and commits only selected paths", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      let branch = "feature";
      let head = "a".repeat(40);
      let committedPaths: string[] = [];
      let message = "";
      let remote: string | undefined;
      let remoteHead = "a".repeat(40);
      let publish = true;
      let pushArgs: ReadonlyArray<string> = [];
      const process = Layer.mock(VcsProcess.VcsProcess)({
        run: (input) =>
          Effect.gen(function* () {
            assert.equal(input.command, "arc");
            if (input.args[0] === "checkout")
              branch = input.args[1] === "-b" ? input.args[2]! : input.args[1]!;
            if (input.args[0] === "branch" && input.args[1] === "-u") remote = input.args[2];
            if (input.args[0] === "commit") {
              committedPaths = input.args.slice(input.args.indexOf("--") + 1);
              message = yield* fs.readFileString(input.args[input.args.indexOf("-F") + 1]!);
              head = "b".repeat(40);
            }
            if (input.args[0] === "push") {
              pushArgs = input.args;
              if (publish) {
                if (input.args[1] === "-u") remote = `users/test/${branch}`;
                remoteHead = head;
              }
            }
            const stdout =
              input.args[0] === "root"
                ? "/repo\n"
                : input.args[0] === "info"
                  ? JSON.stringify({
                      hash: head,
                      branch,
                      repository: "arcadia",
                      mount_id: "mount-1",
                      user_login: "test",
                      ...(remote ? { remote, remote_head: remoteHead } : {}),
                    })
                  : input.args[0] === "log"
                    ? JSON.stringify([{ commit: remoteHead }])
                    : "";
            input.onStdoutChunk?.(Buffer.from(stdout));
            return {
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdout,
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            };
          }).pipe(Effect.orDie),
      });
      yield* Effect.gen(function* () {
        const ops = yield* ArcOperations.ArcOperations;
        yield* ops.createRef({ cwd: "/repo/project", refName: "task-2", switchRef: true });
        const ctx = yield* ops.context("/repo/project");
        assert.equal(ctx.root, "/repo");
        assert.equal(ctx.branch, "task-2");
        const result = yield* ops.commit("/repo/project", "Выбранный файл", "Описание", {
          filePaths: ["project/selected.txt"],
        });
        assert.equal(result.commitSha, "b".repeat(40));
        assert.deepEqual(committedPaths, ["project/selected.txt"]);
        assert.equal(message, "Выбранный файл\n\nОписание\n");
        const pushed = yield* ops.pushCurrentBranch("/repo/project");
        assert.equal(pushed.upstreamBranch, "users/test/task-2");
        remote = undefined;
        yield* ops.setUpstream("/repo/project", "users/test/existing-pr");
        const continued = yield* ops.pushCurrentBranch("/repo/project");
        assert.equal(
          continued.upstreamBranch?.replace(/^arcadia\//u, ""),
          "users/test/existing-pr",
        );
        assert.deepEqual(pushArgs, ["push"]);
        publish = false;
        remoteHead = "a".repeat(40);
        assert.equal(
          (yield* ops.pushCurrentBranch("/repo/project").pipe(Effect.result))._tag,
          "Failure",
        );
      }).pipe(
        Effect.provide(
          ArcOperations.layer.pipe(Layer.provide(ArcCli.layer), Layer.provide(process)),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps repository root separate from project cwd and paginates native refs", () =>
    Effect.gen(function* () {
      const ops = yield* ArcOperations.ArcOperations;
      const status = yield* ops.localStatus({ cwd: "/repo/project" });
      assert.equal(status.refName, "feature");
      assert.equal(status.vcsKind, "arc");
      assert.equal(status.workingTree.rootPath, "/repo");
      assert.deepEqual(status.workingTree.files, [
        { path: "project/file.txt", insertions: 1, deletions: 1 },
      ]);
      const refs = yield* ops.listRefs({ cwd: "/repo/project", limit: 1 });
      assert.equal(refs.refs[0]?.name, "feature");
      assert.equal(refs.refs[0]?.worktreePath, "/repo/project");
      assert.equal(refs.nextCursor, 1);
      assert.equal(refs.totalCount, 2);
      const allRefs = yield* ops.listRefs({
        cwd: "/repo/project",
        includeMatchingRemoteRefs: true,
      });
      assert.equal(allRefs.refs.find((ref) => ref.name === "arcadia/trunk")?.isRemote, true);
    }).pipe(
      Effect.provide(
        ArcOperations.layer.pipe(
          Layer.provide(ArcCli.layer),
          Layer.provide(
            Layer.mock(VcsProcess.VcsProcess)({
              run: (input) =>
                Effect.sync(() => {
                  const command = input.args[0];
                  assert.equal(input.command, "arc");
                  const stdout =
                    command === "root"
                      ? "/repo\n"
                      : command === "info"
                        ? JSON.stringify({
                            hash: "a".repeat(40),
                            repository: "arcadia",
                            branch: "feature",
                            mount_id: "mount-1",
                          })
                        : command === "status"
                          ? JSON.stringify({
                              status: {
                                changed: [
                                  { path: "project/file.txt", status: "modified", type: "file" },
                                ],
                              },
                            })
                          : command === "branch"
                            ? JSON.stringify([
                                { name: "feature", local: true, current: true },
                                { name: "trunk", local: true },
                                ...(input.args.includes("-a") ? [{ name: "arcadia/trunk" }] : []),
                              ])
                            : command === "diff"
                              ? patch
                              : "";
                  input.onStdoutChunk?.(Buffer.from(stdout));
                  return {
                    exitCode: ChildProcessSpawner.ExitCode(0),
                    stdout,
                    stderr: "",
                    stdoutTruncated: false,
                    stderrTruncated: false,
                  };
                }),
            }),
          ),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );
});
