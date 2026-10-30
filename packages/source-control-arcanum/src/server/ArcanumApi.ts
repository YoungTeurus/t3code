import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import { readSourceControlHostSettings } from "@t3tools/source-control-core/shared/definition";
import { definition, settings } from "../shared/definition.ts";

export class ArcanumApiError extends Schema.TaggedError<ArcanumApiError>()("ArcanumApiError", {
  operation: Schema.String,
  reason: Schema.Literals([
    "missing-tool",
    "unauthenticated",
    "forbidden",
    "rate-limited",
    "not-found",
    "conflict",
    "failed",
  ]),
  status: Schema.optional(Schema.Number),
}) {}

export interface ArcanumRequest {
  readonly cwd: string;
  readonly operation: string;
  readonly path: string;
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly body?: unknown;
  readonly idempotencyKey?: string;
}

export class ArcanumApi extends Context.Service<
  ArcanumApi,
  {
    readonly request: <A>(
      input: ArcanumRequest,
      schema: Schema.Codec<A>,
    ) => Effect.Effect<A, ArcanumApiError>;
    readonly viewer: (cwd: string) => Effect.Effect<string, ArcanumApiError>;
    readonly withVerifiedCredential: <A, E, R>(
      cwd: string,
      use: (identity: {
        readonly viewer: string;
        readonly credentialFingerprint: string;
      }) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | ArcanumApiError, R>;
  }
>()("@t3tools/source-control-arcanum/server/ArcanumApi") {}

const Wrapper = Schema.Struct({
  data: Schema.optional(Schema.Unknown),
  errors: Schema.optional(Schema.Array(Schema.Unknown)),
});
const decodeWrapper = Schema.decodeUnknownEffect(Wrapper);
const Viewer = Schema.Struct({ login: Schema.NonEmptyString });
const decodeViewer = Schema.decodeUnknownEffect(Viewer);
const PinnedCredential = Context.Reference<Redacted.Redacted<string> | null>(
  "@t3tools/source-control-arcanum/server/ArcanumApi/PinnedCredential",
  { defaultValue: () => null },
);
const PinnedIdentity = Context.Reference<{
  readonly viewer: string;
  readonly credentialFingerprint: string;
} | null>("@t3tools/source-control-arcanum/server/ArcanumApi/PinnedIdentity", {
  defaultValue: () => null,
});

const parseJson = (text: string): unknown =>
  JSON.parse(text, (_key, value: unknown, source?: { source?: string }) => {
    if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      if (source?.source && /^-?\d+$/u.test(source.source)) return source.source;
      throw new TypeError("Unsafe numeric identifier in an Arcanum response.");
    }
    return value;
  });
const serializeBody = (body: unknown): string => {
  const raw = (JSON as typeof JSON & { readonly rawJSON?: (source: string) => unknown }).rawJSON;
  const encoded = JSON.stringify(body, (key, value: unknown) => {
    if (key === "reply_to_id" && typeof value === "string") {
      if (!/^-?[1-9]\d*$/u.test(value) || !raw) throw new TypeError("Invalid comment identifier.");
      return raw(value);
    }
    if (typeof value === "number" && !Number.isSafeInteger(value))
      throw new TypeError("Unsafe numeric value in an Arcanum request.");
    return value;
  });
  if (encoded === undefined) throw new TypeError("Missing Arcanum request body.");
  return encoded;
};

const make = Effect.gen(function* () {
  const host = yield* SourceControlHost.SourceControlHost;
  const http = yield* HttpClient.HttpClient;
  const limits = yield* SourceControlRateLimit.SourceControlRateLimit;
  const environment = yield* HostProcess.Environment;
  const crypto = yield* Crypto.Crypto;
  const permit = yield* Semaphore.make(1);
  let lastRequest: number | null = null;
  const failure = (
    operation: string,
    reason: ArcanumApiError["reason"] = "failed",
    status?: number,
  ) => new ArcanumApiError({ operation, reason, ...(status === undefined ? {} : { status }) });
  const cliTokens = yield* Cache.makeWith(
    (cwd: string) =>
      host.process
        .run({
          cwd,
          operation: "ArcanumApi.credential",
          command: "arc",
          args: ["token", "show"],
          timeoutMs: 10_000,
          maxOutputBytes: 16_384,
          outputMode: "error",
        })
        .pipe(
          Effect.mapError(() => failure("credential", "unauthenticated")),
          Effect.flatMap((output) =>
            output.stdout.trim() && !output.stdoutTruncated
              ? Effect.succeed(Redacted.make(output.stdout.trim()))
              : Effect.fail(failure("credential", "unauthenticated")),
          ),
        ),
    { capacity: 32, timeToLive: (exit) => (Exit.isSuccess(exit) ? "30 seconds" : "0 seconds") },
  );
  const credential = Effect.fn("ArcanumApi.credential")(function* (cwd: string) {
    const pinned = yield* PinnedCredential;
    if (pinned !== null) return pinned;
    const stored = yield* host.settings.get.pipe(
      Effect.map((config) =>
        readSourceControlHostSettings(settings, config.sourceControlHosts[definition.kind]),
      ),
      Effect.option,
    );
    const value = Option.getOrUndefined(stored);
    if (value?.hosts["a.yandex-team.ru"]?.enabled === false)
      return yield* failure("credential", "unauthenticated");
    const token =
      value?.tokens["a.yandex-team.ru"]?.trim() ||
      environment.ARCANUM_TOKEN?.trim() ||
      environment.ARC_TOKEN?.trim();
    return token ? Redacted.make(token) : yield* Cache.get(cliTokens, cwd);
  });
  const send = Effect.fn("ArcanumApi.send")(function (input: ArcanumRequest, userInfo = false) {
    return permit.withPermit(
      Effect.gen(function* () {
        if (!/^\/v[12]\//u.test(input.path) || /[\0\r\n]/u.test(input.path))
          return yield* failure(input.operation);
        const token = yield* credential(input.cwd);
        const key = { provider: definition.kind, host: "arcanum.yandex.net" };
        const lease = yield* limits
          .check(key, { allowPaused: yield* SourceControlRateLimit.Interactive })
          .pipe(Effect.mapError(() => failure(input.operation, "rate-limited")));
        const now = yield* Clock.currentTimeMillis;
        if (lastRequest !== null && now - lastRequest < 1_000)
          yield* Effect.sleep(1_000 - (now - lastRequest));
        lastRequest = yield* Clock.currentTimeMillis;
        const url = userInfo
          ? "https://login.yandex-team.ru/info?format=json"
          : `https://arcanum.yandex.net/api${input.path}`;
        let request = HttpClientRequest.make(input.method ?? "GET")(url).pipe(
          HttpClientRequest.setHeaders({
            authorization: `OAuth ${Redacted.value(token)}`,
            accept: "application/json",
            ...(input.idempotencyKey ? { "idempotency-key": input.idempotencyKey } : {}),
          }),
        );
        if (input.body !== undefined) {
          const body = yield* Effect.try({
            try: () => serializeBody(input.body),
            catch: () => failure(input.operation),
          });
          request = request.pipe(HttpClientRequest.bodyText(body, "application/json"));
        }
        const response = yield* http.execute(request).pipe(
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
          Effect.mapError(() => failure(input.operation)),
        );
        if (response.status < 200 || response.status >= 300) {
          if (response.status === 401) yield* Cache.invalidate(cliTokens, input.cwd);
          if (response.status === 429)
            yield* limits.recordRateLimit({
              ...key,
              lease,
              retryAt: SourceControlRateLimit.retryAtFromHeader(
                response.headers["retry-after"],
                yield* Clock.currentTimeMillis,
              ),
            });
          return yield* failure(
            input.operation,
            response.status === 401
              ? "unauthenticated"
              : response.status === 403
                ? "forbidden"
                : response.status === 429
                  ? "rate-limited"
                  : response.status === 404
                    ? "not-found"
                    : response.status === 409
                      ? "conflict"
                      : "failed",
            response.status,
          );
        }
        yield* limits.recordSuccess({ ...key, lease });
        if (response.status === 204) return undefined;
        const body = yield* collectUint8StreamText({
          stream: response.stream,
          maxBytes: 8 * 1024 * 1024,
        }).pipe(Effect.mapError(() => failure(input.operation)));
        if (body.truncated || body.invalidUtf8) return yield* failure(input.operation);
        const decoded = yield* Effect.try({
          try: () => (body.text.trim() ? parseJson(body.text) : {}),
          catch: () => failure(input.operation),
        });
        if (userInfo) return decoded;
        const wrapper = yield* decodeWrapper(decoded).pipe(
          Effect.mapError(() => failure(input.operation)),
        );
        if (wrapper.errors?.length) return yield* failure(input.operation);
        return wrapper.data;
      }).pipe(
        Effect.timeoutOrElse({
          duration: "30 seconds",
          orElse: () => Effect.fail(failure(input.operation)),
        }),
      ),
    );
  });
  const viewer = Effect.fn("ArcanumApi.viewer")(function* (cwd: string) {
    const data = yield* send({ cwd, operation: "viewer", path: "/v1/viewer" }, true);
    return (yield* decodeViewer(data).pipe(Effect.mapError(() => failure("viewer")))).login;
  });
  return ArcanumApi.of({
    request: Effect.fn("ArcanumApi.request")(function* <A>(
      input: ArcanumRequest,
      schema: Schema.Codec<A>,
    ) {
      const data = yield* send(input);
      return yield* Schema.decodeUnknownEffect(schema)(data).pipe(
        Effect.mapError(() => failure(input.operation)),
      );
    }),
    viewer,
    withVerifiedCredential: Effect.fn("ArcanumApi.withVerifiedCredential")(function* <A, E, R>(
      cwd: string,
      use: (identity: {
        readonly viewer: string;
        readonly credentialFingerprint: string;
      }) => Effect.Effect<A, E, R>,
    ) {
      const current = yield* PinnedIdentity;
      if (current !== null) return yield* use(current);
      const token = yield* credential(cwd);
      const fingerprint = yield* crypto
        .digest("SHA-256", new TextEncoder().encode(Redacted.value(token)))
        .pipe(
          Effect.map(Hex.encode),
          Effect.mapError(() => failure("credentialFingerprint")),
        );
      const login = yield* viewer(cwd).pipe(Effect.provideService(PinnedCredential, token));
      const identity = { viewer: login, credentialFingerprint: fingerprint };
      return yield* use(identity).pipe(
        Effect.provideService(PinnedCredential, token),
        Effect.provideService(PinnedIdentity, identity),
        Effect.provideService(SourceControlRateLimit.CredentialScope, fingerprint),
      );
    }),
  });
});

export const layer = Layer.effect(ArcanumApi, make);
