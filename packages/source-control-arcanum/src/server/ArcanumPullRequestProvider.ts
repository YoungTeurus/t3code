import * as NodeBuffer from "node:buffer";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type {
  PullRequestActor,
  PullRequestCapabilities,
  PullRequestComment,
  PullRequestReviewThread,
  PullRequestViewerPermissions,
  PullRequestReviewPosition,
} from "@t3tools/contracts";
import {
  PullRequestProviderError,
  type PullRequestProviderApi,
  type ProviderChangeRequest,
  type ProviderChangeRequestDetail,
  type ProviderRepositoryRef,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import { parseDiffFilePaths } from "@t3tools/source-control-core/server/diffFileRevisions";
import * as ArcanumApi from "./ArcanumApi.ts";
import * as Reads from "./ArcanumPullRequestApi.ts";
import { makeArcanumCommentPublisher } from "./ArcanumCommentPublisher.ts";
import { toChangeRequest } from "./ArcanumSourceControlProvider.ts";
import { definition } from "../shared/definition.ts";

type NativePr = {
  readonly pr: typeof Reads.PullRequest.Type;
  readonly diff: typeof Reads.Diff.Type;
};
type Ref = ProviderRepositoryRef & { readonly number: number };
const Log = Schema.Array(
  Schema.Struct({
    commit: Schema.String,
    parents: Schema.Array(Schema.String),
    date: Schema.String,
    message: Schema.String,
    author: Schema.optional(Schema.String),
  }),
);
const decodeLog = Schema.decodeEffect(Schema.fromJsonString(Log));
const Anchor = Schema.Struct({
  diff_id: Schema.optional(Schema.NullOr(Reads.Id)),
  destination_path: Schema.optional(Schema.NullOr(Schema.String)),
  source_path: Schema.optional(Schema.NullOr(Schema.String)),
  line: Schema.optional(Schema.NullOr(Schema.Number)),
  side: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeAnchor = Schema.decodeUnknownOption(Anchor);
const encodeFingerprint = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const isApiError = Schema.is(ArcanumApi.ArcanumApiError);
const isProviderError = Schema.is(PullRequestProviderError);
const capabilities: PullRequestCapabilities = {
  diff: true,
  comment: true,
  actions: ["close", "ready", "disable-auto-merge"],
  mergeMethods: [],
  deleteBranch: false,
  search: false,
  reactions: false,
  viewedFiles: "environment",
  review: {
    inlineComment: true,
    rangeComment: true,
    reply: true,
    resolve: true,
    verdicts: ["comment", "approve"],
  },
  reviewers: { request: true, listCandidates: false },
  edit: { changeRequest: true, comment: true },
  stacks: false,
  stackActions: false,
  labels: false,
};
const actor = (user: { readonly name: string } | undefined): PullRequestActor | null =>
  user ? { login: user.name, name: null, avatarUrl: null } : null;
const nativePosition = (position: PullRequestReviewPosition) =>
  position.kind === "added"
    ? { line: position.newLine, side: "new" as const }
    : position.kind === "deleted"
      ? { line: position.oldLine, side: "old" as const }
      : {
          line: position.side === "left" ? position.oldLine : position.newLine,
          side: position.side === "left" ? ("old" as const) : ("new" as const),
        };

export const make = Effect.gen(function* () {
  const client = yield* Reads.ArcanumPullRequestApi;
  const api = yield* ArcanumApi.ArcanumApi;
  const host = yield* SourceControlHost.SourceControlHost;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const publisher = yield* makeArcanumCommentPublisher();
  const error = (
    operation: string,
    detail = "The native Arcanum operation could not be completed.",
    reason: PullRequestProviderError["reason"] = "failed",
  ) => new PullRequestProviderError({ provider: definition.kind, operation, reason, detail });
  const io = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError((cause) =>
        isApiError(cause)
          ? error(
              operation,
              cause.reason === "forbidden"
                ? "Arcanum denied access to this operation."
                : cause.reason === "conflict"
                  ? "The Arcanum state changed. Refresh before trying again."
                  : "The Arcanum request could not be completed.",
              cause.reason === "conflict" || cause.reason === "forbidden" ? "failed" : cause.reason,
            )
          : error(operation),
      ),
    );
  const assertRef = (input: ProviderRepositoryRef) =>
    input.host === "a.yandex-team.ru" && input.repository === "arcadia"
      ? Effect.void
      : Effect.fail(
          error(
            "repositoryIdentity",
            "This provider requires an Arcadia repository on a.yandex-team.ru.",
          ),
        );
  const read = Effect.fn("ArcanumPullRequestProvider.read")(function* (
    input: Ref,
    refresh = false,
  ) {
    yield* assertRef(input);
    return yield* io("read", client.read(input.cwd, input.number, refresh));
  });
  const run = Effect.fn("ArcanumPullRequestProvider.run")(function* (
    cwd: string,
    operation: string,
    args: ReadonlyArray<string>,
    maxOutputBytes = 8 * 1024 * 1024,
    truncate = false,
  ) {
    return yield* io(
      operation,
      host.process.run({
        cwd,
        operation: `ArcanumPullRequestProvider.${operation}`,
        command: "arc",
        args,
        maxOutputBytes,
        outputMode: truncate ? "truncate" : "error",
        timeoutMs: 60_000,
      }),
    );
  });
  const root = Effect.fn("ArcanumPullRequestProvider.root")(function* (cwd: string) {
    const output = yield* run(cwd, "root", ["root"], 65_536);
    if (!path.isAbsolute(output.stdout.trim())) return yield* error("root");
    return output.stdout.trim();
  });
  const sourceCommits = Effect.fn("ArcanumPullRequestProvider.sourceCommits")(function* (
    input: Ref,
    record: NativePr,
  ) {
    const output = yield* run(yield* root(input.cwd), "commits", [
      "log",
      "--json",
      `${record.diff.commit_ids.base}..${record.diff.commit_ids.head}`,
    ]);
    return yield* io("decodeCommits", decodeLog(output.stdout));
  });
  const range = Effect.fn("ArcanumPullRequestProvider.range")(function* (
    input: Ref & { readonly commit?: string | undefined },
    record: NativePr,
  ) {
    if (input.commit !== undefined) {
      const selected = (yield* sourceCommits(input, record)).find(
        (commit) => commit.commit === input.commit,
      );
      if (!selected?.parents[0])
        return yield* error(
          "commitIdentity",
          "The selected commit is not part of this Arcanum PR.",
        );
      return { base: selected.parents[0], head: selected.commit };
    }
    if (record.diff.commit_ids.merge)
      return { base: record.diff.commit_ids.base, head: record.diff.commit_ids.merge };
    const base = (yield* run(
      input.cwd,
      "mergeBase",
      ["merge-base", "--leftmost", record.diff.commit_ids.base, record.diff.commit_ids.head],
      65_536,
    )).stdout.trim();
    if (!/^[0-9a-f]{40,64}$/iu.test(base)) return yield* error("mergeBase");
    return { base, head: record.diff.commit_ids.head };
  });
  const statistics = Effect.fn("ArcanumPullRequestProvider.statistics")(function* (
    input: Ref,
    record: NativePr,
  ) {
    const selected = yield* range(input, record);
    const output = yield* run(
      yield* root(input.cwd),
      "statistics",
      ["diff", "--stat", selected.base, selected.head],
      1_048_576,
    );
    const summary = output.stdout.trimEnd().split("\n").at(-1)?.trim() ?? "";
    if (!summary) return { additions: 0, deletions: 0, changedFiles: 0 };
    const match =
      /^(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?$/u.exec(
        summary,
      );
    if (!match) return yield* error("statistics", "Arc returned an unrecognized diffstat summary.");
    return {
      additions: Number(match[2] ?? 0),
      deletions: Number(match[3] ?? 0),
      changedFiles: Number(match[1]),
    };
  });
  const permissions = (record: NativePr, viewer: string): PullRequestViewerPermissions => {
    const owner =
      record.pr.author.name === viewer ||
      record.pr.coauthors?.some((user) => user.name === viewer) === true;
    return {
      actions:
        owner && toChangeRequest(record).state === "open"
          ? ["close", "ready", "disable-auto-merge"]
          : [],
      comment: true,
      resolve: true,
      verdicts:
        record.pr.author.name === viewer || !record.diff.published || record.pr.status !== "open"
          ? ["comment"]
          : ["comment", "approve"],
      requestReviewers: owner,
      labels: false,
      editChangeRequest: owner,
    };
  };
  const listItem = (record: NativePr): ProviderChangeRequest => ({
    number: record.pr.id,
    title: record.pr.summary,
    url: record.pr.url,
    author: actor(record.pr.author),
    headBranch: record.pr.vcs.from_branch,
    baseBranch: record.pr.vcs.to_branch,
    state: toChangeRequest(record).state,
    isDraft: !record.diff.published,
    mergeability: record.diff.has_conflicts
      ? "conflicting"
      : record.pr.merge_allowed === true
        ? "mergeable"
        : "unknown",
    additions: 0,
    deletions: 0,
    createdAt: record.pr.created_at,
    updatedAt: record.pr.updated_at,
    closedAt: record.pr.closed_at ?? null,
    mergedAt: record.pr.status === "merged" ? (record.pr.closed_at ?? null) : null,
    reviewRequestLogins: (record.pr.assignees ?? []).map((user) => user.name),
    labels: (record.pr.labels ?? []).map((label) => ({ name: label.name, color: null })),
  });
  const getChangeRequest: PullRequestProviderApi["getChangeRequest"] = Effect.fn(
    "ArcanumPullRequestProvider.getChangeRequest",
  )(function* (input) {
    const record = yield* read(input);
    const [checks, stats] = yield* Effect.all(
      [io("checks", client.checks(input.cwd, record.diff.id)), statistics(input, record)],
      { concurrency: 2 },
    );
    return {
      ...listItem(record),
      ...stats,
      body: record.pr.description,
      headSha: record.diff.commit_ids.head,
      reviewers: (record.pr.assignees ?? []).flatMap((user) => actor(user) ?? []),
      checks,
      mergeCapabilities: { merge: false, squash: false, rebase: false },
      viewerPermissions: permissions(record, yield* io("viewer", api.viewer(input.cwd))),
      ...(record.pr.auto_merge !== undefined
        ? {
            autoMergeEnabled: ["on_satisfied_requirements", "force"].includes(record.pr.auto_merge),
          }
        : {}),
      mergedAt: record.pr.status === "merged" ? (record.pr.closed_at ?? null) : null,
      closedAt: record.pr.closed_at ?? null,
    } satisfies ProviderChangeRequestDetail;
  });
  const getDiff: PullRequestProviderApi["getDiff"] = Effect.fn(
    "ArcanumPullRequestProvider.getDiff",
  )(function* (input) {
    if (input.cursor) return yield* error("diffCursor");
    const record = yield* read(input);
    const selected = yield* range(input, record);
    const output = yield* run(
      yield* root(input.cwd),
      "diff",
      ["diff", "--git", "--binary", "--no-color", selected.base, selected.head],
      10_000_000,
      true,
    );
    return { patch: output.stdout, truncated: output.stdoutTruncated, nextCursor: null };
  });
  const readContents = Effect.fn("ArcanumPullRequestProvider.readContents")(function* (
    cwd: string,
    revision: string,
    file: string,
  ) {
    if (
      path.isAbsolute(file) ||
      /\0/u.test(file) ||
      path.normalize(file) === ".." ||
      path.normalize(file).startsWith(`..${path.sep}`)
    )
      return yield* error("fileScope");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const output = yield* io(
      "fileContents",
      host.process.run({
        cwd: yield* root(cwd),
        operation: "ArcanumPullRequestProvider.fileContents",
        command: "arc",
        args: ["show", `${revision}:${file}`],
        maxOutputBytes: 8 * 1024 * 1024,
        outputMode: "error",
        onStdoutChunk: (chunk) => {
          bytes += chunk.byteLength;
          if (bytes <= 8 * 1024 * 1024) chunks.push(NodeBuffer.Buffer.from(chunk));
        },
      }),
    );
    if (bytes > 8 * 1024 * 1024 || output.stdoutTruncated) return yield* error("fileContentsLimit");
    return yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(NodeBuffer.Buffer.concat(chunks)),
      catch: () => error("binaryFileContents", "This Arc file cannot be expanded as UTF-8 text."),
    });
  });
  const getChangeRequestActivity: PullRequestProviderApi["getChangeRequestActivity"] = Effect.fn(
    "ArcanumPullRequestProvider.getChangeRequestActivity",
  )(function* (input) {
    const record = yield* read(input);
    const [comments, viewer, commits] = yield* Effect.all(
      [
        io("comments", client.comments(input.cwd, input.number)),
        io("viewer", api.viewer(input.cwd)),
        sourceCommits(input, record),
      ],
      { concurrency: 3 },
    );
    const visible = comments.filter((comment) => !comment.deleted_at);
    const byId = new Map(visible.map((comment) => [String(comment.id), comment]));
    const groups = new Map<string, Array<(typeof visible)[number]>>();
    for (const comment of visible) {
      let parent = comment;
      const visited = new Set<string>();
      while (
        parent.reply_to_id !== undefined &&
        parent.reply_to_id !== null &&
        byId.has(String(parent.reply_to_id))
      ) {
        if (visited.has(String(parent.id))) return yield* error("commentThreadCycle");
        visited.add(String(parent.id));
        parent = byId.get(String(parent.reply_to_id))!;
      }
      const id = String(parent.id);
      groups.set(id, [...(groups.get(id) ?? []), comment]);
    }
    const conversation: PullRequestComment[] = [];
    const reviewThreads: PullRequestReviewThread[] = [];
    for (const [id, thread] of groups) {
      const first = byId.get(id)!;
      const anchor = Option.getOrUndefined(decodeAnchor(first.anchor));
      const file = anchor?.destination_path ?? anchor?.source_path;
      const normalized = thread.map((comment) => ({
        id: String(comment.id),
        author: actor(comment.author),
        body: comment.forbidden ? "Access to this comment is restricted." : (comment.content ?? ""),
        createdAt: comment.created_at,
        editedAt: comment.edited_at ?? null,
        url: `${record.pr.url}#comment-${comment.id}`,
        canEdit: !comment.forbidden && comment.author?.name === viewer,
      }));
      if (file)
        reviewThreads.push({
          id,
          path: file,
          line: anchor?.line && anchor.line > 0 ? anchor.line : null,
          side: anchor?.side === "old" ? "left" : "right",
          isResolved: first.issue_status !== "open",
          isOutdated:
            anchor?.diff_id !== undefined &&
            anchor.diff_id !== null &&
            String(anchor.diff_id) !== String(record.diff.id),
          comments: normalized,
          canResolve: first.issue_status !== undefined && first.issue_status !== "not_issue",
        });
      else
        conversation.push(
          ...normalized.map((comment) => ({
            ...comment,
            kind: "issue-comment" as const,
            path: null,
            reviewState: null,
          })),
        );
    }
    const normalizedCommits = yield* Effect.forEach(commits, (commit) => {
      const date = DateTime.make(commit.date);
      return Option.isNone(date)
        ? Effect.fail(error("commitDate"))
        : Effect.succeed({
            oid: commit.commit,
            messageHeadline: commit.message.split("\n")[0] ?? "",
            committedDate: DateTime.formatIso(date.value),
            ...(commit.author ? { authors: [actor({ name: commit.author })!] } : {}),
          });
    });
    return {
      author: actor(record.pr.author),
      reviewers: (record.pr.assignees ?? []).flatMap((user) => actor(user) ?? []),
      comments: conversation,
      commentCount: visible.length,
      commentsTruncated: false,
      reviewThreads,
      commits: normalizedCommits,
    };
  });
  const unsupported = (operation: string) =>
    Effect.fail(error(operation, "This Arcanum operation is not supported by this build."));
  const paths = Effect.fn("ArcanumPullRequestProvider.paths")(function* (patch: string) {
    return yield* Effect.forEach(parseDiffFilePaths(patch), (file) => {
      const oldPath = file.oldPath ?? file.newPath;
      const newPath = file.newPath ?? file.oldPath;
      return oldPath === null || newPath === null
        ? Effect.fail(error("diffFilePaths"))
        : Effect.succeed({ oldPath, newPath });
    });
  });
  const publish = Effect.fn("ArcanumPullRequestProvider.publishComment")(function* (
    input: Ref,
    body: Readonly<Record<string, unknown>>,
  ) {
    yield* read(input, true);
    return yield* api
      .withVerifiedCredential(input.cwd, ({ viewer }) =>
        io("comment", publisher.publish({ cwd: input.cwd, number: input.number, viewer, body })),
      )
      .pipe(Effect.mapError((cause) => (isProviderError(cause) ? cause : error("comment"))));
  });
  const provider = {
    kind: definition.kind,
    capabilities,
    unavailableRequirement: {
      missing: "Install Arc on the server and run `arc token store`, or configure ARC_TOKEN.",
      unauthenticated:
        "Arc or Arcanum refused the server credential. Check the token in Settings → Source Control.",
    },
    repositoryKey: () => "arcadia",
    withVerifiedCredential: (input, use) =>
      api
        .withVerifiedCredential(input.cwd, (identity) =>
          use({ accountId: identity.viewer, ...identity }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isApiError(cause)
              ? error(
                  "credential",
                  "Arcanum could not verify the selected credential.",
                  cause.reason === "forbidden" || cause.reason === "conflict"
                    ? "failed"
                    : cause.reason,
                )
              : cause,
          ),
        ),
    getRoutingIdentity: Effect.fn("ArcanumPullRequestProvider.getRoutingIdentity")(
      function* (input) {
        const viewer = yield* io("viewer", api.viewer(input.cwd));
        return { accountId: viewer, viewer };
      },
    ),
    getViewer: (input) => io("viewer", api.viewer(input.cwd)),
    listChangeRequests: Effect.fn("ArcanumPullRequestProvider.listChangeRequests")(
      function* (input) {
        yield* assertRef(input);
        const offset = input.cursor?.delivered ?? 0;
        const page = yield* io(
          "list",
          client.search(input.cwd, {
            state: input.state,
            involvement: input.involvement,
            viewer: input.viewer,
            limit: input.limit,
            offset,
          }),
        );
        const items: ProviderChangeRequest[] = [];
        for (const pr of page.rows) {
          const record = pr.active_diff
            ? { pr, diff: pr.active_diff }
            : yield* io("listActiveDiff", client.read(input.cwd, pr.id));
          const item = listItem(record);
          if (input.state === "all" || input.state === item.state) items.push(item);
        }
        return {
          items,
          truncated: offset + page.rawCount < page.total,
          continues: offset + page.rawCount < page.total,
          cursorAdvance: page.rawCount,
        };
      },
    ),
    getChangeRequest,
    getChangeRequestSummary: Effect.fn("ArcanumPullRequestProvider.getChangeRequestSummary")(
      function* (input) {
        const record = yield* read(input);
        return listItem(record);
      },
    ),
    getChangeRequestChecks: Effect.fn("ArcanumPullRequestProvider.getChangeRequestChecks")(
      function* (input) {
        const record = yield* read(input);
        const checks = yield* io("checks", client.checks(input.cwd, record.diff.id));
        return { checks, state: toChangeRequest(record).state };
      },
    ),
    getChangeRequestActivity,
    getViewerPermissions: Effect.fn("ArcanumPullRequestProvider.getViewerPermissions")(
      function* (input) {
        const record = yield* read(input, true);
        return permissions(record, yield* io("viewer", api.viewer(input.cwd)));
      },
    ),
    getDiff,
    getDiffFilePaths: Effect.fn("ArcanumPullRequestProvider.getDiffFilePaths")(function* (input) {
      const diff = yield* getDiff(input);
      if (diff.truncated) return yield* error("filePathsTruncated");
      return { files: yield* paths(diff.patch), nextCursor: null };
    }),
    getDiffFileContents: Effect.fn("ArcanumPullRequestProvider.getDiffFileContents")(
      function* (input) {
        const record = yield* read(input);
        const selected = yield* range(input, record);
        const patch = yield* getDiff(input);
        if (
          patch.truncated ||
          !(yield* paths(patch.patch)).some(
            (file) => file.oldPath === input.oldPath && file.newPath === input.newPath,
          )
        )
          return yield* error("fileIdentity");
        const [oldContents, newContents] = yield* Effect.all(
          [
            input.changeType === "new"
              ? Effect.succeed("")
              : readContents(input.cwd, selected.base, input.oldPath),
            input.changeType === "deleted"
              ? Effect.succeed("")
              : readContents(input.cwd, selected.head, input.newPath),
          ],
          { concurrency: 2 },
        );
        return { oldContents, newContents };
      },
    ),
    getFileRevisions: Effect.fn("ArcanumPullRequestProvider.getFileRevisions")(function* (input) {
      const record = yield* read(input);
      const changes = yield* io("changes", client.changes(input.cwd, record.diff.id));
      const revisions = new Map<string, string>();
      for (const file of input.paths) {
        const change = changes.find((change) => change.path === file);
        if (change?.change_type === "delete") revisions.set(file, "");
        else if (change?.blob_after) revisions.set(file, change.blob_after);
      }
      return { revisions, complete: revisions.size === input.paths.length };
    }),
    comment: Effect.fn("ArcanumPullRequestProvider.comment")((input) =>
      publish(input, { content: input.body, is_issue: false, is_draft: false }).pipe(Effect.asVoid),
    ),
    replyToThread: Effect.fn("ArcanumPullRequestProvider.replyToThread")(function* (input) {
      const comments = yield* io("comments", client.comments(input.cwd, input.number));
      if (!comments.some((comment) => String(comment.id) === input.threadId && !comment.deleted_at))
        return yield* error("threadIdentity");
      yield* publish(input, {
        content: input.body,
        reply_to_id: input.threadId,
        is_issue: false,
        is_draft: false,
      });
    }),
    updateComment: Effect.fn("ArcanumPullRequestProvider.updateComment")(function* (input) {
      yield* read(input, true);
      const viewer = yield* io("viewer", api.viewer(input.cwd));
      const comments = yield* io("comments", client.comments(input.cwd, input.number));
      const comment = comments.find(
        (comment) => String(comment.id) === input.commentId && !comment.deleted_at,
      );
      if (!comment || comment.author?.name !== viewer || comment.forbidden)
        return yield* error("editCommentPermission");
      const result = yield* api
        .request(
          {
            cwd: input.cwd,
            operation: "updateComment",
            method: "PUT",
            path: `/v2/public/pull-request/${input.number}/comment/${encodeURIComponent(input.commentId)}`,
            body: { content: input.body },
          },
          Schema.Unknown,
        )
        .pipe(Effect.result);
      const after = yield* io("editCommentReadback", client.comments(input.cwd, input.number));
      if (
        !after.some(
          (comment) =>
            String(comment.id) === input.commentId &&
            comment.content === input.body &&
            !comment.deleted_at,
        )
      )
        return yield* error(
          "editCommentReadback",
          result._tag === "Failure"
            ? "The comment update outcome could not be verified. Refresh before trying again."
            : undefined,
        );
    }),
    setThreadResolution: Effect.fn("ArcanumPullRequestProvider.setThreadResolution")(
      function* (input) {
        yield* read(input, true);
        const comments = yield* io("comments", client.comments(input.cwd, input.number));
        const comment = comments.find(
          (comment) => String(comment.id) === input.threadId && !comment.deleted_at,
        );
        if (!comment || !comment.issue_status || comment.issue_status === "not_issue")
          return yield* error("issueIdentity");
        const status = input.resolved ? "resolved" : "open";
        yield* api
          .request(
            {
              cwd: input.cwd,
              operation: "resolveIssue",
              method: "PUT",
              path: `/v2/public/pull-request/${input.number}/comment/${encodeURIComponent(input.threadId)}`,
              body: { issue_status: status },
            },
            Schema.Unknown,
          )
          .pipe(Effect.result);
        const after = yield* io("issueReadback", client.comments(input.cwd, input.number));
        if (
          !after.some(
            (comment) => String(comment.id) === input.threadId && comment.issue_status === status,
          )
        )
          return yield* error("issueReadback");
      },
    ),
    submitReview: Effect.fn("ArcanumPullRequestProvider.submitReview")(function* (input) {
      if (input.verdict === "request-changes") return yield* unsupported("review");
      yield* api
        .withVerifiedCredential(input.cwd, ({ viewer }) =>
          Effect.gen(function* () {
            const record = yield* read(input, true);
            if (input.verdict === "approve" || input.comments.length > 0) {
              if (
                !input.expectedHeadSha ||
                input.expectedHeadSha !== record.diff.commit_ids.head ||
                !record.diff.published ||
                record.pr.status !== "open"
              )
                return yield* error(
                  "staleReview",
                  "The Arcanum diff changed. Refresh and review the current revision before submitting.",
                );
              if (input.verdict === "approve" && record.pr.author.name === viewer)
                return yield* error("selfApproval");
            }
            const changes = input.comments.length
              ? yield* io("reviewChanges", client.changes(input.cwd, record.diff.id))
              : [];
            const comments = yield* Effect.forEach(input.comments, (comment) =>
              Effect.gen(function* () {
                if (comment.expectedHeadSha !== record.diff.commit_ids.head)
                  return yield* error(
                    "staleComment",
                    "A line comment belongs to an older revision. Review it again before submitting.",
                  );
                const entry = changes.find(
                  (entry) =>
                    entry.path === comment.path &&
                    (!comment.oldPath ||
                      comment.oldPath === entry.source?.path ||
                      comment.oldPath === entry.path),
                );
                if (!entry?.entry_id || entry.node_type !== "file")
                  return yield* error("commentEntryIdentity");
                const end = nativePosition(comment.position);
                const start = comment.startPosition ? nativePosition(comment.startPosition) : end;
                if (start.side !== end.side || start.line > end.line)
                  return yield* error("commentRange");
                return {
                  clientId: comment.clientId,
                  body: {
                    content: comment.body,
                    entry_id: entry.entry_id,
                    is_draft: false,
                    is_issue: false,
                    line: start.line,
                    side: start.side,
                    size: end.line - start.line + 1,
                  },
                };
              }),
            );
            const batchId = yield* crypto
              .digest(
                "SHA-256",
                new TextEncoder().encode(
                  yield* io(
                    "reviewIntent",
                    encodeFingerprint([record.diff.id, input.verdict, input.body, input.comments]),
                  ),
                ),
              )
              .pipe(
                Effect.map(Hex.encode),
                Effect.mapError(() => error("reviewIntent")),
              );
            for (let index = 0; index < comments.length; index++) {
              const comment = comments[index]!;
              yield* io(
                "inlineComment",
                publisher.publish({
                  cwd: input.cwd,
                  number: input.number,
                  viewer,
                  diff: record.diff.id,
                  intentId: `review-line/${comment.clientId ?? `${batchId}/${index}`}`,
                  body: comment.body,
                }),
              );
            }
            if (input.body.trim())
              yield* io(
                "reviewSummary",
                publisher.publish({
                  cwd: input.cwd,
                  number: input.number,
                  viewer,
                  intentId: `review-summary/${batchId}`,
                  body: { content: input.body, is_issue: false, is_draft: false },
                }),
              );
            if (input.verdict === "approve")
              yield* io(
                "approve",
                api.request(
                  {
                    cwd: input.cwd,
                    operation: "approve",
                    method: "POST",
                    path: `/v1/review-requests/${input.number}/diff-sets/${encodeURIComponent(String(record.diff.id))}/ship?sticky=false`,
                  },
                  Schema.Void,
                ),
              );
          }),
        )
        .pipe(Effect.mapError((cause) => (isProviderError(cause) ? cause : error("review"))));
    }),
    runAction: Effect.fn("ArcanumPullRequestProvider.runAction")(function* (input) {
      const record = yield* read(input, true);
      const viewer = yield* io("viewer", api.viewer(input.cwd));
      if (!permissions(record, viewer).actions.includes(input.action))
        return yield* unsupported("action");
      const endpoint =
        input.action === "close"
          ? `/v1/plugin/pull-request/${input.number}/discard`
          : input.action === "ready"
            ? `/v1/plugin/diff/${encodeURIComponent(String(record.diff.id))}/publish`
            : `/v1/plugin/pull-request/${input.number}/auto-merge`;
      yield* api
        .request(
          {
            cwd: input.cwd,
            operation: input.action,
            method: input.action === "disable-auto-merge" ? "DELETE" : "PATCH",
            path: endpoint,
          },
          Schema.Unknown,
        )
        .pipe(Effect.result);
      const after = yield* read(input, true);
      const confirmed =
        input.action === "close"
          ? toChangeRequest(after).state === "closed"
          : input.action === "ready"
            ? String(after.diff.id) === String(record.diff.id) && after.diff.published
            : after.pr.auto_merge === "disabled";
      if (!confirmed)
        return yield* error(
          "actionReadback",
          "The Arcanum action outcome could not be verified. Refresh before trying again.",
        );
    }),
    updateChangeRequest: Effect.fn("ArcanumPullRequestProvider.updateChangeRequest")(
      function* (input) {
        const record = yield* read(input, true);
        const viewer = yield* io("viewer", api.viewer(input.cwd));
        if (
          !permissions(record, viewer).editChangeRequest ||
          input.maintainerCanModify !== undefined ||
          record.pr.labels === undefined ||
          record.pr.tickets === undefined
        )
          return yield* error("editPermission");
        const summary = input.title ?? record.pr.summary;
        const description = input.body ?? record.pr.description;
        yield* api
          .request(
            {
              cwd: input.cwd,
              operation: "editPullRequest",
              method: "PUT",
              path: `/v1/plugin/pull-request/${input.number}`,
              body: {
                summary,
                description,
                labels: record.pr.labels.map((label) => label.name),
                issues: record.pr.tickets ?? [],
              },
            },
            Schema.Unknown,
          )
          .pipe(Effect.result);
        const after = yield* read(input, true);
        if (after.pr.summary !== summary || after.pr.description !== description)
          return yield* error("editReadback");
      },
    ),
    listReviewerCandidates: () => unsupported("reviewers"),
    setReviewerRequest: Effect.fn("ArcanumPullRequestProvider.setReviewerRequest")(
      function* (input) {
        const record = yield* read(input, true);
        const viewer = yield* io("viewer", api.viewer(input.cwd));
        if (
          !permissions(record, viewer).requestReviewers ||
          record.pr.assignees === undefined ||
          input.reviewers.some(
            (reviewer) =>
              reviewer.kind !== "user" ||
              !/^[a-z][a-z0-9_-]*$/iu.test(reviewer.id) ||
              reviewer.id === record.pr.author.name,
          )
        )
          return yield* error("reviewerPermission");
        const reviewers = new Set(record.pr.assignees.map((user) => user.name));
        for (const reviewer of input.reviewers) {
          if (input.requested) reviewers.add(reviewer.id);
          else reviewers.delete(reviewer.id);
        }
        yield* api
          .request(
            {
              cwd: input.cwd,
              operation: "reviewers",
              method: "PUT",
              path: `/v1/plugin/pull-request/${input.number}/reviewers`,
              body: { reviewers: [...reviewers] },
            },
            Schema.Unknown,
          )
          .pipe(Effect.result);
        const after = yield* read(input, true);
        const actual = new Set(after.pr.assignees?.map((user) => user.name));
        if (input.reviewers.some((reviewer) => actual.has(reviewer.id) !== input.requested))
          return yield* error("reviewerReadback");
      },
    ),
    setReaction: () => unsupported("reactions"),
    getChangeRequestWatchFingerprint: Effect.fn(
      "ArcanumPullRequestProvider.getChangeRequestWatchFingerprint",
    )(function* (input) {
      const record = yield* read(input, true);
      const [checks, comments] = yield* Effect.all(
        [
          io("checks", client.checks(input.cwd, record.diff.id)),
          io("comments", client.comments(input.cwd, input.number)),
        ],
        { concurrency: 2 },
      );
      const hash = Effect.fn("ArcanumPullRequestProvider.fingerprint")(function* (value: unknown) {
        const text = yield* io("fingerprint", encodeFingerprint(value));
        return yield* io(
          "fingerprint",
          crypto.digest("SHA-256", new TextEncoder().encode(text)),
        ).pipe(Effect.map(Hex.encode));
      });
      return {
        status: yield* hash({
          state: record.pr.status,
          head: record.diff.commit_ids.head,
          diff: record.diff.id,
          draft: !record.diff.published,
          mergeAllowed: record.pr.merge_allowed ?? null,
          autoMerge: record.pr.auto_merge,
          reviewers: (record.pr.assignees ?? []).map((user) => user.name).toSorted(),
          approvers: (record.pr.approvers ?? []).map((user) => user.name).toSorted(),
          checks: checks.toSorted((a, b) => a.name.localeCompare(b.name)),
        }),
        remarks: yield* hash(comments.toSorted((a, b) => String(a.id).localeCompare(String(b.id)))),
      };
    }),
  } satisfies PullRequestProviderApi;
  const verified = <I extends Ref, A>(
    operation: (input: I) => Effect.Effect<A, PullRequestProviderError>,
  ) =>
    Effect.fn("ArcanumPullRequestProvider.verifiedMutation")(function (input: I) {
      return api
        .withVerifiedCredential(input.cwd, () => operation(input))
        .pipe(Effect.mapError((cause) => (isProviderError(cause) ? cause : error("credential"))));
    });
  return {
    ...provider,
    comment: verified(provider.comment),
    replyToThread: verified(provider.replyToThread),
    updateComment: verified(provider.updateComment),
    setThreadResolution: verified(provider.setThreadResolution),
    submitReview: verified(provider.submitReview),
    runAction: verified(provider.runAction),
    updateChangeRequest: verified(provider.updateChangeRequest),
    setReviewerRequest: verified(provider.setReviewerRequest),
  };
});
