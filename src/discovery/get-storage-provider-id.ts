import { R2_STORAGE_PREFIX } from "../types/provider-id.js";
import type { GetStorageProviderIdParams } from "./storage-protocol.js";

function requireR2Field(label: string, value: unknown): string {
    if (typeof value !== "string" || value.trim() === "") {
        throw new Error(`getStorageProviderId(r2): ${label} is required`);
    }
    const trimmed = value.trim();
    if (trimmed.includes("/") || trimmed.includes(":")) {
        throw new Error(`getStorageProviderId(r2): ${label} must not contain ":" or "/" (got "${value}")`);
    }
    return trimmed;
}

/**
 * Build the service-wide StorageProvider id from protocol + protocol-specific fields.
 *
 * - `r2` → `r2:{accountId}:{bucket}`
 * - `local-fs` / `remote-fs` → not implemented yet (throws)
 */
export function getStorageProviderId(params: GetStorageProviderIdParams): string {
    const protocol = params.protocol;
    if (protocol === "r2") {
        const accountId = requireR2Field("accountId", params.accountId);
        const bucket = requireR2Field("bucket", params.bucket);
        return `${R2_STORAGE_PREFIX}${accountId}:${bucket}`;
    }
    if (protocol === "local-fs" || protocol === "remote-fs") {
        throw new Error(`getStorageProviderId: protocol "${protocol}" is not implemented yet`);
    }
    throw new Error(`getStorageProviderId: unknown protocol "${String(protocol)}"`);
}
