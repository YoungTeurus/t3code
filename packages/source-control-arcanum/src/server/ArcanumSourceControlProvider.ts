import {
  SourceControlProviderError,
  SourceControlProviderKind,
  type ChangeRequest,
} from "@t3tools/contracts";
import {
  providerAuth,
  type SourceControlApiDiscoverySpec,
} from "@t3tools/source-control-core/server/discovery";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import { parseGitRemoteRepository } from "@t3tools/shared/git";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  ARC_SERVER_HOSTS,
  ARCANUM_DEFAULT_REPOSITORY,
  ARCANUM_WEB_HOST,
  definition,
  parseReviewUrl,
} from "../shared/definition.ts";
import * as ArcanumApi from "./ArcanumApi.ts";
import * as Json from "./arcanumJson.ts";
import * as Reads from "./arcanumReads.ts";

const KIND = SourceControlProviderKind.make("arcanum");
const CHECKOUT_TIMEOUT_MS = 5 * 60_000;
const ARC_INFO_TIMEOUT_MS = 15_000;
const MAX_DESCRIPTION_BYTES = 1024 * 1024;

const decodeArcMountInfo = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ default_branch: Schema.optional(Schema.String) })),
);
const decodeArcBranches = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ name: Schema.String, remote: Schema.optional(Schema.String) })),
  ),
);
const decodeArcInfo = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ user_login: Schema.optional(Schema.String) })),
);
const CreatedPullRequest = Schema.Struct({ id: Schema.Int, url: Schema.optional(Schema.String) });

/** The Arc repository a provider context names, or Arcanum's own when it names none. */
function repositoryOfContext(
  context: SourceControlProvider.SourceControlProviderContext | undefined,
): string {
  const parsed = context === undefined ? null : parseGitRemoteRepository(context.remoteUrl);
  return parsed !== null && ARC_SERVER_HOSTS.has(parsed.host)
    ? parsed.path
    : ARCANUM_DEFAULT_REPOSITORY;
}

/** A pull request number from `123`, `#123` or a review URL. */
function referenceNumber(reference: string): number | null {
  const trimmed = reference.trim();
  const bare = /^#?(\d{1,12})$/u.exec(trimmed)?.[1];
  const number = bare === undefined ? parseReviewUrl(trimmed) : Number(bare);
  return number !== null && Number.isSafeInteger(number) && number > 0 ? number : null;
}

function toChangeRequest(pull: Json.ReviewRequest): ChangeRequest {
  const state = Json.pullRequestState(pull.full_status);
  const closedAt = pull.closed_at ?? null;
  return {
    provider: KIND,
    number: pull.id,
    title: Json.titleOf(pull),
    url: pull.url,
    baseRefName: pull.vcs.to_branch,
    headRefName: pull.vcs.from_branch,
    ...(pull.active_diff_set?.arc_branch_heads === undefined
      ? {}
      : { headSha: pull.active_diff_set.arc_branch_heads.from_id }),
    state,
    isDraft: pull.active_diff_set?.status === "draft" || pull.common_status === "draft",
    closedAt: state === "open" ? null : closedAt,
    mergedAt: state === "merged" ? closedAt : null,
    updatedAt: Option.map(DateTime.make(pull.updated_at), DateTime.toUtc),
    // Arcanum has no forks: every branch lives in the repository.
    isCrossRepository: false,
  };
}

export const make = Effect.gen(function* () {
  const api = yield* ArcanumApi.ArcanumApi;
  const { process } = yield* SourceControlHost.SourceControlHost;
  const fileSystem = yield* FileSystem.FileSystem;

  const failure =
    (operation: string, cwd: string, extra?: { reference?: string; repository?: string }) =>
    (cause: { readonly detail?: string; readonly message: string } | string) =>
      new SourceControlProviderError({
        provider: KIND,
        operation,
        cwd,
        ...(extra?.reference === undefined
          ? {}
          : {
              reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                extra.reference,
              ),
            }),
        ...(extra?.repository === undefined ? {} : { repository: extra.repository }),
        detail: typeof cause === "string" ? cause : (cause.detail ?? cause.message),
        ...(typeof cause === "string" ? {} : { cause }),
      });

  const readPull = (operation: string, cwd: string, number: number, repository: string) =>
    Reads.readReviewRequest(api, operation, number).pipe(
      Effect.tap((pull) => Reads.assertRepository(operation, pull, repository)),
      Effect.mapError(failure(operation, cwd, { reference: String(number) })),
    );

  const runArcJson = <A>(
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    decode: (text: string) => Effect.Effect<A, Schema.SchemaError>,
  ) =>
    process
      .run({
        operation: `ArcanumSourceControlProvider.${operation}`,
        command: "arc",
        args,
        cwd,
        timeoutMs: ARC_INFO_TIMEOUT_MS,
        maxOutputBytes: 8 * 1024 * 1024,
        outputMode: "error",
      })
      .pipe(
        Effect.mapError(failure(operation, cwd)),
        Effect.flatMap((output) =>
          decode(output.stdout).pipe(
            Effect.mapError(() =>
              failure(
                operation,
                cwd,
              )(`Arc printed \`arc ${args[0]}\` output this version cannot read.`),
            ),
          ),
        ),
      );

  /**
   * The Arc server branch a branch name means. A local branch that tracks one means that one. A
   * local branch that does not is where Arc would push it, `users/<Arc login>/<name>`, as the Arc
   * driver pushes. Any other name already is a server branch, such as the upstream the caller read.
   */
  const serverBranchOf = Effect.fn("ArcanumSourceControlProvider.serverBranchOf")(function* (
    operation: string,
    cwd: string,
    repository: string,
    branch: string,
  ) {
    const name = branch.trim().replace(/^refs\/heads\//u, "");
    if (name.length === 0) {
      return yield* failure(operation, cwd)("No branch to look a pull request up by.");
    }
    // Without `-v` Arc leaves out each branch's upstream, `remote`.
    const branches = yield* runArcJson(
      operation,
      cwd,
      ["branch", "--json", "-v"],
      decodeArcBranches,
    );
    const local = branches.find((entry) => entry.name === name);
    if (local === undefined) return name;
    const remote = local.remote?.trim();
    if (remote) {
      return remote.startsWith(`${repository}/`) ? remote.slice(repository.length + 1) : remote;
    }
    const info = yield* runArcJson(operation, cwd, ["info", "--json"], decodeArcInfo);
    const login = info.user_login?.trim();
    if (!login) {
      return yield* failure(operation, cwd)("Arc did not report the signed-in user.");
    }
    return name.startsWith(`users/${login}/`) ? name : `users/${login}/${name}`;
  });

  // The pin the pull request provider uses too: both read through one ArcanumApi.
  const withCredential: SourceControlProvider.SourceControlProvider["Service"]["withCredential"] = (
    _input,
    use,
  ) => api.withCredential(use);

  const unsupported = (operation: string, cwd: string, repository: string) =>
    Effect.fail(
      failure(operation, cwd, { repository })(
        "Arc repositories are mounted with `arc mount`; T3 cannot clone or create them.",
      ),
    );

  return SourceControlProvider.SourceControlProvider.of({
    kind: KIND,
    withCredential,
    // Arcanum keys pull requests by full Arc branch, never by an `owner:branch` fork selector.
    headBranchProbe: ({ headSelectors }) => ({
      headSelectors: headSelectors.filter(
        (selector) => SourceControlProvider.parseSourceControlOwnerRef(selector) === undefined,
      ),
      limit: 1,
    }),
    resolveLink: ({ cwd, url }) => {
      const number = parseReviewUrl(url.href);
      if (number === null) return undefined;
      return Reads.readReviewRequest(api, "resolveLink", number).pipe(
        Effect.map((pull) => ({ title: Json.titleOf(pull), body: pull.description ?? null })),
        Effect.mapError(failure("resolveLink", cwd, { reference: url.href })),
      );
    },
    listChangeRequests: Effect.fn("ArcanumSourceControlProvider.listChangeRequests")(
      function* (input) {
        const operation = "listChangeRequests";
        const repository = repositoryOfContext(input.context);
        const branch = SourceControlProvider.sourceBranch(input);
        if (branch.length === 0) return [];
        const serverBranch = yield* serverBranchOf(operation, input.cwd, repository, branch);
        const number = yield* Reads.latestFromBranch(api, operation, {
          branch: serverBranch,
          repository,
        }).pipe(Effect.mapError(failure(operation, input.cwd, { reference: branch })));
        if (number === null) return [];
        const changeRequest = toChangeRequest(
          yield* readPull(operation, input.cwd, number, repository),
        );
        return input.state === "all" || changeRequest.state === input.state ? [changeRequest] : [];
      },
    ),
    getChangeRequest: Effect.fn("ArcanumSourceControlProvider.getChangeRequest")(function* (input) {
      const number = referenceNumber(input.reference);
      if (number === null) {
        return yield* failure("getChangeRequest", input.cwd, { reference: input.reference })(
          "Arcanum pull requests are numbers or review URLs.",
        );
      }
      return toChangeRequest(
        yield* readPull("getChangeRequest", input.cwd, number, repositoryOfContext(input.context)),
      );
    }),
    createChangeRequest: Effect.fn("ArcanumSourceControlProvider.createChangeRequest")(
      function* (input) {
        const operation = "createChangeRequest";
        const repository = repositoryOfContext(input.context);
        const fail = failure(operation, input.cwd, { reference: input.headSelector, repository });
        const description = yield* fileSystem
          .readFileString(input.bodyFile)
          .pipe(Effect.mapError(() => fail("Could not read the pull request description.")));
        if (new TextEncoder().encode(description).byteLength > MAX_DESCRIPTION_BYTES) {
          return yield* fail("The pull request description is too long for Arcanum.");
        }
        const serverBranch = yield* serverBranchOf(
          operation,
          input.cwd,
          repository,
          SourceControlProvider.sourceBranch(input),
        );
        const created = yield* api
          .request({
            operation,
            method: "POST",
            path: "/v1/pull-requests",
            query: { fields: "id,url" },
            body: {
              vcs: {
                arc_repo_name: repository,
                from_branch: serverBranch,
                to_branch: input.target?.refName ?? input.baseRefName,
              },
              summary: input.title,
              description,
            },
          })
          .pipe(
            Effect.flatMap(Reads.decodeData(operation, CreatedPullRequest)),
            Effect.mapError((error) =>
              fail(
                error.status === 409
                  ? "An open pull request from this branch already exists in Arcanum."
                  : error.outcomeUnknown
                    ? `${error.detail} Check Arcanum before creating it again.`
                    : error,
              ),
            ),
          );
        // Arcanum's answer names the pull request, so nothing has to look it up again.
        const url =
          created.url ??
          definition.changeRequestUrl({ host: ARCANUM_WEB_HOST, repository, number: created.id });
        return url === null ? undefined : { number: created.id, url };
      },
    ),
    getRepositoryCloneUrls: Effect.fn("ArcanumSourceControlProvider.getRepositoryCloneUrls")(
      function* (input) {
        return yield* unsupported("getRepositoryCloneUrls", input.cwd, input.repository);
      },
    ),
    createRepository: Effect.fn("ArcanumSourceControlProvider.createRepository")(function* (input) {
      return yield* unsupported("createRepository", input.cwd, input.repository);
    }),
    getDefaultBranch: Effect.fn("ArcanumSourceControlProvider.getDefaultBranch")(function* (input) {
      const operation = "getDefaultBranch";
      const output = yield* process
        .run({
          operation: "ArcanumSourceControlProvider.getDefaultBranch",
          command: "arc",
          args: ["info", "--mount", "--json"],
          cwd: input.cwd,
          timeoutMs: ARC_INFO_TIMEOUT_MS,
          maxOutputBytes: 1024 * 1024,
        })
        .pipe(Effect.mapError(failure(operation, input.cwd)));
      const info = yield* decodeArcMountInfo(output.stdout).pipe(
        Effect.mapError(() =>
          failure(operation, input.cwd)("Arc printed mount info this version cannot read."),
        ),
      );
      return info.default_branch?.trim() || null;
    }),
    checkoutChangeRequest: Effect.fn("ArcanumSourceControlProvider.checkoutChangeRequest")(
      function* (input) {
        const operation = "checkoutChangeRequest";
        const number = referenceNumber(input.reference);
        if (number === null) {
          return yield* failure(operation, input.cwd, { reference: input.reference })(
            "Arcanum pull requests are numbers or review URLs.",
          );
        }
        // `arc pr checkout` switches to a local branch tracking the pull request's own: the
        // branch name without `users/<you>/` for your own pull request, the full name otherwise.
        yield* process
          .run({
            operation: "ArcanumSourceControlProvider.checkoutChangeRequest",
            command: "arc",
            args: ["pr", "checkout", ...(input.force === true ? ["--force"] : []), String(number)],
            cwd: input.cwd,
            timeoutMs: CHECKOUT_TIMEOUT_MS,
            maxOutputBytes: 1024 * 1024,
          })
          .pipe(Effect.mapError(failure(operation, input.cwd, { reference: String(number) })));
      },
    ),
  });
});

export const makeDiscovery = Effect.gen(function* () {
  const api = yield* ArcanumApi.ArcanumApi;
  return {
    type: "api",
    kind: KIND,
    label: "Arcanum",
    installHint:
      "Save an Arcanum token in Settings → Source control, set ARC_TOKEN on the server, or sign Arc in so `arc token show` works.",
    probeAuth: api.identity("discovery").pipe(
      Effect.map(({ login }) =>
        providerAuth({ status: "authenticated", account: login, host: ARCANUM_WEB_HOST }),
      ),
      Effect.catch((error) =>
        Effect.succeed(
          providerAuth({
            status:
              error.reason === "missing-tool" || error.reason === "unauthenticated"
                ? "unauthenticated"
                : "unknown",
            host: ARCANUM_WEB_HOST,
            detail: error.detail,
          }),
        ),
      ),
    ),
  } satisfies SourceControlApiDiscoverySpec;
});
