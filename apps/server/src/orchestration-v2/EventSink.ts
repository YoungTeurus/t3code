import {
  CommandId,
  pendingGuestMessageCount,
  type OrchestrationV2Run,
  type ThreadSnoozeDependency,
  OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  OrchestrationV2StoredEvent,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  NodeId,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { replayAndBufferProjectedLiveEvents } from "./LiveStreamBudget.ts";
import type { UnsequencedProjectEvent } from "../persistence/OrchestrationEventStore.ts";
import { projectDomainEventForWire } from "./WireProjection.ts";
import { makeRunOutcomeRecorder, type RunOutcome } from "./RunMetrics.ts";

import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

export class EventSinkWriteError extends Schema.TaggedError<EventSinkWriteError>()(
  "EventSinkWriteError",
  {
    eventCount: Schema.Number,
    commandId: Schema.optional(CommandId),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to write ${this.eventCount} orchestration V2 event(s).`;
  }
}

export class EventSinkStreamError extends Schema.TaggedError<EventSinkStreamError>()(
  "EventSinkStreamError",
  {
    threadId: Schema.optional(ThreadId),
    afterSequence: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.threadId === undefined
      ? "Failed to stream orchestration V2 events."
      : `Failed to stream orchestration V2 events for thread ${this.threadId}.`;
  }
}

export const EventSinkV2Error = Schema.Union([EventSinkWriteError, EventSinkStreamError]);
export type EventSinkV2Error = typeof EventSinkV2Error.Type;

export interface RemoteApprovalCheck {
  readonly parentThreadId: string;
  readonly taskId: string;
  readonly remoteEnvironmentId: string;
  readonly remoteThreadId: string;
  readonly snapshotSequence: number | null;
  readonly lastAttentionSequence: number | null;
  readonly pendingApprovalCount: number | null;
}

export interface EventSinkV2Shape {
  readonly write: (input: {
    /** Return no events if another thread owns this native session at commit time. */
    readonly unlessNativeThreadOwned?: Pick<
      OrchestrationV2ProviderThread,
      "driver" | "providerInstanceId" | "appThreadId" | "nativeThreadRef"
    >;
    readonly guardPendingUserInputCancellations?: boolean;
    readonly commandId?: CommandId;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  }) => Effect.Effect<ReadonlyArray<OrchestrationV2StoredEvent>, EventSinkV2Error>;
  readonly writeWithEffects: (input: {
    /**
     * Rebuilds each run.updated from the stored row with only its delegatedCompletion replaced.
     * The batch must not also change that run's lifecycle.
     */
    readonly updateDelegatedCompletionOnly?: boolean;
    readonly unlessNativeThreadOwned?: Pick<
      OrchestrationV2ProviderThread,
      "driver" | "providerInstanceId" | "appThreadId" | "nativeThreadRef"
    >;
    readonly guardPendingUserInputCancellations?: boolean;
    readonly commandId?: CommandId;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
    readonly effects: ReadonlyArray<EffectOutbox.PendingOrchestrationEffectV2>;
  }) => Effect.Effect<ReadonlyArray<OrchestrationV2StoredEvent>, EventSinkV2Error>;
  readonly writeIfRunCurrent: (input: {
    readonly guardPendingUserInputCancellations?: boolean;
    readonly commandId?: CommandId;
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly activeAttemptId: RunAttemptId;
    readonly expectedStatus: OrchestrationV2Run["status"];
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
    readonly effects?: ReadonlyArray<EffectOutbox.PendingOrchestrationEffectV2>;
  }) => Effect.Effect<
    {
      readonly committed: boolean;
      readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
    },
    EventSinkV2Error
  >;
  /** Commits only if the expected attempt and ordinal still own the provider thread, protecting newer attempts. */
  readonly writeIfProviderThreadOwner: (input: {
    readonly guardPendingUserInputCancellations?: boolean;
    readonly commandId?: CommandId;
    readonly providerThreadId: ProviderThreadId;
    readonly runId: RunId;
    readonly activeAttemptId: RunAttemptId;
    readonly expectedLastRunOrdinal: number;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  }) => Effect.Effect<
    {
      readonly committed: boolean;
      readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
    },
    EventSinkV2Error
  >;
  /** Commits only if the full provider row equals expected; some writers do not advance updatedAt. */
  readonly writeIfProviderThreadUnchanged: (input: {
    readonly expected: OrchestrationV2ProviderThread;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  }) => Effect.Effect<
    {
      readonly committed: boolean;
      readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
    },
    EventSinkV2Error
  >;
  readonly commitCommand: (input: {
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
    readonly commandType: string;
    readonly snoozeDependency?: {
      readonly targetThreadId: ThreadId;
      readonly until: "settled" | "completed";
      readonly preserveDependencyId?: string | undefined;
    };
    readonly resolveSnoozeDependencyId?: string;
    readonly showSnoozeDependencyId?: string;
    readonly attentionSequence?: number;
    readonly expectedSnoozeDependencyId?: string;
    readonly expectedThreadSequence?: number;
    readonly remoteApprovalChecks?: ReadonlyArray<RemoteApprovalCheck>;
    readonly undoSnoozeDependency?: ThreadSnoozeDependency;
    readonly undoExpectedCommandId?: CommandId;
    readonly remoteApprovalObservation?: {
      readonly taskId: string;
      readonly remoteEnvironmentId: string;
      readonly remoteThreadId: string;
      readonly snapshotSequence: number;
      readonly lastAttentionSequence: number;
      readonly pendingApprovalCount: number;
      readonly unavailable?: boolean | undefined;
    };
    readonly cancelSnoozeDependency?: boolean;
    readonly acceptedAt: DateTime.Utc;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
    readonly effects: ReadonlyArray<EffectOutbox.PendingOrchestrationEffectV2>;
    readonly cancelUnsettledEffects?: {
      readonly effectTypes: ReadonlyArray<EffectOutbox.OrchestrationEffectRequestV2["type"]>;
      readonly reason: string;
    };
    /** Like writeWithEffects' updateDelegatedCompletionOnly, for this run's run.updated only. */
    readonly updateDelegatedCompletionOnlyRunId?: RunId;
  }) => Effect.Effect<
    {
      readonly receipt: CommandReceiptStore.CommandReceiptV2;
      readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
      readonly committed: boolean;
      readonly cancelledEffectCount: number;
    },
    EventSinkV2Error
  >;
  readonly commitRejectedCommand: (input: {
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
    readonly commandType: string;
    readonly rejectedAt: DateTime.Utc;
    readonly error: string;
  }) => Effect.Effect<CommandReceiptStore.CommandReceiptV2, EventSinkV2Error>;
  readonly commitProjectCommand: (input: {
    readonly commandId: CommandId;
    readonly projectId: ProjectId;
    readonly commandType: string;
    readonly acceptedAt: DateTime.Utc;
    readonly event: UnsequencedProjectEvent;
  }) => Effect.Effect<
    { readonly receipt: CommandReceiptStore.ProjectCommandReceiptV2; readonly committed: boolean },
    EventSinkV2Error
  >;
  readonly commitRejectedProjectCommand: (input: {
    readonly commandId: CommandId;
    readonly projectId: ProjectId;
    readonly commandType: string;
    readonly rejectedAt: DateTime.Utc;
    readonly error: string;
  }) => Effect.Effect<CommandReceiptStore.ProjectCommandReceiptV2, EventSinkV2Error>;
  readonly stream: (input?: {
    readonly threadId?: ThreadId;
    readonly afterSequence?: number;
    readonly eventType?: OrchestrationV2DomainEvent["type"];
    /** Bound RPC subscribers; internal workers must not drop their subscription under load. */
    readonly bounded?: boolean;
  }) => Stream.Stream<OrchestrationV2StoredEvent, EventSinkV2Error>;
  readonly latestSequence: (input?: {
    readonly threadId?: ThreadId;
  }) => Effect.Effect<number, EventSinkV2Error>;
  readonly approvalAttention: (threadId: ThreadId) => Effect.Effect<
    {
      readonly version: 1;
      readonly snapshotSequence: number;
      readonly lastAttentionSequence: number;
      readonly pendingApprovalCount: number;
      readonly available: boolean;
    },
    EventSinkV2Error
  >;
  readonly remoteApprovalObservation: (
    threadId: ThreadId,
    taskId: NodeId,
  ) => Effect.Effect<
    {
      readonly snapshotSequence: number;
      readonly lastAttentionSequence: number;
      readonly pendingApprovalCount: number;
    } | null,
    EventSinkV2Error
  >;
  readonly remoteApprovalTasks: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<RemoteApprovalCheck>, EventSinkV2Error>;
  readonly readByCommandId: (input: {
    readonly commandId: CommandId;
  }) => Stream.Stream<OrchestrationV2StoredEvent, EventSinkV2Error>;
}

export class EventSinkV2 extends Context.Service<EventSinkV2, EventSinkV2Shape>()(
  "t3/orchestration-v2/EventSink/EventSinkV2",
) {}

const layerBase: Layer.Layer<
  EventSinkV2,
  never,
  | CommandReceiptStore.CommandReceiptStoreV2
  | EffectOutbox.EffectOutboxV2
  | EventStore.EventStoreV2
  | ProjectionStore.ProjectionStoreV2
  | ProjectStore.ProjectStoreV2
  | SqlClient.SqlClient
  | TurnItemPositionStore.TurnItemPositionStoreV2
> = Layer.effect(
  EventSinkV2,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const commandReceipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
    const effectOutbox = yield* EffectOutbox.EffectOutboxV2;
    const eventStore = yield* EventStore.EventStoreV2;
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const projectStore = yield* ProjectStore.ProjectStoreV2;
    const turnItemPositions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
    const liveEvents = yield* PubSub.unbounded<OrchestrationV2StoredEvent>();
    const liveEventsByType = new Map<
      OrchestrationV2DomainEvent["type"],
      PubSub.PubSub<OrchestrationV2StoredEvent>
    >();
    const publishLiveEvents =
      /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
      Effect.fnUntraced(function* (events: ReadonlyArray<OrchestrationV2StoredEvent>) {
        yield* PubSub.publishAll(liveEvents, events);
        for (const [type, pubsub] of liveEventsByType) {
          yield* PubSub.publishAll(
            pubsub,
            events.filter((stored) => stored.event.type === type),
          );
        }
      });
    const runOutcomes = makeRunOutcomeRecorder((threadId) =>
      // One payload row; unlike the shell, it still resolves a deleted child thread.
      projectionStore
        .getThread(threadId)
        .pipe(Effect.map((thread) => thread.lineage.relationshipToParent === "subagent")),
    );
    // Recorded before publication, so an interrupted publish cannot lose a committed outcome.
    const publishStoredEvents = (
      events: ReadonlyArray<OrchestrationV2StoredEvent>,
      outcomes: ReadonlyArray<RunOutcome>,
    ) =>
      runOutcomes
        .record(outcomes)
        .pipe(
          Effect.andThen(eventStore.publishCommitted(events)),
          Effect.andThen(publishLiveEvents(events)),
        );

    // Serialize commit and publish; reordered publication makes clients drop earlier sequences.
    const publishLane = yield* Semaphore.make(1);
    const commitThenPublish = <A, E, R>(
      transaction: Effect.Effect<A, E, R>,
      publish: (committed: A) => Effect.Effect<void>,
    ) =>
      Effect.uninterruptibleMask((restore) => {
        let holdsLane = false;
        const takeLane = publishLane.take(1).pipe(
          Effect.andThen(
            Effect.sync(() => {
              holdsLane = true;
            }),
          ),
          Effect.uninterruptible,
        );
        // Cancellation may roll back the transaction's work. Once it commits,
        // every subscriber must hear about it before this writer can exit.
        // Otherwise a failed child run can leave its parent's task running.
        return sql
          .withTransaction(Effect.tap(restore(transaction), () => takeLane))
          .pipe(
            Effect.tap(publish),
            Effect.ensuring(
              Effect.suspend(() => (holdsLane ? publishLane.release(1) : Effect.void)),
            ),
          );
      });

    // A user can answer after terminal normalization reads the pending request.
    // Recheck inside the write transaction so stale cleanup cannot erase answers.
    const guardUserInputCancellations =
      /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
      Effect.fnUntraced(function* (events: ReadonlyArray<OrchestrationV2DomainEvent>) {
        const staleRequests = new Set<RuntimeRequestId>();
        const staleNodes = new Set<NodeId>();
        for (const event of events) {
          if (
            event.type !== "runtime-request.updated" ||
            event.payload.kind !== "user_input" ||
            event.payload.status !== "cancelled"
          )
            continue;
          const current = yield* projectionStore.getRuntimeRequest(
            event.threadId,
            event.payload.id,
          );
          if (
            current?.status !== "pending" ||
            current.kind !== "user_input" ||
            current.providerTurnId !== event.payload.providerTurnId ||
            current.responseCapability.type === "message"
          ) {
            staleRequests.add(event.payload.id);
            staleNodes.add(event.payload.nodeId);
          }
        }
        return events.filter((event) => {
          switch (event.type) {
            case "runtime-request.updated":
              return event.payload.status !== "cancelled" || !staleRequests.has(event.payload.id);
            case "node.updated":
              return event.payload.status !== "cancelled" || !staleNodes.has(event.payload.id);
            case "turn-item.updated":
              return (
                event.payload.type !== "user_input_request" ||
                event.payload.status !== "cancelled" ||
                !staleRequests.has(event.payload.requestId)
              );
            default:
              return true;
          }
        });
      });

    const normalizeEvents = (events: ReadonlyArray<OrchestrationV2DomainEvent>) => {
      const runOrdinals = new Map(
        events.flatMap((event) =>
          event.type === "run.created" || event.type === "run.updated"
            ? [[event.payload.id, event.payload.ordinal] as const]
            : [],
        ),
      );
      return Effect.forEach(
        events,
        (event): Effect.Effect<OrchestrationV2DomainEvent, unknown> =>
          event.type === "turn-item.updated"
            ? turnItemPositions
                .normalize(
                  event.payload,
                  event.payload.runId === null ? undefined : runOrdinals.get(event.payload.runId),
                )
                .pipe(Effect.map((payload) => ({ ...event, payload })))
            : Effect.succeed(event),
        { concurrency: 1 },
      );
    };

    const applyStoredEvents =
      /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
      Effect.fnUntraced(function* (storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>) {
        yield* Effect.forEach(
          storedEvents,
          (stored) =>
            Effect.gen(function* () {
              const event = stored.event;
              let kind: "settled" | "completed" | "archived" | "deleted" | "attention" | null =
                null;
              if (event.type === "run.updated" && event.payload.status === "completed") {
                const previous = yield* sql<{ readonly status: string }>`
              SELECT status FROM orchestration_v2_projection_runs WHERE run_id = ${event.payload.id}
            `;
                if (
                  previous[0] !== undefined &&
                  ["queued", "preparing", "starting", "running", "waiting"].includes(
                    previous[0].status,
                  )
                ) {
                  kind = "completed";
                }
              } else if (event.type === "thread.settled") {
                const previous = yield* sql<{ readonly settled: string | null }>`
              SELECT json_extract(payload_json, '$.settledOverride') AS settled
              FROM orchestration_v2_projection_threads WHERE thread_id = ${event.threadId}
            `;
                if (previous[0] !== undefined && previous[0].settled !== "settled")
                  kind = "settled";
              } else if (event.type === "thread.archived") {
                kind = "archived";
              } else if (event.type === "thread.deleted") {
                kind = "deleted";
              } else if (
                event.type === "runtime-request.updated" &&
                event.payload.status === "pending" &&
                event.payload.kind !== "dynamic_tool_call" &&
                event.payload.kind !== "auth_refresh"
              ) {
                kind = "attention";
              } else if (
                event.type === "thread.guest-share-updated" &&
                pendingGuestMessageCount(event.payload.guestShare) > 0
              ) {
                kind = "attention";
              } else if (event.type === "run.updated" && event.payload.status === "failed") {
                const previous = yield* sql<{ readonly status: string }>`
              SELECT status FROM orchestration_v2_projection_runs WHERE run_id = ${event.payload.id}
            `;
                if (previous[0] !== undefined && previous[0].status !== "failed")
                  kind = "attention";
              }
              if (kind !== null) {
                yield* sql`
                INSERT OR IGNORE INTO thread_snooze_transitions (target_thread_id, event_id, kind, occurred_at)
                SELECT ${event.threadId}, ${event.id}, ${kind}, ${DateTime.formatIso(event.occurredAt)}
                WHERE (${kind} = 'attention' AND EXISTS (SELECT 1 FROM thread_snooze_dependencies WHERE thread_id = ${event.threadId}))
                   OR (${kind} != 'attention' AND (
                     EXISTS (SELECT 1 FROM thread_snooze_dependencies WHERE target_thread_id = ${event.threadId})
                     OR EXISTS (
                       SELECT 1 FROM thread_snooze_undo u
                       WHERE u.target_thread_id = ${event.threadId}
                         AND (u.until_kind = ${kind} OR ${kind} IN ('archived', 'deleted'))
                         AND NOT EXISTS (
                           SELECT 1 FROM thread_snooze_transitions previous
                           WHERE previous.target_thread_id = u.target_thread_id
                             AND previous.sequence > u.start_sequence
                             AND (previous.kind = u.until_kind OR previous.kind IN ('archived', 'deleted'))
                         )
                     )
                   ))
            `;
              }
              if (
                event.type === "runtime-request.updated" &&
                event.payload.status === "pending" &&
                !["user_input", "auth_refresh", "dynamic_tool_call"].includes(event.payload.kind)
              ) {
                const previous = yield* sql<{ readonly status: string }>`
                  SELECT status FROM orchestration_v2_projection_runtime_requests
                  WHERE runtime_request_id = ${event.payload.id}
                `;
                if (previous[0]?.status !== "pending") {
                  yield* sql`
                    WITH RECURSIVE ancestors(thread_id, path) AS (
                      SELECT thread_id, ',' || thread_id || ','
                      FROM orchestration_v2_projection_threads WHERE thread_id = ${event.threadId}
                      UNION ALL
                      SELECT json_extract(t.payload_json, '$.lineage.parentThreadId'), a.path || t.thread_id || ','
                      FROM ancestors a JOIN orchestration_v2_projection_threads t ON t.thread_id = a.thread_id
                      WHERE json_extract(t.payload_json, '$.lineage.relationshipToParent') = 'subagent'
                        AND json_extract(t.payload_json, '$.creationSource') != 'provider'
                        AND EXISTS (SELECT 1 FROM orchestration_v2_projection_runs run WHERE run.thread_id = t.thread_id AND run.status IN ('preparing', 'starting', 'running', 'waiting'))
                        AND instr(a.path, ',' || json_extract(t.payload_json, '$.lineage.parentThreadId') || ',') = 0
                    )
                    INSERT INTO thread_approval_attention(thread_id, last_attention_sequence)
                    SELECT thread_id, ${stored.sequence} FROM ancestors WHERE thread_id IS NOT NULL
                    ON CONFLICT(thread_id) DO UPDATE SET last_attention_sequence = MAX(last_attention_sequence, excluded.last_attention_sequence)
                  `;
                }
                yield* sql`
                  WITH RECURSIVE ancestors(thread_id, path) AS (
                    SELECT json_extract(payload_json, '$.lineage.parentThreadId'), ',' || thread_id || ','
                    FROM orchestration_v2_projection_threads
                    WHERE thread_id = ${event.threadId}
                      AND json_extract(payload_json, '$.lineage.relationshipToParent') = 'subagent'
                      AND json_extract(payload_json, '$.creationSource') != 'provider'
                      AND EXISTS (SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id = ${event.threadId} AND status IN ('preparing', 'starting', 'running', 'waiting'))
                    UNION ALL
                    SELECT json_extract(t.payload_json, '$.lineage.parentThreadId'), a.path || t.thread_id || ','
                    FROM ancestors a JOIN orchestration_v2_projection_threads t ON t.thread_id = a.thread_id
                    WHERE json_extract(t.payload_json, '$.lineage.relationshipToParent') = 'subagent'
                      AND instr(a.path, ',' || t.thread_id || ',') = 0
                  )
                  INSERT OR IGNORE INTO thread_snooze_transitions(target_thread_id, event_id, kind, occurred_at)
                  SELECT a.thread_id, ${event.id} || ':ancestor:' || a.thread_id, 'attention', ${DateTime.formatIso(event.occurredAt)}
                  FROM ancestors a JOIN thread_snooze_dependencies d ON d.thread_id = a.thread_id
                `;
              }
              yield* projectionStore.apply(event);
            }),
          {
            concurrency: 1,
          },
        );
        const sequence = storedEvents.at(-1)?.sequence;
        if (sequence !== undefined) {
          const now = DateTime.formatIso(yield* DateTime.now);
          yield* sql`
            INSERT INTO orchestration_v2_projection_metadata (
              projection_name,
              schema_version,
              last_sequence,
              updated_at
            )
            VALUES (
              'thread-projections',
              ${ProjectionStore.ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION},
              ${sequence},
              ${now}
            )
            ON CONFLICT(projection_name)
            DO UPDATE SET
              schema_version = excluded.schema_version,
              last_sequence = excluded.last_sequence,
              updated_at = excluded.updated_at
          `;
        }
        // Read lineage here, on the connection this transaction holds; see makeRunOutcomeRecorder.
        return yield* runOutcomes.prepare(storedEvents);
      });

    // The enclosing write or commit span already traces this per-event projection merge.
    const updateDelegatedCompletionOnly = Effect.fnUntraced(function* (
      events: ReadonlyArray<OrchestrationV2DomainEvent>,
      includesRun: (runId: RunId) => boolean,
    ) {
      return yield* Effect.forEach(events, (event) =>
        Effect.gen(function* () {
          if (event.type !== "run.updated" || !includesRun(event.payload.id)) return event;
          const { runs } = yield* projectionStore.getThreadRecords(event.threadId, ["runs"], {
            runIds: [event.payload.id],
          });
          const current = runs[0];
          return current === undefined
            ? event
            : {
                ...event,
                payload: { ...current, delegatedCompletion: event.payload.delegatedCompletion },
              };
        }),
      );
    });

    const writeEffect = Effect.fn("orchestrationV2.EventSink.write")(function* (
      input: Parameters<EventSinkV2Shape["writeWithEffects"]>[0],
    ) {
      yield* Effect.annotateCurrentSpan({
        "orchestration_v2.command_id": input.commandId ?? null,
        "orchestration_v2.event_count": input.events.length,
        "orchestration_v2.thread_id": input.events[0]?.threadId ?? null,
      });

      const { committed } = yield* commitThenPublish(
        Effect.gen(function* () {
          // Check ownership in the same transaction that claims the native session.
          const imported = input.unlessNativeThreadOwned;
          if (imported?.nativeThreadRef != null) {
            const owners = yield* sql`
              SELECT provider_thread_id
              FROM orchestration_v2_projection_provider_threads
              WHERE driver = ${imported.driver}
                AND provider_instance_id = ${imported.providerInstanceId}
                AND thread_id IS NOT ${imported.appThreadId}
                AND json_extract(payload_json, '$.nativeThreadRef.nativeId') = ${imported.nativeThreadRef.nativeId}
              LIMIT 1
            `;
            if (owners.length > 0) return { committed: [], outcomes: [] };
          }
          // Checkpoint capture can finish after a cohort writer reads its parent run.
          // Merge in this transaction so the event log and projection keep that completion.
          const events = input.updateDelegatedCompletionOnly
            ? yield* updateDelegatedCompletionOnly(input.events, () => true)
            : input.events;
          const normalized = yield* normalizeEvents(
            input.guardPendingUserInputCancellations === true
              ? yield* guardUserInputCancellations(events)
              : events,
          );
          const committed = yield* eventStore.append({
            ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
            events: normalized,
          });
          const outcomes = yield* applyStoredEvents(committed);
          yield* effectOutbox.enqueue(input.effects);
          return { committed, outcomes };
        }).pipe(Effect.withTracerEnabled(false)),
        ({ committed, outcomes }) =>
          Effect.gen(function* () {
            if (input.effects.length > 0) {
              yield* effectOutbox.notifyAvailable(input.effects.length);
            }
            yield* publishStoredEvents(committed, outcomes);
          }),
      );
      return committed;
    });

    const writeIfRunCurrentEffect = Effect.fn("orchestrationV2.EventSink.writeIfRunCurrent")(
      function* (input: Parameters<EventSinkV2Shape["writeIfRunCurrent"]>[0]) {
        yield* Effect.annotateCurrentSpan({
          "orchestration_v2.command_id": input.commandId ?? null,
          "orchestration_v2.event_count": input.events.length,
          "orchestration_v2.run_id": input.runId,
          "orchestration_v2.thread_id": input.threadId,
        });

        return yield* commitThenPublish(
          Effect.gen(function* () {
            const rows = yield* sql<{
              readonly status: string;
              readonly active_attempt_id: string | null;
            }>`
            SELECT
              status,
              json_extract(payload_json, '$.activeAttemptId') AS active_attempt_id
            FROM orchestration_v2_projection_runs
            WHERE run_id = ${input.runId}
              AND thread_id = ${input.threadId}
            LIMIT 1
          `;
            const current = rows[0];
            if (
              current === undefined ||
              current.status !== input.expectedStatus ||
              current.active_attempt_id !== input.activeAttemptId
            ) {
              return {
                committed: false as const,
                storedEvents: [] as ReadonlyArray<OrchestrationV2StoredEvent>,
              };
            }

            const normalized = yield* normalizeEvents(
              input.guardPendingUserInputCancellations === true
                ? yield* guardUserInputCancellations(input.events)
                : input.events,
            );
            const storedEvents = yield* eventStore.append({
              ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
              events: normalized,
            });
            const outcomes = yield* applyStoredEvents(storedEvents);
            yield* effectOutbox.enqueue(input.effects ?? []);
            return { committed: true as const, storedEvents, outcomes };
          }),
          (result) =>
            Effect.gen(function* () {
              if (!result.committed) return;
              if (input.effects !== undefined && input.effects.length > 0) {
                yield* effectOutbox.notifyAvailable(input.effects.length);
              }
              yield* publishStoredEvents(result.storedEvents, result.outcomes);
            }),
        );
      },
    );

    const writeIfProviderThreadOwnerEffect = Effect.fn(
      "orchestrationV2.EventSink.writeIfProviderThreadOwner",
    )(function* (input: Parameters<EventSinkV2Shape["writeIfProviderThreadOwner"]>[0]) {
      yield* Effect.annotateCurrentSpan({
        "orchestration_v2.command_id": input.commandId ?? null,
        "orchestration_v2.event_count": input.events.length,
        "orchestration_v2.provider_thread_id": input.providerThreadId,
        "orchestration_v2.run_id": input.runId,
        "orchestration_v2.active_attempt_id": input.activeAttemptId,
        "orchestration_v2.expected_last_run_ordinal": input.expectedLastRunOrdinal,
      });

      return yield* commitThenPublish(
        Effect.gen(function* () {
          const rows = yield* sql<{
            readonly active_attempt_id: string | null;
            readonly last_run_ordinal: number | null;
          }>`
            SELECT
              json_extract(r.payload_json, '$.activeAttemptId') AS active_attempt_id,
              p.last_run_ordinal
            FROM orchestration_v2_projection_provider_threads p
            JOIN orchestration_v2_projection_runs r
              ON r.run_id = ${input.runId}
             AND r.thread_id = p.thread_id
            WHERE p.provider_thread_id = ${input.providerThreadId}
            LIMIT 1
          `;
          const current = rows[0];
          if (
            current === undefined ||
            current.active_attempt_id !== input.activeAttemptId ||
            current.last_run_ordinal !== input.expectedLastRunOrdinal
          ) {
            return {
              committed: false as const,
              storedEvents: [] as ReadonlyArray<OrchestrationV2StoredEvent>,
            };
          }

          const normalized = yield* normalizeEvents(
            input.guardPendingUserInputCancellations === true
              ? yield* guardUserInputCancellations(input.events)
              : input.events,
          );
          const storedEvents = yield* eventStore.append({
            ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
            events: normalized,
          });
          const outcomes = yield* applyStoredEvents(storedEvents);
          return { committed: true as const, storedEvents, outcomes };
        }),
        (result) =>
          result.committed
            ? publishStoredEvents(result.storedEvents, result.outcomes)
            : Effect.void,
      );
    });

    const writeIfProviderThreadUnchangedEffect = Effect.fn(
      "orchestrationV2.EventSink.writeIfProviderThreadUnchanged",
    )(function* (input: Parameters<EventSinkV2Shape["writeIfProviderThreadUnchanged"]>[0]) {
      yield* Effect.annotateCurrentSpan({
        "orchestration_v2.event_count": input.events.length,
        "orchestration_v2.provider_thread_id": input.expected.id,
      });
      const expectedJson = yield* ProjectionStore.encodeProviderThreadPayload(input.expected);

      return yield* commitThenPublish(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly payload_json: string }>`
            SELECT payload_json
            FROM orchestration_v2_projection_provider_threads
            WHERE provider_thread_id = ${input.expected.id}
            LIMIT 1
          `;
          if (rows[0]?.payload_json !== expectedJson) {
            return {
              committed: false as const,
              storedEvents: [] as ReadonlyArray<OrchestrationV2StoredEvent>,
            };
          }

          const normalized = yield* normalizeEvents(input.events);
          const storedEvents = yield* eventStore.append({ events: normalized });
          const outcomes = yield* applyStoredEvents(storedEvents);
          return { committed: true as const, storedEvents, outcomes };
        }),
        (result) =>
          result.committed
            ? publishStoredEvents(result.storedEvents, result.outcomes)
            : Effect.void,
      );
    });

    const existingCommandResult =
      /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
      Effect.fnUntraced(function* (commandId: CommandId) {
        const existing = yield* commandReceipts.getByCommandId(commandId);
        if (Option.isNone(existing)) {
          return yield* Effect.die(
            new Error(`Command receipt ${commandId} disappeared during its transaction.`),
          );
        }
        const storedEvents = yield* eventStore.readByCommandId({ commandId }).pipe(
          Stream.runCollect,
          Effect.map((events): ReadonlyArray<OrchestrationV2StoredEvent> => Array.from(events)),
        );
        return { receipt: existing.value, storedEvents };
      });

    const remoteApprovalTasks = (threadId: ThreadId) =>
      sql<{
        readonly parent_thread_id: string;
        readonly task_id: string;
        readonly remote_environment_id: string;
        readonly remote_thread_id: string;
        readonly snapshot_sequence: number | null;
        readonly last_attention_sequence: number | null;
        readonly pending_approval_count: number | null;
      }>`
      WITH RECURSIVE descendants(thread_id, path) AS (
        SELECT ${threadId}, ',' || ${threadId} || ','
        UNION ALL
        SELECT t.thread_id, d.path || t.thread_id || ','
        FROM descendants d JOIN orchestration_v2_projection_threads t
          ON json_extract(t.payload_json, '$.lineage.parentThreadId') = d.thread_id
        WHERE json_extract(t.payload_json, '$.lineage.relationshipToParent') = 'subagent'
          AND json_extract(t.payload_json, '$.creationSource') != 'provider'
          AND instr(d.path, ',' || t.thread_id || ',') = 0
      )
      SELECT task.thread_id AS parent_thread_id, task.subagent_id AS task_id,
        json_extract(task.payload_json, '$.remoteChild.environmentId') AS remote_environment_id,
        json_extract(task.payload_json, '$.remoteChild.threadId') AS remote_thread_id,
        o.snapshot_sequence, o.last_attention_sequence, o.pending_approval_count
      FROM descendants d JOIN orchestration_v2_projection_subagents task ON task.thread_id = d.thread_id
      LEFT JOIN remote_task_approval_observations o
        ON o.parent_thread_id = task.thread_id AND o.task_id = task.subagent_id
      WHERE json_type(task.payload_json, '$.remoteChild') = 'object'
        AND json_extract(task.payload_json, '$.result') IS NULL
      ORDER BY task.thread_id, task.subagent_id
    `.pipe(
        Effect.map((rows): ReadonlyArray<RemoteApprovalCheck> =>
          rows.map((row) => ({
            parentThreadId: row.parent_thread_id,
            taskId: row.task_id,
            remoteEnvironmentId: row.remote_environment_id,
            remoteThreadId: row.remote_thread_id,
            snapshotSequence: row.snapshot_sequence,
            lastAttentionSequence: row.last_attention_sequence,
            pendingApprovalCount: row.pending_approval_count,
          })),
        ),
      );

    const commitCommandEffect = Effect.fn("orchestrationV2.EventSink.commitCommand")(function* (
      input: Parameters<EventSinkV2Shape["commitCommand"]>[0],
    ) {
      const result = yield* commitThenPublish(
        Effect.gen(function* () {
          const reserved = yield* commandReceipts.insertIfAbsent({
            commandId: input.commandId,
            threadId: input.threadId,
            commandType: input.commandType,
            acceptedAt: input.acceptedAt,
            resultSequence: 0,
            status: "accepted",
            error: null,
          });
          if (!reserved) {
            const existing = yield* existingCommandResult(input.commandId);
            return { ...existing, committed: false as const, cancelledEffectIds: [] };
          }

          if (input.expectedThreadSequence !== undefined) {
            const sequence = yield* eventStore.latestSequence({ threadId: input.threadId });
            if (sequence !== input.expectedThreadSequence) {
              return yield* new EventSinkWriteError({
                eventCount: input.events.length,
                commandId: input.commandId,
                cause: new Error("The thread changed while its snooze was being updated."),
              });
            }
          }

          if (input.remoteApprovalChecks !== undefined) {
            const actual = yield* remoteApprovalTasks(input.threadId);
            if (
              actual.length !== input.remoteApprovalChecks.length ||
              actual.some((task, index) => {
                const expected = input.remoteApprovalChecks?.[index];
                return (
                  expected === undefined ||
                  task.parentThreadId !== expected.parentThreadId ||
                  task.taskId !== expected.taskId ||
                  task.remoteEnvironmentId !== expected.remoteEnvironmentId ||
                  task.remoteThreadId !== expected.remoteThreadId ||
                  task.snapshotSequence !== expected.snapshotSequence ||
                  task.lastAttentionSequence !== expected.lastAttentionSequence ||
                  task.pendingApprovalCount !== expected.pendingApprovalCount
                );
              }) ||
              actual.some((task) => task.pendingApprovalCount !== 0)
            ) {
              return yield* new EventSinkWriteError({
                eventCount: input.events.length,
                commandId: input.commandId,
                cause: new Error("Remote task approval status changed or is unavailable."),
              });
            }
          }

          let remoteAttentionOpened = false;
          if (input.remoteApprovalObservation !== undefined) {
            const observation = input.remoteApprovalObservation;
            const task = yield* sql`
              SELECT 1 FROM orchestration_v2_projection_subagents
              WHERE subagent_id = ${observation.taskId} AND thread_id = ${input.threadId}
                AND json_extract(payload_json, '$.remoteChild.environmentId') = ${observation.remoteEnvironmentId}
                AND json_extract(payload_json, '$.remoteChild.threadId') = ${observation.remoteThreadId}
                AND json_extract(payload_json, '$.result') IS NULL
            `;
            const previous = (yield* sql<{
              readonly snapshot_sequence: number;
              readonly last_attention_sequence: number;
              readonly pending_approval_count: number;
            }>`SELECT snapshot_sequence, last_attention_sequence, pending_approval_count
              FROM remote_task_approval_observations
              WHERE parent_thread_id = ${input.threadId} AND task_id = ${observation.taskId}`)[0];
            if (
              task.length === 0 ||
              (!observation.unavailable &&
                (observation.lastAttentionSequence > observation.snapshotSequence ||
                  (previous !== undefined &&
                    (observation.snapshotSequence < previous.snapshot_sequence ||
                      observation.lastAttentionSequence < previous.last_attention_sequence))))
            ) {
              return yield* new EventSinkWriteError({
                eventCount: input.events.length,
                commandId: input.commandId,
                cause: new Error(
                  "The remote approval observation is stale or no longer belongs to this task.",
                ),
              });
            }
            const snapshotSequence = observation.unavailable
              ? Math.max(previous?.snapshot_sequence ?? 0, observation.snapshotSequence)
              : observation.snapshotSequence;
            const attentionSequence = observation.unavailable
              ? Math.max(previous?.last_attention_sequence ?? 0, observation.lastAttentionSequence)
              : observation.lastAttentionSequence;
            const pendingCount = observation.unavailable ? -1 : observation.pendingApprovalCount;
            remoteAttentionOpened = observation.unavailable
              ? previous?.pending_approval_count !== -1 ||
                attentionSequence > (previous?.last_attention_sequence ?? 0)
              : attentionSequence > (previous?.last_attention_sequence ?? 0) ||
                (pendingCount > 0 && (previous?.pending_approval_count ?? 0) <= 0);
            yield* sql`
              INSERT INTO remote_task_approval_observations(parent_thread_id, task_id, remote_environment_id, remote_thread_id, snapshot_sequence, last_attention_sequence, pending_approval_count)
              VALUES (${input.threadId}, ${observation.taskId}, ${observation.remoteEnvironmentId}, ${observation.remoteThreadId}, ${snapshotSequence}, ${attentionSequence}, ${pendingCount})
              ON CONFLICT(parent_thread_id, task_id) DO UPDATE SET
                remote_environment_id = excluded.remote_environment_id, remote_thread_id = excluded.remote_thread_id,
                snapshot_sequence = excluded.snapshot_sequence, last_attention_sequence = excluded.last_attention_sequence,
                pending_approval_count = excluded.pending_approval_count
            `;
            if (remoteAttentionOpened) {
              yield* sql`UPDATE thread_snooze_dependencies SET visibility = 'visible', revision = revision + 1 WHERE thread_id = ${input.threadId} AND visibility = 'hidden'`;
            }
          }

          let savedUndo = false;
          if (
            ["thread.settle", "thread.snooze", "thread.snooze-until-thread"].includes(
              input.commandType,
            )
          ) {
            const captured = yield* sql<{ readonly dependency_id: string }>`
              INSERT INTO thread_snooze_undo
                (thread_id, dependency_id, target_thread_id, until_kind, start_sequence, visibility_sequence, visibility, revision, action_command_id)
              SELECT thread_id, dependency_id, target_thread_id, until_kind, start_sequence, visibility_sequence, visibility, 0, ${input.commandId}
              FROM thread_snooze_dependencies WHERE thread_id = ${input.threadId}
              ON CONFLICT(thread_id) DO UPDATE SET dependency_id = excluded.dependency_id,
                target_thread_id = excluded.target_thread_id, until_kind = excluded.until_kind,
                start_sequence = excluded.start_sequence, visibility_sequence = excluded.visibility_sequence,
                visibility = excluded.visibility, revision = 0, action_command_id = excluded.action_command_id
              RETURNING dependency_id
            `;
            savedUndo = captured.length > 0;
          }
          if (
            !savedUndo &&
            input.undoSnoozeDependency === undefined &&
            input.commandType !== "thread.visit" &&
            input.commandType !== "thread.mark-unread"
          ) {
            yield* sql`DELETE FROM thread_snooze_undo WHERE thread_id = ${input.threadId}`;
          }

          if (input.remoteApprovalChecks !== undefined) {
            const pending = yield* sql`
              SELECT 1 WHERE EXISTS (
                SELECT 1 FROM orchestration_v2_projection_runtime_requests
                WHERE thread_id = ${input.threadId} AND status = 'pending'
              ) OR EXISTS (
                SELECT 1 FROM orchestration_v2_projection_threads t,
                  json_each(t.payload_json, '$.guestShare.messages') message
                WHERE t.thread_id = ${input.threadId}
                  AND json_extract(message.value, '$.status') = 'pending'
              ) OR EXISTS (
                SELECT 1 FROM orchestration_v2_projection_runs run
                LEFT JOIN orchestration_v2_projection_messages message
                  ON message.message_id = json_extract(run.payload_json, '$.userMessageId')
                WHERE run.thread_id = ${input.threadId} AND run.status = 'queued'
                  AND json_extract(message.payload_json, '$.notification') IS NULL
                  AND json_extract(message.payload_json, '$.delegatedCompletion') IS NULL
              )
            `;
            if (pending.length > 0)
              return yield* new EventSinkWriteError({
                eventCount: input.events.length,
                commandId: input.commandId,
                cause: new Error("The thread has a pending request or queued message."),
              });
            const childRequests = yield* sql`
              WITH RECURSIVE descendants(thread_id, path) AS (
                SELECT thread_id, ',' || thread_id || ',' FROM orchestration_v2_projection_threads
                WHERE json_extract(payload_json, '$.lineage.parentThreadId') = ${input.threadId}
                  AND json_extract(payload_json, '$.lineage.relationshipToParent') = 'subagent'
                UNION ALL
                SELECT t.thread_id, d.path || t.thread_id || ','
                FROM descendants d JOIN orchestration_v2_projection_threads t
                  ON json_extract(t.payload_json, '$.lineage.parentThreadId') = d.thread_id
                WHERE json_extract(t.payload_json, '$.lineage.relationshipToParent') = 'subagent'
                  AND instr(d.path, ',' || t.thread_id || ',') = 0
              )
              SELECT 1 FROM descendants d
              JOIN orchestration_v2_projection_threads t ON t.thread_id = d.thread_id
              JOIN orchestration_v2_projection_runtime_requests r ON r.thread_id = d.thread_id
              WHERE r.status = 'pending' AND r.kind NOT IN ('user_input', 'auth_refresh', 'dynamic_tool_call')
                AND json_extract(t.payload_json, '$.creationSource') != 'provider'
                AND EXISTS (SELECT 1 FROM orchestration_v2_projection_runs run WHERE run.thread_id = d.thread_id AND run.status IN ('preparing', 'starting', 'running', 'waiting'))
              LIMIT 1
            `;
            if (childRequests.length > 0)
              return yield* new EventSinkWriteError({
                eventCount: input.events.length,
                commandId: input.commandId,
                cause: new Error("A subagent needs approval."),
              });
          }

          let undoWake:
            | { readonly kind: "settled" | "completed" | "archived" | "deleted" }
            | undefined;
          if (input.undoSnoozeDependency !== undefined) {
            const dependency = input.undoSnoozeDependency;
            const history = (yield* sql<{
              readonly dependency_id: string;
              readonly target_thread_id: string;
              readonly until_kind: string;
              readonly start_sequence: number;
              readonly visibility_sequence: number;
              readonly visibility: string;
              readonly revision: number;
              readonly action_command_id: string;
            }>`SELECT dependency_id, target_thread_id, until_kind, start_sequence, visibility_sequence, visibility, revision, action_command_id
              FROM thread_snooze_undo WHERE thread_id = ${input.threadId}`)[0];
            const currentSequence =
              (yield* sql<{ readonly sequence: number }>`
              SELECT COALESCE(MAX(sequence), 0) AS sequence FROM orchestration_events
              WHERE stream_id = ${input.threadId} AND event_type NOT IN ('thread.visited', 'thread.marked-unread')
            `)[0]?.sequence ?? 0;
            const reverse =
              yield* sql`SELECT 1 FROM thread_snooze_dependencies WHERE thread_id = ${dependency.targetThreadId} AND target_thread_id = ${input.threadId}`;
            if (
              history === undefined ||
              history.action_command_id !== input.undoExpectedCommandId ||
              history.dependency_id !== dependency.dependencyId ||
              history.target_thread_id !== dependency.targetThreadId ||
              history.until_kind !== dependency.until ||
              history.visibility !== dependency.visibility ||
              history.revision !== currentSequence
            ) {
              return yield* new EventSinkWriteError({
                eventCount: input.events.length,
                commandId: input.commandId,
                cause: new Error("The previous wait can no longer be restored."),
              });
            }
            undoWake = (yield* sql<{
              readonly kind: "settled" | "completed" | "archived" | "deleted";
            }>`
              SELECT kind FROM thread_snooze_transitions
              WHERE target_thread_id = ${history.target_thread_id} AND sequence > ${history.start_sequence}
                AND (kind = ${history.until_kind} OR kind IN ('archived', 'deleted'))
              ORDER BY sequence LIMIT 1
            `)[0];
            if (undoWake === undefined && reverse.length > 0) {
              return yield* new EventSinkWriteError({
                eventCount: input.events.length,
                commandId: input.commandId,
                cause: new Error("The previous wait would create a direct cycle."),
              });
            }
            yield* sql`DELETE FROM thread_snooze_dependencies WHERE thread_id = ${input.threadId}`;
            if (undoWake === undefined) {
              yield* sql`
                INSERT INTO thread_snooze_dependencies (thread_id, dependency_id, target_thread_id, until_kind, start_sequence, visibility_sequence, visibility, revision)
                VALUES (${input.threadId}, ${history.dependency_id}, ${history.target_thread_id}, ${history.until_kind}, ${history.start_sequence}, ${history.visibility_sequence}, ${history.visibility}, 1)
              `;
            }
            yield* sql`DELETE FROM thread_snooze_undo WHERE thread_id = ${input.threadId}`;
          }

          if (input.undoSnoozeDependency !== undefined) {
          } else if (input.showSnoozeDependencyId !== undefined) {
            const updated = yield* sql<{ readonly dependency_id: string }>`
              UPDATE thread_snooze_dependencies SET visibility = 'visible', revision = revision + 1
              WHERE thread_id = ${input.threadId} AND dependency_id = ${input.showSnoozeDependencyId}
                AND visibility_sequence < ${input.attentionSequence ?? 0}
              RETURNING dependency_id
            `;
            if (updated.length === 0) {
              return yield* new EventSinkWriteError({
                eventCount: input.events.length,
                commandId: input.commandId,
              });
            }
          } else if (input.resolveSnoozeDependencyId !== undefined) {
            const removed = yield* sql<{ readonly dependency_id: string }>`
              DELETE FROM thread_snooze_dependencies
              WHERE thread_id = ${input.threadId} AND dependency_id = ${input.resolveSnoozeDependencyId}
              RETURNING dependency_id
            `;
            if (removed.length === 0) {
              return yield* new EventSinkWriteError({
                eventCount: input.events.length,
                commandId: input.commandId,
                cause: new Error("The snooze dependency changed."),
              });
            }
          } else if (input.snoozeDependency !== undefined) {
            const { targetThreadId, until } = input.snoozeDependency;
            const targets = yield* sql<{
              readonly settled_override: string | null;
              readonly settled_at: string | null;
              readonly deleted_at: string | null;
              readonly archived_at: string | null;
            }>`
              SELECT json_extract(payload_json, '$.settledOverride') AS settled_override,
                json_extract(payload_json, '$.settledAt') AS settled_at, deleted_at, archived_at
              FROM orchestration_v2_projection_threads WHERE thread_id = ${targetThreadId}
            `;
            const reverse = yield* sql<{ readonly thread_id: string }>`
              SELECT thread_id FROM thread_snooze_dependencies
              WHERE thread_id = ${targetThreadId} AND target_thread_id = ${input.threadId}
            `;
            const target = targets[0];
            if (
              targetThreadId === input.threadId ||
              target === undefined ||
              target.deleted_at !== null ||
              target.archived_at !== null ||
              reverse.length > 0 ||
              (until === "settled" &&
                (target.settled_override === "settled" || target.settled_at !== null))
            ) {
              return yield* new EventSinkWriteError({
                eventCount: input.events.length,
                commandId: input.commandId,
                cause: new Error("Invalid or unavailable snooze dependency target."),
              });
            }
            const preserved = input.snoozeDependency.preserveDependencyId;
            if (preserved !== undefined && preserved !== input.commandId) {
              const rows = yield* sql<{ readonly pending: number }>`
                SELECT EXISTS (
                  SELECT 1 FROM thread_snooze_transitions t
                  WHERE t.target_thread_id = d.target_thread_id AND t.sequence > d.start_sequence
                    AND (t.kind = d.until_kind OR t.kind IN ('archived', 'deleted'))
                ) AS pending
                FROM thread_snooze_dependencies d
                WHERE d.thread_id = ${input.threadId} AND d.dependency_id = ${preserved}
              `;
              if (rows.length === 0 || rows[0]?.pending !== 0) {
                return yield* new EventSinkWriteError({
                  eventCount: input.events.length,
                  commandId: input.commandId,
                });
              }
              yield* sql`UPDATE thread_snooze_dependencies SET visibility = 'hidden', visibility_sequence = COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'thread_snooze_transitions'), 0), revision = revision + 1 WHERE thread_id = ${input.threadId} AND dependency_id = ${preserved}`;
            } else
              yield* sql`
              INSERT INTO thread_snooze_dependencies
                (thread_id, dependency_id, target_thread_id, until_kind, start_sequence, visibility_sequence, visibility, revision)
              VALUES (${input.threadId}, ${input.commandId}, ${targetThreadId}, ${until},
                COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'thread_snooze_transitions'), 0), COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'thread_snooze_transitions'), 0), 'hidden', 1)
              ON CONFLICT(thread_id) DO UPDATE SET dependency_id = excluded.dependency_id,
                target_thread_id = excluded.target_thread_id, until_kind = excluded.until_kind,
                start_sequence = excluded.start_sequence, visibility = excluded.visibility,
                visibility_sequence = excluded.visibility_sequence,
                revision = thread_snooze_dependencies.revision + 1
            `;
          } else if (
            input.cancelSnoozeDependency ||
            [
              "thread.unsnooze",
              "thread.snooze",
              "thread.settle",
              "thread.pin",
              "thread.archive",
              "thread.delete",
            ].includes(input.commandType)
          ) {
            if (input.expectedSnoozeDependencyId !== undefined) {
              const removed =
                yield* sql`DELETE FROM thread_snooze_dependencies WHERE thread_id = ${input.threadId} AND dependency_id = ${input.expectedSnoozeDependencyId} RETURNING dependency_id`;
              if (removed.length === 0)
                return yield* new EventSinkWriteError({
                  eventCount: input.events.length,
                  commandId: input.commandId,
                  cause: new Error("The snooze dependency changed."),
                });
            } else {
              yield* sql`DELETE FROM thread_snooze_dependencies WHERE thread_id = ${input.threadId}`;
            }
          }
          if (input.commandType === "runtime-request.respond") {
            const wake = input.events.findLast(
              (event) =>
                event.type === "thread.unsnoozed" || event.type === "thread.metadata-updated",
            );
            if (
              (wake?.type === "thread.unsnoozed" || wake?.type === "thread.metadata-updated") &&
              wake.payload.snoozeDependency?.visibility === "visible"
            ) {
              yield* sql`
                UPDATE thread_snooze_dependencies SET visibility = 'visible', revision = revision + 1
                WHERE thread_id = ${input.threadId} AND dependency_id = ${wake.payload.snoozeDependency.dependencyId}
              `;
            }
          }

          const runId = input.updateDelegatedCompletionOnlyRunId;
          const normalized = yield* normalizeEvents(
            runId === undefined
              ? input.events
              : yield* updateDelegatedCompletionOnly(input.events, (id) => id === runId),
          );
          const remoteNormalized = remoteAttentionOpened
            ? normalized.map((event) =>
                event.type === "thread.metadata-updated" &&
                event.threadId === input.threadId &&
                event.payload.snoozeDependency?.visibility === "hidden"
                  ? {
                      ...event,
                      payload: {
                        ...event.payload,
                        snoozeDependency: {
                          ...event.payload.snoozeDependency,
                          visibility: "visible" as const,
                        },
                        lastSnoozeWakeAt: input.acceptedAt,
                        updatedAt: input.acceptedAt,
                      },
                    }
                  : event,
              )
            : normalized;
          const eventsToStore =
            undoWake === undefined
              ? remoteNormalized
              : remoteNormalized.map((event) => {
                  if (event.type !== "thread.snoozed" || input.undoSnoozeDependency === undefined)
                    return event;
                  return {
                    ...event,
                    type: "thread.unsnoozed" as const,
                    payload: {
                      ...event.payload,
                      snoozeDependency: null,
                      snoozedAt: null,
                      lastSnoozeWakeAt: input.acceptedAt,
                      snoozeDependencyWake: {
                        targetThreadId: input.undoSnoozeDependency.targetThreadId,
                        reason: undoWake!.kind,
                        eventId: input.commandId,
                        occurredAt: DateTime.formatIso(input.acceptedAt),
                      },
                    },
                  };
                });
          const storedEvents = yield* eventStore.append({
            commandId: input.commandId,
            events: eventsToStore,
          });
          if (remoteAttentionOpened) {
            const sequence = storedEvents.at(-1)?.sequence ?? 0;
            yield* sql`
              WITH RECURSIVE ancestors(thread_id, path) AS (
                SELECT ${input.threadId}, ',' || ${input.threadId} || ','
                UNION ALL
                SELECT json_extract(t.payload_json, '$.lineage.parentThreadId'), a.path || t.thread_id || ','
                FROM ancestors a JOIN orchestration_v2_projection_threads t ON t.thread_id = a.thread_id
                WHERE json_extract(t.payload_json, '$.lineage.relationshipToParent') = 'subagent'
                  AND instr(a.path, ',' || json_extract(t.payload_json, '$.lineage.parentThreadId') || ',') = 0
              )
              INSERT INTO thread_approval_attention(thread_id, last_attention_sequence)
              SELECT thread_id, ${sequence} FROM ancestors WHERE thread_id IS NOT NULL
              ON CONFLICT(thread_id) DO UPDATE SET last_attention_sequence = MAX(last_attention_sequence, excluded.last_attention_sequence)
            `;
            yield* sql`
              WITH RECURSIVE ancestors(thread_id, path) AS (
                SELECT json_extract(payload_json, '$.lineage.parentThreadId'), ',' || thread_id || ','
                FROM orchestration_v2_projection_threads WHERE thread_id = ${input.threadId}
                  AND json_extract(payload_json, '$.lineage.relationshipToParent') = 'subagent'
                UNION ALL
                SELECT json_extract(t.payload_json, '$.lineage.parentThreadId'), a.path || t.thread_id || ','
                FROM ancestors a JOIN orchestration_v2_projection_threads t ON t.thread_id = a.thread_id
                WHERE json_extract(t.payload_json, '$.lineage.relationshipToParent') = 'subagent'
                  AND instr(a.path, ',' || t.thread_id || ',') = 0
              )
              INSERT OR IGNORE INTO thread_snooze_transitions(target_thread_id, event_id, kind, occurred_at)
              SELECT a.thread_id, ${input.commandId} || ':remote-ancestor:' || a.thread_id, 'attention', ${DateTime.formatIso(input.acceptedAt)}
              FROM ancestors a JOIN thread_snooze_dependencies d ON d.thread_id = a.thread_id
            `;
          }
          // A Stop that changes nothing can still queue the stop of its delegated tasks.
          const sequence =
            storedEvents.at(-1)?.sequence ??
            (input.effects.length === 0
              ? undefined
              : yield* eventStore.latestSequence({ threadId: input.threadId }));
          if (sequence === undefined) {
            return yield* Effect.die(
              new Error(`Command ${input.commandId} produced no orchestration events.`),
            );
          }
          if (savedUndo)
            yield* sql`UPDATE thread_snooze_undo SET revision = ${sequence} WHERE thread_id = ${input.threadId}`;
          const outcomes = yield* applyStoredEvents(storedEvents);
          yield* effectOutbox.enqueue(input.effects);
          const receipt: CommandReceiptStore.CommandReceiptV2 = {
            commandId: input.commandId,
            threadId: input.threadId,
            commandType: input.commandType,
            acceptedAt: input.acceptedAt,
            resultSequence: sequence,
            status: "accepted",
            error: null,
          };
          yield* commandReceipts.upsert(receipt);
          const cancelledEffectIds =
            input.cancelUnsettledEffects === undefined
              ? []
              : yield* effectOutbox.cancelUnsettled({
                  threadId: input.threadId,
                  ...input.cancelUnsettledEffects,
                });
          return { receipt, storedEvents, outcomes, committed: true as const, cancelledEffectIds };
        }),
        (result) =>
          Effect.gen(function* () {
            yield* effectOutbox.signalCancellations(result.cancelledEffectIds);
            if (result.committed && input.effects.length > 0) {
              yield* effectOutbox.notifyAvailable(input.effects.length);
            }
            if (result.committed) yield* publishStoredEvents(result.storedEvents, result.outcomes);
          }),
      );
      return {
        receipt: result.receipt,
        storedEvents: result.storedEvents,
        committed: result.committed,
        cancelledEffectCount: result.cancelledEffectIds.length,
      };
    });

    const commitRejectedCommandEffect = Effect.fn(
      "orchestrationV2.EventSink.commitRejectedCommand",
    )(function* (input: Parameters<EventSinkV2Shape["commitRejectedCommand"]>[0]) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const sequence = yield* eventStore.latestSequence({ threadId: input.threadId });
          const receipt: CommandReceiptStore.CommandReceiptV2 = {
            commandId: input.commandId,
            threadId: input.threadId,
            commandType: input.commandType,
            acceptedAt: input.rejectedAt,
            resultSequence: sequence,
            status: "rejected",
            error: input.error,
          };
          const inserted = yield* commandReceipts.insertIfAbsent(receipt);
          if (inserted) {
            return receipt;
          }
          const existing = yield* commandReceipts.getByCommandId(input.commandId);
          return Option.getOrElse(existing, () => receipt);
        }),
      );
    });

    const existingProjectReceipt = (commandId: CommandId) =>
      commandReceipts.getProjectByCommandId(commandId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(`Command ${commandId} was already used by a thread command.` as const),
            onSome: Effect.succeed,
          }),
        ),
      );

    const commitProjectCommandEffect = Effect.fn("orchestrationV2.EventSink.commitProjectCommand")(
      function* (input: Parameters<EventSinkV2Shape["commitProjectCommand"]>[0]) {
        const result = yield* commitThenPublish(
          Effect.gen(function* () {
            const reserved: CommandReceiptStore.ProjectCommandReceiptV2 = {
              commandId: input.commandId,
              projectId: input.projectId,
              commandType: input.commandType,
              acceptedAt: input.acceptedAt,
              resultSequence: 0,
              status: "accepted",
              error: null,
            };
            if (!(yield* commandReceipts.insertIfAbsent(reserved))) {
              return { receipt: yield* existingProjectReceipt(input.commandId), event: undefined };
            }
            const event = yield* eventStore.appendProjectEvent(input.event);
            yield* projectStore.apply(event);
            const receipt = { ...reserved, resultSequence: event.sequence };
            yield* commandReceipts.upsert(receipt);
            return { receipt, event };
          }),
          (result) =>
            result.event === undefined ? Effect.void : eventStore.publishCommitted([result.event]),
        );
        return { receipt: result.receipt, committed: result.event !== undefined };
      },
    );

    const commitRejectedProjectCommandEffect = Effect.fn(
      "orchestrationV2.EventSink.commitRejectedProjectCommand",
    )(function* (input: Parameters<EventSinkV2Shape["commitRejectedProjectCommand"]>[0]) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const receipt: CommandReceiptStore.ProjectCommandReceiptV2 = {
            commandId: input.commandId,
            projectId: input.projectId,
            commandType: input.commandType,
            acceptedAt: input.rejectedAt,
            resultSequence: yield* eventStore.latestApplicationSequence,
            status: "rejected",
            error: input.error,
          };
          return (yield* commandReceipts.insertIfAbsent(receipt))
            ? receipt
            : yield* existingProjectReceipt(input.commandId);
        }),
      );
    });

    const catchUp = (input: {
      readonly afterSequence: number;
      readonly throughSequence: number;
      readonly threadId?: ThreadId;
      readonly eventType?: OrchestrationV2DomainEvent["type"];
    }): Stream.Stream<OrchestrationV2StoredEvent, unknown> => {
      const pageSize = 256;
      const loop = (afterSequence: number): Stream.Stream<OrchestrationV2StoredEvent, unknown> =>
        Stream.unwrap(
          eventStore
            .read({
              afterSequence,
              throughSequence: input.throughSequence,
              ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
              ...(input.eventType === undefined ? {} : { eventType: input.eventType }),
              limit: pageSize,
            })
            .pipe(
              Stream.runCollect,
              Effect.map((chunk) => Array.from(chunk)),
              Effect.map((events) => {
                if (events.length === 0) {
                  return Stream.empty;
                }
                const current = Stream.fromIterable(events);
                const last = events.at(-1)?.sequence ?? input.throughSequence;
                return events.length < pageSize || last >= input.throughSequence
                  ? current
                  : Stream.concat(current, loop(last));
              }),
            ),
        );
      return loop(input.afterSequence);
    };

    const stream = (input?: Parameters<EventSinkV2Shape["stream"]>[0]) => {
      const afterSequence = input?.afterSequence ?? 0;
      const matches = (stored: OrchestrationV2StoredEvent) =>
        (input?.threadId === undefined || stored.event.threadId === input.threadId) &&
        (input?.eventType === undefined || stored.event.type === input.eventType);
      const replay = (throughSequence: number) =>
        catchUp({
          afterSequence,
          throughSequence,
          ...(input?.threadId === undefined ? {} : { threadId: input.threadId }),
          ...(input?.eventType === undefined ? {} : { eventType: input.eventType }),
        }).pipe(Stream.filter(matches));
      return Stream.unwrap(
        Effect.gen(function* () {
          let pubsub = liveEvents;
          if (input?.eventType !== undefined) {
            const existing = liveEventsByType.get(input.eventType);
            if (existing !== undefined) {
              pubsub = existing;
            } else {
              const created = yield* PubSub.unbounded<OrchestrationV2StoredEvent>();
              pubsub = liveEventsByType.get(input.eventType) ?? created;
              liveEventsByType.set(input.eventType, pubsub);
            }
          }
          if (input?.bounded === true) {
            return replayAndBufferProjectedLiveEvents({
              subscribe: PubSub.subscribe(pubsub),
              latestSequence: eventStore.latestSequence(),
              afterSequence,
              filter: matches,
              replay,
              project: (stored) => ({ ...stored, event: projectDomainEventForWire(stored.event) }),
            });
          }
          const subscription = yield* PubSub.subscribe(pubsub);
          const highWater = yield* eventStore.latestSequence();
          const live = Stream.fromSubscription(subscription).pipe(
            Stream.filter((stored) => stored.sequence > Math.max(highWater, afterSequence)),
            Stream.filter(matches),
          );
          return Stream.concat(replay(highWater), live);
        }),
      );
    };

    return EventSinkV2.of({
      write: (input) =>
        writeEffect({ ...input, effects: [] }).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: input.events.length,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                cause,
              }),
          ),
        ),
      writeWithEffects: (input) =>
        writeEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: input.events.length,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                cause,
              }),
          ),
        ),
      writeIfRunCurrent: (input) =>
        writeIfRunCurrentEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: input.events.length,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                cause,
              }),
          ),
        ),
      writeIfProviderThreadOwner: (input) =>
        writeIfProviderThreadOwnerEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: input.events.length,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                cause,
              }),
          ),
        ),
      writeIfProviderThreadUnchanged: (input) =>
        writeIfProviderThreadUnchangedEffect(input).pipe(
          Effect.mapError(
            (cause) => new EventSinkWriteError({ eventCount: input.events.length, cause }),
          ),
        ),
      commitCommand: (input) =>
        commitCommandEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                commandId: input.commandId,
                eventCount: input.events.length,
                cause,
              }),
          ),
        ),
      commitRejectedCommand: (input) =>
        commitRejectedCommandEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                commandId: input.commandId,
                eventCount: 0,
                cause,
              }),
          ),
        ),
      commitProjectCommand: (input) =>
        commitProjectCommandEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({ commandId: input.commandId, eventCount: 1, cause }),
          ),
        ),
      commitRejectedProjectCommand: (input) =>
        commitRejectedProjectCommandEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({ commandId: input.commandId, eventCount: 0, cause }),
          ),
        ),
      stream: (input) =>
        stream(input).pipe(
          Stream.mapError(
            (cause) =>
              new EventSinkStreamError({
                ...(input?.threadId === undefined ? {} : { threadId: input.threadId }),
                ...(input?.afterSequence === undefined
                  ? {}
                  : { afterSequence: input.afterSequence }),
                cause,
              }),
          ),
        ),
      latestSequence: (input) =>
        eventStore.latestSequence(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkStreamError({
                ...(input?.threadId === undefined ? {} : { threadId: input.threadId }),
                cause,
              }),
          ),
        ),
      approvalAttention: Effect.fn("EventSink.approvalAttention")((threadId) =>
        Effect.gen(function* () {
          const row = (yield* sql<{
            readonly snapshot_sequence: number;
            readonly last_attention_sequence: number;
            readonly pending_approval_count: number;
            readonly unavailable_count: number;
          }>`
            WITH RECURSIVE descendants(thread_id, path) AS (
              SELECT ${threadId}, ',' || ${threadId} || ','
              UNION ALL
              SELECT t.thread_id, d.path || t.thread_id || ','
              FROM descendants d JOIN orchestration_v2_projection_threads t
                ON json_extract(t.payload_json, '$.lineage.parentThreadId') = d.thread_id
              WHERE json_extract(t.payload_json, '$.lineage.relationshipToParent') = 'subagent'
                AND json_extract(t.payload_json, '$.creationSource') != 'provider'
                AND instr(d.path, ',' || t.thread_id || ',') = 0
            )
            SELECT
              COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'orchestration_events'), 0) AS snapshot_sequence,
              COALESCE((SELECT last_attention_sequence FROM thread_approval_attention WHERE thread_id = ${threadId}), 0) AS last_attention_sequence,
              (SELECT COUNT(*) FROM descendants d
                JOIN orchestration_v2_projection_runtime_requests r ON r.thread_id = d.thread_id
                WHERE r.status = 'pending' AND r.kind NOT IN ('user_input', 'auth_refresh', 'dynamic_tool_call')
                  AND EXISTS (SELECT 1 FROM orchestration_v2_projection_runs run WHERE run.thread_id = d.thread_id AND run.status IN ('preparing', 'starting', 'running', 'waiting'))
              ) + (SELECT COALESCE(SUM(MAX(o.pending_approval_count, 0)), 0) FROM descendants d
                JOIN orchestration_v2_projection_subagents task ON task.thread_id = d.thread_id
                LEFT JOIN remote_task_approval_observations o ON o.parent_thread_id = task.thread_id AND o.task_id = task.subagent_id
                WHERE json_type(task.payload_json, '$.remoteChild') = 'object' AND json_extract(task.payload_json, '$.result') IS NULL
              ) AS pending_approval_count,
              (SELECT COUNT(*) FROM descendants d
                JOIN orchestration_v2_projection_subagents task ON task.thread_id = d.thread_id
                LEFT JOIN remote_task_approval_observations o ON o.parent_thread_id = task.thread_id AND o.task_id = task.subagent_id
                WHERE json_type(task.payload_json, '$.remoteChild') = 'object' AND json_extract(task.payload_json, '$.result') IS NULL
                  AND (o.task_id IS NULL OR o.pending_approval_count < 0)
              ) AS unavailable_count
          `)[0]!;
          return {
            version: 1 as const,
            snapshotSequence: row.snapshot_sequence,
            lastAttentionSequence: row.last_attention_sequence,
            pendingApprovalCount: row.pending_approval_count,
            available: row.unavailable_count === 0,
          };
        }).pipe(Effect.mapError((cause) => new EventSinkStreamError({ threadId, cause }))),
      ),
      remoteApprovalObservation: Effect.fn("EventSink.remoteApprovalObservation")(
        (threadId, taskId) =>
          Effect.gen(function* () {
            const row = (yield* sql<{
              readonly snapshot_sequence: number;
              readonly last_attention_sequence: number;
              readonly pending_approval_count: number;
            }>`SELECT snapshot_sequence, last_attention_sequence, pending_approval_count FROM remote_task_approval_observations WHERE parent_thread_id = ${threadId} AND task_id = ${taskId}`)[0];
            return row === undefined
              ? null
              : {
                  snapshotSequence: row.snapshot_sequence,
                  lastAttentionSequence: row.last_attention_sequence,
                  pendingApprovalCount: row.pending_approval_count,
                };
          }).pipe(Effect.mapError((cause) => new EventSinkStreamError({ threadId, cause }))),
      ),
      remoteApprovalTasks: (threadId) =>
        remoteApprovalTasks(threadId).pipe(
          Effect.mapError((cause) => new EventSinkStreamError({ threadId, cause })),
        ),
      readByCommandId: (input) =>
        eventStore.readByCommandId(input).pipe(
          Stream.mapError(
            (cause) =>
              new EventSinkStreamError({
                cause,
              }),
          ),
        ),
    } satisfies EventSinkV2Shape);
  }),
);

/** Share the worker's outbox instance: enqueue wakeups are in-memory. */
export const layerFromStores = layerBase;

export const layer: Layer.Layer<
  EventSinkV2,
  never,
  EventStore.EventStoreV2 | ProjectionStore.ProjectionStoreV2 | SqlClient.SqlClient
> = layerBase.pipe(
  Layer.provide(
    Layer.mergeAll(
      CommandReceiptStore.layer,
      EffectOutbox.layer,
      ProjectStore.layer,
      TurnItemPositionStore.layer,
    ),
  ),
);
