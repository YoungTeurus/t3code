import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ArcanumApi from "./ArcanumApi.ts";
import * as ArcanumCredentials from "./ArcanumCredentials.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

export interface SentRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly origin: string;
  readonly authorization: string | undefined;
  readonly idempotencyKey: string | undefined;
  readonly body: unknown;
}

export type Route = unknown | Response | ((request: SentRequest) => unknown | Response);

/** `{data: value}`, as Arcanum wraps every answer. */
export const data = (value: unknown) => ({ data: value });

/** The identity probe's answer for a staff account in good standing. */
export const account = (name = "alice", fields: { outstaff?: boolean; banned?: boolean } = {}) =>
  data({ name, outstaff: false, banned: false, ...fields });

/**
 * A scripted Arcanum: `"METHOD /path"` keys answer with JSON (wrapped by the caller) or a
 * `Response`; anything unscripted is a 404 so a missing route fails loudly in the test.
 */
function fakeArcanum(
  routes: Record<string, Route>,
  options: {
    readonly user?: string;
    readonly gate?: ((request: SentRequest) => Effect.Effect<void>) | undefined;
  } = {},
) {
  const sent: Array<SentRequest> = [];
  const client = HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
    const url = new URL(request.url);
    const entry: SentRequest = {
      method: request.method,
      path: url.pathname.replace(/^\/api/u, ""),
      query: url.searchParams,
      origin: url.origin,
      authorization: request.headers.authorization,
      idempotencyKey: request.headers["idempotency-key"],
      body:
        request.body._tag === "Uint8Array"
          ? decodeJson(new TextDecoder().decode(request.body.body))
          : undefined,
    };
    sent.push(entry);
    const route = routes[`${entry.method} ${entry.path}`];
    const answer = typeof route === "function" ? route(entry) : route;
    const headers = {
      "content-type": "application/json",
      "x-arcanum-user": options.user ?? "alice",
    };
    const response =
      answer instanceof Response
        ? answer
        : answer === undefined
          ? new Response(encodeJson({ errors: [{ status: "404", message: "not found" }] }), {
              status: 404,
              headers,
            })
          : new Response(answer === null ? null : encodeJson(answer), {
              status: answer === null ? 204 : 200,
              headers,
            });
    const answered = HttpClientResponse.fromWeb(request, response);
    return options.gate === undefined
      ? Effect.succeed(answered)
      : options.gate(entry).pipe(Effect.as(answered));
  });
  return { sent, client };
}

export const jsonResponse = (status: number, body: unknown, user = "alice") =>
  new Response(body === null ? null : encodeJson(body), {
    status,
    headers: { "content-type": "application/json", "x-arcanum-user": user },
  });

export interface HarnessOptions {
  readonly requestSpacingMs?: number;
  readonly routes: Record<string, Route>;
  readonly user?: string;
  readonly settings?: ServerSettings;
  readonly env?: NodeJS.ProcessEnv;
  readonly process?: SourceControlHost.SourceControlHost["Service"]["process"]["run"];
  readonly review?: Partial<SourceControlHost.SourceControlHost["Service"]["review"]>;
  readonly home?: string;
  /** Holds each request until it succeeds, after the request is recorded as sent. */
  readonly gate?: (request: SentRequest) => Effect.Effect<void>;
}

/** The Arcanum services over a scripted HTTP client and host, with an `ARC_TOKEN` by default. */
export function harness(options: HarnessOptions) {
  const fake = fakeArcanum(options.routes, {
    ...(options.user === undefined ? {} : { user: options.user }),
    gate: options.gate,
  });
  const host = TestSourceControlHost.layer({
    settings: options.settings ?? DEFAULT_SERVER_SETTINGS,
    ...(options.process === undefined ? {} : { process: { run: options.process } }),
    ...(options.review === undefined ? {} : { review: options.review }),
  });
  const layer = ArcanumApi.layer.pipe(
    Layer.provideMerge(ArcanumCredentials.layer),
    Layer.provideMerge(host),
    Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, fake.client)),
    Layer.provideMerge(SourceControlRateLimit.layer),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ArcanumApi.RequestSpacingMs, options.requestSpacingMs ?? 0),
        Layer.succeed(HostProcess.Environment, options.env ?? { ARC_TOKEN: "env-token" }),
        Layer.succeed(HostProcess.HomeDirectory, options.home ?? "/nonexistent-home-for-tests"),
      ),
    ),
  );
  return { sent: fake.sent, layer };
}

export const provideHarness =
  (options: HarnessOptions) =>
  <A, E, R>(effect: (sent: ReadonlyArray<SentRequest>) => Effect.Effect<A, E, R>) => {
    const { sent, layer } = harness(options);
    return effect(sent).pipe(Effect.provide(layer));
  };
