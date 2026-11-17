import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { type AssetResource, EnvironmentId } from "@t3tools/contracts";
import type { PluggableList } from "unified";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { PullRequestMarkdown, PullRequestMarkdownContext } from "./PullRequestMarkdown";
import {
  pullRequestMarkdownPlugins,
  pullRequestMarkdownSpansAttachments,
  remarkPullRequestAutolinks,
} from "./pullRequestMarkdown.logic";
import { remarkYfm } from "./remarkYfm";

const requested = vi.hoisted(() => [] as Array<AssetResource | null>);
vi.mock(import("~/assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrlState: (_environmentId, resource) => {
    requested.push(resource);
    return { _tag: "Loading" };
  },
}));

function setup() {
  requested.length = 0;
}

async function renderBody(
  host: string,
  options: { lineBreaks?: boolean; repository?: string; text?: string } = {},
) {
  const { repository = null, text = "first line\nsecond line", ...props } = options;
  const context = {
    remarkPlugins: [],
    lineBreaks: sourceControlClients.get(host).hardLineBreaks ?? false,
    threadRef: null,
    repository,
  };
  return render(
    <PullRequestMarkdownContext value={context}>
      <PullRequestMarkdown
        text={text}
        cwd="/repo"
        environmentId={EnvironmentId.make("local")}
        {...props}
      />
    </PullRequestMarkdownContext>,
  );
}

it.each(["github", "forgejo", "azure-devops"])("%s breaks a single newline", async (host) => {
  await using screen = await renderBody(host);
  await expect.element(screen.getByText(/first line/)).toBeInTheDocument();
  expect(screen.container.querySelectorAll("p br")).toHaveLength(1);
});

it.each(["gitlab", "bitbucket", "gitcafe", "unknown"])(
  "%s joins a single newline",
  async (host) => {
    await using screen = await renderBody(host);
    await expect.element(screen.getByText(/first line/)).toBeInTheDocument();
    expect(screen.container.querySelectorAll("p br")).toHaveLength(0);
  },
);

it("lets text the host did not write opt out of the host's breaks", async () => {
  await using screen = await renderBody("github", { lineBreaks: false });
  await expect.element(screen.getByText(/first line/)).toBeInTheDocument();
  expect(screen.container.querySelectorAll("p br")).toHaveLength(0);
});

it("loads the body's host media in the pull request's repository, not the checkout's", async () => {
  setup();
  const image = "https://github.com/user-attachments/assets/7195f963-51a9-4331-be74-3e06be760422";
  const video = "https://github.com/user-attachments/assets/2f8c1a90-1b2c-4d5e-8f90-abcdef123456";
  await using _screen = await renderBody("github", {
    repository: "enterprise/private",
    text: `![shot](${image})\n\n${video}`,
  });
  await vi.waitFor(() =>
    expect(requested).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cwd: "/repo",
          url: expect.stringContaining("7195f963"),
          repository: "enterprise/private",
        }),
        expect.objectContaining({
          cwd: "/repo",
          url: expect.stringContaining("2f8c1a90"),
          repository: "enterprise/private",
        }),
      ]),
    ),
  );
});

const CHANGE_REQUESTS = {
  arcanum: { provider: "arcanum", url: "https://a.yandex-team.ru/review/1" },
  github: { provider: "github", url: "https://github.com/team/repo/pull/8" },
} as const;

function markdown(
  text: string,
  provider: keyof typeof CHANGE_REQUESTS | undefined,
  remarkPlugins = pullRequestMarkdownPlugins(provider ? CHANGE_REQUESTS[provider] : null),
) {
  return (
    <PullRequestMarkdownContext
      value={{
        remarkPlugins,
        lineBreaks: sourceControlClients.get(provider ?? "unknown").hardLineBreaks ?? false,
        threadRef: null,
        repository: null,
        wholeDocument: pullRequestMarkdownSpansAttachments(provider ?? ""),
      }}
    >
      <PullRequestMarkdown
        text={text}
        cwd="/repo"
        environmentId={EnvironmentId.make("environment")}
      />
    </PullRequestMarkdownContext>
  );
}

it("opens the Arcanum ai cut and renders its child Markdown", async () => {
  await using screen = await render(
    markdown(
      'Before\n\n{% cut "ai" %}\n\nAdded **launcher** `dev/recco`.\n\n- Native backend\n- Frontend\n\n{% endcut %}\n\nAfter',
      "arcanum",
    ),
  );
  const cut = screen.container.querySelector("[data-markdown-details]")!;
  expect(cut.getAttribute("data-markdown-details-open")).toBe("false");
  await userEvent.click(screen.getByText("ai", { exact: true }));
  await expect.element(screen.getByText("launcher", { exact: true })).toBeVisible();
  expect(cut.querySelector("strong")?.textContent).toBe("launcher");
  expect(cut.querySelector("code")?.textContent).toBe("dev/recco");
  expect(cut.querySelectorAll("li")).toHaveLength(2);
  expect(screen.container.textContent).not.toContain("{% cut");
});

it("renders nested YFM notes, tabs and tables inside a cut and keeps fenced tags literal", async () => {
  const text = [
    '{% cut "Details" %}',
    '{% note warning "Heads up" %}',
    "A **nested** note.",
    "{% endnote %}",
    "",
    "{% list tabs %}",
    "",
    "- First",
    "",
    "  First panel",
    "",
    "- Second",
    "",
    "  #|",
    "  || **Name** | **Value** ||",
    "  || Item | **Result** ||",
    "  |#",
    "",
    "{% endlist %}",
    "",
    "```text",
    '{% cut "Literal" %}',
    "{% endcut %}",
    "```",
    "{% endcut %}",
  ].join("\n");
  await using screen = await render(markdown(text, "arcanum"));
  await userEvent.click(screen.getByText("Details", { exact: true }));
  const note = screen.container.querySelector('[data-markdown-details] [role="note"]')!;
  expect(note.textContent).toContain("Heads up");
  expect(note.querySelector("strong")?.textContent).toBe("nested");
  await expect.element(screen.getByRole("tabpanel")).toHaveTextContent("First panel");
  await userEvent.click(screen.getByRole("tab", { name: "Second" }));
  await expect
    .element(screen.getByRole("tab", { name: "Second" }))
    .toHaveAttribute("aria-selected", "true");
  await expect.element(screen.getByRole("tabpanel")).toMatchTextContent("Result");
  expect(screen.container.querySelector("[role=tabpanel] table td strong")?.textContent).toBe(
    "Name",
  );
  expect(screen.container.querySelectorAll("[data-markdown-details]")).toHaveLength(1);
  expect(screen.container.querySelector("pre")?.textContent).toContain('{% cut "Literal" %}');
});

it("keeps unsafe HTML and link schemes out of a cut and its title", async () => {
  const text = [
    '{% cut "<img src=x onerror=alert(1)> Title" %}',
    "",
    '<script>alert(1)</script><iframe src="https://example.com"></iframe>',
    "",
    '<a href="javascript:alert(1)" onclick="alert(1)">Raw link</a>',
    "",
    "[Unsafe](javascript:alert(1)) and [Safe](https://example.com/safe)",
    "",
    "{% endcut %}",
  ].join("\n");
  await using screen = await render(markdown(text, "arcanum"));
  // The sanitized <img> renders as an image of its own beside the title text.
  await userEvent.click(screen.getByRole("button", { name: /Title/ }));
  await expect
    .element(screen.getByRole("link", { name: "Safe", exact: true }))
    .toHaveAttribute("href", "https://example.com/safe");
  expect(screen.container.querySelector("script, iframe, [onerror], [onclick]")).toBeNull();
  expect(screen.container.querySelector('a[href^="javascript:"]')).toBeNull();
});

const RECCO_AUTOLINKS: PluggableList = [
  remarkYfm,
  [
    remarkPullRequestAutolinks,
    {
      autolinks: (value: string) =>
        value === "RECCO-123"
          ? [
              {
                kind: "reference",
                index: 0,
                text: value,
                label: value,
                url: "https://st.yandex-team.ru/RECCO-123",
              },
            ]
          : [],
    },
  ],
];

it("keeps attachment URLs and later remark plugins working inside cuts", async () => {
  const url = "https://arcanum.s3.mds.yandex.net/files/person/opaque-upload-id";
  const text = [
    '{% cut "Evidence" %}',
    "",
    "RECCO-123",
    "",
    `[report.zip](${url})`,
    "",
    "{% endcut %}",
  ].join("\n");
  await using screen = await render(markdown(text, "arcanum", RECCO_AUTOLINKS));
  await userEvent.click(screen.getByText("Evidence", { exact: true }));
  await expect
    .element(screen.getByRole("link", { name: "report.zip" }))
    .toHaveAttribute("href", url);
  await expect
    .element(screen.getByRole("link", { name: "RECCO-123" }))
    .toHaveAttribute("href", "https://st.yandex-team.ru/RECCO-123");
});

it.each([undefined, "github"] as const)(
  "keeps YFM tags literal for provider %s",
  async (provider) => {
    await using screen = await render(
      markdown('{% cut "ai" %}\n\n**Still Markdown**\n\n{% endcut %}', provider),
    );
    expect(screen.container.querySelector("[data-markdown-details]")).toBeNull();
    expect(screen.container.textContent).toContain('{% cut "ai" %}');
    expect(screen.container.querySelector("strong")?.textContent).toBe("Still Markdown");
  },
);

it("keeps attachments inside an Arcanum cut in one document", async () => {
  // Served by the test's own origin, so the image loads and the video fails the same way offline.
  const { origin } = window.location;
  await using screen = await render(
    markdown(
      `{% cut "Evidence" %}\n\n${origin}/favicon-16x16.png\n\n${origin}/missing-clip.mp4\n\n{% endcut %}`,
      "arcanum",
    ),
  );
  expect(screen.container.querySelectorAll(".chat-markdown")).toHaveLength(1);
  expect(screen.container.textContent).not.toContain("{% cut");
  await userEvent.click(screen.getByText("Evidence", { exact: true }));
  const cut = screen
    .getByText("Evidence", { exact: true })
    .element()
    .closest("[data-markdown-details]")!;
  await vi.waitFor(() => expect(cut.querySelector("img[src$='favicon-16x16.png']")).not.toBeNull());
  await expect.element(screen.getByText(/Video unavailable/)).toBeInTheDocument();
  expect(cut.textContent).toMatch(/Video unavailable/);
});

it("gives a collapsible heading's anchor a target", async () => {
  await using screen = await render(markdown("[Go](#fold)\n\n##+ Fold {#fold}\n\nBody", "arcanum"));
  await expect.element(screen.getByText("Fold", { exact: true })).toBeInTheDocument();
  expect(screen.container.querySelector("#user-content-fold")).not.toBeNull();
});
