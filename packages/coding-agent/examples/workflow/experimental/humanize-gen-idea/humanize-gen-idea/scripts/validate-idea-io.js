const argsState = workflowContext.state?.ideaArgs;
if (!argsState || typeof argsState !== "object") {
	throw new Error("Missing or empty idea input");
}
const argsText = typeof argsState.argsText === "string" ? argsState.argsText.trim() : "";
if (!argsText) {
	throw new Error("Missing or empty idea input");
}

const tokens = parseCommandArgs(argsText);
const parsed = parseGenIdeaArgs(tokens);
const n = parseDirectionCount(parsed.n);
const warnings = [];

const input = await resolveIdeaInput(parsed.ideaInput, warnings);
const projectRoot = await resolveProjectRoot();
const output = await resolveOutputPath({
	outputFile: parsed.outputFile,
	projectRoot,
	slug: input.slug,
});
const templateFile = resolveTemplateFile();
await assertFileExists(templateFile, "Template file missing — plugin configuration error");

const idea = {
	inputMode: input.mode,
	input: parsed.ideaInput,
	source: typeof argsState.source === "string" ? argsState.source : "unknown",
	n,
	requestedN: n,
	outputFile: output.outputFile,
	slug: input.slug,
	templateFile,
	warnings,
	rawArgs: argsText,
};
if (input.mode === "file") {
	idea.ideaBodyFile = input.ideaBodyFile;
} else {
	idea.ideaBody = `${parsed.ideaInput}\n`;
}

return {
	summary: `validated humanize gen-idea input; mode=${input.mode}; n=${n}; output=${output.outputFile}`,
	data: {
		inputMode: input.mode,
		outputFile: output.outputFile,
		slug: input.slug,
		n,
		warnings,
	},
	statePatch: [{ op: "set", path: "/idea", value: idea }],
};

function parseGenIdeaArgs(tokens) {
	let ideaInput = "";
	let n = "6";
	let outputFile = "";
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === "--n") {
			const value = tokens[index + 1];
			if (!value || value.startsWith("--")) throw invalidArguments("ERROR: --n requires a value");
			n = value;
			index += 1;
			continue;
		}
		if (token === "--output") {
			const value = tokens[index + 1];
			if (!value || value.startsWith("--")) throw invalidArguments("ERROR: --output requires a value");
			outputFile = value;
			index += 1;
			continue;
		}
		if (token === "-h" || token === "--help") throw invalidArguments();
		if (token.startsWith("--")) throw invalidArguments(`ERROR: Unknown option: ${token}`);
		if (!ideaInput) {
			ideaInput = token;
			continue;
		}
		throw invalidArguments(`ERROR: Unexpected positional argument: ${token}`);
	}
	if (!ideaInput) throw new Error("Missing or empty idea input");
	return { ideaInput, n, outputFile };
}

function parseDirectionCount(value) {
	if (!/^[0-9]+$/u.test(value)) {
		throw invalidArguments(`--n must be a non-negative integer; got: ${value}`);
	}
	const n = Number(value);
	if (n < 2 || n > 10) {
		throw invalidArguments(`--n must be between 2 and 10 inclusive; got: ${value}`);
	}
	return n;
}

async function resolveIdeaInput(ideaInput, warnings) {
	const file = Bun.file(ideaInput);
	if (await file.exists()) {
		if (!ideaInput.endsWith(".md")) {
			throw new Error("Input looks like a file path but is missing, not readable, or not `.md`");
		}
		let body;
		try {
			body = await file.arrayBuffer();
		} catch {
			throw new Error("Input looks like a file path but is missing, not readable, or not `.md`");
		}
		if (body.byteLength === 0) throw new Error("Missing or empty idea input");
		return {
			mode: "file",
			ideaBodyFile: normalizePath(ideaInput),
			slug: basename(ideaInput, ".md"),
		};
	}
	if (looksLikePath(ideaInput)) {
		throw new Error("Input looks like a file path but is missing, not readable, or not `.md`");
	}
	if (ideaInput.length < 10) warnings.push(`WARNING: short idea (${ideaInput.length} chars); proceeding`);
	return {
		mode: "inline",
		slug: slugFromInlineIdea(ideaInput),
	};
}

function looksLikePath(value) {
	return !/\s/u.test(value) && (value.endsWith(".md") || value.includes("/") || value.includes("\\"));
}

async function resolveOutputPath({ outputFile, projectRoot, slug }) {
	const isDefault = !outputFile;
	const resolvedOutput = normalizePath(
		isDefault ? joinPath(projectRoot, ".humanize", "ideas", `${slug}-${timestamp()}.md`) : outputFile,
	);
	const outputDir = dirname(resolvedOutput);
	if (isDefault) {
		if (!(await hasWritePermission(outputDir))) throw new Error("No write permission to output directory");
	} else {
		if (!(await isDirectory(outputDir))) {
			throw new Error("Output directory does not exist — please create it or choose a different path");
		}
		if (!(await hasWritePermission(outputDir))) throw new Error("No write permission to output directory");
	}
	if (await Bun.file(resolvedOutput).exists()) {
		throw new Error("Output file already exists — choose a different path");
	}
	return { outputFile: resolvedOutput };
}

function resolveTemplateFile() {
	const resourceRoot = workflowContext.resources?.root;
	if (typeof resourceRoot !== "string" || !resourceRoot) {
		throw new Error("Template file missing — plugin configuration error");
	}
	return joinPath(resourceRoot, "templates", "gen-idea-template.md");
}

async function resolveProjectRoot() {
	try {
		const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
			cwd: process.cwd(),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		if (exitCode === 0 && stdout.trim()) return stdout.trim();
	} catch {
		// Fall back to the workflow cwd below.
	}
	return process.cwd();
}

async function assertFileExists(filePath, message) {
	const stat = await statOptional(filePath);
	if (!stat?.isFile()) throw new Error(message);
}

async function isDirectory(filePath) {
	const stat = await statOptional(filePath);
	return stat?.isDirectory() === true;
}

async function hasWritePermission(filePath) {
	try {
		const testPath = joinPath(filePath, `.omh-write-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		await Bun.write(testPath, "");
		try {
			await Bun.file(testPath).delete();
		} catch {
			// A failed cleanup should not mask successful write permission.
		}
		return true;
	} catch {
		return false;
	}
}

async function statOptional(filePath) {
	try {
		return await Bun.file(filePath).stat();
	} catch {
		return undefined;
	}
}

function timestamp(date = new Date()) {
	const year = date.getFullYear();
	const month = pad(date.getMonth() + 1);
	const day = pad(date.getDate());
	const hour = pad(date.getHours());
	const minute = pad(date.getMinutes());
	const second = pad(date.getSeconds());
	return `${year}${month}${day}-${hour}${minute}${second}`;
}

function pad(value) {
	return String(value).padStart(2, "0");
}

function slugFromInlineIdea(ideaInput) {
	const firstFortyBytes = new TextDecoder().decode(new TextEncoder().encode(ideaInput).slice(0, 40));
	const slug = firstFortyBytes
		.toLowerCase()
		.replace(/[^a-z0-9-]+/gu, "-")
		.replace(/-+/gu, "-")
		.replace(/^-+|-+$/gu, "");
	return slug || "idea";
}

function joinPath(...segments) {
	return normalizeAbsolutePath(segments.filter(Boolean).join("/"));
}

function normalizePath(value) {
	if (value.startsWith("/")) return normalizeAbsolutePath(value);
	return normalizeAbsolutePath(`${process.cwd()}/${value}`);
}

function normalizeAbsolutePath(value) {
	const parts = [];
	for (const part of value.replace(/\\/gu, "/").split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") {
			parts.pop();
			continue;
		}
		parts.push(part);
	}
	return `/${parts.join("/")}`;
}

function dirname(filePath) {
	const normalized = normalizeAbsolutePath(filePath);
	const index = normalized.lastIndexOf("/");
	if (index <= 0) return "/";
	return normalized.slice(0, index);
}

function basename(filePath, suffix = "") {
	const normalized = filePath.replace(/\\/gu, "/").replace(/\/+$/u, "");
	const base = normalized.slice(normalized.lastIndexOf("/") + 1);
	return suffix && base.endsWith(suffix) ? base.slice(0, -suffix.length) : base;
}

function parseCommandArgs(source) {
	const tokens = [];
	let token = "";
	let quote = "";
	let escaping = false;
	for (const char of source) {
		if (escaping) {
			token += char;
			escaping = false;
			continue;
		}
		if (char === "\\") {
			escaping = true;
			continue;
		}
		if (quote) {
			if (char === quote) {
				quote = "";
				continue;
			}
			token += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (/\s/u.test(char)) {
			if (token) {
				tokens.push(token);
				token = "";
			}
			continue;
		}
		token += char;
	}
	if (escaping) token += "\\";
	if (quote) throw invalidArguments("ERROR: Unterminated quoted argument");
	if (token) tokens.push(token);
	return tokens;
}

function invalidArguments(message) {
	return new Error([message, usageText()].filter(Boolean).join("\n"));
}

function usageText() {
	return [
		"Invalid arguments",
		"Usage: <idea-text-or-path> [--n <int>] [--output <path>]",
		"",
		"Arguments:",
		"  <idea-text-or-path>  Inline idea text OR path to an existing .md file (required)",
		"  --n                  Number of directions (default: 6; range: 2-10)",
		"  --output             Output draft path (default: .humanize/ideas/<slug>-<timestamp>.md)",
		"  -h, --help           Show this help message",
	].join("\n");
}
