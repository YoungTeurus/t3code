import * as Schema from "effect/Schema";

import type { PullRequestCheckAction, PullRequestCheckStatus } from "@t3tools/contracts";

import type { ArcanumApiRequest } from "./ArcanumApi.ts";

/**
 * Merge check actions. Arcanum has them only outside its public API: restart and requirement
 * changes are `unsafe_review_requests`, skipping a service's configuration is `unsafe_diffs`.
 * A check has no id of its own; it is the pair of its system and type.
 */
interface CheckKey {
  readonly system: string;
  readonly type: string;
}

type CheckAction =
  | ({ readonly kind: "restart" | "require" | "unrequire" } & CheckKey)
  | { readonly kind: "skip-service"; readonly service: string };

const CHECK_KINDS = ["restart", "require", "unrequire"] as const;

const checkActionId = (kind: (typeof CHECK_KINDS)[number], key: CheckKey) =>
  `${kind}:${encodeURIComponent(key.system)}:${encodeURIComponent(key.type)}`;

export function parseCheckAction(id: string): CheckAction | null {
  const [kind, ...parts] = id.split(":");
  try {
    if (kind === "skip-service" && parts.length === 1 && parts[0]) {
      return { kind, service: decodeURIComponent(parts[0]) };
    }
    const known = CHECK_KINDS.find((candidate) => candidate === kind);
    if (known !== undefined && parts.length === 2 && parts[0] && parts[1]) {
      return {
        kind: known,
        system: decodeURIComponent(parts[0]),
        type: decodeURIComponent(parts[1]),
      };
    }
  } catch {
    return null;
  }
  return null;
}

/** Whether Arcanum lets anyone stop requiring a check, and on what terms. */
type DisablingPolicy = "allowed" | "denied" | "need_reason";

const policyOf = (raw: string | undefined): DisablingPolicy | null =>
  raw === "allowed" || raw === "denied" || raw === "need_reason" ? raw : null;

const DENIED = "Arcanum does not let anyone stop requiring this check.";

/** A check's actions, from what the public checks read reports. Only open pull requests get any. */
export function checkActionsOf(
  check: CheckKey & { readonly required: boolean; readonly disabling_policy?: string | undefined },
  status: PullRequestCheckStatus,
): ReadonlyArray<PullRequestCheckAction> {
  const actions: PullRequestCheckAction[] = [];
  // Whether Arcanum lets it restart is read on click: the public read does not say.
  if (status === "failure" || status === "cancelled") {
    actions.push({ id: checkActionId("restart", check), label: "Restart", available: true });
  }
  if (!check.required) {
    actions.push({ id: checkActionId("require", check), label: "Require", available: true });
    return actions;
  }
  const policy = policyOf(check.disabling_policy);
  const id = checkActionId("unrequire", check);
  actions.push(
    policy === "denied"
      ? { id, label: "Stop requiring", available: false, unavailableReason: DENIED }
      : {
          id,
          label: "Stop requiring",
          available: true,
          reason: policy === "need_reason" ? "required" : "optional",
        },
  );
  return actions;
}

/** Services Arcanum still waits on to add their checks to the iteration. */
export function serviceActionsOf(
  services: ReadonlyArray<{
    readonly id?: string | undefined;
    readonly configuration_state?: string | undefined;
  }>,
): ReadonlyArray<PullRequestCheckAction> {
  return services.flatMap((service) =>
    service.id === undefined || service.configuration_state !== "configure_pending"
      ? []
      : [
          {
            id: `skip-service:${encodeURIComponent(service.id)}`,
            label: `Stop waiting for ${service.id}`,
            available: true,
          },
        ],
  );
}

/** `GET /v1/review-requests/{id}` with {@link CHECK_ACTION_FIELDS}, read on click before a write. */
export const CHECK_ACTION_FIELDS =
  "full_status,active_diff_set(id,arc_branch_heads(from_id)),checks(system,type,required,configuration(restartable,disabling_policy)),services(id,configuration_state)";

export const CheckActionState = Schema.Struct({
  full_status: Schema.String,
  active_diff_set: Schema.optional(
    Schema.Struct({
      id: Schema.Int,
      arc_branch_heads: Schema.optional(Schema.Struct({ from_id: Schema.String })),
    }),
  ),
  checks: Schema.optional(
    Schema.Array(
      Schema.Struct({
        system: Schema.String,
        type: Schema.String,
        required: Schema.optional(Schema.Boolean),
        configuration: Schema.optional(
          Schema.Struct({
            restartable: Schema.optional(Schema.Boolean),
            disabling_policy: Schema.optional(Schema.String),
          }),
        ),
      }),
    ),
  ),
  services: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.optional(Schema.String),
        configuration_state: Schema.optional(Schema.String),
      }),
    ),
  ),
});
export type CheckActionState = typeof CheckActionState.Type;

/** Why the action cannot run now, by a fresh read; null when it can. */
export function unavailableReason(
  action: CheckAction,
  state: CheckActionState,
  reason: string | undefined,
): string | null {
  if (action.kind === "skip-service") {
    const service = state.services?.find((candidate) => candidate.id === action.service);
    return service?.configuration_state === "configure_pending"
      ? null
      : `Arcanum no longer waits for ${action.service}.`;
  }
  const check = state.checks?.find(
    (candidate) => candidate.system === action.system && candidate.type === action.type,
  );
  if (check === undefined) return "The check is no longer on this pull request.";
  switch (action.kind) {
    case "restart":
      return check.configuration?.restartable === true
        ? null
        : "Arcanum does not let this check restart.";
    case "require":
      return check.required === true ? "The check is already required." : null;
    case "unrequire": {
      if (check.required !== true) return "The check is no longer required.";
      const policy = policyOf(check.configuration?.disabling_policy);
      if (policy === "denied") return DENIED;
      return policy === "need_reason" && reason === undefined
        ? "Arcanum needs a reason to stop requiring this check."
        : null;
    }
  }
}

/**
 * The write an action is. A requirement change holds for the whole pull request, later
 * iterations included; a restart is always on the active iteration.
 */
export function checkActionWrite(
  action: CheckAction,
  input: { readonly number: number; readonly diffSetId: number; readonly reason?: string },
): Omit<ArcanumApiRequest, "operation"> {
  const base = `/v1/review-requests/${input.number}`;
  switch (action.kind) {
    case "skip-service":
      return {
        method: "DELETE",
        path: `${base}/diff-sets/${input.diffSetId}/services/${encodeURIComponent(action.service)}`,
      };
    case "restart":
      return {
        method: "POST",
        path: `${base}/restarting-checks`,
        body: { system: action.system, type: action.type },
      };
    case "require":
    case "unrequire":
      return {
        method: "POST",
        path: `${base}/check-requirements`,
        body: {
          system: action.system,
          type: action.type,
          enabled: action.kind === "require",
          ...(action.kind === "unrequire" && input.reason !== undefined
            ? { reason: { text: input.reason } }
            : {}),
        },
      };
  }
}
