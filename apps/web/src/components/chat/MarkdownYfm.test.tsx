import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { MarkdownYfmBlock } from "./MarkdownYfm";

const block = (spec: string, children?: React.ReactNode) => (
  <MarkdownYfmBlock spec={spec}>{children}</MarkdownYfmBlock>
);

describe("MarkdownYfmBlock", () => {
  // Authored HTML writes any `data-yfm` marker in any order, in every chat and comment.
  it.each([
    ["tab value=0", block("tab value=0", "Text")],
    ["tab-list", block("tab-list", block("tab value=0", "Text"))],
    ["tab-panel value=0", block("tab-panel value=0", "Text")],
    ["tabs > tab", block("tabs", block("tab value=0", "Text"))],
    [
      "tabs > tab-list > tab value=x",
      block("tabs", block("tab-list", block("tab value=x", "Text"))),
    ],
    [
      "tabs > tab-panel > tab",
      block("tabs", block("tab-panel value=0", block("tab value=0", "Text"))),
    ],
    ["layout gap=constructor", block("layout gap=constructor justify=__proto__", "Text")],
    [
      "block padding=toString",
      block("block padding=toString border=solid borderSize=valueOf", "Text"),
    ],
  ])("renders an authored %s marker without throwing", (_, element) => {
    expect(renderToStaticMarkup(element)).toContain("Text");
  });

  it("orphan tab markers render as plain divs", () => {
    expect(renderToStaticMarkup(block("tabs", block("tab value=0", "Text")))).not.toContain(
      'role="tab"',
    );
  });
});
