import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE thread_approval_attention (
      thread_id TEXT PRIMARY KEY,
      last_attention_sequence INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE remote_task_approval_observations (
      parent_thread_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      remote_environment_id TEXT NOT NULL,
      remote_thread_id TEXT NOT NULL,
      snapshot_sequence INTEGER NOT NULL,
      last_attention_sequence INTEGER NOT NULL,
      pending_approval_count INTEGER NOT NULL,
      PRIMARY KEY (parent_thread_id, task_id)
    )
  `;
  yield* sql`
    WITH RECURSIVE affected(thread_id, path) AS (
      SELECT DISTINCT r.thread_id, ',' || r.thread_id || ','
      FROM orchestration_v2_projection_runtime_requests r
      WHERE r.status = 'pending' AND r.kind NOT IN ('user_input', 'auth_refresh', 'dynamic_tool_call')
        AND EXISTS (SELECT 1 FROM orchestration_v2_projection_runs run WHERE run.thread_id = r.thread_id AND run.status IN ('preparing', 'starting', 'running', 'waiting'))
      UNION ALL
      SELECT json_extract(t.payload_json, '$.lineage.parentThreadId'), a.path || t.thread_id || ','
      FROM affected a JOIN orchestration_v2_projection_threads t ON t.thread_id = a.thread_id
      WHERE json_extract(t.payload_json, '$.lineage.relationshipToParent') = 'subagent'
        AND json_extract(t.payload_json, '$.creationSource') != 'provider'
        AND instr(a.path, ',' || json_extract(t.payload_json, '$.lineage.parentThreadId') || ',') = 0
    )
    INSERT INTO thread_approval_attention(thread_id, last_attention_sequence)
    SELECT thread_id, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'orchestration_events'), 0)
    FROM affected WHERE thread_id IS NOT NULL GROUP BY thread_id
  `;
});
