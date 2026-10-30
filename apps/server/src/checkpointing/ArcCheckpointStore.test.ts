import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process";
import { CheckpointRef, VcsProcessExitError } from "@t3tools/contracts";

import { makeArcCheckpoints } from "./ArcCheckpointStore.ts";
import * as ArcOperations from "../vcs/ArcOperations.ts";
import * as ArcCli from "../vcs/ArcCli.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

describe("Arc checkpoints", () => {
  it.effect("restores clean and dirty files within scope and refuses a different branch", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-arc-checkpoint-" });
      const cwd = path.join(root, "project");
      const storage = yield* fs.makeTempDirectoryScoped({ prefix: "t3-arc-private-checkpoints-" });
      yield* fs.makeDirectory(cwd);
      yield* fs.writeFileString(path.join(cwd, "clean.txt"), "clean baseline\n");
      yield* fs.writeFileString(path.join(cwd, "dirty.txt"), "dirty at capture\n");
      let branch = "feature";
      let head = "a".repeat(40);
      let failReplacement = false;
      let failPrivateWrite = false;
      const canonicalCwd = yield* fs.realPath(cwd);
      const fault = (method: string) =>
        PlatformError.systemError({
          _tag: "WriteZero",
          module: "FileSystem",
          method,
          description: "Fixture disk failure",
        });
      const checkpointFileSystem = {
        ...fs,
        rename: (source: string, destination: string) =>
          failReplacement && destination === path.join(canonicalCwd, "dirty.txt")
            ? Effect.fail(fault("rename"))
            : fs.rename(source, destination),
        writeFile: (...args: Parameters<typeof fs.writeFile>) =>
          failPrivateWrite ? Effect.fail(fault("writeFile")) : fs.writeFile(...args),
      };
      let changed = ["project/dirty.txt"];
      let cleanBlobsAvailable = true;
      const baseFiles: Record<string, string> = {
        "project/clean.txt": "clean baseline\n",
        "project/dirty.txt": "dirty baseline\n",
      };
      const processLayer = Layer.mock(VcsProcess.VcsProcess)({
        run: (input) =>
          input.args[0] === "show" && !cleanBlobsAvailable
            ? Effect.fail(
                new VcsProcessExitError({
                  cwd: input.cwd,
                  command: "arc",
                  operation: input.operation,
                  exitCode: 1,
                  detail: "Clean blob unavailable.",
                }),
              )
            : Effect.sync(() => {
                const stdout =
                  input.args[0] === "root"
                    ? `${root}\n`
                    : input.args[0] === "info"
                      ? JSON.stringify({
                          hash: head,
                          branch,
                          repository: "arcadia",
                          mount_id: "mount-1",
                        })
                      : input.args[0] === "status"
                        ? JSON.stringify({
                            status: {
                              changed: changed.map((p) => ({
                                path: p,
                                status: "modified",
                                type: "file",
                              })),
                            },
                          })
                        : input.args[0] === "ls-tree"
                          ? JSON.stringify(
                              Object.keys(baseFiles).map((name) => ({
                                name,
                                type: "blob",
                                mode: "100644",
                                hash: "c".repeat(40),
                              })),
                            )
                          : input.args[0] === "show"
                            ? baseFiles[input.args[1]!.slice(41)]!
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
      });
      yield* Effect.gen(function* () {
        const makeStore = () =>
          makeArcCheckpoints(storage).pipe(
            Effect.provideService(FileSystem.FileSystem, checkpointFileSystem),
          );
        const store = yield* makeStore();
        const ref = CheckpointRef.make("refs/t3/checkpoints/arc-test");
        assert.equal(
          (yield* store.captureCheckpoint({ cwd: root, checkpointRef: ref }).pipe(Effect.result))
            ._tag,
          "Failure",
        );
        yield* store.captureCheckpoint({ cwd, checkpointRef: ref });
        assert.isTrue(yield* store.hasCheckpointRef({ cwd, checkpointRef: ref }));
        const second = CheckpointRef.make("refs/t3/checkpoints/arc-test-2");
        yield* store.captureCheckpoint({ cwd, checkpointRef: second });
        const baselineObjects = yield* fs.readDirectory(path.join(storage, "objects"));
        const temporaryRef = CheckpointRef.make("refs/t3/checkpoints/temporary");
        yield* fs.writeFileString(path.join(cwd, "dirty.txt"), "temporary captured contents\n");
        yield* store.captureCheckpoint({ cwd, checkpointRef: temporaryRef });
        yield* store.deleteCheckpointRefs({ cwd, checkpointRefs: [temporaryRef] });
        assert.deepEqual(
          (yield* fs.readDirectory(path.join(storage, "objects"))).toSorted(),
          baselineObjects.toSorted(),
        );
        yield* fs.writeFileString(path.join(cwd, "dirty.txt"), "dirty at capture\n");
        const failedRef = CheckpointRef.make("refs/t3/checkpoints/disk-failure");
        yield* fs.writeFileString(path.join(cwd, "dirty.txt"), "not captured on full disk\n");
        failPrivateWrite = true;
        assert.equal(
          (yield* store.captureCheckpoint({ cwd, checkpointRef: failedRef }).pipe(Effect.result))
            ._tag,
          "Failure",
        );
        failPrivateWrite = false;
        assert.isFalse(yield* store.hasCheckpointRef({ cwd, checkpointRef: failedRef }));
        assert.equal(
          yield* fs.readFileString(path.join(cwd, "dirty.txt")),
          "not captured on full disk\n",
        );
        yield* fs.writeFileString(path.join(cwd, "dirty.txt"), "dirty at capture\n");
        cleanBlobsAvailable = false;
        assert.equal(
          yield* store.diffCheckpoints({
            cwd,
            fromCheckpointRef: ref,
            toCheckpointRef: second,
            ignoreWhitespace: false,
          }),
          "",
        );
        cleanBlobsAvailable = true;
        yield* fs.writeFileString(path.join(cwd, "clean.txt"), "changed after capture\n");
        yield* fs.writeFileString(path.join(cwd, "dirty.txt"), "changed dirty\n");
        yield* fs.writeFileString(path.join(cwd, "new.txt"), "new after capture\n");
        yield* fs.writeFileString(path.join(cwd, "ignored.txt"), "keep ignored\n");
        changed = ["project/clean.txt", "project/dirty.txt", "project/new.txt"];
        assert.isTrue(yield* store.restoreCheckpoint({ cwd, checkpointRef: ref }));
        assert.equal(yield* fs.readFileString(path.join(cwd, "clean.txt")), "clean baseline\n");
        assert.equal(yield* fs.readFileString(path.join(cwd, "dirty.txt")), "dirty at capture\n");
        assert.isFalse(yield* fs.exists(path.join(cwd, "new.txt")));
        assert.equal(yield* fs.readFileString(path.join(cwd, "ignored.txt")), "keep ignored\n");
        assert.isFalse(yield* fs.exists(path.join(root, ".git")));
        head = "b".repeat(40);
        changed = ["project/clean.txt", "project/dirty.txt"];
        yield* fs.writeFileString(
          path.join(cwd, "clean.txt"),
          "clean before interrupted restore\n",
        );
        yield* fs.writeFileString(
          path.join(cwd, "dirty.txt"),
          "dirty before interrupted restore\n",
        );
        failReplacement = true;
        assert.equal(
          (yield* store.restoreCheckpoint({ cwd, checkpointRef: ref }).pipe(Effect.result))._tag,
          "Failure",
        );
        failReplacement = false;
        yield* fs.writeFileString(
          path.join(cwd, "clean.txt"),
          "external edit after interruption\n",
        );
        const restarted = yield* makeStore();
        assert.equal(
          (yield* restarted.restoreCheckpoint({ cwd, checkpointRef: ref }).pipe(Effect.result))
            ._tag,
          "Failure",
        );
        assert.equal(
          yield* fs.readFileString(path.join(cwd, "dirty.txt")),
          "dirty before interrupted restore\n",
        );
        yield* fs.writeFileString(path.join(cwd, "clean.txt"), "clean baseline\n");
        assert.isTrue(yield* restarted.restoreCheckpoint({ cwd, checkpointRef: ref }));
        assert.equal(yield* fs.readFileString(path.join(cwd, "dirty.txt")), "dirty at capture\n");
        assert.equal(head, "b".repeat(40));
        yield* fs.remove(path.join(cwd, "clean.txt"));
        yield* fs.makeDirectory(path.join(cwd, "clean.txt"));
        yield* fs.writeFileString(path.join(cwd, "clean.txt", "child.txt"), "new child\n");
        changed = ["project/clean.txt", "project/clean.txt/child.txt"];
        assert.isTrue(yield* store.restoreCheckpoint({ cwd, checkpointRef: ref }));
        assert.equal(yield* fs.readFileString(path.join(cwd, "clean.txt")), "clean baseline\n");
        yield* fs.remove(path.join(cwd, "clean.txt"));
        yield* fs.makeDirectory(path.join(cwd, "clean.txt"));
        yield* fs.writeFileString(
          path.join(cwd, "clean.txt", "child.txt"),
          "preserve on refusal\n",
        );
        yield* fs.writeFileString(path.join(cwd, "clean.txt", "ignored.txt"), "ignored content\n");
        assert.equal(
          (yield* store.restoreCheckpoint({ cwd, checkpointRef: ref }).pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal(
          yield* fs.readFileString(path.join(cwd, "clean.txt", "child.txt")),
          "preserve on refusal\n",
        );
        assert.equal(
          yield* fs.readFileString(path.join(cwd, "clean.txt", "ignored.txt")),
          "ignored content\n",
        );
        yield* fs.remove(path.join(cwd, "clean.txt"), { recursive: true });
        yield* fs.writeFileString(path.join(cwd, "clean.txt"), "clean baseline\n");
        branch = "other";
        yield* fs.writeFileString(path.join(cwd, "clean.txt"), "other branch work\n");
        const result = yield* store
          .restoreCheckpoint({ cwd, checkpointRef: ref })
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        assert.equal(yield* fs.readFileString(path.join(cwd, "clean.txt")), "other branch work\n");
      }).pipe(
        Effect.provide(
          ArcOperations.layer.pipe(
            Layer.provideMerge(ArcCli.layer),
            Layer.provideMerge(processLayer),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
