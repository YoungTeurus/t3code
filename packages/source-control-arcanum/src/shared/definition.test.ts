import {
  makeSourceControlDefinitionRegistry,
  recognizeRemoteWith,
} from "@t3tools/source-control-core/shared/definition";
import { describe, expect, it } from "vite-plus/test";
import { makeThreadPullRequests } from "@t3tools/source-control-core/shared/threadPullRequests";

import { definition, parseReviewUrl } from "./definition.ts";

describe("Arcanum change request URLs", () => {
  it("reads review URLs on the web host, whatever page of the review they open", () => {
    for (const url of [
      "https://a.yandex-team.ru/review/16806405",
      "https://A.Yandex-Team.ru/review/16806405/details",
      "https://a.yandex-team.ru/review/16806405/files/3?iteration=2#c1",
    ]) {
      expect(definition.parseChangeRequestUrl(new URL(url)), url).toEqual({
        host: "a.yandex-team.ru",
        repository: "arcadia",
        number: 16806405,
        repositoryUrl: "https://a.yandex-team.ru/arcadia",
      });
      expect(definition.isChangeRequestReference(url), url).toBe(true);
    }
    expect(definition.changeRequestUrl({ host: "x", repository: "y", number: 7 })).toBe(
      "https://a.yandex-team.ru/review/7",
    );
  });

  it("rejects other hosts, schemes, ports, credentials and malformed numbers", () => {
    for (const url of [
      "https://arcanum.yandex.net/review/7",
      "https://a.yandex-team.ru.evil.test/review/7",
      "http://a.yandex-team.ru/review/7",
      "https://a.yandex-team.ru:8443/review/7",
      "https://user:pw@a.yandex-team.ru/review/7",
      "https://a.yandex-team.ru/review/0",
      "https://a.yandex-team.ru/review/7suffix",
      "https://a.yandex-team.ru/review/9007199254740992",
      "https://a.yandex-team.ru/arcadia/review/7",
      "not a url",
    ]) {
      expect(parseReviewUrl(url), url).toBeNull();
      expect(definition.isChangeRequestReference(url), url).toBe(false);
    }
  });

  it("parses only a bare `arc pr checkout <id>`", () => {
    expect(definition.checkoutCommandArgument("arc pr checkout 123")).toBe("123");
    expect(definition.checkoutCommandArgument("arc pr co 123")).toBe("123");
    expect(definition.checkoutCommandArgument("arc pr checkout --force 123")).toBeNull();
    expect(definition.checkoutCommandArgument("gh pr checkout 123")).toBeNull();
    expect(definition.checkoutCommand({ number: 5, headBranch: "users/a/b" })).toBe(
      "arc pr checkout 5",
    );
  });
});

it("identifies a review by its global number when unlinking a saved Cloudia reference", () => {
  const registry = makeSourceControlDefinitionRegistry([definition]);
  const { threadPullRequestKeysEqual, normalizeThreadPullRequestKey } =
    makeThreadPullRequests(registry);
  const saved = { host: "a.yandex-team.ru", repository: "cloudia", number: 42 };
  const parsed = registry.parseChangeRequestUrl("https://a.yandex-team.ru/review/42")!.link;
  expect(threadPullRequestKeysEqual(saved, parsed)).toBe(true);
  expect(threadPullRequestKeysEqual(saved, { ...parsed, number: 43 })).toBe(false);
  expect(normalizeThreadPullRequestKey(saved)).toEqual({
    host: "a.yandex-team.ru",
    repository: "arcadia",
    number: 42,
  });
  expect(registry.repositoryKeyFromRemote("arc://arc-vcs.yandex-team.ru/cloudia")).toBe(
    "a.yandex-team.ru/cloudia",
  );
});

describe("Arcanum remotes", () => {
  it("claims only known Arc servers and the web host", () => {
    expect(recognizeRemoteWith(definition, "arc://arc-vcs.yandex-team.ru/arcadia")).toEqual({
      kind: "arcanum",
      name: "Arcanum",
      baseUrl: "https://a.yandex-team.ru",
    });
    expect(recognizeRemoteWith(definition, "https://a.yandex-team.ru/review/1")?.kind).toBe(
      "arcanum",
    );
    for (const remote of [
      "arc://arc.example.net/arcadia",
      "ssh://arc-vcs.yandex-team.ru/arcadia",
      "https://arc-vcs.yandex-team.ru/arcadia",
      "arc://a.yandex-team.ru/arcadia",
      "git@github.com:T3Tools/t3code.git",
    ]) {
      expect(recognizeRemoteWith(definition, remote), remote).toBeNull();
    }
  });

  it("keys the Arc server's spelling and the web host's alike, and nothing else", () => {
    expect(definition.repositoryKeyFromRemote?.("arc-vcs.yandex-team.ru/arcadia")).toBe(
      "a.yandex-team.ru/arcadia",
    );
    expect(definition.canonicalRepositoryKey?.("a.yandex-team.ru/arcadia")).toBe(
      "a.yandex-team.ru/arcadia",
    );
    expect(definition.canonicalRepositoryKey?.("arc.example.net/arcadia")).toBeNull();
    expect(definition.canonicalRepositoryKey?.("a.yandex-team.ru/team/repo")).toBeNull();
    expect(definition.canonicalRepositoryKey?.("github.com/t3tools/t3code")).toBeNull();
  });

  it("keys a review URL's repository like the project's Arc remote", () => {
    const registry = makeSourceControlDefinitionRegistry([definition]);
    const reviewRepositoryUrl = registry.parseChangeRequestUrl("https://a.yandex-team.ru/review/42")
      ?.link.repositoryUrl;
    expect(reviewRepositoryUrl).toBe("https://a.yandex-team.ru/arcadia");
    expect(
      registry.canonicalRepositoryKey(registry.repositoryKeyFromRemote(reviewRepositoryUrl!)),
    ).toBe(
      registry.canonicalRepositoryKey(
        registry.repositoryKeyFromRemote("arc://arc-vcs.yandex-team.ru/arcadia"),
      ),
    );
    expect(
      definition.canonicalRepositoryKey?.("https://arc-vcs.yandex-team.ru/arcadia"),
    ).toBeNull();
  });

  it("matches a review link to the project's repository on the web host", () => {
    const identity = {
      canonicalKey: "a.yandex-team.ru/arcadia",
      locator: {
        source: "git-remote" as const,
        remoteName: "arcadia",
        remoteUrl: "arc://arc-vcs.yandex-team.ru/arcadia",
      },
      displayName: "arcadia",
      name: "arcadia",
    };
    const link = definition.parseChangeRequestUrl(new URL("https://a.yandex-team.ru/review/42"))!;
    expect(definition.isChangeRequestInRepository(identity, link)).toBe(true);
    expect(definition.canReadChangeRequestOnHost(identity, link)).toBe(true);
    expect(
      definition.isChangeRequestInRepository(
        { ...identity, canonicalKey: "github.com/t3tools/arcadia" },
        link,
      ),
    ).toBe(false);
  });
});
