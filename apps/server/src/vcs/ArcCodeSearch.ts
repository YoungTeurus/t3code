import * as NodeModule from "node:module";
import * as NodeTls from "node:tls";

import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Context from "effect/Context";
import * as ArcanumCredentials from "@t3tools/source-control-arcanum/server/credentials";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import * as VcsProcess from "./VcsProcess.ts";
import * as Redacted from "effect/Redacted";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as Undici from "undici";

import type { ProjectContentMatch, ProjectEntry, ProjectSearchSource } from "@t3tools/contracts";
import { isProjectFaviconPath, PROJECT_FAVICON_EXTENSIONS } from "@t3tools/shared/projectFavicon";
import { scoreQueryMatch } from "@t3tools/shared/searchRanking";

import * as ArcOperations from "./ArcOperations.ts";
const rootToCwdRelative = (prefix: string, file: string) => {
  const relative = prefix
    ? file.startsWith(prefix + "/")
      ? file.slice(prefix.length + 1)
      : null
    : file;
  return relative &&
    !relative.split("/").some((part) => part === ".." || part === ".arc" || part === ".git") &&
    !relative.startsWith("/")
    ? relative
    : null;
};
import * as VcsDriver from "./VcsDriver.ts";
import { YANDEX_INTERNAL_ROOT_CA } from "./yandexInternalRootCa.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveSourceControlHostSecrets } from "../sourceControl/sourceControlHostSecrets.ts";

// undici is external to the CLI bundle; Node single-executables can load it from disk only with require.
const requireUndici = NodeModule.createRequire(import.meta.url);

const SEARCH_URLS = {
  arcadia: "https://codesearch.yandex-team.ru/search",
  cloudia: "https://cloudia.codesearch.yandex-team.ru/search",
} as const;
type SearchRepository = keyof typeof SEARCH_URLS;
const PinnedCredential = Context.Reference<ArcanumCredentials.ArcanumCredential | null>(
  "t3/vcs/ArcCodeSearch/PinnedCredential",
  { defaultValue: () => null },
);
const REQUEST_TIMEOUT = Duration.seconds(10);
/** Paths fetched per path query before local ranking picks the best `limit`. */
const PATH_CANDIDATES = 500;
const MAX_MATCHES_PER_FILE = 100;
const CACHE_CAPACITY = 64;
const CACHE_TTL = Duration.seconds(30);
const REGEX_ERROR_MAX_LENGTH = 300;

/** The subset of FCS `TRequest` (devtools/codesearch/fcs/api/proto/api.proto) T3 sends. */
const FcsQuery = Schema.Struct({
  Regex: Schema.String,
  FileRegex: Schema.String,
  CaseSensitive: Schema.Boolean,
  IsPureLiteral: Schema.Boolean,
  WholeWords: Schema.Boolean,
  MaxMatches: Schema.Number,
  MaxMatchesPerDoc: Schema.Number,
});
type FcsQuery = typeof FcsQuery.Type;
const FcsCacheKey = Schema.fromJsonString(
  Schema.Struct({
    cwd: Schema.String,
    repository: Schema.Literals(["arcadia", "cloudia"]),
    credential: Schema.String,
    query: FcsQuery,
  }),
);
const encodeCacheKey = Schema.encodeSync(FcsCacheKey);
const decodeCacheKey = Schema.decodeSync(FcsCacheKey);

const FcsStats = Schema.Struct({
  Error: Schema.optional(Schema.String),
  IndexRevision: Schema.optional(Schema.String),
  Overflow: Schema.optional(Schema.Boolean),
});

const FcsResponse = Schema.Struct({
  Chunks: Schema.optional(
    Schema.Array(
      Schema.Struct({
        CodeChunk: Schema.optional(
          Schema.Struct({
            File: Schema.String,
            Matches: Schema.optional(
              Schema.Array(
                Schema.Struct({
                  Snippet: Schema.optional(Schema.String),
                  FirstLine: Schema.optional(Schema.Number),
                  Ranges: Schema.optional(
                    Schema.Array(Schema.Struct({ From: Schema.Number, To: Schema.Number })),
                  ),
                }),
              ),
            ),
          }),
        ),
        FileChunk: Schema.optional(Schema.Struct({ File: Schema.String })),
      }),
    ),
  ),
  Stats: Schema.optional(FcsStats),
  MetaStats: Schema.optional(FcsStats),
});
type FcsResponse = typeof FcsResponse.Type;
const decodeResponse = Schema.decodeUnknownOption(Schema.fromJsonString(FcsResponse));

type FcsAnswer =
  | { readonly _tag: "Results"; readonly response: FcsResponse }
  | { readonly _tag: "InvalidRegex"; readonly error: string };

/** RE2 and JavaScript share these escapes for literal text. */
const escapeRegex = (value: string) => value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");

const IMAGE_SUFFIX = `(?:${PROJECT_FAVICON_EXTENSIONS.map(escapeRegex).join("|")})$`;

const sourceOf = (response: FcsResponse, repository: SearchRepository): ProjectSearchSource => {
  const revision = (response.Stats ?? response.MetaStats)?.IndexRevision?.trim();
  return revision ? { index: `${repository}/trunk`, revision } : { index: `${repository}/trunk` };
};

const overflowed = (response: FcsResponse) =>
  (response.Stats ?? response.MetaStats)?.Overflow === true;

const parentsOf = (path: string) => {
  const parents: string[] = [];
  for (let index = path.indexOf("/"); index !== -1; index = path.indexOf("/", index + 1)) {
    parents.push(path.slice(0, index));
  }
  return parents;
};

/** Lower scores rank first: basename matches lead, then path matches, then shorter paths. */
const rankPath = (path: string, token: string) => {
  const lower = path.toLowerCase();
  const name = lower.slice(lower.lastIndexOf("/") + 1);
  return (
    scoreQueryMatch({
      value: name,
      query: token,
      exactBase: 0,
      prefixBase: 10,
      boundaryBase: 20,
      includesBase: 30,
    }) ??
    scoreQueryMatch({ value: lower, query: token, exactBase: 100, includesBase: 100 }) ??
    1_000
  );
};

const byteRangesToStringRanges = (
  line: string,
  ranges: ReadonlyArray<{ readonly From: number; readonly To: number }>,
) => {
  const bytes = Buffer.from(line);
  const toIndex = (offset: number) => bytes.subarray(0, offset).toString().length;
  return ranges
    .filter((range) => range.From < range.To && range.From < bytes.length)
    .map((range) => ({
      start: toIndex(range.From),
      end: toIndex(Math.min(range.To, bytes.length)),
    }));
};

const describeTransportFailure = (cause: unknown) => {
  // Undici reports TLS trust failures as a code on the fetch error's cause.
  let current: unknown = cause;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    const code = (current as { readonly code?: unknown }).code;
    if (typeof code === "string" && /CERT|SSL|TLS/.test(code)) {
      return `Code Search's TLS certificate is not trusted (${code}). If a proxy re-signs HTTPS traffic, add its CA to NODE_EXTRA_CA_CERTS for the T3 server.`;
    }
    current = (current as { readonly cause?: unknown }).cause;
  }
  return "Could not reach Code Search. Check the network or VPN.";
};

const statusReason = (status: number) =>
  status === 404
    ? "Code Search has no index for this repository."
    : status === 429
      ? "Code Search is rate limiting requests. Try again shortly."
      : status >= 500
        ? `Code Search failed (HTTP ${status}).`
        : `Code Search refused the query (HTTP ${status}).`;

/**
 * Project search for Arc checkouts through Fast Code Search: the repository's trunk index, scoped to
 * the project's folder. Nothing reads the checkout tree, and failures stay failures.
 */
export const makeArcCodeSearch = Effect.fnUntraced(function* (
  cli: ArcOperations.ArcOperations["Service"],
) {
  const failCredential = (cwd: string, detail: string) =>
    new VcsDriver.VcsWorkspaceSearchError({
      cwd,
      reason: `${detail} Cloudia Code Search needs codesearch:search access.`,
    });
  const process = yield* VcsProcess.VcsProcess;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const credentials = yield* ArcanumCredentials.makeWithHost({
    process,
    settings: {
      getWithSecrets: Effect.fn("ArcCodeSearch.settings")(function* (kind: string) {
        const service = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
        if (Option.isNone(service)) return DEFAULT_SERVER_SETTINGS;
        const settings = yield* service.value.getSettings;
        const secrets = yield* Effect.serviceOption(SecretResolver.SecretResolver);
        if (Option.isNone(secrets)) return settings;
        const sourceControlHosts = yield* resolveSourceControlHostSecrets(
          secrets.value,
          settings.sourceControlHosts,
          kind,
        );
        return { ...settings, sourceControlHosts };
      }),
    },
  });
  // Many layers build the registry without an HTTP client, so fetch is the default.
  const provided = yield* Effect.serviceOption(HttpClient.HttpClient);
  const httpClient = Option.isSome(provided)
    ? provided.value
    : yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));
  // Code Search's certificate chains to the Yandex internal root, so trust it without NODE_EXTRA_CA_CERTS.
  // Node's built-in fetch rejects npm undici's Agent, so these requests use npm undici's fetch.
  const undici = requireUndici("undici") as typeof Undici;
  const dispatcher = new undici.Agent({
    connect: { ca: [...NodeTls.getCACertificates("default"), YANDEX_INTERNAL_ROOT_CA] },
  });
  const fetchTrustingYandexRoot = ((input: Undici.RequestInfo, init?: Undici.RequestInit) =>
    undici.fetch(input, { ...init, dispatcher })) as unknown as typeof globalThis.fetch;

  const fetchAnswer = Effect.fn("ArcCodeSearch.fetch")(function* (
    key: string,
  ): Effect.fn.Return<FcsAnswer, VcsDriver.VcsWorkspaceSearchError> {
    const { cwd, repository, query: fields } = decodeCacheKey(key);
    const credential = yield* PinnedCredential;
    const fail = (reason: string, cause?: unknown) =>
      new VcsDriver.VcsWorkspaceSearchError({
        cwd,
        reason,
        ...(cause === undefined ? {} : { cause }),
      });
    const request = HttpClientRequest.post(SEARCH_URLS[repository]).pipe(
      HttpClientRequest.setHeaders({
        accept: "application/json",
        "user-agent": "t3code",
        ...(credential === null
          ? {}
          : { authorization: `OAuth ${Redacted.value(credential.token)}` }),
      }),
      HttpClientRequest.bodyJsonUnsafe({
        Repository: repository,
        ...fields,
        Format: "json",
        ChunkedResponse: false,
      }),
    );
    const response = yield* httpClient.execute(request).pipe(
      // Spans would record the query.
      Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
      Effect.provideService(FetchHttpClient.Fetch, fetchTrustingYandexRoot),
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      Effect.flatMap((raw) => raw.text.pipe(Effect.map((text) => ({ status: raw.status, text })))),
      Effect.mapError((cause) => fail(describeTransportFailure(cause), cause)),
      Effect.timeoutOrElse({
        duration: REQUEST_TIMEOUT,
        orElse: () =>
          Effect.fail(
            fail(`Code Search did not answer within ${Duration.format(REQUEST_TIMEOUT)}.`),
          ),
      }),
    );
    const decoded = decodeResponse(response.text);
    if (repository === "cloudia" && (response.status === 401 || response.status === 403)) {
      if (credential !== null) yield* credentials.invalidate(credential);
      return yield* failCredential(
        cwd,
        credential === null
          ? ArcanumCredentials.MISSING_CREDENTIAL_DETAIL
          : ArcanumCredentials.rejectedCredentialDetail(credential.source),
      );
    }
    if (response.status === 400 && !fields.IsPureLiteral && Option.isSome(decoded)) {
      const error = (decoded.value.Stats ?? decoded.value.MetaStats)?.Error ?? "";
      if (error.startsWith("Failed to parse regex")) {
        return { _tag: "InvalidRegex", error: error.slice(0, REGEX_ERROR_MAX_LENGTH) };
      }
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* fail(statusReason(response.status));
    }
    if (Option.isNone(decoded)) {
      return yield* fail("Code Search answered in an unexpected format.");
    }
    if ((decoded.value.Stats ?? decoded.value.MetaStats)?.Error && !decoded.value.Chunks?.length) {
      return yield* fail("Code Search reported an error for this query.");
    }
    return { _tag: "Results", response: decoded.value };
  });

  // Typing re-sends the same query. A short-lived bounded cache answers repeats and refreshes.
  const answers = yield* Cache.makeWith(fetchAnswer, {
    capacity: CACHE_CAPACITY,
    timeToLive: Exit.match({ onSuccess: () => CACHE_TTL, onFailure: () => Duration.zero }),
  });

  const query = Effect.fnUntraced(function* (
    cwd: string,
    repository: SearchRepository,
    fields: FcsQuery,
  ) {
    const credential =
      repository === "cloudia"
        ? yield* credentials.get.pipe(
            Effect.mapError((error) => failCredential(cwd, error.message)),
          )
        : null;
    return yield* Cache.get(
      answers,
      encodeCacheKey({ cwd, repository, credential: credential?.fingerprint ?? "", query: fields }),
    ).pipe(Effect.provideService(PinnedCredential, credential));
  });

  const results = Effect.fnUntraced(function* (
    cwd: string,
    repository: SearchRepository,
    fields: FcsQuery,
  ) {
    const answer = yield* query(cwd, repository, fields);
    if (answer._tag === "InvalidRegex") {
      return yield* new VcsDriver.VcsWorkspaceSearchError({
        cwd,
        reason: "Invalid regular expression.",
      });
    }
    return answer.response;
  });

  /** The project's folder relative to the repository root, from Arc's own `rev-parse`. */
  const scopeOf = Effect.fn("ArcCodeSearch.scope")(function* (cwd: string) {
    const repo = yield* cli.context(cwd).pipe(
      Effect.mapError(
        (cause) =>
          new VcsDriver.VcsWorkspaceSearchError({
            cwd,
            reason: "Arc could not resolve this checkout.",
            cause,
          }),
      ),
    );
    if (repo === null) {
      return yield* new VcsDriver.VcsWorkspaceSearchError({
        cwd,
        reason: "This folder is not inside an Arc checkout.",
      });
    }
    const repository = repo.repository;
    const config = yield* fs
      .readFileString(path.join(repo.root, ".arc", "config"))
      .pipe(Effect.orElseSucceed(() => ""));
    const server = /^Server\s*\{([^}]*)\}/m.exec(config)?.[1];
    const host = server === undefined ? null : /Host:\s*"([^"\n]+)"/.exec(server)?.[1];
    if (
      (repository !== "arcadia" && repository !== "cloudia") ||
      !host ||
      (repository === "cloudia" && host !== "arc-vcs.yandex-team.ru")
    ) {
      return yield* new VcsDriver.VcsWorkspaceSearchError({
        cwd,
        reason: "This Arc repository has no trusted Code Search index.",
      });
    }
    const prefix = repo.scope === "." ? "" : repo.scope.replaceAll("\\", "/");
    return {
      repository: repository as SearchRepository,
      prefix,
      pattern: prefix === "" ? "^" : `^${escapeRegex(prefix)}/`,
    };
  });

  const searchEntries: VcsDriver.VcsWorkspaceSearch["searchEntries"] = Effect.fn(
    "ArcCodeSearch.searchEntries",
  )(function* (input) {
    const scope = yield* scopeOf(input.cwd);
    const tokens = input.query.split(/\s+/).filter((token) => token.length > 0);
    // An empty query would list the index. Only the image picker asks for that.
    if (tokens.length === 0 && !input.imageOnly) {
      return { entries: [], truncated: false, source: { index: `${scope.repository}/trunk` } };
    }
    const body = tokens.map(escapeRegex).join(".*");
    const wantsFiles = input.kind !== "directory";
    const wantsDirectories = input.kind !== "file" && !input.imageOnly && tokens.length > 0;
    const pathQuery = (fileRegex: string) => ({
      Regex: "",
      FileRegex: fileRegex,
      CaseSensitive: false,
      IsPureLiteral: false,
      WholeWords: false,
      MaxMatches: PATH_CANDIDATES,
      MaxMatchesPerDoc: 1,
    });
    const [files, directories] = yield* Effect.all(
      [
        wantsFiles
          ? results(
              input.cwd,
              scope.repository,
              pathQuery(`${scope.pattern}.*${body}[^/]*${input.imageOnly ? IMAGE_SUFFIX : "$"}`),
            )
          : Effect.succeed(null),
        // Folders are not indexed. Parents of files below a matching folder stand in.
        wantsDirectories
          ? results(input.cwd, scope.repository, pathQuery(`${scope.pattern}.*${body}[^/]*/`))
          : Effect.succeed(null),
      ],
      { concurrency: "unbounded" },
    );
    const relativeFiles = (response: FcsResponse | null) =>
      (response?.Chunks ?? []).flatMap((chunk) => {
        const file = chunk.FileChunk?.File ?? chunk.CodeChunk?.File;
        const relative = file === undefined ? null : rootToCwdRelative(scope.prefix, file);
        return relative ? [relative] : [];
      });
    const entries = new Map<string, ProjectEntry>();
    for (const path of relativeFiles(files)) {
      if (!input.imageOnly || isProjectFaviconPath(path)) entries.set(path, { path, kind: "file" });
    }
    const directoryPattern = new RegExp(`${tokens.map(escapeRegex).join(".*")}[^/]*$`, "i");
    for (const path of relativeFiles(directories)) {
      for (const parent of parentsOf(path)) {
        if (!entries.has(parent) && directoryPattern.test(parent)) {
          entries.set(parent, { path: parent, kind: "directory" });
        }
      }
    }
    const token = (tokens.at(-1) ?? "").toLowerCase();
    const ranked = [...entries.values()]
      .map((entry) => ({ entry, score: rankPath(entry.path, token) }))
      .toSorted(
        (left, right) =>
          left.score - right.score ||
          left.entry.path.length - right.entry.path.length ||
          left.entry.path.localeCompare(right.entry.path),
      );
    const answered = files ?? directories;
    return {
      entries: ranked.slice(0, input.limit).map(({ entry }) => entry),
      truncated:
        ranked.length > input.limit ||
        (files !== null && overflowed(files)) ||
        (directories !== null && overflowed(directories)),
      source:
        answered === null
          ? { index: `${scope.repository}/trunk` }
          : sourceOf(answered, scope.repository),
    };
  });

  const searchContents: VcsDriver.VcsWorkspaceSearch["searchContents"] = Effect.fn(
    "ArcCodeSearch.searchContents",
  )(function* (input) {
    const scope = yield* scopeOf(input.cwd);
    const answer = yield* query(input.cwd, scope.repository, {
      Regex: input.query,
      FileRegex: scope.pattern === "^" ? "" : scope.pattern,
      CaseSensitive: input.caseSensitive,
      IsPureLiteral: !input.useRegex,
      WholeWords: input.wholeWord,
      MaxMatches: input.limit + 1,
      MaxMatchesPerDoc: MAX_MATCHES_PER_FILE,
    });
    if (answer._tag === "InvalidRegex") {
      return {
        matches: [],
        truncated: false,
        regexFallbackError: answer.error,
        source: { index: `${scope.repository}/trunk` },
      };
    }
    const matches: ProjectContentMatch[] = [];
    for (const chunk of answer.response.Chunks ?? []) {
      const code = chunk.CodeChunk;
      const path = code === undefined ? null : rootToCwdRelative(scope.prefix, code.File);
      if (!code || !path) continue;
      for (const match of code.Matches ?? []) {
        const lineNumber = match.FirstLine ?? 0;
        if (!Number.isInteger(lineNumber) || lineNumber < 1) continue;
        // Without context lines a snippet is the matched line. Keep only that line.
        const lineContent = (match.Snippet ?? "").split("\n", 1)[0] ?? "";
        matches.push({
          path,
          lineNumber,
          lineContent,
          matchRanges: byteRangesToStringRanges(lineContent, match.Ranges ?? []),
        });
      }
    }
    return {
      matches: matches.slice(0, input.limit),
      truncated: matches.length > input.limit || overflowed(answer.response),
      source: sourceOf(answer.response, scope.repository),
    };
  });

  return { searchEntries, searchContents } satisfies VcsDriver.VcsWorkspaceSearch;
});
