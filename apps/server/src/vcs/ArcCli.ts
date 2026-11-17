import * as NodeBuffer from "node:buffer";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  VcsProcessOutputReadError,
  VcsProcessOutputLimitError,
  type VcsError,
} from "@t3tools/contracts";

import * as VcsProcess from "./VcsProcess.ts";
const { Buffer } = NodeBuffer;

type ArcInput = Omit<VcsProcess.VcsProcessInput, "command">;
interface ArcOutput extends VcsProcess.VcsProcessOutput {
  readonly stdoutBytes: Uint8Array;
}

export class ArcCli extends Context.Service<
  ArcCli,
  {
    readonly run: (input: ArcInput) => Effect.Effect<ArcOutput, VcsError>;
    readonly runJson: <A>(input: ArcInput, schema: Schema.Codec<A>) => Effect.Effect<A, VcsError>;
  }
>()("t3/vcs/ArcCli") {}

const make = Effect.gen(function* () {
  const process = yield* VcsProcess.VcsProcess;
  const run = Effect.fn("ArcCli.run")(function* (input: ArcInput) {
    const chunks: Uint8Array[] = [];
    const limit = input.maxOutputBytes ?? 16 * 1024 * 1024;
    let bytes = 0;
    const output = yield* process.run({
      ...input,
      command: "arc",
      maxOutputBytes: limit,
      outputMode: "error",
      onStdoutChunk: (chunk) => {
        bytes += chunk.length;
        if (bytes <= limit) chunks.push(Buffer.from(chunk));
        input.onStdoutChunk?.(chunk);
      },
    });
    if (bytes > limit || output.stdoutTruncated)
      return yield* new VcsProcessOutputLimitError({
        operation: input.operation,
        command: "arc",
        cwd: input.cwd,
        stream: "stdout",
        maxBytes: limit,
        observedBytes: Math.max(bytes, limit + 1),
      });
    return { ...output, stdoutBytes: Buffer.concat(chunks) };
  });
  const runJson = Effect.fn("ArcCli.runJson")(function* <A>(
    input: ArcInput,
    schema: Schema.Codec<A>,
  ) {
    const output = yield* run(input);
    return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(output.stdout).pipe(
      Effect.mapError(
        (cause) =>
          new VcsProcessOutputReadError({
            operation: input.operation,
            command: "arc",
            cwd: input.cwd,
            stream: "stdout",
            cause,
          }),
      ),
    );
  });
  return ArcCli.of({ run, runJson });
});

export const layer = Layer.effect(ArcCli, make);
