import { useAtomValue } from "@effect/atom-react";
import { reviewActionConfirmation } from "@t3tools/client-runtime/pull-request-review";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  PullRequestDetailView,
  PullRequestRef,
  PullRequestReviewAction,
} from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { Menu, MenuItem, MenuItemLabel, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { readableFailure } from "./pullRequestDetail.logic";

/** The host's review decisions beyond the verdicts, each confirmed before it runs. */
export function PullRequestReviewActions({
  environmentId,
  reference,
  detail,
  onDone,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  detail: PullRequestDetailView;
  onDone: () => void;
}) {
  const canWrite = useAtomValue(
    pullRequestEnvironment.runReviewAction.permissionAtom(environmentId),
  );
  const runReviewAction = useAtomCommand(pullRequestEnvironment.runReviewAction, {
    reportFailure: false,
  });
  const [pending, setPending] = useState(false);
  const actions = detail.reviewStatus?.actions ?? [];
  if (actions.length === 0) return null;
  const term = sourceControlClients.get(detail.provider).changeRequest.singular;

  const run = async (action: PullRequestReviewAction) => {
    const message = reviewActionConfirmation(action, term);
    const confirmed = (await requestConfirmDialog(message)) ?? window.confirm(message);
    if (!confirmed) return;
    setPending(true);
    const result = await runReviewAction({
      environmentId,
      input: {
        ...reference,
        actionId: action.id,
        ...(detail.headSha === undefined ? {} : { expectedHeadSha: detail.headSha }),
      },
    });
    setPending(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: `${action.label} failed`,
        description: readableFailure(
          squashAtomCommandFailure(result),
          "The host refused the review decision.",
        ),
      });
      return;
    }
    toastManager.add({ type: "success", title: `${action.label}: done` });
    onDone();
  };

  return (
    <div className="mt-2 flex justify-start">
      <Menu>
        <MenuTrigger render={<Button size="compact" variant="outline" disabled={pending} />}>
          More decisions
          <ChevronDownIcon aria-hidden />
        </MenuTrigger>
        <MenuPopup align="start">
          {actions.map((action) => {
            const reason = !canWrite
              ? "This session cannot make changes on the host."
              : action.available
                ? null
                : (action.unavailableReason ?? "Not available now.");
            return (
              <MenuItem key={action.id} disabled={reason !== null} onClick={() => void run(action)}>
                <span className="flex min-w-0 flex-col">
                  <MenuItemLabel>{action.label}</MenuItemLabel>
                  {reason === null ? null : (
                    <span className="text-xs text-muted-foreground">{reason}</span>
                  )}
                </span>
              </MenuItem>
            );
          })}
        </MenuPopup>
      </Menu>
    </div>
  );
}
