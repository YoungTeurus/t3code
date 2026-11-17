import { RuntimeMode } from "@t3tools/contracts";
import type * as CodexSchema from "effect-codex-app-server/schema";

export type CodexConfigRequirements =
  CodexSchema.V2ConfigRequirementsReadResponse__ConfigRequirements;

/** What each runtime mode asks Codex for; keep in step with `codexRuntimeModeTurnDefaults`. */
const RUNTIME_MODE_ACCESS = {
  "approval-required": { sandbox: "read-only", approval: "untrusted" },
  "auto-accept-edits": { sandbox: "workspace-write", approval: "on-request" },
  auto: { sandbox: "workspace-write", approval: "on-request" },
  "full-access": { sandbox: "danger-full-access", approval: "never" },
} as const satisfies Record<RuntimeMode, unknown>;

/** The runtime modes managed requirements (MDM, requirements.toml) allow; undefined when they restrict none. */
export function codexSupportedRuntimeModes(
  requirements: CodexConfigRequirements | null | undefined,
): ReadonlyArray<RuntimeMode> | undefined {
  if (!requirements) return undefined;
  const { allowedSandboxModes, allowedApprovalPolicies } = requirements;
  const modes = RuntimeMode.literals.filter(
    (mode) =>
      (allowedSandboxModes == null ||
        allowedSandboxModes.includes(RUNTIME_MODE_ACCESS[mode].sandbox)) &&
      (allowedApprovalPolicies == null ||
        allowedApprovalPolicies.includes(RUNTIME_MODE_ACCESS[mode].approval)),
  );
  return modes.length === 0 || modes.length === RuntimeMode.literals.length ? undefined : modes;
}
