import type { ProviderDefinition } from "./types";

export const nebiusProvider = {
	id: "nebius",
	name: "Nebius Token Factory",
} as const satisfies ProviderDefinition;
