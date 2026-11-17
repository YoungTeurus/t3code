import { useAtomValue } from "@effect/atom-react";
import { issueStateLabel, issueTransitions } from "@t3tools/client-runtime/pull-request-review";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  PullRequestComment,
  PullRequestDetail,
  PullRequestIssueState,
} from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { composerPullRequests } from "../../state/pull-requests";
import { useAtomCommand } from "../../state/use-atom-command";
import { usePullRequestConnected } from "./usePullRequestConnected";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";

const PILL = "min-h-8 flex-row items-center gap-1 rounded-full border px-2.5 active:opacity-70";

/** An issue's state, with resolve, drop or reopen for a viewer who may change it. */
export function PullRequestIssueActions(props: {
  readonly params: PullRequestParams;
  readonly threadId: string;
  readonly state: PullRequestIssueState;
  readonly canResolve: boolean;
  readonly onChanged: () => void;
}) {
  const target = pullRequestTarget(props.params);
  const connected = usePullRequestConnected(target.environmentId);
  const canWrite = useAtomValue(
    composerPullRequests.setThreadResolution.permissionAtom(target.environmentId),
  );
  const setThreadResolution = useAtomCommand(composerPullRequests.setThreadResolution, {
    reportFailure: false,
  });
  const [busy, setBusy] = useState(false);
  const move = async (next: PullRequestIssueState) => {
    setBusy(true);
    const response = await setThreadResolution({
      ...target,
      input: {
        ...target.input,
        threadId: props.threadId,
        resolved: next !== "open",
        issueState: next,
      },
    });
    setBusy(false);
    if (response._tag === "Failure") {
      const cause = squashAtomCommandFailure(response);
      Dialog.alert(
        "Couldn't update the issue",
        cause instanceof Error ? cause.message : "Try again.",
      );
      return;
    }
    props.onChanged();
  };
  return (
    <View className="flex-row flex-wrap items-center gap-1.5">
      <Text className="text-xs font-t3-medium text-foreground-muted">
        {issueStateLabel(props.state)}
      </Text>
      {props.canResolve && connected && canWrite
        ? issueTransitions(props.state).map((transition) => (
            <Pressable
              key={transition.state}
              accessibilityRole="button"
              accessibilityState={{ disabled: busy }}
              disabled={busy}
              onPress={() => void move(transition.state)}
              className={`${PILL} border-border-subtle`}
            >
              <Text className="text-xs font-t3-medium text-foreground">{transition.label}</Text>
            </Pressable>
          ))
        : null}
    </View>
  );
}

/** A conversation comment's place in an issue thread: the issue's state, or a reply marker. */
export function PullRequestCommentIssue(props: {
  readonly params: PullRequestParams;
  readonly comment: PullRequestComment;
  readonly onChanged: () => void;
}) {
  const { comment } = props;
  if (comment.issueState !== undefined) {
    return (
      <PullRequestIssueActions
        params={props.params}
        threadId={comment.threadId ?? comment.id}
        state={comment.issueState}
        canResolve={comment.canResolve === true}
        onChanged={props.onChanged}
      />
    );
  }
  return comment.threadId !== undefined && comment.threadId !== comment.id ? (
    <Text className="text-2xs text-foreground-muted">Reply in a thread</Text>
  ) : null;
}

/** Raises a new comment as an issue, on a host that has them. */
export function PullRequestIssueToggle(props: {
  readonly pr: Pick<PullRequestDetail, "capabilities"> | null;
  readonly value: boolean;
  readonly disabled?: boolean;
  readonly onValueChange: (value: boolean) => void;
}) {
  if (props.pr?.capabilities.review.issues !== true) return null;
  return (
    <View className="flex-row items-center justify-between gap-3 px-4">
      <Text className="text-sm text-foreground">Raise as an issue</Text>
      <ThemedSwitch
        accessibilityLabel="Raise as an issue"
        disabled={props.disabled}
        value={props.value}
        onValueChange={props.onValueChange}
      />
    </View>
  );
}
