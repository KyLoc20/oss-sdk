export { flushOssSdkTelemetry, OSS_SDK_VERSION } from "./flush.js";
export {
    isOssSdkTelemetryEnabledSync,
    resetOssSdkTelemetryConfigForTests,
    resolveOssSdkTelemetryConfig,
} from "./config.js";
export { resetOssSdkTelemetryBufferForTests } from "./buffer.js";
export { clipCostMs, markOssSdkTelemetryStart, recordOssSdkTelemetryEvent } from "./record.js";
export type {
    OssSdkTelemetryEvent,
    OssSdkTelemetryFilePayload,
    OssSdkTelemetryOp,
} from "./types.js";

import { resolveOssSdkTelemetryConfig } from "./config.js";

/** True after successful env validation when telemetry is on. */
export async function isOssSdkTelemetryEnabled(): Promise<boolean> {
    const config = await resolveOssSdkTelemetryConfig();
    return config.enabled;
}
