import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { act, render } from "../../test/render";
import "../index.css";

const environmentId = EnvironmentId.make("environment-1");
const source = ThreadId.make("source");
const target = ThreadId.make("target");
const settled = ThreadId.make("settled");

vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => [{ environmentId, id: "project", title: "Project" }]) as never,
  useThreadShells: (() => [
    {
      environmentId,
      id: source,
      projectId: "project",
      title: "Current",
      deletedAt: null,
      archivedAt: null,
      settledAt: null,
      settledOverride: null,
      updatedAt: "2026-01-01",
    },
    {
      environmentId,
      id: target,
      projectId: "project",
      title: "Active target",
      deletedAt: null,
      archivedAt: null,
      settledAt: null,
      settledOverride: null,
      updatedAt: "2026-01-01",
    },
    {
      environmentId,
      id: settled,
      projectId: "project",
      title: "Settled target",
      deletedAt: null,
      archivedAt: null,
      settledAt: "2026-01-01",
      settledOverride: "settled",
      updatedAt: "2026-01-01",
    },
  ]) as never,
}));
vi.mock(import("../state/queries"), async (original) => ({
  ...(await original()),
  useThreadSearch: (() => ({ matches: [], query: "", isPending: false })) as never,
}));

import { requestSnoozeUntilThread, SnoozeUntilThreadDialogHost } from "./SnoozeUntilThreadDialog";

describe("Snooze until another thread", () => {
  it("excludes settled threads by default and accepts a successful-run wait", async () => {
    await using _screen = await render(<SnoozeUntilThreadDialogHost />);
    let result!: Promise<unknown>;
    await act(() => {
      result = requestSnoozeUntilThread(environmentId, source);
    });
    await expect.element(page.getByText("Active target", { exact: false })).toBeInTheDocument();
    await expect
      .element(page.getByText("Settled target", { exact: false }))
      .not.toBeInTheDocument();
    await userEvent.click(page.getByRole("checkbox", { name: "Include settled threads" }));
    await userEvent.click(page.getByRole("button", { name: /Settled target/ }));
    await expect
      .element(page.getByText("This thread is already settled. Choose another thread or event."))
      .toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Snooze", exact: true })).toBeDisabled();
    await userEvent.click(page.getByRole("radio", { name: "Successful run" }));
    await userEvent.click(page.getByRole("button", { name: "Snooze", exact: true }));
    expect(await result).toEqual({ targetThreadId: settled, until: "completed" });
  });
  it("identifies the existing wait when hiding it again", async () => {
    await using _screen = await render(<SnoozeUntilThreadDialogHost />);
    let result!: Promise<unknown>;
    await act(() => {
      result = requestSnoozeUntilThread(environmentId, source, {
        targetThreadId: target,
        until: "settled",
        visibility: "visible",
        dependencyId: "original-wait",
      });
    });
    await userEvent.click(page.getByRole("button", { name: /Active target/ }));
    await userEvent.click(page.getByRole("button", { name: "Snooze", exact: true }));
    expect(await result).toEqual({
      targetThreadId: target,
      until: "settled",
      expectedDependencyId: "original-wait",
    });
  });
});
