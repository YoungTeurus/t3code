import {
  SourceControlProviderKind,
  resolvePullRequestAuthorFilter,
  type PullRequestAction,
  type PullRequestCapabilities,
  type PullRequestReviewCommentDraft,
  type PullRequestReviewPosition,
  type PullRequestViewerPermissions,
  type ReviewDiffFileStat,
} from "@t3tools/contracts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import {
  PullRequestProviderError,
  type ProviderChangeRequest,
  type ProviderChangeRequestDetail,
  type ProviderChangeRequestPage,
  type ProviderDiffSlice,
  type ProviderRepositoryRef,
  type PullRequestProviderApi,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import { parseDiffFilePaths } from "@t3tools/source-control-core/server/diffFileRevisions";
import { toIsoUtc } from "@t3tools/source-control-core/server/pullRequestUtils";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { ARCANUM_WEB_HOST, definition } from "../shared/definition.ts";
import * as ArcanumApi from "./ArcanumApi.ts";
import * as ArcanumCredentials from "./ArcanumCredentials.ts";
import * as Json from "./arcanumJson.ts";
import * as Reads from "./arcanumReads.ts";
import * as Checks from "./arcanumChecks.ts";
import * as Review from "./arcanumReview.ts";

const KIND = SourceControlProviderKind.make("arcanum");

type ListInput = Parameters<PullRequestProviderApi["listChangeRequests"]>[0];

const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: true,
  actions: [...definition.changeRequestActions],
  // Arcanum lands a pull request as a merge commit of its head into the target branch.
  mergeMethods: ["merge"],
  // Arcanum has no full-text search, so the page narrows loaded rows itself.
  search: false,
  reactions: true,
  viewedFiles: "host",
  review: {
    inlineComment: true,
    rangeComment: true,
    reply: true,
    resolve: true,
    verdicts: ["comment", "approve", "request-changes"],
    issues: true,
  },
  reviewers: { request: true, listCandidates: true },
  edit: { changeRequest: true, comment: true },
  labels: true,
  // Arcanum's own review and issue checks report on every iteration.
  checksAlwaysReport: true,
  reviewEvents: true,
};

const UNAVAILABLE_REQUIREMENT = {
  missing: ArcanumCredentials.MISSING_CREDENTIAL_DETAIL,
  unauthenticated:
    "Arcanum refused the server's token. Save a new one in Settings → Source control, or refresh ARC_TOKEN or Arc's sign-in.",
};

const LIST_PAGE_LIMIT = 100;
/** How long a listing page answers the same request again, as long as the service holds a list. */
const LIST_REUSE = Duration.seconds(30);
/** Single-row reads spent finding where a listing carries on; a binary search needs far fewer. */
const MAX_LOCATE_PROBES = 64;
/** Raw rows per read when the provider filters rows itself. */
const FILTERED_PAGE_ROWS = 50;
/** Files per diff page once the whole patch is too large to send at once. */
const DIFF_PAGE_FILES = 25;
const DIFF_FILE_CONCURRENCY = 4;
const COMMIT_LIMIT = 250;
const LABEL_LIMIT = 100;
/** Iterations whose file lists and entry ids are held; neither changes within an iteration. */
const STRUCTURE_CAPACITY = 16;
const STRUCTURE_TTL = Duration.minutes(10);
/** An iteration's file count never changes, so its read answers until the cache drops it. */
const STATS_REUSE = Duration.hours(1);
const STATS_TAG = "diff-stats";
/** CI links change only when a check starts or restarts, while states come with every read. */
const CHECK_LINKS_REUSE = Duration.minutes(5);
const DIFF_CURSOR = /^(\d{1,12}):(\d{1,7})$/u;

/** A row's place in Arcanum's listing order: newest update first, then highest id. */
interface ListPosition {
  /** UTC, with the fraction padded to nine digits so equal instants compare equal as text. */
  readonly time: string;
  readonly id: number;
}

const ORDER_TIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/u;
const LIST_POSITION = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z)~(\d{1,15})$/u;

const orderTime = (updatedAt: string): string | null => {
  const match = ORDER_TIME.exec(updatedAt.trim());
  return match === null ? null : `${match[1]}.${(match[2] ?? "").padEnd(9, "0")}Z`;
};

const positionOf = (row: { readonly id: number; readonly updated_at: string }) => {
  const time = orderTime(row.updated_at);
  return time === null ? null : { time, id: row.id };
};

/** Whether `row` comes after `key` in the listing, which runs newest first, then by id down. */
const comesAfter = (row: ListPosition, key: ListPosition) =>
  row.time < key.time || (row.time === key.time && row.id < key.id);

const encodeListPosition = (position: ListPosition) => `${position.time}~${position.id}`;

const INVOLVING_SIDES = ["authored", "reviewing"] as const;
const INVOLVING_POSITION =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z~\d{1,15})~(\d{1,9})~(\d{1,9})$/u;

/** The position both sides of an `all` listing carry on from, and where each side reached. */
const encodeInvolvingPosition = (position: ListPosition, offsets: ReadonlyArray<number>) =>
  `${encodeListPosition(position)}~${offsets.join("~")}`;

function parseInvolvingPosition(
  value: string | undefined,
): { readonly position: ListPosition; readonly offsets: ReadonlyArray<number> } | null {
  const match = value === undefined ? null : INVOLVING_POSITION.exec(value);
  const position = match === null ? null : parseListPosition(match[1]);
  return match === null || position === null
    ? null
    : { position, offsets: [Number(match[2]), Number(match[3])] };
}

function parseListPosition(value: string | undefined): ListPosition | null {
  const match = value === undefined ? null : LIST_POSITION.exec(value);
  return match === null ? null : { time: match[1]!, id: Number(match[2]) };
}

/**
 * A cursor from before positions were kept names only a millisecond boundary: carry on after the
 * whole millisecond's ties, which the service's own seen-at list already deduplicates.
 */
function boundaryPosition(boundary: string): ListPosition | null {
  const time = orderTime(boundary);
  return time === null
    ? null
    : { time: `${time.slice(0, 23)}999999Z`, id: Number.MAX_SAFE_INTEGER };
}

const PublicComments = Schema.Array(Json.PublicComment);
const DiffComments = Schema.Array(Json.DiffComment);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const isOpen = (pull: { readonly full_status: string }) =>
  Json.pullRequestState(pull.full_status) === "open";
const isDraft = (pull: {
  readonly common_status: string;
  readonly active_diff_set?: { readonly status: string } | undefined;
}) => pull.active_diff_set?.status === "draft" || pull.common_status === "draft";
/** Moves whenever a watch could have check news: a check finishing, failing, or the rollup. */
const checksFingerprint = (pull: Json.ReviewRequest) => {
  const checks = Json.toChecks(pull.checks ?? [], false);
  const count = (statuses: ReadonlyArray<string>) =>
    checks.filter((check) => statuses.includes(check.status)).length;
  return [
    Json.checksStateOf(checks) ?? "-",
    count(["failure", "cancelled", "action-required"]),
    count(["pending", "queued"]),
  ].join("/");
};
const autoMergeOf = (pull: Json.ReviewRequest) => pull.policies?.auto_merge;
const autoMergeOn = (policy: string | undefined) =>
  policy !== undefined && policy !== "disabled" && policy !== "unknown";

/** What the viewer can do on the pull request as just read. Arcanum enforces the rest. */
function viewerPermissionsOf(
  pull: Json.ReviewRequest,
  reviewer: Review.ReviewViewer,
): PullRequestViewerPermissions {
  const viewer = reviewer.login;
  if (!isOpen(pull)) {
    return {
      actions: [],
      comment: true,
      resolve: true,
      verdicts: [],
      requestReviewers: false,
      labels: true,
      editChangeRequest: false,
    };
  }
  const policy = autoMergeOf(pull);
  const actions: Array<PullRequestAction> = [];
  const isAuthor = pull.author.name.toLowerCase() === viewer.toLowerCase();
  if (isDraft(pull) && isAuthor) actions.push("ready");
  // Merging is enabling auto-merge once requirements hold, as `arc pr merge --now` does.
  if (pull.merge_allowed === true && policy === "disabled") actions.push("merge");
  if (pull.merge_allowed !== true && policy === "disabled") actions.push("enable-auto-merge");
  if (autoMergeOn(policy)) actions.push("disable-auto-merge");
  return {
    actions,
    comment: true,
    resolve: true,
    verdicts: Review.verdictsOf(pull, reviewer),
    requestReviewers: true,
    labels: true,
    editChangeRequest: true,
  };
}

const reviewersOf = (pull: Json.ReviewRequest) => {
  const logins = new Set<string>();
  for (const reviewer of pull.review?.reviewers ?? []) {
    if (reviewer.user !== undefined) logins.add(reviewer.user.name);
  }
  for (const assignee of pull.assignees ?? []) logins.add(assignee.name);
  return [...logins];
};

function toChangeRequest(
  pull: Json.ReviewRequest | Json.ReviewRequestRow,
  review: { readonly status: string | undefined; readonly requested: ReadonlyArray<string> },
): ProviderChangeRequest {
  const state = Json.pullRequestState(pull.full_status);
  const closedAt = pull.closed_at ? toIsoUtc(pull.closed_at) : null;
  const decision = Json.reviewDecision(review.status);
  const checksState = Json.checksStateOfPull(pull);
  return {
    number: pull.id,
    title: Json.titleOf(pull),
    url: pull.url,
    author: Json.actor(pull.author.name),
    headBranch: pull.vcs.from_branch,
    baseBranch: pull.vcs.to_branch,
    state,
    isDraft: isDraft(pull),
    mergeability: Json.mergeability(pull),
    additions: pull.active_diff_set?.patch_stats?.additions ?? 0,
    deletions: pull.active_diff_set?.patch_stats?.deletions ?? 0,
    createdAt: toIsoUtc(pull.created_at),
    updatedAt: toIsoUtc(pull.updated_at),
    closedAt: state === "open" ? null : closedAt,
    mergedAt: state === "merged" ? closedAt : null,
    reviewRequestLogins: review.requested,
    labels: Json.labelsOf(pull.labels),
    ...(decision === undefined ? {} : { reviewDecision: decision }),
    ...(checksState === undefined ? {} : { checksState }),
  };
}

const pullToChangeRequest = (pull: Json.ReviewRequest) =>
  toChangeRequest(pull, { status: pull.review?.review_status, requested: reviewersOf(pull) });

const rowToChangeRequest = (row: Json.ReviewRequestRow) =>
  toChangeRequest(row, {
    status: row.review_status,
    requested: (row.assignees ?? []).flatMap((assignee) =>
      assignee.user === undefined ? [] : [assignee.user.name],
    ),
  });

type Side = "old" | "new";
const sideOf = (position: PullRequestReviewPosition): { side: Side; line: number } =>
  position.kind === "added"
    ? { side: "new", line: position.newLine }
    : position.kind === "deleted"
      ? { side: "old", line: position.oldLine }
      : position.side === "left"
        ? { side: "old", line: position.oldLine }
        : { side: "new", line: position.newLine };

/** Arcanum's anchor for a line comment: first line, side, and how many lines it covers. */
function anchorOf(
  draft: PullRequestReviewCommentDraft,
): { readonly side: Side; readonly line: number; readonly size: number } | string {
  const end = sideOf(draft.position);
  if (draft.startPosition === undefined) return { ...end, size: 1 };
  const start = sideOf(draft.startPosition);
  if (start.side !== end.side) return "A comment's range has to stay on one side of the diff.";
  if (start.line > end.line) return "A comment's range has to start before it ends.";
  return { side: end.side, line: start.line, size: end.line - start.line + 1 };
}

const PublishedComment = Schema.Struct({
  id: Json.CommentId,
  draft: Schema.optional(Schema.Boolean),
  published_at: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.Struct({ name: Schema.String }),
  issue_status: Schema.optional(Schema.String),
  deleted_at: Schema.optional(Schema.NullOr(Schema.String)),
});

export const make = Effect.gen(function* () {
  const api = yield* ArcanumApi.ArcanumApi;
  const host = yield* SourceControlHost.SourceControlHost;

  const toProviderError =
    (operation: string) =>
    (error: ArcanumApi.ArcanumApiError): PullRequestProviderError =>
      new PullRequestProviderError({
        provider: KIND,
        operation,
        reason: error.reason,
        detail: error.outcomeUnknown
          ? `${error.detail} Arcanum may have applied it, so reload before trying again.`
          : error.detail,
        ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
        cause: error,
      });
  const failure = (operation: string, detail: string, cause?: unknown) =>
    new PullRequestProviderError({
      provider: KIND,
      operation,
      reason: "failed",
      detail,
      ...(cause === undefined ? {} : { cause }),
    });
  const run =
    (operation: string) =>
    <A, R>(
      effect: Effect.Effect<A, ArcanumApi.ArcanumApiError | PullRequestProviderError, R>,
    ): Effect.Effect<A, PullRequestProviderError, R> =>
      effect.pipe(
        Effect.mapError((error) =>
          error._tag === "ArcanumApiError" ? toProviderError(operation)(error) : error,
        ),
      );

  const readRepository = (number: number) =>
    Reads.readReviewRequest(api, "resolveChangeRequestRepository", number).pipe(
      Effect.map((pull) => pull.vcs.arc_repo_name),
    );
  // Every routed operation asks for a review's repository, and that never changes.
  const reviewRepositories = yield* Cache.makeWith(readRepository, {
    capacity: 4096,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
  });

  const requireHost = (operation: string, ref: Pick<ProviderRepositoryRef, "host">) =>
    ref.host.toLowerCase() === ARCANUM_WEB_HOST
      ? Effect.void
      : Effect.fail(failure(operation, `Arcanum serves pull requests on ${ARCANUM_WEB_HOST}.`));

  /**
   * A pull request of the project's repository, read whole. A write passes how old a read its
   * checks may rest on.
   */
  const readPull = Effect.fn("ArcanumPullRequestProvider.readPull")(function* (
    operation: string,
    ref: ProviderRepositoryRef & { readonly number: number },
    maxAge?: Duration.Input,
  ) {
    yield* requireHost(operation, ref);
    const pull = yield* Reads.readReviewRequest(
      api,
      operation,
      ref.number,
      maxAge === undefined ? undefined : { maxAge },
    );
    yield* Reads.assertRepository(operation, pull, ref.repository);
    return pull;
  });
  /**
   * For a write that checks only which repository the pull request is in, and its id: neither
   * ever changes, so a shared read is as good as a fresh one. A write decided on its state,
   * iteration or the viewer's grants reads fresh instead.
   */
  const readPullIdentity = (
    operation: string,
    ref: ProviderRepositoryRef & { readonly number: number },
  ) => readPull(operation, ref);

  const viewerLogin = (operation: string) =>
    api.identity(operation).pipe(Effect.map((identity) => identity.login));
  const reviewViewer = (operation: string) =>
    api
      .identity(operation)
      .pipe(
        Effect.map(({ login, account }): Review.ReviewViewer =>
          account === undefined ? { login } : { login, account },
        ),
      );

  const send = (input: ArcanumApi.ArcanumApiRequest) => api.request(input).pipe(Effect.asVoid);

  /** Sets or withdraws the viewer's decision on one iteration. */
  const sendDecision = (
    operation: string,
    pullRequest: number,
    diffId: number,
    decision: Review.Decision,
  ) => {
    const write = Review.DECISION_WRITES[decision];
    return send({
      operation,
      method: write.method,
      path: `/v1/review-requests/${pullRequest}/diff-sets/${diffId}/${write.route}`,
      ...(write.sticky === undefined ? {} : { query: { sticky: String(write.sticky) } }),
    });
  };

  const readCheckLinks = (operation: string, pullRequest: number, diffId: number) =>
    Reads.readChecks(api, operation, diffId, {
      tag: Reads.pullTag(pullRequest),
      ttl: CHECK_LINKS_REUSE,
    }).pipe(
      Effect.map(Json.checkLinksOf),
      // States and actions come from the pull request read; without links the list still holds.
      Effect.orElseSucceed((): ReadonlyMap<string, string> => new Map()),
    );

  /** Commits on the pull request's branch that its base does not have, newest first. */
  const readCommits = Effect.fn("ArcanumPullRequestProvider.readCommits")(function* (
    operation: string,
    cwd: string,
    range: { readonly base: string; readonly head: string },
  ) {
    const read = yield* host.review
      .rangeCommits({ cwd, base: range.base, head: range.head, limit: COMMIT_LIMIT })
      .pipe(
        Effect.mapError((cause) =>
          failure(operation, "Arc could not list the pull request's commits.", cause),
        ),
      );
    return read.commits;
  });

  const requireCommitOnPullRequest = Effect.fn("ArcanumPullRequestProvider.requireCommit")(
    function* (operation: string, cwd: string, iteration: Reads.ActiveIteration, commit: string) {
      const commits = yield* readCommits(operation, cwd, iteration);
      if (!commits.some((entry) => entry.sha === commit)) {
        return yield* failure(operation, "That commit is not on this pull request.");
      }
    },
  );

  const reviewError = (operation: string) => (cause: unknown) =>
    failure(
      operation,
      cause instanceof Error && cause.message.trim().length > 0
        ? cause.message.trim()
        : "Arc could not read the pull request's changes.",
      cause,
    );

  /** Pins content reads to the iteration they were asked about. */
  const iterationOf = Effect.fn("ArcanumPullRequestProvider.iterationOf")(function* (
    operation: string,
    ref: ProviderRepositoryRef & { readonly number: number },
  ) {
    const pull = yield* readPull(operation, ref);
    return yield* Reads.activeIteration(operation, pull);
  });

  // Bounded holders for what an iteration never changes. A held entry keeps its first read's
  // time, so a hit does not extend it.
  const holder = <A>() => {
    const held = new Map<string, { readonly at: number; readonly value: A }>();
    return {
      get: (key: string) =>
        Clock.currentTimeMillis.pipe(
          Effect.map((now) => {
            const entry = held.get(key);
            return entry !== undefined && now - entry.at < Duration.toMillis(STRUCTURE_TTL)
              ? entry.value
              : undefined;
          }),
        ),
      set: (key: string, value: A) =>
        Clock.currentTimeMillis.pipe(
          Effect.map((at) => {
            held.delete(key);
            if (held.size >= STRUCTURE_CAPACITY) {
              const oldest = held.keys().next().value;
              if (oldest !== undefined) held.delete(oldest);
            }
            held.set(key, { at, value });
          }),
        ),
    };
  };

  /** Files of an iteration's merge commit, as the VCS reads it, by the two hashes that fix it. */
  const diffStructures = holder<ReadonlyArray<ReviewDiffFileStat>>();
  const structureKey = (iteration: Reads.ActiveIteration) => `${iteration.base}:${iteration.merge}`;

  /** The merge commit's whole diff against the base; a different first parent is a new iteration. */
  const readWholeDiff = Effect.fn("ArcanumPullRequestProvider.readWholeDiff")(function* (
    operation: string,
    cwd: string,
    iteration: Reads.ActiveIteration,
  ) {
    const whole = yield* host.review
      .commitDiff({ cwd, commit: iteration.merge })
      .pipe(Effect.mapError(reviewError(operation)));
    if (whole.parent !== iteration.base) return yield* staleIteration(operation);
    if (whole.files !== undefined) yield* diffStructures.set(structureKey(iteration), whole.files);
    return whole;
  });

  const diffFilesOf = Effect.fn("ArcanumPullRequestProvider.diffFilesOf")(function* (
    operation: string,
    cwd: string,
    iteration: Reads.ActiveIteration,
  ) {
    const held = yield* diffStructures.get(structureKey(iteration));
    if (held !== undefined) return held;
    const whole = yield* readWholeDiff(operation, cwd, iteration);
    if (whole.files === undefined) {
      return yield* failure(operation, "Arc did not list the files of the pull request's diff.");
    }
    return whole.files;
  });

  /**
   * An iteration's changelist entries for review marks and comment anchors. Entry ids belong to
   * the iteration and are held per credential; whether each one is reviewed is not, and is
   * read afresh by whoever shows it.
   */
  const changelists = holder<ReadonlyArray<Json.ChangelistEntry>>();
  const readChangelist = Effect.fn("ArcanumPullRequestProvider.readChangelist")(function* (
    operation: string,
    diffId: number,
  ) {
    const credential = yield* api.credential;
    const files = yield* Reads.readChangelist(api, operation, diffId);
    yield* changelists.set(`${credential.fingerprint}:${diffId}`, files);
    return files;
  });
  const changelistStructure = Effect.fn("ArcanumPullRequestProvider.changelistStructure")(
    function* (operation: string, diffId: number) {
      const credential = yield* api.credential;
      return (
        (yield* changelists.get(`${credential.fingerprint}:${diffId}`)) ??
        (yield* readChangelist(operation, diffId))
      );
    },
  );

  const readFileDiffs = Effect.fn("ArcanumPullRequestProvider.readFileDiffs")(function* (
    operation: string,
    cwd: string,
    iteration: Reads.ActiveIteration,
    files: ReadonlyArray<ReviewDiffFileStat>,
  ) {
    const slices = yield* Effect.forEach(
      files,
      (file) =>
        host.review
          .commitDiff({
            cwd,
            commit: iteration.merge,
            file: { path: file.path, previousPath: file.previousPath },
          })
          .pipe(
            Effect.mapError(reviewError(operation)),
            Effect.filterOrFail(
              (diff) => diff.parent === iteration.base,
              () => staleIteration(operation),
            ),
          ),
      { concurrency: DIFF_FILE_CONCURRENCY },
    );
    return {
      patch: slices.map((slice) => slice.patch).join(""),
      truncated: slices.some((slice) => slice.truncated),
    };
  });

  const staleIteration = (operation: string) =>
    failure(operation, "The pull request changed while it was being read. Refresh and try again.");

  const diffCursor = (diffId: number, offset: number) => `${diffId}:${offset}`;

  /** One slice of the active iteration's diff: the whole patch, or files from a changelist offset. */
  const getDiff = Effect.fn("ArcanumPullRequestProvider.getDiff")(function* (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly cursor?: string | undefined;
      readonly commit?: string | undefined;
    },
  ) {
    const operation = "getDiff";
    const iteration = yield* iterationOf(operation, input);
    if (input.commit !== undefined) {
      yield* requireCommitOnPullRequest(operation, input.cwd, iteration, input.commit);
      const diff = yield* host.review
        .commitDiff({ cwd: input.cwd, commit: input.commit })
        .pipe(Effect.mapError(reviewError(operation)));
      return { patch: diff.patch, truncated: diff.truncated, nextCursor: null };
    }
    let offset = 0;
    if (input.cursor !== undefined) {
      const match = DIFF_CURSOR.exec(input.cursor);
      if (match === null) return yield* failure(operation, "The diff page cursor is not valid.");
      // A cursor from an older iteration would splice two diffs together.
      if (Number(match[1]) !== iteration.diffId) return yield* staleIteration(operation);
      offset = Number(match[2]);
    } else {
      const whole = yield* readWholeDiff(operation, input.cwd, iteration);
      if (!whole.truncated) {
        return {
          patch: whole.patch,
          truncated: false,
          nextCursor: null,
        } satisfies ProviderDiffSlice;
      }
    }
    // Pages follow the VCS's own file list of the merge, which the iteration fixes.
    const files = yield* diffFilesOf(operation, input.cwd, iteration);
    const page = files.slice(offset, offset + DIFF_PAGE_FILES);
    const slice = yield* readFileDiffs(operation, input.cwd, iteration, page);
    const next = offset + page.length;
    return {
      patch: slice.patch,
      truncated: slice.truncated,
      nextCursor: next < files.length ? diffCursor(iteration.diffId, next) : null,
    } satisfies ProviderDiffSlice;
  });

  const toActivity = Effect.fn("ArcanumPullRequestProvider.toActivity")(function* (
    operation: string,
    input: ProviderRepositoryRef & { readonly number: number },
  ) {
    const pull = yield* readPull(operation, input);
    const iteration = yield* Reads.activeIteration(operation, pull);
    const [viewer, all, active, commits] = yield* Effect.all(
      [
        viewerLogin(operation),
        api
          .request({ operation, path: `/v1/public/review-requests/${pull.id}/comments` })
          .pipe(Effect.flatMap(Reads.decodeData(operation, PublicComments))),
        api
          .request({
            operation,
            path: `/v2/public/diff/${iteration.diffId}/comment`,
            query: { fields: Json.DIFF_COMMENT_FIELDS },
          })
          .pipe(Effect.flatMap(Reads.decodeData(operation, DiffComments))),
        readCommits(operation, input.cwd, iteration),
      ],
      { concurrency: 3 },
    );
    return {
      pull,
      viewer,
      commits,
      activity: Json.toActivity({ all, active, viewer, pullRequestUrl: pull.url }),
    };
  });

  /** The numeric iteration an inline comment, or the thread it replies in, was written on. */
  const commentDiffId = Effect.fn("ArcanumPullRequestProvider.commentDiffId")(function* (
    operation: string,
    pullRequest: number,
    commentId: number,
  ) {
    const all = yield* api
      .request({ operation, path: `/v1/public/review-requests/${pullRequest}/comments` })
      .pipe(Effect.flatMap(Reads.decodeData(operation, PublicComments)));
    const byId = new Map(all.map((comment) => [comment.id, comment]));
    let current = byId.get(commentId);
    for (let depth = 0; current !== undefined && depth < 64; depth++) {
      const xid = current.anchor?.review_request?.diff?.diff_set_xid;
      if (xid !== undefined && /^\d+$/u.test(xid)) return Number(xid);
      current = current.reply_to_id == null ? undefined : byId.get(current.reply_to_id);
    }
    return yield* failure(operation, "Arcanum did not say which iteration that comment is on.");
  });

  const readComment = (operation: string, commentId: number) =>
    api
      .request({ operation, path: `/v1/public/review-requests-comments/${commentId}` })
      .pipe(Effect.flatMap(Reads.decodeData(operation, PublishedComment)));

  const parseCommentId = (operation: string, id: string) =>
    /^-?[1-9]\d{0,17}$/u.test(id) && Number.isSafeInteger(Number(id))
      ? Effect.succeed(Number(id))
      : Effect.fail(failure(operation, "That comment id is not one of Arcanum's."));

  const idempotencyKey = randomUuidV4.pipe(Effect.map((uuid) => `t3-${uuid}`));

  /** Deletes drafts this submission made, after confirming each is still an unpublished draft. */
  const deleteOwnDrafts = Effect.fn("ArcanumPullRequestProvider.deleteOwnDrafts")(function* (
    operation: string,
    viewer: string,
    ids: ReadonlyArray<number>,
  ) {
    const left: Array<number> = [];
    for (const id of ids) {
      const comment = yield* readComment(operation, id).pipe(Effect.option);
      if (comment._tag === "None") {
        left.push(id);
        continue;
      }
      const draft = comment.value;
      if (
        draft.draft !== true ||
        draft.published_at != null ||
        draft.user.name.toLowerCase() !== viewer.toLowerCase()
      ) {
        continue;
      }
      const deleted = yield* send({
        operation,
        method: "DELETE",
        path: `/v1/public/review-requests-comments/${id}`,
      }).pipe(Effect.option);
      if (deleted._tag === "None") left.push(id);
    }
    return left;
  });

  const submitReview = Effect.fn("ArcanumPullRequestProvider.submitReview")(function* (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly verdict: "comment" | "approve" | "request-changes";
      readonly body: string;
      readonly comments: ReadonlyArray<PullRequestReviewCommentDraft>;
    },
  ) {
    const operation = "submitReview";
    const pull = yield* readPull(operation, input, Reads.FRESH);
    if (!isOpen(pull)) return yield* failure(operation, "The pull request is no longer open.");
    const iteration = yield* Reads.activeIteration(operation, pull);
    const reviewer = yield* reviewViewer(operation);
    const viewer = reviewer.login;
    const decision =
      input.verdict === "approve"
        ? ("ship" as const)
        : input.verdict === "request-changes"
          ? ("request-changes" as const)
          : null;
    // Checked before any draft is made, so a refused decision leaves no comments behind.
    const refused = decision === null ? null : Review.unavailableReason(decision, pull, reviewer);
    if (refused !== null) return yield* failure(operation, refused);
    const body = input.body.trim().length > 0 ? input.body : null;
    if (input.verdict === "comment" && body === null && input.comments.length === 0) {
      return yield* failure(operation, "A comment review needs a comment.");
    }
    const anchors = input.comments.map((draft) => ({ draft, anchor: anchorOf(draft) }));
    for (const { anchor } of anchors) {
      if (typeof anchor === "string") return yield* failure(operation, anchor);
    }
    const targets =
      input.comments.length === 0
        ? new Map<string, Json.ChangelistTarget>()
        : Json.changelistTargets(yield* changelistStructure(operation, iteration.diffId));
    for (const { draft, anchor } of anchors) {
      const target = targets.get(draft.path);
      if (target === undefined) {
        return yield* failure(
          operation,
          `${draft.path} is not in the pull request's latest iteration.`,
        );
      }
      // The old path of a move only has the lines the move took away.
      if (target.movedFrom && typeof anchor !== "string" && anchor.side !== "old") {
        return yield* failure(
          operation,
          `${draft.path} was moved, so only its removed lines can take a comment there.`,
        );
      }
    }

    // Only drafts this submission made are ever published or cleaned up.
    const created: Array<number> = [];
    const cleanUp = (reason: PullRequestProviderError) =>
      deleteOwnDrafts(operation, viewer, created).pipe(
        Effect.flatMap((left) =>
          Effect.fail(
            left.length === 0
              ? reason
              : failure(
                  operation,
                  `${reason.detail} ${left.length} of its draft comments could not be removed and stay as your drafts in Arcanum.`,
                  reason,
                ),
          ),
        ),
      );
    const createDraft = Effect.fn("ArcanumPullRequestProvider.createDraft")(function* (
      request: Omit<ArcanumApi.ArcanumApiRequest, "operation" | "method">,
    ) {
      const key = yield* idempotencyKey;
      const comment = yield* api
        .request({ ...request, operation, method: "POST", idempotencyKey: key })
        .pipe(Effect.flatMap(Reads.decodeData(operation, Json.CreatedComment)));
      created.push(comment.id);
    });

    yield* Effect.gen(function* () {
      for (const { draft, anchor } of anchors) {
        if (typeof anchor === "string") continue;
        yield* createDraft({
          path: `/v2/public/diff/${iteration.diffId}/comment`,
          body: {
            content: draft.body,
            is_draft: true,
            ...(draft.isIssue === true ? { is_issue: true } : {}),
            entry_id: targets.get(draft.path)!.entry.entry_id,
            line: anchor.line,
            side: anchor.side,
            size: anchor.size,
          },
        });
      }
      if (body !== null) {
        yield* createDraft({
          path: `/v2/public/pull-request/${pull.id}/comment`,
          body: { content: body, is_draft: true },
        });
      }
      // The comments were anchored in this iteration, and a newer one would misplace them.
      const now = yield* Reads.readReviewRequest(api, operation, pull.id, {
        maxAge: Reads.FRESH,
      });
      if (now.active_diff_set?.id !== iteration.diffId) return yield* staleIteration(operation);
    }).pipe(
      run(operation),
      Effect.catch((error: PullRequestProviderError) =>
        // A creation whose answer was lost may have made a draft this list does not hold. It
        // stays a draft, never published.
        cleanUp(error),
      ),
    );

    if (created.length > 0) {
      const published = yield* send({
        operation,
        method: "POST",
        path: "/v1/public/draft-comments",
        body: {
          comment_for_diff_ids: created.filter((id) => id > 0),
          comment_for_review_ids: created.filter((id) => id < 0),
        },
      }).pipe(Effect.result);
      if (published._tag === "Failure") {
        const error = published.failure;
        // Only an answer that the publish did not happen lets its drafts be removed.
        if (!error.outcomeUnknown) return yield* cleanUp(toProviderError(operation)(error));
        // The answer was lost and the publish may still land: read back, but never delete these
        // comments or publish them again. A draft read now could be published a moment later.
        const states = yield* Effect.forEach(created, (id) =>
          readComment(operation, id).pipe(Effect.option),
        );
        const confirmed = states.filter(
          (state) => state._tag === "Some" && state.value.draft !== true,
        ).length;
        if (confirmed < created.length) {
          return yield* failure(
            operation,
            `Arcanum did not confirm the review: ${confirmed} of ${created.length} comments read as published, and any others stay as your drafts in Arcanum. No verdict was sent. Check the pull request before submitting again.`,
            error,
          );
        }
      }
    }

    if (decision === null) return;
    yield* sendDecision(operation, pull.id, iteration.diffId, decision).pipe(
      run(operation),
      Effect.mapError((error) =>
        created.length === 0
          ? error
          : failure(
              operation,
              `The comments were published, but the verdict was not: ${error.detail}`,
              error,
            ),
      ),
    );
  });

  /**
   * The offset of the first row after `key` in the listing's order. Searched outward from `hint`,
   * where the last slice ended, then by halves.
   */
  const locateAfter = Effect.fn("ArcanumPullRequestProvider.locateAfter")(function* (
    operation: string,
    key: ListPosition,
    hint: number,
    probe: (
      offset: number,
    ) => Effect.Effect<typeof Json.ReviewRequestProbe.Type, ArcanumApi.ArcanumApiError>,
  ) {
    let probes = 0;
    let total: number | undefined;
    const isAfter = Effect.fnUntraced(function* (at: number) {
      if (++probes > MAX_LOCATE_PROBES) {
        return yield* failure(operation, "Arcanum's listing kept changing while it was read.");
      }
      const read = yield* probe(at);
      total = read.total_count;
      const row = read.review_requests[0];
      if (row === undefined) return true;
      const position = positionOf(row);
      if (position === null) return yield* unreadableTime(operation);
      return comesAfter(position, key);
    });
    // `lo` is before the first match and `hi` at or past it. -1 and the end stand in for both.
    let lo = -1;
    let hi = Math.max(0, hint);
    let step = 1;
    if (yield* isAfter(hi)) {
      for (let at = hi - step; at >= 0; at = hi - step) {
        if (!(yield* isAfter(at))) {
          lo = at;
          break;
        }
        hi = at;
        step *= 2;
      }
    } else {
      lo = hi;
      for (;;) {
        const at = lo + step;
        if (total !== undefined && at >= total) {
          hi = total;
          break;
        }
        if (yield* isAfter(at)) {
          hi = at;
          break;
        }
        lo = at;
        step *= 2;
      }
    }
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (yield* isAfter(mid)) hi = mid;
      else lo = mid;
    }
    return hi;
  });

  const unreadableTime = (operation: string) =>
    Effect.fail(failure(operation, "Arcanum sent an update time this version cannot order by."));

  /**
   * One server-filtered listing. `rows` are the delivered rows, `scanned` every row read past the
   * resume point, filtered out or not, each with its exact position and the offset past it.
   */
  const listOneSide = Effect.fnUntraced(function* (input: ListInput) {
    const operation = "listChangeRequests";
    yield* requireHost(operation, input);
    const filters = input.filters;
    const author =
      filters?.author === undefined
        ? undefined
        : resolvePullRequestAuthorFilter(filters.author, input.viewer);
    if (
      input.involvement === "authored" &&
      author !== undefined &&
      author.toLowerCase() !== input.viewer.toLowerCase()
    ) {
      return { page: { items: [], truncated: false, continues: false }, rows: [], scanned: [] };
    }
    const authors =
      input.involvement === "authored"
        ? [input.viewer]
        : author === undefined
          ? undefined
          : [author];
    const filter = {
      repos: [input.repository],
      ...(authors === undefined ? {} : { authors }),
      ...(input.involvement === "reviewing" ? { assignees: [input.viewer] } : {}),
      ...(input.state === "open"
        ? { open: true }
        : input.state === "merged"
          ? { common_status: ["merged"] }
          : input.state === "closed"
            ? { common_status: ["discarded"] }
            : {}),
      ...(filters?.draft === "only"
        ? { status: "draft" }
        : filters?.draft === "hide"
          ? { status: "published" }
          : {}),
    };
    const limit = Math.max(1, Math.min(input.limit, LIST_PAGE_LIMIT));
    // Raw rows are read in larger pages when the provider itself filters them, so a run of
    // rejected rows costs fewer requests.
    const rawPageSize = filters?.checks === undefined ? limit : Math.max(limit, FILTERED_PAGE_ROWS);
    // Only the first page is shared, as the page under another search. Where a listing carries
    // on is decided on fresh reads alone: held offsets from before rows moved would skip some.
    const listPage = (offset: number, rows: number, fields: string, shared = false) =>
      api.request({
        operation,
        path: "/v1/review-requests",
        query: {
          filter: encodeJson(filter),
          // Arcanum orders by these two and nothing else, newest first: a total order.
          order: "-updated_at,-id",
          limit: String(rows),
          offset: String(offset),
          fields,
        },
        ...(shared ? { reuse: { tag: Reads.LIST_TAG, ttl: LIST_REUSE } } : {}),
      });
    const readRows = (offset: number, rows: number, shared = false) =>
      listPage(offset, rows, Json.LIST_FIELDS, shared).pipe(
        Effect.flatMap(Reads.decodeData(operation, Json.ReviewRequestPage)),
      );
    const cursor = input.cursor;
    // The last row a slice consumed, delivered or rejected. Rows only move up when they change,
    // so the rows after it keep their order however many rows before it leave or arrive. An
    // offset would drift, so the listing carries on at the first row after it, found afresh.
    const resumeKey =
      cursor === undefined
        ? null
        : (parseListPosition(cursor.resumeAfter) ?? boundaryPosition(cursor.updatedBefore));
    if (cursor !== undefined && resumeKey === null) {
      return yield* failure(operation, "The listing's position is not one this version can read.");
    }
    /**
     * The page from just before `at`. It skipped nothing when it starts at the top, or at or
     * before the resume point and reaches past it or to the end: the order is total.
     */
    const readFrom = Effect.fnUntraced(function* (at: number, key: ListPosition) {
      const from = Math.max(0, at - 1);
      const page = yield* readRows(from, rawPageSize + (at > 0 ? 1 : 0));
      if (from === 0) return { offset: from, page };
      const positions: Array<ListPosition> = [];
      for (const row of page.review_requests) {
        const position = positionOf(row);
        if (position === null) return yield* unreadableTime(operation);
        positions.push(position);
      }
      const first = positions[0];
      const exact =
        first !== undefined &&
        !comesAfter(first, key) &&
        (positions.some((position) => comesAfter(position, key)) ||
          from + positions.length >= page.total_count);
      return exact ? { offset: from, page } : null;
    });
    let offset = 0;
    let read: typeof Json.ReviewRequestPage.Type;
    if (resumeKey === null) {
      read = yield* readRows(0, rawPageSize, true);
    } else {
      // The hint is where the last slice ended. When rows above moved, the position is found
      // again and the page read from it is checked the same way.
      const found =
        (yield* readFrom(cursor?.delivered ?? 0, resumeKey)) ??
        (yield* readFrom(
          yield* locateAfter(operation, resumeKey, cursor?.delivered ?? 0, (at) =>
            listPage(at, 1, Json.PROBE_FIELDS).pipe(
              Effect.flatMap(Reads.decodeData(operation, Json.ReviewRequestProbe)),
            ),
          ),
          resumeKey,
        ));
      if (found === null) {
        return yield* failure(operation, "Arcanum's listing kept changing while it was read.");
      }
      offset = found.offset;
      read = found.page;
    }
    const start = offset;
    const matched: Array<{
      readonly item: ProviderChangeRequest;
      readonly position: ListPosition;
      readonly end: number;
    }> = [];
    const scanned: Array<{ readonly position: ListPosition; readonly end: number }> = [];
    let total = 0;
    let lastRead:
      | { readonly position: ListPosition; readonly updatedAt: string; readonly end: number }
      | undefined;
    // One raw page per slice: the service reads further slices within its own budget, so a
    // filter that matches nothing costs one page per slice, never a page budget per slice.
    total = read.total_count;
    for (const row of read.review_requests) {
      offset += 1;
      const position = positionOf(row);
      if (position === null) return yield* unreadableTime(operation);
      // A row ordered at or before the resume point was consumed already, or moved there.
      if (resumeKey !== null && !comesAfter(position, resumeKey)) continue;
      const item = rowToChangeRequest(row);
      lastRead = { position, updatedAt: item.updatedAt, end: offset };
      scanned.push({ position, end: offset });
      // Only the host can filter checks. The page narrows everything else on its own.
      if (filters?.checks !== undefined && item.checksState !== filters.checks) continue;
      matched.push({ item, position, end: offset });
    }
    // Everything read sat before the resume point, so rows above must have moved in meanwhile.
    if (lastRead === undefined && offset < total) {
      return yield* failure(operation, "Arcanum's listing kept changing while it was read.");
    }
    const delivered = matched.slice(0, limit);
    // Rows read past the limit are not consumed: the next slice starts after the last one sent.
    // Otherwise everything read was consumed, rejected rows included, so a run of rejected rows
    // always moves the position on.
    const consumed =
      matched.length > limit ? delivered.at(-1) : lastRead === undefined ? undefined : lastRead;
    const more = consumed === undefined ? false : consumed.end < total || matched.length > limit;
    const page: ProviderChangeRequestPage = {
      items: delivered.map((entry) => entry.item),
      ...(consumed === undefined ? {} : { resumeAfter: encodeListPosition(consumed.position) }),
      ...(delivered.length === 0 && lastRead !== undefined
        ? { scannedThrough: lastRead.updatedAt }
        : {}),
      truncated: more,
      // Only a hint for where the next search starts. The position decides.
      cursorAdvance: Math.max(0, (consumed?.end ?? offset) - (cursor?.delivered ?? start)),
      continues: more,
    };
    return { page, rows: delivered, scanned };
  });

  /**
   * `all` is the viewer's own pull requests and those assigned to them: everything else is the
   * whole of Arcadia. Arcanum's filter cannot say "author or assignee", so both listings are
   * read from one position and merged in the order they share.
   */
  const listInvolving = Effect.fnUntraced(function* (input: ListInput) {
    const operation = "listChangeRequests";
    const cursor = input.cursor;
    const resume = cursor === undefined ? null : parseInvolvingPosition(cursor.resumeAfter);
    if (cursor !== undefined && resume === null) {
      return yield* failure(operation, "The listing's position is not one this version can read.");
    }
    const pages = yield* Effect.forEach(
      INVOLVING_SIDES,
      (involvement, index) =>
        listOneSide({
          ...input,
          involvement,
          cursor:
            cursor === undefined || resume === null
              ? undefined
              : {
                  ...cursor,
                  delivered: resume.offsets[index]!,
                  resumeAfter: encodeListPosition(resume.position),
                },
        }),
      { concurrency: 2 },
    );
    const sides = pages.map(({ page, rows, scanned }, index) => ({
      rows,
      scanned,
      from: resume?.offsets[index] ?? 0,
      consumed: parseListPosition(page.resumeAfter),
      continues: page.continues,
    }));
    // A side that carries on may still hold rows newer than the other side's later ones, so
    // nothing past the newest such point is delivered yet.
    let cut: ListPosition | null = null;
    for (const side of sides) {
      if (side.continues && side.consumed !== null) {
        if (cut === null || comesAfter(cut, side.consumed)) cut = side.consumed;
      }
    }
    // A side's first page can be a held read: of two copies of a row, the newer one is current.
    const merged = new Map<number, { item: ProviderChangeRequest; position: ListPosition }>();
    for (const side of sides) {
      for (const row of side.rows) {
        const held = merged.get(row.item.number);
        if (held === undefined || comesAfter(held.position, row.position)) {
          merged.set(row.item.number, row);
        }
      }
    }
    const eligible = [...merged.values()]
      .filter((row) => cut === null || !comesAfter(row.position, cut))
      .toSorted((left, right) => (comesAfter(left.position, right.position) ? 1 : -1));
    const limit = Math.max(1, Math.min(input.limit, LIST_PAGE_LIMIT));
    const delivered = eligible.slice(0, limit);
    const items = delivered.map((row) => row.item);
    const boundary = eligible.length > limit ? delivered.at(-1)!.position : cut;
    if (boundary === null) return { items, truncated: false, continues: false };
    // Rejected rows count too: a hint short of them starts the next read among consumed rows.
    const offsets = sides.map(
      (side) =>
        side.scanned.filter((row) => !comesAfter(row.position, boundary)).at(-1)?.end ?? side.from,
    );
    return {
      items,
      resumeAfter: encodeInvolvingPosition(boundary, offsets),
      ...(items.length === 0 ? { scannedThrough: boundary.time } : {}),
      truncated: true,
      continues: true,
    } satisfies ProviderChangeRequestPage;
  });

  const listChangeRequests = Effect.fn("ArcanumPullRequestProvider.listChangeRequests")(function* (
    input: ListInput,
  ) {
    if (input.involvement === "all") return yield* listInvolving(input);
    return (yield* listOneSide(input)).page;
  });

  const fail =
    (operation: string) =>
    <A, R>(effect: Effect.Effect<A, ArcanumApi.ArcanumApiError | PullRequestProviderError, R>) =>
      run(operation)(effect);

  const detail = Effect.fn("ArcanumPullRequestProvider.getChangeRequest")(function* (
    input: ProviderRepositoryRef & { readonly number: number },
  ) {
    const operation = "getChangeRequest";
    const pull = yield* readPull(operation, input);
    const viewer = yield* reviewViewer(operation);
    const iteration = pull.active_diff_set;
    const open = isOpen(pull);
    const stats =
      iteration === undefined
        ? null
        : yield* api
            .request({
              operation,
              path: `/v1/review-requests/${pull.id}/diff-sets/${iteration.id}/diff-stats`,
              query: { fields: "changes_count" },
              reuse: { tag: STATS_TAG, ttl: STATS_REUSE },
            })
            .pipe(Effect.flatMap(Reads.decodeData(operation, Json.DiffStats)));
    const base = pullToChangeRequest(pull);
    const policy = autoMergeOf(pull);
    return {
      ...base,
      closedAt: base.closedAt ?? null,
      mergedAt: base.mergedAt ?? null,
      headSha: pull.active_diff_set?.arc_branch_heads?.from_id ?? null,
      body: pull.description ?? "",
      changedFiles: stats?.changes_count ?? 0,
      reviewers: reviewersOf(pull).map(Json.actor),
      checks: Json.toChecks(pull.checks ?? [], open),
      mergeCapabilities: {
        // The method Arcanum lands with. Whether it may land now is the `merge` action.
        merge: open,
        squash: false,
        rebase: false,
      },
      viewerPermissions: viewerPermissionsOf(pull, viewer),
      reviewStatus: Review.reviewStatusOf(pull, viewer),
      checkActions: open ? Checks.serviceActionsOf(pull.services ?? []) : [],
      ...(policy === undefined || policy === "unknown"
        ? {}
        : { autoMergeEnabled: autoMergeOn(policy) }),
      ...(autoMergeOn(policy) ? { autoMergeMethod: "merge" as const } : {}),
    } satisfies ProviderChangeRequestDetail;
  });

  const runReviewAction = Effect.fn("ArcanumPullRequestProvider.runReviewAction")(function* (
    input: Parameters<NonNullable<PullRequestProviderApi["runReviewAction"]>>[0],
  ) {
    const operation = "runReviewAction";
    if (!Review.isDecision(input.actionId)) {
      return yield* failure(operation, `Arcanum has no ${input.actionId} review action.`);
    }
    // Availability is read fresh, and a decision lands only on the iteration the viewer saw.
    const pull = yield* readPull(operation, input, Reads.FRESH);
    const iteration = yield* Reads.activeIteration(operation, pull);
    if (input.expectedHeadSha === undefined || input.expectedHeadSha !== iteration.head) {
      return yield* staleIteration(operation);
    }
    const reason = Review.unavailableReason(input.actionId, pull, yield* reviewViewer(operation));
    if (reason !== null) return yield* failure(operation, reason);
    yield* sendDecision(operation, pull.id, iteration.diffId, input.actionId);
  });

  /** Decides on one fresh read of the checks, never on what the detail showed. */
  const runCheckAction = Effect.fn("ArcanumPullRequestProvider.runCheckAction")(function* (
    input: Parameters<NonNullable<PullRequestProviderApi["runCheckAction"]>>[0],
  ) {
    const operation = "runCheckAction";
    const action = Checks.parseCheckAction(input.actionId);
    if (action === null) {
      return yield* failure(operation, `Arcanum has no ${input.actionId} check action.`);
    }
    const state = yield* api
      .request({
        operation,
        path: `/v1/review-requests/${input.number}`,
        query: { fields: Checks.CHECK_ACTION_FIELDS },
      })
      .pipe(Effect.flatMap(Reads.decodeData(operation, Checks.CheckActionState)));
    const iteration = state.active_diff_set;
    if (
      iteration === undefined ||
      input.expectedHeadSha === undefined ||
      input.expectedHeadSha !== iteration.arc_branch_heads?.from_id
    ) {
      return yield* staleIteration(operation);
    }
    if (!isOpen(state)) return yield* failure(operation, "The pull request is no longer open.");
    const reason = Checks.unavailableReason(action, state, input.reason);
    if (reason !== null) return yield* failure(operation, reason);
    yield* send({
      operation,
      ...Checks.checkActionWrite(action, {
        number: input.number,
        diffSetId: iteration.id,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      }),
    });
  });

  const runAction = Effect.fn("ArcanumPullRequestProvider.runAction")(function* (
    input: Parameters<PullRequestProviderApi["runAction"]>[0],
  ) {
    const operation = "runAction";
    if (input.stackNumber !== undefined) {
      return yield* failure(operation, "Arcanum has no pull request stacks.");
    }
    if (input.mergeMethod !== undefined && input.mergeMethod !== "merge") {
      return yield* failure(operation, "Arcanum only lands a pull request as a merge commit.");
    }
    if (!CAPABILITIES.actions.includes(input.action)) {
      return yield* failure(operation, `Arcanum has no ${input.action} action.`);
    }
    // Readiness is read fresh: a merge goes ahead only on what Arcanum says right now.
    const pull = yield* readPull(operation, input, Reads.FRESH);
    const viewer = yield* reviewViewer(operation);
    const allowed = viewerPermissionsOf(pull, viewer).actions;
    if (!allowed.includes(input.action)) {
      return yield* failure(
        operation,
        input.action === "merge"
          ? "Arcanum does not allow merging this pull request yet: its requirements are not all met."
          : `That action is not available on PR ${pull.id} in its current state.`,
      );
    }
    switch (input.action) {
      case "ready":
        return yield* send({
          operation,
          method: "PATCH",
          path: `/v1/public/review-requests/${pull.id}/publish`,
        });
      case "merge":
      case "enable-auto-merge":
        return yield* send({
          operation,
          method: "PUT",
          path: `/v1/pull-requests/${pull.id}/auto-merge`,
        });
      case "disable-auto-merge":
        return yield* send({
          operation,
          method: "DELETE",
          path: `/v1/pull-requests/${pull.id}/auto-merge`,
        });
      default:
        return yield* failure(operation, `Arcanum has no ${input.action} action.`);
    }
  });

  const provider: PullRequestProviderApi = {
    kind: KIND,
    capabilities: CAPABILITIES,
    unavailableRequirement: UNAVAILABLE_REQUIREMENT,
    servesHost: (candidate) => candidate.toLowerCase() === ARCANUM_WEB_HOST,
    // Detail checks carry no CI links; the checks read adds them.
    detailChecksComplete: false,
    withCredential: (_input, use) => api.withCredential(use),
    forgetChangeRequestReads: (scope) =>
      api.forget(
        scope?.number === undefined ? undefined : [Reads.pullTag(scope.number), Reads.LIST_TAG],
      ),

    resolveChangeRequestRepository: Effect.fn(
      "ArcanumPullRequestProvider.resolveChangeRequestRepository",
    )(function* (input) {
      yield* requireHost("resolveChangeRequestRepository", input);
      const interactive = yield* SourceControlRateLimit.Interactive;
      return yield* Cache.get(reviewRepositories, input.number).pipe(
        // A rate-limit pause can reject a shared background lookup before it sends a request.
        Effect.catchIf(
          (error) =>
            interactive &&
            error._tag === "ArcanumApiError" &&
            error.reason === "rate-limited" &&
            error.status === null,
          () =>
            readRepository(input.number).pipe(
              Effect.tap((repository) => Cache.set(reviewRepositories, input.number, repository)),
            ),
        ),
        run("resolveChangeRequestRepository"),
      );
    }),
    getViewer: () => viewerLogin("getViewer").pipe(fail("getViewer")),
    getRoutingIdentity: () =>
      api.identity("getRoutingIdentity").pipe(
        Effect.map(({ login }) => ({ accountId: login, viewer: login })),
        fail("getRoutingIdentity"),
      ),
    withVerifiedCredential: (_input, use) =>
      api.identity("withVerifiedCredential").pipe(
        fail("withVerifiedCredential"),
        Effect.flatMap(({ login, credential }) =>
          use({
            accountId: login,
            viewer: login,
            credentialFingerprint: credential.fingerprint,
          }).pipe(
            Effect.provideService(ArcanumApi.PinnedCredential, credential),
            Effect.provideService(SourceControlRateLimit.CredentialScope, credential.fingerprint),
          ),
        ),
      ),

    listChangeRequests: (input) => listChangeRequests(input).pipe(fail("listChangeRequests")),

    getChangeRequest: (input) => detail(input).pipe(fail("getChangeRequest")),

    getChangeRequestChecks: Effect.fn("ArcanumPullRequestProvider.getChangeRequestChecks")(
      function* (input) {
        const pull = yield* readPull("getChangeRequestChecks", input);
        const diffId = pull.active_diff_set?.id;
        const links =
          diffId === undefined
            ? new Map<string, string>()
            : yield* readCheckLinks("getChangeRequestChecks", pull.id, diffId);
        return {
          state: Json.pullRequestState(pull.full_status),
          checks: Json.toChecks(pull.checks ?? [], isOpen(pull), links),
        };
      },
      fail("getChangeRequestChecks"),
    ),

    getChangeRequestPreview: (input) =>
      readPull("getChangeRequestPreview", input).pipe(
        Effect.map((pull) => ({
          number: pull.id,
          title: Json.titleOf(pull),
          url: pull.url,
          author: Json.actor(pull.author.name),
          state: Json.pullRequestState(pull.full_status),
          isDraft: isDraft(pull),
          createdAt: toIsoUtc(pull.created_at),
        })),
        fail("getChangeRequestPreview"),
      ),

    getChangeRequestSummary: (input) =>
      readPull("getChangeRequestSummary", input).pipe(
        Effect.map((pull) => {
          const {
            reviewRequestLogins: _logins,
            labels: _labels,
            ...summary
          } = pullToChangeRequest(pull);
          return summary;
        }),
        fail("getChangeRequestSummary"),
      ),

    getChangeRequestWatchFingerprint: (input) =>
      readPull("getChangeRequestWatchFingerprint", input).pipe(
        Effect.map((pull) => ({
          status: [
            pull.full_status,
            pull.common_status,
            pull.active_diff_set?.id ?? "-",
            pull.merge_allowed === true,
            checksFingerprint(pull),
            pull.policies?.auto_merge ?? "-",
            pull.review?.review_status ?? "-",
          ].join(" "),
          // Arcanum moves `updated_at` on every change, comments included.
          remarks: pull.updated_at,
        })),
        fail("getChangeRequestWatchFingerprint"),
      ),

    getChangeRequestActivity: (input) =>
      toActivity("getChangeRequestActivity", input).pipe(
        Effect.map(({ pull, activity, commits }) => ({
          author: Json.actor(pull.author.name),
          reviewers: reviewersOf(pull).map(Json.actor),
          comments: activity.comments,
          commentCount: activity.comments.length,
          commentsTruncated: false,
          reviewThreadsTruncated: false,
          reviewThreads: activity.reviewThreads,
          commits: commits.map((commit) => ({
            oid: commit.sha,
            messageHeadline: commit.subject.trim(),
            committedDate: toIsoUtc(commit.committedAt),
          })),
        })),
        fail("getChangeRequestActivity"),
      ),

    getViewerPermissions: Effect.fn("ArcanumPullRequestProvider.getViewerPermissions")(function* (
      input,
    ) {
      // Fresh: the write that follows takes this read instead of one of its own.
      const pull = yield* readPull("getViewerPermissions", input, Reads.FRESH);
      return viewerPermissionsOf(pull, yield* reviewViewer("getViewerPermissions"));
    }, fail("getViewerPermissions")),

    getDiff: (input) => getDiff(input).pipe(fail("getDiff")),

    getDiffFilePaths: Effect.fn("ArcanumPullRequestProvider.getDiffFilePaths")(function* (input) {
      const operation = "getDiffFilePaths";
      const iteration = yield* iterationOf(operation, input);
      if (input.commit !== undefined) {
        // One commit's files come from its own diff, which may touch paths the final PR does not.
        yield* requireCommitOnPullRequest(operation, input.cwd, iteration, input.commit);
        const diff = yield* host.review
          .commitDiff({ cwd: input.cwd, commit: input.commit })
          .pipe(Effect.mapError(reviewError(operation)));
        if (diff.truncated) {
          return yield* failure(operation, "That commit changes too much to list its files.");
        }
        return {
          files: parseDiffFilePaths(diff.patch).map((file) => ({
            oldPath: file.oldPath ?? file.newPath ?? "",
            newPath: file.newPath ?? file.oldPath ?? "",
          })),
          nextCursor: null,
        };
      }
      const files = yield* diffFilesOf(operation, input.cwd, iteration);
      return {
        // A move may also be shown as a deletion and an addition, so both halves are listed too.
        files: files.flatMap((file) =>
          file.previousPath === null
            ? [{ oldPath: file.path, newPath: file.path }]
            : [
                { oldPath: file.previousPath, newPath: file.path },
                { oldPath: file.previousPath, newPath: file.previousPath },
                { oldPath: file.path, newPath: file.path },
              ],
        ),
        nextCursor: null,
      };
    }, fail("getDiffFilePaths")),

    getDiffFileContents: Effect.fn("ArcanumPullRequestProvider.getDiffFileContents")(function* (
      input,
    ) {
      const operation = "getDiffFileContents";
      const iteration = yield* iterationOf(operation, input);
      if (input.commit !== undefined) {
        yield* requireCommitOnPullRequest(operation, input.cwd, iteration, input.commit);
        const diff = yield* host.review
          .commitDiff({
            cwd: input.cwd,
            commit: input.commit,
            file: { path: input.newPath, previousPath: input.oldPath },
          })
          .pipe(Effect.mapError(reviewError(operation)));
        return yield* host.review
          .commitFileContents({
            cwd: input.cwd,
            parent: diff.parent,
            commit: input.commit,
            changeType: input.changeType,
            oldPath: input.oldPath,
            newPath: input.newPath,
          })
          .pipe(Effect.mapError(reviewError(operation)));
      }
      // The reviewable side is Arcanum's merge of the branch onto the base, not the pushed head.
      return yield* host.review
        .commitFileContents({
          cwd: input.cwd,
          parent: iteration.base,
          commit: iteration.merge,
          changeType: input.changeType,
          oldPath: input.oldPath,
          newPath: input.newPath,
        })
        .pipe(Effect.mapError(reviewError(operation)));
    }, fail("getDiffFileContents")),

    getFileStats: Effect.fn("ArcanumPullRequestProvider.getFileStats")(function* (input) {
      const iteration = yield* iterationOf("getFileStats", input);
      const whole = yield* readWholeDiff("getFileStats", input.cwd, iteration);
      return whole.truncated || whole.files === undefined
        ? { files: [], truncated: true }
        : {
            files: whole.files.map((file) => ({
              path: file.path,
              additions: file.additions,
              deletions: file.deletions,
            })),
            truncated: false,
          };
    }, fail("getFileStats")),

    getFilesViewed: Effect.fn("ArcanumPullRequestProvider.getFilesViewed")(function* (input) {
      const iteration = yield* iterationOf("getFilesViewed", input);
      const files = yield* readChangelist("getFilesViewed", iteration.diffId);
      // Both halves of a move read the one mark Arcanum keeps for it.
      return {
        files: [...Json.changelistTargets(files)].map(([path, target]) => ({
          path,
          state: target.entry.reviewed === true ? ("viewed" as const) : ("unviewed" as const),
        })),
        truncated: false,
      };
    }, fail("getFilesViewed")),

    setFilesViewed: Effect.fn("ArcanumPullRequestProvider.setFilesViewed")(function* (input) {
      const operation = "setFilesViewed";
      const iteration = yield* Reads.activeIteration(
        operation,
        yield* readPull(operation, input, Reads.FRESH),
      );
      const targets = Json.changelistTargets(
        yield* changelistStructure(operation, iteration.diffId),
      );
      // Entry ids are opaque and are sent exactly as the changelist gave them, once each.
      const wanted = new Map<string, { readonly viewed: boolean; readonly path: string }>();
      for (const file of input.files) {
        const target = targets.get(file.path);
        if (target === undefined) {
          return yield* failure(
            operation,
            `${file.path} is not in the pull request's latest iteration.`,
          );
        }
        const entryId = target.entry.entry_id;
        const earlier = wanted.get(entryId);
        // Both halves of a move are one mark, which cannot be set and cleared at once.
        if (earlier !== undefined && earlier.viewed !== file.viewed) {
          return yield* failure(
            operation,
            `${earlier.path} and ${file.path} are one moved file, so they are viewed together.`,
          );
        }
        wanted.set(entryId, { viewed: file.viewed, path: file.path });
      }
      const groups = new Map<boolean, Array<string>>();
      for (const [entryId, { viewed }] of wanted) {
        groups.set(viewed, [...(groups.get(viewed) ?? []), entryId]);
      }
      for (const [reviewed, entryIds] of groups) {
        yield* send({
          operation,
          method: "PUT",
          path: `/v1/review-requests/${input.number}/reviewed-files`,
          body: { entry_ids: entryIds, reviewed },
          // Marks are read afresh, never from a shared read.
          forgets: [],
        });
      }
    }, fail("setFilesViewed")),

    runAction: (input) => runAction(input).pipe(fail("runAction")),

    updateChangeRequest: Effect.fn("ArcanumPullRequestProvider.updateChangeRequest")(function* (
      input,
    ) {
      const operation = "updateChangeRequest";
      if (input.maintainerCanModify !== undefined) {
        return yield* failure(operation, "Arcanum has no maintainer edit setting.");
      }
      if (input.title === undefined && input.body === undefined) {
        return yield* failure(operation, "Nothing to change.");
      }
      const pull = yield* readPullIdentity(operation, input);
      if (input.title !== undefined) {
        yield* send({
          operation,
          method: "PATCH",
          path: `/v1/pull-requests/${pull.id}/summary`,
          body: { summary: input.title },
        });
      }
      if (input.body !== undefined) {
        yield* send({
          operation,
          method: "PATCH",
          path: `/v1/pull-requests/${pull.id}/description`,
          body: { description: input.body },
        });
      }
    }, fail("updateChangeRequest")),

    comment: Effect.fn("ArcanumPullRequestProvider.comment")(function* (input) {
      const pull = yield* readPullIdentity("comment", input);
      yield* send({
        operation: "comment",
        method: "POST",
        path: `/v2/public/pull-request/${pull.id}/comment`,
        body: { content: input.body, ...(input.isIssue === true ? { is_issue: true } : {}) },
        idempotencyKey: yield* idempotencyKey,
      });
    }, fail("comment")),

    updateComment: Effect.fn("ArcanumPullRequestProvider.updateComment")(function* (input) {
      const operation = "updateComment";
      yield* readPullIdentity(operation, input);
      const id = yield* parseCommentId(operation, input.commentId);
      const [comment, viewer] = yield* Effect.all([
        readComment(operation, id),
        viewerLogin(operation),
      ]);
      // Editing changes what someone said, so only the viewer's own comments are editable.
      if (comment.user.name.toLowerCase() !== viewer.toLowerCase()) {
        return yield* failure(operation, `Only ${comment.user.name} can edit that comment.`);
      }
      yield* send({
        operation,
        method: "PATCH",
        path: `/v1/public/review-requests-comments/${id}`,
        body: { content: input.body },
      });
    }, fail("updateComment")),

    submitReview: (input) => submitReview(input).pipe(fail("submitReview")),

    runReviewAction: (input) => runReviewAction(input).pipe(fail("runReviewAction")),

    runCheckAction: (input) => runCheckAction(input).pipe(fail("runCheckAction")),

    getChangeRequestReviewEvents: (input) =>
      api
        .request({
          operation: "getChangeRequestReviewEvents",
          path: `/v1/plugin/pull-request/${input.number}/activity`,
          // A timeline reopened within the minute reuses this; a write to the PR drops it.
          reuse: { tag: Reads.pullTag(input.number), ttl: Duration.minutes(1) },
        })
        .pipe(
          Effect.flatMap(Reads.decodeData("getChangeRequestReviewEvents", Review.ReviewActivities)),
          Effect.map(Review.reviewEventsOf),
          fail("getChangeRequestReviewEvents"),
        ),

    listReviewerCandidates: Effect.fn("ArcanumPullRequestProvider.listReviewerCandidates")(
      function* (input) {
        const operation = "listReviewerCandidates";
        const pull = yield* readPull(operation, input);
        const [suggested, current] = yield* Effect.all(
          [
            api
              .request({ operation, path: `/v1/review-requests/${pull.id}/suggested-assignees` })
              .pipe(Effect.flatMap(Reads.decodeData(operation, Json.SuggestedAssignees))),
            api
              .request({ operation, path: `/v1/pull-requests/${pull.id}/reviewers` })
              .pipe(Effect.flatMap(Reads.decodeData(operation, Json.Users))),
          ],
          { concurrency: 2 },
        );
        const requested = new Set(current.map((user) => user.name.toLowerCase()));
        const author = pull.author.name.toLowerCase();
        const seen = new Set<string>();
        const candidates = [...current, ...suggested].flatMap((user) => {
          const key = user.name.toLowerCase();
          if (key === author || seen.has(key)) return [];
          seen.add(key);
          return [
            {
              ...Json.actor(user.name),
              id: user.name,
              kind: "user" as const,
              isRequested: requested.has(key),
            },
          ];
        });
        return { candidates, truncated: false };
      },
      fail("listReviewerCandidates"),
    ),

    setReviewerRequest: Effect.fn("ArcanumPullRequestProvider.setReviewerRequest")(function* (
      input,
    ) {
      const operation = "setReviewerRequest";
      if (input.reviewers.some((reviewer) => reviewer.kind !== "user")) {
        return yield* failure(operation, "Arcanum requests reviews from people, not teams.");
      }
      const pull = yield* readPullIdentity(operation, input);
      yield* send({
        operation,
        method: input.requested ? "PUT" : "DELETE",
        path: `/v1/pull-requests/${pull.id}/reviewers`,
        body: { reviewers: input.reviewers.map((reviewer) => reviewer.id) },
      });
    }, fail("setReviewerRequest")),

    listLabelCandidates: Effect.fn("ArcanumPullRequestProvider.listLabelCandidates")(function* (
      input,
    ) {
      const operation = "listLabelCandidates";
      const pull = yield* readPull(operation, input);
      const catalog = yield* api
        .request({
          operation,
          path: "/v1/public/labels",
          query: { limit: String(LABEL_LIMIT), text: "" },
        })
        .pipe(Effect.flatMap(Reads.decodeData(operation, Json.Labels)));
      const applied = new Set(Json.labelsOf(pull.labels).map((label) => label.name));
      const names = [...new Set([...applied, ...catalog.map((label) => label.name)])];
      return {
        candidates: names.map((name) => ({
          name,
          color: null,
          description: null,
          isApplied: applied.has(name),
        })),
        truncated: catalog.length >= LABEL_LIMIT,
      };
    }, fail("listLabelCandidates")),

    listRepositoryLabels: Effect.fn("ArcanumPullRequestProvider.listRepositoryLabels")(function* (
      input,
    ) {
      const operation = "listRepositoryLabels";
      yield* requireHost(operation, input);
      const query = input.query?.trim();
      const labels = yield* api
        .request({
          operation,
          path: "/v1/public/labels",
          // Arcanum refuses the catalog without `text`, so an unfiltered read sends an empty one.
          query: { limit: String(LABEL_LIMIT), text: query ?? "" },
        })
        .pipe(Effect.flatMap(Reads.decodeData(operation, Json.Labels)));
      return {
        items: labels.map((label) => ({ name: label.name, color: null })),
        truncated: labels.length >= LABEL_LIMIT,
      };
    }, fail("listRepositoryLabels")),

    setLabels: Effect.fn("ArcanumPullRequestProvider.setLabels")(function* (input) {
      const pull = yield* readPullIdentity("setLabels", input);
      // PATCH adds to the set and DELETE takes away, leaving the other labels alone.
      yield* send({
        operation: "setLabels",
        method: input.applied ? "PATCH" : "DELETE",
        path: `/v1/pull-requests/${pull.id}/labels`,
        body: { labels: input.labels },
      });
    }, fail("setLabels")),

    replyToThread: Effect.fn("ArcanumPullRequestProvider.replyToThread")(function* (input) {
      const operation = "replyToThread";
      yield* readPullIdentity(operation, input);
      const root = yield* parseCommentId(operation, input.threadId);
      yield* send({
        operation,
        method: "POST",
        path: `/v1/public/review-requests-comments/${root}/replies`,
        body: { content: input.body },
        idempotencyKey: yield* idempotencyKey,
      });
    }, fail("replyToThread")),

    setReaction: Effect.fn("ArcanumPullRequestProvider.setReaction")(function* (input) {
      const operation = "setReaction";
      if (input.subjectId === undefined) {
        return yield* failure(
          operation,
          "Arcanum has no reactions on a pull request's description.",
        );
      }
      const pull = yield* readPullIdentity(operation, input);
      const id = yield* parseCommentId(operation, input.subjectId);
      const code = encodeURIComponent(Json.REACTION_CODES[input.content]);
      const target = Json.isPullRequestLevelId(id)
        ? `/v2/public/pull-request/${pull.id}`
        : `/v2/public/diff/${yield* commentDiffId(operation, pull.id, id)}`;
      yield* send({
        operation,
        method: input.reacted ? "PUT" : "DELETE",
        path: `${target}/comment/${id}/reaction/${code}`,
      });
    }, fail("setReaction")),

    setThreadResolution: Effect.fn("ArcanumPullRequestProvider.setThreadResolution")(function* (
      input,
    ) {
      const operation = "setThreadResolution";
      yield* readPullIdentity(operation, input);
      const root = yield* parseCommentId(operation, input.threadId);
      const comment = yield* readComment(operation, root);
      // Only an issue has a status, so a plain remark resolves nothing.
      if (comment.issue_status === undefined || comment.issue_status === "not_issue") {
        return yield* failure(
          operation,
          "That thread is not an issue, so it has nothing to resolve.",
        );
      }
      yield* send({
        operation,
        method: "PATCH",
        path: `/v1/public/review-requests-comments/${root}`,
        body: { issue_status: input.issueState ?? (input.resolved ? "resolved" : "open") },
      });
    }, fail("setThreadResolution")),
  };
  return provider;
});
