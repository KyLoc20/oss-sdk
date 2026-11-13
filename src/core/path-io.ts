import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, open, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { StorageError } from "./errors.js";

/** v1: dest must be an absolute file path (not a directory). */
export function assertDestFilePath(destLocator: string): string {
    const trimmed = destLocator.trim();
    if (trimmed === "") {
        throw new StorageError("destLocator must be a non-empty absolute file path", { code: "CONFIG" });
    }
    if (!isAbsolute(trimmed)) {
        throw new StorageError(`destLocator must be an absolute file path (got "${destLocator}")`, {
            code: "CONFIG",
        });
    }
    if (trimmed.endsWith("/") || trimmed.endsWith("\\")) {
        throw new StorageError(`destLocator must be a file path, not a directory: ${destLocator}`, {
            code: "CONFIG",
        });
    }
    return resolve(trimmed);
}

export function isHttpUrl(locator: string): boolean {
    return /^https?:\/\//i.test(locator.trim());
}

export async function assertSourceFilePath(sourceLocator: string): Promise<{ path: string; size: number }> {
    const trimmed = sourceLocator.trim();
    if (trimmed === "" || isHttpUrl(trimmed)) {
        throw new StorageError(`sourceLocator is not a local file path: ${sourceLocator}`, { code: "CONFIG" });
    }
    const absolute = isAbsolute(trimmed) ? resolve(trimmed) : resolve(trimmed);
    try {
        const info = await stat(absolute);
        if (!info.isFile()) {
            throw new StorageError(`sourceLocator is not a file: ${absolute}`, { code: "CONFIG" });
        }
        return { path: absolute, size: info.size };
    } catch (error) {
        if (error instanceof StorageError) {
            throw error;
        }
        throw new StorageError(`Cannot read sourceLocator: ${absolute}`, {
            code: "CONFIG",
            cause: error,
        });
    }
}

export async function ensureParentDir(filePath: string): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
}

export async function prepareDestFile(
    destLocator: string,
    options: { overwrite?: boolean; resume?: boolean },
): Promise<{ dest: string; existingSize: number }> {
    const dest = assertDestFilePath(destLocator);
    await ensureParentDir(dest);
    let existingSize = 0;
    try {
        const info = await stat(dest);
        if (info.isDirectory()) {
            throw new StorageError(`destLocator points to a directory: ${dest}`, { code: "CONFIG" });
        }
        existingSize = info.size;
        if (existingSize > 0 && options.resume !== false && options.overwrite !== true) {
            return { dest, existingSize };
        }
        if (existingSize > 0 && options.overwrite !== true && options.resume === false) {
            throw new StorageError(`Destination already exists: ${dest}`, { code: "ALREADY_EXISTS" });
        }
        if (options.overwrite === true) {
            existingSize = 0;
        }
    } catch (error) {
        if (error instanceof StorageError) {
            throw error;
        }
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code !== "ENOENT") {
            throw error;
        }
    }
    return { dest, existingSize };
}

export async function copyFileStream(sourcePath: string, destPath: string): Promise<void> {
    await ensureParentDir(destPath);
    await pipeline(createReadStream(sourcePath), createWriteStream(destPath));
}

export async function writeStreamToFile(
    readable: NodeJS.ReadableStream,
    destPath: string,
    options?: { start?: number },
): Promise<void> {
    await ensureParentDir(destPath);
    const start = options?.start ?? 0;
    const write = createWriteStream(destPath, start > 0 ? { flags: "r+", start } : undefined);
    if (start > 0) {
        // Ensure file is large enough / exists for r+
        await access(destPath);
    }
    await pipeline(readable, write);
}

export async function truncateFile(destPath: string, size: number): Promise<void> {
    const handle = await open(destPath, "r+");
    try {
        await handle.truncate(size);
    } finally {
        await handle.close();
    }
}
