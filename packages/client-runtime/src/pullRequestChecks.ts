import type { PullRequestCheck, PullRequestChecks, PullRequestDetail } from "@t3tools/contracts";

/** The checks merging waits on: the required ones where the host marks any, otherwise all. */
export function blockingPullRequestChecks(
  checks: ReadonlyArray<PullRequestCheck>,
): ReadonlyArray<PullRequestCheck> {
  const required = checks.filter((check) => check.required === true);
  return required.length > 0 ? required : checks;
}

export function resolvePullRequestDetailChecks(
  detail: PullRequestDetail | null,
  checks: PullRequestChecks | null,
  checksAreNewer: boolean,
): PullRequestDetail | null {
  if (detail === null || checks === null) return detail;
  const newer =
    detail.observedAt !== undefined && checks.observedAt !== undefined
      ? checks.observedAt >= detail.observedAt
      : checksAreNewer;
  return newer
    ? {
        ...detail,
        state: detail.state === "merged" ? "merged" : checks.state,
        checks: checks.checks,
      }
    : withLinksFrom(detail, checks.checks);
}

// A host's detail can leave out links its checks read has, as Arcanum does; keep them shown.
function withLinksFrom(
  detail: PullRequestDetail,
  checks: ReadonlyArray<PullRequestCheck>,
): PullRequestDetail {
  const links = new Map(
    checks.flatMap((check) => (check.url === null ? [] : [[check.name, check.url] as const])),
  );
  if (links.size === 0 || detail.checks.every((check) => check.url !== null)) return detail;
  return {
    ...detail,
    checks: detail.checks.map((check) =>
      check.url === null ? { ...check, url: links.get(check.name) ?? null } : check,
    ),
  };
}

/** Checks still running are worth a tighter poll than a settled head. */
export function pullRequestChecksRefreshIntervalMs(
  checks: ReadonlyArray<PullRequestCheck>,
): number {
  return checks.length === 0 ||
    checks.some((check) => ["pending", "queued", "action-required"].includes(check.status))
    ? 45_000
    : 60_000;
}
