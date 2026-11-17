import { useAtomValue } from "@effect/atom-react";
import { reviewActionConfirmation } from "@t3tools/client-runtime/pull-request-review";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { PullRequestDetail } from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { composerPullRequests } from "../../state/pull-requests";
import { useAtomCommand } from "../../state/use-atom-command";
import { usePullRequestConnected } from "./usePullRequestConnected";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";

/** The host's review decisions beyond the verdicts, each confirmed before it runs. */
export function PullRequestReviewActions(props: {
  readonly params: PullRequestParams;
  readonly pr: PullRequestDetail | null;
  readonly busy: boolean;
  /** The sheet's own submission, which refreshes and closes on success. */
  readonly submit: (operation: () => Promise<void>) => Promise<void>;
}) {
  const target = pullRequestTarget(props.params);
  const connected = usePullRequestConnected(target.environmentId);
  const canRun = useAtomValue(
    composerPullRequests.runReviewAction.permissionAtom(target.environmentId),
  );
  const run = useAtomCommand(composerPullRequests.runReviewAction, { reportFailure: false });
  const pr = props.pr;
  const actions = pr?.reviewStatus?.actions ?? [];
  if (pr === null || actions.length === 0) return null;
  const term = sourceControlClients.get(pr.provider).changeRequest.singular;

  return (
    <View className="gap-1.5">
      <Text className="px-4 text-xs text-foreground-muted">More decisions</Text>
      <View className="overflow-hidden rounded-[20px] bg-grouped-card">
        {actions.map((action) => {
          const reason = !connected
            ? "Reconnect to make changes."
            : !canRun
              ? "This session cannot make changes on the host."
              : action.available
                ? null
                : (action.unavailableReason ?? "Not available now.");
          const [title, ...rest] = reviewActionConfirmation(action, term).split("\n");
          return (
            <Pressable
              key={action.id}
              accessibilityRole="button"
              accessibilityState={{ disabled: reason !== null || props.busy }}
              disabled={reason !== null || props.busy}
              onPress={() =>
                Dialog.confirm({
                  title: title ?? action.label,
                  message: rest.join("\n"),
                  confirmText: action.label,
                  onConfirm: () =>
                    void props.submit(async () => {
                      const response = await run({
                        ...target,
                        input: {
                          ...target.input,
                          actionId: action.id,
                          ...(pr.headSha === undefined ? {} : { expectedHeadSha: pr.headSha }),
                        },
                      });
                      if (response._tag === "Failure") throw squashAtomCommandFailure(response);
                    }),
                })
              }
              className="gap-0.5 border-b border-border-subtle px-4 py-3 last:border-b-0 active:opacity-70"
            >
              <Text
                className={
                  reason === null
                    ? "text-base text-primary-text"
                    : "text-base text-foreground-muted"
                }
              >
                {action.label}
              </Text>
              {reason === null ? null : (
                <Text className="text-xs text-foreground-muted">{reason}</Text>
              )}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
