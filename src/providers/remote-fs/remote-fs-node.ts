import type { CreateParams, CreateResult } from "../../types/storage.types.js";
import type { RemoteFsStorageProvider } from "./remote-fs-provider.js";

/**
 * @deprecated Prefer `provider.create({ uniqueName, sourceLocator })`.
 */
export async function putRemoteFileFromPath(
    provider: RemoteFsStorageProvider,
    uniqueName: string,
    sourcePath: string,
    options?: Omit<CreateParams, "uniqueName" | "sourceLocator">,
): Promise<CreateResult> {
    return provider.create({ uniqueName, sourceLocator: sourcePath, ...options });
}
