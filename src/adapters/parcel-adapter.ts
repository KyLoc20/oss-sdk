import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
    CreateResult,
    CreateUploadAdapterOptions,
    StorageProvider,
    StorageUploadAdapter,
    UploadTracker,
} from "../types/storage.types.js";

/**
 * Adapt a {@link StorageProvider} to the parcel-manager StorageAdapter shape
 * used by target-supabase-sdk (`upload(data, pathOrKey) => { url }`).
 *
 * Writes a temp file then calls {@link StorageProvider.create}.
 */
export function createParcelUploadAdapter(
    provider: StorageProvider,
    options: CreateUploadAdapterOptions = {},
): StorageUploadAdapter {
    const tracker = options.tracker as UploadTracker<CreateResult> | undefined;
    return {
        provider: provider.kind,
        async upload(data, pathOrKey) {
            const dir = await mkdtemp(join(tmpdir(), "oss-sdk-parcel-"));
            const tempPath = join(dir, "blob.bin");
            try {
                await writeFile(tempPath, Buffer.from(data));
                const result = await provider.create({
                    uniqueName: pathOrKey,
                    sourceLocator: tempPath,
                });
                tracker?.push(result);
                return { url: result.locator };
            } finally {
                await rm(dir, { recursive: true, force: true });
            }
        },
    };
}

/** Best-effort rollback using provider.delete on tracked create results. */
export async function rollbackTrackedPuts(
    provider: StorageProvider,
    handles: unknown[],
): Promise<{ deleted: number; failed: number }> {
    let deleted = 0;
    let failed = 0;
    for (const handle of handles) {
        const created = handle as CreateResult;
        const target = created?.locator || created?.uniqueName;
        if (target == null || target === "") {
            continue;
        }
        try {
            await provider.delete({ uniqueName: target });
            deleted += 1;
        } catch {
            failed += 1;
        }
    }
    return { deleted, failed };
}
