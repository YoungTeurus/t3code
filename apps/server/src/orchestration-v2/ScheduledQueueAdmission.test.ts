import { describe, expect, it } from "@effect/vitest";
import { MessageId, RunId, ScheduledTaskId, type ServerSettings } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { scheduledQueueAdmission } from "./ScheduledQueueAdmission.ts";

const task = ScheduledTaskId.make("task:a");
const other = ScheduledTaskId.make("task:b");
const defaults: Pick<
  ServerSettings,
  "scheduledTaskQueueLimit" | "scheduledThreadQueueLimit" | "scheduledQueueOverflow"
> = {
  scheduledTaskQueueLimit: 1,
  scheduledThreadQueueLimit: 3,
  scheduledQueueOverflow: "replace_oldest" as const,
};
const queued = (
  id: number,
  scheduledTaskId: ScheduledTaskId | undefined = task,
  status: "queued" | "running" = "queued",
  queuePosition = id,
) => ({
  run: {
    id: RunId.make(`run:${id}`),
    userMessageId: MessageId.make(`message:${id}`),
    status,
    ordinal: id,
    queuePosition,
    requestedAt: DateTime.makeUnsafe(id * 1000),
  },
  message: {
    id: MessageId.make(`message:${id}`),
    ...(scheduledTaskId === undefined ? {} : { scheduledTaskId }),
  },
});
const admission = (entries: ReturnType<typeof queued>[], settings = defaults) =>
  scheduledQueueAdmission(
    { runs: entries.map(({ run }) => run), messages: entries.map(({ message }) => message) },
    task,
    settings,
  );

describe("scheduled queue admission", () => {
  it("replaces the oldest scheduled message while protecting manual and executing runs", () => {
    const manual = queued(2);
    delete manual.message.scheduledTaskId;
    expect(
      admission([
        queued(1, task, "running"),
        manual,
        queued(3, task, "queued", 99),
        queued(4, task, "queued", 1),
      ]),
    ).toEqual({ skip: false, cancelRunIds: [RunId.make("run:3"), RunId.make("run:4")] });
  });
  it("trims legacy backlog to both limits at the next arrival", () => {
    expect(
      admission([queued(1), queued(2), queued(3, other), queued(4, other), queued(5, other)]),
    ).toEqual({
      skip: false,
      cancelRunIds: [RunId.make("run:1"), RunId.make("run:2"), RunId.make("run:3")],
    });
  });
  it("skips new messages without deleting the backlog", () => {
    expect(
      admission([queued(1), queued(2)], { ...defaults, scheduledQueueOverflow: "skip_new" }),
    ).toEqual({ skip: true, cancelRunIds: [] });
  });
  it("supports independent unlimited limits", () => {
    const entries = [queued(1), queued(2), queued(3, other)];
    expect(
      admission(entries, {
        ...defaults,
        scheduledTaskQueueLimit: null,
        scheduledThreadQueueLimit: null,
      }),
    ).toEqual({ skip: false, cancelRunIds: [] });
    expect(admission(entries, { ...defaults, scheduledTaskQueueLimit: null })).toEqual({
      skip: false,
      cancelRunIds: [RunId.make("run:1")],
    });
    expect(admission(entries, { ...defaults, scheduledThreadQueueLimit: null })).toEqual({
      skip: false,
      cancelRunIds: [RunId.make("run:1"), RunId.make("run:2")],
    });
  });
});
