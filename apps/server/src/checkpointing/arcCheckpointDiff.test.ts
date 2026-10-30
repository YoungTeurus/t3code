import { assert, describe, it } from "@effect/vitest";
import { normalizeArcCheckpointNumstat } from "./arcCheckpointDiff.ts";

describe("Arc checkpoint numstat", () => {
  it("normalizes additions, deletions and escaped names without fake renames", () => {
    assert.equal(
      normalizeArcCheckpointNumstat("1\t0\t\0/dev/null\0b/project/new\nfile\0"),
      "1\t0\tproject/new\nfile\0",
    );
    assert.equal(
      normalizeArcCheckpointNumstat("0\t1\t\0a/project/deleted\0/dev/null\0"),
      "0\t1\tproject/deleted\0",
    );
    assert.equal(
      normalizeArcCheckpointNumstat("2\t3\t\0a/project/file\0b/project/file\0"),
      "2\t3\tproject/file\0",
    );
    assert.equal(
      normalizeArcCheckpointNumstat("0\t0\t\0a/project/old\0b/project/new\0"),
      "0\t0\t\0project/old\0project/new\0",
    );
  });
});
