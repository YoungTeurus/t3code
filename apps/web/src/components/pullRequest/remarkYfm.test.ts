import {
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS,
} from "@t3tools/shared/markdownPipeline";
import type { Root } from "hast";
import { toHtml } from "hast-util-to-html";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { describe, expect, it } from "vite-plus/test";

import { remarkYfm } from "./remarkYfm";

// ChatMarkdown's own pipeline, sanitizer included, so generated markup must survive it.
const processor = unified()
  .use(remarkParse)
  .use(CHAT_MARKDOWN_REMARK_PLUGINS)
  .use(remarkYfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
const plain = unified()
  .use(remarkParse)
  .use(CHAT_MARKDOWN_REMARK_PLUGINS)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(CHAT_MARKDOWN_REHYPE_PLUGINS);

const render = (text: string, pipeline = processor) =>
  toHtml(pipeline.runSync(pipeline.parse(text), text) as Root).replace(/>\n/g, ">");

describe("remarkYfm", () => {
  it.each([
    [
      'Before\n\n{% cut "ai" %}\n\nAdded **launcher**.\n\n- One\n- Two\n\n{% endcut %}\n\nAfter',
      "<p>Before</p><details><summary>ai</summary><p>Added <strong>launcher</strong>.</p><ul><li>One</li><li>Two</li></ul></details><p>After</p>",
    ],
    [
      '{% cut "Run `npm test`" %}\nBody\n{% endcut %}',
      '<details><summary>Run <code data-inline-code="">npm test</code></summary><p>Body</p></details>',
    ],
    [
      "::: cut [Use `--force`]\nBody\n:::",
      '<details><summary>Use <code data-inline-code="">--force</code></summary><p>Body</p></details>',
    ],
    ["::: cut\nBody\n:::", "<details><p>Body</p></details>"],
    [
      '{% cut "<img src=x onerror=alert(1)>" %}\n[Unsafe](javascript:alert(1))\n{% endcut %}',
      '<details><summary><img src="x"></summary><p><a>Unsafe</a></p></details>',
    ],
    [
      '{% cut "Changes" %}\n- tight\n- list\n{% endcut %}',
      "<details><summary>Changes</summary><ul><li>tight</li><li>list</li></ul></details>",
    ],
    [
      '{% cut "Outer" %}\n- item\n  {% cut "Inner" %}\n  Body\n  {% endcut %}\n{% endcut %}',
      "<details><summary>Outer</summary><ul><li>item\n<details><summary>Inner</summary><p>Body</p></details></li></ul></details>",
    ],
  ])("renders cuts: %s", (text, html) => {
    expect(render(text)).toBe(html);
  });

  it("renders notes as alerts, with an inline-markdown title", () => {
    for (const [style, alert] of [
      ["note", "note"],
      ["info", "note"],
      ["tip", "tip"],
      ["warning", "warning"],
      ["alert", "caution"],
    ]) {
      expect(render(`{% note ${style} %}\nBody\n{% endnote %}`)).toBe(
        `<blockquote data-alert="${alert}"><p>Body</p></blockquote>`,
      );
    }
    expect(
      render(
        '{% note warning "Run `checks`" %}\nBefore\n{% cut "Details" %}\nBody\n{% endcut %}\n{% endnote %}',
      ),
    ).toBe(
      '<blockquote data-alert="warning"><div data-yfm="note-title">Run <code data-inline-code="">checks</code></div><p>Before</p><details><summary>Details</summary><p>Body</p></details></blockquote>',
    );
  });

  it("renders tabs from the list between the tags", () => {
    expect(
      render(
        "{% list tabs %}\n\n- One\n\n  Intro\n\n  - Alpha\n  - Beta\n\n- Two\n\n      literal\n\n{% endlist %}",
      ),
    ).toBe(
      '<div data-yfm="tabs"><div data-yfm="tab-list"><div data-yfm="tab value=0">One</div><div data-yfm="tab value=1">Two</div></div><div data-yfm="tab-panel value=0"><p>Intro</p><ul><li>Alpha</li><li>Beta</li></ul></div><div data-yfm="tab-panel value=1"><pre><code>literal\n</code></pre></div></div>',
    );
    expect(render("{% list tabs %}\n- **One**\n- Two\n  Body\n{% endlist %}")).toBe(
      '<div data-yfm="tabs"><div data-yfm="tab-list"><div data-yfm="tab value=0"><strong>One</strong></div><div data-yfm="tab value=1">Two</div></div><div data-yfm="tab-panel value=0"></div><div data-yfm="tab-panel value=1"><p>Body</p></div></div>',
    );
  });

  it("renders styled blocks and layouts with validated attributes only", () => {
    expect(render("{% block padding=s border=dashed %}\n++Team++\n{% endblock %}")).toBe(
      '<div data-yfm="block padding=s border=dashed"><p>++Team++</p></div>',
    );
    expect(
      render(
        "{% layout gap=s cols=auto justify=center %}\n{% block col=4 align=center width=320 borderColor=tip %}\nA\n{% endblock %}\n{% block %}\nB\n{% endblock %}\n{% block %}\nC\n{% endblock %}\n{% endlayout %}",
      ),
    ).toBe(
      '<div data-yfm="layout gap=s cols=auto justify=center"><div data-yfm="layout-column span=4 align=center width=320 borderColor=tip"><p>A</p></div><div data-yfm="layout-column span=4"><p>B</p></div><div data-yfm="layout-column span=4"><p>C</p></div></div>',
    );
    for (const attributes of [
      "padding=huge",
      'width="javascript:alert(1)"',
      'borderColor="red;display:none"',
      "align=left align=right",
      "col=4",
      "constructor=x",
      "toString=x",
    ]) {
      const text = `{% block ${attributes} %}\nPreserve\n{% endblock %}`;
      expect(render(text)).toBe(render(text, plain));
    }
  });

  it.each([
    [
      "#|\n|| **A** | **B** ||\n|| Paragraph\non another line\n|\n- First\n- Second\n||\n|#\nAfter",
      "<table><tbody><tr><td><p><strong>A</strong></p></td><td><p><strong>B</strong></p></td></tr><tr><td><p>Paragraph\non another line</p></td><td><ul><li>First</li><li>Second</li></ul></td></tr></tbody></table><p>After</p>",
    ],
    [
      "#|\n||Text\n|\n- Potatoes\n- Onions||\n|#",
      "<table><tbody><tr><td><p>Text</p></td><td><ul><li>Potatoes</li><li>Onions</li></ul></td></tr></tbody></table>",
    ],
    [
      "#|\n|| A \\| B | `code | pipe` | A \\\\| B ||\n|#",
      '<table><tbody><tr><td><p>A | B</p></td><td><p><code data-inline-code="">code | pipe</code></p></td><td><p>A \\</p></td><td><p>B</p></td></tr></tbody></table>',
    ],
    [
      "#|\r\n\r\n|| | B | ||\r\n|#",
      "<table><tbody><tr><td></td><td><p>B</p></td><td></td></tr></tbody></table>",
    ],
    [
      "#|\n|| Before |\n#|\n|| Inner ||\n|#\n||\n|#",
      "<table><tbody><tr><td><p>Before</p></td><td><table><tbody><tr><td><p>Inner</p></td></tr></tbody></table></td></tr></tbody></table>",
    ],
    [
      // An earlier plugin rewrites the text around the image without positions.
      "#|\n|| A \\| B\n![alt](https://example.com/img.png)\n| Other ||\n|#",
      '<table><tbody><tr><td><p>A | B<br><img src="https://example.com/img.png" alt="alt"></p></td><td><p>Other</p></td></tr></tbody></table>',
    ],
    [
      "#|\n|| {% block padding=s %}\nCell\n{% endblock %}\n| Other ||\n|#",
      '<table><tbody><tr><td><div data-yfm="block padding=s"><p>Cell</p></div></td><td><p>Other</p></td></tr></tbody></table>',
    ],
  ])("renders multiline tables: %s", (text, html) => {
    expect(render(text)).toBe(html);
  });

  it("keeps malformed tables literal", () => {
    for (const text of [
      "#|\n|| Unclosed row\n|#",
      "#|\n|| Closed row ||",
      "#|\n|#",
      "#|\nOutside a row\n|#",
      "#|\n|| A || trailing content\n|#",
      "#|\n|:{header-rows=1}\n|| A ||\n|#",
      "#|\n||:{align=center} A ||\n|#",
      "#|\n|| ::{width=50} A ||\n|#",
      "#|\n|| A | > ||\n|#",
      "#|\n|| ^ ||\n|#",
    ]) {
      expect(render(text), text).toBe(render(text, plain));
    }
  });

  it("reads heading anchors and collapsible headings, with inline markdown titles", () => {
    expect(render("## [Runbook](https://example.com) {#runbook}")).toBe(
      '<h2 id="user-content-runbook"><a href="https://example.com">Runbook</a></h2>',
    );
    expect(render("##+ Collapsed **now** {#fold}\nBody\n\n### Inside\nMore\n## Next\nText")).toBe(
      '<details id="user-content-fold"><summary>Collapsed <strong>now</strong></summary><p>Body</p><h3>Inside</h3><p>More</p></details><h2>Next</h2><p>Text</p>',
    );
    expect(render("##+ Top\n{% block padding=s %}\n## Inner\nBody\n{% endblock %}\n## Next")).toBe(
      '<details><summary>Top</summary><div data-yfm="block padding=s"><h2>Inner</h2><p>Body</p></div></details><h2>Next</h2>',
    );
  });

  it("keeps a tag inside a list item within that item", () => {
    expect(render("1. First\n\n   {% note warning %}\n   Body\n   {% endnote %}\n\n1. Next")).toBe(
      '<ol><li><p>First</p><blockquote data-alert="warning"><p>Body</p></blockquote></li><li><p>Next</p></li></ol>',
    );
  });

  it("never reads tags in HTML, code or escapes", () => {
    for (const text of [
      "<!--\n{% note warning %}\nHidden\n{% endnote %}\n-->",
      '```md\n{% cut "Literal" %}\n{% endcut %}\n```',
      '    {% cut "Literal" %}\n    {% endcut %}',
      '> ~~~markdown\n> {% cut "Literal" %}\n> ~~~\n\n{% endcut %}',
      "`multi\n{% layout %}\nline`",
      '\\{% cut "Literal" %}\nText\n\\{% endcut %}',
      "\\::: cut [Literal]\nText\n\\:::",
      "\\##+ Literal\nText",
      "#|\n|| ```text\n{% endblock %}\n```\n||\n|#",
    ]) {
      expect(render(text), text).toBe(render(text, plain));
    }
    expect(render("<!--\n{% note warning %}\nHidden\n{% endnote %}\n-->")).toBe("");
  });

  it("keeps unbalanced, mismatched and unknown tags literal", () => {
    for (const text of [
      "{% note warning %}\nText\n{% endcut %}",
      "{% note warning %}\nText\n{% endnote extra %}",
      "{% note danger %}\nText\n{% endnote %}",
      "{% cut \"Mixed' %}\nText\n{% endcut %}",
      "{% list tabs %}\nText outside a tab\n{% endlist %}",
      "::: cut [Details]\nBody\n{% endcut %}",
      "{% unsupported thing %}\nText\n{% endunsupported %}",
      "Text with a | pipe and {% weird %} tag",
    ]) {
      expect(render(text), text).toBe(render(text, plain));
    }
  });

  it("caps nesting and keeps the inner tags literal", () => {
    const text = `${'{% cut "L" %}\n'.repeat(34)}Body${"\n{% endcut %}".repeat(34)}`;
    const html = render(text);
    expect(html.match(/<details>/g)).toHaveLength(32);
    expect(html).toContain('<p>{% cut "L" %}\n{% cut "L" %}\nBody\n{% endcut %}\n{% endcut %}</p>');
  });

  it("resolves references and footnotes document-wide from inside YFM containers", () => {
    const text = [
      "[Before][guide] and a note[^n]",
      "",
      '{% cut "References" %}',
      "",
      "[Inside][guide][^n]",
      "",
      "#|",
      "|| [Cell][guide] ||",
      "|#",
      "",
      "{% endcut %}",
      "",
      "> [guide]: <https://example.com/guide>",
      "",
      "[^n]: The note",
    ].join("\n");
    const html = render(text);
    expect(html.match(/<a href="https:\/\/example\.com\/guide">/g)).toHaveLength(3);
    expect(html.match(/data-footnote-ref/g)).toHaveLength(2);
    expect(html).toContain("<p>The note");
    expect(html).not.toContain("{%");
  });

  it("transforms a large document in one parse", () => {
    const rows = Array.from({ length: 600 }, (_, index) => `|| [Ref ${index}][r${index}] ||`);
    const definitions = Array.from(
      { length: 600 },
      (_, index) => `[r${index}]: https://example.com/${index}`,
    );
    const text = `{% cut "Table" %}\n\n#|\n${rows.join("\n")}\n|#\n\n{% endcut %}\n\n${definitions.join("\n")}`;
    const html = render(text);
    expect(html.match(/<td>/g)).toHaveLength(600);
    expect(html).toContain('<a href="https://example.com/599">Ref 599</a>');
  });
});
