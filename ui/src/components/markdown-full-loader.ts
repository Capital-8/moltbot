import { lazyModule } from "solid-js";

// Most selected names cannot affect code ownership. Resolve the canonical
// source parser only before rendering a name that contains a code delimiter.
export const loadFullMarkdown = lazyModule(() => import("./markdown-full.ts"));
