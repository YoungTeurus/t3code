import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import "../../index.css";
import { SnoozeMenuButton } from "./SidebarThreadRow";

describe("sidebar snooze button", () => {
  it("offers waiting for another thread on a supported server", async () => {
    const onSnoozeUntilThread = vi.fn();
    await using _screen = await render(
      <SnoozeMenuButton
        open
        onOpenChange={() => {}}
        onSnooze={() => {}}
        onSnoozeUntilThread={onSnoozeUntilThread}
        snoozeDependencySupported
        timestampFormat="locale"
        environmentId={EnvironmentId.make("environment-1")}
      />,
    );
    await userEvent.click(page.getByRole("menuitem", { name: "Until another thread…" }));
    expect(onSnoozeUntilThread).toHaveBeenCalledOnce();
  });

  it("keeps time snooze available on an older server", async () => {
    await using _screen = await render(
      <SnoozeMenuButton
        open
        onOpenChange={() => {}}
        onSnooze={() => {}}
        onSnoozeUntilThread={() => {}}
        snoozeDependencySupported={false}
        timestampFormat="locale"
        environmentId={EnvironmentId.make("environment-1")}
      />,
    );
    await expect.element(page.getByRole("menuitem", { name: "Custom…" })).toBeInTheDocument();
    await expect
      .element(page.getByRole("menuitem", { name: "Until another thread…" }))
      .not.toBeInTheDocument();
  });
});
