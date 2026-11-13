/**
 * oss-sdk — multi-provider object storage.
 *
 * Default entry: types, core, remoteFs, r2.
 * For local filesystem provider, import `oss-sdk/node`.
 *
 * Note: create/get use local file paths and require Node.js.
 */

export * from "./types/index.js";
export * from "./core/index.js";
export * from "./adapters/index.js";

export {
    createRemoteFsStorageProvider,
    putRemoteFileFromPath,
    type RemoteFsStorageProvider,
    type RemoteFsStorageProviderOptions,
} from "./providers/remote-fs/index.js";

export {
    createR2StorageProvider,
    type R2StorageProvider,
    type R2StorageProviderOptions,
} from "./providers/r2/index.js";
