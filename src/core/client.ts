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

/** Facade over a {@link StorageProviderRegistry}. */
export function createStorageClient(options: CreateStorageClientOptions = {}): StorageClient {
    const registry = options.registry ?? createStorageProviderRegistry();
    for (const provider of options.providers ?? []) {
        registry.register(provider);
    }

    return {
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
}
