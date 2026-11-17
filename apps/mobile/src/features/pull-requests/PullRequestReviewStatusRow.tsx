import { reviewerStateLabel } from "@t3tools/client-runtime/pull-request-review";
import type { PullRequestDetail, PullRequestReviewerState } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";
import Animated from "react-native-reanimated";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { PullRequestCardRow } from "./PullRequestControls";
import { PullRequestAvatar } from "./PullRequestPresentation";
import { PR_DISCLOSURE_ENTER, PR_ROW_EXIT, PR_ROW_LAYOUT } from "./pullRequestAnimations";

const STATE_SYMBOLS: Record<
  PullRequestReviewerState,
  { readonly icon: AppSymbolName; readonly tint: string }
> = {
  approved: { icon: "checkmark", tint: "accent-adaptive-emerald-600-400" },
  "changes-requested": { icon: "plusminus", tint: "accent-danger-foreground" },
  blocked: { icon: "slash.circle", tint: "accent-danger-foreground" },
  commented: { icon: "bubble.left", tint: "accent-icon-muted" },
  pending: { icon: "clock", tint: "accent-icon-muted" },
};

/** Each reviewer's standing and the completion a host counts, for a host that reports them. */
export function PullRequestReviewStatusRow(props: { readonly pr: PullRequestDetail }) {
  const [expanded, setExpanded] = useState(false);
  const status = props.pr.reviewStatus;
  if (status === undefined) return null;
  return (
    <Animated.View layout={PR_ROW_LAYOUT}>
      <PullRequestCardRow
        title="Review progress"
        icon="list.number"
        {...(status.completionPercent === undefined
          ? {}
          : { value: `${Math.round(status.completionPercent)}%` })}
        compact
        expanded={expanded}
        onPress={() => setExpanded(!expanded)}
      />
      {expanded ? (
        <Animated.View
          layout={PR_ROW_LAYOUT}
          entering={PR_DISCLOSURE_ENTER}
          exiting={PR_ROW_EXIT}
          className="pl-8"
        >
          {status.reviewers.length === 0 ? (
            <Text className="px-4 py-3 text-sm text-foreground-muted">No reviewers yet</Text>
          ) : (
            status.reviewers.map((reviewer) => {
              const label = reviewerStateLabel(reviewer);
              const symbol = STATE_SYMBOLS[reviewer.state];
              return (
                <View
                  key={reviewer.actor.login}
                  accessibilityLabel={`${reviewer.actor.login}, ${label}`}
                  className="min-h-14 flex-row items-center gap-3 px-4 py-2"
                >
                  <SymbolView name={symbol.icon} size={18} tintColorClassName={symbol.tint} />
                  <PullRequestAvatar actor={reviewer.actor} size={32} />
                  <Text className="min-w-0 flex-1 text-sm font-t3-medium" numberOfLines={1}>
                    {reviewer.actor.login}
                  </Text>
                  <Text className="text-xs text-foreground-muted">{label}</Text>
                </View>
              );
            })
          )}
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}
