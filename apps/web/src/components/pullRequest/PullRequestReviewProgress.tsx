import { reviewerStateLabel } from "@t3tools/client-runtime/pull-request-review";
import type { PullRequestDetailView, PullRequestReviewerState } from "@t3tools/contracts";
import { ListChecksIcon } from "lucide-react";

import { cn } from "~/lib/utils";

const TONES: Partial<Record<PullRequestReviewerState, string>> = {
  approved: "text-success-foreground",
  "changes-requested": "text-destructive-foreground",
  blocked: "text-destructive-foreground",
};

/** Each reviewer's standing and the completion a host counts, for a host that reports them. */
export function PullRequestReviewProgress({ detail }: { detail: PullRequestDetailView }) {
  const status = detail.reviewStatus;
  if (status === undefined) return null;
  return (
    <div className="grid min-h-7 min-w-0 grid-cols-[6rem_minmax(0,1fr)] items-center gap-2 text-xs sm:min-h-6">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <ListChecksIcon className="size-3.5" />
        Review
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-foreground">
        {status.completionPercent === undefined ? null : (
          <span className="font-medium tabular-nums">
            {Math.round(status.completionPercent)}% done
          </span>
        )}
        {status.reviewers.length === 0 ? (
          <span className="text-muted-foreground">No reviewers yet</span>
        ) : (
          status.reviewers.map((reviewer) => (
            <span key={reviewer.actor.login} className="inline-flex items-center gap-1">
              <span>{reviewer.actor.login}</span>
              <span className={cn("text-muted-foreground", TONES[reviewer.state])}>
                {reviewerStateLabel(reviewer)}
              </span>
            </span>
          ))
        )}
      </span>
    </div>
  );
}
