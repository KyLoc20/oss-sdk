import { open } from "node:fs/promises";
import { basename } from "node:path";
import { normalizeUniqueName } from "../../core/body.js";
import { StorageConfigError, StorageError, StorageNotFoundError } from "../../core/errors.js";
import { createFetchWithProxy, downloadUrlToFile } from "../../core/http.js";
import { assertSourceFilePath, isHttpUrl } from "../../core/path-io.js";
import { withRetry } from "../../core/retry.js";
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

const DEFAULT_API_ROOT = "/v0/upload/file";
const DEFAULT_CHUNK_THRESHOLD_BYTES = 8 * 1024 * 1024;
const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;

export interface RemoteFsStorageProviderOptions {
    /** Peer origin, e.g. `https://host:3600` (no trailing slash). */
    baseUrl: string;
    /**
     * Full provider id or suffix.
     * Examples: `fs:149.28.16.125`, `149.28.16.125`.
     */
    id: string;
    /**
     * Sandbox API root on the peer.
     * Default `/v0/upload/file`; TEMP uses `/v0/upload/temp`.
     */
    apiRoot?: string;
    /** Switch to chunked upload above this size. Default 8 MiB. */
    chunkThresholdBytes?: number;
    /** Preferred chunk size sent on init. Default 4 MiB. */
    chunkSize?: number;
    /** Default proxy for outbound HTTP. */
    proxyUrl?: string;
    /** Optional custom fetch (defaults to global fetch). */
    fetch?: typeof fetch;
}

export interface RemoteFsStorageProvider extends StorageProvider {
    readonly kind: "remoteFs";
    readonly baseUrl: string;
    readonly apiRoot: string;
}

function stripTrailingSlash(url: string): string {
    return url.replace(/\/+$/, "");
}

function normalizeApiRoot(apiRoot: string): string {
    const trimmed = apiRoot.trim() || DEFAULT_API_ROOT;
    const withLeading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
    return withLeading.replace(/\/+$/, "") || DEFAULT_API_ROOT;
}

function parentDir(key: string): string | null {
    const idx = key.lastIndexOf("/");
    if (idx <= 0) {
        return null;
    }
    return key.slice(0, idx);
}

function uploadedRelativePath(data: Record<string, unknown>): string {
    const files = data.files;
    if (Array.isArray(files) && files.length > 0) {
        const first = files[0] as Record<string, unknown>;
        if (typeof first.relativePath === "string" && first.relativePath !== "") {
            return first.relativePath.replace(/\\/g, "/");
        }
    }
    throw new Error("Upload response missing files[0].relativePath");
}

/** Remote filesystem provider over upload-service sandbox HTTP APIs. */
export function createRemoteFsStorageProvider(input: RemoteFsStorageProviderOptions): RemoteFsStorageProvider {
    const baseUrl = stripTrailingSlash(input.baseUrl?.trim() ?? "");
    if (baseUrl === "") {
        throw new StorageConfigError("RemoteFsStorageProviderOptions.baseUrl is required", "remoteFs");
    }
    if (!input.id?.trim()) {
        throw new StorageConfigError("RemoteFsStorageProviderOptions.id is required", "remoteFs");
    }

    const id = buildProviderId("remoteFs", input.id.trim());
    const apiRoot = normalizeApiRoot(input.apiRoot ?? DEFAULT_API_ROOT);
    const chunkThreshold = input.chunkThresholdBytes ?? DEFAULT_CHUNK_THRESHOLD_BYTES;
    const preferredChunkSize = input.chunkSize ?? DEFAULT_CHUNK_SIZE;
    const defaultProxy = input.proxyUrl;
    const baseFetch: typeof fetch = input.fetch ?? fetch.bind(globalThis);

    function downloadUrl(objectKey: string): string {
        const url = new URL(`${apiRoot}/download`, `${baseUrl}/`);
        url.searchParams.set("path", objectKey);
        return url.toString();
    }

    async function resolveFetch(proxyUrl?: string): Promise<typeof fetch> {
        return createFetchWithProxy(proxyUrl ?? defaultProxy, baseFetch);
    }

    async function apiJson(
        doFetch: typeof fetch,
        path: string,
        init?: RequestInit,
    ): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
        const res = await doFetch(`${baseUrl}${path}`, init);
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        return { ok: res.ok, status: res.status, data };
    }

    async function ensureParentDir(doFetch: typeof fetch, objectKey: string): Promise<void> {
        const parent = parentDir(objectKey);
        if (parent == null) {
            return;
        }
        const { ok, status, data } = await apiJson(doFetch, `${apiRoot}/mkdir`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ relativePath: parent }),
        });
        if (ok || status === 201) {
            return;
        }
        const message = typeof data.error === "string" ? data.error : `mkdir HTTP ${status}`;
        if (/exist/i.test(message)) {
            return;
        }
        throw new Error(`mkdir ${parent}: ${message}`);
    }

    async function renameRemote(doFetch: typeof fetch, from: string, to: string): Promise<void> {
        if (from === to) {
            return;
        }
        const { ok, status, data } = await apiJson(doFetch, `${apiRoot}/rename`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ from, to }),
        });
        if (ok) {
            return;
        }
        const message = typeof data.error === "string" ? data.error : `rename HTTP ${status}`;
        if (/already exists/i.test(message)) {
            return;
        }
        throw new Error(`${from} → ${to}: ${message}`);
    }

    async function headObject(
        doFetch: typeof fetch,
        objectKey: string,
        signal?: AbortSignal,
    ): Promise<CheckExistResult> {
        const url = downloadUrl(objectKey);
        const head = await doFetch(url, { method: "HEAD", signal });
        if (head.ok) {
            const len = head.headers.get("content-length");
            return {
                exists: true,
                size: len != null ? Number(len) : undefined,
                contentType: head.headers.get("content-type") ?? undefined,
                etag: head.headers.get("etag") ?? undefined,
                locator: url,
            };
        }
        const probe = await doFetch(url, { method: "GET", headers: { Range: "bytes=0-0" }, signal });
        if (probe.status === 404) {
            return { exists: false };
        }
        if (probe.ok || probe.status === 206) {
            const contentRange = probe.headers.get("content-range");
            const match = contentRange?.match(/\/(\d+)\s*$/);
            await probe.body?.cancel?.();
            return {
                exists: true,
                size: match ? Number(match[1]) : undefined,
                contentType: probe.headers.get("content-type") ?? undefined,
                etag: probe.headers.get("etag") ?? undefined,
                locator: url,
            };
        }
        if (head.status === 404 || probe.status === 404) {
            return { exists: false };
        }
        throw new StorageError(`RemoteFs checkExist HTTP ${probe.status}`, {
            code: "CHECK_FAILED",
            provider: id,
        });
    }

    async function uploadMultipartFile(
        doFetch: typeof fetch,
        objectKey: string,
        sourcePath: string,
        fileName: string,
        signal?: AbortSignal,
    ): Promise<string> {
        const form = new FormData();
        const blob = await open(sourcePath).then(async (fh) => {
            try {
                const buf = await fh.readFile();
                return new Blob([buf]);
            } finally {
                await fh.close();
            }
        });
        form.append("files", blob, fileName);
        const url = new URL(`${apiRoot}/upload`, `${baseUrl}/`);
        url.searchParams.set("relativePath", objectKey);
        const res = await doFetch(url.toString(), { method: "POST", body: form, signal });
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) {
            const message = typeof data.error === "string" ? data.error : `HTTP ${res.status}`;
            throw new Error(message);
        }
        return uploadedRelativePath(data);
    }

    async function uploadChunkedFile(
        doFetch: typeof fetch,
        objectKey: string,
        sourcePath: string,
        fileSize: number,
        options: CreateParams,
    ): Promise<string> {
        const shardSize = options.shardSize ?? preferredChunkSize;
        const concurrency = Math.max(1, options.concurrency ?? 3);

        const init = await apiJson(doFetch, `${apiRoot}/upload/chunk/init`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                relativePath: objectKey,
                fileSize,
                chunkSize: shardSize,
            }),
            signal: options.signal,
        });
        if (!init.ok) {
            const message = typeof init.data.error === "string" ? init.data.error : `init HTTP ${init.status}`;
            throw new Error(message);
        }

        const uploadId = String(init.data.uploadId ?? "");
        const chunkSize = Number(init.data.chunkSize ?? shardSize);
        const totalParts = Number(init.data.totalParts ?? Math.ceil(fileSize / chunkSize));
        if (uploadId === "") {
            throw new Error("chunk init missing uploadId");
        }

        let transferred = 0;
        const fh = await open(sourcePath, "r");
        try {
            let nextPart = 0;
            async function worker(): Promise<void> {
                for (;;) {
                    const partIndex = nextPart;
                    nextPart += 1;
                    if (partIndex >= totalParts) {
                        return;
                    }
                    const start = partIndex * chunkSize;
                    const end = Math.min(start + chunkSize, fileSize);
                    const length = end - start;
                    const buf = Buffer.alloc(length);
                    await fh.read(buf, 0, length, start);

                    await withRetry(
                        async () => {
                            const partUrl = `${baseUrl}${apiRoot}/upload/chunk/${encodeURIComponent(uploadId)}/${partIndex}`;
                            const res = await doFetch(partUrl, {
                                method: "PUT",
                                headers: { "Content-Type": "application/octet-stream" },
                                body: buf,
                                signal: options.signal,
                            });
                            if (!res.ok) {
                                const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
                                const message =
                                    typeof body.error === "string"
                                        ? body.error
                                        : `part ${partIndex} HTTP ${res.status}`;
                                const err = new Error(message) as Error & { status: number };
                                err.status = res.status;
                                throw err;
                            }
                        },
                        { signal: options.signal },
                    );

                    transferred += length;
                    options.onProgress?.({
                        phase: "upload",
                        transferred,
                        total: fileSize,
                        shardIndex: partIndex,
                        shardCount: totalParts,
                    });
                }
            }

            await Promise.all(Array.from({ length: Math.min(concurrency, totalParts) }, () => worker()));

            const complete = await apiJson(
                doFetch,
                `${apiRoot}/upload/chunk/${encodeURIComponent(uploadId)}/complete`,
                { method: "POST", signal: options.signal },
            );
            if (!complete.ok) {
                const message =
                    typeof complete.data.error === "string"
                        ? complete.data.error
                        : `complete HTTP ${complete.status}`;
                throw new Error(message);
            }
            return uploadedRelativePath(complete.data);
        } catch (error) {
            await doFetch(`${baseUrl}${apiRoot}/upload/chunk/${encodeURIComponent(uploadId)}`, {
                method: "DELETE",
            }).catch(() => undefined);
            throw error;
        } finally {
            await fh.close();
        }
    }

    return {
        kind: "remoteFs",
        id,
        baseUrl,
        apiRoot,

        async checkExist(params: CheckExistParams): Promise<CheckExistResult> {
            const objectKey = normalizeUniqueName(params.uniqueName);
            try {
                const doFetch = await resolveFetch();
                return await headObject(doFetch, objectKey, params.signal);
            } catch (error) {
                if (error instanceof StorageError) {
                    throw error;
                }
                throw new StorageError(`RemoteFs checkExist failed for ${objectKey}`, {
                    code: "CHECK_FAILED",
                    provider: id,
                    cause: error,
                });
            }
        },

        async get(params: GetParams): Promise<GetResult> {
            const objectKey = normalizeUniqueName(params.uniqueName);
            try {
                const result = await downloadUrlToFile({
                    url: downloadUrl(objectKey),
                    destLocator: params.destLocator,
                    fetchImpl: baseFetch,
                    proxyUrl: params.proxyUrl ?? defaultProxy,
                    overwrite: params.overwrite,
                    resume: params.resume,
                    concurrency: params.concurrency,
                    signal: params.signal,
                    onProgress: params.onProgress,
                    provider: id,
                    uniqueName: objectKey,
                    // Trusted peer (configured baseUrl); may be a private LAN host.
                    allowPrivateNetwork: true,
                });
                return {
                    uniqueName: objectKey,
                    destLocator: result.destLocator,
                    size: result.size,
                    contentType: result.contentType,
                    etag: result.etag,
                };
            } catch (error) {
                if (error instanceof StorageNotFoundError) {
                    throw new StorageNotFoundError(objectKey, id);
                }
                if (error instanceof StorageError) {
                    throw error;
                }
                throw new StorageError(`RemoteFs get failed for ${objectKey}`, {
                    code: "GET_FAILED",
                    provider: id,
                    cause: error,
                });
            }
        },

        async create(params: CreateParams): Promise<CreateResult> {
            const objectKey = normalizeUniqueName(params.uniqueName);
            try {
                const doFetch = await resolveFetch(params.proxyUrl);

                if (params.upsert === false) {
                    const existing = await headObject(doFetch, objectKey, params.signal);
                    if (existing.exists) {
                        throw new StorageError(`Object already exists: ${objectKey}`, {
                            code: "ALREADY_EXISTS",
                            provider: id,
                        });
                    }
                }

                let sourcePath: string;
                let fileSize: number;
                let tempCleanup: (() => Promise<void>) | undefined;

                if (isHttpUrl(params.sourceLocator)) {
                    const { mkdtemp, rm } = await import("node:fs/promises");
                    const { join } = await import("node:path");
                    const { tmpdir } = await import("node:os");
                    const dir = await mkdtemp(join(tmpdir(), "oss-sdk-"));
                    const tempPath = join(dir, basename(objectKey) || "upload.bin");
                    const downloaded = await downloadUrlToFile({
                        url: params.sourceLocator.trim(),
                        destLocator: tempPath,
                        fetchImpl: doFetch,
                        overwrite: true,
                        resume: false,
                        signal: params.signal,
                        provider: id,
                        allowPrivateNetwork: params.allowPrivateNetwork === true,
                    });
                    sourcePath = downloaded.destLocator;
                    fileSize = downloaded.size;
                    tempCleanup = async () => {
                        await rm(dir, { recursive: true, force: true });
                    };
                } else {
                    const source = await assertSourceFilePath(params.sourceLocator);
                    sourcePath = source.path;
                    fileSize = source.size;
                }

                try {
                    await ensureParentDir(doFetch, objectKey);
                    const staging =
                        fileSize > chunkThreshold
                            ? await uploadChunkedFile(doFetch, objectKey, sourcePath, fileSize, params)
                            : await uploadMultipartFile(
                                  doFetch,
                                  objectKey,
                                  sourcePath,
                                  basename(objectKey) || "upload.bin",
                                  params.signal,
                              );
                    await renameRemote(doFetch, staging, objectKey);
                    params.onProgress?.({ phase: "upload", transferred: fileSize, total: fileSize });
                    return {
                        uniqueName: objectKey,
                        locator: downloadUrl(objectKey),
                        size: fileSize,
                        contentType: params.contentType,
                    };
                } finally {
                    await tempCleanup?.();
                }
            } catch (error) {
                if (error instanceof StorageError) {
                    throw error;
                }
                throw new StorageError(`RemoteFs create failed for ${objectKey}`, {
                    code: "CREATE_FAILED",
                    provider: id,
                    cause: error,
                });
            }
        },

        async delete(params: DeleteParams): Promise<void> {
            const objectKey = normalizeUniqueName(params.uniqueName);
            try {
                const doFetch = await resolveFetch();
                const { ok, status, data } = await apiJson(doFetch, `${apiRoot}/delete`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ relativePaths: [objectKey] }),
                    signal: params.signal,
                });
                if (!ok) {
                    const message = typeof data.error === "string" ? data.error : `delete HTTP ${status}`;
                    throw new Error(message);
                }
            } catch (error) {
                throw new StorageError(`RemoteFs delete failed for ${objectKey}`, {
                    code: "DELETE_FAILED",
                    provider: id,
                    cause: error,
                });
            }
        },

        async probe() {
            try {
                const doFetch = await resolveFetch();
                const res = await doFetch(`${baseUrl}${apiRoot}/root`);
                if (!res.ok) {
                    return { ok: false as const, error: `root HTTP ${res.status}` };
                }
                const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
                return { ok: true as const, detail: { baseUrl, apiRoot, root: data } };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return { ok: false as const, error: message };
            }
        },
    };
}

/** @deprecated Prefer provider.create({ uniqueName, sourceLocator }). */
export async function putRemoteFileFromPath(
    provider: RemoteFsStorageProvider,
    uniqueName: string,
    sourcePath: string,
    options?: Omit<CreateParams, "uniqueName" | "sourceLocator">,
): Promise<CreateResult> {
    return provider.create({ uniqueName, sourceLocator: sourcePath, ...options });
}
