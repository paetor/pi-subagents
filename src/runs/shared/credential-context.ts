import { createJiti } from "jiti";

/** App-owned, non-secret credential-store descriptors; never tool parameters. */
export interface CredentialContext {
	provider: string;
	module: string;
	value: unknown;
}
export interface CredentialContextRegistry {
	getRegisteredProviderIds(): readonly string[];
	getCredentialStoreProviders?(): readonly string[];
	getCredentialStore?(provider: string): unknown;
}
interface ExportableStore {
	exportCredentialContext(): { module: string; value: unknown };
}
export function captureCredentialContext(registry?: CredentialContextRegistry): CredentialContext[] | undefined {
	if (!registry?.getCredentialStore) return;
	const contexts: CredentialContext[] = [];
	for (const provider of registry.getCredentialStoreProviders?.() ?? registry.getRegisteredProviderIds()) {
		const store = registry.getCredentialStore(provider);
		if (!store) continue;
		if (typeof (store as Partial<ExportableStore>).exportCredentialContext !== "function") {
			throw new Error(`Provider '${provider}' has a session credential store that cannot be inherited safely.`);
		}
		const context = (store as ExportableStore).exportCredentialContext();
		if (!context.module.startsWith("file:")) throw new Error("Credential adapters must be host-local files.");
		contexts.push({ provider, ...context });
	}
	return contexts.length ? structuredClone(contexts) : undefined;
}
interface ContextSession {
	getSessionId(): string;
	getBranch(): Array<{ type: string; customType?: string; data?: unknown }>;
	appendCustomEntry(type: string, value: unknown): unknown;
}
interface ContextRuntime {
	setCredentialStore?: (provider: string, store: unknown, options?: { retainOnFailure?: boolean }) => Promise<void>;
}
const ENTRY = "pi-child-credential-context";
export async function applyCredentialContext(runtime: unknown, session: ContextSession, requested?: CredentialContext[]): Promise<void> {
	const branch = session.getBranch?.() ?? [];
	const own = branch.filter(entry => entry.type === "custom" && entry.customType === ENTRY)
		.map(entry => entry.data as { sessionId?: string; contexts?: CredentialContext[] })
		.reverse().find(entry => entry?.sessionId === session.getSessionId());
	const contexts = own?.contexts ?? requested;
	if (!contexts?.length) return;
	const target = runtime as ContextRuntime;
	if (typeof target.setCredentialStore !== "function") throw new Error("This child requires the session-credential-store Pi runtime.");
	const loader = createJiti(import.meta.url, { interopDefault: true });
	for (const context of contexts) {
		if (!context.module.startsWith("file:") || !context.provider) throw new Error("Invalid child credential context.");
		// A transcript can preserve a binding, never choose executable adapter code.
		if (!requested?.some(approved => approved.provider === context.provider && approved.module === context.module)) {
			throw new Error("The child's original credential adapter is not registered by the launching parent.");
		}
		const adapter = await loader.import(context.module) as { credentialStoreFromContext?: (value: unknown, branch: unknown[]) => unknown };
		if (typeof adapter.credentialStoreFromContext !== "function") throw new Error("Credential adapter cannot restore its store.");
		const store = await adapter.credentialStoreFromContext(context.value, branch);
		await target.setCredentialStore(context.provider, store, { retainOnFailure: true });
	}
	if (!own) session.appendCustomEntry(ENTRY, { sessionId: session.getSessionId(), contexts });
}
