import {
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
  type PullRequestActor,
  type PullRequestCheck,
  type PullRequestCheckStatus,
  type PullRequestChecksState,
  type PullRequestComment,
  type PullRequestIssueState,
  type PullRequestLabel,
  type PullRequestMergeability,
  type PullRequestReaction,
  type PullRequestReactionContent,
  type PullRequestReviewDecision,
  type PullRequestReviewThread,
  type PullRequestState,
  type PullRequestThreadComment,
} from "@t3tools/contracts";
import { toIsoUtc } from "@t3tools/source-control-core/server/pullRequestUtils";
import * as Schema from "effect/Schema";

import { checkActionsOf } from "./arcanumChecks.ts";

/*
 * Arcanum drops unknown or unprojected fields silently, so every read asks for its fields by name
 * and these schemas require the ones a response must carry. A missing required field fails the
 * read. An optional one is optional because Arcanum leaves it out when it does not apply.
 */

export const CommentId = Schema.Int.check(
  Schema.isBetween({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
);
const InlineCommentId = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const Login = Schema.Struct({ name: TrimmedNonEmptyString });
const Hash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u));

/** One envelope for every read: `{"data": …}`. */
export const envelope = <S extends Schema.Top>(data: S) =>
  Schema.fromJsonString(Schema.Struct({ data }));

const DiffSetSummary = Schema.Struct({
  id: PositiveInt,
  status: Schema.String,
  has_conflicts: Schema.optional(Schema.Boolean),
  patch_stats: Schema.optional(
    Schema.Struct({ additions: NonNegativeInt, deletions: NonNegativeInt }),
  ),
});

const BranchHeads = Schema.Struct({ from_id: Hash, to_id: Hash, merge_id: Hash });

/** The active iteration's merge requirements as `/v1/review-requests` projects `checks(...)`. */
const ReviewRequestCheck = Schema.Struct({
  system: Schema.String,
  type: Schema.String,
  required: Schema.optional(Schema.Boolean),
  status: Schema.String,
  description: Schema.optional(Schema.String),
  configuration: Schema.optional(
    Schema.Struct({ disabling_policy: Schema.optional(Schema.String) }),
  ),
});
type ReviewRequestCheck = typeof ReviewRequestCheck.Type;

/** `GET /v1/review-requests/{id}` with {@link DETAIL_FIELDS}. */
export const DETAIL_FIELDS = [
  "id",
  "url",
  "summary",
  "description",
  "author(name)",
  "vcs(arc_repo_name,from_branch,to_branch)",
  "created_at",
  "updated_at",
  "closed_at",
  "full_status",
  "common_status",
  "merge_allowed",
  "checks(system,type,required,status,description,configuration(disabling_policy))",
  "labels(name)",
  "policies(auto_merge)",
  "active_diff_set(id,status,has_conflicts,patch_stats(additions,deletions),arc_branch_heads(from_id,to_id,merge_id))",
  "review(review_status,completion_percent,reviewers(user(name),action))",
  "assignees(name)",
  "outstaff",
  "caps(disable_sticky_ships)",
  "services(id,configuration_state)",
].join(",");

export const ReviewRequest = Schema.Struct({
  id: PositiveInt,
  url: TrimmedNonEmptyString,
  summary: Schema.String,
  description: Schema.optional(Schema.String),
  author: Login,
  vcs: Schema.Struct({
    arc_repo_name: TrimmedNonEmptyString,
    from_branch: TrimmedNonEmptyString,
    to_branch: TrimmedNonEmptyString,
  }),
  created_at: TrimmedNonEmptyString,
  updated_at: TrimmedNonEmptyString,
  closed_at: Schema.optional(Schema.NullOr(Schema.String)),
  full_status: TrimmedNonEmptyString,
  common_status: TrimmedNonEmptyString,
  merge_allowed: Schema.optional(Schema.Boolean),
  checks: Schema.optional(Schema.Array(ReviewRequestCheck)),
  labels: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String }))),
  policies: Schema.optional(Schema.Struct({ auto_merge: Schema.optional(Schema.String) })),
  active_diff_set: Schema.optional(
    Schema.Struct({ ...DiffSetSummary.fields, arc_branch_heads: Schema.optional(BranchHeads) }),
  ),
  review: Schema.optional(
    Schema.Struct({
      review_status: Schema.optional(Schema.String),
      completion_percent: Schema.optional(Schema.Number),
      reviewers: Schema.optional(
        Schema.Array(
          Schema.Struct({ user: Schema.optional(Login), action: Schema.optional(Schema.String) }),
        ),
      ),
    }),
  ),
  assignees: Schema.optional(Schema.Array(Login)),
  /** The author is an external contributor. */
  outstaff: Schema.optional(Schema.Boolean),
  caps: Schema.optional(Schema.Struct({ disable_sticky_ships: Schema.optional(Schema.Boolean) })),
  services: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.optional(Schema.String),
        configuration_state: Schema.optional(Schema.String),
      }),
    ),
  ),
});
export type ReviewRequest = typeof ReviewRequest.Type;

/** `GET /v1/review-requests` rows. */
export const LIST_FIELDS = `review_requests(${[
  "id",
  "url",
  "summary",
  "author(name)",
  "vcs(arc_repo_name,from_branch,to_branch)",
  "created_at",
  "updated_at",
  "closed_at",
  "full_status",
  "common_status",
  "review_status",
  "labels(name)",
  "checks(system,type,required,status)",
  "active_diff_set(id,status,has_conflicts,patch_stats(additions,deletions))",
  "assignees(user(name))",
].join(",")}),total_count`;

export const ReviewRequestRow = Schema.Struct({
  id: PositiveInt,
  url: TrimmedNonEmptyString,
  summary: Schema.String,
  author: Login,
  vcs: Schema.Struct({
    arc_repo_name: TrimmedNonEmptyString,
    from_branch: TrimmedNonEmptyString,
    to_branch: TrimmedNonEmptyString,
  }),
  created_at: TrimmedNonEmptyString,
  updated_at: TrimmedNonEmptyString,
  closed_at: Schema.optional(Schema.NullOr(Schema.String)),
  full_status: TrimmedNonEmptyString,
  common_status: TrimmedNonEmptyString,
  review_status: Schema.optional(Schema.String),
  labels: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String }))),
  checks: Schema.optional(Schema.Array(ReviewRequestCheck)),
  active_diff_set: Schema.optional(DiffSetSummary),
  assignees: Schema.optional(Schema.Array(Schema.Struct({ user: Schema.optional(Login) }))),
});
export type ReviewRequestRow = typeof ReviewRequestRow.Type;

export const ReviewRequestPage = Schema.Struct({
  review_requests: Schema.Array(ReviewRequestRow),
  total_count: NonNegativeInt,
});

/** One row's position in the listing order, for finding where a listing carries on. */
export const PROBE_FIELDS = "review_requests(id,updated_at),total_count";
export const ReviewRequestProbe = Schema.Struct({
  review_requests: Schema.Array(
    Schema.Struct({ id: PositiveInt, updated_at: TrimmedNonEmptyString }),
  ),
  total_count: NonNegativeInt,
});

/** `GET /v2/pull-requests/latest`. */
export const LatestPullRequest = Schema.Struct({ id: PositiveInt });

/** `GET /v1/review-requests/{id}/diff-sets/{id}/diff-stats`. */
export const DiffStats = Schema.Struct({ changes_count: NonNegativeInt });

/** `GET /v2/public/diff/{id}/checks`, one page, read only for its links. */
export const ChecksPage = Schema.Struct({
  checks: Schema.Array(
    Schema.Struct({
      key: Schema.Struct({ system: Schema.String, type: Schema.String }),
      uri: Schema.optional(Schema.String),
    }),
  ),
  next_page_cursor: Schema.optional(Schema.NullOr(Schema.String)),
});
export type ChecksPage = typeof ChecksPage.Type;

/** `GET /v2/public/diff/{xid}/changelist` with {@link CHANGELIST_FIELDS}. */
export const CHANGELIST_FIELDS = "path,entry_id,change_type,node_type,reviewed,source(path)";

export const ChangelistEntry = Schema.Struct({
  path: Schema.String.check(Schema.isNonEmpty()),
  entry_id: TrimmedNonEmptyString,
  change_type: Schema.String,
  node_type: Schema.String,
  reviewed: Schema.optional(Schema.Boolean),
  source: Schema.optional(Schema.Struct({ path: Schema.optional(Schema.String) })),
});
export type ChangelistEntry = typeof ChangelistEntry.Type;
export const Changelist = Schema.Array(ChangelistEntry);

const Reaction = Schema.Struct({ code: Schema.String, user: Login });
const IssueStatus = Schema.optional(Schema.String);
// Arcanum uses -1 for a file-level comment, which has no numbered line in T3.
const CommentLine = Schema.Union([PositiveInt, Schema.Literals([-1])]);

/** `GET /v1/public/review-requests/{id}/comments`: every comment, anchored where it was written. */
export const PublicComment = Schema.Struct({
  id: CommentId,
  user: Login,
  content: Schema.String,
  created_at: TrimmedNonEmptyString,
  edited_at: Schema.optional(Schema.NullOr(Schema.String)),
  deleted_at: Schema.optional(Schema.NullOr(Schema.String)),
  published_at: Schema.optional(Schema.NullOr(Schema.String)),
  draft: Schema.optional(Schema.Boolean),
  reply_to_id: Schema.optional(Schema.NullOr(CommentId)),
  issue_status: IssueStatus,
  reactions: Schema.optional(Schema.Array(Reaction)),
  anchor: Schema.optional(
    Schema.Struct({
      review_request: Schema.optional(
        Schema.Struct({
          diff: Schema.optional(
            Schema.Struct({
              diff_set_xid: Schema.optional(Schema.String),
              file: Schema.Struct({
                entry_id: Schema.Struct({
                  content_id_before: Schema.optional(Schema.Struct({ path: Schema.String })),
                  content_id_after: Schema.optional(Schema.Struct({ path: Schema.String })),
                }),
                position: Schema.optional(
                  Schema.Struct({ side: Schema.String, line: CommentLine }),
                ),
              }),
            }),
          ),
        }),
      ),
    }),
  ),
});
export type PublicComment = typeof PublicComment.Type;

/** `GET /v2/public/diff/{id}/comment` with {@link DIFF_COMMENT_FIELDS}: anchored in that iteration. */
export const DIFF_COMMENT_FIELDS =
  "id,author(name),content,created_at,edited_at,deleted_at,published_at,reply_to_id,is_draft,issue_status,anchor,reactions(code,user(name))";

export const DiffComment = Schema.Struct({
  id: InlineCommentId,
  author: Login,
  content: Schema.String,
  created_at: TrimmedNonEmptyString,
  edited_at: Schema.optional(Schema.NullOr(Schema.String)),
  deleted_at: Schema.optional(Schema.NullOr(Schema.String)),
  published_at: Schema.optional(Schema.NullOr(Schema.String)),
  reply_to_id: Schema.optional(Schema.NullOr(CommentId)),
  is_draft: Schema.optional(Schema.Boolean),
  issue_status: IssueStatus,
  reactions: Schema.optional(Schema.Array(Reaction)),
  anchor: Schema.Struct({
    diff_id: PositiveInt,
    entry_id: Schema.optional(Schema.String),
    source_path: Schema.optional(Schema.String),
    destination_path: Schema.optional(Schema.String),
    line: Schema.optional(CommentLine),
    side: Schema.optional(Schema.String),
  }),
});
export type DiffComment = typeof DiffComment.Type;

/** A comment Arcanum created, as its write echo carries it. */
export const CreatedComment = Schema.Struct({ id: CommentId });

export const SuggestedAssignees = Schema.Array(Login);
export const Users = Schema.Array(Login);
export const Labels = Schema.Array(Schema.Struct({ name: TrimmedNonEmptyString }));

export function pullRequestState(fullStatus: string): PullRequestState {
  return fullStatus === "merged" ? "merged" : fullStatus === "discarded" ? "closed" : "open";
}

/** Null means review is off for merging, undefined that Arcanum said nothing this maps. */
export function reviewDecision(
  reviewStatus: string | undefined,
): PullRequestReviewDecision | null | undefined {
  switch (reviewStatus) {
    case "review_completed":
      return "approved";
    case "needs_work":
    case "waiting_for_changes":
    case "block_merge":
      return "changes-requested";
    case "waiting_for_review":
    case "review_in_progress":
      return "review-required";
    case "turned_off_for_merge":
      return null;
    default:
      return undefined;
  }
}

export function mergeability(input: {
  readonly full_status: string;
  readonly active_diff_set?: { readonly has_conflicts?: boolean | undefined } | undefined;
}): PullRequestMergeability {
  if (input.full_status === "conflicts" || input.active_diff_set?.has_conflicts === true) {
    return "conflicting";
  }
  return input.active_diff_set?.has_conflicts === false ? "mergeable" : "unknown";
}

export const actor = (login: string): PullRequestActor => ({
  login,
  name: null,
  // Staff serves avatars on the intranet without auth.
  avatarUrl: `https://center.yandex-team.ru/api/v1/user/${encodeURIComponent(login)}/avatar/100.jpg`,
  ...(login.startsWith("robot-") ? { isBot: true } : {}),
});

export const labelsOf = (
  labels: ReadonlyArray<{ readonly name: string }> | undefined,
): ReadonlyArray<PullRequestLabel> =>
  (labels ?? []).flatMap((label) =>
    label.name.trim().length === 0 ? [] : [{ name: label.name.trim(), color: null }],
  );

export const titleOf = (row: { readonly id: number; readonly summary: string }) =>
  row.summary.trim() || `PR ${row.id}`;

const CHECK_STATUS: Readonly<Record<string, PullRequestCheckStatus>> = {
  success: "success",
  failure: "failure",
  error: "failure",
  pending: "pending",
  // `unknown` is a check that has not reported yet, such as CI before the iteration is published.
  unknown: "queued",
  not_started: "queued",
  cancelled: "cancelled",
  skipped: "skipped",
  action_required: "action-required",
};

// Arcanum lists approval as a merge check, but review has its own state and is not CI.
const isReviewCheck = (check: { readonly system: string; readonly type: string }) =>
  check.system === "arcanum" && check.type === "approved";

const checkKey = (check: { readonly system: string; readonly type: string }) =>
  `${check.system}\0${check.type}`;

/** CI links by check, from `/v2/public/diff/{id}/checks`: the v1 projection has none. */
export function checkLinksOf(pages: ReadonlyArray<ChecksPage>): ReadonlyMap<string, string> {
  return new Map(
    pages.flatMap((page) =>
      page.checks.flatMap((check) => {
        const uri = check.uri?.trim();
        return uri ? [[checkKey(check.key), uri] as const] : [];
      }),
    ),
  );
}

/** `withActions` for an open pull request, whose checks can still change. */
export function toChecks(
  checks: ReadonlyArray<ReviewRequestCheck>,
  withActions: boolean,
  links: ReadonlyMap<string, string> = new Map(),
): ReadonlyArray<PullRequestCheck> {
  return checks.flatMap((check) => {
    if (isReviewCheck(check)) return [];
    // A status this version does not know is still running, never passed.
    const status = CHECK_STATUS[check.status] ?? "pending";
    const required = check.required === true;
    return [
      {
        name: `${check.system}: ${check.type}`.trim(),
        status,
        description: check.description?.trim() || null,
        url: links.get(checkKey(check)) ?? null,
        required,
        ...(withActions
          ? {
              actions: checkActionsOf(
                {
                  system: check.system,
                  type: check.type,
                  required,
                  disabling_policy: check.configuration?.disabling_policy,
                },
                status,
              ),
            }
          : {}),
      },
    ];
  });
}

/** Undefined when the read did not project checks. */
export const checksStateOfPull = (pull: {
  readonly checks?: ReadonlyArray<ReviewRequestCheck> | undefined;
}) => (pull.checks === undefined ? undefined : checksStateOf(toChecks(pull.checks, false)));

/** Rolls up checks the way merging reads them: only required ones block. */
export function checksStateOf(
  checks: ReadonlyArray<PullRequestCheck>,
): PullRequestChecksState | null {
  const required = checks.filter((check) => check.required === true);
  if (required.length === 0) return null;
  if (required.some((check) => check.status === "failure" || check.status === "cancelled")) {
    return "failing";
  }
  if (required.some((check) => ["pending", "queued", "action-required"].includes(check.status))) {
    return "pending";
  }
  return "passing";
}

/**
 * The codes Arcanum's API takes for each reaction. Arcanum stores any code a person sends, and these
 * are the shortcodes its web picker uses, and a code with no entry here is not shown.
 */
export const REACTION_CODES: Readonly<Record<PullRequestReactionContent, string>> = {
  "thumbs-up": ":+1:",
  "thumbs-down": ":-1:",
  laugh: ":smile:",
  hooray: ":tada:",
  confused: ":confused:",
  heart: ":heart:",
  rocket: ":rocket:",
  eyes: ":eyes:",
};
const CONTENT_BY_CODE = new Map<string, PullRequestReactionContent>([
  ...Object.entries(REACTION_CODES).map(
    ([content, code]) => [code, content as PullRequestReactionContent] as const,
  ),
  // Sent for laugh by earlier versions; Arcanum's web shows it as "?".
  [":laughing:", "laugh"],
]);

function toReactions(
  reactions: ReadonlyArray<{ readonly code: string; readonly user: { readonly name: string } }>,
  viewer: string,
): ReadonlyArray<PullRequestReaction> {
  const byContent = new Map<PullRequestReactionContent, Set<string>>();
  for (const reaction of reactions) {
    const content = CONTENT_BY_CODE.get(reaction.code);
    if (content === undefined) continue;
    const users = byContent.get(content) ?? new Set<string>();
    users.add(reaction.user.name);
    byContent.set(content, users);
  }
  const viewerKey = viewer.toLowerCase();
  return [...byContent].map(([content, users]) => {
    const all = [...users];
    const viewerHasReacted = all.some((user) => user.toLowerCase() === viewerKey);
    return {
      content,
      count: all.length,
      actors: all.filter((user) => user.toLowerCase() !== viewerKey),
      viewerHasReacted,
    };
  });
}

const iso = (value: string) => toIsoUtc(value);
const editedAt = (comment: {
  readonly edited_at?: string | null | undefined;
}): { readonly editedAt?: string } =>
  comment.edited_at ? { editedAt: iso(comment.edited_at) } : {};

const isVisible = (comment: {
  readonly deleted_at?: string | null | undefined;
  readonly draft?: boolean | undefined;
  readonly is_draft?: boolean | undefined;
}) => !comment.deleted_at && comment.draft !== true && comment.is_draft !== true;

/** PR-level comments carry negative ids and inline ones positive, so the id says which route. */
export const isPullRequestLevelId = (id: number) => id < 0;

/** Null for a comment that is not an issue, or whose status this version does not know. */
const issueStateOf = (status: string | undefined): PullRequestIssueState | null =>
  status === "open" || status === "resolved" || status === "dropped" ? status : null;

export interface ArcanumActivity {
  readonly comments: ReadonlyArray<PullRequestComment>;
  readonly reviewThreads: ReadonlyArray<PullRequestReviewThread>;
  /** The iteration inline anchors and thread writes are bound to, by root comment id. */
  readonly threadDiffIds: ReadonlyMap<string, number>;
}

/**
 * Builds the conversation from every comment and the active iteration's re-anchored inline
 * comments. A thread whose root did not carry over to the active iteration is outdated, and keeps
 * the line it was written on. Replies follow `reply_to_id` up to their root at any depth.
 */
export function toActivity(input: {
  readonly all: ReadonlyArray<PublicComment>;
  readonly active: ReadonlyArray<DiffComment>;
  readonly viewer: string;
  readonly pullRequestUrl: string;
}): ArcanumActivity {
  const byId = new Map(input.all.map((comment) => [comment.id, comment]));
  const activeById = new Map(input.active.map((comment) => [comment.id, comment]));
  const viewerKey = input.viewer.toLowerCase();
  const rootOf = (id: number): number => {
    let current = id;
    const seen = new Set<number>();
    for (;;) {
      if (seen.has(current)) return current;
      seen.add(current);
      const parent = byId.get(current)?.reply_to_id ?? activeById.get(current)?.reply_to_id;
      if (parent === undefined || parent === null) return current;
      current = parent;
    }
  };
  const ids = new Set<number>([...byId.keys(), ...activeById.keys()]);
  const groups = new Map<number, Array<number>>();
  for (const id of ids) {
    const root = rootOf(id);
    const group = groups.get(root) ?? [];
    group.push(id);
    groups.set(root, group);
  }

  const author = (id: number) => (activeById.get(id)?.author ?? byId.get(id)?.user)?.name ?? null;
  const created = (id: number) => activeById.get(id)?.created_at ?? byId.get(id)?.created_at ?? "";
  const ordered = (group: ReadonlyArray<number>) =>
    group.toSorted((left, right) => created(left).localeCompare(created(right)) || left - right);

  const comments: Array<PullRequestComment> = [];
  const reviewThreads: Array<PullRequestReviewThread> = [];
  const threadDiffIds = new Map<string, number>();

  for (const [root, group] of groups) {
    const visible = ordered(group).flatMap((id) => {
      const comment = activeById.get(id) ?? byId.get(id);
      if (comment === undefined || !isVisible(comment)) return [];
      const login = author(id);
      return [
        {
          id: String(id),
          author: login === null ? null : actor(login),
          body: comment.content,
          createdAt: iso(comment.created_at),
          ...editedAt(comment),
          url: input.pullRequestUrl,
          reactions: toReactions(comment.reactions ?? [], input.viewer),
          canEdit: login !== null && login.toLowerCase() === viewerKey,
        } satisfies PullRequestThreadComment,
      ];
    });
    if (visible.length === 0) continue;

    if (isPullRequestLevelId(root)) {
      const rootComment = byId.get(root) ?? activeById.get(root);
      const issueState = issueStateOf(rootComment?.issue_status);
      for (const comment of visible) {
        const isRoot = comment.id === String(root);
        comments.push({
          ...comment,
          kind: "issue-comment",
          path: null,
          reviewState: null,
          threadId: String(root),
          ...(isRoot && issueState !== null ? { issueState, canResolve: true } : {}),
        });
      }
      continue;
    }

    const activeRoot = activeById.get(root);
    const originalRoot = byId.get(root);
    const originalFile = originalRoot?.anchor?.review_request?.diff?.file;
    const path =
      activeRoot?.anchor.destination_path ??
      activeRoot?.anchor.source_path ??
      originalFile?.entry_id.content_id_after?.path ??
      originalFile?.entry_id.content_id_before?.path;
    if (path === undefined || path.trim().length === 0) continue;
    const position =
      activeRoot === undefined
        ? originalFile?.position
        : activeRoot.anchor.line === undefined
          ? undefined
          : { line: activeRoot.anchor.line, side: activeRoot.anchor.side ?? "new" };
    const issueState = issueStateOf(activeRoot?.issue_status ?? originalRoot?.issue_status);
    if (activeRoot !== undefined) threadDiffIds.set(String(root), activeRoot.anchor.diff_id);
    reviewThreads.push({
      id: String(root),
      path,
      line: position !== undefined && position.line > 0 ? position.line : null,
      side: position?.side === "old" ? "left" : "right",
      isResolved: issueState === "resolved" || issueState === "dropped",
      isOutdated: activeRoot === undefined,
      comments: visible,
      commentCount: visible.length,
      canResolve: issueState !== null,
      ...(issueState === null ? {} : { issueState }),
    });
  }

  comments.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return { comments, reviewThreads, threadDiffIds };
}

/** Files of a changelist, without the directory entries `flat_path_with_dirs` adds. */
export const changelistFiles = (entries: ReadonlyArray<ChangelistEntry>) =>
  entries.filter((entry) => entry.node_type !== "dir");

/** Where a path of the diff points in the changelist. */
export interface ChangelistTarget {
  readonly entry: ChangelistEntry;
  /** The deletion half of a move, which Arc's patch shows under the old path. */
  readonly movedFrom: boolean;
}

/**
 * Each path the diff shows, to the changelist entry it belongs to. A move shows as its old path
 * deleted and its new path added, and both halves are the one entry. A copy's source stays out:
 * it is unchanged and can be the source of several copies.
 */
export function changelistTargets(
  entries: ReadonlyArray<ChangelistEntry>,
): ReadonlyMap<string, ChangelistTarget> {
  const targets = new Map<string, ChangelistTarget>();
  for (const entry of entries) targets.set(entry.path, { entry, movedFrom: false });
  for (const entry of entries) {
    const source = entry.change_type === "move" ? previousPathOf(entry) : null;
    // A path that is a changed file of its own keeps that entry.
    if (source !== null && !targets.has(source)) {
      targets.set(source, { entry, movedFrom: true });
    }
  }
  return targets;
}

/** The old path a move or copy came from, otherwise the file's own path. */
export const previousPathOf = (entry: ChangelistEntry): string | null =>
  (entry.change_type === "move" || entry.change_type === "copy") &&
  entry.source?.path !== undefined &&
  entry.source.path.length > 0 &&
  entry.source.path !== entry.path
    ? entry.source.path
    : null;
