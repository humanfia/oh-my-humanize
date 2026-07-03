// Stealth mode constants that mimic Claude Code's request fingerprint.
// Kept in a leaf module so OAuth login helpers can build Claude headers without
// importing the full Anthropic provider graph.
export const claudeCodeVersion = "2.1.165";
export const claudeAgentSdkVersion = "0.3.165";
export const claudeClientVersion = "1.11187.4";
export const claudeToolPrefix: string = "_";
export const claudeCodeSystemInstruction = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
// Claude Code caps requested output at 64k tokens even when the model ceiling is
// higher (e.g. Opus 4.8 supports 128k); OAuth requests clamp to match the wire
// fingerprint. API-key requests keep the full model ceiling.
export const CLAUDE_CODE_MAX_OUTPUT_TOKENS = 64000;
