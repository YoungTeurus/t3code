import { toIsoUtc } from "@t3tools/source-control-core/server/pullRequestUtils";
import * as Schema from "effect/Schema";

import type {
  PullRequestComment,
  PullRequestReviewAction,
  PullRequestReviewStatus,
  PullRequestReviewVerdict,
  PullRequestReviewerStatus,
} from "@t3tools/contracts";

import type { ArcanumAccount } from "./ArcanumApi.ts";
import * as Json from "./arcanumJson.ts";

/** Every native decision, by the id T3 sends back. `ship` and `request-changes` are the verdicts. */
export type Decision =
  | "ship"
  | "sticky-ship"
  | "request-changes"
  | "block-merge"
  | "unship"
  | "cancel-request-changes"
  | "unblock-merge";

/** The decisions offered beside the verdicts, in menu order. */
const EXTRA_ACTIONS = [
  { id: "sticky-ship", label: "Sticky Ship" },
  { id: "block-merge", label: "Block merge" },
  { id: "unship", label: "Withdraw Ship" },
  { id: "cancel-request-changes", label: "Withdraw changes request" },
  { id: "unblock-merge", label: "Lift merge block" },
] as const satisfies ReadonlyArray<{ readonly id: Decision; readonly label: string }>;

/** The write each decision is: a POST sets it on the iteration, a DELETE withdraws it. */
export const DECISION_WRITES: Readonly<
  Record<
    Decision,
    {
      readonly method: "POST" | "DELETE";
      readonly route: "ship" | "request-for-changes" | "block-merge";
      readonly sticky?: boolean;
    }
  >
> = {
  ship: { method: "POST", route: "ship", sticky: false },
  "sticky-ship": { method: "POST", route: "ship", sticky: true },
  "request-changes": { method: "POST", route: "request-for-changes" },
  "block-merge": { method: "POST", route: "block-merge" },
  unship: { method: "DELETE", route: "ship" },
  "cancel-request-changes": { method: "DELETE", route: "request-for-changes" },
  "unblock-merge": { method: "DELETE", route: "block-merge" },
};

export const isDecision = (id: string): id is Decision => Object.hasOwn(DECISION_WRITES, id);

/** A reviewer's standing vote, as Arcanum names it. */
type Vote = "ship" | "sticky_ship" | "waiting_for_changes" | "block_merge";

const voteOf = (pull: Json.ReviewRequest, login: string): Vote | null => {
  const key = login.toLowerCase();
  const action = pull.review?.reviewers?.find(
    (reviewer) => reviewer.user?.name.toLowerCase() === key,
  )?.action;
  return action === "ship" ||
    action === "sticky_ship" ||
    action === "waiting_for_changes" ||
    action === "block_merge"
    ? action
    : null;
};

export interface ReviewViewer {
  readonly login: string;
  readonly account?: ArcanumAccount | undefined;
}

/**
 * Why the viewer cannot take a decision on the pull request as read, or null when Arcanum would
 * accept it. Arcanum checks again on the write.
 */
export function unavailableReason(
  decision: Decision,
  pull: Json.ReviewRequest,
  viewer: ReviewViewer,
): string | null {
  const account = viewer.account;
  const iteration = pull.active_diff_set;
  const shared =
    account === undefined
      ? "Arcanum did not say whether this account may review."
      : account.banned
        ? "This account is banned from review in Arcanum."
        : account.outstaff
          ? "Arcanum does not take review decisions from external accounts."
          : Json.pullRequestState(pull.full_status) !== "open"
            ? "Review decisions need an open pull request."
            : iteration === undefined
              ? "This pull request has no iteration to review yet."
              : iteration.status === "discarded"
                ? "This iteration was discarded. Refresh before deciding."
                : null;
  if (shared !== null) return shared;
  const vote = voteOf(pull, viewer.login);
  switch (decision) {
    case "sticky-ship":
      if (pull.outstaff === true) {
        return "Sticky Ship is not available on pull requests from external contributors.";
      }
      if (pull.caps?.disable_sticky_ships === true) {
        return "This pull request's review rules turn Sticky Ship off.";
      }
      return pull.outstaff === false && pull.caps?.disable_sticky_ships === false
        ? null
        : "Arcanum did not say whether Sticky Ship is allowed here.";
    case "request-changes":
      if (iteration?.status === "published") return null;
      return iteration?.status === "draft"
        ? "Publish the iteration before requesting changes."
        : "Arcanum did not say whether this iteration is published.";
    case "unship":
      return vote === "ship" || vote === "sticky_ship" ? null : "You have no Ship to withdraw.";
    case "cancel-request-changes":
      return vote === "waiting_for_changes" ? null : "You have not requested changes.";
    case "unblock-merge":
      return vote === "block_merge" ? null : "You have not blocked merging.";
    case "ship":
    case "block-merge":
      return null;
  }
}

/** The verdicts the viewer can submit with a review. A comment needs no decision. */
export function verdictsOf(
  pull: Json.ReviewRequest,
  viewer: ReviewViewer,
): ReadonlyArray<PullRequestReviewVerdict> {
  return [
    "comment",
    ...(unavailableReason("ship", pull, viewer) === null ? (["approve"] as const) : []),
    ...(unavailableReason("request-changes", pull, viewer) === null
      ? (["request-changes"] as const)
      : []),
  ];
}

const REVIEWER_STATES: Readonly<
  Record<string, Pick<PullRequestReviewerStatus, "state" | "label">>
> = {
  ship: { state: "approved", label: "Ship" },
  sticky_ship: { state: "approved", label: "Sticky Ship" },
  block_merge: { state: "blocked" },
  waiting_for_changes: { state: "changes-requested" },
  needs_work: { state: "changes-requested" },
  comment: { state: "commented" },
};

export function reviewStatusOf(
  pull: Json.ReviewRequest,
  viewer: ReviewViewer,
): PullRequestReviewStatus {
  const reviewers: Array<PullRequestReviewerStatus> = [];
  const seen = new Set<string>();
  for (const reviewer of pull.review?.reviewers ?? []) {
    const login = reviewer.user?.name;
    if (login === undefined || seen.has(login.toLowerCase())) continue;
    seen.add(login.toLowerCase());
    reviewers.push({
      actor: Json.actor(login),
      ...(REVIEWER_STATES[reviewer.action ?? ""] ?? { state: "pending" }),
    });
  }
  // Assigned reviewers who have not acted yet.
  for (const assignee of pull.assignees ?? []) {
    if (seen.has(assignee.name.toLowerCase())) continue;
    seen.add(assignee.name.toLowerCase());
    reviewers.push({ actor: Json.actor(assignee.name), state: "pending" });
  }
  const percent = pull.review?.completion_percent;
  return {
    reviewers,
    ...(percent !== undefined && Number.isFinite(percent) && percent >= 0 && percent <= 100
      ? { completionPercent: percent }
      : {}),
    actions: EXTRA_ACTIONS.map(({ id, label }): PullRequestReviewAction => {
      const reason = unavailableReason(id, pull, viewer);
      return reason === null
        ? { id, label, available: true }
        : { id, label, available: false, unavailableReason: reason };
    }),
  };
}

/**
 * `GET /v1/plugin/pull-request/{id}/activity`, Arcanum's whole history of a pull request in one
 * answer (`plugin_api`). Its paged `review/review-request/{id}/activity` builds that same history
 * on every page, so one read of this costs Arcanum less.
 */
export const ReviewActivities = Schema.Struct({
  activities: Schema.Array(
    Schema.Struct({
      activity: Schema.String,
      id: Schema.String,
      action_time: Schema.String,
      ship: Schema.optional(
        Schema.Struct({
          login: Schema.String,
          review_system: Schema.optional(Schema.Unknown),
        }),
      ),
    }),
  ),
});
export type ReviewActivities = typeof ReviewActivities.Type;

/** The decisions shown in the timeline, by Arcanum's activity name, as T3 review states. */
const REVIEW_EVENT_STATES: Readonly<Record<string, string>> = {
  approved: "APPROVED",
  approved_pr: "APPROVED",
  unapproved: "WITHDREW_SHIP",
  unapproved_all: "WITHDREW_SHIP",
  waiting_for_changes: "CHANGES_REQUESTED",
  unmark_waiting_for_changes: "WITHDREW_CHANGES_REQUEST",
  block_merge: "BLOCKED_MERGE",
  unblock_merge: "LIFTED_MERGE_BLOCK",
};

/** Review decisions as `review` comments without a body; every other activity is dropped. */
export function reviewEventsOf(history: ReviewActivities): ReadonlyArray<PullRequestComment> {
  return history.activities.flatMap((entry) => {
    const reviewState = REVIEW_EVENT_STATES[entry.activity];
    if (reviewState === undefined) return [];
    const login = entry.ship?.login;
    return [
      {
        id: `review-event:${entry.id}`,
        kind: "review" as const,
        author:
          login === undefined
            ? null
            : {
                ...Json.actor(login),
                ...(entry.ship?.review_system === undefined ? {} : { isBot: true }),
              },
        body: "",
        createdAt: toIsoUtc(entry.action_time),
        url: null,
        path: null,
        reviewState,
        // Arcanum takes reactions on comments only, and an activity id is not one.
        canReact: false,
      },
    ];
  });
}
