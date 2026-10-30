import { vi } from "vite-plus/test";

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  if (process.env.T3CODE_TEST_KEEP_PROVIDER_ENV === "1") return sdk;
  return {
    ...sdk,
    // Replays describe their own policy; a host MDM policy must not alter recorded SDK frames.
    resolveSettings: (options?: Parameters<typeof sdk.resolveSettings>[0]) =>
      sdk.resolveSettings({
        ...options,
        serverManagedSettings: { model: "test-model", ...options?.serverManagedSettings },
      }),
  };
});
