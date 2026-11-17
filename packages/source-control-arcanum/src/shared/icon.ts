import type { SourceControlIcon } from "@t3tools/source-control-core/shared/definition";

/** The same arc-and-dot glyph the client draws for the Arc VCS. */
export const icon: SourceControlIcon = {
  viewBox: "0 0 24 24",
  paths: [
    { d: "M4 19a8 8 0 0 1 16 0", stroke: "currentColor", strokeWidth: 2.5 },
    { d: "M14.5 7a2.5 2.5 0 1 1-5 0a2.5 2.5 0 1 1 5 0Z", fill: "currentColor" },
  ],
};
