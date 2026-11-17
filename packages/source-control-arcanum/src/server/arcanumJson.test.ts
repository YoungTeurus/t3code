import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import * as Json from "./arcanumJson.ts";

const H = (digit: string) => digit.repeat(40);

// Shapes follow recorded Arcanum responses, with invented logins, paths and ids.
const detail = {
  id: 101,
  url: "https://a.yandex-team.ru/review/101",
  summary: "Fix the widget",
  author: { name: "alice" },
  vcs: { arc_repo_name: "arcadia", from_branch: "users/alice/fix", to_branch: "trunk" },
  created_at: "2026-10-30T11:51:31.665921Z",
  updated_at: "2026-10-30T18:09:03.478330Z",
  full_status: "open",
  common_status: "waiting_for_review",
  merge_allowed: false,
  policies: { auto_merge: "disabled" },
  active_diff_set: {
    id: 9001,
    status: "published",
    has_conflicts: false,
    patch_stats: { additions: 575, deletions: 57, size: "M" },
    arc_branch_heads: { from_id: H("1"), to_id: H("2"), merge_id: H("3") },
  },
  // Arcanum ignores the sub-projection and sends the whole review object.
  review: {
    completion_percent: 0,
    review_status: "review_in_progress",
    reviewers: [{ user: { name: "bob" }, action: "comment" }],
    rules: [],
  },
  assignees: [{ name: "carol" }],
};

const decodeDetail = Schema.decodeUnknownSync(Json.ReviewRequest);
const decodePublicComment = Schema.decodeUnknownSync(Json.PublicComment);
const decodeDiffComment = Schema.decodeSync(Json.DiffComment);

describe("Arcanum response schemas", () => {
  it("rejects comment ids that JSON would round before an action addresses them", () => {
    const decode = Schema.decodeSync(Json.envelope(Json.CreatedComment));
    expect(decode('{"data":{"id":9007199254740991}}').data.id).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => decode('{"data":{"id":9223372036854775807}}')).toThrow();
  });
  it("reads a pull request whose projection came back, ignoring fields it did not ask for", () => {
    const pull = decodeDetail(detail);
    expect(pull.active_diff_set?.arc_branch_heads?.merge_id).toBe(H("3"));
    expect(pull.review?.review_status).toBe("review_in_progress");
  });

  it("fails when Arcanum silently drops a field every pull request carries", () => {
    for (const key of ["vcs", "full_status", "updated_at", "author"] as const) {
      const { [key]: _dropped, ...rest } = detail;
      expect(() => decodeDetail(rest), key).toThrow();
    }
    expect(() =>
      decodeDetail({ ...detail, active_diff_set: { ...detail.active_diff_set, id: undefined } }),
    ).toThrow();
  });

  it("requires the status of every check a pull request read projects", () => {
    const check = { system: "CI", type: "build", required: true, status: "success" };
    expect(decodeDetail({ ...detail, checks: [check] }).checks).toHaveLength(1);
    const { status: _dropped, ...withoutStatus } = check;
    expect(() => decodeDetail({ ...detail, checks: [withoutStatus] })).toThrow();
  });
});

describe("Arcanum states", () => {
  it("maps lifecycle, review and readiness without treating unknown as passing", () => {
    expect(Json.pullRequestState("merged")).toBe("merged");
    expect(Json.pullRequestState("discarded")).toBe("closed");
    expect(Json.pullRequestState("merge_failed")).toBe("open");
    expect(Json.reviewDecision("review_completed")).toBe("approved");
    expect(Json.reviewDecision("waiting_for_changes")).toBe("changes-requested");
    expect(Json.reviewDecision("turned_off_for_merge")).toBeNull();
    expect(Json.reviewDecision("something_new")).toBeUndefined();
    expect(Json.checksStateOfPull({})).toBeUndefined();
    expect(Json.mergeability({ full_status: "open" })).toBe("unknown");
    expect(Json.mergeability({ full_status: "conflicts" })).toBe("conflicting");
  });

  it("rolls up only required CI checks, leaving approval to review", () => {
    const approval = { system: "arcanum", type: "approved", required: true, status: "pending" };
    const build = { system: "CI", type: "build", required: true, status: "unknown" };
    const optional = [
      { system: "CI", type: "lint", required: false, status: "error" },
      { system: "CI", type: "tests", status: "brand_new" },
    ];
    const checks = Json.toChecks([approval, build, ...optional], false);
    // A check not reported yet is queued, and a status this version does not know still runs.
    expect(checks.map((check) => [check.name, check.status])).toEqual([
      ["CI: build", "queued"],
      ["CI: lint", "failure"],
      ["CI: tests", "pending"],
    ]);
    expect(checks.some((check) => check.actions !== undefined)).toBe(false);
    expect(Json.checksStateOf(checks)).toBe("pending");
    // Waiting for approval and failing optional checks leave finished CI green.
    expect(
      Json.checksStateOfPull({ checks: [approval, { ...build, status: "skipped" }, ...optional] }),
    ).toBe("passing");
    expect(Json.checksStateOfPull({ checks: [approval, ...optional] })).toBeNull();
    expect(
      Json.checksStateOfPull({
        checks: [
          { ...build, status: "error" },
          { ...build, type: "x" },
        ],
      }),
    ).toBe("failing");
  });

  it("takes CI links from the checks pages by check", () => {
    const links = Json.checkLinksOf([
      {
        checks: [
          { key: { system: "CI", type: "build" }, uri: " https://ci/build " },
          { key: { system: "CI", type: "lint" }, uri: "" },
        ],
      },
    ]);
    const checks = Json.toChecks(
      [
        { system: "CI", type: "build", required: true, status: "success" },
        { system: "CI", type: "lint", required: true, status: "success" },
      ],
      false,
      links,
    );
    expect(checks.map((check) => check.url)).toEqual(["https://ci/build", null]);
  });
});

describe("Arcanum conversation", () => {
  const pullRequestUrl = "https://a.yandex-team.ru/review/101";
  const inlineRoot = {
    id: 501,
    user: { name: "robot-reviewer" },
    content: "Check the bound",
    created_at: "2026-10-30T13:51:49.084796Z",
    published_at: "2026-10-30T13:51:49.264365Z",
    issue_status: "resolved",
    reactions: [
      { code: ":+1:", user: { name: "alice" } },
      { code: ":goose:", user: { name: "bob" } },
      { code: ":smile:", user: { name: "bob" } },
      { code: ":laughing:", user: { name: "carol" } },
    ],
    anchor: {
      review_request: {
        id: 101,
        diff: {
          diff_set_xid: "9000",
          file: {
            entry_id: {
              content_id_before: { path: "src/a.ts" },
              content_id_after: { path: "src/a.ts" },
            },
            position: { side: "new", line: 92, size: 5 },
          },
        },
      },
    },
  };
  // Replies carry no anchor in the full list and inherit their root's.
  const reply = (id: number, parent: number, author: string, at: string) => ({
    id,
    user: { name: author },
    content: `reply ${id}`,
    created_at: at,
    reply_to_id: parent,
    anchor: { review_request: { id: 101 } },
  });
  const outdatedRoot = {
    ...inlineRoot,
    id: 502,
    issue_status: "open",
    reactions: [],
    anchor: {
      review_request: {
        id: 101,
        diff: {
          diff_set_xid: "8999",
          file: {
            entry_id: { content_id_before: { path: "src/gone.ts" } },
            position: { side: "old", line: 7, size: 1 },
          },
        },
      },
    },
  };
  const all = [
    { id: -20, user: { name: "bob" }, content: "Top", created_at: "2026-10-30T11:00:00Z" },
    reply(-21, -20, "alice", "2026-10-30T11:05:00Z"),
    {
      id: -22,
      user: { name: "alice" },
      content: "secret draft",
      created_at: "2026-10-30T11:06:00Z",
      draft: true,
    },
    inlineRoot,
    reply(601, 501, "alice", "2026-10-30T14:04:50Z"),
    reply(602, 601, "bob", "2026-10-30T14:10:00Z"),
    { ...reply(603, 501, "carol", "2026-10-30T14:20:00Z"), deleted_at: "2026-10-30T14:30:00Z" },
    outdatedRoot,
    { ...outdatedRoot, id: 503, user: { name: "alice" }, issue_status: "dropped" },
    {
      id: -30,
      user: { name: "alice" },
      content: "Why a new dependency?",
      created_at: "2026-10-30T12:00:00Z",
      issue_status: "open",
    },
    reply(-31, -30, "bob", "2026-10-30T12:10:00Z"),
  ].map((comment) => decodePublicComment(comment));
  // The active iteration re-anchors the live root to line 132, collapsing its range to size 0.
  const active = [
    {
      id: 501,
      author: { name: "robot-reviewer" },
      content: "Check the bound",
      created_at: inlineRoot.created_at,
      is_draft: false,
      issue_status: "resolved",
      reactions: inlineRoot.reactions,
      anchor: {
        diff_id: 9001,
        entry_id: "eid:1:opaque",
        source_path: "src/a.ts",
        destination_path: "src/a.ts",
        line: 132,
        size: 0,
        side: "new",
      },
    },
  ].map((comment) => decodeDiffComment(comment));

  const activity = Json.toActivity({ all, active, viewer: "alice", pullRequestUrl });

  it("keeps PR-level remarks flat, each naming its thread, without drafts", () => {
    expect(activity.comments.map((comment) => [comment.id, comment.threadId])).toEqual([
      ["-20", "-20"],
      ["-21", "-20"],
      ["-30", "-30"],
      ["-31", "-30"],
    ]);
    expect(activity.comments[1]).toMatchObject({ kind: "issue-comment", canEdit: true });
    expect(activity.comments[0]).not.toHaveProperty("issueState");
  });

  it("carries a PR-level issue's state on the comment that raised it", () => {
    const [issue, answer] = activity.comments.slice(2);
    expect(issue).toMatchObject({ issueState: "open", canResolve: true });
    expect(answer).not.toHaveProperty("issueState");
  });

  it("tells a dropped issue from a resolved one, and lets anyone change it", () => {
    expect(activity.reviewThreads.find((thread) => thread.id === "503")).toMatchObject({
      issueState: "dropped",
      isResolved: true,
      canResolve: true,
    });
    expect(activity.reviewThreads.find((thread) => thread.id === "502")).toMatchObject({
      issueState: "open",
      canResolve: true,
    });
  });

  it("threads nested replies under their root and anchors live threads in the active iteration", () => {
    const live = activity.reviewThreads.find((thread) => thread.id === "501");
    expect(live).toMatchObject({
      path: "src/a.ts",
      line: 132,
      side: "right",
      isResolved: true,
      isOutdated: false,
      issueState: "resolved",
      canResolve: true,
    });
    expect(live?.comments.map((comment) => comment.id)).toEqual(["501", "601", "602"]);
    expect(live?.comments[0]?.reactions).toEqual([
      { content: "thumbs-up", count: 1, actors: [], viewerHasReacted: true },
      { content: "laugh", count: 2, actors: ["bob", "carol"], viewerHasReacted: false },
    ]);
    expect(activity.threadDiffIds.get("501")).toBe(9001);
  });

  it("marks a thread outdated when its root did not carry over, at the line it was written on", () => {
    expect(activity.reviewThreads.find((thread) => thread.id === "502")).toMatchObject({
      path: "src/gone.ts",
      line: 7,
      side: "left",
      isOutdated: true,
      isResolved: false,
    });
  });

  it("keeps file-level threads and replies when Arcanum reports line -1", () => {
    const root = decodePublicComment({
      ...outdatedRoot,
      anchor: {
        review_request: {
          diff: {
            diff_set_xid: "8999",
            file: {
              entry_id: { content_id_after: { path: "src/file.ts" } },
              position: { side: "new", line: -1 },
            },
          },
        },
      },
    });
    const answer = decodePublicComment(reply(604, root.id, "alice", "2026-10-30T14:40:00Z"));
    const reanchored = decodeDiffComment({
      id: root.id,
      author: root.user,
      content: root.content,
      created_at: root.created_at,
      anchor: { diff_id: 9001, destination_path: "src/file.ts", line: -1, side: "new" },
    });
    for (const active of [[], [reanchored]]) {
      const result = Json.toActivity({
        all: [root, answer],
        active,
        viewer: "alice",
        pullRequestUrl,
      });
      expect(result.reviewThreads).toMatchObject([
        { path: "src/file.ts", line: null, isOutdated: active.length === 0, commentCount: 2 },
      ]);
      expect(result.reviewThreads[0]?.comments.map((comment) => comment.id)).toEqual([
        "502",
        "604",
      ]);
    }
  });
});

describe("changelist entries", () => {
  it("drops directories and names a move's source as the old path", () => {
    const entries = [
      { path: "a", entry_id: "e1", change_type: "modify", node_type: "dir" },
      {
        path: "a/b.ts",
        entry_id: "e2",
        change_type: "move",
        node_type: "file",
        source: { path: "old/b.ts" },
      },
      { path: "a/c.ts", entry_id: "e3", change_type: "delete", node_type: "file" },
    ];
    const files = Json.changelistFiles(entries);
    expect(files.map((file) => file.entry_id)).toEqual(["e2", "e3"]);
    expect(files.map(Json.previousPathOf)).toEqual(["old/b.ts", null]);
  });
});
