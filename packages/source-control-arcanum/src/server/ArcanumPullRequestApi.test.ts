import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as ArcanumApi from "./ArcanumApi.ts";
import * as ArcanumPullRequestApi from "./ArcanumPullRequestApi.ts";

describe("Arcanum pull request reads", () => {
  it.effect(
    "keeps diff IDs separate from commit SHA, preserves unknown merge permission and reads every checks page",
    () =>
      Effect.gen(function* () {
        const client = yield* ArcanumPullRequestApi.ArcanumPullRequestApi;
        const pr = yield* client.read("/repo", 42);
        assert.equal(pr.diff.id, 700);
        assert.equal(pr.diff.commit_ids.head, "a".repeat(40));
        assert.equal(pr.pr.merge_allowed, null);
        const checks = yield* client.checks("/repo", pr.diff.id);
        assert.equal(checks.length, 2);
        assert.equal(checks[0]?.status, "success");
        assert.equal(checks[1]?.status, "pending");
        assert.equal(checks[1]?.required, true);
        const otherAccount = yield* client
          .read("/repo", 42)
          .pipe(Effect.provideService(SourceControlRateLimit.CredentialScope, "account-b"));
        assert.equal(otherAccount.pr.description, "account-b");
        yield* client.list("/repo", { limit: 10, offset: 0 });
        const page = yield* client.search("/repo", {
          state: "open",
          involvement: "authored",
          viewer: "reader",
          limit: 10,
          offset: 0,
        });
        assert.equal(page.rawCount, 0);
      }).pipe(
        Effect.provide(
          ArcanumPullRequestApi.layer.pipe(
            Layer.provide(
              Layer.mock(ArcanumApi.ArcanumApi)({
                request: (input, schema) => {
                  assert.isTrue(input.path.includes("fields="));
                  assert.isFalse(input.path.includes("active-diff"));
                  if (input.path.startsWith("/v1/plugin/pull-request/search")) {
                    assert.deepEqual(input.body, {
                      filter: { is_open: true, authors_or_coauthors: { include: ["reader"] } },
                      order: [{ field: "updated_at", ascending: false }],
                      limit: 10,
                      offset: 0,
                    });
                    return Schema.decodeUnknownEffect(schema)({ pull_requests: [], total: 0 }).pipe(
                      Effect.orDie,
                    );
                  }
                  if (input.path.startsWith("/v1/public/repos"))
                    return Schema.decodeUnknownEffect(schema)([
                      { id: "arc_vcs", arc_repo_name: "arcadia", slug: "arcadia", vcs_type: "arc" },
                    ]).pipe(Effect.orDie);
                  if (input.path.startsWith("/v1/pull-requests/cursor")) {
                    assert.deepEqual(input.body, {
                      filter: { repositories: ["arc_vcs"] },
                      desc_order: true,
                      limit: 10,
                      offset: 0,
                    });
                    return Schema.decodeUnknownEffect(schema)({
                      pull_requests: [],
                      has_next: false,
                    }).pipe(Effect.orDie);
                  }
                  const data = input.path.startsWith("/v2/pull-requests/")
                    ? {
                        id: 42,
                        url: "https://a.yandex-team.ru/review/42",
                        summary: "Native change",
                        description: "Body",
                        status: "open",
                        created_at: "2026-10-01T00:00:00Z",
                        updated_at: "2026-10-02T00:00:00Z",
                        author: { name: "author", uid: "user-1" },
                        vcs: {
                          repo_name: "arc_vcs",
                          type: "arc",
                          from_branch: "users/author/task",
                          to_branch: "trunk",
                        },
                        merge_allowed: null,
                        active_diff: {
                          id: 700,
                          published: true,
                          has_conflicts: false,
                          commit_ids: { head: "a".repeat(40), base: "b".repeat(40) },
                        },
                      }
                    : input.path.includes("active-diff")
                      ? {
                          id: 700,
                          published: true,
                          commit_ids: { head: "a".repeat(40), base: "b".repeat(40) },
                          has_conflicts: false,
                        }
                      : {
                          checks: [
                            {
                              key: {
                                system: "ci",
                                type: input.path.includes("cursor=") ? "tests" : "build",
                              },
                              status: input.path.includes("cursor=") ? "pending" : "success",
                              required: true,
                              satisfied: !input.path.includes("cursor="),
                            },
                          ],
                          ...(input.path.includes("cursor=")
                            ? {}
                            : { next_page_cursor: "next-page" }),
                        };
                  return Effect.flatMap(SourceControlRateLimit.CredentialScope, (scope) =>
                    Schema.decodeUnknownEffect(schema)(
                      input.path.startsWith("/v2/pull-requests/")
                        ? { ...data, description: scope }
                        : data,
                    ),
                  ).pipe(Effect.orDie);
                },
              }),
            ),
          ),
        ),
      ),
  );
});
