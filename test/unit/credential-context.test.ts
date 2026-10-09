import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { applyCredentialContext, captureCredentialContext } from "../../src/runs/shared/credential-context.ts";

function fixture(t: { after(fn: () => void): void }) {
	const root = mkdtempSync(join(tmpdir(), "credential-context-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "adapter.mjs");
	writeFileSync(path, "export const credentialStoreFromContext = value => ({ account: value.account, read: async () => ({type:'oauth',access:'fixture-access'}), list: async()=>[], modify: async()=>undefined, delete:async()=>{} });", { mode: 0o600 });
	const module = pathToFileURL(path).href;
	let account = "henk";
	const registry = { getRegisteredProviderIds: () => ["openai"], getCredentialStore: () => ({
		access: "must-not-serialize", exportCredentialContext: () => ({ module, value: { account } }),
	}) };
	const entries: Array<{ type: string; customType: string; data: unknown }> = [];
	const session = { getSessionId: () => "child-1", getBranch: () => entries, appendCustomEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); } };
	let installed: { account: string } | undefined;
	const runtime = { async setCredentialStore(_provider: string, store: unknown) { installed = store as typeof installed; } };
	return { root, module, registry, session, runtime, installed: () => installed, select: (next: string) => { account = next; } };
}

test("capture is immutable, secret-free and restores without child extensions", async t => {
	const f = fixture(t), context = captureCredentialContext(f.registry);
	assert.ok(context?.length);assert.ok(!JSON.stringify(context).includes("must-not-serialize"));
	f.select("harrie");await applyCredentialContext(f.runtime, f.session, context);
	assert.equal(f.installed()?.account, "henk");
	await applyCredentialContext(f.runtime, f.session, captureCredentialContext(f.registry));
	assert.equal(f.installed()?.account, "henk", "resuming an existing child keeps its captured account");
});

test("a fork does not adopt a copied parent's child-context record", async t => {
	const f = fixture(t);await applyCredentialContext(f.runtime, f.session, captureCredentialContext(f.registry));
	f.select("harrie");const fork = { ...f.session, getSessionId: () => "fork-child-2" };
	await applyCredentialContext(f.runtime, fork, captureCredentialContext(f.registry));assert.equal(f.installed()?.account, "harrie");
});

test("a detached process restores the captured account after its parent changes", t => {
	const f = fixture(t), context = captureCredentialContext(f.registry);f.select("harrie");
	const helper = new URL("../../src/runs/shared/credential-context.ts", import.meta.url).href;
	const script = `import {applyCredentialContext} from ${JSON.stringify(helper)};
	await applyCredentialContext({setCredentialStore:async(_,s)=>console.log(s.account)}, {getSessionId:()=> 'child',getBranch:()=>[],appendCustomEntry:()=>{}},${JSON.stringify(context)});`;
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 15000 });
	assert.equal(result.status, 0, result.stderr);assert.equal(result.stdout.trim(), "henk");
});

test("unsupported runtimes and non-exportable or remote credential adapters fail closed", async t => {
	const f = fixture(t), context = captureCredentialContext(f.registry);
	await assert.rejects(applyCredentialContext({}, f.session, context), /session-credential-store/);
	assert.throws(() => captureCredentialContext({ getRegisteredProviderIds: () => ["openai"], getCredentialStore: () => ({}) }), /cannot be inherited/);
	await assert.rejects(applyCredentialContext(f.runtime, f.session, [{ provider: "openai", module: "https://example.invalid/code", value: {} }]), /Invalid child/);
});
