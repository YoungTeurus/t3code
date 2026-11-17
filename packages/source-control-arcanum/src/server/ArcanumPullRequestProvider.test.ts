import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  VcsProcessExitError,
  type PullRequestListFilters,
  type ReviewDiffFileStat,
} from "@t3tools/contracts";
import type {
  ProviderListCursor,
  ProviderRepositoryRef,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";

import * as ArcanumApi from "./ArcanumApi.ts";
import * as ArcanumPullRequestProvider from "./ArcanumPullRequestProvider.ts";
import {
  account,
  data,
  jsonResponse,
  provideHarness,
  type HarnessOptions,
  type SentRequest,
} from "./arcanumTesting.ts";

const H = (digit: string) => digit.repeat(40);
const HEAD = H("1");
const BASE = H("2");
const MERGE = H("3");
const REF: ProviderRepositoryRef & { readonly number: number } = {
  cwd: "/arc/arcadia/adv/frontend",
  repository: "arcadia",
  host: "a.yandex-team.ru",
  number: 101,
};

/** Approval waits, as on most open pull requests: it must never hold CI's rollup back. */
const ciChecks = (status: string) => [
  { system: "arcanum", type: "approved", required: true, status: "pending" },
  { system: "CI", type: "build", required: true, status },
];

// Field shapes follow recorded responses, and everything that names a person or path is invented.
const pull = (overrides: Record<string, unknown> = {}) => ({
  id: 101,
  url: "https://a.yandex-team.ru/review/101",
  summary: "Fix the widget",
  description: "Body",
  author: { name: "alice" },
  vcs: { arc_repo_name: "arcadia", from_branch: "users/alice/fix", to_branch: "trunk" },
  created_at: "2026-10-30T11:51:31.665921Z",
  updated_at: "2026-10-30T18:09:03.478330Z",
  full_status: "open",
  common_status: "waiting_for_review",
  merge_allowed: false,
  checks: ciChecks("pending"),
  labels: [{ name: "team/one" }],
  policies: { auto_merge: "disabled" },
  active_diff_set: {
    id: 9001,
    status: "published",
    has_conflicts: false,
    patch_stats: { additions: 10, deletions: 2, size: "S" },
    arc_branch_heads: { from_id: HEAD, to_id: BASE, merge_id: MERGE },
  },
  review: {
    review_status: "review_in_progress",
    reviewers: [{ user: { name: "bob" }, action: "comment" }],
  },
  assignees: [{ name: "carol" }],
  ...overrides,
});

const changelist = [
  {
    path: "adv/frontend/a.ts",
    entry_id: "eid:1:A/b+c==",
    change_type: "modify",
    node_type: "file",
    reviewed: true,
  },
  // Outside the project folder, in the same Arc repository: still part of the pull request.
  {
    path: "devtools/b.ts",
    entry_id: "eid:1:B",
    change_type: "move",
    node_type: "file",
    source: { path: "devtools/old.ts" },
  },
  { path: "devtools", entry_id: "eid:1:D", change_type: "modify", node_type: "dir" },
];

const runProvider =
  (options: HarnessOptions) =>
  <A, E, R>(
    body: (
      provider: Effect.Success<typeof ArcanumPullRequestProvider.make>,
      sent: ReadonlyArray<SentRequest>,
    ) => Effect.Effect<A, E, R>,
  ) =>
    provideHarness(options)((sent) =>
      Effect.gen(function* () {
        const provider = yield* ArcanumPullRequestProvider.make;
        return yield* body(provider, sent);
      }),
    );

const writes = (sent: ReadonlyArray<{ method: string; path: string }>) =>
  sent
    .filter((request) => request.method !== "GET")
    .map((request) => `${request.method} ${request.path}`);

describe("ArcanumPullRequestProvider listing", () => {
  it.effect("filters on the server by involvement, state and draft, and asks for whole rows", () =>
    runProvider({
      routes: {
        "GET /v1/review-requests": data({
          review_requests: [
            {
              ...pull(),
              review_status: "review_completed",
              assignees: [{ user: { name: "alice" } }],
            },
          ],
          total_count: 1,
        }),
      },
    })((provider, sent) =>
      Effect.gen(function* () {
        const page = yield* provider.listChangeRequests({
          ...REF,
          state: "merged",
          involvement: "reviewing",
          viewer: "alice",
          limit: 500,
          filters: { draft: "hide" },
        });
        const query = sent[0]!.query;
        assert.deepStrictEqual(JSON.parse(query.get("filter")!), {
          repos: ["arcadia"],
          assignees: ["alice"],
          common_status: ["merged"],
          status: "published",
        });
        assert.equal(query.get("order"), "-updated_at,-id");
        assert.equal(query.get("limit"), "100");
        assert.equal(query.get("offset"), "0");
        assert.include(query.get("fields")!, "review_requests(");
        assert.include(query.get("fields")!, "total_count");
        assert.deepStrictEqual(page.items[0]?.reviewRequestLogins, ["alice"]);
        assert.equal(page.items[0]?.reviewDecision, "approved");
        assert.isFalse(page.truncated);
      }),
    ),
  );

  /** A listing ordered newest first, served by offset the way Arcanum pages it. */
  /** Arcanum's own order: newest update first, then highest id. */
  const ordered = (rows: ReadonlyArray<Record<string, unknown>>) =>
    rows.toSorted(
      (left, right) =>
        String(right["updated_at"]).localeCompare(String(left["updated_at"])) ||
        Number(right["id"]) - Number(left["id"]),
    );
  const listing = (rows: () => ReadonlyArray<Record<string, unknown>>) => ({
    "GET /v1/review-requests": (request: { query: URLSearchParams }) => {
      const all = ordered(rows());
      const offset = Number(request.query.get("offset"));
      const limit = Number(request.query.get("limit"));
      return data({ review_requests: all.slice(offset, offset + limit), total_count: all.length });
    },
  });
  const row = (id: number, second: number, satisfied = true) => ({
    ...pull({ id, checks: ciChecks(satisfied ? "success" : "pending") }),
    updated_at: `2026-10-30T09:00:${String(second).padStart(2, "0")}Z`,
  });
  const at = (second: number) => `2026-10-30T09:00:${String(second).padStart(2, "0")}.000Z`;

  it.effect("carries on through a run of rejected rows that all share one instant", () =>
    Effect.gen(function* () {
      // 260 rows still running checks, then 2 that pass, all updated in the same instant: more
      // than one slice reads, so only the position within the tie can move the listing on.
      const rows = [
        ...Array.from({ length: 260 }, (_, index) => row(1000 + index, 50, false)),
        row(2, 50),
        row(1, 50),
      ];
      yield* runProvider({ routes: listing(() => rows) })((provider, sent) =>
        Effect.gen(function* () {
          const list = (cursor?: ProviderListCursor) =>
            provider.listChangeRequests({
              ...REF,
              state: "open",
              involvement: "authored",
              viewer: "alice",
              limit: 2,
              filters: { checks: "passing" },
              ...(cursor === undefined ? {} : { cursor }),
            });
          const first = yield* list();
          // One raw page per slice: the service's own budget decides how many slices it reads.
          assert.equal(sent.length, 1);
          assert.deepStrictEqual(first.items, []);
          assert.isTrue(first.continues && first.truncated);
          assert.equal(first.scannedThrough, at(50));
          // The last row consumed is the 50th rejected one, inside the tie.
          assert.equal(first.resumeAfter, "2026-10-30T09:00:50.000000000Z~1210");
          let page = first;
          let delivered = first.cursorAdvance ?? 0;
          let slices = 1;
          while (page.items.length === 0 && page.continues) {
            page = yield* list({
              updatedBefore: at(50),
              delivered,
              seenAt: [],
              ...(page.resumeAfter === undefined ? {} : { resumeAfter: page.resumeAfter }),
            });
            delivered += page.cursorAdvance ?? 0;
            slices += 1;
          }
          assert.deepStrictEqual(
            page.items.map((item) => item.number),
            [2, 1],
          );
          assert.isFalse(page.continues);
          // Every row was read once, and carrying on where a slice ended cost no probe.
          assert.equal(slices, 6);
          assert.equal(sent.length, 6);
          assert.isTrue(sent.every((request) => request.query.get("limit") !== "1"));
        }),
      );
    }),
  );

  it.effect("never takes another reader's held offsets for where a listing carries on", () =>
    Effect.gen(function* () {
      // Ten rows in one instant, so only the id orders them: 10 first, 1 last.
      let ids = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
      yield* runProvider({ routes: listing(() => ids.map((id) => row(id, 50))) })((provider) =>
        Effect.gen(function* () {
          const after = (id: number, delivered: number) =>
            provider.listChangeRequests({
              ...REF,
              state: "open",
              involvement: "authored",
              viewer: "alice",
              limit: 2,
              cursor: {
                updatedBefore: at(50),
                delivered,
                seenAt: [],
                resumeAfter: `2026-10-30T09:00:50.000000000Z~${id}`,
              },
            });
          // Another reader's continuation leaves its probes and pages behind.
          assert.deepStrictEqual(
            (yield* after(6, 2)).items.map((item) => item.number),
            [5, 4],
          );
          // 10 and 9 leave, so every offset below them moves up two.
          ids = [8, 7, 6, 5, 4, 3, 2, 1];
          const first = yield* after(6, 4);
          assert.deepStrictEqual(
            first.items.map((item) => item.number),
            [5, 4],
          );
          const second = yield* after(4, 4 + (first.cursorAdvance ?? 0));
          assert.deepStrictEqual(
            second.items.map((item) => item.number),
            [3, 2],
          );
        }),
      );
    }),
  );

  it.effect("carries on after the last row consumed, whatever rows before it left or arrived", () =>
    Effect.gen(function* () {
      // 3 and 2 tie at 09:00:57, so Arcanum lists 3 first. 9 and 3 were delivered; since then 9
      // merged and left the open list, and 1 newer pull request arrived, so offsets shifted.
      let rows: ReadonlyArray<Record<string, unknown>> = [
        row(8, 59),
        row(2, 57),
        row(3, 57),
        row(4, 56),
        row(5, 55),
      ];
      const position = "2026-10-30T09:00:57.000000000Z~3";
      yield* runProvider({ routes: listing(() => rows) })((provider) =>
        Effect.gen(function* () {
          const next = (resumeAfter: string | undefined) =>
            provider.listChangeRequests({
              ...REF,
              state: "open",
              involvement: "authored",
              viewer: "alice",
              limit: 2,
              cursor: {
                updatedBefore: at(57),
                delivered: 2,
                seenAt: [3],
                ...(resumeAfter === undefined ? {} : { resumeAfter }),
              },
            });
          const page = yield* next(position);
          // 2 ties 3 but sorts after it, so it is the next row, never skipped or repeated.
          assert.deepStrictEqual(
            page.items.map((item) => item.number),
            [2, 4],
          );
          assert.equal(page.resumeAfter, "2026-10-30T09:00:56.000000000Z~4");
          assert.isTrue(page.continues);
          // A cursor from before positions were kept carries on after its whole millisecond's ties,
          // which the service's seen-at list deduplicates.
          assert.deepStrictEqual(
            (yield* next(undefined)).items.map((item) => item.number),
            [3, 2],
          );
          // Rows above the resume point left: the slice cannot start at the old offset, so it
          // finds the position again rather than skip row 2.
          rows = [row(2, 57), row(4, 56), row(5, 55)];
          yield* provider.forgetChangeRequestReads!();
          assert.deepStrictEqual(
            (yield* next(position)).items.map((item) => item.number),
            [2, 4],
          );
          rows = [row(8, 59)];
          // A listing page answers its exact request for a while, until the service drops reads.
          yield* provider.forgetChangeRequestReads!();
          const emptied = yield* next(position);
          assert.deepStrictEqual(emptied.items, []);
          assert.isFalse(emptied.continues);
        }),
      );
    }),
  );

  it.effect("lists only the viewer's own and assigned pull requests for all, in one order", () =>
    Effect.gen(function* () {
      const involving = (
        id: number,
        second: number,
        author: string,
        assignees: Array<string>,
        satisfied = true,
      ) => ({
        ...row(id, second, satisfied),
        // Arcanum's own precision: a position rounded to milliseconds would misplace the row.
        updated_at: `2026-10-30T09:00:${String(second).padStart(2, "0")}.123456Z`,
        author: { name: author },
        assignees: assignees.map((name) => ({ user: { name } })),
      });
      const rows = [
        involving(10, 59, "alice", []),
        involving(9, 58, "bob", ["alice"], false),
        involving(8, 57, "bob", ["carol"]),
        involving(7, 56, "alice", ["alice"]),
        involving(6, 55, "bob", ["alice"]),
        involving(5, 54, "alice", [], false),
        involving(4, 53, "bob", []),
        involving(3, 52, "alice", ["carol"]),
      ];
      const routes = {
        "GET /v1/review-requests": (request: { query: URLSearchParams }) => {
          const filter = JSON.parse(request.query.get("filter")!) as {
            authors?: Array<string>;
            assignees?: Array<string>;
          };
          const all = ordered(
            rows.filter(
              (candidate) =>
                (filter.authors === undefined || filter.authors.includes(candidate.author.name)) &&
                (filter.assignees === undefined ||
                  candidate.assignees.some(({ user }) => filter.assignees!.includes(user.name))),
            ),
          );
          const offset = Number(request.query.get("offset"));
          const limit = Number(request.query.get("limit"));
          return data({
            review_requests: all.slice(offset, offset + limit),
            total_count: all.length,
          });
        },
      };
      yield* runProvider({ routes })((provider, sent) =>
        Effect.gen(function* () {
          const list = (
            involvement: "all" | "authored",
            filters?: PullRequestListFilters,
            cursor?: ProviderListCursor,
          ) =>
            provider.listChangeRequests({
              ...REF,
              state: "open",
              involvement,
              viewer: "alice",
              limit: 2,
              ...(filters === undefined ? {} : { filters }),
              ...(cursor === undefined ? {} : { cursor }),
            });
          const pagesOf = (filters?: PullRequestListFilters) =>
            Effect.gen(function* () {
              const pages = [yield* list("all", filters)];
              while (pages.at(-1)!.continues) {
                pages.push(
                  yield* list("all", filters, {
                    updatedBefore: at(0),
                    delivered: 0,
                    seenAt: [],
                    resumeAfter: pages.at(-1)!.resumeAfter!,
                  }),
                );
              }
              return pages.map((page) => page.items.map((item) => item.number));
            });
          const first = yield* list("all");
          // The Authored group's own first page is the one `all` just read.
          const reads = sent.length;
          yield* list("authored");
          assert.equal(sent.length, reads);
          assert.deepStrictEqual(
            first.items.map((item) => item.number),
            [10, 9],
          );
          assert.deepStrictEqual(yield* pagesOf(), [
            [10, 9],
            [7, 6],
            [5, 3],
          ]);
          // Rows the provider rejects itself still move each side on, never past the other's.
          assert.deepStrictEqual((yield* pagesOf({ checks: "passing" })).flat(), [10, 7, 6, 3]);
          // One side's first page is a held read from before 10 changed: its fresh copy wins.
          yield* provider.forgetChangeRequestReads!();
          rows.splice(
            0,
            rows.length,
            involving(10, 56, "alice", ["alice"]),
            involving(9, 58, "bob", ["alice"]),
            involving(11, 57, "bob", ["alice"]),
            involving(8, 57, "alice", []),
            involving(6, 50, "bob", ["alice"]),
            involving(5, 51, "alice", []),
            involving(3, 49, "alice", []),
          );
          const three = (involvement: "all" | "reviewing") =>
            provider.listChangeRequests({
              ...REF,
              state: "open",
              involvement,
              viewer: "alice",
              limit: 3,
            });
          yield* three("reviewing");
          rows[0] = involving(10, 59, "alice", ["alice"]);
          assert.deepStrictEqual(
            (yield* three("all")).items.map((item) => item.number),
            [10, 9, 11],
          );
          // Rows a side filters out itself still move its hint on, or a new row strands its read.
          rows.splice(
            0,
            rows.length,
            involving(1, 55, "alice", []),
            involving(2, 53, "alice", []),
            involving(3, 52, "alice", []),
            ...Array.from({ length: 49 }, (_, index) =>
              involving(1000 + index, 54, "bob", ["alice"], false),
            ),
            involving(20, 48, "bob", ["alice"]),
            involving(21, 47, "bob", ["alice"]),
          );
          const passing = yield* list("all", { checks: "passing" });
          assert.deepStrictEqual(
            passing.items.map((item) => item.number),
            [1, 2],
          );
          rows.push(involving(999, 56, "bob", ["alice"], false));
          const after = yield* list(
            "all",
            { checks: "passing" },
            { updatedBefore: at(0), delivered: 0, seenAt: [], resumeAfter: passing.resumeAfter! },
          );
          assert.deepStrictEqual(
            after.items.map((item) => item.number),
            [3, 20],
          );
          // Nothing lists the whole repository, and each side carries on without probing.
          for (const request of sent) {
            const filter = JSON.parse(request.query.get("filter")!) as Record<string, unknown>;
            assert.isTrue("authors" in filter !== "assignees" in filter);
            assert.notEqual(request.query.get("limit"), "1");
          }
        }),
      );
    }),
  );

  it.effect("returns no rows for an author filter that can never match the viewer's own", () =>
    runProvider({ routes: {} })((provider, sent) =>
      Effect.gen(function* () {
        const page = yield* provider.listChangeRequests({
          ...REF,
          state: "open",
          involvement: "authored",
          viewer: "alice",
          limit: 10,
          filters: { author: "bob" },
        });
        assert.deepStrictEqual(page.items, []);
        assert.equal(sent.length, 0);
      }),
    ),
  );
});

describe("ArcanumPullRequestProvider repository routing", () => {
  it.effect("resolves an interactive lookup when a shared background lookup is rate-limited", () =>
    Effect.gen(function* () {
      const entered = yield* Queue.unbounded<void>();
      const release = yield* Deferred.make<void>();
      const cloudia = pull({
        vcs: { arc_repo_name: "cloudia", from_branch: "users/alice/fix", to_branch: "trunk" },
      });
      yield* runProvider({
        routes: {
          "GET /busy": new Response(null, { status: 429, headers: { "retry-after": "60" } }),
          "GET /v1/review-requests/101": data(cloudia),
        },
        gate: (request) =>
          request.path === "/busy"
            ? Queue.offer(entered, undefined).pipe(
                Effect.forkDetach,
                Effect.andThen(Deferred.await(release)),
              )
            : Effect.void,
      })((provider) =>
        Effect.gen(function* () {
          const api = yield* ArcanumApi.ArcanumApi;
          const resolve = provider.resolveChangeRequestRepository!;
          // Every slot is taken by a request about to be rate limited.
          const busy = yield* Effect.all(
            Array.from({ length: 4 }, () =>
              Effect.flip(api.request({ operation: "test", path: "/busy" })),
            ),
            { concurrency: "unbounded" },
          ).pipe(Effect.forkChild);
          yield* Effect.all(Array.from({ length: 4 }, () => Queue.take(entered)));
          const background = yield* Effect.flip(resolve(REF)).pipe(
            Effect.forkChild({ startImmediately: true }),
          );
          const user = yield* resolve(REF).pipe(
            Effect.provideService(SourceControlRateLimit.Interactive, true),
            Effect.forkChild({ startImmediately: true }),
          );
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(busy);
          assert.equal((yield* Fiber.join(background)).reason, "rate-limited");
          assert.equal(yield* Fiber.join(user), "cloudia");
        }),
      );
    }),
  );
});

describe("ArcanumPullRequestProvider detail and actions", () => {
  const checks = [
    { system: "CI", type: "build", required: true, status: "success" },
    { system: "CI", type: "tests", required: true, status: "failure" },
  ];
  const linksPage = (type: string, cursor?: string) =>
    data({
      checks: [{ key: { system: "CI", type }, uri: `https://ci/${type}` }],
      ...(cursor === undefined ? {} : { next_page_cursor: cursor }),
    });
  const routes = (overrides: Record<string, unknown> = {}) => ({
    "GET /v1/review-requests/101": data(pull({ checks, ...overrides })),
    "GET /v2/users/me": account(),
    "GET /v2/public/diff/9001/checks": (request: { query: URLSearchParams }) =>
      request.query.get("cursor") === "page-2" ? linksPage("tests") : linksPage("build", "page-2"),
    "GET /v1/review-requests/101/diff-sets/9001/diff-stats": data({ changes_count: 2 }),
    "PUT /v1/pull-requests/101/auto-merge": null,
    "DELETE /v1/pull-requests/101/auto-merge": null,
    "PATCH /v1/public/review-requests/101/publish": null,
  });

  it.effect(
    "takes checks from the pull request read, and their links only from a checks read",
    () =>
      runProvider({ routes: routes() })((provider, sent) =>
        Effect.gen(function* () {
          const count = (path: string) => sent.filter((request) => request.path === path).length;
          const detail = yield* provider.getChangeRequest(REF);
          assert.equal(detail.headSha, HEAD);
          assert.equal(detail.changedFiles, 2);
          assert.deepStrictEqual(
            detail.checks.map((check) => [check.status, check.url]),
            [
              ["success", null],
              ["failure", null],
            ],
          );
          assert.equal(detail.checksState, "failing");
          assert.deepStrictEqual(
            detail.reviewers.map((reviewer) => reviewer.login),
            ["bob", "carol"],
          );
          assert.deepStrictEqual(detail.viewerPermissions.actions, ["enable-auto-merge"]);
          // The method stays offered while merging waits, or auto-merge has no method to arm.
          assert.isTrue(detail.mergeCapabilities.merge);
          assert.isFalse(detail.autoMergeEnabled);
          assert.equal(count("/v2/public/diff/9001/checks"), 0);

          const read = yield* provider.getChangeRequestChecks!(REF);
          assert.deepStrictEqual(
            read.checks.map((check) => check.url),
            ["https://ci/build", "https://ci/tests"],
          );
          assert.equal(count("/v2/public/diff/9001/checks"), 2);

          // An iteration's stats and its links are shared past the pull request read.
          yield* provider.getChangeRequest(REF);
          yield* provider.getChangeRequestChecks!(REF);
          assert.equal(count("/v1/review-requests/101/diff-sets/9001/diff-stats"), 1);
          assert.equal(count("/v2/public/diff/9001/checks"), 2);
        }),
      ),
  );

  it.effect("keeps the checks when their links cannot be read in full", () =>
    runProvider({
      routes: {
        ...routes(),
        "GET /v2/public/diff/9001/checks": linksPage("build", "again"),
      },
    })((provider) =>
      Effect.gen(function* () {
        const read = yield* provider.getChangeRequestChecks!(REF);
        assert.deepStrictEqual(
          read.checks.map((check) => [check.status, check.url]),
          [
            ["success", null],
            ["failure", null],
          ],
        );
      }),
    ),
  );

  it.effect("reads a pull request once per open, afresh for a write, and per credential", () =>
    Effect.gen(function* () {
      let mergeAllowed = false;
      yield* runProvider({
        routes: {
          ...routes(),
          "GET /v1/review-requests/101": () => data(pull({ merge_allowed: mergeAllowed })),
          "GET /v2/public/diff/9001/checks": data({ checks: [] }),
          "GET /v1/public/review-requests/101/comments": data([]),
          "GET /v2/public/diff/9001/comment": data([]),
          "POST /v2/public/pull-request/101/comment": data({ id: -1 }),
        },
        review: {
          rangeCommits: () => Effect.succeed({ commits: [], truncated: false }),
        },
      })((provider, sent) =>
        Effect.gen(function* () {
          const pulls = () => sent.filter((request) => request.path === "/v1/review-requests/101");
          yield* Effect.all(
            [provider.getChangeRequest(REF), provider.getChangeRequestActivity(REF)],
            {
              concurrency: 2,
            },
          );
          yield* provider.getChangeRequestPreview!(REF);
          yield* provider.getChangeRequestWatchFingerprint!(REF);
          assert.equal(pulls().length, 1);
          assert.equal(sent.filter((request) => request.path === "/v2/users/me").length, 1);

          // The permission check before a write asks Arcanum, and the write rests on that read.
          yield* provider.getViewerPermissions({ ...REF, includeUpdateBranch: false });
          assert.equal(pulls().length, 2);
          yield* provider.comment({ ...REF, body: "hi" });
          assert.equal(pulls().length, 2);

          // A write drops every shared read, and a merge decides on a read of its own.
          mergeAllowed = true;
          yield* provider.getChangeRequest(REF);
          assert.equal(pulls().length, 3);
          mergeAllowed = false;
          const refused = yield* Effect.flip(provider.runAction({ ...REF, action: "merge" }));
          assert.include(refused.detail, "requirements");
          assert.equal(pulls().length, 4);

          // A replaced token never reads the previous one's answers.
          const settings = yield* TestSourceControlHost.TestSourceControlHostSettings;
          yield* settings.update({ sourceControlHosts: { arcanum: { token: "second" } } });
          yield* provider.getChangeRequestPreview!(REF);
          assert.equal(pulls().length, 5);
          assert.equal(pulls().at(-1)?.authorization, "OAuth second");
        }),
      );
    }),
  );

  it.effect("decides a write on a fresh read, never on one another reader holds", () =>
    Effect.gen(function* () {
      let head = HEAD;
      const iteration = () => ({
        id: head === HEAD ? 9001 : 9002,
        status: "published",
        has_conflicts: false,
        patch_stats: { additions: 1, deletions: 0 },
        arc_branch_heads: { from_id: head, to_id: BASE, merge_id: MERGE },
      });
      yield* runProvider({
        routes: {
          ...routes(),
          "GET /v1/review-requests/101": () => data(pull({ active_diff_set: iteration() })),
          "GET /v2/public/diff/9002/changelist": data(changelist),
          "PUT /v1/review-requests/101/reviewed-files": null,
        },
      })((provider, sent) =>
        Effect.gen(function* () {
          yield* provider.getChangeRequestPreview!(REF);
          // A new iteration lands while that read is still shared.
          head = H("4");
          const stale = yield* Effect.flip(
            provider.runReviewAction!({ ...REF, actionId: "unship", expectedHeadSha: HEAD }),
          );
          assert.include(stale.detail, "changed");
          yield* provider.getChangeRequestPreview!(REF);
          yield* provider.setFilesViewed!({
            ...REF,
            files: [{ path: "adv/frontend/a.ts", viewed: true }],
          });
          // Entry ids come from the iteration Arcanum shows now.
          assert.isTrue(sent.some((request) => request.path === "/v2/public/diff/9002/changelist"));
          assert.equal(
            sent.filter((request) => request.path === "/v1/review-requests/101").length,
            3,
          );
        }),
      );
    }),
  );

  it.effect("refuses a pull request from another repository", () =>
    runProvider({
      routes: routes({ vcs: { arc_repo_name: "other", from_branch: "x/y", to_branch: "trunk" } }),
    })((provider) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(provider.getChangeRequest(REF));
        assert.equal(error.reason, "not-found");
      }),
    ),
  );

  it.effect("merges only when a fresh read says Arcanum allows it, and only by auto-merge", () =>
    Effect.gen(function* () {
      yield* runProvider({ routes: routes() })((provider, sent) =>
        Effect.gen(function* () {
          const refused = yield* Effect.flip(provider.runAction({ ...REF, action: "merge" }));
          assert.include(refused.detail, "requirements");
          assert.deepStrictEqual(writes(sent), []);
          const close = yield* Effect.flip(provider.runAction({ ...REF, action: "close" }));
          assert.include(close.detail, "no close");
          const squash = yield* Effect.flip(
            provider.runAction({ ...REF, action: "merge", mergeMethod: "squash" }),
          );
          assert.include(squash.detail, "merge commit");
          yield* provider.runAction({ ...REF, action: "enable-auto-merge" });
          assert.deepStrictEqual(writes(sent), ["PUT /v1/pull-requests/101/auto-merge"]);
        }),
      );
      yield* runProvider({ routes: routes({ merge_allowed: true }) })((provider, sent) =>
        Effect.gen(function* () {
          yield* provider.runAction({ ...REF, action: "merge" });
          assert.deepStrictEqual(writes(sent), ["PUT /v1/pull-requests/101/auto-merge"]);
          const enable = yield* Effect.flip(
            provider.runAction({ ...REF, action: "enable-auto-merge" }),
          );
          assert.include(enable.detail, "not available");
        }),
      );
      yield* runProvider({
        routes: routes({ policies: { auto_merge: "on_satisfied_requirements" } }),
      })((provider, sent) =>
        Effect.gen(function* () {
          yield* provider.runAction({ ...REF, action: "disable-auto-merge" });
          assert.deepStrictEqual(writes(sent), ["DELETE /v1/pull-requests/101/auto-merge"]);
        }),
      );
    }),
  );

  it.effect("publishes a draft only for its author", () =>
    Effect.gen(function* () {
      const draft = {
        common_status: "draft",
        active_diff_set: { ...pull().active_diff_set, status: "draft" },
      };
      yield* runProvider({ routes: routes(draft) })((provider, sent) =>
        Effect.gen(function* () {
          yield* provider.runAction({ ...REF, action: "ready" });
          assert.deepStrictEqual(writes(sent), ["PATCH /v1/public/review-requests/101/publish"]);
        }),
      );
      yield* runProvider({ routes: routes(draft), user: "bob" })((provider) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(provider.runAction({ ...REF, action: "ready" }));
          assert.include(error.detail, "not available");
        }),
      );
    }),
  );
});

describe("ArcanumPullRequestProvider content", () => {
  const diffCalls: Array<unknown> = [];
  const contentCalls: Array<unknown> = [];
  const review = (
    respond: (input: { commit: string; file?: { path: string } | undefined }) => {
      parent: string;
      patch: string;
      truncated: boolean;
      files?: ReadonlyArray<ReviewDiffFileStat>;
    },
    rangeCommits?: SourceControlHost.SourceControlHost["Service"]["review"]["rangeCommits"],
  ): Partial<SourceControlHost.SourceControlHost["Service"]["review"]> => ({
    ...(rangeCommits === undefined ? {} : { rangeCommits }),
    commitDiff: (input) =>
      Effect.sync(() => {
        diffCalls.push(input);
        return respond(input);
      }),
    commitFileContents: (input) =>
      Effect.sync(() => {
        contentCalls.push(input);
        return { oldContents: "old", newContents: "new" };
      }),
  });
  const routes = {
    "GET /v1/review-requests/101": data(pull()),
    "GET /v2/public/diff/9001/changelist": data(changelist),
  };

  it.effect("diffs Arcanum's merge against the base, never the pushed head", () =>
    Effect.gen(function* () {
      diffCalls.length = 0;
      yield* runProvider({
        routes,
        review: review(() => ({ parent: BASE, patch: "diff --git a/x b/x\n", truncated: false })),
      })((provider) =>
        Effect.gen(function* () {
          const slice = yield* provider.getDiff(REF);
          assert.deepStrictEqual(slice, {
            patch: "diff --git a/x b/x\n",
            truncated: false,
            nextCursor: null,
          });
          assert.deepStrictEqual(diffCalls, [{ cwd: REF.cwd, commit: MERGE }]);
          yield* provider.getDiffFileContents!({
            ...REF,
            changeType: "rename-changed",
            oldPath: "devtools/old.ts",
            newPath: "devtools/b.ts",
          });
          assert.deepStrictEqual(contentCalls.at(-1), {
            cwd: REF.cwd,
            parent: BASE,
            commit: MERGE,
            changeType: "rename-changed",
            oldPath: "devtools/old.ts",
            newPath: "devtools/b.ts",
          });
        }),
      );
    }),
  );

  const stat = (path: string) => ({ path, previousPath: null, additions: 1, deletions: 0 });
  // Arc's own list of the merge's files: a move is a deletion and an addition.
  const mergeFiles = Array.from({ length: 26 }, (_, index) =>
    stat(`devtools/f${String(index).padStart(2, "0")}.ts`),
  );

  it.effect(
    "pages a large diff by the VCS's own file list, across the whole repository, bound to the iteration",
    () =>
      Effect.gen(function* () {
        diffCalls.length = 0;
        yield* runProvider({
          routes: { "GET /v1/review-requests/101": data(pull()) },
          review: review((input) =>
            input.file === undefined
              ? { parent: BASE, patch: "huge", truncated: true, files: mergeFiles }
              : { parent: BASE, patch: `diff --git a/${input.file.path}\n`, truncated: false },
          ),
        })((provider, sent) =>
          Effect.gen(function* () {
            const first = yield* provider.getDiff(REF);
            assert.equal(first.nextCursor, "9001:25");
            assert.deepStrictEqual(diffCalls[1], {
              cwd: REF.cwd,
              commit: MERGE,
              file: { path: "devtools/f00.ts", previousPath: null },
            });
            diffCalls.length = 0;
            const second = yield* provider.getDiff({ ...REF, cursor: first.nextCursor! });
            assert.equal(second.patch, "diff --git a/devtools/f25.ts\n");
            assert.isNull(second.nextCursor);
            // The iteration fixes the file list, so the continuation reads only its own files.
            assert.deepStrictEqual(diffCalls, [
              {
                cwd: REF.cwd,
                commit: MERGE,
                file: { path: "devtools/f25.ts", previousPath: null },
              },
            ]);
            // The structure comes from Arc, never from Arcanum.
            assert.isTrue(sent.every((request) => !request.path.endsWith("/changelist")));
            const stale = yield* Effect.flip(provider.getDiff({ ...REF, cursor: "9000:25" }));
            assert.include(stale.detail, "changed");
          }),
        );
      }),
  );

  it.effect("fails a large diff Arc does not list the files of, with no Arcanum fallback", () =>
    runProvider({
      routes: { "GET /v1/review-requests/101": data(pull()) },
      review: review(() => ({ parent: BASE, patch: "huge", truncated: true })),
    })((provider, sent) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(provider.getDiff(REF));
        assert.include(error.detail, "did not list");
        assert.deepStrictEqual(
          sent.map((request) => request.path),
          ["/v1/review-requests/101"],
        );
      }),
    ),
  );

  it.effect("lists a commit's own files, once the commit is shown to be on the pull request", () =>
    Effect.gen(function* () {
      diffCalls.length = 0;
      const onBranch = H("7");
      const ranges: Array<unknown> = [];
      yield* runProvider({
        routes,
        review: review(
          (input) =>
            input.commit === MERGE
              ? {
                  parent: BASE,
                  patch: "diff --git a/adv/frontend/a.ts b/adv/frontend/a.ts\n",
                  truncated: false,
                  files: [
                    stat("adv/frontend/a.ts"),
                    { ...stat("devtools/b.ts"), previousPath: "devtools/old.ts" },
                  ],
                }
              : {
                  parent: H("6"),
                  // A file the commit touched that the final pull request no longer changes.
                  patch:
                    "diff --git a/devtools/tmp.ts b/devtools/tmp.ts\nnew file mode 100644\n--- /dev/null\n+++ b/devtools/tmp.ts\n@@ -0,0 +1 @@\n+x\n",
                  truncated: false,
                },
          (input) =>
            Effect.sync(() => {
              ranges.push(input);
              return {
                commits: [{ sha: onBranch, subject: "wip", committedAt: "2026-10-30T10:00:00Z" }],
                truncated: false,
              };
            }),
        ),
      })((provider, sent) =>
        Effect.gen(function* () {
          const foreign = yield* Effect.flip(
            provider.getDiffFilePaths!({ ...REF, commit: H("8") }),
          );
          assert.include(foreign.detail, "not on this pull request");
          assert.deepStrictEqual(diffCalls, []);
          const paths = yield* provider.getDiffFilePaths!({ ...REF, commit: onBranch });
          assert.deepStrictEqual(paths.files, [
            { oldPath: "devtools/tmp.ts", newPath: "devtools/tmp.ts" },
          ]);
          assert.deepStrictEqual(diffCalls, [{ cwd: REF.cwd, commit: onBranch }]);
          // The pull request's history is read through Arc, between the iteration's own hashes.
          assert.deepStrictEqual(ranges, [
            { cwd: REF.cwd, base: BASE, head: HEAD, limit: 250 },
            { cwd: REF.cwd, base: BASE, head: HEAD, limit: 250 },
          ]);
          // The whole pull request's files, where a move is listed as both of the patch's halves.
          const all = yield* provider.getDiffFilePaths!(REF);
          assert.deepStrictEqual(all.files, [
            { oldPath: "adv/frontend/a.ts", newPath: "adv/frontend/a.ts" },
            { oldPath: "devtools/old.ts", newPath: "devtools/b.ts" },
            { oldPath: "devtools/old.ts", newPath: "devtools/old.ts" },
            { oldPath: "devtools/b.ts", newPath: "devtools/b.ts" },
          ]);
          assert.isTrue(sent.every((request) => !request.path.endsWith("/changelist")));
        }),
      );
    }),
  );

  it.effect("fails rather than mixing iterations when the merge's parent is not the base", () =>
    runProvider({
      routes,
      review: review(() => ({ parent: H("9"), patch: "x", truncated: false })),
    })((provider) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(provider.getDiff(REF));
        assert.include(error.detail, "changed");
      }),
    ),
  );

  it.effect("reads and writes viewed marks by the changelist's own entry ids", () =>
    runProvider({ routes: { ...routes, "PUT /v1/review-requests/101/reviewed-files": null } })(
      (provider, sent) =>
        Effect.gen(function* () {
          const viewed = yield* provider.getFilesViewed!(REF);
          const changelistReads = () =>
            sent.filter((request) => request.path === "/v2/public/diff/9001/changelist").length;
          // The move's old path is the deleted half Arc's patch shows: the same entry, same mark.
          assert.deepStrictEqual(viewed.files, [
            { path: "adv/frontend/a.ts", state: "viewed" },
            { path: "devtools/b.ts", state: "unviewed" },
            { path: "devtools/old.ts", state: "unviewed" },
          ]);
          yield* provider.setFilesViewed!({
            ...REF,
            files: [
              { path: "devtools/b.ts", viewed: true },
              { path: "devtools/old.ts", viewed: true },
              { path: "adv/frontend/a.ts", viewed: false },
            ],
          });
          yield* provider.setFilesViewed!({
            ...REF,
            files: [{ path: "devtools/old.ts", viewed: false }],
          });
          // Entry ids come from the iteration's held changelist; marks are read afresh after.
          assert.equal(changelistReads(), 1);
          yield* provider.getFilesViewed!(REF);
          assert.equal(changelistReads(), 2);
          // Each write reads the iteration afresh; the reads around them share one.
          assert.equal(
            sent.filter((request) => request.path === "/v1/review-requests/101").length,
            3,
          );
          assert.deepStrictEqual(
            sent.filter((request) => request.method === "PUT").map((request) => request.body),
            [
              { entry_ids: ["eid:1:B"], reviewed: true },
              { entry_ids: ["eid:1:A/b+c=="], reviewed: false },
              { entry_ids: ["eid:1:B"], reviewed: false },
            ],
          );
          const conflicting = yield* Effect.flip(
            provider.setFilesViewed!({
              ...REF,
              files: [
                { path: "devtools/b.ts", viewed: true },
                { path: "devtools/old.ts", viewed: false },
              ],
            }),
          );
          assert.include(conflicting.detail, "one moved file");
          assert.equal(sent.filter((request) => request.method === "PUT").length, 3);
          const unknown = yield* Effect.flip(
            provider.setFilesViewed!({ ...REF, files: [{ path: "nope.ts", viewed: true }] }),
          );
          assert.include(unknown.detail, "nope.ts");
        }),
    ),
  );
});

describe("ArcanumPullRequestProvider reviews", () => {
  const draftComment = {
    path: "devtools/b.ts",
    position: { kind: "added" as const, newLine: 12 },
    startPosition: { kind: "added" as const, newLine: 10 },
    body: "Tighten this",
  };
  let nextInline = 700;
  const routes = (overrides: Record<string, unknown> = {}) => ({
    "GET /v1/review-requests/101": data(pull()),
    "GET /v2/users/me": account(),
    "GET /v2/public/diff/9001/changelist": data(changelist),
    "POST /v2/public/diff/9001/comment": () => data({ id: nextInline++, content: "x" }),
    "POST /v2/public/pull-request/101/comment": data({ id: -900, content: "x" }),
    "POST /v1/public/draft-comments": data({ published: [] }),
    "POST /v1/review-requests/101/diff-sets/9001/ship": null,
    "POST /v1/review-requests/101/diff-sets/9001/request-for-changes": data("waiting_for_changes"),
    "DELETE /v1/public/review-requests-comments/700": null,
    "DELETE /v1/public/review-requests-comments/-900": null,
    "GET /v1/public/review-requests-comments/700": data({
      id: 700,
      draft: true,
      user: { name: "alice" },
    }),
    "GET /v1/public/review-requests-comments/-900": data({
      id: -900,
      draft: true,
      user: { name: "alice" },
    }),
    ...overrides,
  });

  it.effect(
    "drafts each comment once, publishes exactly those, then ships the reviewed iteration",
    () =>
      Effect.gen(function* () {
        nextInline = 700;
        yield* runProvider({ routes: routes() })((provider, sent) =>
          Effect.gen(function* () {
            yield* provider.submitReview({
              ...REF,
              verdict: "approve",
              body: "LGTM with a nit",
              comments: [draftComment],
            });
            assert.deepStrictEqual(writes(sent), [
              "POST /v2/public/diff/9001/comment",
              "POST /v2/public/pull-request/101/comment",
              "POST /v1/public/draft-comments",
              "POST /v1/review-requests/101/diff-sets/9001/ship",
            ]);
            const posts = sent.filter((request) => request.method === "POST");
            assert.deepStrictEqual(posts[0]?.body, {
              content: "Tighten this",
              is_draft: true,
              entry_id: "eid:1:B",
              line: 10,
              side: "new",
              size: 3,
            });
            assert.deepStrictEqual(posts[1]?.body, { content: "LGTM with a nit", is_draft: true });
            assert.isString(posts[0]?.idempotencyKey);
            assert.notEqual(posts[0]?.idempotencyKey, posts[1]?.idempotencyKey);
            assert.deepStrictEqual(posts[2]?.body, {
              comment_for_diff_ids: [700],
              comment_for_review_ids: [-900],
            });
            assert.equal(posts[3]?.query.get("sticky"), "false");
          }),
        );
      }),
  );

  it.effect("refuses a decision the viewer cannot take before drafting anything", () =>
    runProvider({
      routes: routes({
        "GET /v1/review-requests/101": data(
          pull({ active_diff_set: { ...pull().active_diff_set, status: "draft" } }),
        ),
      }),
    })((provider, sent) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          provider.submitReview({
            ...REF,
            verdict: "request-changes",
            body: "Needs work",
            comments: [draftComment],
          }),
        );
        assert.include(error.detail, "Publish the iteration");
        assert.deepStrictEqual(writes(sent), []);
      }),
    ),
  );

  it.effect("comments on a moved file's old path through the move's entry, on the old side", () =>
    Effect.gen(function* () {
      nextInline = 700;
      const oldHalf = {
        path: "devtools/old.ts",
        position: { kind: "deleted" as const, oldLine: 4 },
        body: "Why was this dropped?",
      };
      yield* runProvider({ routes: routes() })((provider, sent) =>
        Effect.gen(function* () {
          yield* provider.submitReview({
            ...REF,
            verdict: "comment",
            body: "",
            comments: [oldHalf, draftComment],
          });
          const inline = sent.filter(
            (request) =>
              request.method === "POST" && request.path === "/v2/public/diff/9001/comment",
          );
          assert.deepStrictEqual(
            inline.map((request) => request.body),
            [
              {
                content: "Why was this dropped?",
                is_draft: true,
                entry_id: "eid:1:B",
                line: 4,
                side: "old",
                size: 1,
              },
              {
                content: "Tighten this",
                is_draft: true,
                entry_id: "eid:1:B",
                line: 10,
                side: "new",
                size: 3,
              },
            ],
          );
          // Exactly the drafts this review made were published.
          assert.deepStrictEqual(
            sent.find((request) => request.path === "/v1/public/draft-comments")?.body,
            { comment_for_diff_ids: [700, 701], comment_for_review_ids: [] },
          );
        }),
      );
      yield* runProvider({ routes: routes() })((provider, sent) =>
        Effect.gen(function* () {
          const added = yield* Effect.flip(
            provider.submitReview({
              ...REF,
              verdict: "comment",
              body: "",
              comments: [{ ...oldHalf, position: { kind: "added", newLine: 4 } }],
            }),
          );
          assert.include(added.detail, "removed lines");
          assert.deepStrictEqual(writes(sent), []);
        }),
      );
    }),
  );

  it.effect(
    "cleans up only its own drafts when a newer iteration arrives, and sends no verdict",
    () =>
      Effect.gen(function* () {
        nextInline = 700;
        let reads = 0;
        yield* runProvider({
          routes: routes({
            "GET /v1/review-requests/101": () =>
              data(
                reads++ === 0
                  ? pull()
                  : pull({ active_diff_set: { ...pull().active_diff_set, id: 9002 } }),
              ),
          }),
        })((provider, sent) =>
          Effect.gen(function* () {
            const error = yield* Effect.flip(
              provider.submitReview({
                ...REF,
                verdict: "approve",
                body: "",
                comments: [draftComment],
              }),
            );
            assert.include(error.detail, "changed");
            assert.deepStrictEqual(writes(sent), [
              "POST /v2/public/diff/9001/comment",
              "DELETE /v1/public/review-requests-comments/700",
            ]);
          }),
        );
      }),
  );

  it.effect("reads back a publish whose answer was lost, and never publishes twice", () =>
    Effect.gen(function* () {
      nextInline = 700;
      // The drafts went out: Arcanum now reports them published.
      const published = {
        draft: false,
        published_at: "2026-10-30T12:00:00Z",
        user: { name: "alice" },
      };
      yield* runProvider({
        routes: routes({
          "POST /v1/public/draft-comments": jsonResponse(503, null),
          "GET /v1/public/review-requests-comments/700": data({ id: 700, ...published }),
          "GET /v1/public/review-requests-comments/-900": data({ id: -900, ...published }),
        }),
      })((provider, sent) =>
        Effect.gen(function* () {
          yield* provider.submitReview({
            ...REF,
            verdict: "request-changes",
            body: "Please fix",
            comments: [draftComment],
          });
          assert.deepStrictEqual(writes(sent), [
            "POST /v2/public/diff/9001/comment",
            "POST /v2/public/pull-request/101/comment",
            "POST /v1/public/draft-comments",
            "POST /v1/review-requests/101/diff-sets/9001/request-for-changes",
          ]);
        }),
      );
      nextInline = 700;
      yield* runProvider({
        routes: routes({ "POST /v1/public/draft-comments": jsonResponse(503, null) }),
      })((provider, sent) =>
        Effect.gen(function* () {
          // Still drafts after a lost answer, but the publish may yet land: nothing is deleted,
          // nothing is published again, and no verdict goes out.
          const error = yield* Effect.flip(
            provider.submitReview({
              ...REF,
              verdict: "approve",
              body: "x",
              comments: [draftComment],
            }),
          );
          assert.include(error.detail, "0 of 2 comments read as published");
          assert.include(error.detail, "No verdict was sent");
          assert.deepStrictEqual(writes(sent), [
            "POST /v2/public/diff/9001/comment",
            "POST /v2/public/pull-request/101/comment",
            "POST /v1/public/draft-comments",
          ]);
          assert.isFalse(writes(sent).includes("POST /v1/review-requests/101/diff-sets/9001/ship"));
        }),
      );
      nextInline = 700;
      // Half landed by the time it is read back: still nothing deleted, and no verdict.
      yield* runProvider({
        routes: routes({
          "POST /v1/public/draft-comments": jsonResponse(503, null),
          "GET /v1/public/review-requests-comments/700": data({ id: 700, ...published }),
        }),
      })((provider, sent) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            provider.submitReview({
              ...REF,
              verdict: "approve",
              body: "x",
              comments: [draftComment],
            }),
          );
          assert.include(error.detail, "1 of 2 comments read as published");
          assert.isFalse(writes(sent).some((write) => write.startsWith("DELETE")));
          assert.isFalse(writes(sent).some((write) => write.endsWith("/ship")));
        }),
      );
    }),
  );

  it.effect("refuses a range that crosses sides before writing anything", () =>
    runProvider({ routes: routes() })((provider, sent) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          provider.submitReview({
            ...REF,
            verdict: "comment",
            body: "",
            comments: [{ ...draftComment, startPosition: { kind: "deleted", oldLine: 3 } }],
          }),
        );
        assert.include(error.detail, "one side");
        assert.deepStrictEqual(writes(sent), []);
      }),
    ),
  );
});

describe("ArcanumPullRequestProvider review events", () => {
  it.effect("reads review decisions in one request of their own, shared for a minute", () =>
    runProvider({
      routes: {
        "GET /v1/plugin/pull-request/101/activity": data({
          activities: [
            {
              activity: "approved",
              id: "aid:1",
              action_time: "2026-11-01T10:00:00.000000Z",
              ship: { login: "bob" },
            },
            {
              activity: "merge_requirements_changed",
              id: "aid:2",
              action_time: "2026-11-01T10:01:00.000000Z",
              merge_requirement: { system: "ci", type: "build" },
            },
            {
              activity: "block_merge",
              id: "aid:3",
              action_time: "2026-11-01T10:02:00.000000Z",
              ship: { login: "robot-reviewer", review_system: { slug: "ai" } },
            },
            {
              activity: "commented",
              id: "aid:4",
              action_time: "2026-11-01T10:03:00.000000Z",
              comments: [{ id: 1, content: "Read with the activity, not here" }],
            },
            {
              activity: "unapproved",
              id: "aid:5",
              action_time: "2026-11-01T10:04:00.000000Z",
              ship: { login: "bob" },
            },
          ],
        }),
      },
    })((provider, sent) =>
      Effect.gen(function* () {
        const events = yield* provider.getChangeRequestReviewEvents!(REF);
        assert.deepStrictEqual(
          events.map((event) => [event.author?.login, event.author?.isBot, event.reviewState]),
          [
            ["bob", undefined, "APPROVED"],
            ["robot-reviewer", true, "BLOCKED_MERGE"],
            ["bob", undefined, "WITHDREW_SHIP"],
          ],
        );
        assert.isTrue(
          events.every(
            (event) => event.kind === "review" && event.body === "" && event.canReact === false,
          ),
        );
        yield* provider.getChangeRequestReviewEvents!(REF);
        assert.deepStrictEqual(
          sent.map((request) => request.path),
          ["/v1/plugin/pull-request/101/activity"],
        );
      }),
    ),
  );
});

describe("ArcanumPullRequestProvider check actions", () => {
  const services = [
    { id: "Arcadia CI Approvals", configuration_state: "configure_pending" },
    { id: "ci", configuration_state: "completed" },
  ];
  const actionState = (overrides: Record<string, unknown> = {}) =>
    pull({
      services,
      checks: [
        {
          system: "ci",
          type: "build",
          required: true,
          status: "failure",
          configuration: { restartable: true, disabling_policy: "need_reason" },
        },
        {
          system: "ci",
          type: "large_tests",
          required: false,
          status: "unknown",
          configuration: { disabling_policy: "allowed" },
        },
        {
          system: "arcanum",
          type: "approved",
          required: true,
          status: "pending",
          configuration: { restartable: false, disabling_policy: "denied" },
        },
      ],
      ...overrides,
    });
  const routes = (overrides: Record<string, unknown> = {}) => ({
    "GET /v1/review-requests/101": data(actionState(overrides)),
    "GET /v2/users/me": account(),
    "GET /v1/review-requests/101/diff-sets/9001/diff-stats": data({ changes_count: 2 }),
    "POST /v1/review-requests/101/restarting-checks": null,
    "POST /v1/review-requests/101/check-requirements": null,
    "DELETE /v1/review-requests/101/diff-sets/9001/services/Arcadia%20CI%20Approvals": null,
  });

  it.effect("offers check actions from the reads the detail already makes", () =>
    Effect.gen(function* () {
      yield* runProvider({ routes: routes() })((provider, sent) =>
        Effect.gen(function* () {
          const detail = yield* provider.getChangeRequest(REF);
          assert.deepStrictEqual(
            detail.checks.map((check) => check.actions),
            [
              [
                { id: "restart:ci:build", label: "Restart", available: true },
                {
                  id: "unrequire:ci:build",
                  label: "Stop requiring",
                  available: true,
                  reason: "required",
                },
              ],
              [{ id: "require:ci:large_tests", label: "Require", available: true }],
            ],
          );
          assert.deepStrictEqual(detail.checkActions, [
            {
              id: "skip-service:Arcadia%20CI%20Approvals",
              label: "Stop waiting for Arcadia CI Approvals",
              available: true,
            },
          ]);
          assert.deepStrictEqual(
            sent.map((request) => request.path),
            [
              "/v1/review-requests/101",
              "/v2/users/me",
              "/v1/review-requests/101/diff-sets/9001/diff-stats",
            ],
          );
          assert.include(sent[0]?.query.get("fields") ?? "", "services(id,configuration_state)");
        }),
      );
      // A closed pull request's checks can no longer change.
      yield* runProvider({ routes: routes({ full_status: "discarded" }) })((provider) =>
        Effect.gen(function* () {
          const detail = yield* provider.getChangeRequest(REF);
          assert.isTrue(detail.checks.every((check) => check.actions === undefined));
          assert.deepStrictEqual(detail.checkActions, []);
        }),
      );
    }),
  );

  it.effect("runs each action as its own write after one fresh read", () =>
    Effect.gen(function* () {
      const cases = [
        [
          "restart:ci:build",
          undefined,
          "POST /v1/review-requests/101/restarting-checks",
          { system: "ci", type: "build" },
        ],
        [
          "unrequire:ci:build",
          "flaky on trunk",
          "POST /v1/review-requests/101/check-requirements",
          { system: "ci", type: "build", enabled: false, reason: { text: "flaky on trunk" } },
        ],
        [
          "require:ci:large_tests",
          undefined,
          "POST /v1/review-requests/101/check-requirements",
          { system: "ci", type: "large_tests", enabled: true },
        ],
        [
          "skip-service:Arcadia%20CI%20Approvals",
          undefined,
          "DELETE /v1/review-requests/101/diff-sets/9001/services/Arcadia%20CI%20Approvals",
          undefined,
        ],
      ] as const;
      for (const [actionId, reason, write, body] of cases) {
        yield* runProvider({ routes: routes() })((provider, sent) =>
          Effect.gen(function* () {
            yield* provider.runCheckAction!({
              ...REF,
              actionId,
              expectedHeadSha: HEAD,
              ...(reason === undefined ? {} : { reason }),
            });
            assert.deepStrictEqual(writes(sent), [write]);
            assert.deepStrictEqual(sent.at(-1)?.body, body);
            assert.equal(sent.length, 2);
            assert.include(sent[0]?.query.get("fields") ?? "", "configuration(restartable");
          }),
        );
      }
    }),
  );

  it.effect("refuses before writing when the fresh read does not allow the action", () =>
    Effect.gen(function* () {
      const refusals = [
        [routes(), "restart:arcanum:approved", HEAD, undefined, "does not let this check restart"],
        [routes(), "unrequire:ci:build", HEAD, undefined, "needs a reason"],
        [routes(), "unrequire:arcanum:approved", HEAD, "why", "does not let anyone"],
        [routes(), "require:ci:build", HEAD, undefined, "already required"],
        [routes(), "restart:ci:gone", HEAD, undefined, "no longer on this pull request"],
        [routes(), "skip-service:ci", HEAD, undefined, "no longer waits for ci"],
        [routes(), "restart:ci:build", BASE, undefined, "changed while it was being read"],
        [routes(), "restart:ci:build", undefined, undefined, "changed while it was being read"],
        [
          routes({ full_status: "discarded" }),
          "require:ci:large_tests",
          HEAD,
          undefined,
          "no longer open",
        ],
        [routes(), "delete-everything", HEAD, undefined, "no delete-everything check action"],
      ] as const;
      for (const [scripted, actionId, expectedHeadSha, reason, detail] of refusals) {
        yield* runProvider({ routes: scripted })((provider, sent) =>
          Effect.gen(function* () {
            const error = yield* Effect.flip(
              provider.runCheckAction!({
                ...REF,
                actionId,
                ...(expectedHeadSha === undefined ? {} : { expectedHeadSha }),
                ...(reason === undefined ? {} : { reason }),
              }),
            );
            assert.include(error.detail, detail);
            assert.deepStrictEqual(writes(sent), []);
          }),
        );
      }
    }),
  );
});

describe("ArcanumPullRequestProvider review decisions", () => {
  const routes = (pullOverrides: Record<string, unknown> = {}, who = account()) => ({
    "GET /v1/review-requests/101": data(
      pull({ outstaff: false, caps: { disable_sticky_ships: false }, ...pullOverrides }),
    ),
    "GET /v2/users/me": who,
    "GET /v1/review-requests/101/diff-sets/9001/diff-stats": data({ changes_count: 2 }),
    "POST /v1/review-requests/101/diff-sets/9001/ship": null,
    "DELETE /v1/review-requests/101/diff-sets/9001/ship": null,
    "POST /v1/review-requests/101/diff-sets/9001/block-merge": null,
    "DELETE /v1/review-requests/101/diff-sets/9001/block-merge": null,
    "DELETE /v1/review-requests/101/diff-sets/9001/request-for-changes": null,
  });
  const voted = (action: string) => ({
    review: {
      review_status: "review_in_progress",
      reviewers: [{ user: { name: "alice" }, action }],
    },
  });

  it.effect("reports reviewer standing, completion and decisions in the one detail read", () =>
    runProvider({
      routes: routes({
        review: {
          review_status: "review_in_progress",
          completion_percent: 50,
          reviewers: [
            { user: { name: "bob" }, action: "sticky_ship" },
            { user: { name: "alice" }, action: "block_merge" },
          ],
        },
      }),
    })((provider, sent) =>
      Effect.gen(function* () {
        const detail = yield* provider.getChangeRequest(REF);
        assert.equal(detail.reviewStatus?.completionPercent, 50);
        assert.deepStrictEqual(
          detail.reviewStatus?.reviewers.map((reviewer) => [reviewer.actor.login, reviewer.state]),
          [
            ["bob", "approved"],
            ["alice", "blocked"],
            ["carol", "pending"],
          ],
        );
        assert.deepStrictEqual(
          detail.reviewStatus?.actions
            .filter((action) => action.available)
            .map((action) => action.id),
          ["sticky-ship", "block-merge", "unblock-merge"],
        );
        assert.deepStrictEqual(detail.viewerPermissions.verdicts, [
          "comment",
          "approve",
          "request-changes",
        ]);
        // The pull request, its stats and the cached account: no read was added.
        assert.deepStrictEqual(
          sent.map((request) => request.path),
          [
            "/v1/review-requests/101",
            "/v2/users/me",
            "/v1/review-requests/101/diff-sets/9001/diff-stats",
          ],
        );
        assert.include(sent[0]?.query.get("fields") ?? "", "caps(disable_sticky_ships)");
      }),
    ),
  );

  it.effect("sets and withdraws each decision with its own write on the seen iteration", () =>
    Effect.gen(function* () {
      const cases = [
        ["sticky-ship", {}, "POST /v1/review-requests/101/diff-sets/9001/ship", "true"],
        ["block-merge", {}, "POST /v1/review-requests/101/diff-sets/9001/block-merge", null],
        [
          "unship",
          voted("sticky_ship"),
          "DELETE /v1/review-requests/101/diff-sets/9001/ship",
          null,
        ],
        [
          "cancel-request-changes",
          voted("waiting_for_changes"),
          "DELETE /v1/review-requests/101/diff-sets/9001/request-for-changes",
          null,
        ],
        [
          "unblock-merge",
          voted("block_merge"),
          "DELETE /v1/review-requests/101/diff-sets/9001/block-merge",
          null,
        ],
      ] as const;
      for (const [actionId, overrides, write, sticky] of cases) {
        yield* runProvider({ routes: routes(overrides) })((provider, sent) =>
          Effect.gen(function* () {
            yield* provider.runReviewAction!({ ...REF, actionId, expectedHeadSha: HEAD });
            assert.deepStrictEqual(writes(sent), [write]);
            assert.equal(sent.at(-1)?.query.get("sticky"), sticky);
          }),
        );
      }
    }),
  );

  it.effect("refuses before writing when the decision is unavailable, unknown or stale", () =>
    Effect.gen(function* () {
      const refusals = [
        [routes(), "unblock-merge", HEAD, "You have not blocked merging."],
        [
          routes({ caps: { disable_sticky_ships: true } }),
          "sticky-ship",
          HEAD,
          "turn Sticky Ship off",
        ],
        [
          routes({}, account("alice", { outstaff: true })),
          "block-merge",
          HEAD,
          "external accounts",
        ],
        [routes(), "approve-everything", HEAD, "no approve-everything review action"],
        [routes(), "sticky-ship", BASE, "changed while it was being read"],
        [routes(), "sticky-ship", undefined, "changed while it was being read"],
      ] as const;
      for (const [scripted, actionId, expectedHeadSha, detail] of refusals) {
        yield* runProvider({ routes: scripted })((provider, sent) =>
          Effect.gen(function* () {
            const error = yield* Effect.flip(
              provider.runReviewAction!({
                ...REF,
                actionId,
                ...(expectedHeadSha === undefined ? {} : { expectedHeadSha }),
              }),
            );
            assert.include(error.detail, detail);
            assert.deepStrictEqual(writes(sent), []);
          }),
        );
      }
    }),
  );
});

describe("ArcanumPullRequestProvider conversation writes", () => {
  const routes = {
    "GET /v1/review-requests/101": data(pull()),
    "GET /v2/users/me": account(),
    "GET /v1/public/review-requests/101/comments": data([
      {
        id: 501,
        user: { name: "bob" },
        content: "root",
        created_at: "2026-10-30T13:51:49Z",
        anchor: {
          review_request: { id: 101, diff: { diff_set_xid: "9000", file: { entry_id: {} } } },
        },
      },
      {
        id: 601,
        user: { name: "alice" },
        content: "reply",
        created_at: "2026-10-30T14:00:00Z",
        reply_to_id: 501,
      },
    ]),
    "GET /v1/public/review-requests-comments/501": data({ id: 501, user: { name: "bob" } }),
    "PUT /v2/public/diff/9000/comment/601/reaction/%3Aeyes%3A": null,
    "PUT /v2/public/diff/9000/comment/601/reaction/%3Asmile%3A": null,
    "DELETE /v2/public/pull-request/101/comment/-20/reaction/%3A%2B1%3A": null,
  };

  it.effect(
    "reacts through the route a comment's sign and thread name, never on the description",
    () =>
      runProvider({ routes })((provider, sent) =>
        Effect.gen(function* () {
          yield* provider.setReaction({ ...REF, subjectId: "601", content: "eyes", reacted: true });
          yield* provider.setReaction({
            ...REF,
            subjectId: "601",
            content: "laugh",
            reacted: true,
          });
          yield* provider.setReaction({
            ...REF,
            subjectId: "-20",
            content: "thumbs-up",
            reacted: false,
          });
          assert.deepStrictEqual(writes(sent), [
            "PUT /v2/public/diff/9000/comment/601/reaction/%3Aeyes%3A",
            "PUT /v2/public/diff/9000/comment/601/reaction/%3Asmile%3A",
            "DELETE /v2/public/pull-request/101/comment/-20/reaction/%3A%2B1%3A",
          ]);
          const description = yield* Effect.flip(
            provider.setReaction({ ...REF, content: "heart", reacted: true }),
          );
          assert.include(description.detail, "description");
        }),
      ),
  );

  it.effect("edits only the viewer's own comments and resolves only issues", () =>
    runProvider({ routes })((provider, sent) =>
      Effect.gen(function* () {
        const edit = yield* Effect.flip(
          provider.updateComment!({ ...REF, commentId: "501", kind: "review-comment", body: "x" }),
        );
        assert.include(edit.detail, "Only bob");
        const resolve = yield* Effect.flip(
          provider.setThreadResolution({ ...REF, threadId: "501", resolved: true }),
        );
        assert.include(resolve.detail, "not an issue");
        const bad = yield* Effect.flip(
          provider.replyToThread({ ...REF, threadId: "1e5", body: "x" }),
        );
        assert.include(bad.detail, "not one of Arcanum's");
        assert.deepStrictEqual(writes(sent), []);
      }),
    ),
  );
});

describe("ArcanumPullRequestProvider issues", () => {
  const routes = (raisedBy: string, issue_status = "open") => ({
    "GET /v1/review-requests/101": data(pull()),
    "GET /v2/users/me": account(),
    "GET /v2/public/diff/9001/changelist": data(changelist),
    "POST /v2/public/diff/9001/comment": data({ id: 700 }),
    "POST /v2/public/pull-request/101/comment": data({ id: -900 }),
    "POST /v1/public/draft-comments": data({ published: [] }),
    "GET /v1/public/review-requests-comments/-40": data({
      id: -40,
      user: { name: raisedBy },
      issue_status,
    }),
    "PATCH /v1/public/review-requests-comments/-40": null,
  });

  it.effect("raises a PR-level comment or a line comment as an issue", () =>
    runProvider({ routes: routes("alice") })((provider, sent) =>
      Effect.gen(function* () {
        yield* provider.comment({ ...REF, body: "Why?", isIssue: true });
        yield* provider.comment({ ...REF, body: "Nice" });
        yield* provider.submitReview({
          ...REF,
          verdict: "comment",
          body: "",
          comments: [
            {
              path: "adv/frontend/a.ts",
              position: { kind: "added", newLine: 3 },
              body: "Bound?",
              isIssue: true,
            },
          ],
        });
        const posts = sent.filter((request) => request.method === "POST");
        assert.deepStrictEqual(posts[0]?.body, { content: "Why?", is_issue: true });
        assert.deepStrictEqual(posts[1]?.body, { content: "Nice" });
        assert.deepInclude(posts[2]?.body, { is_draft: true, is_issue: true });
      }),
    ),
  );

  it.effect("moves anyone's issue between open, resolved and dropped", () =>
    Effect.gen(function* () {
      for (const [issueState, resolved] of [
        ["dropped", true],
        ["resolved", true],
        ["open", false],
      ] as const) {
        yield* runProvider({ routes: routes("bob", "resolved") })((provider, sent) =>
          Effect.gen(function* () {
            yield* provider.setThreadResolution({ ...REF, threadId: "-40", resolved, issueState });
            assert.deepStrictEqual(sent.at(-1)?.body, { issue_status: issueState });
          }),
        );
      }
    }),
  );
});

describe("ArcanumPullRequestProvider credentials", () => {
  it.effect("pins the verified credential for the whole operation", () =>
    runProvider({
      routes: { "GET /v2/users/me": account(), "GET /v1/review-requests/101": data(pull()) },
    })((provider, sent) =>
      Effect.gen(function* () {
        const settings = yield* TestSourceControlHost.TestSourceControlHostSettings;
        yield* provider.withVerifiedCredential!(REF, (identity) =>
          Effect.gen(function* () {
            assert.equal(identity.accountId, "alice");
            yield* settings.update({ sourceControlHosts: { arcanum: { token: "changed" } } });
            yield* provider.getChangeRequestPreview!(REF);
          }),
        );
        assert.deepStrictEqual(
          sent.map((request) => request.authorization),
          ["OAuth env-token", "OAuth env-token"],
        );
      }),
    ),
  );

  it.effect("does not fall back to another source when the chosen one is refused", () =>
    runProvider({
      settings: { ...DEFAULT_SERVER_SETTINGS, sourceControlHosts: { arcanum: { token: "saved" } } },
      routes: { "GET /v2/users/me": jsonResponse(401, { errors: [{ message: "nope" }] }) },
    })((provider, sent) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(provider.getViewer({ cwd: REF.cwd }));
        assert.equal(error.reason, "unauthenticated");
        assert.include(error.detail, "Settings");
        assert.deepStrictEqual(
          sent.map((request) => request.authorization),
          ["OAuth saved"],
        );
      }),
    ),
  );

  it.effect("reports a missing credential as missing, not as an empty listing", () =>
    runProvider({
      env: {},
      routes: {},
      process: (input) =>
        Effect.fail(
          new VcsProcessExitError({
            operation: input.operation,
            command: input.command,
            cwd: input.cwd,
            exitCode: 1,
            detail: "not signed in",
          }),
        ),
    })((provider) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          provider.listChangeRequests({
            ...REF,
            state: "open",
            involvement: "all",
            viewer: "alice",
            limit: 10,
          }),
        );
        assert.equal(error.reason, "missing-tool");
      }),
    ),
  );
});

describe("ArcanumPullRequestProvider labels", () => {
  // Arcanum answers 400 "text is null" when the catalog read has no `text`, even an empty one.
  const catalog = (request: SentRequest) =>
    request.query.has("text")
      ? data([{ name: `found/${request.query.get("text") || "any"}` }])
      : jsonResponse(400, { errors: [{ status: "400", message: "text is null" }] });
  const routes = {
    "GET /v1/review-requests/101": data(pull()),
    "GET /v1/public/labels": catalog,
  };

  it.effect("reads the label catalog with a search text, empty when there is none", () =>
    runProvider({ routes })((provider) =>
      Effect.gen(function* () {
        const candidates = yield* provider.listLabelCandidates!(REF);
        assert.deepStrictEqual(
          candidates.candidates.map((label) => label.name),
          ["team/one", "found/any"],
        );
        const all = yield* provider.listRepositoryLabels!(REF);
        assert.deepStrictEqual(
          all.items.map((label) => label.name),
          ["found/any"],
        );
        const some = yield* provider.listRepositoryLabels!({ ...REF, query: " team " });
        assert.deepStrictEqual(
          some.items.map((label) => label.name),
          ["found/team"],
        );
      }),
    ),
  );
});
