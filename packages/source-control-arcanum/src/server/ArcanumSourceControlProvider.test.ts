import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { VcsProcessTimeoutError } from "@t3tools/contracts";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as ArcanumPullRequestApi from "./ArcanumPullRequestApi.ts";
import * as ArcanumSourceControlProvider from "./ArcanumSourceControlProvider.ts";
import * as ArcanumApi from "./ArcanumApi.ts";

describe("Arcanum publication", () => {
  it.effect("reads back a PR created before a lost CLI response and never creates it twice", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const bodyFile = yield* fs.makeTempFileScoped({ prefix: "t3-arcanum-body-" });
      yield* fs.writeFileString(bodyFile, "Description");
      const head = "a".repeat(40);
      let published = false;
      let creations = 0;
      let viewer = "author";
      let branch = "task";
      const upstreams: string[] = [];
      const provider = yield* ArcanumSourceControlProvider.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ArcanumApi.ArcanumApi)({
              withVerifiedCredential: (_cwd, use) =>
                use({ viewer, credentialFingerprint: `fixture-${viewer}` }),
            }),
            TestSourceControlHost.layer({
              git: {
                listLocalBranchNames: () => Effect.succeed(["t3/pr-42"]),
                switchRef: (input) =>
                  Effect.sync(() => {
                    branch = input.refName;
                    return { refName: branch };
                  }),
                setBranchUpstream: (input) =>
                  Effect.sync(() => {
                    upstreams.push(input.remoteBranch);
                  }),
              },
              process: {
                run: (input) =>
                  Effect.gen(function* () {
                    assert.equal(input.command, "arc");
                    if (input.args[0] === "info")
                      return TestSourceControlHost.processOutput(
                        JSON.stringify({
                          hash: head,
                          branch,
                          remote: "users/author/task",
                          repository: "arcadia",
                          user_login: "author",
                        }),
                      );
                    if (input.args[0] === "root")
                      return TestSourceControlHost.processOutput("/repo\n");
                    if (input.args[0] === "status")
                      return TestSourceControlHost.processOutput('{"status":{}}');
                    assert.deepEqual(input.args.slice(0, 2), ["pr", "create"]);
                    assert.isTrue(input.args.includes("--no-push"));
                    assert.equal(
                      yield* fs
                        .readFileString(input.args[input.args.indexOf("-F") + 1]!)
                        .pipe(Effect.orDie),
                      "Title\n\nDescription\n",
                    );
                    creations++;
                    published = true;
                    return yield* new VcsProcessTimeoutError({
                      operation: input.operation,
                      command: "arc",
                      cwd: input.cwd,
                      timeoutMs: 300_000,
                    });
                  }),
              },
            }),
            Layer.mock(ArcanumPullRequestApi.ArcanumPullRequestApi)({
              list: () =>
                Effect.succeed({ pull_requests: published ? [{ id: 42 }] : [], has_next: false }),
              read: () =>
                Effect.succeed({
                  pr: {
                    id: 42,
                    url: "https://a.yandex-team.ru/review/42",
                    summary: "Title",
                    description: "Description",
                    status: "open",
                    created_at: "2026-10-01T00:00:00Z",
                    updated_at: "2026-10-02T00:00:00Z",
                    author: { name: "author" },
                    vcs: {
                      repo_name: "arc_vcs",
                      type: "arc",
                      from_branch: "users/author/task",
                      to_branch: "trunk",
                    },
                  },
                  diff: {
                    id: 700,
                    published: true,
                    has_conflicts: false,
                    commit_ids: { head, base: "b".repeat(40) },
                  },
                }),
            }),
          ),
        ),
      );
      const input = {
        cwd: "/repo/service",
        headSelector: "users/author/task",
        baseRefName: "trunk",
        title: "Title",
        bodyFile,
      };
      yield* provider.createChangeRequest(input);
      yield* provider.createChangeRequest(input);
      assert.equal(creations, 1);
      yield* provider.checkoutChangeRequest({ cwd: input.cwd, reference: "42" });
      yield* provider.checkoutChangeRequest({ cwd: input.cwd, reference: "42" });
      assert.deepEqual(upstreams, ["users/author/task", "users/author/task"]);
      viewer = "another-user";
      assert.equal(
        (yield* provider.createChangeRequest(input).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal(creations, 1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
