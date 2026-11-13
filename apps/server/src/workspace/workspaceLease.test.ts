import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { makeWorkspaceLease } from "./workspaceLease.ts";

it.effect("serializes nested Arc projects by checkout while allowing reentrant operations", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-arc-lease-" });
    yield* fs.makeDirectory(path.join(root, ".arc"));
    yield* fs.writeFileString(path.join(root, ".arc", "HEAD"), "fixture");
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    yield* fs.makeDirectory(a);
    yield* fs.makeDirectory(b);
    const lease = yield* makeWorkspaceLease;
    let active = 0;
    let maximum = 0;
    const operation = Effect.gen(function* () {
      active++;
      maximum = Math.max(maximum, active);
      yield* Effect.yieldNow;
      active--;
    });
    yield* Effect.all([lease(a, operation), lease(b, operation)], { concurrency: 2 });
    assert.equal(maximum, 1);
    assert.equal(yield* lease(a, lease(b, Effect.succeed("nested"))), "nested");
  }).pipe(Effect.provide(NodeServices.layer)),
);
