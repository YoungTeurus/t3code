import type {
  PullRequestIssueState,
  PullRequestCheckAction,
  PullRequestReviewAction,
  PullRequestReviewerState,
  PullRequestReviewerStatus,
} from "@t3tools/contracts";

const REVIEWER_STATE_LABELS: Record<PullRequestReviewerState, string> = {
  pending: "Pending",
  commented: "Commented",
  approved: "Approved",
  "changes-requested": "Changes requested",
  blocked: "Blocked merging",
};

export const reviewerStateLabel = (status: PullRequestReviewerStatus): string =>
  status.label ?? REVIEWER_STATE_LABELS[status.state];

/**
 * Asked before a review action runs. Any of them can change whether the host lets the change
 * request merge, and a host with auto-merge on lands it at once.
 */
export const reviewActionConfirmation = (action: PullRequestReviewAction, term: string): string =>
  `${action.label} on this ${term}?\nThis changes your review decision on the host. If auto-merge is on, the ${term} can merge as soon as its requirements hold.`;

/**
 * Asked before a check action runs, or shown above its reason. Each can change whether the host
 * lets the change request merge.
 */
export const checkActionConfirmation = (
  action: PullRequestCheckAction,
  check: string | null,
  term: string,
): string =>
  `${action.label}${check === null ? "" : ` ${check}`}?\nThis changes what the host requires before the ${term} can merge. If auto-merge is on, the ${term} can merge as soon as its requirements hold.`;

/** A review decision in words for a timeline, such as "approved" or a host's "blocked merge". */
export const reviewStateVerb = (state: string): string => {
  const normalized = state.trim().toUpperCase().replaceAll("-", "_");
  if (normalized === "APPROVED") return "approved";
  if (normalized === "CHANGES_REQUESTED") return "requested changes";
  return normalized.toLowerCase().replaceAll("_", " ");
};

const ISSUE_STATE_LABELS: Record<PullRequestIssueState, string> = {
  open: "Open issue",
  resolved: "Resolved",
  dropped: "Dropped",
};

export const issueStateLabel = (state: PullRequestIssueState): string => ISSUE_STATE_LABELS[state];

/** The states an issue can move to from `state`, each with its button label. */
export function issueTransitions(
  state: PullRequestIssueState,
): ReadonlyArray<{ readonly state: PullRequestIssueState; readonly label: string }> {
  return state === "open"
    ? [
        { state: "resolved", label: "Resolve" },
        { state: "dropped", label: "Drop" },
      ]
    : [{ state: "open", label: "Reopen" }];
}

interface ThreadMember {
  readonly id: string;
  readonly threadId?: string | undefined;
  readonly createdAt: string;
}

/**
 * Moves each reply right after its thread's root, oldest reply first, keeping every other item
 * where it was. `memberOf` names the comment an item shows, or undefined for other items. A reply
 * whose root is not in the list stays in place.
 */
export function nestThreadReplies<T>(
  items: ReadonlyArray<T>,
  memberOf: (item: T) => ThreadMember | undefined,
): { readonly items: ReadonlyArray<T>; readonly replies: ReadonlySet<T> } {
  const roots = new Set<string>();
  for (const item of items) {
    const member = memberOf(item);
    if (member !== undefined && member.threadId === member.id) roots.add(member.id);
  }
  const byRoot = new Map<string, T[]>();
  for (const item of items) {
    const member = memberOf(item);
    if (member?.threadId === undefined || member.threadId === member.id) continue;
    if (!roots.has(member.threadId)) continue;
    byRoot.set(member.threadId, [...(byRoot.get(member.threadId) ?? []), item]);
  }
  if (byRoot.size === 0) return { items, replies: new Set() };
  const replies = new Set([...byRoot.values()].flat());
  const nested: T[] = [];
  for (const item of items) {
    if (replies.has(item)) continue;
    nested.push(item);
    const member = memberOf(item);
    const thread = member === undefined ? undefined : byRoot.get(member.id);
    if (thread === undefined || member?.threadId !== member?.id) continue;
    nested.push(
      ...[...thread].sort((left, right) =>
        memberOf(left)!.createdAt.localeCompare(memberOf(right)!.createdAt),
      ),
    );
  }
  return { items: nested, replies };
}

/**
 * `shown`, a slice of `all`, with the roots its replies belong to put back in front, in `all`'s
 * order, so a filtered or paged list keeps each thread whole.
 */
export function withThreadRoots<T>(
  shown: ReadonlyArray<T>,
  all: ReadonlyArray<T>,
  memberOf: (item: T) => ThreadMember | undefined,
): ReadonlyArray<T> {
  const present = new Set(shown);
  const wanted = new Set<string>();
  for (const item of shown) {
    const member = memberOf(item);
    if (member?.threadId !== undefined && member.threadId !== member.id)
      wanted.add(member.threadId);
  }
  const roots = all.filter((item) => {
    const member = memberOf(item);
    return (
      member !== undefined &&
      !present.has(item) &&
      member.threadId === member.id &&
      wanted.has(member.id)
    );
  });
  return roots.length === 0 ? shown : [...roots, ...shown];
}
