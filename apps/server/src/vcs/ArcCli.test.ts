import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";

import * as ArcCli from "./ArcCli.ts";
import * as VcsProcess from "./VcsProcess.ts";

describe("Arc CLI", () => {
  it.effect("preserves binary stdout and rejects malformed JSON", () =>
    Effect.gen(function* () {
      const cli = yield* ArcCli.ArcCli;
      const input = { operation: "probe", cwd: "/repo", args: ["show", "HEAD:file"] };
      const output = yield* cli.run(input);
      assert.deepEqual([...output.stdoutBytes], [0, 255, 128, 10]);
      const result = yield* cli
        .runJson(input, Schema.Struct({ hash: Schema.String }))
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      const bounded = yield* cli.run({ ...input, maxOutputBytes: 3 }).pipe(Effect.result);
      assert.equal(bounded._tag, "Failure");
    }).pipe(
      Effect.provide(
        ArcCli.layer.pipe(
          Layer.provide(
            Layer.mock(VcsProcess.VcsProcess)({
              run: (input) =>
                Effect.sync(() => {
                  assert.equal(input.command, "arc");
                  assert.deepEqual(input.args, ["show", "HEAD:file"]);
                  input.onStdoutChunk?.(new Uint8Array([0, 255, 128, 10]));
                  return {
                    exitCode: ChildProcessSpawner.ExitCode(0),
                    stdout: "\u0000��\n",
                    stderr: "",
                    stdoutTruncated: false,
                    stderrTruncated: false,
                  };
                }),
            }),
          ),
        ),
      ),
    ),
  );
});
