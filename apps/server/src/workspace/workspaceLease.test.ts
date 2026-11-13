import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { makeWorkspaceLease } from "./workspaceLease.ts";

it.effect.each(["arc", "git"] as const)(
  "serializes nested %s projects by checkout while allowing reentrant operations",
  (kind) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-arc-lease-" });
      if (kind === "arc") {
        yield* fs.makeDirectory(path.join(root, ".arc"));
        yield* fs.writeFileString(path.join(root, ".arc", "HEAD"), "fixture");
      } else {
        yield* fs.makeDirectory(path.join(root, ".git"));
      }
      const a = path.join(root, "a");
      const b = path.join(root, "b");
      yield* fs.makeDirectory(a);
      yield* fs.makeDirectory(b);
      const lease = yield* makeWorkspaceLease;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let active = 0;
      let maximum = 0;
      const first = yield* lease(
        a,
        Effect.gen(function* () {
          active++;
          maximum = Math.max(maximum, active);
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
          active--;
        }),
      ).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(entered);
      const second = yield* lease(
        b,
        Effect.sync(() => {
          active++;
          maximum = Math.max(maximum, active);
          active--;
        }),
      ).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      assert.equal(maximum, 1);
      assert.equal(yield* lease(a, lease(b, Effect.succeed("nested"))), "nested");
    }).pipe(Effect.provide(NodeServices.layer)),
);
