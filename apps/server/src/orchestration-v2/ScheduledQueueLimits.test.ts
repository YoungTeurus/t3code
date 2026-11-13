import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  type ServerSettings,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for metadata controls"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = (serverSettings: Partial<ServerSettings> = {}) =>
  Layer.mergeAll(
    layerDatabase,
    ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
    EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
    ProviderReplayHarness.layerWithRegistry(
      { name: "control-reads" },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      { databaseLayer: layerDatabase, runEffectWorker: false, serverSettings },
    ),
  );

it.effect(
  "limits scheduled queue atomically, preserves manual work and resets the durable counter after clearing",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:scheduled-queue");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create"),
        threadId,
        projectId: ProjectId.make("project:scheduled-queue"),
        title: "Queue",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const dispatch = (id: string, scheduledTaskId?: ScheduledTaskId) =>
        orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(id),
          threadId,
          messageId: MessageId.make(id),
          text: id,
          attachments: [],
          modelSelection,
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
          ...(scheduledTaskId === undefined ? {} : { scheduledTaskId }),
        });
      yield* dispatch("active");
      yield* dispatch("manual");
      const taskId = ScheduledTaskId.make("task:a");
      yield* dispatch("old", taskId);
      const held = (yield* projections.getThreadRecords(threadId, ["runs"])).runs.find(
        (run) => run.userMessageId === MessageId.make("old"),
      )!;
      yield* projections.apply({
        type: "run.updated",
        id: EventId.make("hold-old"),
        threadId,
        runId: held.id,
        occurredAt: yield* DateTime.now,
        payload: { ...held, queueHeld: true },
      });
      yield* dispatch("fresh", taskId);
      let state = yield* projections.getThreadProjection(threadId);
      assert.deepEqual(
        state.runs.filter((run) => run.status === "queued").map((run) => run.userMessageId),
        [MessageId.make("manual"), MessageId.make("fresh")],
      );
      assert.equal(
        state.runs.find((run) => run.userMessageId === MessageId.make("old"))?.status,
        "cancelled",
      );
      assert.equal(state.thread.scheduledQueueSkippedCount, 1);
      const fresh = state.runs.find((run) => run.userMessageId === MessageId.make("fresh"))!;
      assert.isTrue(fresh.queueHeld);
      assert.isAbove(fresh.queuePosition!, held.queuePosition!);
      yield* dispatch("fresh", taskId);
      assert.equal((yield* projections.getThread(threadId)).scheduledQueueSkippedCount, 1);
      for (const messageId of ["fresh", "manual"]) {
        const run = state.runs.find((run) => run.userMessageId === MessageId.make(messageId))!;
        yield* orchestrator.dispatch({
          type: "queued-run.cancel",
          commandId: CommandId.make(`cancel:${messageId}`),
          threadId,
          runId: run.id,
        });
        state = yield* projections.getThreadProjection(threadId);
        assert.equal(state.thread.scheduledQueueSkippedCount, messageId === "fresh" ? 1 : 0);
      }
      yield* dispatch("new-queue", taskId);
      assert.equal((yield* projections.getThread(threadId)).scheduledQueueSkippedCount ?? 0, 0);
    }).pipe(Effect.provide(layerTest())),
);

it.effect.each(["replace_oldest", "skip_new"] as const)(
  "enforces the chat limit and counts %s exactly once",
  (overflow) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make(`thread:chat-limit:${overflow}`);
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create"),
        threadId,
        projectId: ProjectId.make("project:queue"),
        title: "Queue",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const send = (id: string, scheduledTaskId?: ScheduledTaskId) =>
        orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(id),
          threadId,
          messageId: MessageId.make(id),
          text: id,
          attachments: [],
          modelSelection,
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
          ...(scheduledTaskId === undefined ? {} : { scheduledTaskId }),
        });
      yield* send("active");
      for (let index = 0; index < 4; index++)
        yield* send(`schedule:${index}`, ScheduledTaskId.make(`task:${index}`));
      let state = yield* projections.getThreadProjection(threadId);
      const queued = state.runs.filter((run) => run.status === "queued");
      assert.equal(queued.length, 3);
      assert.deepEqual(
        queued.map((run) => run.userMessageId),
        (overflow === "skip_new" ? [0, 1, 2] : [1, 2, 3]).map((index) =>
          MessageId.make(`schedule:${index}`),
        ),
      );
      assert.equal(state.thread.scheduledQueueSkippedCount, 1);
      yield* send("schedule:3", ScheduledTaskId.make("task:3"));
      assert.equal((yield* projections.getThread(threadId)).scheduledQueueSkippedCount, 1);
      for (const run of queued.slice(0, 2))
        yield* orchestrator.dispatch({
          type: "queued-run.cancel",
          commandId: CommandId.make(`cancel:${run.id}`),
          threadId,
          runId: run.id,
        });
      const active = state.runs.find((run) => run.userMessageId === MessageId.make("active"))!;
      yield* projections.apply({
        type: "run.updated",
        id: EventId.make("finish-active"),
        threadId,
        runId: active.id,
        occurredAt: yield* DateTime.now,
        payload: { ...active, status: "completed", completedAt: yield* DateTime.now },
      });
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("start-last"),
        threadId,
      });
      state = yield* projections.getThreadProjection(threadId);
      assert.equal(state.runs.filter((run) => run.status === "queued").length, 0);
      assert.equal(state.thread.scheduledQueueSkippedCount, 0);
    }).pipe(Effect.provide(layerTest({ scheduledQueueOverflow: overflow }))),
);
