import { loginOpenAICodexDevice, refreshOpenAICodexToken } from "./oauth/openai-codex";
import type { OAuthCredentials } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const openaiCodexDeviceProvider = {
	id: "openai-codex-device",
	name: "Codex (device code)",
	login: loginOpenAICodexDevice,
	refreshToken: async (credentials: OAuthCredentials) => refreshOpenAICodexToken(credentials.refresh),
	storeCredentialsAs: "openai-codex",
} as const satisfies ProviderDefinition;
