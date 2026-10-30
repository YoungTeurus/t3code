import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as Context from "effect/Context";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const leases = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();
const heldLeases = Context.Reference<ReadonlyMap<string, number>>("t3/workspace/heldLeases", {
  defaultValue: () => new Map(),
});

export const withWorkspaceLease = Effect.fn("WorkspaceLease.withLease")(function* <A, E, R>(
  cwd: string,
  effect: Effect.Effect<A, E, R>,
): Effect.fn.Return<A, E, R> {
  const held = yield* heldLeases;
  const fiberId = yield* Effect.fiberId;
  if (held.get(cwd) === fiberId) return yield* effect;
  const lease = leases.get(cwd) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
  leases.set(cwd, lease);
  lease.users++;
  return yield* lease.semaphore
    .withPermit(effect.pipe(Effect.provideService(heldLeases, new Map([...held, [cwd, fiberId]]))))
    .pipe(
      Effect.ensuring(
        Effect.sync(() => {
          lease.users--;
          if (lease.users === 0) leases.delete(cwd);
        }),
      ),
    );
});

export const makeWorkspaceLease = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const key = Effect.fn("WorkspaceLease.key")(function* (cwd: string) {
    const resolved = yield* fs.realPath(cwd).pipe(Effect.orElseSucceed(() => path.resolve(cwd)));
    let current = resolved;
    while (true) {
      if (yield* fs.exists(path.join(current, ".git"))) return path.resolve(cwd);
      if (yield* fs.exists(path.join(current, ".arc", "HEAD"))) return `arc:${current}`;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(cwd);
      current = parent;
    }
  });
  return <A, E, R>(cwd: string, effect: Effect.Effect<A, E, R>) =>
    key(cwd).pipe(Effect.flatMap((identity) => withWorkspaceLease(identity, effect)));
});
