import { createR2StorageProvider } from "../providers/r2/r2-provider.js";
import {
    clipCostMs,
    markOssSdkTelemetryStart,
    recordOssSdkTelemetryEvent,
} from "../telemetry/record.js";
import { getStorageProviderId } from "./get-storage-provider-id.js";
import type { VerifyStorageProviderParams, VerifyStorageProviderResult } from "./storage-protocol.js";

function requireR2Cred(label: string, value: unknown): string {
    if (typeof value !== "string" || value.trim() === "") {
        throw new Error(`verifyStorageProvider(r2): ${label} is required`);
    }
    return value.trim();
}

async function verifyStorageProviderInner(
    params: VerifyStorageProviderParams,
): Promise<VerifyStorageProviderResult> {
    const protocol = params.protocol;

    if (protocol === "local-fs" || protocol === "remote-fs") {
        return {
            ok: false,
            protocol,
            error: `verifyStorageProvider: protocol "${protocol}" is not implemented yet`,
        };
    }

    if (protocol !== "r2") {
        return {
            ok: false,
            protocol: protocol as VerifyStorageProviderResult["protocol"],
            error: `verifyStorageProvider: unknown protocol "${String(protocol)}"`,
        };
    }

    let providerId: string;
    try {
        providerId = getStorageProviderId({
            protocol: "r2",
            accountId: params.accountId,
            bucket: params.bucket,
        });
    } catch (error) {
        return {
            ok: false,
            protocol: "r2",
            error: error instanceof Error ? error.message : String(error),
        };
    }

    let accessKeyId: string;
    let secretAccessKey: string;
    try {
        accessKeyId = requireR2Cred("accessKeyId", params.accessKeyId);
        secretAccessKey = requireR2Cred("secretAccessKey", params.secretAccessKey);
    } catch (error) {
        return {
            ok: false,
            protocol: "r2",
            providerId,
            error: error instanceof Error ? error.message : String(error),
        };
    }

    const accountId = String(params.accountId).trim();
    const bucket = String(params.bucket).trim();
    const endpoint = typeof params.endpoint === "string" ? params.endpoint.trim() : undefined;
    const region = typeof params.region === "string" && params.region.trim() !== "" ? params.region.trim() : "auto";

    try {
        const provider = createR2StorageProvider({
            id: providerId,
            accountId,
            bucket,
            accessKeyId,
            secretAccessKey,
            region,
            ...(endpoint != null && endpoint !== "" ? { endpoint } : {}),
        });
        const probe = await provider.probe?.();
        if (probe == null) {
            return {
                ok: false,
                protocol: "r2",
                providerId,
                error: "r2 provider has no probe()",
            };
        }
        if (!probe.ok) {
            return {
                ok: false,
                protocol: "r2",
                providerId,
                error: probe.error,
                detail: { bucket, accountId },
            };
        }
        return {
            ok: true,
            protocol: "r2",
            providerId,
            detail: {
                bucket,
                accountId,
                ...(probe.detail != null && typeof probe.detail === "object"
                    ? (probe.detail as Record<string, unknown>)
                    : {}),
            },
        };
    } catch (error) {
        return {
            ok: false,
            protocol: "r2",
            providerId,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/**
 * Check whether a StorageProvider configuration is reachable.
 *
 * Currently only `protocol: "r2"` is implemented (HeadBucket / probe).
 * `local-fs` / `remote-fs` return `{ ok: false, error: "not implemented" }`.
 * Telemetry: docs/telemetry.md (`op: verify`).
 */
export async function verifyStorageProvider(
    params: VerifyStorageProviderParams,
): Promise<VerifyStorageProviderResult> {
    const started = markOssSdkTelemetryStart();
    const result = await verifyStorageProviderInner(params);
    await recordOssSdkTelemetryEvent({
        op: "verify",
        providerId: result.providerId ?? null,
        uniqueName: null,
        ok: result.ok,
        errMessage: result.ok ? null : (result.error ?? "verify failed"),
        costMs: clipCostMs(started),
        resultSummary: `protocol=${params.protocol}`,
    });
    return result;
}
