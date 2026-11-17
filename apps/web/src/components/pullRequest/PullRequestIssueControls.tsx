import { useAtomValue } from "@effect/atom-react";
import { issueStateLabel, issueTransitions } from "@t3tools/client-runtime/pull-request-review";
import type {
  EnvironmentId,
  PullRequestComment,
  PullRequestDetailView,
  PullRequestIssueState,
  PullRequestRef,
} from "@t3tools/contracts";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleSlashIcon,
  CornerDownRightIcon,
} from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { toastManager } from "../ui/toast";
import { usePullRequestReviewStore, type PendingReviewComment } from "./pullRequestReviewStore";

const STATE_ICONS = {
  open: CircleAlertIcon,
  resolved: CircleCheckIcon,
  dropped: CircleSlashIcon,
} as const;

export function PullRequestIssueStateBadge({ state }: { state: PullRequestIssueState }) {
  const Icon = STATE_ICONS[state];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 font-medium",
        state === "resolved" ? "text-success-foreground" : "text-muted-foreground",
      )}
    >
      <Icon aria-hidden className="size-3" />
      {issueStateLabel(state)}
    </span>
  );
}

/** Resolve, drop or reopen an issue. Renders nothing for a viewer who cannot change it. */
export function PullRequestIssueActions({
  environmentId,
  reference,
  threadId,
  state,
  canResolve,
  pending = false,
  className,
  onDone,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  threadId: string;
  state: PullRequestIssueState;
  canResolve: boolean;
  pending?: boolean;
  className?: string;
  onDone: () => void;
}) {
  const canWrite = useAtomValue(
    pullRequestEnvironment.setThreadResolution.permissionAtom(environmentId),
  );
  const setThreadResolution = useAtomCommand(pullRequestEnvironment.setThreadResolution, {
    reportFailure: false,
  });
  const [running, setRunning] = useState(false);
  if (!canResolve || !canWrite) return null;

  const move = async (next: PullRequestIssueState) => {
    setRunning(true);
    const result = await setThreadResolution({
      environmentId,
      input: { ...reference, threadId, resolved: next !== "open", issueState: next },
    });
    setRunning(false);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "The issue could not be updated" });
      return;
    }
    onDone();
  };

  return (
    <span className={cn("flex shrink-0 items-center gap-1", className)}>
      {issueTransitions(state).map((transition) => (
        <Button
          key={transition.state}
          size="xs"
          variant="ghost"
          disabled={pending || running}
          onClick={() => void move(transition.state)}
        >
          {transition.label}
        </Button>
      ))}
    </span>
  );
}

/** A conversation comment's place in an issue thread: the issue's state, or a reply marker. */
export function PullRequestCommentIssue({
  comment,
  environmentId,
  reference,
  onDone,
}: {
  comment: PullRequestComment | undefined;
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  onDone: () => void;
}) {
  if (comment === undefined) return null;
  if (comment.issueState !== undefined) {
    return (
      <span className="flex shrink-0 items-center gap-1 text-2xs">
        <PullRequestIssueStateBadge state={comment.issueState} />
        <PullRequestIssueActions
          environmentId={environmentId}
          reference={reference}
          threadId={comment.threadId ?? comment.id}
          state={comment.issueState}
          canResolve={comment.canResolve === true}
          onDone={onDone}
        />
      </span>
    );
  }
  return comment.threadId !== undefined && comment.threadId !== comment.id ? (
    <span className="inline-flex shrink-0 items-center gap-1 text-2xs text-muted-foreground">
      <CornerDownRightIcon aria-hidden className="size-3" />
      Reply in a thread
    </span>
  ) : null;
}

/** Raises a new comment as an issue, on a host that has them. */
export function PullRequestIssueToggle({
  detail,
  checked,
  disabled = false,
  onCheckedChange,
}: {
  detail: Pick<PullRequestDetailView, "capabilities">;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  if (detail.capabilities.review.issues !== true) return null;
  return (
    <label className="mr-auto flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onCheckedChange(next === true)}
      />
      Raise as an issue
    </label>
  );
}

/** Marks a pending line comment as an issue before the review is submitted. */
export function PendingReviewIssueToggle({
  detail,
  reviewKey,
  comment,
}: {
  detail: Pick<PullRequestDetailView, "capabilities">;
  reviewKey: string;
  comment: PendingReviewComment;
}) {
  return (
    <PullRequestIssueToggle
      detail={detail}
      checked={comment.isIssue === true}
      onCheckedChange={(isIssue) =>
        usePullRequestReviewStore.setState((store) => ({
          drafts: {
            ...store.drafts,
            [reviewKey]: (store.drafts[reviewKey] ?? []).map((draft) =>
              draft.id === comment.id ? { ...draft, isIssue } : draft,
            ),
          },
        }))
      }
    />
  );
}
