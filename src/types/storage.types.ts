/** Known provider kind ids (also used as registry keys). */
export type StorageProviderKind = "localFs" | "remoteFs" | "r2";

export interface Progress {
    phase: "upload" | "download";
    transferred: number;
    total?: number;
    shardIndex?: number;
    shardCount?: number;
}

export interface CheckExistParams {
    uniqueName: string;
    /** Override default bucket (r2 only). */
    bucket?: string;
    signal?: AbortSignal;
}

export interface CheckExistResult {
    exists: boolean;
    size?: number;
    contentType?: string;
    etag?: string;
    lastModified?: Date;
    /** Retrievable locator when known. */
    locator?: string;
}

export interface GetParams {
    uniqueName: string;
    /**
     * Absolute local file path to write (v1: must be a file path, not a directory).
     * Trust boundary: never pass untrusted user input — arbitrary overwrite risk.
     */
    destLocator: string;
    /** When false (default), refuse if dest already exists as a non-empty file unless resume applies. */
    overwrite?: boolean;
    /** HTTP(S) proxy only; validated scheme. Do not expose to untrusted callers. */
    proxyUrl?: string;
    signal?: AbortSignal;
    /** Parallel Range shards for HTTP downloads. Default provider-specific. */
    concurrency?: number;
    /** Continue from existing dest byte length when server supports Range. Default true. */
    resume?: boolean;
    onProgress?: (p: Progress) => void;
    /** Override default bucket (r2 only). */
    bucket?: string;
}

export interface GetResult {
    uniqueName: string;
    /** Absolute local file path written. */
    destLocator: string;
    size: number;
    contentType?: string;
    etag?: string;
}

export interface CreateParams {
    uniqueName: string;
    /**
     * Local absolute/relative file path, or http(s) URL.
     * Trust boundary: never pass untrusted user input without validation.
     * HTTP URLs are SSRF-checked by default (private/link-local blocked).
     */
    sourceLocator: string;
    contentType?: string;
    /** Overwrite existing object. Default true. */
    upsert?: boolean;
    /** Override default bucket (r2 only). */
    bucket?: string;
    /** HTTP(S) proxy only; validated scheme. Do not expose to untrusted callers. */
    proxyUrl?: string;
    signal?: AbortSignal;
    /** Shard size in bytes for multipart / chunked upload. */
    shardSize?: number;
    concurrency?: number;
    /** Reserved for durable upload sessions; providers may no-op in v1. */
    resume?: boolean;
    onProgress?: (p: Progress) => void;
    metadata?: Record<string, string>;
    /** Allow HTTP sourceLocator to hit private/link-local addresses. Default false. */
    allowPrivateNetwork?: boolean;
}

export interface CreateResult {
    uniqueName: string;
    /**
     * Retrievable locator for later checkExist / get / delete.
     * - localFs: absolute path or public URL
     * - remoteFs: download URL
     * - r2: opaque `r2:{bucket}/{key}`
     */
    locator: string;
    size: number;
    etag?: string;
    contentType?: string;
    meta?: Record<string, unknown>;
}

export interface DeleteParams {
    uniqueName: string;
    /** Override default bucket (r2 only). */
    bucket?: string;
    signal?: AbortSignal;
}

/** Client-level params: same as provider params plus `provider` id or kind. */
export type ClientCheckExistParams = CheckExistParams & { provider: string };
export type ClientGetParams = GetParams & { provider: string };
export type ClientCreateParams = CreateParams & { provider: string };
export type ClientDeleteParams = DeleteParams & { provider: string };

export interface ProviderProbeOk {
    ok: true;
    detail?: Record<string, unknown>;
}

export interface ProviderProbeFail {
    ok: false;
    error: string;
}

export type ProviderProbeResult = ProviderProbeOk | ProviderProbeFail;

/**
 * Unified object-storage backend.
 * `uniqueName` is caller-owned; path providers map it to an object key.
 * r2 also accepts opaque locators `r2:{bucket}/{key}` in place of uniqueName.
 */
export interface StorageProvider {
    readonly kind: StorageProviderKind;
    /**
     * Full instance id, e.g. `fs:windows-storage:HOST`, `fs:149.28.16.125`, `r2:media`.
     */
    readonly id: string;

    checkExist(params: CheckExistParams): Promise<CheckExistResult>;
    get(params: GetParams): Promise<GetResult>;
    create(params: CreateParams): Promise<CreateResult>;
    delete(params: DeleteParams): Promise<void>;
    probe?(): Promise<ProviderProbeResult>;
}

/** Parcel-manager compatible upload adapter (matches target-supabase-sdk StorageAdapter). */
export interface StorageUploadAdapter {
    provider?: string;
    upload(data: ArrayBuffer, pathOrKey: string): Promise<{ url: string }>;
}

export interface CreateUploadAdapterOptions {
    /** Collect rollback handles during multi-chunk upload. */
    tracker?: UploadTracker<unknown>;
}

export interface UploadTracker<THandle> {
    readonly handles: THandle[];
    push(handle: THandle): void;
}

export function createUploadTracker<THandle>(): UploadTracker<THandle> {
    const handles: THandle[] = [];
    return {
        handles,
        push(handle: THandle) {
            handles.push(handle);
        },
    };
}
