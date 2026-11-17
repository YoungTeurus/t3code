import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ArcanumApi from "./ArcanumApi.ts";
import * as Json from "./arcanumJson.ts";

const CHECKS_PAGE_LIMIT = 100;
/** Pages of checks read before giving up; real pull requests carry a few hundred checks. */
const MAX_CHECK_PAGES = 50;

const unreadable = (operation: string, cause?: unknown) =>
  new ArcanumApi.ArcanumApiError({
    operation,
    status: null,
    reason: "failed",
    // The decoder's own message would quote the response.
    detail: "Arcanum returned a response this version cannot read.",
    ...(cause === undefined ? {} : { cause: String(cause).slice(0, 200) }),
  });

// Each schema compiles its envelope decoder once, however many reads use it.
const decoders = new WeakMap<object, unknown>();

export const decodeData = <S extends Schema.Codec<unknown, unknown, never, never>>(
  operation: string,
  schema: S,
) => {
  let decode = decoders.get(schema) as
    | ((text: string) => Effect.Effect<unknown, Schema.SchemaError>)
    | undefined;
  if (decode === undefined) {
    decode = Schema.decodeEffect(Json.envelope(schema)) as (
      text: string,
    ) => Effect.Effect<unknown, Schema.SchemaError>;
    decoders.set(schema, decode);
  }
  return (
    response: ArcanumApi.ArcanumApiResponse,
  ): Effect.Effect<S["Type"], ArcanumApi.ArcanumApiError> =>
    decode!(response.text).pipe(
      Effect.map((decoded) => (decoded as { readonly data: S["Type"] }).data),
      Effect.mapError(() => unreadable(operation)),
    );
};

const reviewRequestPath = (number: number) => `/v1/review-requests/${number}`;

/** How long one read of a pull request answers every reader of the same credential. */
const PULL_REUSE = Duration.seconds(5);
/** A read that always asks Arcanum, for a permission or a state a write is decided on. */
export const FRESH = Duration.zero;

/** Tag of shared listing pages, which any change to a pull request can move. */
export const LIST_TAG = "list";

/** Tag of the shared reads of pull request `number`. */
export const pullTag = (number: number) => `pr:${number}`;

/**
 * A pull request read in full, the one read every detail, preview and action builds on. Readers
 * share it briefly, so one open of a pull request reads it once; `maxAge` narrows what this one
 * reader takes.
 */
export const readReviewRequest = (
  api: ArcanumApi.ArcanumApi["Service"],
  operation: string,
  number: number,
  options?: { readonly maxAge?: Duration.Input },
) =>
  api
    .request({
      operation,
      path: reviewRequestPath(number),
      query: { fields: Json.DETAIL_FIELDS },
      reuse: {
        tag: pullTag(number),
        ttl: PULL_REUSE,
        ...(options?.maxAge === undefined ? {} : { maxAge: options.maxAge }),
      },
    })
    .pipe(Effect.flatMap(decodeData(operation, Json.ReviewRequest)));

/** The active iteration and its three commits; a pull request without one has nothing to read. */
export function activeIteration(operation: string, pull: Json.ReviewRequest) {
  const iteration = pull.active_diff_set;
  const heads = iteration?.arc_branch_heads;
  return iteration === undefined || heads === undefined
    ? Effect.fail(
        new ArcanumApi.ArcanumApiError({
          operation,
          status: null,
          reason: "failed",
          detail: `PR ${pull.id} has no iteration Arcanum can show yet.`,
        }),
      )
    : Effect.succeed({
        diffId: iteration.id,
        base: heads.to_id,
        merge: heads.merge_id,
        head: heads.from_id,
      });
}

export type ActiveIteration = Effect.Success<ReturnType<typeof activeIteration>>;

export const readChangelist = (
  api: ArcanumApi.ArcanumApi["Service"],
  operation: string,
  diffId: number,
) =>
  api
    .request({
      operation,
      path: `/v2/public/diff/${diffId}/changelist`,
      query: { fields: Json.CHANGELIST_FIELDS, diff_mode: "flat_path" },
    })
    .pipe(
      Effect.flatMap(decodeData(operation, Json.Changelist)),
      Effect.map(Json.changelistFiles),
      Effect.map((files) => files.toSorted((left, right) => left.path.localeCompare(right.path))),
    );

/**
 * Every page of one iteration's checks, following cursors until Arcanum stops giving one. A walk
 * that cannot finish fails rather than pass off part of the list as all of it.
 */
export const readChecks = Effect.fn("arcanumReads.readChecks")(function* (
  api: ArcanumApi.ArcanumApi["Service"],
  operation: string,
  diffId: number,
  reuse?: ArcanumApi.ArcanumApiRequest["reuse"],
) {
  const pages: Array<Json.ChecksPage> = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_CHECK_PAGES; page++) {
    const read: Json.ChecksPage = yield* api
      .request({
        operation,
        path: `/v2/public/diff/${diffId}/checks`,
        query: { limit: String(CHECKS_PAGE_LIMIT), cursor },
        ...(reuse === undefined ? {} : { reuse }),
      })
      .pipe(Effect.flatMap(decodeData(operation, Json.ChecksPage)));
    pages.push(read);
    const next = read.next_page_cursor ?? undefined;
    // Only a page without a cursor ends the list. An empty page that names one is not the end.
    if (next === undefined || next.length === 0) return pages;
    // A cursor seen before would loop forever.
    if (seen.has(next)) break;
    seen.add(next);
    cursor = next;
  }
  return yield* new ArcanumApi.ArcanumApiError({
    operation,
    status: null,
    reason: "failed",
    detail: "Arcanum's list of checks did not come to an end, so their state is unknown.",
  });
});

export function assertRepository(operation: string, pull: Json.ReviewRequest, repository: string) {
  return pull.vcs.arc_repo_name.toLowerCase() === repository.toLowerCase()
    ? Effect.void
    : Effect.fail(
        new ArcanumApi.ArcanumApiError({
          operation,
          status: null,
          reason: "not-found",
          detail: `PR ${pull.id} belongs to ${pull.vcs.arc_repo_name}, not ${repository}.`,
        }),
      );
}

/** The greatest-id pull request from an exact branch, in any state; null when there is none. */
export const latestFromBranch = (
  api: ArcanumApi.ArcanumApi["Service"],
  operation: string,
  input: { readonly branch: string; readonly repository: string },
) =>
  api
    .request({
      operation,
      path: "/v2/pull-requests/latest",
      query: { from_branch: input.branch, repository: input.repository, fields: "id" },
    })
    .pipe(
      Effect.flatMap(decodeData(operation, Json.LatestPullRequest)),
      Effect.map((pull) => pull.id),
      Effect.catchIf(
        (error) => error.reason === "not-found",
        () => Effect.succeed(null),
      ),
    );
