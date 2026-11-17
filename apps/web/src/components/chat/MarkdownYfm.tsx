import { Tabs } from "@base-ui/react/tabs";
import {
  createContext,
  isValidElement,
  use,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";

import { cn } from "../../lib/utils";

const GAPS = new Map([
  ["s", "0.5rem"],
  ["m", "1rem"],
  ["l", "1.5rem"],
  ["xl", "2rem"],
]);
const JUSTIFY = new Set(["start", "center", "end"]);
const ALIGN = new Set(["left", "center", "right"]);
const PADDINGS = new Map([
  ["xs", 4],
  ["s", 8],
  ["m", 12],
  ["l", 16],
  ["xl", 20],
]);
const BORDERS = new Set(["solid", "dashed"]);
const BORDER_SIZES = new Map([
  ["xs", 1],
  ["s", 2],
  ["m", 4],
  ["l", 6],
]);
const BORDER_COLORS = new Map([
  ["info", "var(--color-info)"],
  ["tip", "var(--color-success)"],
  ["warning", "var(--color-warning)"],
  ["alert", "var(--color-error)"],
]);

/** Which tabs part may render inside: authored HTML can write any marker anywhere. */
const TabsPartContext = createContext<"root" | "list" | null>(null);

function oneOf<T extends string>(values: ReadonlySet<string>, value: string | undefined) {
  return value !== undefined && values.has(value) ? (value as T) : undefined;
}

/** `data-yfm` is `<kind> key=value…`; raw HTML can write one too, so unknown values are dropped. */
function readSpec(spec: string) {
  const [kind = "", ...options] = spec.split(" ");
  const values = new Map<string, string>();
  for (const option of options) {
    const separator = option.indexOf("=");
    if (separator > 0) values.set(option.slice(0, separator), option.slice(separator + 1));
  }
  return { kind, values };
}

function blockStyle(values: ReadonlyMap<string, string>): CSSProperties {
  const width = Number(values.get("width"));
  const border = oneOf(BORDERS, values.get("border"));
  return {
    textAlign: oneOf<"left" | "center" | "right">(ALIGN, values.get("align")),
    width: Number.isInteger(width) && width > 0 && width <= 10_000 ? width : undefined,
    padding: PADDINGS.get(values.get("padding") ?? ""),
    borderStyle: border,
    borderWidth: border ? (BORDER_SIZES.get(values.get("borderSize") ?? "") ?? 1) : undefined,
    borderColor: border ? BORDER_COLORS.get(values.get("borderColor") ?? "") : undefined,
  };
}

/** The title row a YFM note writes in place of the alert's own label. */
export function isYfmNoteTitle(node: ReactNode): node is ReactElement<{ children?: ReactNode }> {
  return (
    isValidElement(node) && (node.props as Record<string, unknown>)["data-yfm"] === "note-title"
  );
}

/** Containers the YFM remark plugin writes for Arcanum text. */
export function MarkdownYfmBlock({ spec, children }: { spec: string; children?: ReactNode }) {
  const { kind, values } = readSpec(spec);
  const part = use(TabsPartContext);
  const value = Number(values.get("value"));
  const tabValue = Number.isSafeInteger(value) && value >= 0;
  if (kind === "tabs") {
    return (
      <Tabs.Root defaultValue={0} className="my-2 min-w-0">
        <TabsPartContext value="root">{children}</TabsPartContext>
      </Tabs.Root>
    );
  }
  if (kind === "tab-list" && part === "root") {
    return (
      <Tabs.List className="mb-2 flex gap-1 overflow-x-auto border-b border-border">
        <TabsPartContext value="list">{children}</TabsPartContext>
      </Tabs.List>
    );
  }
  if (kind === "tab" && part === "list" && tabValue) {
    return (
      <Tabs.Tab
        value={value}
        className="shrink-0 cursor-pointer border-b-2 border-transparent px-3 py-1.5 text-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-selected:border-primary aria-selected:text-foreground"
      >
        <TabsPartContext value={null}>{children}</TabsPartContext>
      </Tabs.Tab>
    );
  }
  if (kind === "tab-panel" && part === "root" && tabValue) {
    return (
      <Tabs.Panel value={value} className="min-w-0 outline-none">
        <TabsPartContext value={null}>{children}</TabsPartContext>
      </Tabs.Panel>
    );
  }
  if (kind === "layout") {
    return (
      <div className="@container my-2 min-w-0">
        <div
          className={cn(
            "grid grid-cols-1",
            values.get("cols") === "auto" ? "@xl:flex @xl:flex-wrap" : "@xl:grid-cols-12",
          )}
          style={{
            gap: GAPS.get(values.get("gap") ?? "") ?? GAPS.get("m"),
            justifyContent: oneOf(JUSTIFY, values.get("justify")),
          }}
        >
          {children}
        </div>
      </div>
    );
  }
  if (kind === "layout-column") {
    const span = Number(values.get("span"));
    return (
      <div
        className="min-w-0 max-w-full @xl:[grid-column:span_var(--yfm-span)]"
        style={
          {
            ...blockStyle(values),
            "--yfm-span": Number.isInteger(span) && span >= 1 && span <= 12 ? span : 12,
          } as CSSProperties
        }
      >
        {children}
      </div>
    );
  }
  if (kind === "block") {
    return (
      <div className="min-w-0 max-w-full" style={blockStyle(values)}>
        {children}
      </div>
    );
  }
  return <div>{children}</div>;
}
