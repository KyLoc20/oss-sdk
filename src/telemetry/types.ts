export type OssSdkTelemetryOp = "checkExist" | "get" | "create" | "delete" | "verify";

export interface OssSdkTelemetryEvent {
    ts: number;
    op: OssSdkTelemetryOp;
    providerId: string | null;
    uniqueName: string | null;
    ok: boolean;
    errMessage: string | null;
    costMs: number;
    size: number | null;
    resultSummary: string | null;
}

export interface OssSdkTelemetryFilePayload {
    flushedAt: number;
    sdkVersion: string;
    droppedBeforeFlush: number;
    events: OssSdkTelemetryEvent[];
}

export const OSS_SDK_TELEMETRY_UNIQUE_NAME_MAX = 256;
export const OSS_SDK_TELEMETRY_ERR_MESSAGE_MAX = 512;
export const OSS_SDK_TELEMETRY_SUMMARY_MAX = 128;
