# oss-sdk protocol

> **Maintenance rule:** If you change the `StorageProvider` contract, provider kind / id, uniqueName / locator format, remoteFs HTTP paths or semantics, or error codes, **update this document**. The source of truth is `src/types/` and each provider.

---

## 1. Goals and scope

This SDK gives one API for object storage on many backends. It supports resume, concurrency, retry, proxy, and sharding. The public API is `checkExist` / `get` / `create` / `delete`, plus discovery helpers `getStorageProviderId` / `verifyStorageProvider`.

| Kind | Meaning | Runtime |
|------|---------|---------|
| `localFs` | Local sandbox directory (Node `fs`) | `oss-sdk/node` |
| `remoteFs` | Peer upload-service sandbox HTTP API | Main entry |
| `r2` | Cloudflare R2 (S3-compatible) | Main entry |

**Not supported yet:** `telegram`, and a shared Bucket abstraction. The r2 provider can expose bucket helper methods.

---

## 2. Terms

| Term | Meaning |
|------|---------|
| **provider** | A registered storage instance (`kind` + full `id`) |
| **uniqueName** | Caller-unique name; path providers map it to an object key |
| **locator** | Lookup string: absolute local path, HTTP URL, or opaque `r2:{bucket}/{key}` |

For `get`, **destLocator (v1) must be an absolute file path** (not a directory).

### 2.1 Trust boundary (security)

| Input | Rule |
|-------|------|
| `uniqueName` | Do not allow `..` or empty segments. localFs also checks the root and rejects symlink escape by default. |
| `sourceLocator` (local path) | **Do not** pass untrusted user input (arbitrary file read). |
| `sourceLocator` (http/s) | Default **SSRF protection** (reject private / link-local / metadata; follow redirects and re-check). Set `allowPrivateNetwork: true` to disable. |
| `destLocator` | **Do not** pass untrusted user input (arbitrary file write). |
| `proxyUrl` | Allow only `http:` / `https:`. Do not expose this to untrusted callers. |

The `example/` demo server binds to `127.0.0.1` by default. To use R2 keys from `.env`, set `EXAMPLE_ALLOW_R2=1`. `useEnvCredentials` must be set to true. Then endpoint and keys always come from `.env`.

---

## 3. Provider ID

| Family | Prefix | Example | kind |
|--------|--------|---------|------|
| `fs` | `fs:` | `fs:windows-storage:HOST`, `fs:149.28.16.125` | `localFs` or `remoteFs` |
| `r2` | `r2:` | **`r2:{accountId}:{bucket}`** (service-wide; **must not** contain `/`) | `r2` |

- `localFs` and `remoteFs` share the `fs:` prefix. The factory sets the kind.
- Object locator `r2:{bucket}/{key}` **is not** a provider id (it contains `/`).
- `accountId` and `bucket` segments must not contain `:` or `/`.

Helpers: `buildProviderId`, `parseProviderId`, `encodeR2Locator` / `parseR2Locator`, **`getStorageProviderId`**, **`verifyStorageProvider`**.

### 3.1 `getStorageProviderId` / `verifyStorageProvider`

| API | Role |
|-----|------|
| `getStorageProviderId({ protocol, … })` | Build a unified `StorageProviderId` from protocol fields |
| `verifyStorageProvider({ protocol, … })` | Check if the config is reachable; returns `{ ok, providerId?, error?, detail? }` |

`protocol`: `'r2' | 'local-fs' | 'remote-fs'` (discovery layer uses hyphens).

| protocol | getStorageProviderId fields | Result | verify |
|----------|-----------------------------|--------|--------|
| `r2` | `accountId`, `bucket` | `r2:{accountId}:{bucket}` | Also needs `accessKeyId`, `secretAccessKey` (optional `endpoint` / `region`); HeadBucket / `probe` |
| `local-fs` | — | Not implemented (throws) | Not implemented (`ok: false`) |
| `remote-fs` | — | Not implemented (throws) | Not implemented (`ok: false`) |

```ts
import { getStorageProviderId, verifyStorageProvider } from "@kyloc20/oss-sdk";

const providerId = getStorageProviderId({
  protocol: "r2",
  accountId: "…",
  bucket: "video",
});
// → "r2:…:video"

const check = await verifyStorageProvider({
  protocol: "r2",
  accountId: "…",
  bucket: "video",
  accessKeyId: "…",
  secretAccessKey: "…",
});
// → { ok: true, protocol: "r2", providerId, detail? }
```

---

## 4. Shared contract `StorageProvider`

Core APIs **always take an object** (no positional argument lists).

| Method | Param type | Semantics |
|--------|------------|-----------|
| `checkExist(params)` | `CheckExistParams` | ≈ HeadObject; missing object returns `{ exists: false }`, does not throw |
| `get(params)` | `GetParams` | ≈ GetObject → write to an absolute local file path |
| `create(params)` | `CreateParams` | ≈ PutObject; source is a local file path or `http(s)` URL |
| `delete(params)` | `DeleteParams` | ≈ DeleteObject; missing object counts as success |
| `probe()` | — | Optional connectivity check |

Required fields:

| Method | Required |
|--------|----------|
| checkExist | `uniqueName` |
| get | `uniqueName`, `destLocator` |
| create | `uniqueName`, `sourceLocator` |
| delete | `uniqueName` |

`StorageClient` also requires `provider` (full id or unique kind):

```ts
await client.create({
  provider: "localFs",
  uniqueName: "feed/a.jpg",
  sourceLocator: "D:/inbox/a.jpg",
  contentType: "image/jpeg",
});
```

### 4.1 uniqueName normalization (path providers)

1. Trim, replace `\` with `/`, remove leading `/`
2. Reject empty segments and `..`
3. Empty string is invalid

r2: the param can be a uniqueName (relative to the default bucket) or an opaque locator `r2:{bucket}/{key}`.

### 4.2 CreateResult.locator

| Provider | locator |
|----------|---------|
| localFs | `publicBaseUrl` + path, else absolute path |
| remoteFs | `{baseUrl}{apiRoot}/download?path={key}` |
| r2 | `r2:{bucket}/{key}` |

### 4.3 Cross-cutting options

| Capability | Notes |
|------------|-------|
| retry | Exponential backoff at shard / request level |
| concurrency | Parallel shard count for upload / download |
| resume | Download: Range resume from local bytes. Upload session resume in v1 may be shard retry only. |
| proxyUrl | Instance default + per-call override (remoteFs; needs optional `undici`) |
| sharding | Large objects use multipart / remoteFs chunk |

---

## 5. Registry

`createStorageClient` / `StorageProviderRegistry`:

1. Primary key is `provider.id`
2. `resolve`: match exact id first; else if that kind has one instance, you may pass the kind
3. Else `UNKNOWN_PROVIDER`

---

## 6. localFs

Config: `rootDir`, `id` (`fs:…`), optional `publicBaseUrl`.

| Operation | Behavior |
|-----------|----------|
| checkExist | `stat` |
| get | Copy to dest absolute path |
| create | Write into root from local path or URL; `upsert: false` rejects overwrite |
| delete | `rm` force |
| probe | root is reachable |

Paths must stay under `rootDir`, or the call returns `PATH_ESCAPE`.

---

## 7. remoteFs

Peer upload-service sandbox HTTP API.

### 7.1 Config

| Field | Notes |
|-------|-------|
| `baseUrl` | origin |
| `id` | `fs:…` |
| `apiRoot` | Default `/v0/upload/file`; TEMP `/v0/upload/temp` |
| `chunkThresholdBytes` | Default 8 MiB |
| `chunkSize` | Default 4 MiB |
| `proxyUrl` | Optional |

### 7.2 HTTP (relative to `apiRoot`)

| Operation | Method | Path |
|-----------|--------|------|
| download / HEAD | GET/HEAD | `/download?path=` |
| mkdir | POST | `/mkdir` |
| rename | POST | `/rename` |
| delete | POST | `/delete` body `{ relativePaths }` |
| upload | POST | `/upload?relativePath=` multipart `files` |
| chunk init | POST | `/upload/chunk/init` |
| chunk part | PUT | `/upload/chunk/{uploadId}/{partIndex}` |
| chunk complete | POST | `/upload/chunk/{uploadId}/complete` |
| chunk abort | DELETE | `/upload/chunk/{uploadId}` |
| root | GET | `/root` |

`create`: small files use multipart; large files use chunk (parts may run in parallel) → rename to the target key.

---

## 8. r2

### 8.1 Config

`id` (`r2:name`), `bucket`, `accessKeyId`, `secretAccessKey`, `accountId` or `endpoint`; optional `region` (default `auto`).

### 8.2 Locator

```
r2:{bucket}/{key}
```

`encodeR2Locator` / `parseR2Locator`. The key may contain `/`. The bucket must not contain `/`.

### 8.3 Behavior

| Operation | S3 API |
|-----------|--------|
| checkExist | HeadObject |
| get | GetObject (supports Range resume) |
| create | PutObject or CreateMultipartUpload + UploadPart + Complete |
| delete | DeleteObject |

### 8.4 Bucket helpers (not part of the shared contract)

`createBucket` / `deleteBucket` / `headBucket` / `listBuckets` — only on the r2 provider instance.

---

## 9. Parcel adapter

`createParcelUploadAdapter(provider)`: write memory to a temp file, then `create`; `url` = `CreateResult.locator`.

---

## 10. Error codes

| code | When |
|------|------|
| `UNKNOWN_PROVIDER` | Cannot resolve |
| `NOT_FOUND` | get source missing |
| `CONFIG` | Invalid config / params |
| `CHECK_FAILED` / `GET_FAILED` / `CREATE_FAILED` / `DELETE_FAILED` | Operation failed |
| `PATH_ESCAPE` | localFs path escape |
| `ALREADY_EXISTS` | upsert / overwrite conflict |
| `RESUME_INVALID` | Invalid resume state |
| `STORAGE_ERROR` | Generic |

---

## 11. Operation telemetry

See **[telemetry.md](./telemetry.md)** (`OSS_SDK_TELEMETRY_ON` / `OSS_SDK_TELEMETRY_DIR`; Client facade + `verifyStorageProvider` instrumentation).

---

## 12. Change checklist

- [ ] Update this document
- [ ] Update `src/types/`
- [ ] Update each provider and run typecheck / build
- [ ] Keep README examples in sync
- [ ] If telemetry changes: update [telemetry.md](./telemetry.md)
