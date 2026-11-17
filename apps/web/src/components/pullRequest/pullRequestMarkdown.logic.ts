import {
  changeRequestReferenceAutolinker,
  resolveChangeRequestMediaUrl,
  splitPullRequestBody,
} from "@t3tools/client-runtime/pull-request-markdown";
import {
  sourceControlClients,
  type ReferenceAutolink,
} from "@t3tools/client-runtime/source-control-clients";
import {
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS,
} from "@t3tools/shared/markdownPipeline";
import type { Nodes } from "hast";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified, type PluggableList } from "unified";

import { remarkYfm } from "./remarkYfm";

export {
  splitPullRequestBody,
  type PullRequestBodySegment,
} from "@t3tools/client-runtime/pull-request-markdown";

type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  url?: string;
  alt?: string;
  data?: { hProperties?: Record<string, unknown> };
  position?: {
    readonly start: { readonly offset?: number };
    readonly end: { readonly offset?: number };
  };
};

const AUTOLINK_IGNORED_TYPES = new Set(["link", "linkReference"]);

export function remarkPullRequestAutolinks(options: {
  readonly autolinks: (text: string) => ReadonlyArray<ReferenceAutolink>;
}) {
  const visit = (node: MarkdownNode): void => {
    const children = node.children;
    if (children === undefined) return;
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index]!;
      if (AUTOLINK_IGNORED_TYPES.has(child.type)) continue;
      if (child.type !== "text" || child.value === undefined) {
        visit(child);
        continue;
      }
      const value = child.value;
      const links = options.autolinks(value);
      if (links.length === 0) continue;
      const replacements: MarkdownNode[] = [];
      let start = 0;
      for (const link of links) {
        if (start < link.index) {
          replacements.push({ type: "text", value: value.slice(start, link.index) });
        }
        replacements.push({
          type: "link",
          url: link.url,
          data: { hProperties: { dataPullRequestAutolink: link.kind } },
          children: [{ type: "text", value: link.label }],
        });
        start = link.index + link.text.length;
      }
      if (start < value.length) replacements.push({ type: "text", value: value.slice(start) });
      children.splice(index, 1, ...replacements);
      index += replacements.length - 1;
    }
  };
  return (tree: MarkdownNode) => visit(tree);
}

function remarkChangeRequestMediaUrls(options: { readonly changeRequestUrl: string }) {
  const visit = (node: MarkdownNode): void => {
    if ((node.type === "image" || node.type === "definition") && node.url !== undefined) {
      node.url = resolveChangeRequestMediaUrl(node.url, options.changeRequestUrl);
    }
    node.children?.forEach(visit);
  };
  return (tree: MarkdownNode) => visit(tree);
}

interface Attachment {
  readonly url: string;
  readonly media: "image" | "video";
}

/** The attachment `splitPullRequestBody` would cut out of a body made of `source` alone. */
function attachment(source: string): Attachment | null {
  if (!/https?:\/\//i.test(source)) return null;
  const segments = splitPullRequestBody(source);
  const only = segments.length === 1 ? segments[0] : undefined;
  return only?.kind === "attachment" && only.media !== "unknown"
    ? { url: only.url, media: only.media }
    : null;
}

// The kind rides along: a video's URL need not name it.
const media = ({ url, media }: Attachment): MarkdownNode => ({
  type: "paragraph",
  children: [{ type: "image", url, alt: "", data: { hProperties: { dataMediaKind: media } } }],
});

/**
 * Attachments as media inside the one document, where `splitPullRequestBody` would cut the body
 * around them: a paragraph or HTML block whose whole source is one attachment.
 */
function remarkPullRequestAttachments() {
  return (tree: MarkdownNode, file: { readonly value?: unknown }) => {
    const source = String(file.value ?? "");
    const visit = (node: MarkdownNode): void => {
      if (node.type === "paragraph") return;
      node.children?.forEach((child, index, children) => {
        const start = child.position?.start.offset;
        const end = child.position?.end.offset;
        const found =
          (child.type === "paragraph" || child.type === "html") &&
          start !== undefined &&
          end !== undefined
            ? attachment(source.slice(start, end))
            : null;
        if (found) children[index] = media(found);
        else visit(child);
      });
    };
    visit(tree);
  };
}

const NO_PLUGINS: PluggableList = [];
const markdownPlugins = new Map<string, PluggableList>();

/**
 * One plugin list per repository, so every comment of a pull request shares one markdown
 * renderer and its parse cache instead of parsing again on each render. It carries the host's
 * markdown dialect too.
 */
export function pullRequestMarkdownPlugins(
  changeRequest: { readonly provider: string; readonly url: string } | null,
): PluggableList {
  if (changeRequest === null) return NO_PLUGINS;
  const repositoryUrl = sourceControlClients.parseChangeRequestUrl(changeRequest.url)?.link
    .repositoryUrl;
  const key = `${changeRequest.provider}\u0000${repositoryUrl ?? ""}`;
  let plugins = markdownPlugins.get(key);
  if (plugins === undefined) {
    const autolinks = changeRequestReferenceAutolinker(changeRequest);
    const hostPlugins: PluggableList = [];
    if (pullRequestMarkdownSpansAttachments(changeRequest.provider)) {
      hostPlugins.push(remarkYfm, remarkPullRequestAttachments);
    }
    if (repositoryUrl !== undefined) {
      hostPlugins.push([remarkChangeRequestMediaUrls, { changeRequestUrl: repositoryUrl }]);
    }
    if (autolinks) hostPlugins.push([remarkPullRequestAutolinks, { autolinks }]);
    plugins = hostPlugins.length > 0 ? hostPlugins : NO_PLUGINS;
    markdownPlugins.set(key, plugins);
  }
  return plugins;
}

const commentPreviewProcessor = unified()
  .use(remarkParse)
  .use(CHAT_MARKDOWN_REMARK_PLUGINS)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(CHAT_MARKDOWN_REHYPE_PLUGINS)
  .freeze();

const PREVIEW_BLOCK_TAGS = new Set([
  "blockquote",
  "br",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "summary",
  "table",
  "td",
  "th",
  "tr",
  "ul",
]);

function commentPreviewText(node: Nodes): string {
  if (node.type === "text") return node.value;
  if (node.type === "element" && node.tagName === "img") {
    return typeof node.properties.alt === "string" ? node.properties.alt : "";
  }
  if (!("children" in node)) return "";
  const text = node.children.map(commentPreviewText).join("");
  return node.type === "element" && PREVIEW_BLOCK_TAGS.has(node.tagName) ? ` ${text} ` : text;
}

export function pullRequestCommentPreview(body: string): string {
  const tree = commentPreviewProcessor.runSync(commentPreviewProcessor.parse(body), body);
  return commentPreviewText(tree).replace(/\s+/gu, " ").trim();
}

/** Whether the host's markup can span attachments, so its text renders as one document. */
export function pullRequestMarkdownSpansAttachments(provider: string): boolean {
  return sourceControlClients.find(provider)?.yfm === true;
}
