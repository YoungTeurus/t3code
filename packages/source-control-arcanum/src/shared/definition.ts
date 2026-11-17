import {
  makeProviderSettingsSchema,
  SettingsSecretValue,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  defineSourceControl,
  hostCredentialSettingsFields,
  isChangeRequestOnProjectHost,
  projectChangeRequestHost,
  type ParsedChangeRequestUrl,
} from "@t3tools/source-control-core/shared/definition";

import { icon } from "./icon.ts";

const KIND = SourceControlProviderKind.make("arcanum");

/** Arcanum's web host: pull requests are `/review/<id>` there, whatever repository they are in. */
export const ARCANUM_WEB_HOST = "a.yandex-team.ru";

/**
 * Arc servers whose repositories Arcanum reviews, as an Arc store's `Server.Host` names them. Only
 * these remotes are Arcanum's, so no other `arc://` server ever receives its credential.
 */
export const ARC_SERVER_HOSTS: ReadonlySet<string> = new Set(["arc-vcs.yandex-team.ru"]);

/**
 * The stable key namespace for Arcanum's globally numbered reviews. Keep the legacy name;
 * the server resolves the actual repository from the review's arc_repo_name.
 */
export const ARCANUM_DEFAULT_REPOSITORY = "arcadia";

const REVIEW_PATH = /^\/review\/(\d+)(?:\/|$)/u;
const CHECKOUT_COMMAND = /^arc\s+pr\s+(?:checkout|co)\s+(\d+)\s*$/u;
const REPOSITORY_NAME = /^[a-z0-9][a-z0-9._-]*$/u;

function reviewNumber(url: URL): number | null {
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== ARCANUM_WEB_HOST) return null;
  if (url.port !== "" || url.username !== "" || url.password !== "") return null;
  const number = Number(REVIEW_PATH.exec(url.pathname)?.[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function parseChangeRequestUrl(url: URL): ParsedChangeRequestUrl | null {
  const number = reviewNumber(url);
  return number === null
    ? null
    : {
        host: ARCANUM_WEB_HOST,
        repository: ARCANUM_DEFAULT_REPOSITORY,
        number,
        repositoryUrl: `https://${ARCANUM_WEB_HOST}/${ARCANUM_DEFAULT_REPOSITORY}`,
      };
}

/** The web spelling of a repository key either host spells, or null for another host's key. */
function webRepositoryKey(key: string): string | null {
  const separator = key.indexOf("/");
  if (separator <= 0) return null;
  const host = key.slice(0, separator).toLowerCase();
  const repository = key.slice(separator + 1).toLowerCase();
  if (!REPOSITORY_NAME.test(repository)) return null;
  return host === ARCANUM_WEB_HOST || ARC_SERVER_HOSTS.has(host)
    ? `${ARCANUM_WEB_HOST}/${repository}`
    : null;
}

/**
 * Also takes a review URL's `repositoryUrl`: the registry keys a one-segment web URL as the
 * whole URL, not as `host/repository`.
 */
function canonicalRepositoryKey(key: string): string | null {
  const webUrl = `https://${ARCANUM_WEB_HOST}/`;
  return webRepositoryKey(
    key.toLowerCase().startsWith(webUrl) ? key.slice("https://".length) : key,
  ) === null
    ? null
    : `${ARCANUM_WEB_HOST}/${ARCANUM_DEFAULT_REPOSITORY}`;
}

export const settings = makeProviderSettingsSchema({
  hosts: hostCredentialSettingsFields.hosts,
  tokens: hostCredentialSettingsFields.tokens,
  token: SettingsSecretValue.pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
    Schema.annotateKey({
      title: "Token",
      description:
        "An Arcanum OAuth token, used before ARC_TOKEN, ~/.arc/token and `arc token show`. Cloudia Code Search also needs codesearch:search access.",
      providerSettingsForm: { control: "password" },
    }),
  ),
});
export type ArcanumSettings = typeof settings.Type;

export const definition = defineSourceControl({
  kind: KIND,
  label: "Arcanum",
  pickerLabel: "Arcanum",
  icon,
  searchKeywords: ["arc", "arcadia", "cloudia"],
  changeRequest: {
    shortLabel: "PR",
    shortLabelWithArticle: "a PR",
    singular: "pull request",
    plural: "pull requests",
  },
  repositoryPathHint: ARCANUM_DEFAULT_REPOSITORY,
  publicHost: ARCANUM_WEB_HOST,
  // Arc repositories are mounted with `arc mount`, never cloned or created through T3.
  managesRepositories: false,
  supportsRepositoryCreation: false,
  publishDescription: ARCANUM_WEB_HOST,
  publishHost: () => ARCANUM_WEB_HOST,
  newRepositoryOwner: () => null,
  defaultCloneTransport: "https",
  changeRequestUrl: ({ number }) =>
    Number.isSafeInteger(number) && number > 0
      ? `https://${ARCANUM_WEB_HOST}/review/${number}`
      : null,
  parseChangeRequestUrl,
  changeRequestUrlFromReferenceAutolink: () => null,
  yfm: true,
  // `close` would discard, which Arcanum cannot undo, and a pull request never reopens.
  changeRequestActions: new Set([
    "merge",
    "ready",
    "enable-auto-merge",
    "disable-auto-merge",
  ] as const),
  checkoutCommand: ({ number }) => `arc pr checkout ${number}`,
  changeRequestCloseCommand: /\barc\s+pr\s+(?:merge|discard)\b/u,
  // `arc pr create` prints the new pull request's URL on a line of its own.
  changeRequestCreateCommand: /\barc\s+pr\s+(?:create|c)\b/u,
  authorProfileUrl: () => null,
  reviewSummaryRequired: () => false,
  checkoutCommandArgument: (input) => CHECKOUT_COMMAND.exec(input.trim())?.[1] ?? null,
  isChangeRequestReference: (value) => {
    const url = URL.parse(value);
    return url !== null && reviewNumber(url) !== null;
  },
  checkoutChangeRequestHost: (identity) => projectChangeRequestHost(identity, KIND),
  recognizeRemote: ({ remoteUrl, hostname }) => {
    const scheme = /^([a-z][a-z0-9+.-]*):\/\//iu.exec(remoteUrl)?.[1]?.toLowerCase();
    const claimed =
      (scheme === "arc" && ARC_SERVER_HOSTS.has(hostname)) ||
      (scheme === "https" && hostname === ARCANUM_WEB_HOST);
    return claimed ? { kind: KIND, name: "Arcanum", baseUrl: `https://${ARCANUM_WEB_HOST}` } : null;
  },
  repositoryKeyFromRemote: webRepositoryKey,
  canonicalRepositoryKey,
  isChangeRequestInRepository: (identity, link) =>
    isChangeRequestOnProjectHost(projectChangeRequestHost(identity, KIND), identity, link),
  canReadChangeRequestOnHost: (identity, link) =>
    isChangeRequestOnProjectHost(projectChangeRequestHost(identity, KIND), identity, link),
  settings,
});

/** The pull request number a review URL names, or null when it is not one of Arcanum's. */
export function parseReviewUrl(value: string): number | null {
  const url = URL.parse(value);
  return url === null ? null : reviewNumber(url);
}
