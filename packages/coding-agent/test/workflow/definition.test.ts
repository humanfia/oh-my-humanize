import { describe, expect, it } from "bun:test";
import { parseWorkflowDefinition, WorkflowDefinitionError } from "../../src/workflow/definition";

const cyclicWorkflow = `
name: humanize-loop
version: 1
models:
  roles:
    builder: pi/task:medium
    reviewer: pi/slow:high
  defaults:
    agent: builder
    review: reviewer
nodes:
  build:
    type: agent
    agent: task
    model:
      role: builder
  review:
    type: review
    agent: reviewer
    model:
      role: reviewer
      unavailable: fail
edges:
  - from: build
    to: review
  - from: review
    to: build
    when: state.verdict == "continue"
`;

describe("workflow definition parsing", () => {
	it("parses a cyclic workflow and preserves model context", () => {
		const definition = parseWorkflowDefinition(cyclicWorkflow, { sourcePath: "workflow.yml" });

		expect(definition.name).toBe("humanize-loop");
		expect(definition.version).toBe(1);
		expect(definition.nodes.map(node => node.id)).toEqual(["build", "review"]);
		expect(definition.edges.map(edge => [edge.from, edge.to])).toEqual([
			["build", "review"],
			["review", "build"],
		]);
		expect(definition.edges[1]?.condition?.source).toBe('state.verdict == "continue"');
		expect(definition.models.roles).toEqual({
			builder: "pi/task:medium",
			reviewer: "pi/slow:high",
		});
		expect(definition.nodes[1]?.model).toEqual({ role: "reviewer", unavailable: "fail" });
	});

	it("parses review fallback verdicts for Humanize-style default continue gates", () => {
		const definition = parseWorkflowDefinition(
			`
name: review-fallback
version: 1
nodes:
  review:
    type: review
    prompt: Review the result.
    gates:
      - CONTINUE
      - COMPLETE
    fallbackVerdict: CONTINUE
edges: []
`,
			{ sourcePath: "workflow.yml" },
		);

		expect(definition.nodes[0]?.fallbackVerdict).toBe("CONTINUE");
	});

	it("rejects unsupported state schema field types before execution", () => {
		expect(() =>
			parseWorkflowDefinition(
				`
name: invalid-state-schema
version: 1
stateSchema:
  version: 1
  shape:
    verdict: enum
nodes:
  review:
    type: review
edges: []
`,
				{ sourcePath: "schema.yml" },
			),
		).toThrow("schema.yml: stateSchema.shape.verdict must be string, number, boolean, object, array, or null");
	});

	it("accepts state condition references declared by nested state schema paths", () => {
		const definition = parseWorkflowDefinition(
			`
name: typed-state-condition
version: 1
stateSchema:
  version: 1
  shape:
    decision: object
    /decision/retry: boolean
nodes:
  evaluate:
    type: script
  repair:
    type: script
edges:
  - from: evaluate
    to: repair
    when: state.decision.retry == true
`,
			{ sourcePath: "condition.yml" },
		);

		expect(definition.edges[0]?.condition?.source).toBe("state.decision.retry == true");
	});

	it("preserves script node runtime budgets from workflow definitions", () => {
		const source = `
name: script-timeout
version: 1
nodes:
  validate:
    type: script
    script:
      language: js
      timeoutMs: 120000
      inline: |
        return { summary: "validated" };
edges: []
`;

		const definition = parseWorkflowDefinition(source, { sourcePath: "timeout.yml" });

		expect(definition.nodes[0]?.script).toEqual({
			language: "js",
			code: 'return { summary: "validated" };\n',
			timeoutMs: 120000,
		});
	});

	it("parses dynamic foreach and child workflow nodes without expanding item branches", () => {
		const definition = parseWorkflowDefinition(
			`
name: dynamic-fanout
version: 1
nodes:
  fanout:
    type: foreach
    foreach:
      items: /tasks
      itemName: task
      key: /id
      concurrency: 2
      failureMode: allSettled
      output:
        path: /taskResults
      body:
        node:
          id: processTask
          type: script
          script:
            inline: |
              return { summary: "processed" };
  invokeChild:
    type: workflow
    workflow:
      path: ./child.omhflow
edges:
  - from: fanout
    to: invokeChild
`,
			{ sourcePath: "dynamic.yml" },
		);

		expect(definition.nodes).toHaveLength(2);
		expect(definition.nodes[0]).toMatchObject({
			id: "fanout",
			type: "foreach",
			writes: ["/taskResults"],
			foreach: {
				items: "/tasks",
				itemName: "task",
				key: "/id",
				concurrency: 2,
				failureMode: "allSettled",
				output: { path: "/taskResults" },
				body: {
					kind: "node",
					node: {
						id: "processTask",
						type: "script",
						script: { code: 'return { summary: "processed" };\n' },
					},
				},
			},
		});
		expect(definition.nodes[1]).toMatchObject({
			id: "invokeChild",
			type: "workflow",
			workflow: { path: "./child.omhflow" },
		});
		expect(definition.edges.map(edge => [edge.from, edge.to])).toEqual([["fanout", "invokeChild"]]);
	});

	it("rejects foreach item and output paths that are not JSON pointers", () => {
		expect(() =>
			parseWorkflowDefinition(
				`
name: invalid-foreach
version: 1
nodes:
  fanout:
    type: foreach
    foreach:
      items: tasks
      output:
        path: /results
      body:
        node:
          id: processTask
          type: script
          script:
            inline: |
              return { summary: "processed" };
edges: []
`,
				{ sourcePath: "dynamic.yml" },
			),
		).toThrow("dynamic.yml: nodes.fanout.foreach.items must be a JSON pointer");
		expect(() =>
			parseWorkflowDefinition(
				`
name: invalid-foreach-output
version: 1
nodes:
  fanout:
    type: foreach
    foreach:
      items: /tasks
      output:
        path: results
      body:
        node:
          id: processTask
          type: script
          script:
            inline: |
              return { summary: "processed" };
edges: []
`,
				{ sourcePath: "dynamic.yml" },
			),
		).toThrow("dynamic.yml: nodes.fanout.foreach.output.path must be a JSON pointer");
	});

	it("accepts foreach body as an inline node object", () => {
		const definition = parseWorkflowDefinition(
			`
name: inline-foreach-body
version: 1
nodes:
  fanout:
    type: foreach
    foreach:
      items: /tasks
      output:
        path: /results
      body:
        id: processTask
        type: script
        script:
          inline: |
            return { summary: "processed" };
edges: []
`,
			{ sourcePath: "dynamic.yml" },
		);

		expect(definition.nodes[0]?.foreach?.body).toMatchObject({
			kind: "node",
			node: {
				id: "processTask",
				type: "script",
			},
		});
	});

	it("rejects script node runtime budgets outside the supported adapter limit", () => {
		const source = `
name: invalid-script-timeout
version: 1
nodes:
  validate:
    type: script
    script:
      language: js
      timeoutMs: 3600001
      inline: |
        return { summary: "validated" };
edges: []
`;

		expect(() => parseWorkflowDefinition(source, { sourcePath: "timeout.yml" })).toThrow(
			"timeout.yml: nodes.validate.script.timeoutMs must be a positive integer no greater than 3600000",
		);
	});

	it("rejects state condition references outside declared state schema paths", () => {
		const source = `
name: invalid-state-condition
version: 1
stateSchema:
  version: 1
  shape:
    decision: object
nodes:
  evaluate:
    type: script
  repair:
    type: script
edges:
  - from: evaluate
    to: repair
    when: state.decision.retry == true
`;

		expect(() => parseWorkflowDefinition(source, { sourcePath: "condition.yml" })).toThrow(
			'condition.yml: edges.0.when references undeclared state path "/decision/retry"',
		);
	});

	it("rejects review fallback verdicts outside declared gates", () => {
		expect(() =>
			parseWorkflowDefinition(
				`
name: review-fallback
version: 1
nodes:
  review:
    type: review
    prompt: Review the result.
    gates:
      - CONTINUE
      - COMPLETE
    fallbackVerdict: RETRY
edges: []
`,
				{ sourcePath: "workflow.yml" },
			),
		).toThrow('nodes.review.fallbackVerdict must be one of the declared gates for review node "review"');
	});

	it("rejects edges that reference unknown nodes", () => {
		const source = `
name: invalid-workflow
version: 1
nodes:
  build:
    type: agent
edges:
  - from: build
    to: missing
`;

		expect(() => parseWorkflowDefinition(source, { sourcePath: "invalid.yml" })).toThrow(WorkflowDefinitionError);
		expect(() => parseWorkflowDefinition(source, { sourcePath: "invalid.yml" })).toThrow(
			'invalid.yml: edge references unknown target node "missing"',
		);
	});

	it("rejects malformed edge conditions before execution", () => {
		const source = `
name: invalid-condition
version: 1
nodes:
  build:
    type: agent
  review:
    type: review
edges:
  - from: build
    to: review
    when: state.verdict = "continue"
`;

		expect(() => parseWorkflowDefinition(source, { sourcePath: "condition.yml" })).toThrow(
			'condition.yml: edges.0.when is not a valid workflow condition: unexpected token "="',
		);
	});

	it("accepts boolean edge conditions from the workflow DSL", () => {
		const source = `
name: boolean-condition
version: 1
nodes:
  build:
    type: agent
  review:
    type: review
edges:
  - from: build
    to: review
    when: state.score >= 0.8 && exists(outputs.review.verdict)
`;

		const definition = parseWorkflowDefinition(source, { sourcePath: "condition.yml" });

		expect(definition.edges[0]?.condition?.source).toBe("state.score >= 0.8 && exists(outputs.review.verdict)");
	});

	it("preserves human-facing edge labels without changing route conditions", () => {
		const source = `
name: labeled-condition
version: 1
nodes:
  hold:
    type: script
  check:
    type: script
edges:
  - from: check
    to: hold
    when: state.operatorGate.minimumSatisfied == false
    label: long-running floor pending
`;

		const definition = parseWorkflowDefinition(source, { sourcePath: "condition.yml" });

		expect(definition.edges[0]).toEqual({
			from: "check",
			to: "hold",
			condition: { source: "state.operatorGate.minimumSatisfied == false" },
			label: "long-running floor pending",
		});
	});

	it("rejects conditions that reference unknown output nodes", () => {
		const source = `
name: invalid-output-reference
version: 1
nodes:
  build:
    type: agent
  review:
    type: review
edges:
  - from: review
    to: build
    when: outputs.missing.verdict == "retry"
`;

		expect(() => parseWorkflowDefinition(source, { sourcePath: "condition.yml" })).toThrow(
			'condition.yml: edges.0.when references unknown output node "missing"',
		);
	});

	it("rejects conditions outside the state and outputs roots", () => {
		const source = `
name: invalid-condition-root
version: 1
nodes:
  build:
    type: agent
  review:
    type: review
edges:
  - from: build
    to: review
    when: context.verdict == "retry"
`;

		expect(() => parseWorkflowDefinition(source, { sourcePath: "condition.yml" })).toThrow(
			"condition.yml: edges.0.when must reference state.* or outputs.*",
		);
	});

	it("rejects review verdict conditions that reference undeclared gates", () => {
		const source = `
name: invalid-review-gate
version: 1
nodes:
  fix:
    type: agent
  review:
    type: review
    gates:
      - retry
      - complete
edges:
  - from: review
    to: fix
    when: outputs.review.verdict == "needs-work"
`;

		expect(() => parseWorkflowDefinition(source, { sourcePath: "condition.yml" })).toThrow(
			'condition.yml: edges.0.when references undeclared verdict "needs-work" for review node "review"',
		);
	});

	it("preserves node state read and write scopes", () => {
		const source = `
name: scoped-state
version: 1
nodes:
  review:
    type: review
    reads:
      - /draft
    writes:
      - /review
edges: []
`;

		const definition = parseWorkflowDefinition(source, { sourcePath: "state.yml" });

		expect(definition.nodes[0]?.reads).toEqual(["/draft"]);
		expect(definition.nodes[0]?.writes).toEqual(["/review"]);
	});

	it("preserves plugin, extension, and skill capability declarations", () => {
		const source = `
name: capability-contract
version: 1
capabilities:
  tools:
    - task
  agents:
    - reviewer
  plugins:
    - humanize-loop
    - optimizer@community
  extensions:
    - humanize-extension
  skills:
    - grill-me
nodes:
  review:
    type: review
edges: []
`;

		const definition = parseWorkflowDefinition(source, { sourcePath: "capabilities.yml" });

		expect(definition.capabilities).toEqual({
			tools: ["task"],
			agents: ["reviewer"],
			plugins: ["humanize-loop", "optimizer@community"],
			extensions: ["humanize-extension"],
			skills: ["grill-me"],
		});
	});

	it("preserves explicit script language and package file selection", () => {
		const source = `
name: script-source
version: 1
nodes:
  score:
    type: script
    script:
      language: py
      file: ./scripts/score.py
edges: []
`;

		const definition = parseWorkflowDefinition(source, { sourcePath: "script.yml" });

		expect(definition.nodes[0]?.script).toEqual({
			language: "py",
			file: "./scripts/score.py",
		});
	});

	it("accepts shell script nodes for long-running program execution", () => {
		const source = `
name: shell-script-source
version: 1
nodes:
  build:
    type: script
    script:
      language: sh
      inline: |
        printf '{"summary":"build complete"}\\n'
edges: []
`;

		const definition = parseWorkflowDefinition(source, { sourcePath: "script.yml" });

		expect(definition.nodes[0]?.script).toEqual({
			language: "sh",
			code: 'printf \'{"summary":"build complete"}\\n\'\n',
		});
	});

	it("rejects unsupported script languages", () => {
		const source = `
name: invalid-script-language
version: 1
nodes:
  score:
    type: script
    script:
      language: rb
      inline: puts "no"
edges: []
`;

		expect(() => parseWorkflowDefinition(source, { sourcePath: "script.yml" })).toThrow(
			"script.yml: nodes.score.script.language must be js, py, or sh",
		);
	});

	it("rejects duplicate node ids in list-form definitions", () => {
		const source = `
name: duplicate-nodes
version: 1
nodes:
  - id: build
    type: agent
  - id: build
    type: review
edges: []
`;

		expect(() => parseWorkflowDefinition(source, { sourcePath: "duplicate.yml" })).toThrow(
			'duplicate.yml: duplicate node id "build"',
		);
	});

	it("rejects model contexts with multiple model sources", () => {
		const source = `
name: invalid-model
version: 1
nodes:
  build:
    type: agent
    model:
      role: builder
      selector: provider/model:high
edges: []
`;

		expect(() => parseWorkflowDefinition(source, { sourcePath: "model.yml" })).toThrow(
			"model.yml: nodes.build.model must define exactly one of role, selector, or candidates",
		);
	});
});
