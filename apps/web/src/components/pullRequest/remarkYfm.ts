import type {
  Blockquote,
  Break,
  FootnoteDefinition,
  Heading,
  ListItem,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
  Text,
} from "mdast";
import type { Processor } from "unified";

/**
 * YFM block syntax over the parsed tree. A tag is a paragraph line of its own and pairs with its
 * closer among one parent's children, so code, HTML, references and footnotes stay as the one
 * parse left them. Malformed tags stay literal. Divs carry `data-yfm="<kind> key=value…"`.
 */
function attachYfm(this: Processor) {
  const parse = this.parser;
  if (!parse) return;
  // Runs on the parser's own tree: escapes are read through positions later rewrites drop.
  this.parser = (document, file) => {
    const tree = parse(document, file) as Root;
    if (!YFM_HINT.test(document)) return tree;
    const context: Context = {
      source: document,
      sourceLines: document.split("\n"),
      tables: document.includes("#|"),
    };
    hoistLazyLines(context, tree, []);
    transformContainer(context, tree);
    return tree;
  };
}

export const remarkYfm = attachYfm;

const YFM_HINT = /\{%|:::|#\||\{#[A-Za-z]|#\+[ \t]/;
const SPLIT_HINT = /\{%|:::|\||#\+/;
const MAX_DEPTH = 32;

interface Context {
  readonly source: string;
  readonly sourceLines: ReadonlyArray<string>;
  /** Pipe lines only matter to multiline tables. */
  readonly tables: boolean;
}

type Container = Root | Blockquote | ListItem | FootnoteDefinition;

interface Line {
  readonly kind: "line";
  readonly nodes: ReadonlyArray<PhrasingContent>;
  readonly origin: Paragraph;
  readonly index: number;
  readonly count: number;
  /** The hard break that ends the line; a soft one is a newline. */
  readonly breakNode: Break | undefined;
  /** The nodes are the origin's own line, untouched. */
  readonly whole: boolean;
  readonly sourceLine: number | undefined;
}

type Item = Line | { readonly kind: "node"; readonly node: RootContent };

type ContainerName = "cut" | "note" | "list" | "layout" | "block" | "colon" | "table";

type Tag =
  | {
      readonly kind: "open";
      readonly name: ContainerName;
      readonly args: string;
      /** Null when the tag's title or arguments do not parse. */
      readonly title: ReadonlyArray<PhrasingContent> | null;
    }
  | { readonly kind: "close"; readonly name: ContainerName }
  | {
      readonly kind: "section";
      readonly level: number;
      readonly title: ReadonlyArray<PhrasingContent>;
      readonly id: string | undefined;
    };

interface Frame {
  readonly tag: Extract<Tag, { kind: "open" }>;
  readonly opener: Line;
  readonly content: Item[];
  readonly literal: boolean;
}

/** A generated element. mdast-util-to-hast renders unknown nodes through `data.hName`. */
interface YfmElement {
  readonly type: "yfm";
  readonly data: { readonly hName: string; readonly hProperties?: Record<string, string> };
  readonly children: ReadonlyArray<RootContent>;
}

const blockAttributes = new WeakMap<object, BlockStyle>();

/** Where each split text piece came from, for escapes. */
const pieces = new WeakMap<Text, { readonly from: Text; readonly offset: number }>();
const escapeCache = new WeakMap<Text, ReadonlySet<number>>();

function splitLines(paragraph: Paragraph): Line[] {
  const raw: Array<Omit<Line, "count">> = [];
  let nodes: PhrasingContent[] = [];
  let sourceLine = paragraph.position?.start.line;
  const push = (breakNode: Break | undefined) => {
    raw.push({
      kind: "line",
      nodes,
      origin: paragraph,
      index: raw.length,
      breakNode,
      whole: true,
      sourceLine,
    });
    nodes = [];
  };
  for (const child of paragraph.children) {
    if (child.type === "break") {
      push(child);
      sourceLine = child.position?.end.line;
    } else if (child.type === "text" && /[\r\n]/.test(child.value)) {
      const { value } = child;
      let offset = 0;
      let lines = 0;
      for (const ending of value.matchAll(/\r\n?|\n/g)) {
        if (ending.index > offset)
          nodes.push(textPiece(child, offset, value.slice(offset, ending.index)));
        push(undefined);
        lines += 1;
        sourceLine = child.position ? child.position.start.line + lines : undefined;
        offset = ending.index + ending[0].length;
      }
      if (offset < value.length) nodes.push(textPiece(child, offset, value.slice(offset)));
    } else {
      nodes.push(child);
    }
  }
  push(undefined);
  return raw.map((line) => ({ ...line, count: raw.length }));
}

function textPiece(from: Text, offset: number, value: string): Text {
  const origin = pieces.get(from);
  const piece: Text = { type: "text", value };
  pieces.set(piece, { from: origin?.from ?? from, offset: (origin?.offset ?? 0) + offset });
  return piece;
}

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
const ENTITY = /^&(?:#\d{1,7}|#[xX][\da-fA-F]{1,6}|[A-Za-z][A-Za-z\d]{1,31});/;

/** Offsets in a text node's value that come from a backslash escape or a character reference. */
function escapedOffsets(context: Context, node: Text): ReadonlySet<number> {
  const cached = escapeCache.get(node);
  if (cached) return cached;
  const escaped = new Set<number>();
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start !== undefined && end !== undefined) {
    const { source } = context;
    const { value } = node;
    let index = 0;
    let cursor = start;
    while (index < value.length && cursor < end) {
      const character = source[cursor]!;
      const next = source[cursor + 1];
      if (character === "\\" && next === value[index] && ASCII_PUNCTUATION.test(next!)) {
        escaped.add(index);
        index += 1;
        cursor += 2;
        continue;
      }
      const entity = character === "&" ? ENTITY.exec(source.slice(cursor, cursor + 40)) : null;
      if (entity && (value[index] !== "&" || entity[0] === "&amp;")) {
        escaped.add(index);
        index += value.codePointAt(index)! > 0xffff ? 2 : 1;
        cursor += entity[0].length;
        continue;
      }
      // Anything else that differs is a container prefix or whitespace the parser dropped.
      if (character === value[index]) index += 1;
      cursor += 1;
    }
  }
  escapeCache.set(node, escaped);
  return escaped;
}

function isEscaped(context: Context, node: Text, index: number): boolean {
  const piece = pieces.get(node);
  return escapedOffsets(context, piece?.from ?? node).has((piece?.offset ?? 0) + index);
}

function text(value: string): Text {
  return { type: "text", value };
}

function lineText(line: Line): string | null {
  let value = "";
  for (const node of line.nodes) {
    if (node.type !== "text") return null;
    value += node.value;
  }
  return value;
}

/** The phrasing between `start` in the first node and `end` in the last, both text. */
function phrasingBetween(
  nodes: ReadonlyArray<PhrasingContent>,
  start: number,
  end: number,
): PhrasingContent[] {
  const first = nodes[0] as Text;
  const last = nodes.at(-1) as Text;
  if (nodes.length === 1) {
    const value = first.value.slice(start, end);
    return value ? [text(value)] : [];
  }
  return [
    text(first.value.slice(start)),
    ...nodes.slice(1, -1),
    text(last.value.slice(0, end)),
  ].filter((node) => node.type !== "text" || node.value !== "");
}

function trimPhrasing(nodes: ReadonlyArray<PhrasingContent>): PhrasingContent[] {
  const result = [...nodes];
  const first = result[0];
  if (first?.type === "text") result[0] = text(first.value.trimStart());
  const last = result.at(-1);
  if (last?.type === "text") result[result.length - 1] = text(last.value.trimEnd());
  return result.filter((node) => node.type !== "text" || node.value !== "");
}

const tagCache = new WeakMap<Line, Tag | null>();
const CONTAINER_TAGS = new Set<string>(["cut", "note", "list", "layout", "block"]);
const NOTE_ARGS = /^\s+(note|info|tip|warning|alert)(?:\s+(["'])|\s*%\}\s*$)/;
const ANCHOR = /[ \t]+\{#([A-Za-z][\w-]{0,127})\}[ \t]*$/;

function classify(context: Context, line: Line): Tag | null {
  if (tagCache.has(line)) return tagCache.get(line)!;
  const tag = readTag(context, line);
  tagCache.set(line, tag);
  return tag;
}

function readTag(context: Context, line: Line): Tag | null {
  const first = line.nodes[0];
  const last = line.nodes.at(-1);
  if (first?.type !== "text") return null;
  const lead = first.value.length - first.value.trimStart().length;
  if (isEscaped(context, first, lead)) return null;
  const head = first.value.slice(lead);

  const section = /^(#{1,6})\+[ \t]+/.exec(head);
  if (section) {
    const anchor = last?.type === "text" ? ANCHOR.exec(last.value) : null;
    const end = anchor?.index ?? (last?.type === "text" ? last.value.length : undefined);
    const title = trimPhrasing(
      end === undefined
        ? [text(first.value.slice(lead + section[0].length)), ...line.nodes.slice(1)]
        : phrasingBetween(line.nodes, lead + section[0].length, end),
    );
    if (title.length === 0) return null;
    return { kind: "section", level: section[1]!.length, title, id: anchor?.[1] };
  }

  if (last?.type !== "text") return null;
  const whole = lineText(line)?.trim();

  if (whole === "#|") return { kind: "open", name: "table", args: "", title: [] };
  if (whole === "|#") return { kind: "close", name: "table" };
  if (whole === ":::") return { kind: "close", name: "colon" };

  const colon = /^:::[ \t]+cut(?=[ \t]|$)[ \t]*/.exec(head);
  if (colon) {
    if (whole !== undefined && /^:::[ \t]+cut$/.test(whole)) {
      return { kind: "open", name: "colon", args: "", title: [] };
    }
    const end = /\][ \t]*$/.exec(last.value);
    const valid = head[colon[0].length] === "[" && end !== null;
    const title = valid ? phrasingBetween(line.nodes, lead + colon[0].length + 1, end.index) : null;
    return { kind: "open", name: "colon", args: "", title };
  }

  const directive = /^\{%[ \t]*([a-z][\w-]*)/.exec(head);
  const closing = /%\}[ \t]*$/.exec(last.value);
  if (!directive || !closing || isEscaped(context, last, closing.index + 1)) return null;
  const name = directive[1]!;
  if (name.startsWith("end") && CONTAINER_TAGS.has(name.slice(3))) {
    return whole !== undefined && new RegExp(`^\\{%[ \\t]*${name}[ \\t]*%\\}$`).test(whole)
      ? { kind: "close", name: name.slice(3) as ContainerName }
      : null;
  }
  if (!CONTAINER_TAGS.has(name)) return null;
  const containerName = name as ContainerName;
  const rest = head.slice(directive[0].length);
  if (containerName === "cut") {
    const quote = /^\s+(["'])/.exec(rest);
    const end = quote ? new RegExp(`${quote[1]}\\s*%\\}[ \\t]*$`).exec(last.value) : null;
    const start = lead + directive[0].length + (quote?.[0].length ?? 0);
    const valid = quote && end && (line.nodes.length > 1 || end.index >= start);
    return {
      kind: "open",
      name: containerName,
      args: "",
      title: valid ? phrasingBetween(line.nodes, start, end.index) : null,
    };
  }
  if (containerName === "note") {
    const args = NOTE_ARGS.exec(rest);
    if (!args) return { kind: "open", name: containerName, args: "", title: null };
    if (!args[2]) {
      return whole === undefined
        ? { kind: "open", name: containerName, args: "", title: null }
        : { kind: "open", name: containerName, args: args[1]!, title: [] };
    }
    const end = new RegExp(`${args[2]}\\s*%\\}[ \\t]*$`).exec(last.value);
    const start = lead + directive[0].length + args[0].length;
    const valid = end && (line.nodes.length > 1 || end.index >= start);
    return {
      kind: "open",
      name: containerName,
      args: args[1]!,
      title: valid ? phrasingBetween(line.nodes, start, end.index) : null,
    };
  }
  if (whole === undefined) return { kind: "open", name: containerName, args: "", title: null };
  const args = /^\{%[ \t]*[a-z][\w-]*([^]*?)%\}$/.exec(whole)?.[1] ?? "";
  return { kind: "open", name: containerName, args, title: [] };
}

/** Whether a line would close the containers it is lazy in, as a block construct does. */
function isBlockLine(context: Context, line: Line): boolean {
  if (classify(context, line) !== null) return true;
  const first = line.nodes[0];
  return context.tables && first?.type === "text" && first.value.trimStart().startsWith("|");
}

interface PathEntry {
  readonly node: Blockquote | ListItem | FootnoteDefinition;
  /** The sibling list holding `block`, the container itself or the list of an item. */
  readonly holder: RootContent[];
  readonly block: RootContent;
}

/**
 * CommonMark appends a line that misses a container's prefix to the paragraph open inside it, so
 * `- item` followed by `{% endcut %}` puts the tag in the item. A block construct would have
 * closed the item there, so the tag and the rest of that paragraph move after the container.
 */
function hoistLazyLines(context: Context, parent: Container, path: ReadonlyArray<PathEntry>) {
  const children = parent.children as RootContent[];
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]!;
    if (child.type === "blockquote" || child.type === "footnoteDefinition") {
      hoistLazyLines(context, child, [...path, { node: child, holder: children, block: child }]);
    } else if (child.type === "list") {
      for (const item of child.children) {
        hoistLazyLines(context, item, [...path, { node: item, holder: children, block: child }]);
      }
    } else if (
      child.type === "paragraph" &&
      path.length > 0 &&
      index === children.length - 1 &&
      needsSplit(child)
    ) {
      const lines = splitLines(child);
      for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex]!;
        if (line.sourceLine === undefined || !isBlockLine(context, line)) continue;
        const depth = lazyDepth(context.sourceLines[line.sourceLine - 1] ?? "", path);
        if (depth < 0) continue;
        const target = path[depth]!;
        children[index] = paragraphOf(lines.slice(0, lineIndex));
        target.holder.splice(
          target.holder.indexOf(target.block) + 1,
          0,
          paragraphOf(lines.slice(lineIndex)),
        );
        break;
      }
    }
  }
}

/** The outermost container whose prefix the source line lacks, or -1. */
function lazyDepth(line: string, path: ReadonlyArray<PathEntry>): number {
  let cursor = 0;
  for (let depth = 0; depth < path.length; depth += 1) {
    const { node } = path[depth]!;
    if (node.type === "blockquote") {
      const marker = /^[ \t]{0,3}>[ \t]?/.exec(line.slice(cursor));
      if (!marker) return depth;
      cursor += marker[0].length;
      continue;
    }
    // A footnote continues on four spaces of indent, an item at its content's column.
    const column = node.children[0]?.position?.start.column;
    if (column === undefined) return -1;
    const indent = node.type === "footnoteDefinition" ? cursor + 4 : column - 1;
    while (cursor < indent && (line[cursor] === " " || line[cursor] === "\t")) cursor += 1;
    if (cursor < indent) return depth;
  }
  return -1;
}

function needsSplit(paragraph: Paragraph): boolean {
  return paragraph.children.some((child) => child.type === "text" && SPLIT_HINT.test(child.value));
}

function transformContainer(context: Context, parent: Container) {
  const children = parent.children as RootContent[];
  for (const child of children) {
    if (child.type === "heading") readHeadingAnchor(child);
    else if (child.type === "blockquote" || child.type === "footnoteDefinition") {
      transformContainer(context, child);
    } else if (child.type === "list") {
      for (const item of child.children) transformContainer(context, item);
    }
  }
  const items: Item[] = [];
  let tagged = false;
  for (const child of children) {
    if (child.type !== "paragraph" || !needsSplit(child)) {
      items.push({ kind: "node", node: child });
      continue;
    }
    for (const whole of splitLines(child)) {
      for (const line of context.tables ? splitLeadingPipes(context, whole) : [whole]) {
        tagged ||= classify(context, line) !== null;
        items.push(line);
      }
    }
  }
  if (!tagged) return;
  (parent as { children: RootContent[] }).children = finalize(context, pairTags(context, items));
}

/** `|| {% block %}` opens a cell with a tag: the tag gets a line of its own. */
function splitLeadingPipes(context: Context, line: Line): Line[] {
  const first = line.nodes[0];
  if (first?.type !== "text") return [line];
  const pipes = /^\s*\|{1,2}(?=\s)/.exec(first.value);
  if (!pipes || isEscaped(context, first, pipes[0].indexOf("|"))) return [line];
  const rest: Line = {
    ...line,
    nodes: [
      textPiece(first, pipes[0].length, first.value.slice(pipes[0].length)),
      ...line.nodes.slice(1),
    ],
    whole: false,
  };
  if (classify(context, rest)?.kind !== "open") return [line];
  return [
    { ...line, nodes: [textPiece(first, 0, pipes[0])], breakNode: undefined, whole: false },
    rest,
  ];
}

function readHeadingAnchor(heading: Heading) {
  const last = heading.children.at(-1);
  if (last?.type !== "text") return;
  const anchor = ANCHOR.exec(last.value);
  if (!anchor) return;
  last.value = last.value.slice(0, anchor.index);
  if (!last.value) heading.children.pop();
  heading.data = {
    ...heading.data,
    hProperties: { ...heading.data?.hProperties, id: anchor[1]! },
  };
}

/** Pairs opening and closing tags among one parent's items, innermost first. */
function pairTags(context: Context, items: ReadonlyArray<Item>): Item[] {
  const output: Item[] = [];
  const stack: Frame[] = [];
  const target = () => stack.at(-1)?.content ?? output;
  for (const item of items) {
    const tag = item.kind === "line" ? classify(context, item) : null;
    if (item.kind === "line" && tag?.kind === "open") {
      stack.push({
        tag,
        opener: item,
        content: [],
        literal: stack.length >= MAX_DEPTH || stack.at(-1)?.literal === true,
      });
      continue;
    }
    const top = stack.at(-1);
    if (item.kind === "line" && tag?.kind === "close" && top?.tag.name === tag.name) {
      stack.pop();
      const node = top.literal ? null : buildContainer(context, top, stack.at(-1));
      if (node) target().push({ kind: "node", node });
      else target().push(top.opener, ...top.content, item);
      continue;
    }
    target().push(item);
  }
  while (stack.length > 0) {
    const frame = stack.pop()!;
    target().push(frame.opener, ...frame.content);
  }
  return output;
}

/** Collapsible headings, then lines joined back into paragraphs. */
function finalize(context: Context, items: ReadonlyArray<Item>): RootContent[] {
  return mergeLines(sections(context, items));
}

function sections(context: Context, items: ReadonlyArray<Item>): Item[] {
  const output: Item[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    const tag = item.kind === "line" ? classify(context, item) : null;
    if (tag?.kind !== "section") {
      output.push(item);
      continue;
    }
    let end = index + 1;
    while (end < items.length && !endsSection(context, items[end]!, tag.level)) end += 1;
    output.push({
      kind: "node",
      node: cut(tag.title, finalize(context, items.slice(index + 1, end)), tag.id),
    });
    index = end - 1;
  }
  return output;
}

function endsSection(context: Context, item: Item, level: number): boolean {
  if (item.kind === "node") return item.node.type === "heading" && item.node.depth <= level;
  const tag = classify(context, item);
  return tag?.kind === "section" && tag.level <= level;
}

function mergeLines(items: ReadonlyArray<Item>): RootContent[] {
  const output: RootContent[] = [];
  let run: Line[] = [];
  const flush = () => {
    if (run.length > 0) {
      const paragraph = paragraphOf(run);
      if (paragraph.children.length > 0) output.push(paragraph);
    }
    run = [];
  };
  for (const item of items) {
    if (item.kind === "node") {
      flush();
      output.push(item.node);
      continue;
    }
    const previous = run.at(-1);
    if (
      previous &&
      (previous.origin !== item.origin ||
        (previous.index !== item.index && previous.index + 1 !== item.index))
    ) {
      flush();
    }
    run.push(item);
  }
  flush();
  return output;
}

function paragraphOf(run: ReadonlyArray<Line>): Paragraph {
  const first = run[0]!;
  const last = run.at(-1)!;
  if (first.index === 0 && last.index === first.count - 1 && run.every((line) => line.whole)) {
    return first.origin;
  }
  const children: PhrasingContent[] = [];
  run.forEach((line, index) => {
    const previous = run[index - 1];
    // Parts of one source line join without a line ending.
    if (previous && previous.index !== line.index) children.push(previous.breakNode ?? text("\n"));
    children.push(...line.nodes);
  });
  // A span the parser placed, so later plugins can read the paragraph's source.
  const start = children[0]?.position?.start;
  const end = children.at(-1)?.position?.end;
  return { type: "paragraph", children, ...(start && end ? { position: { start, end } } : {}) };
}

function element(
  hName: string,
  children: ReadonlyArray<RootContent | PhrasingContent>,
  hProperties?: Record<string, string>,
): RootContent {
  const node: YfmElement = {
    type: "yfm",
    data: hProperties ? { hName, hProperties } : { hName },
    children: children as ReadonlyArray<RootContent>,
  };
  return node as unknown as RootContent;
}

function yfmDiv(spec: string, children: ReadonlyArray<RootContent | PhrasingContent>) {
  return element("div", children, { dataYfm: spec });
}

function cut(
  title: ReadonlyArray<PhrasingContent> | null,
  content: ReadonlyArray<RootContent>,
  id?: string,
): RootContent {
  const summary = title && title.length > 0 ? [element("summary", title)] : [];
  return element("details", [...summary, ...content], id ? { id } : undefined);
}

const NOTE_ALERTS = new Map([
  ["note", "note"],
  ["info", "note"],
  ["tip", "tip"],
  ["warning", "warning"],
  ["alert", "caution"],
]);

function buildContainer(context: Context, frame: Frame, parent: Frame | undefined) {
  const { tag } = frame;
  if (tag.title === null) return null;
  switch (tag.name) {
    case "cut":
    case "colon":
      return cut(tag.title, finalize(context, frame.content));
    case "note": {
      const note: Blockquote = {
        type: "blockquote",
        data: { hProperties: { dataAlert: NOTE_ALERTS.get(tag.args)! } },
        children: [
          ...(tag.title.length > 0 ? [yfmDiv("note-title", tag.title)] : []),
          ...finalize(context, frame.content),
        ] as Blockquote["children"],
      };
      return note;
    }
    case "list":
      return tag.args.trim() === "tabs" ? buildTabs(finalize(context, frame.content)) : null;
    case "layout":
      return buildLayout(tag.args, finalize(context, frame.content));
    case "block": {
      const style = readBlockStyle(tag.args, parent?.tag.name === "layout");
      if (!style) return null;
      const node = yfmDiv(blockSpec("block", style), finalize(context, frame.content));
      blockAttributes.set(node, style);
      return node;
    }
    case "table":
      return buildTable(context, frame.content);
  }
}

function buildTabs(blocks: ReadonlyArray<RootContent>): RootContent | null {
  const titles: RootContent[] = [];
  const panels: RootContent[] = [];
  for (const block of blocks) {
    if (block.type !== "list" || block.ordered) return null;
    for (const item of block.children) {
      const [heading, ...rest] = item.children;
      if (heading?.type !== "paragraph") return null;
      const [titleLine, ...bodyLines] = splitLines(heading);
      const title = trimPhrasing(titleLine!.nodes);
      if (title.length === 0) return null;
      const value = String(titles.length);
      titles.push(yfmDiv(`tab value=${value}`, title));
      panels.push(
        yfmDiv(`tab-panel value=${value}`, [
          ...(bodyLines.length > 0 ? [paragraphOf(bodyLines)] : []),
          ...rest,
        ]),
      );
    }
  }
  if (titles.length === 0) return null;
  return yfmDiv("tabs", [yfmDiv("tab-list", titles), ...panels]);
}

/** Validated `{% block %}` attributes; `col` only inside a layout. */
type BlockStyle = Readonly<Record<string, string>>;

const BLOCK_CHOICES = new Map([
  ["align", /^(?:left|center|right)$/],
  ["width", /^[1-9]\d{0,3}$|^10000$/],
  ["padding", /^(?:xs|s|m|l|xl)$/],
  ["border", /^(?:solid|dashed)$/],
  ["borderSize", /^(?:xs|s|m|l)$/],
  ["borderColor", /^(?:info|tip|warning|alert)$/],
]);

/** `key=value` pairs, each key once, or null. */
function readAttributes(args: string): Map<string, string> | null {
  const result = new Map<string, string>();
  const pattern = /\s+([a-zA-Z][\w-]*)\s*=\s*(?:"([^"\n]*)"|'([^'\n]*)'|([\w-]+))/y;
  let cursor = 0;
  const end = args.trimEnd().length;
  while (cursor < end) {
    pattern.lastIndex = cursor;
    const match = pattern.exec(args);
    if (!match || result.has(match[1]!)) return null;
    result.set(match[1]!, match[2] ?? match[3] ?? match[4]!);
    cursor = pattern.lastIndex;
  }
  return result;
}

function readBlockStyle(args: string, column: boolean): BlockStyle | null {
  const values = readAttributes(args);
  if (!values) return null;
  const style: Record<string, string> = {};
  for (const [key, value] of values) {
    const valid =
      key === "col"
        ? column && /^(?:[1-9]|1[0-2])$/.test(value)
        : BLOCK_CHOICES.get(key)?.test(value);
    if (!valid) return null;
    style[key] = value;
  }
  return style;
}

function blockSpec(kind: string, style: Readonly<Record<string, string | undefined>>): string {
  const options = Object.entries(style).filter((entry) => entry[1] !== undefined);
  return [kind, ...options.map(([key, value]) => `${key}=${value}`)].join(" ");
}

function buildLayout(args: string, blocks: ReadonlyArray<RootContent>): RootContent | null {
  const values = readAttributes(args);
  if (!values) return null;
  const gap = values.get("gap") ?? "m";
  const cols = values.get("cols");
  const justify = values.get("justify");
  if (
    [...values.keys()].some((key) => key !== "gap" && key !== "cols" && key !== "justify") ||
    !/^(?:s|m|l|xl)$/.test(gap) ||
    (cols !== undefined && cols !== "auto") ||
    (justify !== undefined && !/^(?:start|center|end)$/.test(justify))
  ) {
    return null;
  }
  const columns = blocks.map((block) => ({ block, style: blockAttributes.get(block) }));
  if (columns.length === 0 || columns.some((column) => column.style === undefined)) return null;
  const fixed = columns.reduce((sum, column) => sum + Number(column.style?.col ?? 0), 0);
  const flexible = columns.filter((column) => column.style?.col === undefined).length;
  const share = String(Math.max(1, Math.floor((12 - fixed) / (flexible || 1))));
  return yfmDiv(
    blockSpec("layout", { gap, ...(cols ? { cols } : {}), ...(justify ? { justify } : {}) }),
    columns.map(({ block, style }) => {
      const { col, ...rest } = style!;
      return yfmDiv(blockSpec(`layout-column span=${col ?? share}`, rest), [
        ...((block as unknown as YfmElement).children as RootContent[]),
      ]);
    }),
  );
}

type Segment = { readonly pipes: number } | { readonly nodes: ReadonlyArray<PhrasingContent> };

/** A line's phrasing split at its unescaped `|` runs outside code and other inline nodes. */
function pipeSegments(context: Context, line: Line): Segment[] {
  const segments: Segment[] = [];
  let nodes: PhrasingContent[] = [];
  const flush = () => {
    const trimmed = trimPhrasing(nodes);
    if (trimmed.length > 0) segments.push({ nodes: trimmed });
    nodes = [];
  };
  for (const node of line.nodes) {
    if (node.type !== "text") {
      nodes.push(node);
      continue;
    }
    let start = 0;
    for (let index = 0; index < node.value.length; index += 1) {
      if (node.value[index] !== "|" || isEscaped(context, node, index)) continue;
      let end = index;
      while (node.value[end] === "|" && !isEscaped(context, node, end)) end += 1;
      if (start < index) nodes.push(textPiece(node, start, node.value.slice(start, index)));
      flush();
      segments.push({ pipes: end - index });
      start = end;
      index = end - 1;
    }
    if (start === 0) nodes.push(node);
    else if (start < node.value.length) nodes.push(textPiece(node, start, node.value.slice(start)));
  }
  flush();
  return segments;
}

/**
 * The `|` or `||` that ends the last line of a nested list or quote, as in `- Last item||`.
 * Returns the delimiter and the edit that removes it, applied only once the table is valid.
 */
function trailingPipes(context: Context, node: RootContent) {
  let current: RootContent | undefined = node;
  while (current && current.type !== "paragraph") {
    current =
      current.type === "list" || current.type === "listItem" || current.type === "blockquote"
        ? (current.children.at(-1) as RootContent | undefined)
        : undefined;
  }
  if (current?.type !== "paragraph" || current === node) return null;
  const paragraph = current;
  const last = paragraph.children.at(-1);
  if (last?.type !== "text") return null;
  const match = /\s*(\|{1,2})\s*$/.exec(last.value);
  if (!match || isEscaped(context, last, match.index + match[0].indexOf("|"))) return null;
  return {
    pipes: match[1]!.length,
    apply: () => {
      last.value = last.value.slice(0, match.index);
      if (!last.value) paragraph.children.pop();
    },
  };
}

function cellLine(line: Line, nodes: ReadonlyArray<PhrasingContent>): Line {
  return { ...line, nodes, whole: false };
}

function buildTable(context: Context, content: ReadonlyArray<Item>): RootContent | null {
  const rows: Item[][][] = [];
  let row: Item[][] | null = null;
  const edits: Array<() => void> = [];
  for (const item of content) {
    if (item.kind === "node") {
      if (!row) return null;
      row.at(-1)!.push(item);
      const trailing = trailingPipes(context, item.node);
      if (trailing?.pipes === 2) {
        rows.push(row);
        row = null;
      } else if (trailing) {
        row.push([]);
      }
      if (trailing) edits.push(trailing.apply);
      continue;
    }
    const segments = pipeSegments(context, item);
    for (const [index, segment] of segments.entries()) {
      if ("nodes" in segment) {
        if (!row) return null;
        row.at(-1)!.push(cellLine(item, segment.nodes));
      } else if (!row) {
        const next = segments[index + 1];
        const attribute = next && "nodes" in next ? next.nodes[0] : undefined;
        if (index > 0 || segment.pipes !== 2) return null;
        if (attribute?.type === "text" && /^:\s*\{/.test(attribute.value)) return null;
        row = [[]];
      } else if (segment.pipes === 1) {
        row.push([]);
      } else if (segment.pipes === 2 && index === segments.length - 1) {
        rows.push(row);
        row = null;
      } else {
        return null;
      }
    }
  }
  if (row || rows.length === 0) return null;
  for (const cells of rows) {
    for (const cell of cells) {
      const only = cell.length === 1 ? cell[0] : undefined;
      const value = only?.kind === "line" ? lineText(only) : null;
      if (value !== null && (/^::\s*\{/.test(value) || value === ">" || value === "^")) return null;
    }
  }
  for (const edit of edits) edit();
  return element("table", [
    element(
      "tbody",
      rows.map((cells) =>
        element(
          "tr",
          cells.map((cell) => element("td", finalize(context, cell))),
        ),
      ),
    ),
  ]);
}
