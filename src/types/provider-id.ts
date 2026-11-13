import type { StorageProviderKind } from "./storage.types.js";

/** Shared id prefix for localFs and remoteFs (upload-service convention). */
export const FS_STORAGE_PREFIX = "fs:";
export const R2_STORAGE_PREFIX = "r2:";

/**
 * Id family parsed from a stored provider id.
 * Both `localFs` and `remoteFs` use the `fs:` prefix — distinguish via provider.kind.
 */
export type StorageProviderIdFamily = "fs" | "r2";

const KIND_PREFIX: Record<StorageProviderKind, string> = {
    localFs: FS_STORAGE_PREFIX,
    remoteFs: FS_STORAGE_PREFIX,
    r2: R2_STORAGE_PREFIX,
};

export function providerIdPrefix(kind: StorageProviderKind): string {
    return KIND_PREFIX[kind];
}

export function buildProviderId(kind: StorageProviderKind, suffix: string): string {
    const trimmed = suffix.trim();
    if (trimmed === "") {
        throw new Error(`buildProviderId: empty suffix for kind ${kind}`);
    }
    const prefix = KIND_PREFIX[kind];
    if (trimmed.startsWith(prefix)) {
        return trimmed;
    }
    return `${prefix}${trimmed}`;
}

export function parseProviderId(raw: string): { family: StorageProviderIdFamily; suffix: string } | null {
    const value = raw.trim();
    if (value.startsWith(R2_STORAGE_PREFIX) && value.length > R2_STORAGE_PREFIX.length) {
        // Locator `r2:{bucket}/{key}` also starts with r2: — only treat as provider id when no "/" after prefix
        // or when used as provider id form `r2:name` without requiring slash rules here.
        return { family: "r2", suffix: value.slice(R2_STORAGE_PREFIX.length) };
    }
    if (value.startsWith(FS_STORAGE_PREFIX) && value.length > FS_STORAGE_PREFIX.length) {
        return { family: "fs", suffix: value.slice(FS_STORAGE_PREFIX.length) };
    }
    return null;
}

export function requirePrefixedId(raw: string, prefix: string, label: string, example: string): string {
    const trimmed = raw.trim();
    if (!trimmed.startsWith(prefix) || trimmed === prefix) {
        throw new Error(`${label} must be a full id starting with "${prefix}" (got "${raw}"). Example: ${example}`);
    }
    return trimmed;
}

export function isFsStorageProviderId(stored: string | null | undefined): boolean {
    return (stored ?? "").trim().startsWith(FS_STORAGE_PREFIX);
}

export function isR2StorageProviderId(stored: string | null | undefined): boolean {
    const value = (stored ?? "").trim();
    if (!value.startsWith(R2_STORAGE_PREFIX) || value === R2_STORAGE_PREFIX) {
        return false;
    }
    // Opaque object locator `r2:bucket/key` — not a provider instance id.
    const rest = value.slice(R2_STORAGE_PREFIX.length);
    return !rest.includes("/");
}

/** Opaque object locator: `r2:{bucket}/{key}` (key may contain `/`). */
export function encodeR2Locator(bucket: string, key: string): string {
    const b = bucket.trim();
    const k = key.trim().replace(/^\/+/, "");
    if (b === "" || k === "") {
        throw new Error("encodeR2Locator: bucket and key are required");
    }
    if (b.includes("/")) {
        throw new Error(`encodeR2Locator: bucket must not contain "/": ${b}`);
    }
    return `${R2_STORAGE_PREFIX}${b}/${k}`;
}

export function parseR2Locator(raw: string): { bucket: string; key: string } | null {
    const value = raw.trim();
    if (!value.startsWith(R2_STORAGE_PREFIX)) {
        return null;
    }
    const rest = value.slice(R2_STORAGE_PREFIX.length);
    const slash = rest.indexOf("/");
    if (slash <= 0 || slash === rest.length - 1) {
        return null;
    }
    const bucket = rest.slice(0, slash);
    const key = rest.slice(slash + 1).replace(/^\/+/, "");
    if (bucket === "" || key === "") {
        return null;
    }
    return { bucket, key };
}

export function isR2ObjectLocator(stored: string | null | undefined): boolean {
    return parseR2Locator(stored ?? "") != null;
}
