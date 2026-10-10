import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function latestStable(refs) {
	const tags = new Map();
	for (const line of refs.trim().split("\n")) {
		const match = /^([a-f0-9]{40})\s+refs\/tags\/v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(\^\{\})?$/.exec(line);
		if (!match) continue;
		const parts = match[2].split(".").map(BigInt);
		if (!tags.has(match[2]) || match[3]) tags.set(match[2], { version: match[2], sha: match[1], parts });
	}
	const result = [...tags.values()].sort((a, b) => {
		for (let i = 0; i < 3; i++) if (a.parts[i] !== b.parts[i]) return a.parts[i] > b.parts[i] ? 1 : -1;
		return 0;
	}).at(-1);
	if (!result) throw new Error("No stable upstream tag");
	return { version: result.version, sha: result.sha };
}

export function discover(policy, refs) {
	const latest = latestStable(refs);

	const current = policy.upstreamVersion.split(".").map(BigInt), next = latest.version.split(".").map(BigInt);
	const difference = next.findIndex((value, i) => value !== current[i]);
	if (difference >= 0 && next[difference] < current[difference]) throw new Error("Upstream stable history regressed");
	const currentRefs = refs.split("\n").filter(line => line.endsWith(`refs/tags/v${policy.upstreamVersion}`) || line.endsWith(`refs/tags/v${policy.upstreamVersion}^{}`)).join("\n");
	if (!currentRefs || latestStable(currentRefs).sha !== policy.upstreamBase) throw new Error("Existing upstream tag moved or disappeared; integration must investigate");
	return { schema: 1, repository: policy.repository, upstream: policy.upstream, current: { version: policy.upstreamVersion, sha: policy.upstreamBase }, latest, state: difference < 0 ? "current" : "integration-needed" };
}

export function plan(kind, root) {
	const npm = process.platform === "win32" ? "npm.cmd" : "npm";
	const common = [{ name: "selftest", command: process.execPath, args: ["--test", "scripts/fork-maintenance.test.mjs"] }, { name: "install", command: npm, args: ["ci", "--ignore-scripts", "--no-audit", "--no-fund"] }];
	if (kind === "pi") return [...common,
		{ name: "model-data-controls", command: "python3", args: ["-I", "scripts/fork-model-data-test.py"] },
		{ name: "hydrate", command: "python3", args: ["-I", "scripts/fork-model-data.py"] },
		{ name: "model-data-check", command: process.execPath, args: ["packages/ai/scripts/check-model-data.ts"] },
		{ name: "build", command: npm, args: ["run", "build:offline"] },
		{ name: "check", command: npm, args: ["run", "check"] },
		{ name: "daemon", command: npm, args: ["run", "build:daemon", "--workspace", "packages/env"] },
		{ name: "tests", command: "bash", args: ["test.sh"] }];
	if (kind !== "subagents") throw new Error("Unknown fork kind");
	const tests = directory => readdirSync(join(root, "test", directory)).filter(name => name.endsWith(".test.ts")).sort().map(name => `test/${directory}/${name}`);
	return [...common,
		{ name: "typecheck", command: npm, args: ["run", "typecheck"] },
		{ name: "schema", command: npm, args: ["run", "test:smoke:tool-activation"] },
		{ name: "units", command: process.execPath, args: ["--experimental-strip-types", "--import", "./test/support/isolated-temp-root.mjs", "--test", "--test-concurrency=2", ...tests("unit")] },
		{ name: "build", command: npm, args: ["run", "build:pkg"] },
		{ name: "integration", command: process.execPath, args: ["--experimental-strip-types", "--import", "./test/support/register-loader.mjs", "--test", "--test-concurrency=2", ...tests("integration")] }];
}

export function isolatedEnvironment(home, original = process.env) {
	for (const dir of ["home/.config", "tmp", "cache", "cargo"]) mkdirSync(join(home, dir), { recursive: true, mode: 0o700 });
	for (const name of ["npm-userconfig", "npm-globalconfig"]) writeFileSync(join(home, name), "", { mode: 0o600 });
	return { PATH: original.PATH, HOME: join(home, "home"), USERPROFILE: join(home, "home"), TMPDIR: join(home, "tmp"), TMP: join(home, "tmp"), TEMP: join(home, "tmp"), XDG_CONFIG_HOME: join(home, "home/.config"), XDG_CACHE_HOME: join(home, "cache"), NPM_CONFIG_USERCONFIG: join(home, "npm-userconfig"), NPM_CONFIG_GLOBALCONFIG: join(home, "npm-globalconfig"), NPM_CONFIG_CACHE: join(home, "cache"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/usr/bin/false", CI: "true", LANG: "C", TZ: "UTC", NODE_DISABLE_COMPILE_CACHE: "1", PI_NO_LOCAL_LLM: "1", PI_SKIP_VERSION_CHECK: "1", AWS_EC2_METADATA_DISABLED: "true", CARGO_HOME: join(home, "cargo"), RUSTUP_HOME: original.RUSTUP_HOME || (original.HOME ? join(original.HOME, ".rustup") : undefined) };
}

export function runStep(step, root, env, output) {
	const result = spawnSync(step.command, step.args, { cwd: root, env, encoding: "utf8", detached: process.platform !== "win32", timeout: step.timeoutMs || 1800000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024 });
	if (process.platform !== "win32" && result.pid > 0) {
		try { process.kill(-result.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
	}
	const text = (result.stdout || "") + (result.stderr || "");
	writeFileSync(join(output, `${step.name}.log`), text, { mode: 0o600 });
	process.stdout.write(text);
	if (result.error || result.status !== 0) throw new Error(`Fork CI phase ${step.name} failed (${result.status ?? result.error?.code})`);
}

export function sourceIdentity(root, env) {
	const result = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, env, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
	if (result.status !== 0) throw new Error("Cannot fingerprint CI source");
	const files = [...new Set(result.stdout.split("\0").filter(Boolean))].sort();
	return createHash("sha256").update(JSON.stringify(files.map(path => { const absolute = join(root, path), stat = lstatSync(absolute); return [path, stat.mode, createHash("sha256").update(stat.isSymbolicLink() ? readlinkSync(absolute) : readFileSync(absolute)).digest("hex")]; }))).digest("hex");
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const sandbox = realpathSync(mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "fci-")));
	const output = join(root, ".fork-ci");
	mkdirSync(output, { recursive: true, mode: 0o700 });
	try {
		const policy = JSON.parse(readFileSync(join(root, ".github/fork-policy.json"), "utf8"));
		if (policy.schema !== 1 || !["paetor/pi", "paetor/pi-subagents"].includes(policy.repository) || !["earendil-works/pi", "nicobailon/pi-subagents"].includes(policy.upstream) || !/^[a-f0-9]{40}$/.test(policy.upstreamBase)) throw new Error("Invalid fork policy");
		const env = isolatedEnvironment(sandbox), [action, phase] = process.argv.slice(2);
		if (action === "discover" && !phase) {
			const result = spawnSync("git", ["ls-remote", "--tags", `https://github.com/${policy.upstream}.git`], { env, encoding: "utf8", timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
			if (result.status !== 0) throw new Error("Upstream discovery failed");
			const report = discover(policy, result.stdout);
			writeFileSync(join(output, "upstream.json"), `${JSON.stringify(report, null, 2)}\n`);
			console.log(JSON.stringify(report, null, 2));
		} else if (action === "ci") {
			const steps = plan(policy.kind, root), selected = phase ? steps.filter(step => step.name === phase) : steps;
			if (!selected.length) throw new Error("Unknown CI phase");
			const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, env, encoding: "utf8" });
			if (head.status !== 0) throw new Error("Cannot identify source commit");
			const before = sourceIdentity(root, env);
			const receipt = { schema: 1, sourceTreeSha256: before, repository: policy.repository, sha: head.stdout.trim(), platform: process.platform, architecture: process.arch, node: process.version, fullPlan: !phase, completed: false, phases: [] };
			const save = () => writeFileSync(join(output, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
			save();
			for (const step of selected) { runStep(step, root, env, output); receipt.phases.push(step.name); save(); }
			if (sourceIdentity(root, env) !== before) throw new Error("CI changed source inputs; review changes and rerun");
			receipt.completed = true; save();
			console.log("FORK CI VERIFIED");
		} else throw new Error("Usage: node scripts/fork-maintenance.mjs discover|ci [phase]");
	} catch (error) { console.error(error.message); process.exitCode = 1; }
	finally { rmSync(sandbox, { recursive: true, force: true }); }
}
