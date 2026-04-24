export interface BranchVariant {
  label: string;
  description: string;
  configOverrides: Record<string, unknown>;
}

export function createAblationVariants(
  baseConfig: Record<string, unknown>,
  dimensions: string[],
): BranchVariant[] {
  const variants: BranchVariant[] = [];

  for (const dimension of dimensions) {
    const overrides: Record<string, unknown> = { ...baseConfig };
    delete overrides[dimension];

    variants.push({
      label: `no-${dimension}`,
      description: `Ablation: remove "${dimension}" from the base configuration`,
      configOverrides: overrides,
    });
  }

  return variants;
}

export function createFreshVsWarmVariants(): BranchVariant[] {
  return [
    {
      label: "fresh-profile",
      description: "Run with a fresh browser profile (no cookies, no cache, no state)",
      configOverrides: { useWarmProfile: false },
    },
    {
      label: "warm-profile",
      description: "Run with a warm browser profile (existing cookies, cache, and state)",
      configOverrides: { useWarmProfile: true },
    },
  ];
}
