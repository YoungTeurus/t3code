import * as Deferred from "effect/Deferred";
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
      if (yield* fs.exists(path.join(current, ".git"))) return current;
      if (yield* fs.exists(path.join(current, ".arc", "HEAD"))) return `arc:${current}`;
      const parent = path.dirname(current);
      if (parent === current) return resolved;
      current = parent;
    }
  });
  return <A, E, R>(cwd: string, effect: Effect.Effect<A, E, R>) =>
    key(cwd).pipe(Effect.flatMap((identity) => withWorkspaceLease(identity, effect)));
});

// A restore rewrites files under its directory, so it must exclude provider
// startup in any overlapping workspace: symlink aliases, parents, and children.
// Kept apart from withWorkspaceLease because that lease is non-reentrant and
// restores call Git work that leases the project root.
interface Reservation {
  readonly cwd: string;
  readonly kind: "restore" | "turn-start";
}

const reservations = new Set<Reservation>();
let reservationReleased = Deferred.makeUnsafe<void>();

// path.relative folds win32 drive-letter case and treats a POSIX backslash as
// part of a name, unlike a raw prefix check.
const contains = (path: Path.Path, parent: string, child: string) => {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
};

const conflicts = (path: Path.Path, a: Reservation, b: Reservation) =>
  (a.kind === "restore" || b.kind === "restore") &&
  (contains(path, a.cwd, b.cwd) || contains(path, b.cwd, a.cwd));

const reserve = (path: Path.Path, reservation: Reservation): Effect.Effect<void> =>
  Effect.suspend(() => {
    for (const held of reservations) {
      if (conflicts(path, held, reservation)) {
        return Deferred.await(reservationReleased).pipe(Effect.andThen(reserve(path, reservation)));
      }
    }
    reservations.add(reservation);
    return Effect.void;
  });

const release = (reservation: Reservation) =>
  Effect.sync(() => {
    if (!reservations.delete(reservation)) return;
    const released = reservationReleased;
    reservationReleased = Deferred.makeUnsafe<void>();
    Deferred.doneUnsafe(released, Effect.void);
  });

// A worktree removed by storage cleanup is recreated inside the reserved
// section, so resolve its nearest existing ancestor: a symlink alias above it
// must still canonicalize the same on both sides. Walks at most the path depth.
const canonicalize = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  target: string,
): Effect.Effect<string> =>
  fileSystem.realPath(target).pipe(
    Effect.catchReason("PlatformError", "NotFound", () => {
      const parent = path.dirname(target);
      return parent === target
        ? Effect.succeed(target)
        : canonicalize(fileSystem, path, parent).pipe(
            Effect.map((resolved) => path.join(resolved, path.basename(target))),
          );
    }),
    Effect.orElseSucceed(() => target),
  );

const withReservation =
  (kind: Reservation["kind"]) =>
  <A, E, R>(
    fileSystem: FileSystem.FileSystem,
    path: Path.Path,
    cwd: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    canonicalize(fileSystem, path, cwd).pipe(
      Effect.flatMap((canonical) => {
        const reservation: Reservation = { cwd: canonical, kind };
        return reserve(path, reservation).pipe(
          Effect.andThen(effect),
          Effect.ensuring(release(reservation)),
        );
      }),
    );

/** Exclusive over every overlapping workspace while checkpoint files are restored. */
export const withCheckpointRestoreReservation = withReservation("restore");

/** Waits out overlapping restores; turn startups never wait on each other. */
export const withTurnStartReservation = withReservation("turn-start");
