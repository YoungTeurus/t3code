import { SourceControlProviderKind } from "@t3tools/contracts";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import { ARCANUM_WEB_HOST } from "../shared/definition.ts";
import * as ArcanumCredentials from "./ArcanumCredentials.ts";

/** Arcanum's API origin. The web host serves pages, and requests and credentials only ever go here. */
const ARCANUM_API_ORIGIN = "https://arcanum.yandex.net";

const NO_REDIRECT: RequestInit = { redirect: "manual" };
const TIMEOUT = Duration.seconds(30);
const VIEWER_TTL = Duration.minutes(10);
const MAX_ERROR_TEXT = 300;
/** Requests in flight at once, across every reader of the server. */
const CONCURRENCY = 4;
const SHARED_READ_CAPACITY = 64;
/** The key PullRequestService keeps its own pause under, so both levels share one per credential. */
const RATE_LIMIT_KEY = {
  provider: SourceControlProviderKind.make("arcanum"),
  host: ARCANUM_WEB_HOST,
};

export const RequestSpacingMs = Context.Reference<number>("ArcanumApi/RequestSpacingMs", {
  defaultValue: () => 1_000,
});

export const ArcanumApiFailure = Schema.Literals([
  "missing-tool",
  "unauthenticated",
  "rate-limited",
  "not-found",
  "failed",
]);

export class ArcanumApiError extends Schema.TaggedError<ArcanumApiError>()("ArcanumApiError", {
  operation: Schema.String,
  status: Schema.NullOr(Schema.Int),
  reason: ArcanumApiFailure,
  detail: Schema.String,
  /** The request may have reached Arcanum, so a write's outcome is unknown. */
  outcomeUnknown: Schema.optional(Schema.Boolean),
  /** When a rate-limited credential may send background reads again. */
  retryAt: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Arcanum ${this.operation} failed: ${this.detail}`;
  }
}

export interface ArcanumApiRequest {
  readonly operation: string;
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Below `/api`, starting with `/`. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
  /** Lets a retried creation return the first one rather than a duplicate. */
  readonly idempotencyKey?: string;
  /**
   * A GET that readers of one credential share while it is in flight and for `ttl` after.
   * `maxAge` is the oldest answer this reader takes, `ttl` by default; zero always asks Arcanum
   * and leaves the answer for the others.
   */
  readonly reuse?: {
    readonly tag: string;
    readonly ttl: Duration.Input;
    readonly maxAge?: Duration.Input;
  };
  /** Tags of the shared reads a write can change. Absent means every one. */
  readonly forgets?: ReadonlyArray<string>;
}

export interface ArcanumApiResponse {
  readonly status: number;
  readonly text: string;
  /** `X-Arcanum-User`: the login the credential belongs to. */
  readonly user: string | null;
}

/** What Arcanum says the account may do in review. Absent when its answer was unreadable. */
export interface ArcanumAccount {
  readonly outstaff: boolean;
  readonly banned: boolean;
}

export interface ArcanumIdentity {
  readonly login: string;
  readonly credential: ArcanumCredentials.ArcanumCredential;
  readonly account?: ArcanumAccount;
}

/**
 * The credential an operation verified, so every request inside it uses that one even if the
 * saved token changes meanwhile.
 */
export const PinnedCredential = Context.Reference<ArcanumCredentials.ArcanumCredential | null>(
  "@t3tools/source-control-arcanum/server/ArcanumApi/PinnedCredential",
  { defaultValue: () => null },
);

export class ArcanumApi extends Context.Service<
  ArcanumApi,
  {
    readonly request: (
      input: ArcanumApiRequest,
    ) => Effect.Effect<ArcanumApiResponse, ArcanumApiError>;
    /** The login of the credential in use, verified with Arcanum. */
    readonly identity: (operation: string) => Effect.Effect<ArcanumIdentity, ArcanumApiError>;
    /** The credential requests would use now, without asking Arcanum. */
    readonly credential: Effect.Effect<ArcanumCredentials.ArcanumCredential, ArcanumApiError>;
    /**
     * Runs `use` with the credential requests would use now pinned for all of it, and passes its
     * fingerprint; one already pinned stays. Null, and nothing pinned, without a credential.
     */
    readonly withCredential: <A, E, R>(
      use: (fingerprint: string | null) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    /** Drops shared reads with these tags, or all of them. */
    readonly forget: (tags?: ReadonlyArray<string>) => Effect.Effect<void>;
  }
>()("@t3tools/source-control-arcanum/server/ArcanumApi") {}

const ErrorEnvelope = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({
      errors: Schema.Array(
        Schema.Struct({
          message: Schema.optional(Schema.String),
          details: Schema.optional(Schema.Unknown),
        }),
      ),
    }),
    // `{code, message}`; the code is left out of what users read.
    Schema.Struct({ message: Schema.String }),
  ]),
);
const decodeErrorEnvelope = Schema.decodeUnknownOption(ErrorEnvelope);

function serverErrorText(text: string): string | undefined {
  const envelope = Option.getOrUndefined(decodeErrorEnvelope(text));
  if (envelope === undefined) return undefined;
  return boundedText("errors" in envelope ? envelope.errors[0]?.message : envelope.message);
}
const decodeAccount = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.Struct({
        name: Schema.String,
        outstaff: Schema.Boolean,
        banned: Schema.Boolean,
      }),
    }),
  ),
);

function boundedText(text: string | undefined): string | undefined {
  const line = text?.replace(/\s+/gu, " ").trim();
  if (!line) return undefined;
  return line.length > MAX_ERROR_TEXT ? `${line.slice(0, MAX_ERROR_TEXT)}…` : line;
}

const reasonForStatus = (status: number): typeof ArcanumApiFailure.Type =>
  status === 401
    ? "unauthenticated"
    : status === 429
      ? "rate-limited"
      : status === 404
        ? "not-found"
        : "failed";

function statusDetail(status: number, serverText: string | undefined): string {
  const prefix =
    status === 403
      ? "Arcanum does not let this account do that"
      : status === 404
        ? "Arcanum has no such object, or this account cannot see it"
        : status === 409
          ? "Arcanum refused the change as conflicting with the current state"
          : status === 429
            ? "Arcanum is rate limiting this account"
            : status >= 500
              ? `Arcanum failed (HTTP ${status})`
              : `Arcanum answered HTTP ${status}`;
  return serverText === undefined ? `${prefix}.` : `${prefix}: ${serverText}`;
}

const isWrite = (method: string) => method !== "GET";

/** @public */
export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const credentials = yield* ArcanumCredentials.ArcanumCredentials;
  const limits = yield* SourceControlRateLimit.SourceControlRateLimit;
  const slots = yield* Semaphore.make(CONCURRENCY);
  const pacing = yield* Semaphore.make(1);
  const spacing = yield* RequestSpacingMs;
  let lastSentAt: number | null = null;

  const fail = (
    input: Pick<ArcanumApiRequest, "operation">,
    fields: Pick<ArcanumApiError, "status" | "reason" | "detail"> & {
      readonly outcomeUnknown?: boolean;
      readonly retryAt?: number | undefined;
      readonly cause?: unknown;
    },
  ) =>
    new ArcanumApiError({
      operation: input.operation,
      status: fields.status,
      reason: fields.reason,
      detail: fields.detail,
      ...(fields.outcomeUnknown === true ? { outcomeUnknown: true } : {}),
      ...(fields.retryAt === undefined ? {} : { retryAt: fields.retryAt }),
      ...(fields.cause === undefined ? {} : { cause: fields.cause }),
    });

  const credentialFor = Effect.fnUntraced(function* (input: Pick<ArcanumApiRequest, "operation">) {
    const pinned = yield* PinnedCredential;
    if (pinned !== null) return pinned;
    return yield* credentials.get.pipe(
      Effect.mapError((cause) =>
        fail(input, {
          status: null,
          reason: cause._tag === "ArcanumCredentialMissingError" ? "missing-tool" : "failed",
          detail: cause.message,
          cause,
        }),
      ),
    );
  });

  const send = Effect.fn("ArcanumApi.request")(function* (
    input: ArcanumApiRequest,
    credential: ArcanumCredentials.ArcanumCredential,
  ) {
    const method = input.method ?? "GET";
    const url = new URL(`${ARCANUM_API_ORIGIN}/api${input.path}`);
    for (const [key, value] of Object.entries(input.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    // A path that resolves elsewhere (`..`, an absolute URL) must never carry the token.
    if (url.origin !== ARCANUM_API_ORIGIN || !url.pathname.startsWith("/api/")) {
      return yield* fail(input, {
        status: null,
        reason: "failed",
        detail: "Refused a request outside Arcanum's API.",
      });
    }
    yield* Effect.annotateCurrentSpan({
      "arcanum.operation": input.operation,
      "http.request.method": method,
    });
    const base = HttpClientRequest.make(method)(url.href).pipe(
      HttpClientRequest.setHeaders({
        authorization: `OAuth ${Redacted.value(credential.token)}`,
        accept: "application/json",
        "user-agent": "t3code",
        ...(input.idempotencyKey === undefined ? {} : { "idempotency-key": input.idempotencyKey }),
      }),
    );
    const response = yield* httpClient
      .execute(
        input.body === undefined ? base : base.pipe(HttpClientRequest.bodyJsonUnsafe(input.body)),
      )
      .pipe(
        // Client spans would record query strings naming branches and users.
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
        // fetch would carry the token to any redirect target.
        Effect.provideService(FetchHttpClient.RequestInit, NO_REDIRECT),
        Effect.flatMap((raw) =>
          raw.text.pipe(
            Effect.map((text) => ({
              status: raw.status,
              text,
              user: raw.headers["x-arcanum-user"]?.trim() || null,
              retryAfter: raw.headers["retry-after"],
            })),
          ),
        ),
        Effect.timeout(TIMEOUT),
        Effect.mapError((cause) =>
          fail(input, {
            status: null,
            reason: "failed",
            detail: "Could not reach Arcanum.",
            // A write that went out without an answer may have landed.
            outcomeUnknown: isWrite(method),
            cause,
          }),
        ),
      );
    yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status });
    if (response.status >= 200 && response.status < 300) {
      return { status: response.status, text: response.text, user: response.user };
    }
    if (response.status === 401) {
      yield* credentials.invalidate(credential);
      return yield* fail(input, {
        status: 401,
        reason: "unauthenticated",
        detail: ArcanumCredentials.rejectedCredentialDetail(credential.source),
      });
    }
    if (response.status >= 300 && response.status < 400) {
      return yield* fail(input, {
        status: response.status,
        reason: "failed",
        detail: "Arcanum answered with a redirect, which T3 does not follow with a credential.",
      });
    }
    return yield* fail(input, {
      status: response.status,
      reason: reasonForStatus(response.status),
      detail: statusDetail(response.status, serverErrorText(response.text)),
      // A server error on a write does not say whether the write was applied.
      outcomeUnknown: isWrite(method) && response.status >= 500,
      ...(response.status === 429
        ? {
            retryAt: SourceControlRateLimit.retryAtFromHeader(
              response.retryAfter,
              yield* Clock.currentTimeMillis,
            ),
          }
        : {}),
    });
  });

  /**
   * Every request waits for a shared slot, then honors the pause a 429 starts for its credential.
   * Background reads fail at once while paused. A write or an interactive read has a user waiting
   * on it, so it still goes out, once.
   */
  const guarded = Effect.fn("ArcanumApi.guarded")(
    function* (input: ArcanumApiRequest, credential: ArcanumCredentials.ArcanumCredential) {
      const interactive = yield* SourceControlRateLimit.Interactive;
      const lease = yield* pacing.withPermit(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          if (lastSentAt !== null && now - lastSentAt < spacing)
            yield* Effect.sleep(spacing - (now - lastSentAt));
          const lease = yield* limits
            .check(
              RATE_LIMIT_KEY,
              interactive || isWrite(input.method ?? "GET") ? { allowPaused: true } : undefined,
            )
            .pipe(
              Effect.mapError((paused) =>
                fail(input, {
                  status: null,
                  reason: "rate-limited",
                  detail: statusDetail(429, undefined),
                  retryAt: paused.retryAt,
                }),
              ),
            );
          lastSentAt = yield* Clock.currentTimeMillis;
          return lease;
        }),
      );
      return yield* send(input, credential).pipe(
        Effect.tap(() => limits.recordSuccess({ ...RATE_LIMIT_KEY, lease })),
        Effect.tapError((error) =>
          error.status === 429
            ? limits.recordRateLimit({ ...RATE_LIMIT_KEY, lease, retryAt: error.retryAt })
            : Effect.void,
        ),
      );
    },
    (effect, _input, credential) =>
      slots
        .withPermit(effect)
        .pipe(
          Effect.provideService(SourceControlRateLimit.CredentialScope, credential.fingerprint),
        ),
  );

  // Shared GETs, keyed by credential, so a replaced token never reads another one's answers. A
  // write bumps the generation: a read that started before it never lands after it.
  let generation = 0;
  // Fingerprint, tag, time to live, path and sorted query, none of which holds a NUL.
  const sharedKey = (input: ArcanumApiRequest, credential: ArcanumCredentials.ArcanumCredential) =>
    [
      credential.fingerprint,
      input.reuse!.tag,
      String(Duration.toMillis(Duration.fromInputUnsafe(input.reuse!.ttl))),
      input.path,
      new URLSearchParams(
        Object.entries(input.query ?? {})
          .flatMap(([name, value]): Array<[string, string]> =>
            value === undefined ? [] : [[name, value]],
          )
          .toSorted(([left], [right]) => left.localeCompare(right)),
      ).toString(),
    ].join("\0");
  const partsOfKey = (key: string) => {
    const [, tag = "", ttl = "0", path = "", query = ""] = key.split("\0");
    return { tag, ttl: Number(ttl), path, query: Object.fromEntries(new URLSearchParams(query)) };
  };
  const sharedReads = yield* Cache.makeWith(
    (key: string) =>
      Effect.gen(function* () {
        const { path, query } = partsOfKey(key);
        // Runs as its first reader, background or interactive, and checks the pause again once
        // it has a slot: a 429 may have landed while it waited.
        const credential = (yield* PinnedCredential)!;
        const response = yield* guarded({ operation: "sharedRead", path, query }, credential);
        return { response, at: yield* Clock.currentTimeMillis };
      }),
    {
      capacity: SHARED_READ_CAPACITY,
      timeToLive: (exit, key) =>
        Exit.isSuccess(exit) ? Duration.millis(partsOfKey(key).ttl) : Duration.zero,
    },
  );

  const forget = Effect.fn("ArcanumApi.forget")(function* (tags?: ReadonlyArray<string>) {
    generation += 1;
    if (tags === undefined) return yield* Cache.invalidateAll(sharedReads);
    const wanted = new Set(tags);
    // A copy: invalidating removes entries from the map the keys are read from.
    const keys = Array.from(yield* Cache.keys(sharedReads));
    for (const key of keys) {
      if (wanted.has(partsOfKey(key).tag)) yield* Cache.invalidate(sharedReads, key);
    }
  });

  /** A request the pause stopped before it was sent. */
  const heldByPause = (error: ArcanumApiError) =>
    error.reason === "rate-limited" && error.status === null;

  const asOperation = (operation: string) => (error: ArcanumApiError) =>
    error.operation === operation ? error : new ArcanumApiError({ ...error, operation });

  const sharedRead = Effect.fn("ArcanumApi.sharedRead")(function* (
    input: ArcanumApiRequest,
    credential: ArcanumCredentials.ArcanumCredential,
  ) {
    const key = sharedKey(input, credential);
    const maxAge = Duration.toMillis(
      Duration.fromInputUnsafe(input.reuse!.maxAge ?? input.reuse!.ttl),
    );
    const fresh = Effect.gen(function* () {
      const started = generation;
      const response = yield* guarded(input, credential);
      if (generation === started) {
        yield* Cache.set(sharedReads, key, { response, at: yield* Clock.currentTimeMillis });
      }
      return response;
    });
    if (maxAge <= 0) return yield* fresh;
    const interactive = yield* SourceControlRateLimit.Interactive;
    yield* limits.check(RATE_LIMIT_KEY, interactive ? { allowPaused: true } : undefined).pipe(
      Effect.provideService(SourceControlRateLimit.CredentialScope, credential.fingerprint),
      Effect.mapError((paused) =>
        fail(input, {
          status: null,
          reason: "rate-limited",
          detail: statusDetail(429, undefined),
          retryAt: paused.retryAt,
        }),
      ),
    );
    const held = yield* Cache.get(sharedReads, key).pipe(
      Effect.provideService(PinnedCredential, credential),
      Effect.mapError(asOperation(input.operation)),
      // A background read it joined was held by the pause, so nothing was sent for this user.
      Effect.catchIf(
        (error) => interactive && heldByPause(error),
        () => Effect.succeed(null),
      ),
    );
    return held === null || (yield* Clock.currentTimeMillis) - held.at > maxAge
      ? yield* fresh
      : held.response;
  });

  const request = (input: ArcanumApiRequest) =>
    credentialFor(input).pipe(
      Effect.flatMap((credential: ArcanumCredentials.ArcanumCredential) =>
        (input.reuse !== undefined && (input.method ?? "GET") === "GET"
          ? sharedRead(input, credential)
          : isWrite(input.method ?? "GET")
            ? forget(input.forgets).pipe(
                Effect.andThen(guarded(input, credential)),
                Effect.ensuring(forget(input.forgets)),
              )
            : guarded(input, credential)
        ).pipe(Effect.tapError((error) => forgetRefused(error, credential))),
      ),
    );

  // Keyed by fingerprint, so a replaced token is verified afresh rather than read from here, and
  // concurrent cold checks of one credential share a single request. The header names the
  // account; the body adds what review needs, and is checked against it.
  // Untraced: the identity span covers it.
  const verify = Effect.fnUntraced(function* (credential: ArcanumCredentials.ArcanumCredential) {
    const response = yield* guarded(
      { operation: "identity", path: "/v2/users/me", query: { fields: "name,outstaff,banned" } },
      credential,
    );
    const user = response.user;
    if (user === null) {
      return yield* fail(
        { operation: "identity" },
        {
          status: null,
          reason: "failed",
          detail: "Arcanum did not say which account the token belongs to.",
        },
      );
    }
    const body = Option.getOrUndefined(decodeAccount(response.text))?.data;
    return {
      login: user,
      ...(body === undefined || body.name.toLowerCase() !== user.toLowerCase()
        ? {}
        : { account: { outstaff: body.outstaff, banned: body.banned } }),
    } satisfies Omit<ArcanumIdentity, "credential">;
  });
  const viewers = yield* Cache.makeWith(
    (_fingerprint: string) => Effect.flatMap(PinnedCredential, (credential) => verify(credential!)),
    {
      capacity: 16,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? VIEWER_TTL : Duration.zero),
    },
  );

  const identity = Effect.fn("ArcanumApi.identity")(function* (operation: string) {
    const credential = yield* credentialFor({ operation });
    const interactive = yield* SourceControlRateLimit.Interactive;
    const verified = yield* Cache.get(viewers, credential.fingerprint).pipe(
      Effect.provideService(PinnedCredential, credential),
      // A background check it joined was held by the pause; a user waiting checks on their own.
      Effect.catchIf(
        (error) => interactive && heldByPause(error),
        () => verify(credential),
      ),
      Effect.mapError(asOperation(operation)),
      Effect.tapError((error) => forgetRefused(error, credential)),
    );
    return { ...verified, credential } satisfies ArcanumIdentity;
  });

  /** Drops a verified login when a request with its credential is refused. */
  const forgetRefused = (
    error: ArcanumApiError,
    credential: ArcanumCredentials.ArcanumCredential,
  ) =>
    error.reason === "unauthenticated"
      ? Cache.invalidate(viewers, credential.fingerprint)
      : Effect.void;

  const withCredential = <A, E, R>(use: (fingerprint: string | null) => Effect.Effect<A, E, R>) =>
    credentialFor({ operation: "credential" }).pipe(
      Effect.option,
      Effect.flatMap((credential) =>
        Option.isNone(credential)
          ? use(null)
          : use(credential.value.fingerprint).pipe(
              Effect.provideService(PinnedCredential, credential.value),
            ),
      ),
    );

  return ArcanumApi.of({
    request,
    identity,
    credential: credentialFor({ operation: "credential" }),
    withCredential,
    forget,
  });
});

export const layer = Layer.effect(ArcanumApi, make);
