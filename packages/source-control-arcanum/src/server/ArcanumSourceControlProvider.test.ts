import { assert, describe, it } from "@effect/vitest";
import { SourceControlProviderKind } from "@t3tools/contracts";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import * as ArcanumSourceControlProvider from "./ArcanumSourceControlProvider.ts";
import {
  account,
  data,
  harness,
  jsonResponse,
  provideHarness,
  type HarnessOptions,
  type SentRequest,
} from "./arcanumTesting.ts";

const H = (digit: string) => digit.repeat(40);
const CONTEXT = {
  provider: {
    kind: SourceControlProviderKind.make("arcanum"),
    name: "Arcanum",
    baseUrl: "https://a.yandex-team.ru",
  },
  remoteName: "arcadia",
  remoteUrl: "arc://arc-vcs.yandex-team.ru/arcadia",
};
const pull = (overrides: Record<string, unknown> = {}) => ({
  id: 101,
  url: "https://a.yandex-team.ru/review/101",
  summary: "Fix",
  author: { name: "alice" },
  vcs: { arc_repo_name: "arcadia", from_branch: "users/alice/fix", to_branch: "trunk" },
  created_at: "2026-10-30T11:51:31Z",
  updated_at: "2026-10-30T18:09:03Z",
  full_status: "open",
  common_status: "waiting_for_review",
  active_diff_set: {
    id: 9001,
    status: "published",
    arc_branch_heads: { from_id: H("1"), to_id: H("2"), merge_id: H("3") },
  },
  ...overrides,
});

const runProvider =
  (options: HarnessOptions) =>
  <A, E, R>(
    body: (
      provider: Effect.Success<typeof ArcanumSourceControlProvider.make>,
      sent: ReadonlyArray<SentRequest>,
    ) => Effect.Effect<A, E, R>,
  ) =>
    provideHarness(options)((sent) =>
      Effect.gen(function* () {
        return yield* body(yield* ArcanumSourceControlProvider.make, sent);
      }),
    );

/** `arc` as the Arc driver reads it: local branches with their tracked server branch, and the login. */
const arc = (input: SourceControlHost.SourceControlProcessInput) =>
  Effect.sync(() => {
    const args = input.args.join(" ");
    // Arc names a branch's upstream only in verbose output.
    if (args === "branch --json" || args === "branch --json -v") {
      return TestSourceControlHost.processOutput(
        JSON.stringify([
          { name: "fix", ...(args.endsWith("-v") ? { remote: "arcadia/users/alice/fix" } : {}) },
          { name: "feature/foo" },
          { name: "plain" },
          { name: "users/native/own" },
        ]),
      );
    }
    if (args === "info --json") {
      return TestSourceControlHost.processOutput(JSON.stringify({ user_login: "native" }));
    }
    throw new Error(`unscripted arc ${args}`);
  });

describe("ArcanumSourceControlProvider branches", () => {
  const routes = {
    "GET /v2/users/me": account(),
    "GET /v2/pull-requests/latest": (request: { query: URLSearchParams }) =>
      request.query.get("from_branch") === "users/alice/fix"
        ? data({ id: 101 })
        : jsonResponse(404, { errors: [{ message: "reviewRequest from branch not found" }] }),
    "GET /v1/review-requests/101": data(pull()),
  };

  it.effect("looks a branch up by the Arc server branch it means, by Arc's own rules", () =>
    runProvider({ routes, user: "alice", process: arc })((provider, sent) =>
      Effect.gen(function* () {
        const lookup = (headSelector: string) =>
          provider.listChangeRequests({
            cwd: "/arc/arcadia/adv",
            context: CONTEXT,
            headSelector,
            state: "all",
          });
        const full = yield* lookup("users/alice/fix");
        assert.deepStrictEqual(
          full.map((change) => [change.number, change.headRefName, change.headSha]),
          [[101, "users/alice/fix", H("1")]],
        );
        for (const selector of [
          "fix",
          "feature/foo",
          "plain",
          "users/native/own",
          "users/bob/x",
          "releases/r1",
        ]) {
          yield* lookup(selector);
        }
        const lookups = sent.filter((request) => request.path === "/v2/pull-requests/latest");
        assert.deepStrictEqual(
          lookups.map((request) => [
            request.query.get("from_branch"),
            request.query.get("repository"),
          ]),
          [
            // A server branch the caller already read off an upstream stays as it is.
            ["users/alice/fix", "arcadia"],
            // A local branch means the server branch it tracks.
            ["users/alice/fix", "arcadia"],
            // An unpublished local branch goes where Arc would push it: under the Arc login,
            // not the Arcanum account, and never prefixed twice.
            ["users/native/feature/foo", "arcadia"],
            ["users/native/plain", "arcadia"],
            ["users/native/own", "arcadia"],
            ["users/bob/x", "arcadia"],
            ["releases/r1", "arcadia"],
          ],
        );
        assert.deepStrictEqual(
          yield* provider.listChangeRequests({
            cwd: "/arc/arcadia",
            headSelector: "users/alice/other",
            state: "open",
          }),
          [],
        );
        assert.deepStrictEqual(
          yield* provider.listChangeRequests({
            cwd: "/arc/arcadia",
            headSelector: "users/alice/fix",
            state: "merged",
          }),
          [],
        );
        assert.deepStrictEqual(
          provider.headBranchProbe?.({
            headSelectors: ["alice:fix", "users/alice/fix"],
            state: "open",
          }),
          { headSelectors: ["users/alice/fix"], limit: 1 },
        );
      }),
    ),
  );

  it.effect("reads references as numbers or review URLs only", () =>
    runProvider({ routes })((provider) =>
      Effect.gen(function* () {
        const byUrl = yield* provider.getChangeRequest({
          cwd: "/arc/arcadia",
          reference: "https://a.yandex-team.ru/review/101/details",
        });
        assert.equal(byUrl.number, 101);
        assert.isFalse(byUrl.isCrossRepository);
        const bad = yield* Effect.flip(
          provider.getChangeRequest({ cwd: "/arc/arcadia", reference: "users/alice/fix" }),
        );
        assert.include(bad.detail, "numbers or review URLs");
      }),
    ),
  );
});

describe("ArcanumSourceControlProvider writes", () => {
  it.effect("creates a pull request from the full branch with the description file's text", () =>
    Effect.gen(function* () {
      const bodyFile = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const file = yield* fs.makeTempFile({ prefix: "t3-arcanum-body-" });
          yield* fs.writeFileString(file, "Line one\nLine two\n");
          return file;
        }),
      ).pipe(Effect.provide(harness({ routes: {} }).layer));
      yield* runProvider({
        routes: {
          "GET /v2/users/me": account(),
          "POST /v1/pull-requests": data({ id: 102, url: "https://a.yandex-team.ru/review/102" }),
        },
        process: arc,
      })((provider, sent) =>
        Effect.gen(function* () {
          const create = (headSelector: string) =>
            provider.createChangeRequest({
              cwd: "/arc/arcadia",
              context: CONTEXT,
              baseRefName: "trunk",
              headSelector,
              title: "Fix",
              bodyFile,
            });
          // Arcanum's answer names the pull request, so the caller need not look it up again.
          assert.deepStrictEqual(yield* create("fix"), {
            number: 102,
            url: "https://a.yandex-team.ru/review/102",
          });
          yield* create("feature/foo");
          const created = sent.filter((request) => request.path === "/v1/pull-requests");
          assert.deepStrictEqual(created[0]?.body, {
            vcs: { arc_repo_name: "arcadia", from_branch: "users/alice/fix", to_branch: "trunk" },
            summary: "Fix",
            description: "Line one\nLine two\n",
          });
          assert.deepStrictEqual(
            created.map(
              (request) => (request.body as { vcs: { from_branch: string } }).vcs.from_branch,
            ),
            ["users/alice/fix", "users/native/feature/foo"],
          );
        }),
      );
      yield* runProvider({
        routes: { "POST /v1/pull-requests": jsonResponse(409, data(pull())) },
        process: arc,
      })((provider) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            provider.createChangeRequest({
              cwd: "/arc/arcadia",
              baseRefName: "trunk",
              headSelector: "users/alice/fix",
              title: "Fix",
              bodyFile,
            }),
          );
          assert.include(error.detail, "already exists");
        }),
      );
      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(bodyFile);
      }).pipe(Effect.provide(harness({ routes: {} }).layer));
    }),
  );

  it.effect("checks out through `arc pr checkout` with fixed arguments", () =>
    Effect.gen(function* () {
      const runs: Array<SourceControlHost.SourceControlProcessInput> = [];
      yield* runProvider({
        routes: {},
        process: (input) =>
          Effect.sync(() => {
            runs.push(input);
            return TestSourceControlHost.processOutput(
              input.args[0] === "info" ? JSON.stringify({ default_branch: "trunk" }) : "",
            );
          }),
      })((provider) =>
        Effect.gen(function* () {
          yield* provider.checkoutChangeRequest({
            cwd: "/arc/arcadia/sub",
            reference: "#101",
            force: true,
          });
          assert.equal(yield* provider.getDefaultBranch({ cwd: "/arc/arcadia/sub" }), "trunk");
          assert.deepStrictEqual(
            runs.map((run) => [run.command, ...run.args]),
            [
              ["arc", "pr", "checkout", "--force", "101"],
              ["arc", "info", "--mount", "--json"],
            ],
          );
          // Arc owns this checkout, so the Git-only guard is not asked to vouch for it.
          assert.isUndefined(runs[0]?.changesGitCheckout);
          const clone = yield* Effect.flip(
            provider.getRepositoryCloneUrls({ cwd: "/arc/arcadia", repository: "arcadia" }),
          );
          assert.include(clone.detail, "arc mount");
          const create = yield* Effect.flip(
            provider.createRepository({ cwd: "/arc", repository: "x", visibility: "private" }),
          );
          assert.include(create.detail, "arc mount");
        }),
      );
    }),
  );
});

describe("Arcanum discovery", () => {
  it.effect("names the signed-in account, or says why there is none", () =>
    Effect.gen(function* () {
      yield* provideHarness({ routes: { "GET /v2/users/me": account() }, user: "alice" })(() =>
        Effect.gen(function* () {
          const discovery = yield* ArcanumSourceControlProvider.makeDiscovery;
          const auth = yield* discovery.probeAuth;
          assert.equal(auth.status, "authenticated");
          assert.equal(Option.getOrNull(auth.account), "alice");
        }),
      );
      yield* provideHarness({
        routes: { "GET /v2/users/me": jsonResponse(401, { errors: [] }) },
      })(() =>
        Effect.gen(function* () {
          const discovery = yield* ArcanumSourceControlProvider.makeDiscovery;
          assert.equal((yield* discovery.probeAuth).status, "unauthenticated");
        }),
      );
    }),
  );
});
