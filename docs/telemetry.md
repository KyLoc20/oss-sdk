# oss-sdk operation telemetry protocol

> **Maintenance rule:** If you change telemetry fields, env vars, buffer / flush semantics, file naming, or privacy rules, **update this document**. The source of truth is `src/telemetry/`.  
> Storage contract: [protocol.md](./protocol.md). This document covers **SDK operation telemetry** only.

---

## 1. Goals and non-goals

| Do | Do not |
|----|--------|
| Record duration / success / failure / error summary for core APIs for later review | Strong consistency, transactions, or exactly-once delivery |
| Let callers enable via env with no business-code changes | Print to stdout by default |
| Keep `create` / `get` / … working if disk write fails | Store secrets, full file content, or large bodies |
| Allow loss of unflushed buffer on process crash | Cross-process file locks / strong fsync guarantees |

**Semantics: best-effort. Loss is allowed.**

---

## 2. Environment variables

| Env | Required (when on) | Meaning |
|-----|--------------------|---------|
| `OSS_SDK_TELEMETRY_ON` | Yes | Enable only for `true` / `1` (case-insensitive) |
| `OSS_SDK_TELEMETRY_DIR` | Yes | Telemetry directory (absolute or relative to cwd) |
| `OSS_SDK_TELEMETRY_FLUSH_SIZE` | No | Flush when event count reaches this; default **100** |
| `OSS_SDK_TELEMETRY_FLUSH_MS` | No | Flush when time since last flush (or first buffered event) reaches this and buffer is not empty; default **60000** |
| `OSS_SDK_TELEMETRY_MAX_BUFFER` | No | Max events in memory; default **500**; drop oldest when over limit |

### 2.1 Startup checks (when `OSS_SDK_TELEMETRY_ON` is true)

1. `OSS_SDK_TELEMETRY_DIR` must not be empty  
2. `mkdir` recursive if the directory does not exist  
3. Write a probe file, then delete it (or an equivalent writable check)  
4. On failure → **disable telemetry** (do not throw). The SDK main path continues. You may log one `console.warn` (optional).

If `OSS_SDK_TELEMETRY_ON` is not set → full no-op.

---

## 3. Instrumentation points

Wrap these methods on the **`StorageClient` facade** (all registered providers):

| `op` | API |
|------|-----|
| `checkExist` | `client.checkExist` |
| `get` | `client.get` |
| `create` | `client.create` |
| `delete` | `client.delete` |

Also:

| `op` | API |
|------|-----|
| `verify` | `verifyStorageProvider` |

If `provider.probe` runs only via `verify`, do not record a second event (avoid double count). If a public probe API is added later, add `op: "probe"`.

Timing: wrap the full `await` with `performance.now()` (fallback: `Date.now()`).

---

## 4. Event fields (`OssSdkTelemetryEvent`)

Time is always **epoch milliseconds** (`number`). Field name: `ts`.

| Field | Type | Notes |
|-------|------|-------|
| `ts` | `number` | Timestamp when the call ends (or fails) |
| `op` | `string` | See tables above |
| `providerId` | `string \| null` | Resolved / derived id; else `null` |
| `uniqueName` | `string \| null` | Truncated to **256**; else `null` |
| `ok` | `boolean` | Success or failure |
| `errMessage` | `string \| null` | On failure: `error.message` truncated to **512**; on success: `null` |
| `costMs` | `number` | Duration in ms, one decimal place |
| `size` | `number \| null` | Optional: create/get result size |
| `resultSummary` | `string \| null` | Optional short summary, e.g. `exists=true`, first 128 chars of `locator`; **no** secrets |

Do not write: `accessKeyId`, `secretAccessKey`, full signed URL query, or file bytes.

---

## 5. In-memory buffer

Logical model:

```ts
{
  events: OssSdkTelemetryEvent[];  // or fixed-size ring
  dropped: number;                 // events dropped because buffer was full
  flushInFlight: boolean;
  lastFlushAt: number;
}
```

| Rule | Default |
|------|---------|
| Append | `append` after each core API ends |
| Cap | `OSS_SDK_TELEMETRY_MAX_BUFFER` (500); when full, **drop oldest** and `dropped++` |
| Flush trigger | `length >= FLUSH_SIZE` **or** (timer) time since last flush ≥ `FLUSH_MS` and buffer not empty |
| Concurrency | Skip a second flush while `flushInFlight` |

---

## 6. Flush and file format

### 6.1 File name

```text
{OSS_SDK_TELEMETRY_DIR}/{flushTs}.{hash6}.json
```

| Part | Meaning |
|------|---------|
| `flushTs` | `Date.now()` at flush **start** |
| `hash6` | SHA-256 of the **JSON body about to write** (UTF-8); take first **6** hex chars |

Same-millisecond flushes are separated by `hash6`.

### 6.2 File body

```json
{
  "flushedAt": 1730000000123,
  "sdkVersion": "0.1.0",
  "droppedBeforeFlush": 0,
  "events": [ /* OssSdkTelemetryEvent[] */ ]
}
```

| Field | Notes |
|-------|-------|
| `flushedAt` | Same as file-name `flushTs` |
| `sdkVersion` | Release version |
| `droppedBeforeFlush` | Dropped count before this flush (after a successful write, phase 1 sets `buffer.dropped` to 0) |
| `events` | Events in this batch |

### 6.3 Disk write (best-effort)

1. Write `{name}.tmp`  
2. `rename` to the final name  
3. On failure: swallow the error; **discard** this batch (do not put events back; avoid poison pills)  
4. `fsync` is not required  

Optional: on `beforeExit` / explicit `flushOssSdkTelemetry()`, try one more best-effort flush.

---

## 7. Public API (exported)

| Symbol | Role |
|--------|------|
| (automatic) | Built-in telemetry in `createStorageClient` / `verifyStorageProvider` |
| `flushOssSdkTelemetry()` | Manual flush; no-op if disabled |
| `isOssSdkTelemetryEnabled()` | Whether telemetry is on (after checks pass) |

Callers **do not** need to change business code for telemetry. Set the env vars only.

---

## 8. Caller integration (upload-service video)

media-clip / FEATURE_VIDEO R2 paths that use `createStorageClient` and `verifyStorageProvider` get telemetry automatically.

Suggested upload-service `.env`:

```bash
OSS_SDK_TELEMETRY_ON=true
OSS_SDK_TELEMETRY_DIR=D:/upload-service/data/oss-sdk-telemetry
```

Keep this directory separate from `MEDIA_INGEST_STAGING_ROOT` / cache so cleanup stays easy.

---

## 9. Change checklist

- [ ] Update this document  
- [ ] Update `src/telemetry/`  
- [ ] Hook `createStorageClient` / `verifyStorageProvider`  
- [ ] typecheck / build  
- [ ] Link from README or protocol.md  

---

## 10. Revision history

| Date | Notes |
|------|-------|
| 2026-11-14 | First version: env, event fields, ring/batch flush, `{ts}.{hash6}.json` (was `docs/log.md` / `OSS_SDK_LOG_*`) |
| 2026-11-14 | Rename: `log` → `telemetry` (docs, env, public API, type names) |
| 2026-11-14 | Lower default flush rate: `FLUSH_SIZE=100`, `FLUSH_MS=60000`; timer no longer flushes immediately when `lastFlushAt=0` |
