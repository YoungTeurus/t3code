import * as NodeBuffer from "node:buffer";

import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as PlatformError from "effect/PlatformError";
import { VcsRepositoryDetectionError, type VcsError } from "@t3tools/contracts";

import * as ArcCli from "../vcs/ArcCli.ts";
import * as ArcOperations from "../vcs/ArcOperations.ts";
import type { VcsCheckpointOps } from "../vcs/VcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { normalizeArcCheckpointNumstat } from "./arcCheckpointDiff.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import { removeEmptyDirectory } from "../vcs/removeEmptyDirectory.ts";
const { Buffer } = NodeBuffer;
const isNotDirectory = Schema.is(Schema.Struct({ code: Schema.Literal("ENOTDIR") }));
const isMissingPath = (cause: PlatformError.PlatformError) =>
  cause.reason._tag === "NotFound" || isNotDirectory(cause.reason.cause);

const Hash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const Entry = Schema.Struct({
  path: Schema.NonEmptyString,
  kind: Schema.Literals(["file", "symlink", "absent"]),
  mode: Schema.Number,
  blob: Schema.NullOr(Hash),
});
type Entry = typeof Entry.Type;
const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  root: Schema.NonEmptyString,
  cwd: Schema.NonEmptyString,
  scope: Schema.NonEmptyString,
  repository: Schema.NonEmptyString,
  branch: Schema.NullOr(Schema.String),
  baseHead: Schema.NonEmptyString,
  capturedAt: Schema.Number,
  entries: Schema.Array(Entry),
});
type Manifest = typeof Manifest.Type;
const Tree = Schema.Array(
  Schema.Struct({
    name: Schema.NonEmptyString,
    type: Schema.String,
    mode: Schema.String,
    hash: Schema.NonEmptyString,
  }),
);
type SnapshotEntry = Entry & { readonly revision?: string; readonly nativeHash?: string };
const Journal = Schema.Struct({
  checkpointRef: Schema.String,
  manifest: Manifest,
  restoreHead: Schema.String,
  before: Schema.Array(Entry),
  target: Schema.Array(Entry),
});
const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(Manifest));
const decodeManifest = Schema.decodeEffect(Schema.fromJsonString(Manifest));
const encodeJournal = Schema.encodeEffect(Schema.fromJsonString(Journal));
const decodeJournal = Schema.decodeEffect(Schema.fromJsonString(Journal));
const Log = Schema.Array(
  Schema.Struct({
    names: Schema.optional(
      Schema.Array(
        Schema.Struct({ path: Schema.String, orig_path: Schema.optional(Schema.String) }),
      ),
    ),
  }),
);

export const makeArcCheckpoints = Effect.fn("ArcCheckpointStore.make")(function* (
  storageRoot: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const cli = yield* ArcCli.ArcCli;
  const ops = yield* ArcOperations.ArcOperations;
  const process = yield* VcsProcess.VcsProcess;

  const error = (cwd: string, operation: string, cause?: unknown) =>
    new VcsRepositoryDetectionError({
      cwd,
      operation: `ArcCheckpointStore.${operation}`,
      detail: "The Arc checkpoint operation could not be completed safely.",
      ...(cause === undefined ? {} : { cause }),
    });
  const io = <A, E, R>(cwd: string, operation: string, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError((cause) => error(cwd, operation, cause)));
  const hash = Effect.fn("ArcCheckpointStore.hash")(function* (bytes: Uint8Array) {
    return Buffer.from(yield* io(storageRoot, "hash", crypto.digest("SHA-256", bytes))).toString(
      "hex",
    );
  });
  const objectPath = (digest: string) => path.join(storageRoot, "objects", digest);

  const atomicWrite = Effect.fn("ArcCheckpointStore.atomicWrite")(function* (
    destination: string,
    bytes: Uint8Array,
  ) {
    yield* io(
      destination,
      "mkdir",
      fs.makeDirectory(path.dirname(destination), { recursive: true, mode: 0o700 }),
    );
    const suffix = yield* io(destination, "uuid", crypto.randomUUIDv4());
    const temporary = `${destination}.${suffix}.tmp`;
    yield* io(destination, "write", fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 }));
    yield* io(destination, "publish", fs.rename(temporary, destination)).pipe(
      Effect.ensuring(
        fs.remove(temporary, { force: true }).pipe(Effect.orElseSucceed(() => undefined)),
      ),
    );
  });

  const storeBlob = Effect.fn("ArcCheckpointStore.storeBlob")(function* (bytes: Uint8Array) {
    const digest = yield* hash(bytes);
    if (!(yield* io(storageRoot, "blobExists", fs.exists(objectPath(digest)))))
      yield* atomicWrite(objectPath(digest), bytes);
    return digest;
  });
  const readBlob = Effect.fn("ArcCheckpointStore.readBlob")(function* (digest: string) {
    const bytes = yield* io(storageRoot, "readBlob", fs.readFile(objectPath(digest)));
    if ((yield* hash(bytes)) !== digest) return yield* error(storageRoot, "blobIntegrity");
    return bytes;
  });
  const area = Effect.fn("ArcCheckpointStore.area")(function* (
    ctx: ArcOperations.ArcRepositoryContext,
  ) {
    return path.join(
      storageRoot,
      "workspaces",
      yield* hash(Buffer.from(`${ctx.repository}\0${ctx.root}\0${ctx.scope}`)),
    );
  });
  const refPath = Effect.fn("ArcCheckpointStore.refPath")(function* (
    ctx: ArcOperations.ArcRepositoryContext,
    ref: string,
  ) {
    return path.join(yield* area(ctx), "refs", yield* hash(Buffer.from(ref)));
  });

  const within = (root: string, candidate: string) => {
    const relative = path.relative(root, candidate);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  const validateStorage = Effect.fn("ArcCheckpointStore.validateStorage")(function* (
    ctx: ArcOperations.ArcRepositoryContext,
  ) {
    if (ctx.scope === ".")
      return yield* new VcsRepositoryDetectionError({
        cwd: ctx.cwd,
        operation: "ArcCheckpointStore.projectScope",
        detail:
          "Open a project directory inside Arcadia to capture checkpoints; the mounted monorepository root is too large.",
      });
    if (!path.isAbsolute(storageRoot)) return yield* error(ctx.cwd, "storagePath");
    let ancestor = storageRoot;
    while (true) {
      const canonical = yield* fs.realPath(ancestor).pipe(
        Effect.catchIf(isMissingPath, () => Effect.succeed(null)),
        Effect.mapError((cause) => error(ctx.cwd, "storagePath", cause)),
      );
      if (canonical !== null) {
        if (within(ctx.root, path.resolve(canonical, path.relative(ancestor, storageRoot))))
          return yield* error(ctx.cwd, "storageInsideArc");
        return;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return yield* error(ctx.cwd, "storagePath");
      ancestor = parent;
    }
  });
  const absolutePath = (ctx: ArcOperations.ArcRepositoryContext, file: string) => {
    const absolute = path.resolve(ctx.root, file);
    return !path.isAbsolute(file) && within(ctx.cwd, absolute) && absolute !== ctx.cwd
      ? Effect.succeed(absolute)
      : Effect.fail(error(ctx.cwd, "path"));
  };
  const safeParent = Effect.fn("ArcCheckpointStore.safeParent")(function* (
    ctx: ArcOperations.ArcRepositoryContext,
    absolute: string,
  ) {
    let candidate = path.dirname(absolute);
    while (within(ctx.cwd, candidate)) {
      const parent = yield* fs.realPath(candidate).pipe(
        Effect.catchIf(isMissingPath, () => Effect.succeed(null)),
        Effect.mapError((cause) => error(ctx.cwd, "parent", cause)),
      );
      if (parent !== null) {
        if (!within(ctx.cwd, parent)) return yield* error(ctx.cwd, "parentBoundary");
        return;
      }
      candidate = path.dirname(candidate);
    }
    return yield* error(ctx.cwd, "parentBoundary");
  });
  const captureFile = Effect.fn("ArcCheckpointStore.captureFile")(function* (
    ctx: ArcOperations.ArcRepositoryContext,
    file: string,
  ): Effect.fn.Return<Entry, VcsError> {
    const absolute = yield* absolutePath(ctx, file);
    const parent = yield* fs.realPath(path.dirname(absolute)).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          isMissingPath(cause) ? Effect.succeed(null) : Effect.fail(cause),
      }),
      Effect.mapError((cause) => error(ctx.cwd, "parent", cause)),
    );
    if (parent === null) return { path: file, kind: "absent", mode: 0, blob: null };
    if (!within(ctx.cwd, parent)) return yield* error(ctx.cwd, "parentBoundary");
    if ((yield* io(ctx.cwd, "parentType", fs.stat(parent))).type !== "Directory")
      return { path: file, kind: "absent", mode: 0, blob: null };
    const link = yield* fs.readLink(absolute).pipe(Effect.option);
    if (Option.isSome(link))
      return {
        path: file,
        kind: "symlink",
        mode: 0o777,
        blob: yield* storeBlob(Buffer.from(link.value)),
      };
    const info = yield* fs.stat(absolute).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          isMissingPath(cause) ? Effect.succeed(null) : Effect.fail(cause),
      }),
      Effect.mapError((cause) => error(ctx.cwd, "stat", cause)),
    );
    if (info === null || info.type === "Directory")
      return { path: file, kind: "absent", mode: 0, blob: null };
    if (info.type !== "File") return yield* error(ctx.cwd, "fileType");
    return {
      path: file,
      kind: "file",
      mode: info.mode & 0o777,
      blob: yield* storeBlob(yield* io(ctx.cwd, "read", fs.readFile(absolute))),
    };
  });

  const readManifest = Effect.fn("ArcCheckpointStore.readManifest")(function* (
    ctx: ArcOperations.ArcRepositoryContext,
    ref: string,
  ) {
    const location = yield* refPath(ctx, ref);
    if (!(yield* io(ctx.cwd, "hasRef", fs.exists(location)))) return null;
    return yield* io(
      ctx.cwd,
      "decodeManifest",
      fs.readFileString(location).pipe(Effect.flatMap(decodeManifest)),
    );
  });

  const capture = Effect.fn("ArcCheckpointStore.capture")(function* (
    ctx: ArcOperations.ArcRepositoryContext,
  ) {
    const changed = yield* ops.changes(ctx.cwd);
    const paths = new Set(
      changed.flatMap((entry) => [entry.path, ...(entry.originalPath ? [entry.originalPath] : [])]),
    );
    const entries = yield* Effect.forEach(paths, (file) => captureFile(ctx, file), {
      concurrency: 4,
    });
    const after = yield* ops.context(ctx.cwd);
    if (after.head !== ctx.head || after.branch !== ctx.branch || after.identity !== ctx.identity)
      return yield* error(ctx.cwd, "captureDrift");
    return {
      version: 1 as const,
      root: ctx.root,
      cwd: ctx.cwd,
      scope: ctx.scope,
      repository: ctx.repository,
      branch: ctx.branch,
      baseHead: ctx.head,
      capturedAt: yield* Clock.currentTimeMillis,
      entries,
    } satisfies Manifest;
  });

  const materialize = Effect.fn("ArcCheckpointStore.materialize")(function* (
    ctx: ArcOperations.ArcRepositoryContext,
    manifest: Manifest,
  ) {
    const tree = yield* cli.runJson(
      {
        cwd: ctx.root,
        operation: "ArcCheckpointStore.tree",
        args: ["ls-tree", "--json", "-r", manifest.baseHead, manifest.scope],
      },
      Tree,
    );
    const files = new Map<string, SnapshotEntry>();
    for (const entry of tree) {
      yield* absolutePath(ctx, entry.name);
      if (entry.type !== "blob" || !["100644", "100755", "120000"].includes(entry.mode))
        return yield* error(ctx.cwd, "treeType");
      files.set(entry.name, {
        path: entry.name,
        kind: entry.mode === "120000" ? "symlink" : "file",
        mode: Number.parseInt(entry.mode, 8) & 0o777,
        blob: null,
        revision: manifest.baseHead,
        nativeHash: entry.hash,
      });
    }
    for (const entry of manifest.entries) {
      yield* absolutePath(ctx, entry.path);
      files.set(entry.path, entry);
    }
    return files;
  });

  const contents = Effect.fn("ArcCheckpointStore.contents")(function* (
    ctx: ArcOperations.ArcRepositoryContext,
    entry: SnapshotEntry,
  ) {
    if (entry.blob !== null) return yield* readBlob(entry.blob);
    if (!entry.revision || entry.kind === "absent") return yield* error(ctx.cwd, "missingContents");
    return (yield* cli.run({
      cwd: ctx.root,
      operation: "ArcCheckpointStore.show",
      args: ["show", `${entry.revision}:${entry.path}`],
    })).stdoutBytes;
  });
  const absent = (file: string): Entry => ({ path: file, kind: "absent", mode: 0, blob: null });
  const same = Effect.fn("ArcCheckpointStore.same")(function* (
    ctx: ArcOperations.ArcRepositoryContext,
    a: SnapshotEntry,
    b: SnapshotEntry,
  ) {
    if (a.kind !== b.kind || a.mode !== b.mode) return false;
    if (a.kind === "absent") return true;
    if (
      (a.blob !== null && a.blob === b.blob) ||
      (a.nativeHash !== undefined && a.nativeHash === b.nativeHash)
    )
      return true;
    const [left, right] = yield* Effect.all([contents(ctx, a), contents(ctx, b)]);
    return Buffer.from(left).equals(right);
  });
  const freeze = Effect.fn("ArcCheckpointStore.freeze")(function* (
    ctx: ArcOperations.ArcRepositoryContext,
    entry: SnapshotEntry,
  ): Effect.fn.Return<Entry, VcsError> {
    return {
      path: entry.path,
      kind: entry.kind,
      mode: entry.mode,
      blob:
        entry.kind === "absent"
          ? null
          : (entry.blob ?? (yield* storeBlob(yield* contents(ctx, entry)))),
    };
  });

  const writeEntry = Effect.fn("ArcCheckpointStore.writeEntry")(function* (
    ctx: ArcOperations.ArcRepositoryContext,
    entry: Entry,
  ) {
    const absolute = yield* absolutePath(ctx, entry.path);
    if (entry.kind === "absent") {
      const exists = yield* fs.realPath(path.dirname(absolute)).pipe(Effect.option);
      if (Option.isNone(exists)) return;
      yield* safeParent(ctx, absolute);
      return yield* io(ctx.cwd, "remove", fs.remove(absolute, { force: true }));
    }
    if (!entry.blob) return yield* error(ctx.cwd, "missingBlob");
    const bytes = yield* readBlob(entry.blob);
    yield* safeParent(ctx, absolute);
    yield* io(ctx.cwd, "mkdir", fs.makeDirectory(path.dirname(absolute), { recursive: true }));
    yield* safeParent(ctx, absolute);
    const link = yield* fs.readLink(absolute).pipe(Effect.option);
    const existing = Option.isNone(link)
      ? yield* fs.stat(absolute).pipe(
          Effect.catchIf(isMissingPath, () => Effect.succeed(null)),
          Effect.mapError((cause) => error(ctx.cwd, "replaceType", cause)),
        )
      : null;
    if (existing?.type === "Directory") {
      if ((yield* io(ctx.cwd, "replaceDirectory", fs.readDirectory(absolute))).length > 0)
        return yield* error(ctx.cwd, "nonemptyDirectory");
      if (!(yield* io(ctx.cwd, "replaceDirectory", removeEmptyDirectory(absolute))))
        return yield* error(ctx.cwd, "nonemptyDirectory");
    }
    const temporary = `${absolute}.t3-${yield* io(ctx.cwd, "uuid", crypto.randomUUIDv4())}`;
    if (entry.kind === "symlink")
      yield* io(ctx.cwd, "symlink", fs.symlink(Buffer.from(bytes).toString("utf8"), temporary));
    else
      yield* io(ctx.cwd, "write", fs.writeFile(temporary, bytes, { flag: "wx", mode: entry.mode }));
    yield* io(ctx.cwd, "replace", fs.rename(temporary, absolute)).pipe(
      Effect.ensuring(
        fs.remove(temporary, { force: true }).pipe(Effect.orElseSucceed(() => undefined)),
      ),
    );
  });

  const captureCheckpoint: VcsCheckpointOps["captureCheckpoint"] = Effect.fn(
    "ArcCheckpointStore.captureCheckpoint",
  )(function* (input) {
    const ctx = yield* ops.context(input.cwd);
    const manifest = yield* capture(ctx);
    const encoded = yield* io(ctx.cwd, "encodeManifest", encodeManifest(manifest));
    yield* atomicWrite(yield* refPath(ctx, input.checkpointRef), Buffer.from(encoded));
  });

  const directoryReplacements = Effect.fn("ArcCheckpointStore.directoryReplacements")(function* (
    ctx: ArcOperations.ArcRepositoryContext,
    target: ReadonlyArray<Entry>,
  ) {
    const deletions = new Set(
      target.filter((entry) => entry.kind === "absent").map((entry) => entry.path),
    );
    const directories = new Set<string>();
    const pending: string[] = [];
    for (const entry of target) {
      if (entry.kind === "absent") continue;
      const absolute = yield* absolutePath(ctx, entry.path);
      if (Option.isSome(yield* fs.readLink(absolute).pipe(Effect.option))) continue;
      const info = yield* fs.stat(absolute).pipe(
        Effect.catchIf(isMissingPath, () => Effect.succeed(null)),
        Effect.mapError((cause) => error(ctx.cwd, "replacementType", cause)),
      );
      if (info?.type === "Directory") pending.push(absolute);
    }
    let inspected = 0;
    while (pending.length > 0) {
      const directory = pending.pop()!;
      if (directories.has(directory)) continue;
      directories.add(directory);
      for (const name of yield* io(ctx.cwd, "replacementDirectory", fs.readDirectory(directory))) {
        if (++inspected > 100_000) return yield* error(ctx.cwd, "replacementDirectoryLimit");
        const absolute = path.join(directory, name);
        const link = yield* fs.readLink(absolute).pipe(Effect.option);
        if (
          Option.isNone(link) &&
          (yield* io(ctx.cwd, "replacementType", fs.stat(absolute))).type === "Directory"
        )
          pending.push(absolute);
        else if (!deletions.has(path.relative(ctx.root, absolute)))
          return yield* error(ctx.cwd, "unrecordedDirectoryContent");
      }
    }
    return [...directories].sort((a, b) => b.length - a.length);
  });

  const restoreCheckpoint: VcsCheckpointOps["restoreCheckpoint"] = Effect.fn(
    "ArcCheckpointStore.restoreCheckpoint",
  )(function* (input) {
    const ctx = yield* ops.context(input.cwd);
    const saved = yield* readManifest(ctx, input.checkpointRef);
    if (saved === null && !input.fallbackToHead) return false;
    const manifest = saved ?? {
      version: 1 as const,
      root: ctx.root,
      cwd: ctx.cwd,
      scope: ctx.scope,
      repository: ctx.repository,
      branch: ctx.branch,
      baseHead: ctx.head,
      capturedAt: yield* Clock.currentTimeMillis,
      entries: [],
    };
    if (
      manifest.root !== ctx.root ||
      manifest.cwd !== ctx.cwd ||
      manifest.branch !== ctx.branch ||
      manifest.repository !== ctx.repository
    )
      return yield* error(ctx.cwd, "restoreIdentity");
    const journalPath = path.join(yield* area(ctx), "restore-intent.json");
    let journal: typeof Journal.Type;
    if (yield* io(ctx.cwd, "journalExists", fs.exists(journalPath))) {
      journal = yield* io(
        ctx.cwd,
        "decodeJournal",
        fs.readFileString(journalPath).pipe(Effect.flatMap(decodeJournal)),
      );
      if (journal.checkpointRef !== input.checkpointRef || journal.restoreHead !== ctx.head)
        return yield* error(ctx.cwd, "unfinishedRestore");
      const prior = new Map(journal.before.map((entry) => [entry.path, entry]));
      for (const target of journal.target) {
        const current = yield* captureFile(ctx, target.path);
        const before = prior.get(target.path);
        if (
          ![before, target].some(
            (entry) =>
              entry?.kind === current.kind &&
              entry.mode === current.mode &&
              entry.blob === current.blob,
          )
        )
          return yield* error(ctx.cwd, "restoreConflict");
      }
    } else {
      const target = yield* materialize(ctx, manifest);
      const current = yield* materialize(ctx, yield* capture(ctx));
      const before: Entry[] = [];
      const changed: Entry[] = [];
      for (const file of new Set([...target.keys(), ...current.keys()])) {
        const a = current.get(file) ?? absent(file);
        const b = target.get(file) ?? absent(file);
        if (yield* same(ctx, a, b)) continue;
        before.push(yield* freeze(ctx, a));
        changed.push(yield* freeze(ctx, b));
      }
      journal = {
        checkpointRef: input.checkpointRef,
        manifest,
        restoreHead: ctx.head,
        before,
        target: changed,
      };
      const encoded = yield* io(ctx.cwd, "encodeJournal", encodeJournal(journal));
      yield* atomicWrite(journalPath, Buffer.from(encoded));
    }
    const directories = yield* directoryReplacements(ctx, journal.target);
    for (const entry of [...journal.target].sort((a, b) => b.path.length - a.path.length))
      if (entry.kind === "absent") yield* writeEntry(ctx, entry);
    for (const directory of directories)
      if (!(yield* io(ctx.cwd, "replaceDirectory", removeEmptyDirectory(directory))))
        return yield* error(ctx.cwd, "nonemptyDirectory");
    for (const entry of journal.target) if (entry.kind !== "absent") yield* writeEntry(ctx, entry);
    yield* cli.run({
      cwd: ctx.root,
      operation: "ArcCheckpointStore.resetIndex",
      args: ["reset", "HEAD", "--", ctx.scope],
    });
    for (const entry of journal.target) {
      const actual = yield* captureFile(ctx, entry.path);
      if (actual.kind !== entry.kind || actual.mode !== entry.mode || actual.blob !== entry.blob)
        return yield* error(ctx.cwd, "restoreReadback");
    }
    const after = yield* ops.context(ctx.cwd);
    if (after.head !== ctx.head || after.branch !== ctx.branch)
      return yield* error(ctx.cwd, "restoreDrift");
    yield* io(ctx.cwd, "clearJournal", fs.remove(journalPath));
    return true;
  });

  const diffCheckpoints: VcsCheckpointOps["diffCheckpoints"] = Effect.fn(
    "ArcCheckpointStore.diffCheckpoints",
  )(function (input) {
    return Effect.scoped(
      Effect.gen(function* () {
        if (input.filePaths?.length === 0) return "";
        const ctx = yield* ops.context(input.cwd);
        const from = yield* readManifest(ctx, input.fromCheckpointRef);
        const to = yield* readManifest(ctx, input.toCheckpointRef);
        if (to === null || (from === null && !input.fallbackFromToHead))
          return yield* error(ctx.cwd, "diffRef");
        const baseline = from ?? { ...to, baseHead: ctx.head, entries: [] };
        const left = yield* materialize(ctx, baseline);
        const right = yield* materialize(ctx, to);
        const changed = new Set<string>();
        for (const file of new Set([...left.keys(), ...right.keys()])) {
          if (input.filePaths && !input.filePaths.includes(file)) continue;
          if (!(yield* same(ctx, left.get(file) ?? absent(file), right.get(file) ?? absent(file))))
            changed.add(file);
        }
        if (changed.size === 0) return "";
        const directory = yield* io(
          ctx.cwd,
          "diffDirectory",
          fs.makeTempDirectoryScoped({ prefix: "t3-arc-diff-" }),
        );
        yield* io(ctx.cwd, "diffDirectory", fs.makeDirectory(path.join(directory, "a")));
        yield* io(ctx.cwd, "diffDirectory", fs.makeDirectory(path.join(directory, "b")));
        for (const [side, files] of [
          ["a", left],
          ["b", right],
        ] as const) {
          for (const entry of files.values()) {
            if (entry.kind === "absent" || !changed.has(entry.path)) continue;
            const destination = path.join(directory, side, entry.path);
            const bytes = yield* contents(ctx, entry);
            yield* io(
              ctx.cwd,
              "diffParent",
              fs.makeDirectory(path.dirname(destination), { recursive: true }),
            );
            if (entry.kind === "symlink")
              yield* io(
                ctx.cwd,
                "diffLink",
                fs.symlink(Buffer.from(bytes).toString("utf8"), destination),
              );
            else
              yield* io(
                ctx.cwd,
                "diffWrite",
                fs.writeFile(destination, bytes, { mode: entry.mode }),
              );
          }
        }
        const output = yield* process.run({
          cwd: directory,
          operation: "ArcCheckpointStore.diff",
          command: "git",
          args: [
            "-c",
            "core.quotePath=false",
            "diff",
            "--no-index",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--src-prefix=",
            "--dst-prefix=",
            ...(input.format === "numstat" ? ["--numstat", "-z"] : ["--binary"]),
            ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
            "--",
            "a",
            "b",
          ],
          allowNonZeroExit: true,
          maxOutputBytes: input.maxOutputBytes ?? 10_000_000,
          outputMode: "error",
        });
        if (output.exitCode !== 0 && output.exitCode !== 1)
          return yield* error(ctx.cwd, "diffProcess");
        if (input.format !== "numstat") return output.stdout;
        return yield* Effect.try({
          try: () => normalizeArcCheckpointNumstat(output.stdout),
          catch: (cause) => error(ctx.cwd, "numstat", cause),
        });
      }),
    );
  });

  const listAuthoredPaths: VcsCheckpointOps["listAuthoredPaths"] = Effect.fn(
    "ArcCheckpointStore.listAuthoredPaths",
  )(function* (input) {
    const ctx = yield* ops.context(input.cwd);
    const from = yield* readManifest(ctx, input.fromCheckpointRef);
    const to = yield* readManifest(ctx, input.toCheckpointRef);
    if (!from || !to || from.baseHead === to.baseHead) return null;
    const removed = yield* cli.runJson(
      {
        cwd: ctx.root,
        operation: "ArcCheckpointStore.removedCommits",
        args: ["log", "--json", "--name-status", `${to.baseHead}..${from.baseHead}`, ctx.scope],
      },
      Log,
    );
    const added = yield* cli.runJson(
      {
        cwd: ctx.root,
        operation: "ArcCheckpointStore.addedCommits",
        args: [
          "log",
          "--json",
          "--name-status",
          "--after",
          DateTime.formatIso(DateTime.makeUnsafe(from.capturedAt)),
          `${from.baseHead}..${to.baseHead}`,
          ctx.scope,
        ],
      },
      Log,
    );
    return new Set(
      [
        ...from.entries,
        ...to.entries,
        ...removed.flatMap((commit) => commit.names ?? []),
        ...added.flatMap((commit) => commit.names ?? []),
      ].flatMap((entry) => [
        entry.path,
        ...("orig_path" in entry && entry.orig_path ? [entry.orig_path] : []),
      ]),
    );
  });

  const collectUnusedBlobs = Effect.fn("ArcCheckpointStore.collectUnusedBlobs")(function* () {
    const live = new Set<string>();
    const mark = (entries: ReadonlyArray<Entry>) => {
      for (const entry of entries) if (entry.blob !== null) live.add(entry.blob);
    };
    const readDirectory = (directory: string) =>
      io(
        storageRoot,
        "gcDirectory",
        fs.readDirectory(directory).pipe(Effect.catchIf(isMissingPath, () => Effect.succeed([]))),
      );
    for (const workspace of yield* readDirectory(path.join(storageRoot, "workspaces"))) {
      const directory = path.join(storageRoot, "workspaces", workspace);
      for (const ref of yield* readDirectory(path.join(directory, "refs"))) {
        const manifest = yield* io(
          storageRoot,
          "gcManifest",
          fs.readFileString(path.join(directory, "refs", ref)).pipe(Effect.flatMap(decodeManifest)),
        );
        mark(manifest.entries);
      }
      const journal = path.join(directory, "restore-intent.json");
      if (yield* io(storageRoot, "gcJournalExists", fs.exists(journal))) {
        const intent = yield* io(
          storageRoot,
          "gcJournal",
          fs.readFileString(journal).pipe(Effect.flatMap(decodeJournal)),
        );
        mark(intent.manifest.entries);
        mark(intent.before);
        mark(intent.target);
      }
    }
    for (const object of yield* readDirectory(path.join(storageRoot, "objects")))
      if (/^[0-9a-f]{64}$/u.test(object) && !live.has(object))
        yield* io(storageRoot, "gcBlob", fs.remove(objectPath(object)));
  });
  const deleteCheckpointRefs: VcsCheckpointOps["deleteCheckpointRefs"] = Effect.fn(
    "ArcCheckpointStore.deleteCheckpointRefs",
  )(function* (input) {
    const ctx = yield* ops.context(input.cwd);
    for (const ref of input.checkpointRefs)
      yield* io(ctx.cwd, "deleteRef", fs.remove(yield* refPath(ctx, ref), { force: true }));
    yield* collectUnusedBlobs();
  });
  const serialized = <I extends { readonly cwd: string }, A>(
    operation: (input: I) => Effect.Effect<A, VcsError>,
  ) =>
    Effect.fn("ArcCheckpointStore.serialized")(function* (input: I) {
      const ctx = yield* ops.context(input.cwd);
      yield* validateStorage(ctx);
      return yield* withWorkspaceLease(
        `arc:${ctx.root}`,
        withWorkspaceLease(`arc-store:${path.resolve(storageRoot)}`, operation(input)),
      );
    });
  return {
    captureCheckpoint: serialized(captureCheckpoint),
    restoreCheckpoint: serialized(restoreCheckpoint),
    diffCheckpoints: serialized(diffCheckpoints),
    listAuthoredPaths,
    hasCheckpointRef: Effect.fn("ArcCheckpointStore.hasCheckpointRef")(function* (input) {
      return (yield* readManifest(yield* ops.context(input.cwd), input.checkpointRef)) !== null;
    }),
    deleteCheckpointRefs: serialized(deleteCheckpointRefs),
  } satisfies VcsCheckpointOps;
});
