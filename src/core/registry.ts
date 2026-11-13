import type { ProviderProbeResult, StorageProvider } from "../types/storage.types.js";
import { StorageError } from "./errors.js";

export type ProviderProbeMap = Record<
    string,
    ProviderProbeResult | { ok: true; detail: { skipped: true } }
>;

export interface StorageProviderRegistry {
    register(provider: StorageProvider): void;
    get(idOrKind: string): StorageProvider;
    has(idOrKind: string): boolean;
    list(): string[];
    /** Prefer exact id match; fall back to kind match when a single provider of that kind exists. */
    resolve(idOrKind: string): StorageProvider;
    probeAll(): Promise<ProviderProbeMap>;
}

/** In-process registry keyed by {@link StorageProvider.id}. */
export function createStorageProviderRegistry(): StorageProviderRegistry {
    const byId = new Map<string, StorageProvider>();

    function findByKind(kind: string): StorageProvider | undefined {
        const matches = [...byId.values()].filter((p) => p.kind === kind);
        return matches.length === 1 ? matches[0] : undefined;
    }

    return {
        register(provider) {
            byId.set(provider.id, provider);
        },
        get(idOrKind) {
            return this.resolve(idOrKind);
        },
        has(idOrKind) {
            if (byId.has(idOrKind)) {
                return true;
            }
            return findByKind(idOrKind) != null;
        },
        list() {
            return [...byId.keys()];
        },
        resolve(idOrKind) {
            const exact = byId.get(idOrKind);
            if (exact != null) {
                return exact;
            }
            const byKind = findByKind(idOrKind);
            if (byKind != null) {
                return byKind;
            }
            const available = [...byId.keys()].join(", ") || "(none)";
            throw new StorageError(`Unknown storage provider: ${idOrKind}. Registered: ${available}`, {
                code: "UNKNOWN_PROVIDER",
            });
        },
        async probeAll() {
            const out: ProviderProbeMap = {};
            for (const [id, provider] of byId) {
                if (provider.probe == null) {
                    out[id] = { ok: true, detail: { skipped: true } };
                    continue;
                }
                out[id] = await provider.probe();
            }
            return out;
        },
    };
}
