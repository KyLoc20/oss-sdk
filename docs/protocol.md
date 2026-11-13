# oss-sdk 协议

> **维护约定：** 凡变更 `StorageProvider` 契约、provider kind / id、uniqueName / locator 格式、remoteFs HTTP 路径与语义，或错误码约定，**必须同步更新本文档**。实现以 `src/types/` 与各 provider 为准。

---

## 1. 目标与范围

统一多后端对象存储：可恢复、可并发、可重试；支持 proxy 与 sharding。公开 API 为 `checkExist` / `get` / `create` / `delete`。

| Kind | 含义 | 运行时 |
|------|------|--------|
| `localFs` | 本机沙箱目录（Node `fs`） | `oss-sdk/node` |
| `remoteFs` | 对端 upload-service 沙箱 HTTP API | 主入口 |
| `r2` | Cloudflare R2（S3 兼容） | 主入口 |

**暂不支持：** `telegram`、统一 Bucket 抽象。r2 可另提供 bucket 辅助方法。

---

## 2. 术语

| 术语 | 含义 |
|------|------|
| **provider** | 已注册存储实例（`kind` + 完整 `id`） |
| **uniqueName** | 调用方保证唯一；路径型 provider 映射为 object key |
| **locator** | 检索串：本地绝对路径、HTTP URL、或 opaque `r2:{bucket}/{key}` |

`get` 的 **destLocator（v1）必须是绝对文件路径**（禁止目录）。

### 2.1 信任边界（安全）

| 输入 | 规则 |
|------|------|
| `uniqueName` | 禁止 `..` / 空段；localFs 另做 root 内校验 + 默认拒绝符号链接逃逸 |
| `sourceLocator`（本地路径） | **不得**直接接不可信用户输入（任意读文件） |
| `sourceLocator`（http/s） | 默认 **SSRF 防护**（拒绝私网/链路本地/metadata；手动跟随重定向并复检）；`allowPrivateNetwork: true` 可关闭 |
| `destLocator` | **不得**直接接不可信用户输入（任意写文件） |
| `proxyUrl` | 仅允许 `http:` / `https:`；勿对不可信调用方暴露 |

`example/` 演示服：默认只绑 `127.0.0.1`；使用 `.env` R2 密钥需 `EXAMPLE_ALLOW_R2=1`，且 `useEnvCredentials` 必须显式为 true，此时 endpoint/密钥固定来自 `.env`。

---

## 3. Provider ID

| Family | 前缀 | 示例 | kind |
|--------|------|------|------|
| `fs` | `fs:` | `fs:windows-storage:HOST`、`fs:149.28.16.125` | `localFs` 或 `remoteFs` |
| `r2` | `r2:` | `r2:media`（**不可**含 `/`） | `r2` |

- `localFs` / `remoteFs` 共用 `fs:`；具体 kind 由工厂决定。
- 对象 locator `r2:{bucket}/{key}` **不是** provider id（含 `/`）。

工具：`buildProviderId`、`parseProviderId`、`encodeR2Locator` / `parseR2Locator`。

---

## 4. 统一契约 `StorageProvider`

核心 API **一律对象传参**（禁止位置参数列表）。

| 方法 | 参数类型 | 语义 |
|------|----------|------|
| `checkExist(params)` | `CheckExistParams` | ≈ HeadObject；不存在返回 `{ exists: false }`，不抛 |
| `get(params)` | `GetParams` | ≈ GetObject → 写入本地绝对文件路径 |
| `create(params)` | `CreateParams` | ≈ PutObject；源为本地文件路径或 `http(s)` URL |
| `delete(params)` | `DeleteParams` | ≈ DeleteObject；不存在视为成功 |
| `probe()` | — | 可选连通性检查 |

必填字段：

| 方法 | 必填 |
|------|------|
| checkExist | `uniqueName` |
| get | `uniqueName`, `destLocator` |
| create | `uniqueName`, `sourceLocator` |
| delete | `uniqueName` |

`StorageClient` 在以上参数上额外要求 `provider`（完整 id 或唯一 kind）：

```ts
await client.create({
  provider: "localFs",
  uniqueName: "feed/a.jpg",
  sourceLocator: "D:/inbox/a.jpg",
  contentType: "image/jpeg",
});
```

### 4.1 uniqueName 规范化（路径型）

1. trim，`\` → `/`，去前导 `/`
2. 禁止空段与 `..`
3. 空非法

r2：参数可为 uniqueName（相对默认 bucket）或 opaque locator `r2:{bucket}/{key}`。

### 4.2 CreateResult.locator

| Provider | locator |
|----------|---------|
| localFs | `publicBaseUrl`+path，否则绝对路径 |
| remoteFs | `{baseUrl}{apiRoot}/download?path={key}` |
| r2 | `r2:{bucket}/{key}` |

### 4.3 横切选项

| 能力 | 说明 |
|------|------|
| retry | 分片/请求级指数退避 |
| concurrency | 上下行分片并行度 |
| resume | 下载：按本地已有字节 Range 续传；上传会话续传 v1 可简化为分片重试 |
| proxyUrl | 实例默认 + 单次覆盖（remoteFs；需 optional `undici`） |
| sharding | 超阈值走 multipart / remoteFs chunk |

---

## 5. 注册表

`createStorageClient` / `StorageProviderRegistry`：

1. 主键 `provider.id`
2. `resolve`：先精确 id；否则该 kind 仅一个实例时可传 kind
3. 否则 `UNKNOWN_PROVIDER`

---

## 6. localFs

配置：`rootDir`、`id`（`fs:…`）、可选 `publicBaseUrl`。

| 操作 | 行为 |
|------|------|
| checkExist | `stat` |
| get | 复制到 dest 绝对路径 |
| create | 从本地路径或 URL 写入 root；`upsert: false` 拒绝覆盖 |
| delete | `rm` force |
| probe | root 可访问 |

路径必须落在 `rootDir` 内，否则 `PATH_ESCAPE`。

---

## 7. remoteFs

对端 upload-service 沙箱 HTTP API。

### 7.1 配置

| 字段 | 说明 |
|------|------|
| `baseUrl` | origin |
| `id` | `fs:…` |
| `apiRoot` | 默认 `/v0/upload/file`；TEMP `/v0/upload/temp` |
| `chunkThresholdBytes` | 默认 8 MiB |
| `chunkSize` | 默认 4 MiB |
| `proxyUrl` | 可选 |

### 7.2 HTTP（相对 `apiRoot`）

| 操作 | 方法 | 路径 |
|------|------|------|
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

`create`：小文件 multipart；大文件 chunk（可并发 part）→ rename 到目标 key。

---

## 8. r2

### 8.1 配置

`id`（`r2:name`）、`bucket`、`accessKeyId`、`secretAccessKey`、`accountId` 或 `endpoint`；可选 `region`（默认 `auto`）。

### 8.2 Locator

```
r2:{bucket}/{key}
```

`encodeR2Locator` / `parseR2Locator`。key 可含 `/`；bucket 不可含 `/`。

### 8.3 行为

| 操作 | S3 API |
|------|--------|
| checkExist | HeadObject |
| get | GetObject（支持 Range 续传） |
| create | PutObject 或 CreateMultipartUpload + UploadPart + Complete |
| delete | DeleteObject |

### 8.4 Bucket 辅助（非统一契约）

`createBucket` / `deleteBucket` / `headBucket` / `listBuckets` — 仅挂在 r2 provider 实例上。

---

## 9. Parcel 适配

`createParcelUploadAdapter(provider)`：内存写入临时文件后 `create`；`url` = `CreateResult.locator`。

---

## 10. 错误码

| code | 场景 |
|------|------|
| `UNKNOWN_PROVIDER` | 无法 resolve |
| `NOT_FOUND` | get 源不存在 |
| `CONFIG` | 配置/参数非法 |
| `CHECK_FAILED` / `GET_FAILED` / `CREATE_FAILED` / `DELETE_FAILED` | 操作失败 |
| `PATH_ESCAPE` | localFs 越界 |
| `ALREADY_EXISTS` | upsert/overwrite 冲突 |
| `RESUME_INVALID` | 续传状态不合法 |
| `STORAGE_ERROR` | 通用 |

---

## 11. 变更检查清单

- [ ] 更新本文档
- [ ] 更新 `src/types/`
- [ ] 各 provider 与 typecheck / build
- [ ] README 示例同步
