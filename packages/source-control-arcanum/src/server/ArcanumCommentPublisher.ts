import * as Path from "effect/Path";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Hex from "effect/encoding/Hex";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as ArcanumApi from "./ArcanumApi.ts";
import { Id } from "./ArcanumPullRequestApi.ts";

interface PublishInput {
  readonly cwd: string;
  readonly number: number;
  readonly viewer: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly diff?: string | number;
  readonly intentId?: string;
}
const Created = Schema.Struct({ id: Id, reply_to_id: Schema.optional(Schema.NullOr(Id)) });
const Pending = Schema.Struct({
  key: Schema.NonEmptyString,
  payloadDigest: Schema.String,
  completed: Schema.optional(Created),
});
const decodePending = Schema.decodeEffect(Schema.fromJsonString(Pending));
const encodePending = Schema.encodeEffect(Schema.fromJsonString(Pending));
const encodePayload = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const makeArcanumCommentPublisher = Effect.fn("ArcanumCommentPublisher.make")(function* () {
  const api = yield* ArcanumApi.ArcanumApi;
  const host = yield* SourceControlHost.SourceControlHost;
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;
  const permit = yield* Semaphore.make(1);
  const error = (operation: string) =>
    new ArcanumApi.ArcanumApiError({ operation, reason: "failed" });
  const io = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError(() => error(operation)));
  const digest = Effect.fn("ArcanumCommentPublisher.digest")(function* (value: string) {
    return yield* crypto.digest("SHA-256", new TextEncoder().encode(value)).pipe(
      Effect.map(Hex.encode),
      Effect.mapError(() => error("commentDigest")),
    );
  });
  const publish = Effect.fn("ArcanumCommentPublisher.publish")(function (input: PublishInput) {
    return permit.withPermit(
      Effect.scoped(
        Effect.gen(function* () {
          if (!host.stateDirectory || !path.isAbsolute(host.stateDirectory))
            return yield* error("commentStateDirectory");
          const root = yield* io(
            "commentCheckout",
            host.process.run({
              cwd: input.cwd,
              command: "arc",
              operation: "ArcanumCommentPublisher.root",
              args: ["root"],
              maxOutputBytes: 65_536,
              outputMode: "error",
            }),
          );
          if (!path.isAbsolute(root.stdout.trim())) return yield* error("commentCheckout");
          const stateDirectory = yield* io(
            "commentStateDirectory",
            fs.realPath(host.stateDirectory),
          );
          const relative = path.relative(root.stdout.trim(), stateDirectory);
          if (
            relative === "" ||
            (!relative.startsWith(`..${path.sep}`) &&
              relative !== ".." &&
              !path.isAbsolute(relative))
          )
            return yield* error("commentStateInsideArc");
          const payload = yield* io("commentPayload", encodePayload(input.body));
          const payloadDigest = yield* digest(payload);
          const identity = yield* digest(
            `${input.viewer}\0${input.number}\0${input.diff ?? "pr"}\0${input.intentId ?? payloadDigest}`,
          );
          const directory = path.join(stateDirectory, "arcanum-requests");
          yield* io(
            "commentIntentDirectory",
            fs.makeDirectory(directory, { recursive: true, mode: 0o700 }),
          );
          const file = path.join(directory, `${identity}.json`);
          if (!(yield* io("commentIntentExists", fs.exists(file)))) {
            const key = yield* io("commentIdempotencyKey", crypto.randomUUIDv4());
            const temporary = yield* io(
              "commentIntentTemporary",
              fs.makeTempFileScoped({ directory, prefix: ".intent-" }),
            );
            const encoded = yield* io("commentIntentEncode", encodePending({ key, payloadDigest }));
            yield* io(
              "commentIntentWrite",
              fs.writeFileString(temporary, encoded, { mode: 0o600 }),
            );
            const linked = yield* fs.link(temporary, file).pipe(Effect.result);
            if (linked._tag === "Failure" && !(yield* io("commentIntentExists", fs.exists(file))))
              return yield* error("commentIntentPublish");
          }
          const pending = yield* io(
            "commentIntentRead",
            fs.readFileString(file).pipe(Effect.flatMap(decodePending)),
          );
          if (pending.payloadDigest !== payloadDigest) return yield* error("commentIntentIdentity");
          if (pending.completed) return pending.completed;
          const endpoint =
            input.diff === undefined
              ? `/v2/public/pull-request/${input.number}/comment`
              : `/v2/public/diff/${encodeURIComponent(String(input.diff))}/comment`;
          const result = yield* api.request(
            {
              cwd: input.cwd,
              operation: "comment",
              method: "POST",
              path: `${endpoint}?fields=id,reply_to_id`,
              body: input.body,
              idempotencyKey: pending.key,
            },
            Created,
          );
          if (!/^-?[1-9]\d*$/u.test(String(result.id))) return yield* error("commentReadback");
          if (
            input.body.reply_to_id !== undefined &&
            String(result.reply_to_id) !== String(input.body.reply_to_id)
          )
            return yield* error("commentReplyReadback");
          if (input.intentId) {
            const completed = yield* io(
              "commentIntentCompleteTemporary",
              fs.makeTempFileScoped({ directory, prefix: ".complete-" }),
            );
            yield* io(
              "commentIntentCompleteWrite",
              fs.writeFileString(
                completed,
                yield* io(
                  "commentIntentCompleteEncode",
                  encodePending({ ...pending, completed: result }),
                ),
                { mode: 0o600 },
              ),
            );
            yield* io("commentIntentComplete", fs.rename(completed, file));
          } else yield* io("commentIntentComplete", fs.remove(file));
          return result;
        }),
      ),
    );
  });
  return { publish };
});
