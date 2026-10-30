import { assert, describe, it } from "@effect/vitest";

import { decodeArcStatus } from "./arcStatus.ts";

describe("Arc status", () => {
  it("preserves staged and unstaged changes and both sides of a rename", () => {
    const result = decodeArcStatus({
      status: {
        staged: [{ path: "project/file.txt", status: "modified", type: "file" }],
        changed: [{ path: "project/file.txt", status: "modified", type: "file" }],
        untracked: [{ path: "project/line\nname.txt", status: "untracked", type: "file" }],
        unmerged: [{ path: "project/conflict.txt", status: "conflict", type: "file" }],
      },
    });
    assert.deepEqual(
      result.map((entry) => [entry.path, entry.index, entry.worktree]),
      [
        ["project/file.txt", "modified", "modified"],
        ["project/line\nname.txt", null, "untracked"],
        ["project/conflict.txt", "conflict", "conflict"],
      ],
    );
    const renamed = decodeArcStatus({
      status: {
        staged: [
          {
            path: "project/new.txt",
            orig_path: "project/old.txt",
            status: "renamed",
            type: "file",
          },
        ],
      },
    });
    assert.equal(renamed[0]?.originalPath, "project/old.txt");
  });

  it("rejects malformed native status instead of reporting a clean tree", () => {
    assert.throws(() => decodeArcStatus({ status: { changed: [{ status: "modified" }] } }));
    assert.throws(() => decodeArcStatus({ errors: ["access denied"] }));
    assert.throws(() =>
      decodeArcStatus({
        status: { future_changes: [{ path: "project/file.txt", status: "modified" }] },
      }),
    );
    assert.deepEqual(decodeArcStatus({ status: {} }), []);
  });
});
