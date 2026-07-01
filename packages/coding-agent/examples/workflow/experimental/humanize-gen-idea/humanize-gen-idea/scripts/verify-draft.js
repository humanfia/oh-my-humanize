const idea = workflowContext.state?.idea;
if (!idea || typeof idea !== "object") {
	throw new Error("humanize-gen-idea requires /idea before verifyDraft");
}
const outputFile = requiredString(idea.outputFile, "idea.outputFile");
const expectedIdea = await originalIdeaBody(idea);
let draft;
try {
	draft = await Bun.file(outputFile).text();
} catch (error) {
	throw new Error(`draft file was not generated: ${outputFile}`);
}
if (!draft.trim()) {
	throw new Error(`draft file is empty: ${outputFile}`);
}
const requiredHeadings = [
	"## Original Idea",
	"## Primary Direction:",
	"### Approach Summary",
	"### Objective Evidence",
	"### Known Risks",
	"## Alternative Directions Considered",
	"## Synthesis Notes",
];
for (const heading of requiredHeadings) {
	if (!draft.includes(heading)) throw new Error(`draft missing required section: ${heading}`);
}
if (!draft.includes(expectedIdea.trim())) {
	throw new Error("draft does not include the original idea body");
}
const unresolved = /<(?:TITLE|ORIGINAL_IDEA|PRIMARY_NAME|PRIMARY_RATIONALE|PRIMARY_APPROACH_SUMMARY|PRIMARY_OBJECTIVE_EVIDENCE|PRIMARY_KNOWN_RISKS|ALTERNATIVES|SYNTHESIS_NOTES)>/u.exec(draft);
if (unresolved) {
	throw new Error(`draft still contains unresolved placeholder ${unresolved[0]}`);
}

const result = {
	status: "written",
	outputFile,
	bytes: new TextEncoder().encode(draft).byteLength,
};

return {
	summary: `Idea draft saved to ${outputFile}.`,
	data: result,
	statePatch: [{ op: "set", path: "/result", value: result }],
};

function requiredString(value, label) {
	if (typeof value === "string" && value.length > 0) return value;
	throw new Error(`humanize-gen-idea requires ${label}`);
}

async function originalIdeaBody(idea) {
	if (typeof idea.ideaBody === "string" && idea.ideaBody.length > 0) return idea.ideaBody;
	if (typeof idea.ideaBodyFile === "string" && idea.ideaBodyFile.length > 0) {
		return await Bun.file(idea.ideaBodyFile).text();
	}
	throw new Error("humanize-gen-idea requires idea.ideaBody or idea.ideaBodyFile");
}
