import { SettingsSecretValue, requireSettingsSecretLiteral } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import { readSourceControlHostSettings } from "@t3tools/source-control-core/shared/definition";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { definition, settings as ArcanumSettingsSchema } from "../shared/definition.ts";

const decodeLegacySettings = Schema.decodeUnknownOption(
  Schema.Struct({
    tokens: Schema.optional(Schema.Record(Schema.String, SettingsSecretValue)),
    hosts: Schema.optional(
      Schema.Record(Schema.String, Schema.Struct({ enabled: Schema.optional(Schema.Boolean) })),
    ),
  }),
);

const ARC_TOKEN_TTL = Duration.minutes(5);
const ARC_MISSING_TTL = Duration.seconds(10);
const ARC_TOKEN_TIMEOUT_MS = 15_000;

/** Where a credential came from, in the order they are tried. */
export type ArcanumCredentialSource = "settings" | "env" | "file" | "arc";

export interface ArcanumCredential {
  readonly token: Redacted.Redacted<string>;
  readonly source: ArcanumCredentialSource;
  /** A digest of the token, never the token: equal fingerprints are the same credential. */
  readonly fingerprint: string;
}

export class ArcanumCredentialMissingError extends Schema.TaggedError<ArcanumCredentialMissingError>()(
  "ArcanumCredentialMissingError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export class ArcanumCredentialFailedError extends Schema.TaggedError<ArcanumCredentialFailedError>()(
  "ArcanumCredentialFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "`arc token show` could not hand over a token. Check it on the server.";
  }
}

export type ArcanumCredentialError = ArcanumCredentialMissingError | ArcanumCredentialFailedError;

export const MISSING_CREDENTIAL_DETAIL =
  "No Arcanum token on the server: save one in Settings → Source control, set ARC_TOKEN, or sign Arc in so `arc token show` works.";

/** What to change when Arcanum refuses the token `source` supplied. */
export function rejectedCredentialDetail(source: ArcanumCredentialSource): string {
  switch (source) {
    case "settings":
      return "Arcanum refused the token saved in Settings → Source control. Save a new one.";
    case "env":
      return "Arcanum refused the server's ARC_TOKEN. Replace or unset it.";
    case "file":
      return "Arcanum refused the token in ~/.arc/token on the server. Replace or remove it.";
    case "arc":
      return "Arcanum refused the token `arc token show` gave. Refresh Arc's sign-in on the server.";
  }
}

const decodeArcTokenShow = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ token: Schema.String, type: Schema.optional(Schema.String) }),
  ),
);

export class ArcanumCredentials extends Context.Service<
  ArcanumCredentials,
  {
    /** Settings are read on every call, so a changed token or secret reference applies at once. */
    readonly get: Effect.Effect<ArcanumCredential, ArcanumCredentialError>;
    /** Forgets a refused credential its source may since have replaced. */
    readonly invalidate: (credential: ArcanumCredential) => Effect.Effect<void>;
  }
>()("@t3tools/source-control-arcanum/server/ArcanumCredentials") {}

export const makeWithHost = Effect.fn("ArcanumCredentials.makeWithHost")(function* (host: {
  readonly settings: Pick<
    SourceControlHost.SourceControlHost["Service"]["settings"],
    "getWithSecrets"
  >;
  readonly process: SourceControlHost.SourceControlHost["Service"]["process"];
}) {
  const digests = yield* Digest.Digest;
  const fileSystem = yield* FileSystem.FileSystem;
  const environment = yield* HostProcess.Environment;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const workingDirectory = yield* HostProcess.WorkingDirectory;

  const credential = (token: string, source: ArcanumCredentialSource) =>
    digests.digest(Digest.sha256, new TextEncoder().encode(token)).pipe(
      Effect.map((digest): ArcanumCredential => ({
        token: Redacted.make(token),
        source,
        fingerprint: `arcanum:${Hex.encode(digest)}`,
      })),
    );

  const fromSettings = host.settings.getWithSecrets(definition.kind).pipe(
    Effect.mapError(
      () =>
        new ArcanumCredentialMissingError({
          detail:
            "Could not read Arcanum credentials from Settings. Check the server settings before retrying.",
        }),
    ),
    Effect.flatMap((current) => {
      const raw = current.sourceControlHosts[definition.kind];
      const legacy = Option.getOrUndefined(decodeLegacySettings(raw));
      if (legacy?.hosts?.["a.yandex-team.ru"]?.enabled === false)
        return Effect.fail(
          new ArcanumCredentialMissingError({ detail: "Arcanum is disabled in Settings." }),
        );
      const saved = readSourceControlHostSettings(ArcanumSettingsSchema, raw).token;
      return requireSettingsSecretLiteral(
        saved || legacy?.tokens?.["a.yandex-team.ru"] || "",
        {},
      ).pipe(
        Effect.mapError((error) => new ArcanumCredentialMissingError({ detail: error.message })),
        Effect.map((token) => token.trim() || null),
      );
    }),
  );

  const fromFile = fileSystem
    // Forward slashes also work on Windows.
    .readFileString(`${homeDirectory.replace(/[\\/]+$/u, "")}/.arc/token`)
    .pipe(
      Effect.map((text) => text.trim() || null),
      Effect.orElseSucceed(() => null),
    );

  // Fixed arguments: the token only ever travels on stdout.
  const fromArc = host.process
    .run({
      operation: "ArcanumCredentials.arcTokenShow",
      command: "arc",
      args: ["token", "show", "--json"],
      cwd: workingDirectory,
      timeoutMs: ARC_TOKEN_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024,
      outputMode: "error",
    })
    .pipe(
      Effect.mapError((error) =>
        error._tag === "VcsProcessSpawnError" &&
        error.cause instanceof PlatformError.PlatformError &&
        error.cause.reason._tag === "NotFound"
          ? new ArcanumCredentialMissingError({ detail: MISSING_CREDENTIAL_DETAIL })
          : error._tag === "VcsProcessExitError"
            ? new ArcanumCredentialMissingError({ detail: MISSING_CREDENTIAL_DETAIL })
            : new ArcanumCredentialFailedError({ cause: error }),
      ),
      Effect.filterOrFail(
        (output) => output.exitCode === 0,
        () => new ArcanumCredentialMissingError({ detail: MISSING_CREDENTIAL_DETAIL }),
      ),
      Effect.flatMap((output) =>
        decodeArcTokenShow(output.stdout).pipe(
          // The parse error would quote stdout, which holds the token.
          Effect.mapError(
            () =>
              new ArcanumCredentialFailedError({
                cause: "`arc token show --json` printed something this version cannot read.",
              }),
          ),
        ),
      ),
      Effect.flatMap(({ token }) =>
        token.trim().length === 0
          ? Effect.fail(new ArcanumCredentialMissingError({ detail: MISSING_CREDENTIAL_DETAIL }))
          : credential(token.trim(), "arc"),
      ),
    );

  const arcCache = yield* Cache.makeWith((_: "arc") => fromArc, {
    capacity: 1,
    timeToLive: (exit) =>
      Exit.isSuccess(exit)
        ? ARC_TOKEN_TTL
        : Exit.findErrorOption(exit).pipe(
              Option.exists((error) => error._tag === "ArcanumCredentialMissingError"),
            )
          ? ARC_MISSING_TTL
          : Duration.zero,
  });

  const get = Effect.gen(function* () {
    const saved = yield* fromSettings;
    if (saved !== null) return yield* credential(saved, "settings");
    const env = environment.ARCANUM_TOKEN?.trim() || environment.ARC_TOKEN?.trim();
    if (env) return yield* credential(env, "env");
    const file = yield* fromFile;
    if (file !== null) return yield* credential(file, "file");
    return yield* Cache.get(arcCache, "arc");
  }).pipe(Effect.withSpan("ArcanumCredentials.get"));

  return ArcanumCredentials.of({
    get,
    invalidate: Effect.fn("ArcanumCredentials.invalidate")(function* (refused) {
      if (refused.source === "arc") yield* Cache.invalidate(arcCache, "arc");
    }),
  });
});

/** @public */
export const make = Effect.gen(function* () {
  return yield* makeWithHost(yield* SourceControlHost.SourceControlHost);
});

export const layer = Layer.effect(ArcanumCredentials, make);
