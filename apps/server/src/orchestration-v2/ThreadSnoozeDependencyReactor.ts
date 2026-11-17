import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { forkParked } from "../serverActivation.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";

export class ThreadSnoozeDependencyReactor extends Context.Service<
  ThreadSnoozeDependencyReactor,
  {
    readonly drain: () => Effect.Effect<void, SqlError | Orchestrator.OrchestratorV2Error>;
    readonly start: () => Effect.Effect<void, never, import("effect/Scope").Scope>;
  }
>()("t3/orchestration-v2/ThreadSnoozeDependencyReactor") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const events = yield* EventSink.EventSinkV2;
  const lock = yield* Semaphore.make(1);

  const drain = Effect.fn("ThreadSnoozeDependencyReactor.drain")(function* () {
    while (true) {
      const cursor = (yield* sql<{
        readonly sequence: number;
        readonly after_thread_id: string | null;
      }>`
        SELECT sequence, after_thread_id FROM thread_snooze_transition_cursor WHERE id = 1
      `)[0]!;
      const transition = (yield* sql<{
        readonly sequence: number;
        readonly target_thread_id: string;
        readonly kind: "settled" | "completed" | "archived" | "deleted" | "attention";
      }>`
        SELECT sequence, target_thread_id, kind FROM thread_snooze_transitions
        WHERE sequence > ${cursor.sequence} ORDER BY sequence LIMIT 1
      `)[0];
      if (transition === undefined) return;
      const dependencies = yield* sql<{
        readonly thread_id: string;
        readonly dependency_id: string;
      }>`
        SELECT thread_id, dependency_id FROM thread_snooze_dependencies
        WHERE ((target_thread_id = ${transition.target_thread_id} AND ${transition.kind} != 'attention')
          OR (thread_id = ${transition.target_thread_id} AND ${transition.kind} = 'attention' AND visibility = 'hidden'))
          AND start_sequence < ${transition.sequence}
          AND (${transition.kind} != 'attention' OR visibility_sequence < ${transition.sequence})
          AND (until_kind = ${transition.kind} OR ${transition.kind} IN ('archived', 'deleted', 'attention'))
          AND (${cursor.after_thread_id} IS NULL OR thread_id > ${cursor.after_thread_id})
        ORDER BY thread_id LIMIT 64
      `;
      for (const dependency of dependencies) {
        const commandId = CommandId.make(
          `snooze-resolve:${transition.sequence}:${dependency.dependency_id}`,
        );
        const result = yield* orchestrator
          .dispatch(
            transition.kind === "attention"
              ? {
                  type: "thread.snooze-dependency.show",
                  commandId,
                  threadId: ThreadId.make(dependency.thread_id),
                  dependencyId: dependency.dependency_id,
                  attentionSequence: transition.sequence,
                }
              : {
                  type: "thread.snooze-dependency.resolve",
                  commandId,
                  threadId: ThreadId.make(dependency.thread_id),
                  dependencyId: dependency.dependency_id,
                  targetThreadId: ThreadId.make(transition.target_thread_id),
                  reason: transition.kind,
                },
          )
          .pipe(Effect.result);
        if (Result.isFailure(result)) {
          const remaining = yield* sql`
            SELECT 1 FROM thread_snooze_dependencies
            WHERE thread_id = ${dependency.thread_id} AND dependency_id = ${dependency.dependency_id}
              AND (${transition.kind} != 'attention' OR visibility_sequence < ${transition.sequence})
          `;
          if (remaining.length > 0) return yield* result.failure;
        }
        yield* sql`UPDATE thread_snooze_transition_cursor SET after_thread_id = ${dependency.thread_id} WHERE id = 1`;
      }
      if (dependencies.length < 64) {
        yield* sql`UPDATE thread_snooze_transition_cursor SET sequence = ${transition.sequence}, after_thread_id = NULL WHERE id = 1`;
        yield* sql`
          DELETE FROM thread_snooze_transitions WHERE sequence IN (
            SELECT t.sequence FROM thread_snooze_transitions t
            WHERE t.sequence <= ${transition.sequence}
              AND NOT EXISTS (
                SELECT 1 FROM thread_snooze_undo u
                WHERE u.target_thread_id = t.target_thread_id AND u.start_sequence < t.sequence
                  AND (u.until_kind = t.kind OR t.kind IN ('archived', 'deleted'))
                  AND NOT EXISTS (
                    SELECT 1 FROM thread_snooze_transitions earlier
                    WHERE earlier.target_thread_id = t.target_thread_id
                      AND earlier.sequence > u.start_sequence AND earlier.sequence < t.sequence
                      AND (earlier.kind = u.until_kind OR earlier.kind IN ('archived', 'deleted'))
                  )
              )
            ORDER BY t.sequence LIMIT 256
          )
        `;
      }
    }
  }, lock.withPermit);

  return ThreadSnoozeDependencyReactor.of({
    drain,
    start: Effect.fn("ThreadSnoozeDependencyReactor.start")(function* () {
      yield* forkParked(
        drain().pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("snooze dependency recovery failed", { cause }),
          ),
          Effect.repeat(Schedule.spaced("1 minute")),
          Effect.asVoid,
        ),
      );
      yield* forkParked(
        Effect.gen(function* () {
          const afterSequence = yield* events.latestSequence();
          yield* drain();
          yield* events.stream({ afterSequence }).pipe(
            Stream.runForEach((stored) => {
              switch (stored.event.type) {
                case "thread.settled":
                case "thread.archived":
                case "thread.deleted":
                case "run.updated":
                case "runtime-request.updated":
                case "thread.guest-share-updated":
                case "thread.metadata-updated":
                  return drain();
                default:
                  return Effect.void;
              }
            }),
          );
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("snooze dependency reactor failed", { cause }),
          ),
        ),
      );
    }),
  });
});

export const layer = Layer.effect(ThreadSnoozeDependencyReactor, make);
