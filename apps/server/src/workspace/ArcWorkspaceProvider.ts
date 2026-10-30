import * as NodeBuffer from "node:buffer";

import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { VcsRepositoryDetectionError } from "@t3tools/contracts";

import * as ArcOperations from "../vcs/ArcOperations.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ServerConfig from "../config.ts";
import type {
  WorkspaceEntry,
  WorkspaceEnsureInput,
  WorkspaceProvider,
} from "./WorkspaceProvider.ts";

export const parseArcWorktrees = (output: string): ReadonlyArray<WorkspaceEntry> => {
  const entries: WorkspaceEntry[] = [];
  let fields = new Map<string, string>();
  const flush = () => {
    if (fields.size === 0) return;
    const root = fields.get("worktree");
    const name = fields.get("name");
    const branch = fields.get("branch");
    if (!root || !name || !branch) throw new TypeError("Incomplete Arc workspace identity.");
    entries.push({
      root,
      name,
      branch,
      head: fields.get("HEAD") || null,
      base: fields.get("base") || null,
      leaseOwner: fields.get("lease-owner") || null,
      ...(fields.has("lease-renewed") ? { leaseRenewed: fields.get("lease-renewed")! } : {}),
    });
    fields = new Map();
  };
  for (const line of output.split("\n")) {
    if (!line.trim()) {
      flush();
      continue;
    }
    const separator = line.indexOf(" ");
    if (separator < 0 && ["trunk", "unmounted", "here"].includes(line)) continue;
    if (separator < 0) throw new TypeError("Malformed Arc workspace identity.");
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (key === "worktree" && fields.size > 0) flush();
    const previous = fields.get(key);
    if (previous !== undefined && previous !== value)
      throw new TypeError("Conflicting Arc workspace identity.");
    fields.set(key, value);
  }
  flush();
  return entries;
};

const Registration = Schema.Struct({
  name: Schema.String,
  root: Schema.String,
  branch: Schema.String,
  owner: Schema.String,
  baseRevision: Schema.String,
});
const decodeRegistration = Schema.decodeEffect(Schema.fromJsonString(Registration));
const encodeRegistration = Schema.encodeEffect(Schema.fromJsonString(Registration));

export const makeArcWorkspaces = Effect.fn("ArcWorkspaceProvider.make")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const process = yield* VcsProcess.VcsProcess;
  const ops = yield* ArcOperations.ArcOperations;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;

  const error = (cwd: string, operation: string, cause?: unknown) =>
    new VcsRepositoryDetectionError({
      cwd,
      operation: `ArcWorkspaceProvider.${operation}`,
      detail: "The Arc workspace could not be prepared or changed safely.",
      ...(cause === undefined ? {} : { cause }),
    });
  const io = <A, E, R>(cwd: string, operation: string, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError((cause) => error(cwd, operation, cause)));
  const digest = Effect.fn("ArcWorkspaceProvider.digest")(function* (value: string) {
    return NodeBuffer.Buffer.from(
      yield* io(config.stateDir, "digest", crypto.digest("SHA-256", NodeBuffer.Buffer.from(value))),
    ).toString("hex");
  });
  const registrationPath = Effect.fn("ArcWorkspaceProvider.registrationPath")(function* (
    root: string,
  ) {
    return path.join(config.stateDir, "arc-workspaces", `${yield* digest(root)}.json`);
  });
  const readRegistration = Effect.fn("ArcWorkspaceProvider.readRegistration")(function* (
    root: string,
  ) {
    const file = yield* registrationPath(root);
    if (!(yield* io(root, "registrationExists", fs.exists(file)))) return null;
    return yield* io(
      root,
      "readRegistration",
      fs.readFileString(file).pipe(Effect.flatMap(decodeRegistration)),
    );
  });
  const saveRegistration = Effect.fn("ArcWorkspaceProvider.saveRegistration")(function* (
    value: typeof Registration.Type,
  ) {
    const file = yield* registrationPath(value.root);
    yield* io(
      value.root,
      "registrationDirectory",
      fs.makeDirectory(path.dirname(file), { recursive: true, mode: 0o700 }),
    );
    const temporary = `${file}.${yield* io(value.root, "uuid", crypto.randomUUIDv4())}.tmp`;
    const encoded = yield* io(value.root, "encodeRegistration", encodeRegistration(value));
    yield* io(
      value.root,
      "writeRegistration",
      fs.writeFileString(temporary, encoded, { flag: "wx", mode: 0o600 }),
    );
    yield* io(value.root, "publishRegistration", fs.rename(temporary, file)).pipe(
      Effect.ensuring(
        fs.remove(temporary, { force: true }).pipe(Effect.orElseSucceed(() => undefined)),
      ),
    );
  });
  const run = Effect.fn("ArcWorkspaceProvider.run")(function* (
    cwd: string,
    args: ReadonlyArray<string>,
  ) {
    return yield* process.run({
      operation: `ArcWorkspaceProvider.${args[0] ?? "command"}`,
      command: "ya",
      cwd,
      args: ["tool", "arc-wt", ...args],
      timeoutMs: 300_000,
      maxOutputBytes: 2 * 1024 * 1024,
      outputMode: "error",
    });
  });
  const list: WorkspaceProvider["list"] = Effect.fn("ArcWorkspaceProvider.list")(function* (cwd) {
    const output = yield* run(cwd, ["list", "--porcelain", "--verbose"]);
    const entries = yield* Effect.try({
      try: () => parseArcWorktrees(output.stdout),
      catch: (cause) => error(cwd, "parseList", cause),
    });
    for (const entry of entries)
      if (!path.isAbsolute(entry.root)) return yield* error(cwd, "workspaceRoot");
    return yield* Effect.forEach(entries, (entry) =>
      io(
        cwd,
        "canonicalWorkspace",
        fs.realPath(entry.root).pipe(
          Effect.catchTags({
            PlatformError: (cause) =>
              cause.reason._tag === "NotFound"
                ? Effect.succeed(path.resolve(entry.root))
                : Effect.fail(cause),
          }),
        ),
      ).pipe(Effect.map((root) => ({ ...entry, root }))),
    );
  });
  const matchingEntry = Effect.fn("ArcWorkspaceProvider.matchingEntry")(function* (
    cwd: string,
    input: WorkspaceEnsureInput,
    entries: ReadonlyArray<WorkspaceEntry>,
  ) {
    const exactName = entries.filter((entry) => entry.name === input.taskKey);
    const registeredBranch: WorkspaceEntry[] = [];
    if (exactName.length === 0) {
      for (const entry of entries) {
        const saved = yield* readRegistration(entry.root);
        if (
          saved?.root === entry.root &&
          saved.name === entry.name &&
          saved.branch === input.branch
        )
          registeredBranch.push(entry);
      }
    }
    const exactBranch = entries.filter((entry) => entry.branch === input.branch);
    const candidates = exactName.length
      ? exactName
      : registeredBranch.length
        ? registeredBranch
        : exactBranch.length
          ? exactBranch
          : entries.filter(
              (entry) => entry.name.includes(input.taskKey) || entry.branch.includes(input.taskKey),
            );
    return yield* candidates.length > 1
      ? Effect.fail(error(cwd, "ambiguousWorkspace"))
      : Effect.succeed(candidates[0] ?? null);
  });

  const ensure: WorkspaceProvider["ensure"] = Effect.fn("ArcWorkspaceProvider.ensure")(
    function* (input) {
      if (
        !input.taskKey ||
        /[\0\r\n]/.test(input.taskKey) ||
        input.taskKey.startsWith("-") ||
        !input.branch ||
        input.branch.startsWith("-") ||
        /[\0\r\n]/.test(input.branch) ||
        !/^[0-9a-f]{40,64}$/i.test(input.baseRevision)
      )
        return yield* error(input.cwd, "input");
      const source = yield* ops.context(input.cwd);
      let entry = yield* matchingEntry(input.cwd, input, yield* list(input.cwd));
      const owner = `t3-${(yield* digest(config.stateDir)).slice(0, 16)}-${(yield* digest(entry?.name ?? input.taskKey)).slice(0, 16)}`;
      let created = false;
      if (entry === null) {
        if (input.path) {
          const requested = path.resolve(input.path);
          const relative = path.relative(source.root, requested);
          if (
            relative === "" ||
            (!relative.startsWith(`..${path.sep}`) &&
              relative !== ".." &&
              !path.isAbsolute(relative))
          )
            return yield* error(input.cwd, "nestedMount");
        }
        const attempt = yield* run(input.cwd, [
          "add",
          input.branch,
          "--name",
          input.taskKey,
          "--base",
          input.baseRevision,
          "--mode",
          "mount-shared",
          "--lease-owner",
          owner,
          "--lease-reason",
          input.taskKey,
          ...(input.path ? ["--path", path.resolve(input.path)] : []),
        ]).pipe(Effect.result);
        entry = yield* matchingEntry(input.cwd, input, yield* list(input.cwd));
        if (entry === null)
          return yield* attempt._tag === "Failure"
            ? Effect.fail(attempt.failure)
            : Effect.fail(error(input.cwd, "createReadback"));
        created = true;
      } else {
        yield* run(input.cwd, [
          "lease",
          "acquire",
          entry.name,
          "--owner",
          owner,
          "--reason",
          input.taskKey,
        ]);
      }
      const observed = (yield* list(input.cwd)).find(
        (candidate) => candidate.name === entry.name && candidate.root === entry.root,
      );
      if (!observed || observed.leaseOwner !== owner)
        return yield* error(input.cwd, "leaseReadback");
      if (entry.root === source.root) return yield* error(input.cwd, "sharedWorkspace");
      if (
        !(yield* io(input.cwd, "mountMetadata", fs.exists(path.join(entry.root, ".arc", "HEAD"))))
      ) {
        const remount = yield* run(input.cwd, ["remount", entry.name, "--lease-owner", owner]).pipe(
          Effect.result,
        );
        const mounted = yield* ops.context(entry.root).pipe(Effect.result);
        if (mounted._tag === "Failure")
          return yield* remount._tag === "Failure"
            ? Effect.fail(remount.failure)
            : Effect.fail(error(input.cwd, "remountReadback"));
      }
      const saved = yield* readRegistration(entry.root);
      let actual = yield* ops.context(entry.root);
      const renamed =
        saved !== null &&
        saved.name === entry.name &&
        saved.owner === owner &&
        saved.branch === actual.branch &&
        input.branch === entry.branch;
      const registeredRoot = yield* io(input.cwd, "canonicalRoot", fs.realPath(entry.root));
      if (
        actual.root !== registeredRoot ||
        (actual.branch !== input.branch && !renamed) ||
        (created && actual.head !== input.baseRevision)
      )
        return yield* error(input.cwd, "checkoutIdentity");
      const cwd = path.resolve(actual.root, source.scope);
      const service = yield* ops.context(cwd);
      if (service.root !== actual.root) return yield* error(input.cwd, "serviceBoundary");
      actual = service;
      if (actual.branch === null) return yield* error(input.cwd, "detachedWorkspace");
      if (input.publishedBranch) yield* ops.setUpstream(cwd, input.publishedBranch);
      yield* saveRegistration({
        name: entry.name,
        root: actual.root,
        branch: actual.branch,
        owner,
        baseRevision: saved?.baseRevision ?? input.baseRevision,
      });
      return {
        root: actual.root,
        cwd,
        branch: actual.branch,
        head: actual.head,
        name: entry.name,
        leaseOwner: owner,
        action: created ? ("CREATED" as const) : ("REUSED" as const),
        isOnRequiredHead: input.requiredHead === undefined || actual.head === input.requiredHead,
      };
    },
  );

  const recordBranch: WorkspaceProvider["recordBranch"] = Effect.fn(
    "ArcWorkspaceProvider.recordBranch",
  )(function* (cwd, branch) {
    const ctx = yield* ops.context(cwd);
    const saved = yield* readRegistration(ctx.root);
    if (saved !== null) {
      if (ctx.branch !== branch) return yield* error(cwd, "renameReadback");
      yield* saveRegistration({ ...saved, branch });
    }
  });

  const remove: WorkspaceProvider["remove"] = Effect.fn("ArcWorkspaceProvider.remove")(
    function* (input) {
      if (!input.explicit) return yield* error(input.cwd, "explicitRemoveRequired");
      const source = yield* ops.context(input.cwd);
      const candidate = path.resolve(input.path);
      const entries = (yield* list(input.cwd)).filter(
        (entry) => candidate === entry.root || candidate.startsWith(`${entry.root}${path.sep}`),
      );
      if (entries.length !== 1 || entries[0]!.root === source.root)
        return yield* error(input.cwd, "removeIdentity");
      const entry = entries[0]!;
      const saved = yield* readRegistration(entry.root);
      if (!saved || saved.owner !== entry.leaseOwner || !entry.leaseRenewed)
        return yield* error(input.cwd, "removeLease");
      const registrationFile = yield* registrationPath(entry.root);
      yield* run(input.cwd, [
        "remove",
        entry.name,
        "--lease-owner",
        saved.owner,
        "--lease-renewed",
        entry.leaseRenewed,
        ...(input.force ? ["--force"] : []),
      ]);
      if ((yield* list(input.cwd)).some((candidate) => candidate.root === entry.root))
        return yield* error(input.cwd, "removeReadback");
      yield* io(input.cwd, "deleteRegistration", fs.remove(registrationFile, { force: true }));
    },
  );

  return { list, ensure, recordBranch, remove } satisfies WorkspaceProvider;
});
