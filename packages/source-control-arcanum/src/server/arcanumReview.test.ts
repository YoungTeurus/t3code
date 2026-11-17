import { describe, expect, it } from "@effect/vitest";

import type * as Json from "./arcanumJson.ts";
import {
  reviewStatusOf,
  unavailableReason,
  verdictsOf,
  type ReviewViewer,
} from "./arcanumReview.ts";

const pull = (overrides: Partial<Json.ReviewRequest> = {}): Json.ReviewRequest => ({
  id: 7,
  url: "https://a.yandex-team.ru/review/7",
  summary: "Fix",
  author: { name: "author" },
  vcs: { arc_repo_name: "arcadia", from_branch: "users/author/fix", to_branch: "trunk" },
  created_at: "2026-10-30T11:51:31Z",
  updated_at: "2026-10-30T11:51:31Z",
  full_status: "open",
  common_status: "waiting_for_review",
  outstaff: false,
  caps: { disable_sticky_ships: false },
  active_diff_set: { id: 3, status: "published" },
  review: { review_status: "review_in_progress", reviewers: [] },
  ...overrides,
});
const viewer: ReviewViewer = { login: "viewer", account: { outstaff: false, banned: false } };
const voted = (action: string) =>
  pull({ review: { reviewers: [{ user: { name: "Viewer" }, action }] } });
const available = (status: ReturnType<typeof reviewStatusOf>) =>
  status.actions.filter((action) => action.available).map((action) => action.id);

describe("Arcanum review decisions", () => {
  it("offers setting decisions on an open published iteration and withdrawing only one's own", () => {
    expect(verdictsOf(pull(), viewer)).toEqual(["comment", "approve", "request-changes"]);
    expect(available(reviewStatusOf(pull(), viewer))).toEqual(["sticky-ship", "block-merge"]);
    expect(available(reviewStatusOf(voted("sticky_ship"), viewer))).toEqual([
      "sticky-ship",
      "block-merge",
      "unship",
    ]);
    expect(available(reviewStatusOf(voted("ship"), viewer))).toContain("unship");
    expect(available(reviewStatusOf(voted("waiting_for_changes"), viewer))).toContain(
      "cancel-request-changes",
    );
    expect(available(reviewStatusOf(voted("block_merge"), viewer))).toContain("unblock-merge");
    expect(unavailableReason("unship", pull(), viewer)).toBe("You have no Ship to withdraw.");
  });

  it("lets the author decide on their own pull request, as Arcanum does", () => {
    const author = { ...viewer, login: "author" };
    expect(verdictsOf(pull(), author)).toEqual(["comment", "approve", "request-changes"]);
    expect(available(reviewStatusOf(pull(), author))).toEqual(["sticky-ship", "block-merge"]);
  });

  it("asks for a published iteration before a changes request", () => {
    const draft = pull({ active_diff_set: { id: 3, status: "draft" } });
    expect(verdictsOf(draft, viewer)).toEqual(["comment", "approve"]);
    expect(unavailableReason("request-changes", draft, viewer)).toMatch(/Publish/u);
    for (const status of ["future_status", ""]) {
      const unknown = pull({ active_diff_set: { id: 3, status } });
      expect(unavailableReason("request-changes", unknown, viewer)).toMatch(/did not say/u);
    }
  });

  it("keeps Sticky Ship off for external authors, rules that disable it, and unknown answers", () => {
    for (const changed of [
      pull({ outstaff: true }),
      pull({ caps: { disable_sticky_ships: true } }),
      pull({ outstaff: undefined }),
      pull({ caps: undefined }),
    ]) {
      expect(unavailableReason("sticky-ship", changed, viewer)).not.toBeNull();
      expect(unavailableReason("ship", changed, viewer)).toBeNull();
    }
  });

  it("offers nothing but comments to an account or pull request that cannot take decisions", () => {
    for (const [changed, who] of [
      [pull({ full_status: "merged" }), viewer],
      [pull({ active_diff_set: { id: 3, status: "discarded" } }), viewer],
      [pull({ active_diff_set: undefined }), viewer],
      [pull(), { ...viewer, account: { outstaff: true, banned: false } }],
      [pull(), { ...viewer, account: { outstaff: false, banned: true } }],
      [pull(), { login: "viewer" }],
    ] as const) {
      expect(verdictsOf(changed, who)).toEqual(["comment"]);
      const status = reviewStatusOf(changed, who);
      expect(status.actions.every((action) => !action.available && action.unavailableReason)).toBe(
        true,
      );
    }
  });

  it("reports each reviewer's standing and the completion Arcanum counts", () => {
    const status = reviewStatusOf(
      pull({
        review: {
          completion_percent: 60,
          reviewers: [
            { user: { name: "shipper" }, action: "sticky_ship" },
            { user: { name: "plain" }, action: "ship" },
            { user: { name: "blocker" }, action: "block_merge" },
            { user: { name: "reader" }, action: "comment" },
            { user: { name: "requester" }, action: "waiting_for_changes" },
            { user: { name: "waiting" }, action: "review_in_progress" },
            { action: "ship" },
          ],
        },
        assignees: [{ name: "waiting" }, { name: "assigned" }],
      }),
      viewer,
    );
    expect(status.completionPercent).toBe(60);
    expect(
      status.reviewers.map((reviewer) => [reviewer.actor.login, reviewer.state, reviewer.label]),
    ).toEqual([
      ["shipper", "approved", "Sticky Ship"],
      ["plain", "approved", "Ship"],
      ["blocker", "blocked", undefined],
      ["reader", "commented", undefined],
      ["requester", "changes-requested", undefined],
      ["waiting", "pending", undefined],
      ["assigned", "pending", undefined],
    ]);
    for (const completion_percent of [200, -1, Number.NaN]) {
      expect(reviewStatusOf(pull({ review: { completion_percent } }), viewer)).not.toHaveProperty(
        "completionPercent",
      );
    }
  });
});
