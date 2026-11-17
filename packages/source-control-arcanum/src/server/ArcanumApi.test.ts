import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import { ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";

import * as ArcanumApi from "./ArcanumApi.ts";
import * as ArcanumCredentials from "./ArcanumCredentials.ts";
import { account, data, jsonResponse, provideHarness } from "./arcanumTesting.ts";

const withSavedToken = (token: string) => ({
  ...DEFAULT_SERVER_SETTINGS,
  sourceControlHosts: { arcanum: { token } },
});

describe("ArcanumApi", () => {
  it.effect("spaces queued requests and rechecks a 429 pause before sending the next", () =>
    Effect.gen(function* () {
      const firstSent = yield* Deferred.make<void>();
      yield* provideHarness({
        requestSpacingMs: 1_000,
        routes: { "GET /v1/first": jsonResponse(429, {}, "alice"), "GET /v1/second": data({}) },
        gate: (request) =>
          request.path === "/v1/first"
            ? Deferred.succeed(firstSent, undefined).pipe(Effect.asVoid)
            : Effect.void,
      })((sent) =>
        Effect.gen(function* () {
          const api = yield* ArcanumApi.ArcanumApi;
          const first = yield* api
            .request({ operation: "first", path: "/v1/first" })
            .pipe(Effect.flip, Effect.forkChild);
          yield* Deferred.await(firstSent);
          yield* Fiber.join(first);
          const second = yield* api
            .request({ operation: "second", path: "/v1/second" })
            .pipe(Effect.flip, Effect.forkChild);
          yield* TestClock.adjust("999 millis");
          assert.equal(sent.length, 1);
          yield* TestClock.adjust("1 millis");
          assert.equal((yield* Fiber.join(second)).reason, "rate-limited");
          assert.equal(sent.length, 1);
        }),
      );
    }),
  );

  it.effect("sends the OAuth token only to Arcanum's API origin, with its query", () =>
    provideHarness({ routes: { "GET /v1/review-requests/7": data({ id: 7 }) } })((sent) =>
      Effect.gen(function* () {
        const api = yield* ArcanumApi.ArcanumApi;
        const response = yield* api.request({
          operation: "test",
          path: "/v1/review-requests/7",
          query: { fields: "id,vcs(from_branch)", unset: undefined },
        });
        assert.equal(response.user, "alice");
        assert.equal(sent[0]?.origin, "https://arcanum.yandex.net");
        assert.equal(sent[0]?.authorization, "OAuth env-token");
        assert.equal(sent[0]?.query.get("fields"), "id,vcs(from_branch)");
        assert.isFalse(sent[0]?.query.has("unset"));

        const escaped = yield* Effect.flip(
          api.request({ operation: "test", path: "/../../evil.example/x" }),
        );
        assert.equal(escaped.reason, "failed");
        assert.equal(sent.length, 1);
      }),
    ),
  );

  it.effect("maps statuses to reasons without echoing the token, and refuses redirects", () =>
    provideHarness({
      routes: {
        "GET /401": jsonResponse(401, {
          errors: [{ message: "blackbox token validation failed" }],
        }),
        "GET /403": jsonResponse(403, { errors: [{ message: "no access" }] }),
        "GET /409": jsonResponse(409, { errors: [{ message: "CANCEL_IS_BUSY" }] }),
        "POST /400": jsonResponse(400, {
          code: "INVALID_ARGUMENT",
          message: "Required flow variable title is missing",
        }),
        "GET /429": jsonResponse(429, null),
        "GET /302": new Response(null, {
          status: 302,
          headers: { location: "https://elsewhere.example/" },
        }),
        "POST /503": jsonResponse(503, null),
      },
    })(() =>
      Effect.gen(function* () {
        const api = yield* ArcanumApi.ArcanumApi;
        const flip = (path: string, method: "GET" | "POST" = "GET") =>
          Effect.flip(api.request({ operation: "test", method, path: `/${path}` }));
        const unauthenticated = yield* flip("401");
        assert.equal(unauthenticated.reason, "unauthenticated");
        assert.include(unauthenticated.detail, "ARC_TOKEN");
        assert.notInclude(unauthenticated.detail, "env-token");
        const forbidden = yield* flip("403");
        assert.equal(forbidden.reason, "failed");
        assert.include(forbidden.detail, "does not let this account");
        assert.include((yield* flip("409")).detail, "CANCEL_IS_BUSY");
        assert.equal(
          (yield* flip("400", "POST")).detail,
          "Arcanum answered HTTP 400: Required flow variable title is missing",
        );
        assert.equal((yield* flip("404")).reason, "not-found");
        assert.include((yield* flip("302")).detail, "redirect");
        const lost = yield* flip("503", "POST");
        assert.isTrue(lost.outcomeUnknown);
        assert.equal((yield* flip("429")).reason, "rate-limited");
        // Without Retry-After the pause falls back to its own backoff.
        const held = yield* flip("404");
        assert.equal(held.reason, "rate-limited");
        assert.isDefined(held.retryAt);
      }),
    ),
  );

  it.effect("verifies the account per credential, and a changed saved token re-verifies", () =>
    Effect.gen(function* () {
      let user = "alice";
      const run = provideHarness({
        routes: {
          "GET /v2/users/me": () => jsonResponse(200, account(user), user),
        },
      });
      yield* run((sent) =>
        Effect.gen(function* () {
          const api = yield* ArcanumApi.ArcanumApi;
          const settings = yield* TestSourceControlHost.TestSourceControlHostSettings;
          const first = yield* api.identity("test");
          assert.equal(first.login, "alice");
          assert.deepStrictEqual(first.account, { outstaff: false, banned: false });
          assert.equal(sent[0]?.path, "/v2/users/me");
          assert.equal(sent[0]?.query.get("fields"), "name,outstaff,banned");
          assert.equal((yield* api.identity("test")).login, "alice");
          assert.equal(sent.length, 1);
          // A saved token outranks ARC_TOKEN at once, and is verified on its own.
          user = "bob";
          yield* settings.update({ sourceControlHosts: { arcanum: { token: "saved" } } });
          const saved = yield* api.identity("test");
          assert.equal(saved.login, "bob");
          assert.equal(saved.credential.source, "settings");
          assert.equal(sent.at(-1)?.authorization, "OAuth saved");
          assert.notEqual(saved.credential.fingerprint, "saved");
          yield* settings.update({
            sourceControlHosts: {
              arcanum: { token: "", tokens: { "a.yandex-team.ru": "legacy" } },
            },
          });
          assert.equal((yield* api.identity("test")).credential.source, "settings");
          assert.equal(sent.at(-1)?.authorization, "OAuth legacy");
        }),
      );
    }),
  );

  it.effect("leaves the account unknown when the probe's body is not the header's account", () =>
    Effect.gen(function* () {
      for (const body of [data({ name: "mallory", outstaff: false, banned: false }), data({})]) {
        const identity = yield* provideHarness({
          routes: { "GET /v2/users/me": () => jsonResponse(200, body, "alice") },
        })(() => Effect.flatMap(ArcanumApi.ArcanumApi, (api) => api.identity("test")));
        assert.equal(identity.login, "alice");
        assert.isUndefined(identity.account);
      }
    }),
  );

  it.effect("verifies concurrent cold identities with one request", () =>
    provideHarness({ routes: { "GET /v2/users/me": account() } })((sent) =>
      Effect.gen(function* () {
        const api = yield* ArcanumApi.ArcanumApi;
        const logins = yield* Effect.all(
          Array.from({ length: 4 }, () => api.identity("test")),
          { concurrency: 4 },
        );
        assert.deepStrictEqual(
          logins.map((identity) => identity.login),
          ["alice", "alice", "alice", "alice"],
        );
        assert.equal(sent.length, 1);
      }),
    ),
  );

  it.effect("keeps a refused identity out of the shared verification", () =>
    Effect.gen(function* () {
      let refuse = true;
      yield* provideHarness({
        routes: {
          "GET /v2/users/me": () =>
            refuse ? jsonResponse(401, null) : jsonResponse(200, account()),
        },
      })((sent) =>
        Effect.gen(function* () {
          const api = yield* ArcanumApi.ArcanumApi;
          assert.equal((yield* Effect.flip(api.identity("test"))).reason, "unauthenticated");
          refuse = false;
          assert.equal((yield* api.identity("test")).login, "alice");
          assert.equal(sent.length, 2);
        }),
      );
    }),
  );

  it.effect("holds background reads of a credential Arcanum paused, until Retry-After", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-03T10:00:00Z"));
      yield* provideHarness({
        settings: withSavedToken("first"),
        routes: {
          "GET /limited": new Response(null, { status: 429, headers: { "retry-after": "120" } }),
          "GET /x": data({}),
          "POST /x": data({}),
        },
      })((sent) =>
        Effect.gen(function* () {
          const api = yield* ArcanumApi.ArcanumApi;
          const settings = yield* TestSourceControlHost.TestSourceControlHostSettings;
          const limited = yield* Effect.flip(api.request({ operation: "test", path: "/limited" }));
          assert.equal(limited.reason, "rate-limited");
          assert.equal(limited.retryAt, Date.parse("2026-11-03T10:02:00Z"));

          const held = yield* Effect.flip(api.request({ operation: "test", path: "/x" }));
          assert.equal(held.reason, "rate-limited");
          assert.equal(held.retryAt, Date.parse("2026-11-03T10:02:00Z"));
          assert.equal(sent.length, 1);
          // Identity reads go through the same pause.
          assert.equal((yield* Effect.flip(api.identity("test"))).reason, "rate-limited");
          assert.equal(sent.length, 1);

          // A user waiting on a read, or a write, still goes out; a write is never repeated.
          yield* api
            .request({ operation: "test", path: "/x" })
            .pipe(Effect.provideService(SourceControlRateLimit.Interactive, true));
          yield* api.request({ operation: "test", method: "POST", path: "/x" });
          assert.equal(sent.length, 3);

          // Another credential has its own quota.
          yield* settings.update({ sourceControlHosts: { arcanum: { token: "second" } } });
          yield* api.request({ operation: "test", path: "/x" });
          assert.equal(sent.at(-1)?.authorization, "OAuth second");

          yield* settings.update({ sourceControlHosts: { arcanum: { token: "first" } } });
          yield* TestClock.adjust("2 minutes");
          yield* api.request({ operation: "test", path: "/x" });
          assert.equal(sent.at(-1)?.authorization, "OAuth first");
          assert.equal(sent.length, 5);
        }),
      );
    }),
  );

  it.effect("reads an HTTP-date Retry-After", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-03T10:00:00Z"));
      yield* provideHarness({
        routes: {
          "GET /limited": new Response(null, {
            status: 429,
            headers: { "retry-after": "Tue, 03 Nov 2026 10:05:00 GMT" },
          }),
        },
      })(() =>
        Effect.gen(function* () {
          const api = yield* ArcanumApi.ArcanumApi;
          const limited = yield* Effect.flip(api.request({ operation: "test", path: "/limited" }));
          assert.equal(limited.retryAt, Date.parse("2026-11-03T10:05:00Z"));
        }),
      );
    }),
  );

  it.effect("sends at most four requests at once", () =>
    Effect.gen(function* () {
      const entered = yield* Queue.unbounded<{
        readonly releasedBefore: number;
        readonly release: Deferred.Deferred<void>;
      }>();
      let released = 0;
      yield* provideHarness({
        routes: { "GET /x": data({}) },
        gate: () =>
          Effect.gen(function* () {
            const release = yield* Deferred.make<void>();
            yield* Queue.offer(entered, { releasedBefore: released, release });
            yield* Deferred.await(release);
          }),
      })((sent) =>
        Effect.gen(function* () {
          const api = yield* ArcanumApi.ArcanumApi;
          const fiber = yield* Effect.all(
            Array.from({ length: 5 }, () => api.request({ operation: "test", path: "/x" })),
            { concurrency: "unbounded" },
          ).pipe(Effect.forkChild);
          const first = yield* Effect.all(Array.from({ length: 4 }, () => Queue.take(entered)));
          released += 1;
          yield* Deferred.succeed(first[0]!.release, undefined);
          const fifth = yield* Queue.take(entered);
          assert.equal(fifth.releasedBefore, 1);
          for (const entry of [...first.slice(1), fifth]) {
            yield* Deferred.succeed(entry.release, undefined);
          }
          yield* Fiber.join(fiber);
          assert.equal(sent.length, 5);
        }),
      );
    }),
  );

  describe("shared reads", () => {
    const shared = (maxAge?: Duration.Input): ArcanumApi.ArcanumApiRequest => ({
      operation: "test",
      path: "/x",
      query: { fields: "id" },
      reuse: { tag: "pr:1", ttl: "5 seconds", ...(maxAge === undefined ? {} : { maxAge }) },
    });

    it.effect("answers readers of one credential once, and never another credential", () =>
      provideHarness({ settings: withSavedToken("first"), routes: { "GET /x": data({}) } })(
        (sent) =>
          Effect.gen(function* () {
            const api = yield* ArcanumApi.ArcanumApi;
            const settings = yield* TestSourceControlHost.TestSourceControlHostSettings;
            yield* Effect.all([api.request(shared()), api.request(shared())], {
              concurrency: 2,
            });
            yield* api.request(shared());
            assert.equal(sent.length, 1);
            yield* settings.update({ sourceControlHosts: { arcanum: { token: "second" } } });
            yield* api.request(shared());
            assert.deepStrictEqual(
              sent.map((request) => request.authorization),
              ["OAuth first", "OAuth second"],
            );
            // Too old for this reader: it asks again, and leaves its answer for the others.
            yield* TestClock.adjust("3 seconds");
            yield* api.request(shared("2 seconds"));
            yield* api.request(shared("2 seconds"));
            assert.equal(sent.length, 3);
            yield* api.request(shared("0 millis"));
            assert.equal(sent.length, 4);
            yield* TestClock.adjust("6 seconds");
            yield* api.request(shared());
            assert.equal(sent.length, 5);
          }),
      ),
    );

    it.effect("keeps a read that started before a write from answering after it", () =>
      Effect.gen(function* () {
        const held = yield* Deferred.make<void>();
        const entered = yield* Deferred.make<void>();
        let version = 0;
        yield* provideHarness({
          routes: {
            "GET /x": () => data({ version }),
            "POST /x": () => {
              version += 1;
              return data({});
            },
          },
          gate: (request) =>
            request.method === "GET" && version === 0
              ? Deferred.succeed(entered, undefined).pipe(
                  Effect.forkDetach,
                  Effect.andThen(Deferred.await(held)),
                )
              : Effect.void,
        })((sent) =>
          Effect.gen(function* () {
            const api = yield* ArcanumApi.ArcanumApi;
            const before = yield* api.request(shared()).pipe(Effect.forkChild);
            yield* Deferred.await(entered);
            yield* api.request({ operation: "test", method: "POST", path: "/x" });
            yield* Deferred.succeed(held, undefined);
            assert.include((yield* Fiber.join(before)).text, '"version":0');
            const after = yield* api.request(shared());
            assert.include(after.text, '"version":1');
            assert.deepStrictEqual(
              sent.map((request) => request.method),
              ["GET", "POST", "GET"],
            );
            // A write that names the tags it changes leaves the other shared reads alone.
            yield* api.request({ operation: "test", method: "POST", path: "/x", forgets: [] });
            yield* api.request(shared());
            assert.equal(sent.length, 4);
            yield* api.forget(["pr:1"]);
            yield* api.request(shared());
            assert.equal(sent.length, 5);
          }),
        );
      }),
    );

    it.effect("stops a background read queued for a slot once a 429 lands, never a user's", () =>
      Effect.gen(function* () {
        const entered = yield* Queue.unbounded<void>();
        const release = yield* Deferred.make<void>();
        yield* provideHarness({
          routes: {
            "GET /busy": new Response(null, { status: 429, headers: { "retry-after": "60" } }),
            "GET /x": data({}),
          },
          gate: (request) =>
            request.path === "/busy"
              ? Queue.offer(entered, undefined).pipe(
                  Effect.forkDetach,
                  Effect.andThen(Deferred.await(release)),
                )
              : Effect.void,
        })((sent) =>
          Effect.gen(function* () {
            const api = yield* ArcanumApi.ArcanumApi;
            const credentials = yield* ArcanumCredentials.ArcanumCredentials;
            const pinned = yield* credentials.get;
            const pin = <A, E>(effect: Effect.Effect<A, E>) =>
              effect.pipe(Effect.provideService(ArcanumApi.PinnedCredential, pinned));
            // Every slot is taken by a request about to be rate limited.
            const busy = yield* Effect.all(
              Array.from({ length: 4 }, () =>
                pin(Effect.flip(api.request({ operation: "test", path: "/busy" }))),
              ),
              { concurrency: "unbounded" },
            ).pipe(Effect.forkChild);
            yield* Effect.all(Array.from({ length: 4 }, () => Queue.take(entered)));
            // Both pass the pause check before any 429, then wait for a slot.
            const background = yield* pin(Effect.flip(api.request(shared()))).pipe(
              Effect.forkChild({ startImmediately: true }),
            );
            const user = yield* pin(api.request(shared())).pipe(
              Effect.provideService(SourceControlRateLimit.Interactive, true),
              Effect.forkChild({ startImmediately: true }),
            );
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(busy);
            const held = yield* Fiber.join(background);
            assert.equal(held.reason, "rate-limited");
            yield* Fiber.join(user);
            assert.equal(sent.filter((request) => request.path === "/x").length, 1);
          }),
        );
      }),
    );

    it.effect("keeps a shared read going for the readers left when one is interrupted", () =>
      Effect.gen(function* () {
        const held = yield* Deferred.make<void>();
        const entered = yield* Deferred.make<void>();
        yield* provideHarness({
          routes: { "GET /x": data({ ok: true }) },
          // Signalled from its own fiber: a synchronous signal would wake the test before the
          // shared read is registered, which a real response never does.
          gate: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.forkDetach,
              Effect.andThen(Deferred.await(held)),
            ),
        })((sent) =>
          Effect.gen(function* () {
            const api = yield* ArcanumApi.ArcanumApi;
            const credentials = yield* ArcanumCredentials.ArcanumCredentials;
            // Pinned, so the second reader reaches the shared read without suspending first.
            const pinned = yield* credentials.get;
            const read = api
              .request(shared())
              .pipe(Effect.provideService(ArcanumApi.PinnedCredential, pinned));
            const first = yield* read.pipe(Effect.forkChild);
            yield* Deferred.await(entered);
            const second = yield* read.pipe(Effect.forkChild({ startImmediately: true }));
            yield* Fiber.interrupt(first);
            yield* Deferred.succeed(held, undefined);
            assert.include((yield* Fiber.join(second)).text, "ok");
            assert.equal(sent.length, 1);
          }),
        );
      }),
    );
  });

  it.effect("keeps the pinned credential for a whole operation", () =>
    provideHarness({
      settings: withSavedToken("first"),
      routes: { "GET /x": data({}) },
    })((sent) =>
      Effect.gen(function* () {
        const api = yield* ArcanumApi.ArcanumApi;
        const credentials = yield* ArcanumCredentials.ArcanumCredentials;
        const settings = yield* TestSourceControlHost.TestSourceControlHostSettings;
        const pinned = yield* credentials.get;
        yield* settings.update({ sourceControlHosts: { arcanum: { token: "second" } } });
        yield* api
          .request({ operation: "test", path: "/x" })
          .pipe(Effect.provideService(ArcanumApi.PinnedCredential, pinned));
        yield* api.request({ operation: "test", path: "/x" });
        assert.deepStrictEqual(
          sent.map((request) => request.authorization),
          ["OAuth first", "OAuth second"],
        );
      }),
    ),
  );
});

describe("ArcanumCredentials", () => {
  const exit = (code: number) => ChildProcessSpawner.ExitCode(code);

  it.effect(
    "falls back to `arc token show --json`, with fixed arguments and no token in argv",
    () =>
      Effect.gen(function* () {
        const runs: Array<ReadonlyArray<string>> = [];
        yield* provideHarness({
          env: {},
          routes: {},
          process: (input) =>
            Effect.sync(() => {
              runs.push([input.command, ...input.args]);
              return TestSourceControlHost.processOutput(
                JSON.stringify({ token: "arc-token", type: "oauth" }),
              );
            }),
        })(() =>
          Effect.gen(function* () {
            const credentials = yield* ArcanumCredentials.ArcanumCredentials;
            const first = yield* credentials.get;
            const second = yield* credentials.get;
            assert.equal(first.source, "arc");
            assert.equal(first.fingerprint, second.fingerprint);
            // One run serves both reads, and refusing it asks Arc again.
            assert.deepStrictEqual(runs, [["arc", "token", "show", "--json"]]);
            yield* credentials.invalidate(first);
            yield* credentials.get;
            assert.equal(runs.length, 2);
          }),
        );
      }),
  );

  it.effect("reports a missing credential, and never quotes Arc's output", () =>
    provideHarness({
      env: {},
      routes: {},
      process: () =>
        Effect.succeed(
          TestSourceControlHost.processOutput("not json but a token-ish secret", {
            exitCode: exit(0),
          }),
        ),
    })(() =>
      Effect.gen(function* () {
        const credentials = yield* ArcanumCredentials.ArcanumCredentials;
        const error = yield* Effect.flip(credentials.get);
        assert.equal(error._tag, "ArcanumCredentialFailedError");
        assert.notInclude(String(error), "token-ish secret");
        const api = yield* ArcanumApi.ArcanumApi;
        const failed = yield* Effect.flip(api.request({ operation: "test", path: "/x" }));
        assert.equal(failed.reason, "failed");
        assert.notInclude(failed.detail, "token-ish secret");
      }),
    ),
  );
});
