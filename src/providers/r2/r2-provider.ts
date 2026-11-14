import { createWriteStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
    AbortMultipartUploadCommand,
    CompleteMultipartUploadCommand,
    CreateBucketCommand,
    CreateMultipartUploadCommand,
    DeleteBucketCommand,
    DeleteObjectCommand,
    GetObjectCommand,
    HeadBucketCommand,
    HeadObjectCommand,
    ListBucketsCommand,
    ListMultipartUploadsCommand,
    PutObjectCommand,
    S3Client,
    UploadPartCommand,
    type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { normalizeUniqueName } from "../../core/body.js";
import { StorageConfigError, StorageError, StorageNotFoundError } from "../../core/errors.js";
import { downloadUrlToFile } from "../../core/http.js";
import { assertSourceFilePath, isHttpUrl, prepareDestFile } from "../../core/path-io.js";
import { withRetry } from "../../core/retry.js";
import { buildProviderId, encodeR2Locator, parseR2Locator } from "../../types/provider-id.js";
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

const DEFAULT_SHARD_THRESHOLD = 8 * 1024 * 1024;
const DEFAULT_SHARD_SIZE = 8 * 1024 * 1024;

export interface R2StorageProviderOptions {
    /**
     * Full provider id or suffix.
     * Examples: `r2:media`, `media`.
     * Must not look like an object locator (`r2:bucket/key`).
     */
    id: string;
    /** Cloudflare account id (used to build default endpoint when endpoint omitted). */
    accountId?: string;
    /** S3 API endpoint. Default `https://{accountId}.r2.cloudflarestorage.com`. */
    endpoint?: string;
    accessKeyId: string;
    secretAccessKey: string;
    /** Default bucket for operations when not overridden / not parsed from locator. */
    bucket: string;
    region?: string;
    /** Switch to multipart above this size. Default 8 MiB. */
    shardThresholdBytes?: number;
    /** Multipart part size. Default 8 MiB (S3 minimum is 5 MiB except last part). */
    shardSize?: number;
    /** Optional preconfigured client (tests). */
    client?: S3Client;
}

export interface R2StorageProvider extends StorageProvider {
    readonly kind: "r2";
    readonly bucket: string;
    readonly client: S3Client;
    /** Optional bucket helpers (not part of the unified contract). */
    createBucket(bucket?: string): Promise<void>;
    deleteBucket(bucket?: string): Promise<void>;
    headBucket(bucket?: string): Promise<boolean>;
    listBuckets(): Promise<string[]>;
}

function resolveEndpoint(input: R2StorageProviderOptions): string {
    if (input.endpoint?.trim()) {
        return input.endpoint.trim().replace(/\/+$/, "");
    }
    const accountId = input.accountId?.trim();
    if (!accountId) {
        throw new StorageConfigError("R2StorageProviderOptions.endpoint or accountId is required", "r2");
    }
    return `https://${accountId}.r2.cloudflarestorage.com`;
}

function resolveObjectRef(
    uniqueNameOrLocator: string,
    defaultBucket: string,
    optionsBucket?: string,
): { bucket: string; key: string; locator: string } {
    const parsed = parseR2Locator(uniqueNameOrLocator);
    if (parsed != null) {
        return {
            bucket: optionsBucket ?? parsed.bucket,
            key: parsed.key,
            locator: encodeR2Locator(optionsBucket ?? parsed.bucket, parsed.key),
        };
    }
    const key = normalizeUniqueName(uniqueNameOrLocator);
    const bucket = optionsBucket ?? defaultBucket;
    return { bucket, key, locator: encodeR2Locator(bucket, key) };
}

/** Drop orphaned multipart sessions (e.g. process killed mid-upload) before starting a new one. */
async function abortOngoingMultipartUploadsForKey(
    client: S3Client,
    bucket: string,
    key: string,
    signal?: AbortSignal,
): Promise<void> {
    let keyMarker: string | undefined;
    let uploadIdMarker: string | undefined;
    for (;;) {
        const listed = await client.send(
            new ListMultipartUploadsCommand({
                Bucket: bucket,
                Prefix: key,
                KeyMarker: keyMarker,
                UploadIdMarker: uploadIdMarker,
            }),
            { abortSignal: signal },
        );
        for (const upload of listed.Uploads ?? []) {
            if (upload.Key === key && upload.UploadId) {
                await client
                    .send(
                        new AbortMultipartUploadCommand({
                            Bucket: bucket,
                            Key: key,
                            UploadId: upload.UploadId,
                        }),
                        { abortSignal: signal },
                    )
                    .catch(() => undefined);
            }
        }
        if (!listed.IsTruncated) {
            return;
        }
        keyMarker = listed.NextKeyMarker;
        uploadIdMarker = listed.NextUploadIdMarker;
    }
}

/** Cloudflare R2 provider via S3-compatible API. Locator: `r2:{bucket}/{key}`. */
export function createR2StorageProvider(input: R2StorageProviderOptions): R2StorageProvider {
    if (!input.id?.trim()) {
        throw new StorageConfigError("R2StorageProviderOptions.id is required", "r2");
    }
    if (!input.accessKeyId?.trim() || !input.secretAccessKey?.trim()) {
        throw new StorageConfigError("R2 accessKeyId and secretAccessKey are required", "r2");
    }
    const bucket = input.bucket?.trim();
    if (!bucket) {
        throw new StorageConfigError("R2StorageProviderOptions.bucket is required", "r2");
    }
    if (bucket.includes("/")) {
        throw new StorageConfigError("R2 bucket name must not contain '/'", "r2");
    }

    const id = buildProviderId("r2", input.id.trim());
    if (id.slice("r2:".length).includes("/")) {
        throw new StorageConfigError(
            `R2 provider id must not contain '/' after prefix (got "${id}"). Object locators use r2:{{bucket}}/{{key}}.`,
            "r2",
        );
    }

    const shardThreshold = input.shardThresholdBytes ?? DEFAULT_SHARD_THRESHOLD;
    const defaultShardSize = input.shardSize ?? DEFAULT_SHARD_SIZE;

    const clientConfig: S3ClientConfig = {
        region: input.region?.trim() || "auto",
        endpoint: resolveEndpoint(input),
        credentials: {
            accessKeyId: input.accessKeyId.trim(),
            secretAccessKey: input.secretAccessKey.trim(),
        },
        forcePathStyle: true,
    };

    const client = input.client ?? new S3Client(clientConfig);

    return {
        kind: "r2",
        id,
        bucket,
        client,

        async checkExist(params: CheckExistParams): Promise<CheckExistResult> {
            const ref = resolveObjectRef(params.uniqueName, bucket, params.bucket);
            try {
                const out = await client.send(
                    new HeadObjectCommand({ Bucket: ref.bucket, Key: ref.key }),
                    { abortSignal: params.signal },
                );
                return {
                    exists: true,
                    size: out.ContentLength,
                    contentType: out.ContentType,
                    etag: out.ETag,
                    lastModified: out.LastModified,
                    locator: ref.locator,
                };
            } catch (error) {
                const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
                const name = (error as { name?: string })?.name;
                if (status === 404 || name === "NotFound" || name === "NoSuchKey") {
                    return { exists: false };
                }
                throw new StorageError(`R2 checkExist failed for ${ref.locator}`, {
                    code: "CHECK_FAILED",
                    provider: id,
                    cause: error,
                });
            }
        },

        async get(params: GetParams): Promise<GetResult> {
            const ref = resolveObjectRef(params.uniqueName, bucket, params.bucket);
            try {
                const head = await client.send(
                    new HeadObjectCommand({ Bucket: ref.bucket, Key: ref.key }),
                    { abortSignal: params.signal },
                );
                const total = head.ContentLength ?? 0;
                const { dest, existingSize } = await prepareDestFile(params.destLocator, {
                    overwrite: params.overwrite,
                    resume: params.resume,
                });

                if (
                    existingSize > 0 &&
                    params.resume !== false &&
                    total > 0 &&
                    existingSize === total &&
                    params.overwrite !== true
                ) {
                    return {
                        uniqueName: ref.key,
                        destLocator: dest,
                        size: total,
                        contentType: head.ContentType,
                        etag: head.ETag,
                    };
                }

                if (existingSize > total && total > 0) {
                    throw new StorageError(`Local file larger than remote object (${existingSize} > ${total})`, {
                        code: "RESUME_INVALID",
                        provider: id,
                    });
                }

                const start =
                    existingSize > 0 && params.resume !== false && params.overwrite !== true && total > existingSize
                        ? existingSize
                        : 0;

                const range = start > 0 ? `bytes=${start}-` : undefined;
                const out = await withRetry(
                    async () =>
                        client.send(
                            new GetObjectCommand({
                                Bucket: ref.bucket,
                                Key: ref.key,
                                Range: range,
                            }),
                            { abortSignal: params.signal },
                        ),
                    { signal: params.signal },
                );

                const body = out.Body;
                if (body == null) {
                    throw new StorageError("R2 GetObject returned empty body", { code: "GET_FAILED", provider: id });
                }

                const nodeStream =
                    typeof (body as { transformToWebStream?: () => ReadableStream }).transformToWebStream === "function"
                        ? Readable.fromWeb(
                              (body as { transformToWebStream: () => ReadableStream }).transformToWebStream() as import("stream/web").ReadableStream,
                          )
                        : (body as NodeJS.ReadableStream);

                let transferred = start;
                nodeStream.on("data", (chunk: Buffer | Uint8Array) => {
                    transferred += chunk.byteLength;
                    params.onProgress?.({
                        phase: "download",
                        transferred,
                        total: total || undefined,
                    });
                });

                const write = createWriteStream(dest, start > 0 ? { flags: "r+", start } : undefined);
                await pipeline(nodeStream, write);

                const info = await stat(dest);
                return {
                    uniqueName: ref.key,
                    destLocator: dest,
                    size: info.size,
                    contentType: out.ContentType ?? head.ContentType,
                    etag: out.ETag ?? head.ETag,
                };
            } catch (error) {
                if (error instanceof StorageError) {
                    throw error;
                }
                const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
                const name = (error as { name?: string })?.name;
                if (status === 404 || name === "NoSuchKey" || name === "NotFound") {
                    throw new StorageNotFoundError(ref.locator, id);
                }
                throw new StorageError(`R2 get failed for ${ref.locator}`, {
                    code: "GET_FAILED",
                    provider: id,
                    cause: error,
                });
            }
        },

        async create(params: CreateParams): Promise<CreateResult> {
            const ref = resolveObjectRef(params.uniqueName, bucket, params.bucket);
            try {
                if (params.upsert === false) {
                    const existing = await this.checkExist({
                        uniqueName: ref.locator,
                        bucket: ref.bucket,
                        signal: params.signal,
                    });
                    if (existing.exists) {
                        throw new StorageError(`Object already exists: ${ref.locator}`, {
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
                    const dir = await mkdtemp(join(tmpdir(), "oss-sdk-r2-"));
                    const tempPath = join(dir, basename(ref.key) || "upload.bin");
                    const downloaded = await downloadUrlToFile({
                        url: params.sourceLocator.trim(),
                        destLocator: tempPath,
                        overwrite: true,
                        resume: false,
                        proxyUrl: params.proxyUrl,
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
                    const shardSize = Math.max(5 * 1024 * 1024, params.shardSize ?? defaultShardSize);
                    const concurrency = Math.max(1, params.concurrency ?? 3);

                    if (fileSize <= shardThreshold) {
                        const fh = await open(sourcePath, "r");
                        try {
                            const body = await fh.readFile();
                            const out = await withRetry(
                                async () =>
                                    client.send(
                                        new PutObjectCommand({
                                            Bucket: ref.bucket,
                                            Key: ref.key,
                                            Body: body,
                                            ContentType: params.contentType,
                                            Metadata: params.metadata,
                                        }),
                                        { abortSignal: params.signal },
                                    ),
                                { signal: params.signal },
                            );
                            params.onProgress?.({ phase: "upload", transferred: fileSize, total: fileSize });
                            return {
                                uniqueName: ref.key,
                                locator: ref.locator,
                                size: fileSize,
                                etag: out.ETag,
                                contentType: params.contentType,
                            };
                        } finally {
                            await fh.close();
                        }
                    }

                    if (params.upsert !== false) {
                        await abortOngoingMultipartUploadsForKey(
                            client,
                            ref.bucket,
                            ref.key,
                            params.signal,
                        );
                    }

                    const created = await client.send(
                        new CreateMultipartUploadCommand({
                            Bucket: ref.bucket,
                            Key: ref.key,
                            ContentType: params.contentType,
                            Metadata: params.metadata,
                        }),
                        { abortSignal: params.signal },
                    );
                    const uploadId = created.UploadId;
                    if (!uploadId) {
                        throw new Error("CreateMultipartUpload missing UploadId");
                    }

                    const totalParts = Math.ceil(fileSize / shardSize);
                    const parts: { ETag: string; PartNumber: number }[] = new Array(totalParts);
                    let transferred = 0;
                    const fh = await open(sourcePath, "r");

                    try {
                        let nextPart = 0;
                        async function worker(): Promise<void> {
                            for (;;) {
                                const index = nextPart;
                                nextPart += 1;
                                if (index >= totalParts) {
                                    return;
                                }
                                const partNumber = index + 1;
                                const start = index * shardSize;
                                const length = Math.min(shardSize, fileSize - start);
                                const buf = Buffer.alloc(length);
                                await fh.read(buf, 0, length, start);

                                const uploaded = await withRetry(
                                    async () =>
                                        client.send(
                                            new UploadPartCommand({
                                                Bucket: ref.bucket,
                                                Key: ref.key,
                                                UploadId: uploadId,
                                                PartNumber: partNumber,
                                                Body: buf,
                                            }),
                                            { abortSignal: params.signal },
                                        ),
                                    { signal: params.signal },
                                );
                                if (!uploaded.ETag) {
                                    throw new Error(`UploadPart ${partNumber} missing ETag`);
                                }
                                parts[index] = { ETag: uploaded.ETag, PartNumber: partNumber };
                                transferred += length;
                                params.onProgress?.({
                                    phase: "upload",
                                    transferred,
                                    total: fileSize,
                                    shardIndex: index,
                                    shardCount: totalParts,
                                });
                            }
                        }

                        await Promise.all(Array.from({ length: Math.min(concurrency, totalParts) }, () => worker()));

                        const completed = await client.send(
                            new CompleteMultipartUploadCommand({
                                Bucket: ref.bucket,
                                Key: ref.key,
                                UploadId: uploadId,
                                MultipartUpload: { Parts: parts },
                            }),
                            { abortSignal: params.signal },
                        );

                        return {
                            uniqueName: ref.key,
                            locator: ref.locator,
                            size: fileSize,
                            etag: completed.ETag,
                            contentType: params.contentType,
                        };
                    } catch (error) {
                        await client
                            .send(
                                new AbortMultipartUploadCommand({
                                    Bucket: ref.bucket,
                                    Key: ref.key,
                                    UploadId: uploadId,
                                }),
                            )
                            .catch(() => undefined);
                        throw error;
                    } finally {
                        await fh.close();
                    }
                } finally {
                    await tempCleanup?.();
                }
            } catch (error) {
                if (error instanceof StorageError) {
                    throw error;
                }
                throw new StorageError(`R2 create failed for ${ref.locator}`, {
                    code: "CREATE_FAILED",
                    provider: id,
                    cause: error,
                });
            }
        },

        async delete(params: DeleteParams): Promise<void> {
            const ref = resolveObjectRef(params.uniqueName, bucket, params.bucket);
            try {
                await client.send(
                    new DeleteObjectCommand({ Bucket: ref.bucket, Key: ref.key }),
                    { abortSignal: params.signal },
                );
            } catch (error) {
                throw new StorageError(`R2 delete failed for ${ref.locator}`, {
                    code: "DELETE_FAILED",
                    provider: id,
                    cause: error,
                });
            }
        },

        async createBucket(name = bucket): Promise<void> {
            await client.send(new CreateBucketCommand({ Bucket: name }));
        },

        async deleteBucket(name = bucket): Promise<void> {
            await client.send(new DeleteBucketCommand({ Bucket: name }));
        },

        async headBucket(name = bucket): Promise<boolean> {
            try {
                await client.send(new HeadBucketCommand({ Bucket: name }));
                return true;
            } catch {
                return false;
            }
        },

        async listBuckets(): Promise<string[]> {
            const out = await client.send(new ListBucketsCommand({}));
            return (out.Buckets ?? []).map((b) => b.Name!).filter(Boolean);
        },

        async probe() {
            try {
                const ok = await this.headBucket(bucket);
                return ok
                    ? { ok: true as const, detail: { bucket, endpoint: resolveEndpoint(input) } }
                    : { ok: false as const, error: `bucket not reachable: ${bucket}` };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return { ok: false as const, error: message };
            }
        },
    };
}
