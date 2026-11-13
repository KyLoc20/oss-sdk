import { StorageError } from "./errors.js";

/** Normalize caller uniqueName into a path-style object key. */
export function normalizeUniqueName(uniqueName: string): string {
    const trimmed = uniqueName.trim().replace(/\\/g, "/");
    if (trimmed === "" || trimmed === "/") {
        throw new StorageError("uniqueName must be non-empty", { code: "CONFIG" });
    }
    const key = trimmed.replace(/^\/+/, "");
    const segments = key.split("/");
    if (segments.some((s) => s === ".." || s === "")) {
        throw new StorageError(`uniqueName must not contain empty or ".." segments: ${uniqueName}`, {
            code: "CONFIG",
        });
    }
    return key;
}

/** @deprecated Use {@link normalizeUniqueName}. */
export function normalizeKey(key: string): string {
    return normalizeUniqueName(key);
}
