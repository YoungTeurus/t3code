import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
  RunId,
  ScheduledTaskId,
  ServerSettings,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

type QueueProjection = {
  readonly runs: ReadonlyArray<
    Pick<OrchestrationV2Run, "id" | "userMessageId" | "status" | "ordinal" | "requestedAt">
  >;
  readonly messages: ReadonlyArray<
    Pick<OrchestrationV2ConversationMessage, "id" | "scheduledTaskId">
  >;
};

export function scheduledQueueAdmission(
  projection: QueueProjection,
  taskId: ScheduledTaskId,
  settings: Pick<
    ServerSettings,
    "scheduledTaskQueueLimit" | "scheduledThreadQueueLimit" | "scheduledQueueOverflow"
  >,
): { readonly skip: boolean; readonly cancelRunIds: ReadonlyArray<RunId> } {
  const tasksByMessage = new Map(
    projection.messages.flatMap((message) =>
      message.scheduledTaskId === undefined ? [] : [[message.id, message.scheduledTaskId] as const],
    ),
  );
  const queued = projection.runs
    .filter((run) => run.status === "queued" && tasksByMessage.has(run.userMessageId))
    .toSorted(
      (a, b) =>
        DateTime.toEpochMillis(a.requestedAt) - DateTime.toEpochMillis(b.requestedAt) ||
        a.ordinal - b.ordinal,
    );
  const sameTask = queued.filter((run) => tasksByMessage.get(run.userMessageId) === taskId);
  const taskExcess =
    settings.scheduledTaskQueueLimit === null
      ? 0
      : Math.max(0, sameTask.length + 1 - settings.scheduledTaskQueueLimit);
  const threadExcess =
    settings.scheduledThreadQueueLimit === null
      ? 0
      : Math.max(0, queued.length + 1 - settings.scheduledThreadQueueLimit);
  if (settings.scheduledQueueOverflow === "skip_new")
    return { skip: taskExcess > 0 || threadExcess > 0, cancelRunIds: [] };
  const cancelled = new Set(sameTask.slice(0, taskExcess).map((run) => run.id));
  for (const run of queued) {
    if (cancelled.size >= threadExcess) break;
    cancelled.add(run.id);
  }
  return { skip: false, cancelRunIds: [...cancelled] };
}
