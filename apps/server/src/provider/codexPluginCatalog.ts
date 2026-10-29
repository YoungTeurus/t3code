import type * as CodexSchema from "effect-codex-app-server/schema";
import type { ServerProviderPluginCatalog } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  type CodexAppServerError,
  CodexAppServerRequestError,
} from "effect-codex-app-server/errors";

const isCodexRequestError = Schema.is(CodexAppServerRequestError);

export const readCodexPluginCatalog = Effect.fn("readCodexPluginCatalog")(function* (
  request: Effect.Effect<CodexSchema.V2PluginInstalledResponse, CodexAppServerError>,
): Effect.fn.Return<ServerProviderPluginCatalog> {
  return yield* request.pipe(
    Effect.timeout("4 seconds"),
    Effect.match({
      onSuccess: parseCodexPluginInstalledResponse,
      onFailure: (error): ServerProviderPluginCatalog =>
        isCodexRequestError(error) && error.code === -32601
          ? {
              status: "unsupported",
              plugins: [],
              message: "This Codex version does not support plugin mentions.",
            }
          : {
              status: "error",
              plugins: [],
              message: "Codex plugins could not be loaded. Refresh the provider to try again.",
            },
    }),
  );
});

export function parseCodexPluginInstalledResponse(
  response: CodexSchema.V2PluginInstalledResponse,
): ServerProviderPluginCatalog {
  const plugins = response.marketplaces.flatMap((marketplace) =>
    marketplace.plugins
      .filter(
        (plugin) =>
          plugin.installed && plugin.enabled && plugin.availability !== "DISABLED_BY_ADMIN",
      )
      .map((plugin) => ({
        id: plugin.id,
        name: plugin.interface?.displayName?.trim() || plugin.name,
        ...(plugin.interface?.shortDescription?.trim()
          ? { description: plugin.interface.shortDescription.trim() }
          : {}),
        source: marketplace.name,
      })),
  );
  return response.marketplaceLoadErrors?.length
    ? {
        status: "error",
        plugins,
        message: "Some plugin marketplaces could not be loaded.",
      }
    : { status: "ready", plugins };
}
