import { describe, expect, it } from "bun:test";
import { workflowScriptEnvironment } from "../script-runtime-env";

describe("workflowScriptEnvironment", () => {
	it("keeps Python cache byproducts under the workflow temp root", () => {
		const env = workflowScriptEnvironment({}, { OMH_RUN_TMP: "/run/tmp", PYTEST_ADDOPTS: "-q" });

		expect(env).toMatchObject({
			OMH_RUN_TMP: "/run/tmp",
			PYTHONDONTWRITEBYTECODE: "1",
			PYTHONPYCACHEPREFIX: "/run/tmp/python-pycache",
			PYTEST_ADDOPTS: "-q -p no:cacheprovider",
		});
	});

	it("falls back to workflow-output tmp when no runtime temp root is provided", () => {
		const env = workflowScriptEnvironment({});

		expect(env).toMatchObject({
			PYTHONDONTWRITEBYTECODE: "1",
			PYTHONPYCACHEPREFIX: "workflow-output/tmp/python-pycache",
			PYTEST_ADDOPTS: "-p no:cacheprovider",
		});
	});
});
