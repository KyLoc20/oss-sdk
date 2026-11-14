import { access, mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { constants as fsConstants } from "node:fs";

export interface OssSdkTelemetryConfig {
    enabled: boolean;
    dir: string;
    flushSize: number;
    flushMs: number;
    maxBuffer: number;
}

let cached: OssSdkTelemetryConfig | null = null;
let initPromise: Promise<OssSdkTelemetryConfig> | null = null;

function parseOn(raw: string | undefined): boolean {
    const v = (raw ?? "").trim().toLowerCase();
    return v === "true" || v === "1";
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
    if (raw == null || raw.trim() === "") {
        return fallback;
    }
    const n = Number.parseInt(raw.trim(), 10);
    if (!Number.isFinite(n) || n <= 0) {
        return fallback;
    }
    return n;
}

async function probeWritableDir(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    const probe = join(dir, `.oss-sdk-telemetry-probe-${process.pid}-${Date.now()}`);
    await writeFile(probe, "ok", "utf8");
    await unlink(probe);
    await access(dir, fsConstants.W_OK);
}

function disabled(): OssSdkTelemetryConfig {
    return {
        enabled: false,
        dir: "",
        flushSize: 100,
        flushMs: 60_000,
        maxBuffer: 500,
    };
}

/**
 * Resolve telemetry config from env. Safe to call often; validates dir once when enabled.
 * Failures disable telemetry without throwing.
 */
export async function resolveOssSdkTelemetryConfig(): Promise<OssSdkTelemetryConfig> {
    if (cached != null) {
        return cached;
    }
    if (initPromise != null) {
        return initPromise;
    }
    initPromise = (async () => {
        if (!parseOn(process.env.OSS_SDK_TELEMETRY_ON)) {
            cached = disabled();
            return cached;
        }
        const dir = process.env.OSS_SDK_TELEMETRY_DIR?.trim() ?? "";
        if (dir === "") {
            console.warn(
                "[oss-sdk] OSS_SDK_TELEMETRY_ON set but OSS_SDK_TELEMETRY_DIR empty; telemetry disabled",
            );
            cached = disabled();
            return cached;
        }
        try {
            await probeWritableDir(dir);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn(
                `[oss-sdk] OSS_SDK_TELEMETRY_DIR not writable (${dir}): ${message}; telemetry disabled`,
            );
            cached = disabled();
            return cached;
        }
        cached = {
            enabled: true,
            dir,
            flushSize: parsePositiveInt(process.env.OSS_SDK_TELEMETRY_FLUSH_SIZE, 100),
            flushMs: parsePositiveInt(process.env.OSS_SDK_TELEMETRY_FLUSH_MS, 60_000),
            maxBuffer: parsePositiveInt(process.env.OSS_SDK_TELEMETRY_MAX_BUFFER, 500),
        };
        return cached;
    })();
    try {
        return await initPromise;
    } finally {
        initPromise = null;
    }
}

export function isOssSdkTelemetryEnabledSync(): boolean {
    return cached?.enabled === true;
}

/** Test helper. */
export function resetOssSdkTelemetryConfigForTests(): void {
    cached = null;
    initPromise = null;
}
