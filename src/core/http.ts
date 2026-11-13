import { createWriteStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { Progress } from "../types/storage.types.js";
import { StorageError, StorageNotFoundError } from "./errors.js";
import { ensureParentDir, prepareDestFile } from "./path-io.js";
import { withRetry } from "./retry.js";
import {
    assertSafeHttpUrl,
    assertSafeProxyUrl,
    fetchWithSsrfGuard,
    type SafeHttpUrlOptions,
} from "./ssrf.js";

export async function createFetchWithProxy(
    proxyUrl: string | undefined,
    baseFetch: typeof fetch = fetch.bind(globalThis),
): Promise<typeof fetch> {
    if (proxyUrl == null || proxyUrl.trim() === "") {
        return baseFetch;
    }
    const safeProxy = assertSafeProxyUrl(proxyUrl);
    try {
        const undici = await import("undici");
        const agent = new undici.ProxyAgent(safeProxy);
        return (input: RequestInfo | URL, init?: RequestInit) =>
            undici.fetch(input as Parameters<typeof undici.fetch>[0], {
                ...(init as object),
                dispatcher: agent,
            }) as unknown as Promise<Response>;
    } catch (error) {
        throw new StorageError(
            `proxyUrl requires optional peer "undici" (failed to load): ${error instanceof Error ? error.message : String(error)}`,
            { code: "CONFIG", cause: error },
        );
    }
}

export interface DownloadToFileOptions extends SafeHttpUrlOptions {
    url: string;
    destLocator: string;
    fetchImpl?: typeof fetch;
    proxyUrl?: string;
    overwrite?: boolean;
    resume?: boolean;
    concurrency?: number;
    signal?: AbortSignal;
    onProgress?: (p: Progress) => void;
    /** Label for errors. */
    provider?: string;
    uniqueName?: string;
    headers?: HeadersInit;
    /**
     * Disable SSRF checks (private IPs / metadata). Default false.
     * Only set when the URL is fully trusted by the integrator.
     */
    allowPrivateNetwork?: boolean;
}

export interface DownloadToFileResult {
    destLocator: string;
    size: number;
    contentType?: string;
    etag?: string;
}

async function guardedFetch(
    doFetch: typeof fetch,
    url: string,
    init: RequestInit | undefined,
    ssrf: SafeHttpUrlOptions,
): Promise<Response> {
    return fetchWithSsrfGuard(doFetch, url, init, ssrf);
}

async function headOrProbe(
    doFetch: typeof fetch,
    url: string,
    signal: AbortSignal | undefined,
    headers: HeadersInit | undefined,
    ssrf: SafeHttpUrlOptions,
): Promise<{ size?: number; contentType?: string; etag?: string; acceptRanges: boolean }> {
    const head = await guardedFetch(doFetch, url, { method: "HEAD", signal, headers }, ssrf);
    if (head.ok) {
        const len = head.headers.get("content-length");
        return {
            size: len != null ? Number(len) : undefined,
            contentType: head.headers.get("content-type") ?? undefined,
            etag: head.headers.get("etag") ?? undefined,
            acceptRanges: /bytes/i.test(head.headers.get("accept-ranges") ?? ""),
        };
    }
    const probe = await guardedFetch(
        doFetch,
        url,
        {
            method: "GET",
            headers: { ...(headers as Record<string, string>), Range: "bytes=0-0" },
            signal,
        },
        ssrf,
    );
    if (probe.status === 404) {
        throw new StorageNotFoundError(url);
    }
    if (!(probe.ok || probe.status === 206)) {
        throw new StorageError(`Probe failed HTTP ${probe.status}`, { code: "GET_FAILED" });
    }
    const contentRange = probe.headers.get("content-range");
    const match = contentRange?.match(/\/(\d+)\s*$/);
    await probe.body?.cancel?.();
    return {
        size: match ? Number(match[1]) : undefined,
        contentType: probe.headers.get("content-type") ?? undefined,
        etag: probe.headers.get("etag") ?? undefined,
        acceptRanges: probe.status === 206 || /bytes/i.test(probe.headers.get("accept-ranges") ?? ""),
    };
}

async function downloadSingleStream(
    doFetch: typeof fetch,
    url: string,
    dest: string,
    options: {
        start?: number;
        signal?: AbortSignal;
        headers?: HeadersInit;
        onProgress?: (p: Progress) => void;
        total?: number;
        ssrf: SafeHttpUrlOptions;
    },
): Promise<void> {
    const start = options.start ?? 0;
    const headers: Record<string, string> = { ...(options.headers as Record<string, string>) };
    if (start > 0) {
        headers.Range = `bytes=${start}-`;
    }
    const res = await withRetry(
        async () => {
            const response = await guardedFetch(
                doFetch,
                url,
                { method: "GET", headers, signal: options.signal },
                options.ssrf,
            );
            if (response.status === 404) {
                throw new StorageNotFoundError(url);
            }
            if (start > 0 && response.status !== 206 && response.status !== 200) {
                const err = new StorageError(`Resume download HTTP ${response.status}`, {
                    code: "GET_FAILED",
                });
                (err as StorageError & { status: number }).status = response.status;
                throw err;
            }
            if (!response.ok && response.status !== 206) {
                const err = new StorageError(`Download HTTP ${response.status}`, { code: "GET_FAILED" });
                (err as StorageError & { status: number }).status = response.status;
                throw err;
            }
            return response;
        },
        { signal: options.signal },
    );

    if (start > 0 && res.status === 200) {
        await ensureParentDir(dest);
    }

    const body = res.body;
    if (body == null) {
        throw new StorageError("Download response missing body", { code: "GET_FAILED" });
    }

    await ensureParentDir(dest);
    const writeFlags = start > 0 && res.status === 206 ? { flags: "r+" as const, start } : undefined;
    if (start > 0 && res.status === 206) {
        await open(dest, "r+").then((h) => h.close());
    }

    let transferred = start;
    const nodeReadable = Readable.fromWeb(body as import("stream/web").ReadableStream);
    nodeReadable.on("data", (chunk: Buffer | Uint8Array) => {
        transferred += chunk.byteLength;
        options.onProgress?.({
            phase: "download",
            transferred,
            total: options.total,
        });
    });

    const writeStream = createWriteStream(dest, writeFlags);
    await pipeline(nodeReadable, writeStream);
}

/**
 * Download URL to an absolute local file path.
 * Applies SSRF protection by default (block private/link-local/metadata targets).
 */
export async function downloadUrlToFile(options: DownloadToFileOptions): Promise<DownloadToFileResult> {
    const ssrf: SafeHttpUrlOptions = {
        allowPrivateNetwork: options.allowPrivateNetwork === true,
        maxRedirects: options.maxRedirects,
    };
    await assertSafeHttpUrl(options.url, ssrf);

    const doFetch = await createFetchWithProxy(options.proxyUrl, options.fetchImpl ?? fetch.bind(globalThis));
    const meta = await headOrProbe(doFetch, options.url, options.signal, options.headers, ssrf);
    const { dest, existingSize } = await prepareDestFile(options.destLocator, {
        overwrite: options.overwrite,
        resume: options.resume,
    });

    if (
        meta.size != null &&
        existingSize > 0 &&
        options.resume !== false &&
        existingSize === meta.size &&
        options.overwrite !== true
    ) {
        return {
            destLocator: dest,
            size: meta.size,
            contentType: meta.contentType,
            etag: meta.etag,
        };
    }

    if (meta.size != null && existingSize > meta.size) {
        throw new StorageError(`Local file larger than remote object (${existingSize} > ${meta.size})`, {
            code: "RESUME_INVALID",
            provider: options.provider,
        });
    }

    let start = 0;
    if (existingSize > 0 && options.resume !== false && meta.acceptRanges && options.overwrite !== true) {
        start = existingSize;
    } else if (existingSize > 0 && options.overwrite === true) {
        start = 0;
    } else if (existingSize > 0 && !meta.acceptRanges && options.resume !== false) {
        start = 0;
    }

    const concurrency = options.concurrency ?? 1;
    const canShard =
        concurrency > 1 &&
        meta.acceptRanges &&
        meta.size != null &&
        meta.size > 0 &&
        start === 0 &&
        options.overwrite !== false;

    if (!canShard) {
        await downloadSingleStream(doFetch, options.url, dest, {
            start,
            signal: options.signal,
            headers: options.headers,
            onProgress: options.onProgress,
            total: meta.size,
            ssrf,
        });
        const info = await stat(dest);
        return {
            destLocator: dest,
            size: info.size,
            contentType: meta.contentType,
            etag: meta.etag,
        };
    }

    const total = meta.size!;
    const shardCount = concurrency;
    const shardSize = Math.ceil(total / shardCount);
    await ensureParentDir(dest);
    const handle = await open(dest, "w");
    await handle.truncate(total);
    await handle.close();

    let transferred = 0;
    const report = (n: number) => {
        transferred += n;
        options.onProgress?.({ phase: "download", transferred, total, shardCount });
    };

    await Promise.all(
        Array.from({ length: shardCount }, async (_, shardIndex) => {
            const from = shardIndex * shardSize;
            const to = Math.min(total - 1, from + shardSize - 1);
            if (from >= total) {
                return;
            }
            await withRetry(
                async () => {
                    const res = await guardedFetch(
                        doFetch,
                        options.url,
                        {
                            method: "GET",
                            headers: {
                                ...(options.headers as Record<string, string>),
                                Range: `bytes=${from}-${to}`,
                            },
                            signal: options.signal,
                        },
                        ssrf,
                    );
                    if (res.status !== 206 && res.status !== 200) {
                        const err = new StorageError(`Shard ${shardIndex} HTTP ${res.status}`, {
                            code: "GET_FAILED",
                            provider: options.provider,
                        });
                        (err as StorageError & { status: number }).status = res.status;
                        throw err;
                    }
                    const buf = Buffer.from(await res.arrayBuffer());
                    const fh = await open(dest, "r+");
                    try {
                        await fh.write(buf, 0, buf.byteLength, from);
                    } finally {
                        await fh.close();
                    }
                    report(buf.byteLength);
                    options.onProgress?.({
                        phase: "download",
                        transferred,
                        total,
                        shardIndex,
                        shardCount,
                    });
                },
                { signal: options.signal },
            );
        }),
    );

    return {
        destLocator: dest,
        size: total,
        contentType: meta.contentType,
        etag: meta.etag,
    };
}
