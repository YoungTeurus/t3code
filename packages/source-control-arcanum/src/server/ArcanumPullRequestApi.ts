import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { PullRequestCheck } from "@t3tools/contracts";
import * as ArcanumApi from "./ArcanumApi.ts";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";

export const Id = Schema.Union([Schema.String, Schema.Number]);
const Commit = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40,64}$/iu));
const User = Schema.Struct({ name: Schema.NonEmptyString, uid: Schema.optional(Schema.String) });
export const Diff = Schema.Struct({
  id: Id,
  published: Schema.Boolean,
  has_conflicts: Schema.Boolean,
  commit_ids: Schema.Struct({ head: Commit, base: Commit, merge: Schema.optional(Commit) }),
});
export const PullRequest = Schema.Struct({
  id: Schema.Number,
  url: Schema.String,
  summary: Schema.String,
  description: Schema.String,
  status: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
  closed_at: Schema.optional(Schema.NullOr(Schema.String)),
  merge_allowed: Schema.optional(Schema.NullOr(Schema.Boolean)),
  auto_merge: Schema.optional(Schema.String),
  author: User,
  coauthors: Schema.optional(Schema.Array(User)),
  tickets: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  vcs: Schema.Struct({
    repo_name: Schema.NonEmptyString,
    type: Schema.Literal("arc"),
    from_branch: Schema.NonEmptyString,
    to_branch: Schema.NonEmptyString,
  }),
  assignees: Schema.optional(Schema.Array(User)),
  approvers: Schema.optional(Schema.Array(User)),
  labels: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String }))),
  active_diff: Schema.optional(Schema.NullOr(Diff)),
});
export const Comments = Schema.Array(
  Schema.Struct({
    id: Id,
    content: Schema.optional(Schema.String),
    author: Schema.optional(User),
    created_at: Schema.String,
    updated_at: Schema.optional(Schema.String),
    edited_at: Schema.optional(Schema.NullOr(Schema.String)),
    deleted_at: Schema.optional(Schema.NullOr(Schema.String)),
    is_draft: Schema.optional(Schema.Boolean),
    reply_to_id: Schema.optional(Schema.NullOr(Id)),
    issue_status: Schema.optional(Schema.String),
    forbidden: Schema.optional(Schema.Boolean),
    anchor: Schema.optional(Schema.Unknown),
  }),
);
export const Changes = Schema.Array(
  Schema.Struct({
    path: Schema.NonEmptyString,
    entry_id: Schema.optional(Schema.NonEmptyString),
    change_type: Schema.String,
    node_type: Schema.String,
    blob_before: Schema.optional(Schema.String),
    blob_after: Schema.optional(Schema.String),
    source: Schema.optional(
      Schema.Struct({
        path: Schema.optional(Schema.String),
        commit_id: Schema.optional(Schema.String),
      }),
    ),
    content_links: Schema.optional(
      Schema.Struct({
        before_path: Schema.optional(Schema.String),
        before_commit: Schema.optional(Schema.String),
        after_path: Schema.optional(Schema.String),
        after_commit: Schema.optional(Schema.String),
      }),
    ),
  }),
);
const CheckPage = Schema.Struct({
  next_page_cursor: Schema.optional(Schema.NullOr(Schema.String)),
  checks: Schema.Array(
    Schema.Struct({
      key: Schema.Struct({ system: Schema.String, type: Schema.String }),
      status: Schema.String,
      required: Schema.Boolean,
      satisfied: Schema.Boolean,
      description: Schema.optional(Schema.String),
      uri: Schema.optional(Schema.String),
    }),
  ),
});
const Listing = Schema.Struct({
  pull_requests: Schema.Array(Schema.Struct({ id: Schema.Number })),
  has_next: Schema.Boolean,
});
const Repositories = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    arc_repo_name: Schema.optional(Schema.String),
    slug: Schema.String,
    vcs_type: Schema.String,
  }),
);
const SearchPage = Schema.Struct({
  pull_requests: Schema.Array(Schema.Unknown),
  total: Schema.Number,
});
const decodeRepositorySelector = Schema.decodeUnknownOption(
  Schema.Struct({ vcs: Schema.Struct({ repo_name: Schema.String, type: Schema.String }) }),
);
const decodePullRequest = Schema.decodeUnknownEffect(PullRequest);
const prFields =
  "id,url,summary,description,status,created_at,updated_at,closed_at,merge_allowed,author(name,uid),coauthors(name,uid),tickets,assignees(name,uid),approvers(name,uid),vcs(repo_name,from_branch,to_branch,type),labels(name),auto_merge,active_diff(id,published,has_conflicts,commit_ids(head,base,merge))";
const diffFields = "id,published,commit_ids(head,base,merge),has_conflicts";
const commentFields =
  "id,content,created_at,updated_at,edited_at,deleted_at,is_draft,issue_status,reply_to_id,forbidden,author(name,uid),anchor";
const checkFields =
  "next_page_cursor,checks(key(system,type),status,required,satisfied,description,uri)";
const changeFields =
  "path,entry_id,change_type,node_type,source(path,commit_id),content_links(before_path,before_commit,after_path,after_commit),blob_before,blob_after";
const fields = (value: string) => `fields=${encodeURIComponent(value)}`;
interface ReadResult {
  readonly pr: typeof PullRequest.Type;
  readonly diff: typeof Diff.Type;
}

export class ArcanumPullRequestApi extends Context.Service<
  ArcanumPullRequestApi,
  {
    readonly read: (
      cwd: string,
      number: number,
      refresh?: boolean,
    ) => Effect.Effect<ReadResult, ArcanumApi.ArcanumApiError>;
    readonly checks: (
      cwd: string,
      diff: typeof Id.Type,
    ) => Effect.Effect<ReadonlyArray<PullRequestCheck>, ArcanumApi.ArcanumApiError>;
    readonly comments: (
      cwd: string,
      number: number,
    ) => Effect.Effect<typeof Comments.Type, ArcanumApi.ArcanumApiError>;
    readonly changes: (
      cwd: string,
      diff: typeof Id.Type,
    ) => Effect.Effect<typeof Changes.Type, ArcanumApi.ArcanumApiError>;
    readonly list: (
      cwd: string,
      input: {
        readonly prefix?: string;
        readonly limit: number;
        readonly offset: number;
        readonly paths?: ReadonlyArray<string>;
        readonly contributor?: string;
      },
    ) => Effect.Effect<typeof Listing.Type, ArcanumApi.ArcanumApiError>;
    readonly search: (
      cwd: string,
      input: {
        readonly state: "all" | "open" | "closed" | "merged";
        readonly involvement: "all" | "authored" | "reviewing";
        readonly viewer: string;
        readonly limit: number;
        readonly offset: number;
      },
    ) => Effect.Effect<
      {
        readonly rows: ReadonlyArray<typeof PullRequest.Type>;
        readonly total: number;
        readonly rawCount: number;
      },
      ArcanumApi.ArcanumApiError
    >;
  }
>()("@t3tools/source-control-arcanum/server/ArcanumPullRequestApi") {}

const make = Effect.gen(function* () {
  const api = yield* ArcanumApi.ArcanumApi;
  const repositories = yield* Cache.makeWith(
    (cwd: string) =>
      Effect.gen(function* () {
        const rows = yield* api.request(
          {
            cwd,
            operation: "getRepositories",
            path: `/v1/public/repos?${fields("id,arc_repo_name,slug,vcs_type")}`,
          },
          Repositories,
        );
        const matches = rows.filter(
          (row) => row.arc_repo_name === "arcadia" && row.vcs_type === "arc",
        );
        if (matches.length !== 1)
          return yield* new ArcanumApi.ArcanumApiError({
            operation: "arcadiaRepositoryIdentity",
            reason: "failed",
          });
        return matches[0]!;
      }),
    { capacity: 32, timeToLive: (exit) => (Exit.isSuccess(exit) ? "10 minutes" : "0 seconds") },
  );
  const cache = yield* Cache.makeWith(
    (key: string) =>
      Effect.gen(function* () {
        const separator = key.indexOf("\0");
        const number = Number(key.slice(0, separator));
        const cwd = key.slice(key.indexOf("\0", separator + 1) + 1);
        const repository = yield* Cache.get(repositories, cwd);
        const pr = yield* api.request(
          {
            cwd,
            operation: "getPullRequest",
            path: `/v2/pull-requests/${number}?${fields(prFields)}`,
          },
          PullRequest,
        );
        if (pr.id !== number || pr.vcs.repo_name !== repository.id)
          return yield* new ArcanumApi.ArcanumApiError({
            operation: "pullRequestIdentity",
            reason: "failed",
          });
        const diff =
          pr.active_diff ??
          (yield* api.request(
            {
              cwd,
              operation: "getActiveDiff",
              path: `/v1/pull-requests/${number}/active-diff?${fields(diffFields)}`,
            },
            Diff,
          ));
        return { pr, diff };
      }),
    { capacity: 256, timeToLive: (exit) => (Exit.isSuccess(exit) ? "5 seconds" : "0 seconds") },
  );
  return ArcanumPullRequestApi.of({
    search: Effect.fn("ArcanumPullRequestApi.search")(function* (cwd, input) {
      const repository = yield* Cache.get(repositories, cwd);
      const page = yield* api.request(
        {
          cwd,
          operation: "searchPullRequests",
          method: "POST",
          path: `/v1/plugin/pull-request/search?${fields(`total,pull_requests(${prFields})`)}`,
          body: {
            filter: {
              ...(input.state === "all" ? {} : { is_open: input.state === "open" }),
              ...(input.involvement === "authored"
                ? { authors_or_coauthors: { include: [input.viewer] } }
                : input.involvement === "reviewing"
                  ? { assignees: [input.viewer] }
                  : {}),
            },
            order: [{ field: "updated_at", ascending: false }],
            limit: Math.min(100, input.limit),
            offset: input.offset,
          },
        },
        SearchPage,
      );
      const rows: Array<typeof PullRequest.Type> = [];
      for (const raw of page.pull_requests) {
        const selector = decodeRepositorySelector(raw);
        if (Option.isNone(selector))
          return yield* new ArcanumApi.ArcanumApiError({
            operation: "searchRepositoryIdentity",
            reason: "failed",
          });
        if (selector.value.vcs.repo_name !== repository.id || selector.value.vcs.type !== "arc")
          continue;
        rows.push(
          yield* decodePullRequest(raw).pipe(
            Effect.mapError(
              () =>
                new ArcanumApi.ArcanumApiError({
                  operation: "searchPullRequest",
                  reason: "failed",
                }),
            ),
          ),
        );
      }
      return { rows, total: page.total, rawCount: page.pull_requests.length };
    }),
    read: Effect.fn("ArcanumPullRequestApi.read")(function* (cwd, number, refresh) {
      if (!Number.isSafeInteger(number) || number < 1)
        return yield* new ArcanumApi.ArcanumApiError({
          operation: "pullRequestNumber",
          reason: "failed",
        });
      const key = `${number}\0${yield* SourceControlRateLimit.CredentialScope}\0${cwd}`;
      if (refresh) yield* Cache.invalidate(cache, key);
      return yield* Cache.get(cache, key);
    }),
    checks: Effect.fn("ArcanumPullRequestApi.checks")(function* (cwd, diff) {
      const checks = new Map<string, PullRequestCheck>();
      const cursors = new Set<string>();
      let cursor: string | null = null;
      do {
        const page: typeof CheckPage.Type = yield* api.request(
          {
            cwd,
            operation: "getChecks",
            path: `/v2/public/diff/${encodeURIComponent(String(diff))}/checks?limit=100&${fields(checkFields)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          },
          CheckPage,
        );
        for (const check of page.checks) {
          const status: PullRequestCheck["status"] =
            check.status === "success"
              ? "success"
              : check.status === "failure" || check.status === "error"
                ? "failure"
                : check.status === "cancelled"
                  ? "cancelled"
                  : check.status === "skipped"
                    ? "skipped"
                    : check.status === "action_required"
                      ? "action-required"
                      : "pending";
          checks.set(`${check.key.system.length}:${check.key.system}${check.key.type}`, {
            name: `${check.key.system} / ${check.key.type}`,
            status,
            description: check.description ?? null,
            url: check.uri ?? null,
            required: check.required,
          });
        }
        cursor = page.next_page_cursor || null;
        if (cursor && (cursors.has(cursor) || cursors.size >= 1_000))
          return yield* new ArcanumApi.ArcanumApiError({
            operation: "checksPagination",
            reason: "failed",
          });
        if (cursor) cursors.add(cursor);
      } while (cursor);
      return [...checks.values()];
    }),
    comments: Effect.fn("ArcanumPullRequestApi.comments")((cwd, number) =>
      api.request(
        {
          cwd,
          operation: "getComments",
          path: `/v2/public/pull-request/${number}/comment?${fields(commentFields)}`,
        },
        Comments,
      ),
    ),
    changes: Effect.fn("ArcanumPullRequestApi.changes")((cwd, diff) =>
      api.request(
        {
          cwd,
          operation: "getChangelist",
          path: `/v2/public/diff/${encodeURIComponent(String(diff))}/changelist?${fields(changeFields)}`,
        },
        Changes,
      ),
    ),
    list: Effect.fn("ArcanumPullRequestApi.list")(function* (cwd, input) {
      const repository = yield* Cache.get(repositories, cwd);
      return yield* api.request(
        {
          cwd,
          operation: "listPullRequests",
          method: "POST",
          path: `/v1/pull-requests/cursor?${fields("pull_requests(id),has_next")}`,
          body: {
            filter: {
              repositories: [repository.id],
              ...(input.prefix ? { user_branch_prefix: input.prefix } : {}),
              ...(input.paths ? { paths: input.paths } : {}),
              ...(input.contributor ? { user: { contributor: [input.contributor] } } : {}),
            },
            desc_order: true,
            limit: Math.min(500, input.limit),
            offset: input.offset,
          },
        },
        Listing,
      );
    }),
  });
});
export const layer = Layer.effect(ArcanumPullRequestApi, make);
