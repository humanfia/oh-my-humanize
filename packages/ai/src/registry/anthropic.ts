import { $pickenv } from "@oh-my-pi/pi-utils";
import { isFoundryEnabled } from "../utils/foundry";
import {
	loginAnthropic,
	loginAnthropicClaudeCode,
	loginAnthropicConsole,
	refreshAnthropicToken,
} from "./oauth/anthropic";
import type { ProviderDefinition } from "./types";

export const anthropicProvider = {
	id: "anthropic",
	name: "Anthropic (Claude Pro/Max)",
	// Foundry mode optionally switches Anthropic auth to enterprise gateway credentials.
	envKeys: () =>
		isFoundryEnabled()
			? $pickenv("ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY")
			: $pickenv("ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"),
	login: cb => loginAnthropic(cb),
	refreshToken: credentials => refreshAnthropicToken(credentials.refresh),
	callbackPort: 54545,
	pasteCodeFlow: true,
} as const satisfies ProviderDefinition;

export const anthropicCodeProvider = {
	id: "anthropic-code",
	name: "Claude Code subscription login",
	login: cb => loginAnthropicClaudeCode(cb),
	refreshToken: credentials => refreshAnthropicToken(credentials.refresh),
	storeCredentialsAs: "anthropic",
	pasteCodeFlow: true,
} as const satisfies ProviderDefinition;

export const anthropicConsoleProvider = {
	id: "anthropic-console",
	name: "Claude Console account login",
	login: cb => loginAnthropicConsole(cb),
	apiKeyRequestProfile: "anthropic-console",
	storeCredentialsAs: "anthropic",
	replaceCredentialsOnApiKeyLogin: true,
	pasteCodeFlow: true,
} as const satisfies ProviderDefinition;
