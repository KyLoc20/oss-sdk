# @kyloc20/oss-sdk

Multi-provider object storage SDK (`localFs`, `remoteFs`, `r2`) with a shared API:

`checkExist` · `get` · `create` · `delete` · `getStorageProviderId` · `verifyStorageProvider`

**Protocol details: [docs/protocol.md](./docs/protocol.md). Operation telemetry: [docs/telemetry.md](./docs/telemetry.md) (`OSS_SDK_TELEMETRY_ON` + `OSS_SDK_TELEMETRY_DIR`).**

Service-wide R2 provider id: `r2:{accountId}:{bucket}` via `getStorageProviderId({ protocol: "r2", accountId, bucket })`.

## Providers

| Kind | Factory | Notes |
|------|---------|--------|
| `localFs` | `createLocalFsStorageProvider` | Node filesystem (`@kyloc20/oss-sdk/node`) |
| `remoteFs` | `createRemoteFsStorageProvider` | upload-service sandbox HTTP |
| `r2` | `createR2StorageProvider` | Cloudflare R2; locator `r2:{bucket}/{key}` |

## Install

```bash
pnpm add @kyloc20/oss-sdk
# optional peer for HTTP proxy on Node:
pnpm add undici
```

This repository uses **pnpm** for development.

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm pack:check
```

## Quick start

```ts
import {
  createStorageClient,
  createRemoteFsStorageProvider,
  createR2StorageProvider,
  getStorageProviderId,
} from "@kyloc20/oss-sdk";
import { createLocalFsStorageProvider } from "@kyloc20/oss-sdk/node";

const client = createStorageClient({
  providers: [
    createLocalFsStorageProvider({
      rootDir: process.env.FEED_FS_ROOT!,
      id: process.env.LOCAL_STORAGE_PROVIDER!, // fs:windows-storage:HOST
    }),
    createRemoteFsStorageProvider({
      baseUrl: process.env.OSS_FILES_BASE_URL!,
      id: process.env.FEED_REMOTE_FS_STORAGE_PROVIDER!, // fs:149.28.16.125
      apiRoot: "/v0/upload/file",
    }),
    createR2StorageProvider({
      id: getStorageProviderId({
        protocol: "r2",
        accountId: process.env.R2_ACCOUNT_ID!,
        bucket: process.env.R2_BUCKET!,
      }),
      accountId: process.env.R2_ACCOUNT_ID!,
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      bucket: process.env.R2_BUCKET!,
    }),
  ],
});

await client.create({
  provider: "localFs",
  uniqueName: "feed/a.jpg",
  sourceLocator: "D:/inbox/a.jpg",
  contentType: "image/jpeg",
});

const head = await client.checkExist({
  provider: "localFs",
  uniqueName: "feed/a.jpg",
});

await client.get({
  provider: "localFs",
  uniqueName: "feed/a.jpg",
  destLocator: "D:/out/a.jpg",
});

await client.delete({ provider: "r2", uniqueName: "feed/a.jpg" });
// or opaque locator:
await client.delete({ provider: "r2", uniqueName: "r2:my-bucket/feed/a.jpg" });
```

## Layout

```text
src/
  core/          # client, registry, errors, http/retry helpers
  types/         # StorageProvider contract + provider id / r2 locator
  discovery/     # getStorageProviderId + verifyStorageProvider
  telemetry/     # best-effort op telemetry → OSS_SDK_TELEMETRY_DIR
  providers/     # local-fs | remote-fs | r2
  adapters/      # parcel upload adapter bridge
  index.ts       # remoteFs + r2 + discovery
  node.ts        # + localFs
docs/
  protocol.md
example/         # dev-only Express demos (not published)
```

## Publish

```bash
pnpm build
pnpm pack:check
# tag v0.1.0 matching package.json, or:
npm publish --access public
```

CI: a push to `main` runs the build. A tag `v*.*.*` publishes with `NPM_TOKEN` (see `.github/workflows/`).

Dev demo (not published; binds to `127.0.0.1` by default):

```bash
pnpm build
# To use R2 credentials from .env:
# EXAMPLE_ALLOW_R2=1 pnpm example
pnpm example
# http://127.0.0.1:3789/example/local-fs
# http://127.0.0.1:3789/example/r2
```
