import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as VcsDriver from "../vcs/VcsDriver.ts";
import * as Registry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { makeReviewRangeReader } from "./ServerSourceControlHost.ts";
import { processOutput } from "@t3tools/source-control-testing/TestSourceControlHost";

it.effect.each(["arc", "git"] as const)(
  "reads the requested %s commit range rather than HEAD and reports truncation",
  (kind) =>
    Effect.gen(function* () {
      const driver = yield* VcsDriver.VcsDriver.pipe(
        Effect.provide(
          Layer.mock(VcsDriver.VcsDriver)({
            checkpoints: {
              captureCheckpoint: () => Effect.die("unexpected checkpoint"),
              hasCheckpointRef: () => Effect.die("unexpected checkpoint"),
              restoreCheckpoint: () => Effect.die("unexpected checkpoint"),
              diffCheckpoints: () => Effect.die("unexpected checkpoint"),
              listAuthoredPaths: () => Effect.die("unexpected checkpoint"),
              deleteCheckpointRefs: () => Effect.die("unexpected checkpoint"),
            },
          }),
        ),
      );
      const base = "a".repeat(40);
      const head = "b".repeat(40);
      const at = "2026-11-17T00:00:00Z";
      const read = yield* makeReviewRangeReader.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(Registry.VcsDriverRegistry)({
              resolve: () =>
                Effect.succeed({
                  kind,
                  driver,
                  repository: {
                    kind,
                    rootPath: "/repo",
                    metadataPath: `/repo/.${kind}`,
                    freshness: {
                      source: "live-local",
                      observedAt: DateTime.makeUnsafe(0),
                      expiresAt: Option.none(),
                    },
                  },
                }),
            }),
            Layer.mock(VcsProcess.VcsProcess)({
              run: (input) => {
                assert.equal(input.command, kind);
                assert.equal(input.cwd, "/repo");
                assert.equal(input.args.at(-1), `${base}..${head}`);
                assert.equal(input.args[input.args.indexOf("-n") + 1], "2");
                return Effect.succeed(
                  processOutput(
                    kind === "arc"
                      ? JSON.stringify([
                          { commit: head, message: "New\nBody", date: at },
                          { commit: base, message: "Old", date: at },
                        ])
                      : `${head}\0${at}\0New\n${base}\0${at}\0Old\n`,
                  ),
                );
              },
            }),
          ),
        ),
      );
      assert.deepEqual(yield* read({ cwd: "/repo/project", base, head, limit: 1 }), {
        commits: [{ sha: head, subject: "New", committedAt: at }],
        truncated: true,
      });
      assert.equal(
        (yield* read({ cwd: "/repo/project", base: "HEAD", head, limit: 1 }).pipe(Effect.flip))
          ._tag,
        "GitCommandError",
      );
    }),
);
