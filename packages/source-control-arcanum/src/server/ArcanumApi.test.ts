import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as ArcanumApi from "./ArcanumApi.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";

describe("Arcanum API transport", () => {
  it.effect.each([
    { body: '{"data":{"id":-9223372036854775807},"errors":[]}', status: 200, expected: "success" },
    {
      body: '{"data":{"id":-9223372036854775807}}',
      status: 201,
      expected: "success",
      payload: { reply_to_id: "-9223372036854775807", content: "Reply" },
    },
    { body: '{"data":{"id":1},"errors":[{"code":"forbidden"}]}', status: 200, expected: "failed" },
    { body: "{}", status: 403, expected: "forbidden" },
    { body: "{}", status: 429, expected: "rate-limited" },
    { body: "{}", status: 409, expected: "conflict" },
  ] as const)("handles $status/$expected without losing opaque IDs", (fixture) =>
    Effect.gen(function* () {
      const api = yield* ArcanumApi.ArcanumApi;
      const result = yield* api
        .request(
          {
            cwd: "/repo",
            operation: "test",
            path: "/v2/pull-requests/42",
            ...("payload" in fixture ? { method: "POST", body: fixture.payload } : {}),
          },
          Schema.Struct({ id: Schema.String }),
        )
        .pipe(Effect.result);
      if (fixture.expected === "success") {
        assert.equal(result._tag, "Success");
        if (result._tag === "Success") assert.equal(result.success.id, "-9223372036854775807");
      } else {
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.equal(result.failure.reason, fixture.expected);
      }
    }).pipe(
      Effect.provide(
        ArcanumApi.layer.pipe(
          Layer.provide(SourceControlRateLimit.layer),
          Layer.provide(NodeCrypto.layer),
          Layer.provide(
            Layer.mergeAll(
              TestSourceControlHost.layer(),
              Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make((request) => {
                  assert.equal(new URL(request.url).origin, "https://arcanum.yandex.net");
                  assert.equal(request.headers.authorization, "OAuth fixture-token");
                  if ("payload" in fixture) {
                    assert.equal(request.body._tag, "Uint8Array");
                    if (request.body._tag === "Uint8Array")
                      assert.equal(
                        new TextDecoder().decode(request.body.body),
                        '{"reply_to_id":-9223372036854775807,"content":"Reply"}',
                      );
                  }
                  return Effect.succeed(
                    HttpClientResponse.fromWeb(
                      request,
                      new Response(fixture.body, { status: fixture.status }),
                    ),
                  );
                }),
              ),
            ),
          ),
        ),
      ),
      Effect.provideService(HostProcess.Environment, { ARC_TOKEN: "fixture-token" }),
    ),
  );
});
