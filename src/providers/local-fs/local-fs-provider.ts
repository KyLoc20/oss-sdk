import { access, lstat, mkdir, realpath, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { normalizeUniqueName } from "../../core/body.js";
import { StorageConfigError, StorageError, StorageNotFoundError } from "../../core/errors.js";
import { downloadUrlToFile } from "../../core/http.js";
import {
    assertSourceFilePath,
    copyFileStream,
    isHttpUrl,
    prepareDestFile,
} from "../../core/path-io.js";
import { buildProviderId } from "../../types/provider-id.js";
import type {
    CheckExistParams,
    CheckExistResult,
    CreateParams,
    CreateResult,
    DeleteParams,
    GetParams,
    GetResult,
    StorageProvider,
} from "../../types/storage.types.js";

export interface LocalFsStorageProviderOptions {
    /** Absolute root directory for objects. */
    rootDir: string;
    /**
     * Full provider id or suffix.
     * Examples: `fs:windows-storage:HOST`, `windows-storage:HOST`.
     */
    id: string;
    /** Optional HTTP base that maps keys to downloadable URLs. */
    publicBaseUrl?: string;
    /**
     * When false (default), reject paths whose symlink chain escapes rootDir.
     */
    allowSymlinksOutsideRoot?: boolean;
}

export interface LocalFsStorageProvider extends StorageProvider {
    readonly kind: "localFs";
    readonly rootDir: string;
    resolvePath(uniqueName: string): string;
    objectLocator(uniqueName: string): string;
}

function assertInsideRoot(rootDir: string, absolutePath: string, providerId: string): void {
    const root = resolve(rootDir);
    const absolute = resolve(absolutePath);
    const rel = relative(root, absolute);
    if (rel === "" || (!rel.startsWith("..") && !rel.split(sep).includes(".."))) {
        return;
    }
    throw new StorageError(`Path escapes storage root: ${absolutePath}`, {
        code: "PATH_ESCAPE",
        provider: providerId,
    });
}

/** Ensure each path segment's realpath stays under root (blocks symlink escape). */
async function assertNoSymlinkEscape(
    rootDir: string,
    absolutePath: string,
    providerId: string,
): Promise<void> {
    const realRoot = await realpath(rootDir);
    assertInsideRoot(realRoot, absolutePath, providerId);

    const rel = relative(rootDir, absolutePath);
    if (rel.startsWith("..")) {
        throw new StorageError(`Path escapes storage root: ${absolutePath}`, {
            code: "PATH_ESCAPE",
            provider: providerId,
        });
    }

    let current = rootDir;
    const parts = rel.split(sep).filter((p) => p && p !== ".");
    for (const part of parts) {
        current = join(current, part);
        try {
            const st = await lstat(current);
            if (st.isSymbolicLink()) {
                const real = await realpath(current);
                assertInsideRoot(realRoot, real, providerId);
            }
        } catch (error) {
            const code = (error as NodeJS.ErrnoException)?.code;
            if (code === "ENOENT") {
                // Creating a new leaf — nearest existing ancestor already checked.
                break;
            }
            throw error;
        }
    }

    try {
        const realTarget = await realpath(absolutePath);
        assertInsideRoot(realRoot, realTarget, providerId);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code !== "ENOENT") {
            throw error;
        }
    }
}

/** Local filesystem provider (Node only). Ids use `fs:` prefix. */
export function createLocalFsStorageProvider(input: LocalFsStorageProviderOptions): LocalFsStorageProvider {
    const rootDir = resolve(input.rootDir.trim());
    if (rootDir === "") {
        throw new StorageConfigError("LocalFsStorageProviderOptions.rootDir is required", "localFs");
    }
    const id = buildProviderId("localFs", input.id.trim());
    const publicBase = input.publicBaseUrl?.replace(/\/$/, "");
    const allowSymlinksOutsideRoot = input.allowSymlinksOutsideRoot === true;

    function resolvePath(uniqueName: string): string {
        const objectKey = normalizeUniqueName(uniqueName);
        const absolute = resolve(rootDir, objectKey);
        assertInsideRoot(rootDir, absolute, id);
        return absolute;
    }

    async function resolvePathSafe(uniqueName: string): Promise<string> {
        const absolute = resolvePath(uniqueName);
        if (!allowSymlinksOutsideRoot) {
            await assertNoSymlinkEscape(rootDir, absolute, id);
        }
        return absolute;
    }

    function objectLocator(uniqueName: string): string {
        const objectKey = normalizeUniqueName(uniqueName);
        if (publicBase) {
            return `${publicBase}/${objectKey.split("/").map(encodeURIComponent).join("/")}`;
        }
        return resolvePath(objectKey);
    }

    return {
        kind: "localFs",
        id,
        rootDir,
        resolvePath,
        objectLocator,

        async checkExist(params: CheckExistParams): Promise<CheckExistResult> {
            const objectKey = normalizeUniqueName(params.uniqueName);
            const absolute = await resolvePathSafe(objectKey);
            try {
                const info = await stat(absolute);
                if (!info.isFile()) {
                    return { exists: false };
                }
                return {
                    exists: true,
                    size: info.size,
                    lastModified: info.mtime,
                    locator: objectLocator(objectKey),
                };
            } catch (error) {
                const code = (error as NodeJS.ErrnoException)?.code;
                if (code === "ENOENT") {
                    return { exists: false };
                }
                throw new StorageError(`LocalFs checkExist failed for ${objectKey}`, {
                    code: "CHECK_FAILED",
                    provider: id,
                    cause: error,
                });
            }
        },

        async get(params: GetParams): Promise<GetResult> {
            const objectKey = normalizeUniqueName(params.uniqueName);
            const absolute = await resolvePathSafe(objectKey);
            try {
                const info = await stat(absolute);
                if (!info.isFile()) {
                    throw new StorageNotFoundError(objectKey, id);
                }
                const { dest, existingSize } = await prepareDestFile(params.destLocator, {
                    overwrite: params.overwrite,
                    resume: params.resume,
                });
                if (
                    existingSize > 0 &&
                    params.resume !== false &&
                    existingSize === info.size &&
                    params.overwrite !== true
                ) {
                    params.onProgress?.({ phase: "download", transferred: info.size, total: info.size });
                    return {
                        uniqueName: objectKey,
                        destLocator: dest,
                        size: info.size,
                    };
                }
                await copyFileStream(absolute, dest);
                params.onProgress?.({ phase: "download", transferred: info.size, total: info.size });
                return {
                    uniqueName: objectKey,
                    destLocator: dest,
                    size: info.size,
                };
            } catch (error) {
                if (error instanceof StorageError) {
                    throw error;
                }
                const code = (error as NodeJS.ErrnoException)?.code;
                if (code === "ENOENT") {
                    throw new StorageNotFoundError(objectKey, id);
                }
                throw new StorageError(`LocalFs get failed for ${objectKey}`, {
                    code: "GET_FAILED",
                    provider: id,
                    cause: error,
                });
            }
        },

        async create(params: CreateParams): Promise<CreateResult> {
            const objectKey = normalizeUniqueName(params.uniqueName);
            const absolute = await resolvePathSafe(objectKey);
            try {
                if (params.upsert === false) {
                    try {
                        await access(absolute);
                        throw new StorageError(`Object already exists: ${objectKey}`, {
                            code: "ALREADY_EXISTS",
                            provider: id,
                        });
                    } catch (error) {
                        if (error instanceof StorageError) {
                            throw error;
                        }
                    }
                }

                await mkdir(dirname(absolute), { recursive: true });

                let size: number;
                if (isHttpUrl(params.sourceLocator)) {
                    const downloaded = await downloadUrlToFile({
                        url: params.sourceLocator.trim(),
                        destLocator: absolute,
                        overwrite: true,
                        resume: false,
                        proxyUrl: params.proxyUrl,
                        signal: params.signal,
                        onProgress: params.onProgress
                            ? (p) => params.onProgress?.({ ...p, phase: "upload" })
                            : undefined,
                        provider: id,
                        uniqueName: objectKey,
                        allowPrivateNetwork: params.allowPrivateNetwork === true,
                    });
                    size = downloaded.size;
                } else {
                    const source = await assertSourceFilePath(params.sourceLocator);
                    await copyFileStream(source.path, absolute);
                    size = source.size;
                    params.onProgress?.({ phase: "upload", transferred: size, total: size });
                }

                return {
                    uniqueName: objectKey,
                    locator: objectLocator(objectKey),
                    size,
                    contentType: params.contentType,
                };
            } catch (error) {
                if (error instanceof StorageError) {
                    throw error;
                }
                throw new StorageError(`LocalFs create failed for ${objectKey}`, {
                    code: "CREATE_FAILED",
                    provider: id,
                    cause: error,
                });
            }
        },

        async delete(params: DeleteParams): Promise<void> {
            const objectKey = normalizeUniqueName(params.uniqueName);
            const absolute = await resolvePathSafe(objectKey);
            try {
                await rm(absolute, { force: true });
            } catch (error) {
                throw new StorageError(`LocalFs delete failed for ${objectKey}`, {
                    code: "DELETE_FAILED",
                    provider: id,
                    cause: error,
                });
            }
        },

        async probe() {
            try {
                await access(rootDir);
                return { ok: true as const, detail: { rootDir } };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return { ok: false as const, error: message };
            }
        },
    };
}

/** @deprecated Prefer provider.create({ uniqueName, sourceLocator }). */
export async function putLocalFileFromPath(
    provider: LocalFsStorageProvider,
    uniqueName: string,
    sourcePath: string,
    options?: Omit<CreateParams, "uniqueName" | "sourceLocator">,
): Promise<CreateResult> {
    return provider.create({ uniqueName, sourceLocator: sourcePath, ...options });
}
