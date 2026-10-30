import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE thread_snooze_dependencies (
      thread_id TEXT PRIMARY KEY,
      dependency_id TEXT NOT NULL UNIQUE,
      target_thread_id TEXT NOT NULL,
      until_kind TEXT NOT NULL,
      start_sequence INTEGER NOT NULL,
      visibility_sequence INTEGER NOT NULL,
      visibility TEXT NOT NULL,
      revision INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX thread_snooze_dependencies_target_idx
    ON thread_snooze_dependencies(target_thread_id, thread_id)
  `;
  yield* sql`
    CREATE TABLE thread_snooze_undo (
      thread_id TEXT PRIMARY KEY,
      dependency_id TEXT NOT NULL,
      target_thread_id TEXT NOT NULL,
      until_kind TEXT NOT NULL,
      start_sequence INTEGER NOT NULL,
      visibility_sequence INTEGER NOT NULL,
      visibility TEXT NOT NULL,
      revision INTEGER NOT NULL,
      action_command_id TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX thread_snooze_undo_target_idx ON thread_snooze_undo(target_thread_id)`;
  yield* sql`
    CREATE TABLE thread_snooze_transitions (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      target_thread_id TEXT NOT NULL,
      event_id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE thread_snooze_transition_cursor (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      sequence INTEGER NOT NULL,
      after_thread_id TEXT
    )
  `;
  yield* sql`CREATE INDEX thread_snooze_transitions_target_idx ON thread_snooze_transitions(target_thread_id, sequence)`;
  yield* sql`INSERT INTO thread_snooze_transition_cursor (id, sequence) VALUES (1, 0)`;
});
