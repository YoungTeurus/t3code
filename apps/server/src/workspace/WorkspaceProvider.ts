import type * as Effect from "effect/Effect";
import type { VcsError } from "@t3tools/contracts";

export interface WorkspaceEntry {
  readonly root: string;
  readonly name: string;
  readonly branch: string;
  readonly head: string | null;
  readonly base: string | null;
  readonly leaseOwner: string | null;
  readonly leaseRenewed?: string;
}

export interface WorkspaceEnsureInput {
  readonly cwd: string;
  readonly taskKey: string;
  readonly branch: string;
  readonly baseRevision: string;
  readonly path?: string;
  readonly requiredHead?: string;
  readonly publishedBranch?: string;
}

export interface WorkspaceResult {
  readonly root: string;
  readonly cwd: string;
  readonly branch: string;
  readonly head: string;
  readonly name: string;
  readonly leaseOwner: string;
  readonly action: "CREATED" | "REUSED";
  readonly isOnRequiredHead: boolean;
}

export interface WorkspaceProvider {
  readonly list: (cwd: string) => Effect.Effect<ReadonlyArray<WorkspaceEntry>, VcsError>;
  readonly ensure: (input: WorkspaceEnsureInput) => Effect.Effect<WorkspaceResult, VcsError>;
  readonly recordBranch: (cwd: string, branch: string) => Effect.Effect<void, VcsError>;
  readonly remove: (input: {
    readonly cwd: string;
    readonly path: string;
    readonly explicit: boolean;
    readonly force?: boolean;
  }) => Effect.Effect<void, VcsError>;
}
