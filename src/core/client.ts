import type {
    CheckExistResult,
    ClientCheckExistParams,
    ClientCreateParams,
    ClientDeleteParams,
    ClientGetParams,
    CreateResult,
    GetResult,
    StorageProvider,
} from "../types/storage.types.js";
import {
    clipCostMs,
    markOssSdkTelemetryStart,
    recordOssSdkTelemetryEvent,
} from "../telemetry/record.js";
import { createStorageProviderRegistry, type StorageProviderRegistry } from "./registry.js";

export interface StorageClient {
    readonly registry: StorageProviderRegistry;
    use(idOrKind: string): StorageProvider;
    checkExist(params: ClientCheckExistParams): Promise<CheckExistResult>;
    get(params: ClientGetParams): Promise<GetResult>;
    create(params: ClientCreateParams): Promise<CreateResult>;
    delete(params: ClientDeleteParams): Promise<void>;
}

export interface CreateStorageClientOptions {
    providers?: StorageProvider[];
    registry?: StorageProviderRegistry;
}

function providerIdOf(params: { provider: string }): string {
    return String(params.provider ?? "").trim() || "unknown";
}

function withTelemetry(client: StorageClient): StorageClient {
    return {
        registry: client.registry,
        use(idOrKind) {
            return client.use(idOrKind);
        },
        async checkExist(params) {
            const started = markOssSdkTelemetryStart();
            try {
                const result = await client.checkExist(params);
                await recordOssSdkTelemetryEvent({
                    op: "checkExist",
                    providerId: providerIdOf(params),
                    uniqueName: params.uniqueName,
                    ok: true,
                    costMs: clipCostMs(started),
                    size: typeof result.size === "number" ? result.size : null,
                    resultSummary: `exists=${result.exists}`,
                });
                return result;
            } catch (error) {
                await recordOssSdkTelemetryEvent({
                    op: "checkExist",
                    providerId: providerIdOf(params),
                    uniqueName: params.uniqueName,
                    ok: false,
                    errMessage: error instanceof Error ? error.message : String(error),
                    costMs: clipCostMs(started),
                });
                throw error;
            }
        },
        async get(params) {
            const started = markOssSdkTelemetryStart();
            try {
                const result = await client.get(params);
                await recordOssSdkTelemetryEvent({
                    op: "get",
                    providerId: providerIdOf(params),
                    uniqueName: params.uniqueName,
                    ok: true,
                    costMs: clipCostMs(started),
                    size: result.size,
                    resultSummary: result.destLocator ? `dest=${result.destLocator}` : null,
                });
                return result;
            } catch (error) {
                await recordOssSdkTelemetryEvent({
                    op: "get",
                    providerId: providerIdOf(params),
                    uniqueName: params.uniqueName,
                    ok: false,
                    errMessage: error instanceof Error ? error.message : String(error),
                    costMs: clipCostMs(started),
                });
                throw error;
            }
        },
        async create(params) {
            const started = markOssSdkTelemetryStart();
            try {
                const result = await client.create(params);
                await recordOssSdkTelemetryEvent({
                    op: "create",
                    providerId: providerIdOf(params),
                    uniqueName: params.uniqueName,
                    ok: true,
                    costMs: clipCostMs(started),
                    size: result.size,
                    resultSummary: result.locator ? `locator=${result.locator}` : null,
                });
                return result;
            } catch (error) {
                await recordOssSdkTelemetryEvent({
                    op: "create",
                    providerId: providerIdOf(params),
                    uniqueName: params.uniqueName,
                    ok: false,
                    errMessage: error instanceof Error ? error.message : String(error),
                    costMs: clipCostMs(started),
                });
                throw error;
            }
        },
        async delete(params) {
            const started = markOssSdkTelemetryStart();
            try {
                await client.delete(params);
                await recordOssSdkTelemetryEvent({
                    op: "delete",
                    providerId: providerIdOf(params),
                    uniqueName: params.uniqueName,
                    ok: true,
                    costMs: clipCostMs(started),
                });
            } catch (error) {
                await recordOssSdkTelemetryEvent({
                    op: "delete",
                    providerId: providerIdOf(params),
                    uniqueName: params.uniqueName,
                    ok: false,
                    errMessage: error instanceof Error ? error.message : String(error),
                    costMs: clipCostMs(started),
                });
                throw error;
            }
        },
    };
}

/** Facade over a {@link StorageProviderRegistry}. Auto-wraps with env-gated telemetry ([docs/telemetry.md](../../docs/telemetry.md)). */
export function createStorageClient(options: CreateStorageClientOptions = {}): StorageClient {
    const registry = options.registry ?? createStorageProviderRegistry();
    for (const provider of options.providers ?? []) {
        registry.register(provider);
    }

    const client: StorageClient = {
        registry,
        use(idOrKind) {
            return registry.resolve(idOrKind);
        },
        checkExist(params) {
            const { provider, ...rest } = params;
            return registry.resolve(provider).checkExist(rest);
        },
        get(params) {
            const { provider, ...rest } = params;
            return registry.resolve(provider).get(rest);
        },
        create(params) {
            const { provider, ...rest } = params;
            return registry.resolve(provider).create(rest);
        },
        delete(params) {
            const { provider, ...rest } = params;
            return registry.resolve(provider).delete(rest);
        },
    };

    return withTelemetry(client);
}
