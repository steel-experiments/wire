import type { BrowserExecTarget } from "../shared/types.js";

// Target / tab routing helpers

/**
 * Resolve a target specification to a concrete value.
 * Defaults to `"active-tab"` when no target is provided.
 */
export function resolveTarget(target: BrowserExecTarget | undefined): BrowserExecTarget {
  return target ?? "active-tab";
}

/**
 * Return a human-readable description of a browser execution target.
 */
export function describeTarget(target: BrowserExecTarget): string {
  if (target === "active-tab") {
    return "active tab";
  }

  if (target === "all-tabs") {
    return "all tabs";
  }

  if (typeof target === "object" && "tabId" in target) {
    return `tab ${target.tabId}`;
  }

  // Exhaustive check – this should never be reached if the union is complete.
  return String(target);
}
