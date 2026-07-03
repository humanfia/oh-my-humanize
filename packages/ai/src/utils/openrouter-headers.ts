import packageJson from "../../package.json" with { type: "json" };

export function getOpenRouterHeaders(): Record<string, string> {
	return {
		"User-Agent": `Oh-My-Humanize/${packageJson.version}`,
		"HTTP-Referer": "https://omh.sh/",
		"X-OpenRouter-Title": "Oh-My-Humanize",
		"X-OpenRouter-Categories": "cli-agent",
		"X-OpenRouter-Cache": "true",
		"X-OpenRouter-Cache-TTL": "3600",
	};
}
