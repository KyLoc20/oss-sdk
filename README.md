# @kyloc20/oss-sdk

Multi-provider object storage SDK (`localFs`, `remoteFs`, `r2`) with a shared API:

`checkExist` · `get` · `create` · `delete`

**协议细节见 [docs/protocol.md](./docs/protocol.md)。**

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

本仓库开发使用 **pnpm**。

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
      id: "media",
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
  providers/     # local-fs | remote-fs | r2
  adapters/      # parcel upload adapter bridge
  index.ts       # remoteFs + r2
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

CI：push 到 `main` 跑构建；推送 tag `v*.*.*` 时用 `NPM_TOKEN` 发布（见 `.github/workflows/`）。

开发演示（不参与发布；默认仅 `127.0.0.1`）：

```bash
pnpm build
# 使用 .env 中的 R2 凭据时：
# EXAMPLE_ALLOW_R2=1 pnpm example
pnpm example
# http://127.0.0.1:3789/example/local-fs
# http://127.0.0.1:3789/example/r2
```
