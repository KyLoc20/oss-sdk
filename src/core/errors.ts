export class StorageError extends Error {
    readonly code: string;
    readonly provider?: string;
    readonly cause?: unknown;

    constructor(message: string, options?: { code?: string; provider?: string; cause?: unknown }) {
        super(message);
        this.name = "StorageError";
        this.code = options?.code ?? "STORAGE_ERROR";
        this.provider = options?.provider;
        this.cause = options?.cause;
    }
}

export class StorageNotFoundError extends StorageError {
    constructor(key: string, provider?: string) {
        super(`Object not found: ${key}`, { code: "NOT_FOUND", provider });
        this.name = "StorageNotFoundError";
    }
}

export class StorageConfigError extends StorageError {
    constructor(message: string, provider?: string) {
        super(message, { code: "CONFIG", provider });
        this.name = "StorageConfigError";
    }
}
