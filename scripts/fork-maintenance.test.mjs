import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discover, isolatedEnvironment, latestStable, plan, runStep, sourceIdentity } from "./fork-maintenance.mjs";

const base = "a".repeat(40), next = "b".repeat(40);
const policy = { repository: "paetor/pi", upstream: "earendil-works/pi", upstreamBase: base, upstreamVersion: "1.1.0" };
const refs = (sha, version, peel = "") => `${sha}\trefs/tags/v${version}${peel}\n`;
function temporary(t) { const root = mkdtempSync(join(tmpdir(), "fork-ci-test-")); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }

test("unchanged upstream is a successful no-op, not a pretend integration", () => {
	assert.equal(discover(policy, refs(base, "1.1.0")).state, "current");
});
test("stable numeric discovery peels annotated tags and ignores prereleases", () => {
	const data = refs(base, "1.9.0") + refs(base, "1.10.0") + refs(next, "1.10.0", "^{}") + refs(base, "99.0.0-rc.1");
	assert.deepEqual(latestStable(data), { version: "1.10.0", sha: next });
	assert.equal(discover(policy, refs(base, "1.1.0") + refs(next, "1.2.0")).state, "integration-needed");
});
test("rewritten tags, regressed history and absent stable tags fail closed", () => {
	assert.throws(() => discover(policy, refs(next, "1.1.0")), /tag moved/);
	assert.throws(() => discover(policy, refs(next, "1.1.0") + refs(next, "1.2.0")), /tag moved/);
	assert.throws(() => discover(policy, refs(next, "1.2.0")), /disappeared/);
	assert.throws(() => discover(policy, refs(next, "1.0.0")), /regressed/);
	assert.throws(() => latestStable(refs(base, "2.0.0-rc.1")), /No stable/);
});
test("test environment strips provider credentials, hooks, GitHub credentials and real user resource roots", t => {
	const root = temporary(t);
	const env = isolatedEnvironment(root, { HOME: "/fixture/original", PATH: "/bin", OPENAI_API_KEY: "sentinel", GH_TOKEN: "sentinel", NODE_OPTIONS: "--require unsafe", PI_CODING_AGENT_DIR: "/unsafe", SSH_AUTH_SOCK: "/unsafe" });
	for (const name of ["OPENAI_API_KEY", "GH_TOKEN", "NODE_OPTIONS", "PI_CODING_AGENT_DIR", "SSH_AUTH_SOCK"]) assert.equal(env[name], undefined);
	assert.equal(env.HOME, join(root, "home"));
	assert.equal(env.CARGO_HOME, join(root, "cargo"));
});
test("real failing commands fail the phase and retain diagnostics rather than returning green", t => {
	const root = temporary(t), env = isolatedEnvironment(root);
	assert.throws(() => runStep({ name: "negative-control", command: process.execPath, args: ["-e", "console.error('fixture-failure');process.exit(7)"] }, root, env, root), /failed \(7\)/);
	assert.match(readFileSync(join(root, "negative-control.log"), "utf8"), /fixture-failure/);
});
test("source identity binds uncommitted bytes and modes without following symlinks", t => {
	const root = temporary(t), env = isolatedEnvironment(root);
	assert.equal(spawnSync("git", ["init"], { cwd: root, env }).status, 0);
	const path = join(root, "source.mjs");
	writeFileSync(path, "first", { mode: 0o600 });
	symlinkSync("/missing-fixture-target", join(root, "fixture-link"));
	const first = sourceIdentity(root, env);
	writeFileSync(path, "second"); assert.notEqual(sourceIdentity(root, env), first);
	writeFileSync(path, "first"); assert.equal(sourceIdentity(root, env), first);
	chmodSync(path, 0o700); assert.notEqual(sourceIdentity(root, env), first);
});

test("hung commands are bounded and fail closed", t => {
	const root = temporary(t), env = isolatedEnvironment(root);
	assert.throws(() => runStep({ name: "timeout-control", command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], timeoutMs: 200 }, root, env, root), /failed/);
});

test("plans keep full checks, the daemon prerequisite, disabled install hooks and compiled child packaging", t => {
	const root = temporary(t);
	for (const directory of ["unit", "integration"]) { mkdirSync(join(root, "test", directory), { recursive: true }); writeFileSync(join(root, "test", directory, "example.test.ts"), ""); }
	const pi = plan("pi", root), child = plan("subagents", root);
	assert(pi.find(step => step.name === "install").args.includes("--ignore-scripts"));
	assert(pi.findIndex(step => step.name === "daemon") < pi.findIndex(step => step.name === "tests"));
	assert.equal(pi.find(step => step.name === "tests").args[0], "test.sh");
	assert(child.some(step => step.args.includes("build:pkg")));
	assert(child.some(step => step.name === "integration"));
});
