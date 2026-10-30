import { assert, describe, it } from "@effect/vitest";
import { makeSourceControlDefinitionRegistry } from "@t3tools/source-control-core/shared/definition";

import { definition } from "./definition.ts";

describe("Arcanum identity", () => {
  it("claims native review URLs without inventing an owner or a Git PR ref", () => {
    const registry = makeSourceControlDefinitionRegistry([definition]);
    const parsed = definition.parseChangeRequestUrl(
      new URL("https://a.yandex-team.ru/review/16762821?iteration=3"),
    );
    assert.deepEqual(parsed, {
      host: "a.yandex-team.ru",
      repository: "arcadia",
      number: 16762821,
      repositoryUrl: "https://a.yandex-team.ru/arcadia",
    });
    assert.equal(registry.recognizeRemote("https://a.yandex-team.ru/arcadia")?.kind, "arcanum");
    assert.equal(
      registry.repositoryKeyFromRemote("https://a.yandex-team.ru/arcadia"),
      "a.yandex-team.ru/arcadia",
    );
    assert.equal(
      definition.changeRequestUrl({ host: "a.yandex-team.ru", repository: "arcadia", number: 42 }),
      "https://a.yandex-team.ru/review/42",
    );
    assert.equal(definition.parseChangeRequestUrl(new URL("https://evil.example/review/42")), null);
    assert.equal(registry.recognizeRemote("git@a.yandex-team.ru:arcadia")?.kind, "unknown");
    assert.isFalse(definition.isChangeRequestReference("http://a.yandex-team.ru/review/42"));
    assert.isFalse(
      definition.isChangeRequestReference("https://user:password@a.yandex-team.ru/review/42"),
    );
    assert.isFalse("changeRequestHeadRef" in definition);
    assert.equal(definition.newRepositoryOwner(), null);
    assert.equal(definition.supportsRepositoryCreation, false);
    assert.deepEqual(
      [...definition.changeRequestActions],
      ["close", "ready", "disable-auto-merge"],
    );
  });
});
