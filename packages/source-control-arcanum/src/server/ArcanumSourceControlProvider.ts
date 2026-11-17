import { SourceControlProviderError, type ChangeRequest } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import { sourceBranch } from "@t3tools/source-control-core/server/SourceControlProvider";
import { definition } from "../shared/definition.ts";
import * as ArcanumPullRequestApi from "./ArcanumPullRequestApi.ts";
import * as ArcanumApi from "./ArcanumApi.ts";

const Info = Schema.Struct({
  hash: Schema.String,
  branch: Schema.NonEmptyString,
  remote: Schema.optional(Schema.String),
  repository: Schema.Literal("arcadia"),
  user_login: Schema.NonEmptyString,
});
const decodeInfo = Schema.decodeEffect(Schema.fromJsonString(Info));
const Created = Schema.Struct({ id: Schema.Number, url: Schema.String });
const decodeCreated = Schema.decodeEffect(Schema.fromJsonString(Created));
const isSourceControlProviderError = Schema.is(SourceControlProviderError);
const decodeCheckoutStatus = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ status: Schema.Record(Schema.String, Schema.Array(Schema.Unknown)) }),
  ),
);

export const toChangeRequest = (record: {
  readonly pr: typeof ArcanumPullRequestApi.PullRequest.Type;
  readonly diff: typeof ArcanumPullRequestApi.Diff.Type;
}): ChangeRequest => ({
  provider: definition.kind,
  number: record.pr.id,
  title: record.pr.summary,
  url: record.pr.url,
  baseRefName: record.pr.vcs.to_branch,
  headRefName: record.pr.vcs.from_branch,
  headSha: record.diff.commit_ids.head,
  state:
    record.pr.status === "merged"
      ? "merged"
      : ["discarded", "no_changes"].includes(record.pr.status)
        ? "closed"
        : "open",
  isDraft: !record.diff.published,
  closedAt: record.pr.closed_at ?? null,
  mergedAt: record.pr.status === "merged" ? (record.pr.closed_at ?? null) : null,
  updatedAt: DateTime.make(record.pr.updated_at),
  isCrossRepository: false,
});

export const make = Effect.gen(function* () {
  const client = yield* ArcanumPullRequestApi.ArcanumPullRequestApi;
  const api = yield* ArcanumApi.ArcanumApi;
  const host = yield* SourceControlHost.SourceControlHost;
  const fs = yield* FileSystem.FileSystem;
  const error = (
    cwd: string,
    operation: string,
    detail = "The Arcanum operation could not be completed.",
  ) => new SourceControlProviderError({ cwd, provider: definition.kind, operation, detail });
  const io = <A, E, R>(cwd: string, operation: string, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError(() => error(cwd, operation)));
  const referenceNumber = (cwd: string, reference: string) => {
    let number = Number(reference.replace(/^#/u, ""));
    if (!Number.isSafeInteger(number) || number < 1) {
      try {
        number = definition.parseChangeRequestUrl(new URL(reference))?.number ?? 0;
      } catch {
        number = 0;
      }
    }
    return Number.isSafeInteger(number) && number > 0
      ? Effect.succeed(number)
      : Effect.fail(
          error(cwd, "reference", "Use an Arcanum PR number or a.yandex-team.ru/review URL."),
        );
  };
  const info = Effect.fn("ArcanumSourceControlProvider.info")(function* (cwd: string) {
    const output = yield* io(
      cwd,
      "info",
      host.process.run({
        cwd,
        operation: "ArcanumSourceControlProvider.info",
        command: "arc",
        args: ["info", "--json"],
        maxOutputBytes: 65_536,
        outputMode: "error",
      }),
    );
    return yield* io(cwd, "decodeInfo", decodeInfo(output.stdout));
  });
  const getChangeRequest: SourceControlProvider.SourceControlProvider["Service"]["getChangeRequest"] =
    Effect.fn("ArcanumSourceControlProvider.getChangeRequest")(function* (input) {
      const number = yield* referenceNumber(input.cwd, input.reference);
      return toChangeRequest(
        yield* io(input.cwd, "getChangeRequest", client.read(input.cwd, number, true)),
      );
    });
  const listChangeRequests: SourceControlProvider.SourceControlProvider["Service"]["listChangeRequests"] =
    Effect.fn("ArcanumSourceControlProvider.listChangeRequests")(function* (input) {
      const branch = sourceBranch(input);
      if (!branch || /[\0\r\n]/u.test(branch)) return yield* error(input.cwd, "headSelector");
      const limit = Math.min(input.limit ?? 20, 100);
      const requests: ChangeRequest[] = [];
      let offset = 0;
      while (requests.length < limit) {
        const page = yield* io(
          input.cwd,
          "listChangeRequests",
          client.list(input.cwd, {
            prefix: branch,
            limit: Math.max(1, limit - requests.length),
            offset,
          }),
        );
        for (const row of page.pull_requests) {
          const request = toChangeRequest(
            yield* io(input.cwd, "readListedChangeRequest", client.read(input.cwd, row.id)),
          );
          if (
            request.headRefName === branch &&
            (input.state === "all" || request.state === input.state)
          )
            requests.push(request);
        }
        if (!page.has_next) break;
        offset += page.pull_requests.length;
        if (offset > 500 || page.pull_requests.length === 0)
          return yield* error(
            input.cwd,
            "listPagination",
            "Arcanum could not completely search this branch's pull requests.",
          );
      }
      return requests.slice(0, limit);
    });
  const createChangeRequest: SourceControlProvider.SourceControlProvider["Service"]["createChangeRequest"] =
    Effect.fn("ArcanumSourceControlProvider.createChangeRequest")(function (input) {
      return api
        .withVerifiedCredential(input.cwd, ({ viewer }) =>
          Effect.scoped(
            Effect.gen(function* () {
              const before = yield* info(input.cwd);
              if (before.user_login !== viewer)
                return yield* error(
                  input.cwd,
                  "accountMismatch",
                  "The Arcanum account must match the Arc CLI account before creating a PR.",
                );
              const branch = sourceBranch(input);
              if (
                before.remote !== branch ||
                input.baseRefName.startsWith("-") ||
                /[\0\r\n]/u.test(input.baseRefName)
              )
                return yield* error(
                  input.cwd,
                  "publishIdentity",
                  "Push the selected Arc branch before creating its Arcanum PR.",
                );
              const existing = yield* listChangeRequests({ ...input, state: "open", limit: 2 });
              if (existing.length > 1) return yield* error(input.cwd, "ambiguousPullRequest");
              if (existing.length === 1) {
                if (existing[0]!.headSha !== before.hash)
                  return yield* error(
                    input.cwd,
                    "publishedHead",
                    "The Arcanum PR has not reached the pushed Arc commit yet.",
                  );
                return;
              }
              const body = yield* io(input.cwd, "readBody", fs.readFileString(input.bodyFile));
              const messageFile = yield* io(
                input.cwd,
                "messageFile",
                fs.makeTempFileScoped({ prefix: "t3-arcanum-create-" }),
              );
              yield* io(
                input.cwd,
                "writeMessage",
                fs.writeFileString(messageFile, `${input.title}\n\n${body.trimEnd()}\n`, {
                  mode: 0o600,
                }),
              );
              const result = yield* host.process
                .run({
                  cwd: input.cwd,
                  operation: "ArcanumSourceControlProvider.createChangeRequest",
                  command: "arc",
                  args: [
                    "pr",
                    "create",
                    "--json",
                    "--no-push",
                    "-F",
                    messageFile,
                    "--to",
                    input.baseRefName,
                  ],
                  timeoutMs: 300_000,
                  maxOutputBytes: 1_048_576,
                  outputMode: "error",
                })
                .pipe(Effect.result);
              const after = yield* info(input.cwd);
              if (
                after.hash !== before.hash ||
                after.branch !== before.branch ||
                after.remote !== before.remote
              )
                return yield* error(
                  input.cwd,
                  "checkoutChanged",
                  "The Arc checkout changed while its PR was being created.",
                );
              if (result._tag === "Success") {
                const created = yield* io(
                  input.cwd,
                  "decodeCreated",
                  decodeCreated(result.success.stdout),
                );
                const readback = yield* getChangeRequest({
                  cwd: input.cwd,
                  reference: String(created.id),
                });
                if (readback.headSha !== before.hash || readback.headRefName !== branch)
                  return yield* error(input.cwd, "createReadback");
                return;
              }
              const readback = yield* listChangeRequests({ ...input, state: "open", limit: 2 });
              if (readback.length !== 1 || readback[0]!.headSha !== before.hash)
                return yield* error(
                  input.cwd,
                  "createOutcomeUnknown",
                  "The PR creation response was lost and its outcome could not be verified. Refresh Arcanum before trying again.",
                );
            }),
          ),
        )
        .pipe(
          Effect.mapError((cause) =>
            isSourceControlProviderError(cause) ? cause : error(input.cwd, "verifyAccount"),
          ),
        );
    });
  return SourceControlProvider.SourceControlProvider.of({
    kind: definition.kind,
    headBranchProbe: ({ headSelectors }) => ({ headSelectors, limit: 20 }),
    listChangeRequests,
    getChangeRequest,
    createChangeRequest,
    getDefaultBranch: Effect.fn("ArcanumSourceControlProvider.getDefaultBranch")(() =>
      Effect.succeed("trunk"),
    ),
    getRepositoryCloneUrls: Effect.fn("ArcanumSourceControlProvider.getRepositoryCloneUrls")(
      (input) =>
        Effect.fail(
          error(input.cwd, "clone", "Open an existing Arc checkout or create an Arc workspace."),
        ),
    ),
    createRepository: Effect.fn("ArcanumSourceControlProvider.createRepository")((input) =>
      Effect.fail(
        error(input.cwd, "createRepository", "Arcanum uses the existing Arcadia monorepository."),
      ),
    ),
    checkoutChangeRequest: Effect.fn("ArcanumSourceControlProvider.checkoutChangeRequest")(
      function* (input) {
        if (input.force)
          return yield* error(
            input.cwd,
            "forceCheckout",
            "Arc PR checkout preserves local commits and changes.",
          );
        const pr = yield* getChangeRequest(input);
        if (!pr.headSha) return yield* error(input.cwd, "missingHead");
        const branch = `t3/pr-${pr.number}`;
        const bindUpstream = io(
          input.cwd,
          "prUpstream",
          host.git.setBranchUpstream({
            cwd: input.cwd,
            branch,
            remoteName: "arcadia",
            remoteBranch: pr.headRefName,
          }),
        );
        const before = yield* info(input.cwd);
        if (before.branch === branch) return yield* bindUpstream;
        const root = yield* io(
          input.cwd,
          "root",
          host.process.run({
            cwd: input.cwd,
            operation: "ArcanumSourceControlProvider.root",
            command: "arc",
            args: ["root"],
            maxOutputBytes: 65_536,
            outputMode: "error",
          }),
        );
        if (!root.stdout.trim()) return yield* error(input.cwd, "root");
        const output = yield* io(
          input.cwd,
          "status",
          host.process.run({
            cwd: root.stdout.trim(),
            operation: "ArcanumSourceControlProvider.status",
            command: "arc",
            args: [
              "status",
              "--json",
              "-u",
              "all",
              "--no-ahead-behind",
              "--no-sync-status",
              "--no-bisect-status",
            ],
            outputMode: "error",
          }),
        );
        const status = yield* io(input.cwd, "decodeStatus", decodeCheckoutStatus(output.stdout));
        if (Object.values(status.status).some((changes) => changes.length > 0))
          return yield* error(
            input.cwd,
            "dirtyCheckout",
            "Commit current Arc changes or open this PR in a workspace.",
          );
        const names = yield* io(input.cwd, "branches", host.git.listLocalBranchNames(input.cwd));
        if (!names.includes(branch))
          yield* io(
            input.cwd,
            "createBranch",
            host.git.createBranch({ cwd: input.cwd, branch, startPoint: pr.headSha }),
          );
        yield* io(input.cwd, "switchRef", host.git.switchRef({ cwd: input.cwd, refName: branch }));
        yield* bindUpstream;
      },
    ),
    resolveLink: (input) =>
      definition.parseChangeRequestUrl(input.url) === null
        ? undefined
        : getChangeRequest({ cwd: input.cwd, reference: input.url.toString() }).pipe(
            Effect.flatMap((pr) =>
              io(input.cwd, "resolveLink", client.read(input.cwd, pr.number)).pipe(
                Effect.map((record) => ({ title: record.pr.summary, body: record.pr.description })),
              ),
            ),
          ),
  });
});
