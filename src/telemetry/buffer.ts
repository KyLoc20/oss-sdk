import type { OssSdkTelemetryEvent } from "./types.js";

export interface OssSdkTelemetryBufferState {
    events: OssSdkTelemetryEvent[];
    dropped: number;
    flushInFlight: boolean;
    lastFlushAt: number;
}

const state: OssSdkTelemetryBufferState = {
    events: [],
    dropped: 0,
    flushInFlight: false,
    lastFlushAt: 0,
};

export function getOssSdkTelemetryBufferState(): OssSdkTelemetryBufferState {
    return state;
}

export function appendOssSdkTelemetryEvent(event: OssSdkTelemetryEvent, maxBuffer: number): void {
    state.events.push(event);
    while (state.events.length > maxBuffer) {
        state.events.shift();
        state.dropped += 1;
    }
}

/** Take up to `count` events for flush (or all if count omitted). */
export function takeOssSdkTelemetryEvents(count?: number): {
    events: OssSdkTelemetryEvent[];
    dropped: number;
} {
    const n = count == null ? state.events.length : Math.min(count, state.events.length);
    const events = state.events.splice(0, n);
    const dropped = state.dropped;
    state.dropped = 0;
    return { events, dropped };
}

export function resetOssSdkTelemetryBufferForTests(): void {
    state.events.length = 0;
    state.dropped = 0;
    state.flushInFlight = false;
    state.lastFlushAt = 0;
}
