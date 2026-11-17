import type * as Effect from "effect/Effect";

import type { GitCommandError, VcsError, WorktreeKeepWhen } from "@t3tools/contracts";

export interface VcsManagedWorktreeInput {
  /** The thread's worktree path. */
  readonly path: string;
  readonly branch: string;
  readonly keepWhen: WorktreeKeepWhen;
}

/** A worktree automatic cleanup may remove, as inspection found it. */
export interface VcsManagedWorktree {
  /** The folder removal deletes. It can hold more than the thread's worktree path. */
  readonly scope: string;
  readonly head: string;
  /** No commits since this server created the worktree. */
  readonly unchanged: boolean;
}

export type VcsManagedWorktreeInspection =
  | { readonly _tag: "Candidate"; readonly worktree: VcsManagedWorktree }
  | { readonly _tag: "Keep"; readonly reason: string };

/**
 * Automatic cleanup of worktrees a non-Git driver can prove this server created. Anything it
 * cannot prove is kept with a reason.
 */
export interface VcsManagedWorktrees {
  readonly inspect: (
    input: VcsManagedWorktreeInput,
  ) => Effect.Effect<VcsManagedWorktreeInspection, VcsError | GitCommandError>;
  /**
   * Repeats every inspection check against `head`, runs `guard` last, then removes. Null once
   * removed, otherwise why it stays.
   */
  readonly remove: <E>(
    input: VcsManagedWorktreeInput & {
      readonly head: string;
      readonly guard: Effect.Effect<string | null, E>;
    },
  ) => Effect.Effect<string | null, VcsError | GitCommandError | E>;
}
