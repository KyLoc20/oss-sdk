import { appendOssSdkTelemetryEvent, getOssSdkTelemetryBufferState } from "./buffer.js";
import { ensureOssSdkTelemetryFlushTimer, flushOssSdkTelemetry } from "./flush.js";
import { resolveOssSdkTelemetryConfig } from "./config.js";
import {
    OSS_SDK_TELEMETRY_ERR_MESSAGE_MAX,
    OSS_SDK_TELEMETRY_SUMMARY_MAX,
    OSS_SDK_TELEMETRY_UNIQUE_NAME_MAX,
    type OssSdkTelemetryEvent,
    type OssSdkTelemetryOp,
} from "./types.js";

function truncate(value: string | null | undefined, max: number): string | null {
    if (value == null) {
        return null;
    }
    const trimmed = value.trim();
    if (trimmed === "") {
        return null;
    }
    return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}

function nowMs(): number {
    return typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();
}

export function clipCostMs(started: number): number {
    const end =
        typeof performance !== "undefined" && typeof performance.now === "function"
            ? performance.now()
            : Date.now();
    return Math.round((end - started) * 10) / 10;
}

export function markOssSdkTelemetryStart(): number {
    return nowMs();
}

export async function recordOssSdkTelemetryEvent(partial: {
    op: OssSdkTelemetryOp;
    providerId?: string | null;
    uniqueName?: string | null;
    ok: boolean;
    errMessage?: string | null;
    costMs: number;
    size?: number | null;
    resultSummary?: string | null;
}): Promise<void> {
    const config = await resolveOssSdkTelemetryConfig();
    if (!config.enabled) {
        return;
    }
    ensureOssSdkTelemetryFlushTimer();

    const event: OssSdkTelemetryEvent = {
        ts: Date.now(),
        op: partial.op,
        providerId: truncate(partial.providerId ?? null, 256),
        uniqueName: truncate(partial.uniqueName ?? null, OSS_SDK_TELEMETRY_UNIQUE_NAME_MAX),
        ok: partial.ok,
        errMessage: partial.ok
            ? null
            : truncate(partial.errMessage ?? null, OSS_SDK_TELEMETRY_ERR_MESSAGE_MAX),
        costMs: partial.costMs,
        size: typeof partial.size === "number" ? partial.size : null,
        resultSummary: truncate(partial.resultSummary ?? null, OSS_SDK_TELEMETRY_SUMMARY_MAX),
    };
    appendOssSdkTelemetryEvent(event, config.maxBuffer);

    const state = getOssSdkTelemetryBufferState();
    if (state.events.length >= config.flushSize) {
        void flushOssSdkTelemetry();
    }
}
