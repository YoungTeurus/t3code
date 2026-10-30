import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as ArcanumApi from "./ArcanumApi.ts";
import { makeArcanumCommentPublisher } from "./ArcanumCommentPublisher.ts";

describe("Arcanum comment publication", () => {
  it.effect(
    "reuses a durable idempotency key after restart and never retries a conflicting payload",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stateDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-arcanum-intents-" });
        const created = new Set<string>();
        const keys: string[] = [];
        let loseResponse = true;
        let conflict = false;
        const dependencies = Layer.mergeAll(
          TestSourceControlHost.layer({
            stateDirectory,
            process: { run: () => Effect.succeed(TestSourceControlHost.processOutput("/repo\n")) },
          }),
          Layer.mock(ArcanumApi.ArcanumApi)({
            request: (input, schema) =>
              Effect.gen(function* () {
                assert.equal(input.method, "POST");
                assert.isDefined(input.idempotencyKey);
                keys.push(input.idempotencyKey!);
                if (conflict)
                  return yield* new ArcanumApi.ArcanumApiError({
                    operation: "comment",
                    reason: "conflict",
                    status: 409,
                  });
                created.add(input.idempotencyKey!);
                if (loseResponse)
                  return yield* new ArcanumApi.ArcanumApiError({
                    operation: "comment",
                    reason: "failed",
                  });
                return yield* Schema.decodeUnknownEffect(schema)({
                  id: "-9223372036854775807",
                }).pipe(Effect.orDie);
              }),
          }),
        );
        const input = {
          cwd: "/repo",
          number: 42,
          viewer: "author",
          body: { content: "Comment", is_issue: false, is_draft: false },
        };
        const first = yield* makeArcanumCommentPublisher().pipe(Effect.provide(dependencies));
        assert.equal((yield* first.publish(input).pipe(Effect.result))._tag, "Failure");
        assert.equal(created.size, 1);
        loseResponse = false;
        const restarted = yield* makeArcanumCommentPublisher().pipe(Effect.provide(dependencies));
        const response = yield* restarted.publish(input);
        assert.equal(String(response.id), "-9223372036854775807");
        assert.equal(keys[0], keys[1]);
        assert.equal(created.size, 1);
        conflict = true;
        const rejected = yield* restarted
          .publish({ ...input, body: { ...input.body, content: "Another comment" } })
          .pipe(Effect.result);
        assert.equal(rejected._tag, "Failure");
        if (rejected._tag === "Failure") assert.equal(rejected.failure.reason, "conflict");
        assert.equal(keys.length, 3);
        conflict = false;
        const reviewComment = { ...input, intentId: "review-1/comment-1" };
        yield* restarted.publish(reviewComment);
        const afterRestart = yield* makeArcanumCommentPublisher().pipe(
          Effect.provide(dependencies),
        );
        yield* afterRestart.publish(reviewComment);
        assert.equal(keys.length, 4);
        const changed = yield* afterRestart
          .publish({ ...reviewComment, body: { content: "Changed" } })
          .pipe(Effect.result);
        assert.equal(changed._tag, "Failure");
        assert.equal(keys.length, 4);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
