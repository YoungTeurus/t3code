import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { planThreadUndo } from "./threadUndo.ts";

describe("dependency undo", () => {
  it("restores the previous wait when settling or replacing its snooze", () => {
    const dependency = {
      targetThreadId: ThreadId.make("target"),
      until: "settled" as const,
      visibility: "visible" as const,
      dependencyId: "old",
    };
    expect(planThreadUndo("settle", { snoozeDependency: dependency })).toEqual([
      { action: "restore-dependency", dependency },
    ]);
    expect(planThreadUndo("snooze", { snoozeDependency: dependency })).toEqual([
      { action: "restore-dependency", dependency },
    ]);
    expect(planThreadUndo("snooze")).toEqual([{ action: "unsnooze" }]);
  });
});
