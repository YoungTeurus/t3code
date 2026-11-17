import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ArcOperations from "./ArcOperations.ts";
import * as VcsProcess from "./VcsProcess.ts";
import { makeArcCodeSearch } from "./ArcCodeSearch.ts";

it.effect.each(["arcadia", "cloudia"] as const)(
  "searches %s trunk with scoped paths and credential-safe caching",
  (repository) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-code-search-" });
      yield* fs.makeDirectory(`${root}/.arc`);
      yield* fs.writeFileString(`${root}/.arc/config`, 'Server { Host: "arc-vcs.yandex-team.ru" }');
      const environment = { ARC_TOKEN: "first-token" };
      const requests: Array<{ url: string; authorization: string | undefined }> = [];
      let unavailable = false;
      const operations = yield* ArcOperations.ArcOperations.pipe(
        Effect.provide(
          Layer.mock(ArcOperations.ArcOperations)({
            context: () =>
              Effect.succeed({
                root,
                cwd: `${root}/project`,
                scope: "project",
                repository,
                head: "a".repeat(40),
                branch: "task",
                upstream: null,
                identity: root,
              }),
            changes: () => Effect.die("unexpected local scan"),
            localStatus: () => Effect.die("unexpected local scan"),
          }),
        ),
      );
      const search = yield* makeArcCodeSearch(operations).pipe(
        Effect.provideService(HostProcess.Environment, environment),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            requests.push({ url: request.url, authorization: request.headers.authorization });
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                unavailable
                  ? new Response("{}", { status: 503 })
                  : new Response(
                      JSON.stringify({
                        Chunks: [
                          {
                            CodeChunk: {
                              File: "project/main.ts",
                              Matches: [
                                { FirstLine: 4, Snippet: "λx", Ranges: [{ From: 2, To: 3 }] },
                              ],
                            },
                          },
                          {
                            CodeChunk: {
                              File: "elsewhere/secret.ts",
                              Matches: [{ FirstLine: 1, Snippet: "x" }],
                            },
                          },
                        ],
                        Stats: { IndexRevision: "r1" },
                      }),
                    ),
              ),
            );
          }),
        ),
      );
      const input = {
        cwd: `${root}/project`,
        query: "x",
        limit: 10,
        caseSensitive: true,
        wholeWord: false,
        useRegex: false,
      };
      const first = yield* search.searchContents(input);
      assert.deepEqual(first.matches, [
        { path: "main.ts", lineNumber: 4, lineContent: "λx", matchRanges: [{ start: 1, end: 2 }] },
      ]);
      assert.deepEqual(first.source, { index: `${repository}/trunk`, revision: "r1" });
      yield* search.searchContents(input);
      assert.equal(requests.length, 1);
      environment.ARC_TOKEN = "second-token";
      yield* search.searchContents(input);
      assert.equal(requests.length, repository === "cloudia" ? 2 : 1);
      assert.equal(
        requests[0]?.url,
        repository === "cloudia"
          ? "https://cloudia.codesearch.yandex-team.ru/search"
          : "https://codesearch.yandex-team.ru/search",
      );
      assert.equal(
        requests.at(-1)?.authorization,
        repository === "cloudia" ? "OAuth second-token" : undefined,
      );
      unavailable = true;
      const failed = yield* search.searchContents({ ...input, query: "retry" }).pipe(Effect.flip);
      assert.equal(failed.reason, "Code Search failed (HTTP 503).");
      unavailable = false;
      assert.equal((yield* search.searchContents({ ...input, query: "retry" })).matches.length, 1);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(VcsProcess.VcsProcess)({ run: () => Effect.die("unexpected local process") }),
        ),
      ),
    ),
);
