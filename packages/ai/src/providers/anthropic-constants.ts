// Request fingerprint constants for the subscription client transport.
// Kept in a leaf module so OAuth login helpers can build provider headers without
// importing the full Anthropic provider graph.
export const claudeCodeVersion = "2.1.199";
export const claudeAgentSdkVersion = "0.3.199";
export const claudeClientVersion = "1.11187.4";
export const claudeToolPrefix: string = "_";
export const claudeCodeSystemInstruction = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
// The subscription client caps requested output at 64k tokens even when the model ceiling is
// higher (e.g. Opus 4.8 supports 128k); OAuth requests clamp to match the wire
// fingerprint. API-key requests keep the full model ceiling.
export const CLAUDE_CODE_MAX_OUTPUT_TOKENS = 64000;
