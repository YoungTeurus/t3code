import type { ServerProvider, ServerProviderPlugin } from "@t3tools/contracts";
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "@t3tools/shared/searchRanking";

export function formatPluginMention(plugin: ServerProviderPlugin): string {
  // Codex restricts linked aliases to ASCII mention names and reserves environment-variable names.
  const label = `plugin-${plugin.name.replace(/[^A-Za-z0-9_:-]+/g, "-").replace(/^-+|-+$/g, "") || "mention"}`;
  return `[@${label}](plugin://${plugin.id})`;
}

export function searchProviderPlugins(
  plugins: ReadonlyArray<ServerProviderPlugin>,
  query: string,
): ReadonlyArray<ServerProviderPlugin> {
  const normalizedQuery = normalizeSearchQuery(query);
  if (!normalizedQuery) return plugins;
  const ranked: Array<{ item: ServerProviderPlugin; score: number; tieBreaker: string }> = [];
  for (const plugin of plugins) {
    const scores = [plugin.name, plugin.id, plugin.description ?? ""]
      .map((value, index) =>
        scoreQueryMatch({
          value: value.toLowerCase(),
          query: normalizedQuery,
          exactBase: index * 10,
          prefixBase: index * 10 + 2,
          includesBase: index * 10 + 4,
          fuzzyBase: index * 10 + 100,
        }),
      )
      .filter((score): score is number => score !== null);
    if (scores.length === 0) continue;
    insertRankedSearchResult(
      ranked,
      {
        item: plugin,
        score: Math.min(...scores),
        tieBreaker: `${plugin.name.toLowerCase()}\u0000${plugin.id}`,
      },
      Number.POSITIVE_INFINITY,
    );
  }
  return ranked.map((entry) => entry.item);
}

export function pluginMenuDescription(
  plugin: ServerProviderPlugin,
  plugins: ReadonlyArray<ServerProviderPlugin>,
): string {
  return plugins.some(
    (candidate) =>
      candidate.id !== plugin.id && candidate.name.toLowerCase() === plugin.name.toLowerCase(),
  )
    ? plugin.id
    : (plugin.description ?? plugin.source);
}

export function resolveProviderPluginCatalogForCwd(
  provider: Pick<ServerProvider, "pluginCatalog" | "workspaceSnapshots">,
  cwd: string | null,
) {
  return (
    provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === cwd)?.pluginCatalog ??
    provider.pluginCatalog
  );
}

export function collectPluginMentions(text: string) {
  return [...text.matchAll(/\[@((?:\\.|[^\]\\])*)\]\(plugin:\/\/([^\s)]+)\)/g)].map((match) => ({
    type: "plugin" as const,
    value: match[2]!,
    label: match[1]!.replace(/\\(.)/g, "$1"),
    source: match[0],
    start: match.index!,
    end: match.index! + match[0].length,
  }));
}
