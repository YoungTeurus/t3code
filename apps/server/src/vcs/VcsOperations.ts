import type * as Effect from "effect/Effect";
import type {
  ReviewDiffFileContentsInput,
  ReviewDiffFileContentsResult,
  ReviewDiffPreviewInput,
  ReviewDiffPreviewResult,
  VcsError,
  VcsListRefsInput,
  VcsListRefsResult,
  VcsStatusInput,
  VcsStatusLocalResult,
  VcsCreateRefInput,
  VcsCreateRefResult,
  VcsSwitchRefInput,
  VcsSwitchRefResult,
  VcsPullResult,
} from "@t3tools/contracts";

export interface VcsRepositoryOperations {
  readonly context: (cwd: string) => Effect.Effect<
    {
      readonly root: string;
      readonly cwd: string;
      readonly scope: string;
      readonly repository: string;
      readonly head: string;
      readonly branch: string | null;
      readonly upstream: string | null;
      readonly identity: string;
    },
    VcsError
  >;
  readonly branchState: (
    cwd: string,
    branch: string,
  ) => Effect.Effect<
    {
      readonly exists: boolean;
      readonly upstream: string | null;
      readonly publishedBranch: string;
    },
    VcsError
  >;
  readonly recentCommitSubjects: (cwd: string) => Effect.Effect<ReadonlyArray<string>, VcsError>;
  readonly setUpstream: (cwd: string, publishedBranch: string) => Effect.Effect<void, VcsError>;
  readonly localStatus: (input: VcsStatusInput) => Effect.Effect<VcsStatusLocalResult, VcsError>;
  readonly listRefs: (input: VcsListRefsInput) => Effect.Effect<VcsListRefsResult, VcsError>;
  readonly getReviewDiffPreview: (
    input: ReviewDiffPreviewInput,
  ) => Effect.Effect<ReviewDiffPreviewResult, VcsError>;
  readonly getReviewDiffFileContents: (
    input: ReviewDiffFileContentsInput,
  ) => Effect.Effect<ReviewDiffFileContentsResult, VcsError>;
  readonly createRef: (input: VcsCreateRefInput) => Effect.Effect<VcsCreateRefResult, VcsError>;
  readonly switchRef: (input: VcsSwitchRefInput) => Effect.Effect<VcsSwitchRefResult, VcsError>;
  readonly commit: (
    cwd: string,
    subject: string,
    body: string,
    options?: { readonly filePaths?: ReadonlyArray<string> },
  ) => Effect.Effect<{ readonly commitSha: string }, VcsError>;
  readonly pushCurrentBranch: (cwd: string) => Effect.Effect<
    {
      readonly status: "pushed" | "skipped_up_to_date";
      readonly branch: string;
      readonly upstreamBranch?: string;
    },
    VcsError
  >;
  readonly pullCurrentBranch: (cwd: string) => Effect.Effect<VcsPullResult, VcsError>;
}
