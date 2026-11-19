import assert from "node:assert/strict";
import test from "node:test";
import { ALL_PATCHES, applyReplacementsToText, hostPromptKeepsInject } from "../lib/core.js";

const patch = ALL_PATCHES.find(p => p.id === 40);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// Assembly return block from dsh-system-prompt 0.2.2-rc.5. Tools are now
// returned separately and required contexts must survive context suppression.
const currentHost = `// [dsh-purge] identity stripped
		const transformed = await this.ctx.waterfall(scopeTarget(this, scope), "system-prompt/assemble", assembly, context, () => Promise.resolve(assembly));
		if (completeSection === void 0 && !runtimeContextSuppressed) return {
			...transformed,
			tools
		};
		const requiredContexts = new Set([...contextByName.values()].filter((entry) => entry.required === true).map((entry) => entry.name));
		return {
			...transformed,
			tools,
			sections: completeSection === void 0 ? transformed.sections : [completeSection],
			contexts: runtimeContextSuppressed ? transformed.contexts.filter((entry) => requiredContexts.has(entry.name)) : transformed.contexts
		};`;

const legacyHost = `// [dsh-purge] identity stripped
		const transformed = await this.ctx.waterfall(scopeTarget(this, scope), "system-prompt/assemble", assembly, context, () => Promise.resolve(assembly));
		if (completeSection === void 0 && !runtimeContextSuppressed) return transformed;
		return {
			...transformed,
			sections: completeSection === void 0 ? transformed.sections : [completeSection],
			contexts: runtimeContextSuppressed ? [] : transformed.contexts
		};`;

for (const [layout, source] of [
  ["tabs and LF", currentHost],
  ["spaces and CRLF", currentHost.replaceAll("\t", "  ").replaceAll("\n", "\r\n")],
  ["legacy", legacyHost],
]) {
  test(`complete prompt patch matches ${layout}, passes host validation and is idempotent`, () => {
    assert.equal(hostPromptKeepsInject(source), false);
    const result = applyReplacementsToText(source, patch);
    assert.equal(result.changed, true);
    assert.equal(hostPromptKeepsInject(result.text), true);
    assert.equal(applyReplacementsToText(result.text, patch).changed, false);
    if (layout.includes("CRLF")) assert.equal(/(?<!\r)\n/.test(result.text), false);
  });
}

for (const complete of [false, true]) {
  for (const suppressed of [false, true]) {
    test(`0.2.2 assembly preserves tools and required contexts (complete=${complete}, suppressed=${suppressed})`, async () => {
      const patched = applyReplacementsToText(currentHost, patch);
      assert.equal(patched.changed, true);
      const injected = { name: "dsh-purge:test", text: "Plugin section added by waterfall" };
      const helper = { name: "helper", text: "Host section" };
      const base = { name: "preset", text: "Complete preset" };
      const transformed = {
        sections: [helper, ...(complete ? [base] : []), injected],
        contexts: [{ name: "required", text: "Required context" }, { name: "optional", text: "Optional context" }],
        variables: { example: "value" },
        tools: [{ name: "stale-waterfall-tool" }],
      };
      const tools = [{ name: "actual-host-tool", parameters: { type: "object" } }];
      const contextByName = new Map([
        ["required", { name: "required", required: true }],
        ["optional", { name: "optional" }],
      ]);
      const run = new AsyncFunction("scopeTarget", "scope", "assembly", "context", "completeSection", "runtimeContextSuppressed", "tools", "contextByName", patched.text);
      const actual = await run.call(
        { ctx: { waterfall: async () => transformed } },
        () => null, {}, { sections: [] }, {}, complete ? base : undefined, suppressed, tools, contextByName,
      );
      assert.deepEqual(actual.sections, [injected, helper, ...(complete ? [base] : [])]);
      assert.equal(actual.tools, tools);
      assert.equal(actual.variables, transformed.variables);
      assert.deepEqual(actual.contexts, suppressed ? [transformed.contexts[0]] : transformed.contexts);
    });
  }
}

test("host validation continues to reject an unrecognized incomplete assembly", () => {
  const unsupported = currentHost.replace("return {\n\t\t\t...transformed,\n\t\t\ttools\n", "return {\n\t\t\t...transformed,\n\t\t\tunknownField\n");
  const result = applyReplacementsToText(unsupported, patch);
  assert.equal(result.changed, false);
  assert.equal(hostPromptKeepsInject(result.text), false);
});
