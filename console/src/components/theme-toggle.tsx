// ABOUTME: Theme switch cycling system -> light -> dark, reflecting the active mode.

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme, type Theme } from "./theme-provider";
import { cn } from "@/lib/utils";

const ORDER: Theme[] = ["system", "light", "dark"];
const ICON = { system: Monitor, light: Sun, dark: Moon } as const;
const LABEL = { system: "System", light: "Light", dark: "Dark" } as const;

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const Icon = ICON[theme];
  const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length]!;

  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      title={`Theme: ${LABEL[theme]} (click for ${LABEL[next]})`}
      className={cn(
        "inline-flex h-9 items-center gap-2 rounded-md border border-border bg-card px-3",
        "text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
      )}
    >
      <Icon className="h-4 w-4" />
      <span className="hidden sm:inline">{LABEL[theme]}</span>
    </button>
  );
}
