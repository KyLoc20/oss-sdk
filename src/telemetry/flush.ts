import { createHash } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveOssSdkTelemetryConfig } from "./config.js";
import { getOssSdkTelemetryBufferState, takeOssSdkTelemetryEvents } from "./buffer.js";
import type { OssSdkTelemetryFilePayload } from "./types.js";

/** Keep in sync with package.json version. */
export const OSS_SDK_VERSION = "0.1.0";

function hash6(content: string): string {
    return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 6);
}

/**
 * Best-effort flush of buffered events to OSS_SDK_TELEMETRY_DIR.
 * Failures are swallowed; events taken for this flush are not re-queued.
 */
export async function flushOssSdkTelemetry(): Promise<{ flushed: number; path: string | null }> {
    const config = await resolveOssSdkTelemetryConfig();
    if (!config.enabled) {
        return { flushed: 0, path: null };
    }

    const state = getOssSdkTelemetryBufferState();
    if (state.flushInFlight || state.events.length === 0) {
        return { flushed: 0, path: null };
    }

    state.flushInFlight = true;
    try {
        const flushTs = Date.now();
        const { events, dropped } = takeOssSdkTelemetryEvents();
        if (events.length === 0) {
            return { flushed: 0, path: null };
        }

        const payload: OssSdkTelemetryFilePayload = {
            flushedAt: flushTs,
            sdkVersion: OSS_SDK_VERSION,
            droppedBeforeFlush: dropped,
            events,
        };
        const body = `${JSON.stringify(payload)}\n`;
        const name = `${flushTs}.${hash6(body)}.json`;
        const finalPath = join(config.dir, name);
        const tmpPath = `${finalPath}.tmp`;
        try {
            await writeFile(tmpPath, body, "utf8");
            await rename(tmpPath, finalPath);
            state.lastFlushAt = flushTs;
            return { flushed: events.length, path: finalPath };
        } catch {
            // best-effort: drop this batch
            return { flushed: 0, path: null };
        }
    } finally {
        state.flushInFlight = false;
    }
}

let timerStarted = false;

export function ensureOssSdkTelemetryFlushTimer(): void {
    if (timerStarted) {
        return;
    }
    timerStarted = true;
    const tick = async () => {
        try {
            const config = await resolveOssSdkTelemetryConfig();
            if (!config.enabled) {
                return;
            }
            const state = getOssSdkTelemetryBufferState();
            if (state.events.length === 0 || state.flushInFlight) {
                return;
            }
            // Never flush on first tick just because lastFlushAt is 0 — wait flushMs
            // from the oldest buffered event (or from last successful flush).
            const since =
                state.lastFlushAt > 0
                    ? Date.now() - state.lastFlushAt
                    : Date.now() - (state.events[0]?.ts ?? Date.now());
            if (since >= config.flushMs) {
                await flushOssSdkTelemetry();
            }
        } catch {
            /* ignore */
        }
    };
    setInterval(() => {
        void tick();
    }, 1000).unref?.();

    const onExit = () => {
        void flushOssSdkTelemetry();
    };
    process.once("beforeExit", onExit);
}
