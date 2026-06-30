const argsPath = ".humanize/gen-idea.args";
const raw = await readOptionalText(argsPath);
const argsText = raw?.trim();

if (argsText) {
	return {
		summary: `loaded gen-idea arguments from ${argsPath}`,
		statePatch: [
			{
				op: "set",
				path: "/ideaArgs",
				value: {
					status: "loaded",
					source: "file",
					file: argsPath,
					argsText,
				},
			},
		],
	};
}

return {
	summary: `no ${argsPath} file found; requesting interactive gen-idea arguments`,
	statePatch: [
		{
			op: "set",
			path: "/ideaArgs",
			value: {
				status: "missing",
				source: raw === undefined ? "none" : "empty-file",
				file: argsPath,
			},
		},
	],
};

async function readOptionalText(filePath) {
	try {
		return await Bun.file(filePath).text();
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

function isEnoent(error) {
	return error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
