export interface RetryOptions {
    attempts?: number;
    baseMs?: number;
    signal?: AbortSignal;
    /** Return true to retry. Default: network-ish / 429 / 5xx. */
    shouldRetry?: (error: unknown, attempt: number) => boolean;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason ?? new Error("aborted"));
            return;
        }
        const timer = setTimeout(resolve, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal?.reason ?? new Error("aborted"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

export function defaultShouldRetry(error: unknown): boolean {
    if (error == null) {
        return false;
    }
    if (typeof error === "object" && error !== null && "status" in error) {
        const status = Number((error as { status: unknown }).status);
        if (status === 408 || status === 429 || (status >= 500 && status <= 599)) {
            return true;
        }
        if (status >= 400 && status < 500) {
            return false;
        }
    }
    const message = error instanceof Error ? error.message : String(error);
    return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket|network|fetch failed|aborted/i.test(message) === false
        ? /timeout|temporar|unavailable|503|502|429/i.test(message)
        : true;
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
    const attempts = Math.max(1, options.attempts ?? 3);
    const baseMs = options.baseMs ?? 500;
    const shouldRetry = options.shouldRetry ?? ((err) => defaultShouldRetry(err));
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        options.signal?.throwIfAborted?.();
        try {
            return await fn(attempt);
        } catch (error) {
            lastError = error;
            if (attempt >= attempts || !shouldRetry(error, attempt)) {
                throw error;
            }
            const jitter = Math.floor(Math.random() * baseMs);
            await sleep(baseMs * 2 ** (attempt - 1) + jitter, options.signal);
        }
    }
    throw lastError;
}
