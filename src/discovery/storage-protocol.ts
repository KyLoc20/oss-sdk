/** Wire / discovery protocol ids (hyphenated). Maps to provider kinds. */
export type StorageProtocol = "r2" | "local-fs" | "remote-fs";

export type GetStorageProviderIdParams =
    | {
          protocol: "r2";
          accountId: string;
          bucket: string;
      }
    | {
          protocol: "local-fs";
      }
    | {
          protocol: "remote-fs";
      };

export type VerifyStorageProviderParams =
    | {
          protocol: "r2";
          accountId: string;
          bucket: string;
          accessKeyId: string;
          secretAccessKey: string;
          /** Optional S3 API endpoint override. */
          endpoint?: string;
          region?: string;
      }
    | {
          protocol: "local-fs";
      }
    | {
          protocol: "remote-fs";
      };

export interface VerifyStorageProviderResult {
    ok: boolean;
    protocol: StorageProtocol;
    /** Set when id can be derived (r2). */
    providerId?: string;
    /** Human-readable failure. */
    error?: string;
    /** Optional probe detail (e.g. endpoint). */
    detail?: Record<string, unknown>;
}
