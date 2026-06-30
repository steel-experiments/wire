// ABOUTME: Small shared UI utilities.
// ABOUTME: `cn` merges class names with Tailwind-aware conflict resolution.

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
