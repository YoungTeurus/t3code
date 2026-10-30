import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as ArcanumApi from "./ArcanumApi.ts";
import * as ArcanumPullRequestApi from "./ArcanumPullRequestApi.ts";
import * as ArcanumPullRequestProvider from "./ArcanumPullRequestProvider.ts";
const isApiError = Schema.is(ArcanumApi.ArcanumApiError);

describe("Arcanum PR presentation", () => {
  it.effect("keeps raw pagination when closed-state filtering removes a page", () =>
    Effect.gen(function* () {
      const pr = (status: string, id: number): typeof ArcanumPullRequestApi.PullRequest.Type => ({
        id,
        status,
        url: `https://a.yandex-team.ru/review/${id}`,
        summary: status,
        description: "",
        created_at: "2026-10-01T00:00:00Z",
        updated_at: "2026-10-02T00:00:00Z",
        author: { name: "author" },
        vcs: {
          repo_name: "arc_vcs",
          type: "arc",
          from_branch: "users/author/task",
          to_branch: "trunk",
        },
        active_diff: {
          id: 700,
          published: true,
          has_conflicts: false,
          commit_ids: { head: "a".repeat(40), base: "b".repeat(40) },
        },
      });
      const provider = yield* ArcanumPullRequestProvider.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            ArcanumPullRequestProviderTestLayer(),
            Layer.mock(ArcanumPullRequestApi.ArcanumPullRequestApi)({
              search: (_cwd, input) =>
                Effect.succeed({
                  rows:
                    input.offset === 0
                      ? [pr("discarded", 1), pr("no_changes", 2)]
                      : [pr("merged", 3)],
                  rawCount: input.offset === 0 ? 2 : 1,
                  total: 3,
                }),
            }),
          ),
        ),
      );
      const input = {
        cwd: "/repo/service",
        host: "a.yandex-team.ru",
        repository: "arcadia",
        state: "merged" as const,
        involvement: "authored" as const,
        viewer: "reader",
        limit: 2,
      };
      const first = yield* provider.listChangeRequests(input);
      assert.equal(first.items.length, 0);
      assert.equal(first.continues, true);
      assert.equal(first.truncated, true);
      assert.equal(first.cursorAdvance, 2);
      const next = yield* provider.listChangeRequests({
        ...input,
        cursor: { delivered: 2, updatedBefore: "2026-10-02T00:00:00Z" },
      });
      assert.deepEqual(
        next.items.map((item) => item.number),
        [3],
      );
      assert.equal(next.continues, false);
      const closed = yield* provider.listChangeRequests({ ...input, state: "closed" });
      assert.deepEqual(
        closed.items.map((item) => item.number),
        [1, 2],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect(
    "resumes a partially published review without duplicating accepted inline comments",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stateDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-arcanum-review-" });
        const published: unknown[] = [];
        let failSecond = true;
        yield* Effect.gen(function* () {
          const provider = yield* ArcanumPullRequestProvider.make;
          const input = {
            cwd: "/repo/service",
            host: "a.yandex-team.ru",
            repository: "arcadia",
            number: 42,
            expectedHeadSha: "a".repeat(40),
            verdict: "comment" as const,
            body: "",
            comments: [
              {
                clientId: "first",
                expectedHeadSha: "a".repeat(40),
                path: "service/file.txt",
                position: { kind: "added" as const, newLine: 3 },
                startPosition: { kind: "added" as const, newLine: 1 },
                body: "First",
              },
              {
                clientId: "second",
                expectedHeadSha: "a".repeat(40),
                path: "service/file.txt",
                position: { kind: "deleted" as const, oldLine: 2 },
                body: "Second",
              },
            ],
          };
          assert.equal((yield* provider.submitReview(input).pipe(Effect.result))._tag, "Failure");
          yield* provider.submitReview(input);
          assert.deepEqual(published, [
            {
              content: "First",
              entry_id: "entry-1",
              is_draft: false,
              is_issue: false,
              line: 1,
              side: "new",
              size: 3,
            },
            {
              content: "Second",
              entry_id: "entry-1",
              is_draft: false,
              is_issue: false,
              line: 2,
              side: "old",
              size: 1,
            },
          ]);
          const stale = yield* provider
            .submitReview({
              ...input,
              comments: [{ ...input.comments[0]!, expectedHeadSha: "c".repeat(40) }],
            })
            .pipe(Effect.result);
          assert.equal(stale._tag, "Failure");
          assert.equal(published.length, 2);
        }).pipe(
          Effect.provide(
            ArcanumPullRequestProviderTestLayer({
              stateDirectory,
              onComment: (body) => {
                if ((body as { content: string }).content === "Second" && failSecond) {
                  failSecond = false;
                  return Effect.fail(
                    new ArcanumApi.ArcanumApiError({ operation: "comment", reason: "failed" }),
                  );
                }
                published.push(body);
                return Effect.succeed({ id: String(-published.length) });
              },
            }),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect(
    "does not infer merge permission from green CI and keeps native comment threads intact",
    () =>
      Effect.gen(function* () {
        const provider = yield* ArcanumPullRequestProvider.make;
        const input = {
          cwd: "/repo/service",
          host: "a.yandex-team.ru",
          repository: "arcadia",
          number: 42,
        };
        const detail = yield* provider.getChangeRequest(input);
        assert.equal(detail.mergeability, "unknown");
        assert.deepEqual(detail.mergeCapabilities, { merge: false, squash: false, rebase: false });
        assert.equal(detail.headSha, "a".repeat(40));
        assert.equal(detail.additions, 2);
        assert.equal(detail.deletions, 1);
        const paths = yield* provider.getDiffFilePaths!(input);
        assert.deepEqual(paths.files, [{ oldPath: "service/new.txt", newPath: "service/new.txt" }]);
        const activity = yield* provider.getChangeRequestActivity(input);
        assert.equal(activity.reviewThreads.length, 1);
        assert.equal(activity.reviewThreads[0]?.id, "-9223372036854775807");
        assert.equal(activity.reviewThreads[0]?.comments.length, 2);
        assert.equal(activity.reviewThreads[0]?.isResolved, false);
        assert.equal(activity.reviewThreads[0]?.path, "service/file.txt");
        yield* provider.submitReview({
          ...input,
          expectedHeadSha: "a".repeat(40),
          verdict: "approve",
          body: "",
          comments: [],
        });
        const stale = yield* provider
          .submitReview({
            ...input,
            expectedHeadSha: "c".repeat(40),
            verdict: "approve",
            body: "",
            comments: [],
          })
          .pipe(Effect.result);
        assert.equal(stale._tag, "Failure");
        yield* provider.updateChangeRequest!({ ...input, title: "Updated title" });
        assert.equal((yield* provider.getChangeRequest(input)).title, "Updated title");
        yield* provider.setReviewerRequest({
          ...input,
          reviewers: [{ id: "second-reader", kind: "user" }],
          requested: true,
        });
        assert.deepEqual((yield* provider.getChangeRequest(input)).reviewRequestLogins, [
          "reader",
          "second-reader",
        ]);
        yield* provider.runAction({ ...input, action: "close" });
        assert.equal((yield* provider.getChangeRequest(input)).state, "closed");
      }).pipe(
        Effect.provide(
          ArcanumPullRequestProviderTestLayer().pipe(Layer.provideMerge(NodeServices.layer)),
        ),
      ),
  );
});

const ArcanumPullRequestProviderTestLayer = (options?: {
  stateDirectory: string;
  onComment: (body: unknown) => Effect.Effect<{ id: string }, ArcanumApi.ArcanumApiError>;
}) => {
  let title = "Title";
  let state = "open";
  let reviewers = ["reader"];
  return Layer.mergeAll(
    TestSourceControlHost.layer({
      ...(options ? { stateDirectory: options.stateDirectory } : {}),
      process: {
        run: (input) => {
          assert.equal(input.command, "arc");
          const stdout =
            input.args[0] === "root"
              ? "/repo\n"
              : input.args[0] === "merge-base"
                ? `${"b".repeat(40)}\n`
                : input.args.includes("--stat")
                  ? " 1 file changed, 2 insertions(+), 1 deletions(-)\n"
                  : input.args[0] === "diff"
                    ? "diff --git a/service/new.txt b/service/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/service/new.txt\n@@ -0,0 +1 @@\n+new\n"
                    : "[]";
          return Effect.succeed(TestSourceControlHost.processOutput(stdout));
        },
      },
    }),
    Layer.mock(ArcanumApi.ArcanumApi)({
      viewer: () => Effect.succeed("reader"),
      withVerifiedCredential: (_cwd, use) =>
        use({ viewer: "reader", credentialFingerprint: "fixture" }),
      request: (input, schema) => {
        if (input.path.startsWith("/v2/public/diff/700/comment") && options)
          return options.onComment(input.body).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(schema)),
            Effect.catchIf(
              (cause) => !isApiError(cause),
              () => Effect.die("invalid fixture"),
            ),
          );
        if (input.path === "/v1/plugin/pull-request/42") {
          assert.equal(input.method, "PUT");
          title = (input.body as { summary: string }).summary;
          assert.deepEqual(input.body, {
            summary: "Updated title",
            description: "Body",
            labels: ["keep-label"],
            issues: ["KEEP-1"],
          });
        } else if (input.path === "/v1/plugin/pull-request/42/reviewers") {
          assert.equal(input.method, "PUT");
          reviewers = [...(input.body as { reviewers: string[] }).reviewers];
        } else if (input.path === "/v1/plugin/pull-request/42/discard") {
          assert.equal(input.method, "PATCH");
          state = "discarded";
        } else {
          assert.equal(input.method, "POST");
          assert.equal(input.path, "/v1/review-requests/42/diff-sets/700/ship?sticky=false");
        }
        return Schema.decodeUnknownEffect(schema)(undefined).pipe(Effect.orDie);
      },
    }),
    Layer.mock(ArcanumPullRequestApi.ArcanumPullRequestApi)({
      read: () =>
        Effect.succeed({
          pr: {
            id: 42,
            url: "https://a.yandex-team.ru/review/42",
            summary: title,
            description: "Body",
            status: state,
            created_at: "2026-10-01T00:00:00Z",
            updated_at: "2026-10-02T00:00:00Z",
            author: { name: "author" },
            coauthors: [{ name: "reader" }],
            assignees: reviewers.map((name) => ({ name })),
            labels: [{ name: "keep-label" }],
            tickets: ["KEEP-1"],
            vcs: {
              repo_name: "arc_vcs",
              type: "arc",
              from_branch: "users/author/task",
              to_branch: "trunk",
            },
            merge_allowed: null,
          },
          diff: {
            id: 700,
            published: true,
            has_conflicts: false,
            commit_ids: { head: "a".repeat(40), base: "b".repeat(40) },
          },
        }),
      checks: () =>
        Effect.succeed([
          { name: "CI", status: "success", description: null, url: null, required: true },
        ]),
      changes: () =>
        Effect.succeed([
          {
            path: "service/file.txt",
            entry_id: "entry-1",
            change_type: "modify",
            node_type: "file",
          },
        ]),
      comments: () =>
        Effect.succeed([
          {
            id: "-9223372036854775807",
            content: "Issue",
            author: { name: "author" },
            created_at: "2026-10-01T00:00:00Z",
            issue_status: "open",
            anchor: { diff_id: 700, destination_path: "service/file.txt", line: 2, side: "new" },
          },
          {
            id: "-9223372036854775806",
            reply_to_id: "-9223372036854775807",
            content: "Reply",
            author: { name: "reader" },
            created_at: "2026-10-02T00:00:00Z",
          },
        ]),
    }),
  );
};
