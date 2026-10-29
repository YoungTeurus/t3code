import { expect, it } from "@effect/vitest";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as Effect from "effect/Effect";
import { CodexAppServerRequestError } from "effect-codex-app-server/errors";

import { parseCodexPluginInstalledResponse, readCodexPluginCatalog } from "./codexPluginCatalog.ts";

const plugin = (
  id: string,
  overrides: Partial<CodexSchema.V2PluginInstalledResponse__PluginSummary> = {},
): CodexSchema.V2PluginInstalledResponse__PluginSummary => ({
  id,
  name: "sample",
  installed: true,
  enabled: true,
  authPolicy: "ON_USE",
  installPolicy: "AVAILABLE",
  source: { type: "remote" },
  ...overrides,
});

it.effect("reports unsupported plugin RPC without failing provider discovery", () =>
  Effect.gen(function* () {
    const catalog = yield* readCodexPluginCatalog(
      Effect.fail(CodexAppServerRequestError.methodNotFound("plugin/installed")),
    );
    expect(catalog).toEqual({
      status: "unsupported",
      plugins: [],
      message: "This Codex version does not support plugin mentions.",
    });
  }),
);

it.effect("reports plugin discovery failure without exposing provider error details", () =>
  Effect.gen(function* () {
    const catalog = yield* readCodexPluginCatalog(
      Effect.fail(new CodexAppServerRequestError({ code: -32000, errorMessage: "private detail" })),
    );
    expect(catalog).toEqual({
      status: "error",
      plugins: [],
      message: "Codex plugins could not be loaded. Refresh the provider to try again.",
    });
  }),
);

it("offers only usable installed plugins and preserves exact IDs for duplicate names", () => {
  const catalog = parseCodexPluginInstalledResponse({
    marketplaces: [
      {
        name: "personal",
        plugins: [
          plugin("sample@personal", {
            interface: {
              displayName: "Sample Plugin",
              shortDescription: "Search messages",
              capabilities: [],
              screenshots: [],
              screenshotUrls: [],
            },
          }),
          plugin("uninstalled@personal", { installed: false }),
          plugin("disabled@personal", { enabled: false }),
          plugin("blocked@personal", { availability: "DISABLED_BY_ADMIN" }),
        ],
      },
      { name: "team", plugins: [plugin("sample@team")] },
    ],
  });
  expect(catalog).toEqual({
    status: "ready",
    plugins: [
      {
        id: "sample@personal",
        name: "Sample Plugin",
        description: "Search messages",
        source: "personal",
      },
      { id: "sample@team", name: "sample", source: "team" },
    ],
  });
});

it("keeps successful marketplaces usable when another marketplace fails", () => {
  expect(
    parseCodexPluginInstalledResponse({
      marketplaces: [{ name: "team", plugins: [plugin("sample@team")] }],
      marketplaceLoadErrors: [{ marketplacePath: "/missing", message: "Failed to load" }],
    }),
  ).toEqual({
    status: "error",
    plugins: [{ id: "sample@team", name: "sample", source: "team" }],
    message: "Some plugin marketplaces could not be loaded.",
  });
});
