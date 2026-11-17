import { useAtomValue } from "@effect/atom-react";
import { checkActionConfirmation } from "@t3tools/client-runtime/pull-request-review";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  PullRequestCheckAction,
  PullRequestDetailView,
  PullRequestRef,
} from "@t3tools/contracts";
import { EllipsisIcon } from "lucide-react";
import { useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Menu, MenuItem, MenuItemLabel, MenuPopup, MenuTrigger } from "../ui/menu";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { readableFailure } from "./pullRequestDetail.logic";

/**
 * The host's actions on one check, or on the checks as a whole when `check` is null. Each is
 * confirmed, or asks for its reason, before it runs.
 */
export function PullRequestCheckActions({
  environmentId,
  reference,
  detail,
  check,
  actions,
  onDone,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  detail: PullRequestDetailView;
  check: string | null;
  actions: ReadonlyArray<PullRequestCheckAction>;
  onDone: () => void;
}) {
  const canWrite = useAtomValue(
    pullRequestEnvironment.runCheckAction.permissionAtom(environmentId),
  );
  const runCheckAction = useAtomCommand(pullRequestEnvironment.runCheckAction, {
    reportFailure: false,
  });
  const [pending, setPending] = useState(false);
  const [asking, setAsking] = useState<PullRequestCheckAction | null>(null);
  const [reason, setReason] = useState("");
  if (actions.length === 0) return null;
  const term = sourceControlClients.get(detail.provider).changeRequest.singular;

  const run = async (action: PullRequestCheckAction, given: string | undefined) => {
    setPending(true);
    const result = await runCheckAction({
      environmentId,
      input: {
        ...reference,
        actionId: action.id,
        ...(given === undefined ? {} : { reason: given }),
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
          "The host refused the check action.",
        ),
      });
      return;
    }
    setAsking(null);
    toastManager.add({ type: "success", title: `${action.label}: done` });
    onDone();
  };

  const choose = async (action: PullRequestCheckAction) => {
    if (action.reason !== undefined) {
      setReason("");
      setAsking(action);
      return;
    }
    const message = checkActionConfirmation(action, check, term);
    const confirmed = (await requestConfirmDialog(message)) ?? window.confirm(message);
    if (confirmed) await run(action, undefined);
  };

  const trimmed = reason.trim();
  const [question, ...explanation] =
    asking === null ? [""] : checkActionConfirmation(asking, check, term).split("\n");

  return (
    <>
      <Menu>
        <MenuTrigger
          render={
            check === null ? (
              <Button size="xs" variant="outline" disabled={pending} />
            ) : (
              <Button
                size="icon-xs"
                variant="ghost"
                disabled={pending}
                aria-label={`Actions for ${check}`}
              />
            )
          }
        >
          {check === null ? "Check actions" : <EllipsisIcon aria-hidden />}
        </MenuTrigger>
        <MenuPopup align="end">
          {actions.map((action) => {
            const unavailable = !canWrite
              ? "This session cannot make changes on the host."
              : action.available
                ? null
                : (action.unavailableReason ?? "Not available now.");
            return (
              <MenuItem
                key={action.id}
                disabled={unavailable !== null}
                onClick={() => void choose(action)}
              >
                <span className="flex min-w-0 flex-col">
                  <MenuItemLabel>{action.label}</MenuItemLabel>
                  {unavailable === null ? null : (
                    <span className="text-xs text-muted-foreground">{unavailable}</span>
                  )}
                </span>
              </MenuItem>
            );
          })}
        </MenuPopup>
      </Menu>
      <Dialog
        open={asking !== null}
        onOpenChange={(open) => (pending || open ? undefined : setAsking(null))}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{question}</DialogTitle>
            <DialogDescription>{explanation.join(" ")}</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Textarea
              autoFocus
              placeholder={asking?.reason === "required" ? "Reason (required)" : "Reason"}
              value={reason}
              maxLength={1000}
              onChange={(event) => setReason(event.target.value)}
            />
          </DialogPanel>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => setAsking(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={pending || (asking?.reason === "required" && trimmed.length === 0)}
              onClick={() => (asking === null ? undefined : void run(asking, trimmed || undefined))}
            >
              {pending ? "Working..." : (asking?.label ?? "")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
