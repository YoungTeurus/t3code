import { changeRequestReferenceAutolinker } from "@t3tools/client-runtime/pull-request-markdown";
import {
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS,
} from "@t3tools/shared/markdownPipeline";
import type { Root as HastRoot } from "hast";
import { toHtml } from "hast-util-to-html";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { describe, expect, it } from "vite-plus/test";

import {
  pullRequestCommentPreview,
  pullRequestMarkdownPlugins,
  remarkPullRequestAutolinks,
} from "./pullRequestMarkdown.logic";
import { remarkYfm } from "./remarkYfm";

type Node = {
  type: string;
  value?: string;
  url?: string;
  data?: { hProperties?: Record<string, unknown> };
  children?: Node[];
};

function links(markdown: string) {
  const autolinks = changeRequestReferenceAutolinker({
    provider: "github",
    url: "https://github.com/team/repo/pull/8",
  })!;
  const tree = unified().use(remarkParse).parse(markdown) as Node;
  remarkPullRequestAutolinks({ autolinks })(tree as never);
  const found: Array<[string | undefined, string | undefined, unknown]> = [];
  const visit = (node: Node) => {
    if (node.type === "link") {
      found.push([
        node.children?.[0]?.value,
        node.url,
        node.data?.hProperties?.["dataPullRequestAutolink"],
      ]);
    }
    node.children?.forEach(visit);
  };
  visit(tree);
  return found;
}

describe("remarkPullRequestAutolinks", () => {
  it("links the host's references in prose and leaves links and code alone", () => {
    expect(links("Fixes #12 in **abcdef1**. [#13](https://example.com) `#14`")).toEqual([
      ["#12", "https://github.com/team/repo/issues/12", "reference"],
      ["abcdef1", "https://github.com/team/repo/commit/abcdef1", "commit"],
      ["#13", "https://example.com", undefined],
    ]);
  });
});

describe("pullRequestCommentPreview", () => {
  it.each([
    ["<!-- hidden -->\n> [!WARNING]\n**Guard** [this](https://example.com).", "Guard this."],
    [
      '<a href="https://example.com"><img src="badge.svg" /></a>\n<strong>Tasks keep the wrong computer</strong>',
      "Tasks keep the wrong computer",
    ],
    [
      "<details><summary>Review &amp; fixes</summary><p>First<br>Second</p></details>",
      "Review & fixes First Second",
    ],
    ['<p title="value > limit">Keep <strong>this</strong> readable.</p>', "Keep this readable."],
    [
      "Use `<div>` and `Promise<void>`.\n\n```html\n<span>example</span>\n```",
      "Use <div> and Promise<void>. <span>example</span>",
    ],
    ["![badge](https://example.com/badge.svg) **Review**", "badge Review"],
    ["```md\n[!TIP]\n> [!WARNING]\n```\n\n    [!NOTE]", "[!TIP] > [!WARNING] [!NOTE]"],
    [
      "Review :codex-file-citation{purpose='output'} safely.",
      "Review :codex-file-citation{purpose='output'} safely.",
    ],
    [":codex-followup[Prepare **print** version]", ":codex-followup[Prepare **print** version]"],
  ])("extracts readable text from %s", (body, expected) => {
    expect(pullRequestCommentPreview(body)).toBe(expected);
  });
});

describe("pullRequestMarkdownPlugins", () => {
  it("adds YFM only for a host that renders it, in one list per repository", () => {
    const arcanum = pullRequestMarkdownPlugins({
      provider: "arcanum",
      url: "https://a.yandex-team.ru/review/1",
    });
    expect(arcanum).toContain(remarkYfm);
    expect(
      pullRequestMarkdownPlugins({ provider: "arcanum", url: "https://a.yandex-team.ru/review/2" }),
    ).toBe(arcanum);
    expect(
      pullRequestMarkdownPlugins({
        provider: "github",
        url: "https://github.com/team/repo/pull/8",
      }),
    ).not.toContain(remarkYfm);
  });
});

describe("remarkPullRequestAttachments", () => {
  const arcanum = pullRequestMarkdownPlugins({
    provider: "arcanum",
    url: "https://a.yandex-team.ru/review/1",
  });
  const processor = unified()
    .use(remarkParse)
    .use(CHAT_MARKDOWN_REMARK_PLUGINS)
    .use(arcanum)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
  const render = (text: string) =>
    toHtml(processor.runSync(processor.parse(text), text) as HastRoot).replace(/>\n/g, ">");

  const image = (url: string, kind = "image") =>
    `<p><img src="${url}" alt="" data-media-kind="${kind}" data-standalone></p>`;

  it("renders an attachment paragraph as media inside a YFM container", () => {
    expect(
      render(
        '{% cut "Evidence" %}\n\nhttps://example.com/screenshot.png\n\n[clip.mp4](https://example.com/clip.mp4)\n{% endcut %}',
      ),
    ).toBe(
      `<details><summary>Evidence</summary>${image("https://example.com/screenshot.png")}${image("https://example.com/clip.mp4", "video")}</details>`,
    );
    // The tags split one paragraph: the line between them is a paragraph of its own.
    expect(render('{% cut "Tight" %}\nhttps://example.com/a.png\n{% endcut %}')).toBe(
      `<details><summary>Tight</summary>${image("https://example.com/a.png")}</details>`,
    );
    expect(
      render('{% cut "A" %}\n[Screenshot](https://example.com/a.png?token=abc).\n{% endcut %}'),
    ).toBe(
      '<details><summary>A</summary><p><a href="https://example.com/a.png?token=abc">Screenshot</a>.</p></details>',
    );
    expect(render("See https://example.com/a.png here")).toBe(
      '<p>See <a href="https://example.com/a.png">https://example.com/a.png</a> here</p>',
    );
  });

  it("leaves a paragraph with an attachment line among others as it is", () => {
    expect(render("A  \nB\nhttps://example.com/a.png\nAfter")).toBe(
      '<p>A<br>B\n<a href="https://example.com/a.png">https://example.com/a.png</a>After</p>',
    );
    for (const text of [
      "Before <!--\nhttps://example.com/a.png\n-->\nAfter\nEnd",
      "Before `code\nhttps://example.com/a.png\n` After\nEnd",
    ]) {
      const html = render(text);
      expect(html, text).not.toContain("<img");
      expect(html, text).toContain("After");
      expect(html, text).toContain("End");
    }
  });

  it("renders video embeds as videos", () => {
    expect(render('<video src="https://example.com/a.mp4"></video>')).toBe(
      image("https://example.com/a.mp4", "video"),
    );
    expect(render('<video controls>\n<source src="https://example.com/stream">\n</video>')).toBe(
      image("https://example.com/stream", "video"),
    );
    expect(
      render(
        '{% cut "Clip" %}\n\n<video\n src="https://example.com/a.mp4"></video>\n\n{% endcut %}',
      ),
    ).toBe(
      `<details><summary>Clip</summary>${image("https://example.com/a.mp4", "video")}</details>`,
    );
  });
});
