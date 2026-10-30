import { expect, it } from "vite-plus/test";
import type { ServerProviderPlugin } from "@t3tools/contracts";

import {
  formatPluginMention,
  pluginMenuDescription,
  searchProviderPlugins,
} from "./providerPluginMentions";

const plugins: ServerProviderPlugin[] = [
  { id: "messages@personal", name: "TelegramEve", source: "personal" },
  { id: "messages@team", name: "TelegramEve", source: "team" },
  { id: "gmail@official", name: "Gmail", source: "official" },
];

it("searches plugin names and exact IDs without collapsing duplicate display names", () => {
  expect(searchProviderPlugins(plugins, "telegram")).toEqual(plugins.slice(0, 2));
  expect(searchProviderPlugins(plugins, "messages@team")).toEqual([plugins[1]]);
  expect(searchProviderPlugins(plugins, "missing")).toEqual([]);
});

it("ranks a display-name prefix above a loose match in another plugin ID", () => {
  const cloud = { id: "cloud-environment@official", name: "Cloud Environment", source: "official" };
  const tools = {
    id: "codex-app-tools@openai-bundled",
    name: "codex-app-tools",
    source: "openai-bundled",
  };
  expect(searchProviderPlugins([tools, cloud], "cloud")[0]).toBe(cloud);
});

it.each([
  ["TelegramEve", "plugin-TelegramEve"],
  ["Google Drive", "plugin-Google-Drive"],
  ["Tools [one] \\ two", "plugin-Tools-one-two"],
  ["Мои инструменты", "plugin-mention"],
  ["HOME", "plugin-HOME"],
])("uses a native-compatible linked alias for %s while preserving the exact ID", (name, alias) => {
  expect(formatPluginMention({ id: "tools@team", name, source: "team" })).toBe(
    `[@${alias}](plugin://tools@team)`,
  );
});

it("distinguishes equal display names within the same marketplace by exact ID", () => {
  const sameName = [
    { id: "first@team", name: "Tools", source: "team" },
    { id: "second@team", name: "Tools", source: "team" },
  ];
  expect(sameName.map((plugin) => pluginMenuDescription(plugin, sameName))).toEqual([
    "first@team",
    "second@team",
  ]);
});
