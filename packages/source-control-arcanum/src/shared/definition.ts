import { makeProviderSettingsSchema, SourceControlProviderKind } from "@t3tools/contracts";
import {
  defineSourceControl,
  hostCredentialSettingsFields,
} from "@t3tools/source-control-core/shared/definition";

const kind = SourceControlProviderKind.make("arcanum");
const host = "a.yandex-team.ru";
const reviewPath = /^\/review\/([1-9]\d*)(?:\/|$)/u;
export const settings = makeProviderSettingsSchema(hostCredentialSettingsFields);

export const definition = defineSourceControl({
  kind,
  label: "Arcanum",
  pickerLabel: "Arcanum",
  icon: null,
  searchKeywords: ["Arc", "Arcadia", "Аркадия"],
  credentials: {
    cliName: "arc",
    cliLabel: "Arc CLI",
    loginCommand: "arc token store",
    tokenEnvVar: "ARC_TOKEN",
    tokenAccess: "access to Arc and Arcanum",
    newTokenUrl: () =>
      "https://oauth.yandex-team.ru/authorize?response_type=token&client_id=5c407aafc5c242948b532842a9a07da6",
  },
  changeRequest: {
    shortLabel: "PR",
    shortLabelWithArticle: "a PR",
    singular: "pull request",
    plural: "pull requests",
  },
  repositoryPathHint: "arcadia",
  publicHost: host,
  publishDescription: "Arcanum",
  supportsRepositoryCreation: false,
  publishHost: () => host,
  newRepositoryOwner: () => null,
  defaultCloneTransport: "https",
  changeRequestUrl: (input) =>
    input.host === host &&
    input.repository === "arcadia" &&
    Number.isSafeInteger(input.number) &&
    input.number > 0
      ? `https://${host}/review/${input.number}`
      : null,
  parseChangeRequestUrl: (url) => {
    if (
      url.protocol !== "https:" ||
      url.hostname !== host ||
      url.port ||
      url.username ||
      url.password
    )
      return null;
    const number = Number(reviewPath.exec(url.pathname)?.[1]);
    return Number.isSafeInteger(number) && number > 0
      ? { host, repository: "arcadia", number, repositoryUrl: `https://${host}/arcadia` }
      : null;
  },
  changeRequestUrlFromReferenceAutolink: () => null,
  changeRequestActions: new Set(["close", "ready", "disable-auto-merge"]),
  checkoutCommand: ({ number }) => `arc pr checkout ${number}`,
  changeRequestCloseCommand: /\barc\s+pr\s+discard\b/u,
  changeRequestCreateCommand: /\barc\s+pr\s+(?:create|c)\b/u,
  authorProfileUrl: (login) => `https://staff.yandex-team.ru/${encodeURIComponent(login)}`,
  reviewSummaryRequired: () => false,
  checkoutCommandArgument: (input) =>
    /^arc\s+pr\s+(?:checkout|co)\s+(\S+)$/iu.exec(input)?.[1] ?? null,
  isChangeRequestReference: (input) => {
    try {
      const url = new URL(input);
      return (
        url.protocol === "https:" &&
        url.hostname === host &&
        !url.port &&
        !url.username &&
        !url.password &&
        reviewPath.test(url.pathname)
      );
    } catch {
      return false;
    }
  },
  isChangeRequestInRepository: (identity, link) =>
    identity.canonicalKey === `${host}/arcadia` &&
    link.host === host &&
    link.repository === "arcadia",
  canReadChangeRequestOnHost: (identity, link) =>
    identity.canonicalKey === `${host}/arcadia` && link.host === host,
  checkoutChangeRequestHost: (identity) =>
    identity.canonicalKey === `${host}/arcadia` ? host : null,
  recognizeRemote: (remote) => {
    try {
      const url = new URL(remote.remoteUrl);
      return url.protocol === "https:" &&
        remote.hostname === host &&
        !url.port &&
        !url.username &&
        !url.password &&
        url.pathname.replace(/\/$/u, "") === "/arcadia"
        ? { kind, name: "Arcanum", baseUrl: `https://${host}` }
        : null;
    } catch {
      return null;
    }
  },
  repositorySelector: () => "arcadia",
  repositoryKeyFromRemote: (key) =>
    [
      "https://a.yandex-team.ru/arcadia",
      "https://a.yandex-team.ru/arcadia/",
      "a.yandex-team.ru/arcadia",
    ].includes(key)
      ? "a.yandex-team.ru/arcadia"
      : null,
  canonicalRepositoryKey: (key) =>
    [
      "https://a.yandex-team.ru/arcadia",
      "https://a.yandex-team.ru/arcadia/",
      "a.yandex-team.ru/arcadia",
    ].includes(key)
      ? "a.yandex-team.ru/arcadia"
      : null,
  settings,
});
