/**
 * Dev-only Express demo for oss-sdk.
 * Not part of the published package.
 *
 * Security defaults:
 * - Bind 127.0.0.1 only
 * - R2 .env usage requires EXAMPLE_ALLOW_R2=1 and explicit useEnvCredentials
 * - When using env creds, endpoint/account/secrets are pinned from .env (request endpoint ignored)
 * - Multer filenames sanitized to basename
 * - Download temps deleted after response finishes
 */
import express from "express";
import multer from "multer";
import { config as loadEnv } from "dotenv";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createR2StorageProvider, createStorageClient } from "@kyloc20/oss-sdk";
import { createLocalFsStorageProvider } from "@kyloc20/oss-sdk/node";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const REPO_ROOT = resolve(ROOT, "..");

loadEnv({ path: resolve(REPO_ROOT, ".env") });

const STORAGE_ROOT = resolve(ROOT, "data", "storage");
const DOWNLOAD_ROOT = resolve(ROOT, "data", "downloads");
const PUBLIC_DIR = resolve(ROOT, "public");
const PORT = Number(process.env.PORT || 3789);
const HOST = process.env.EXAMPLE_HOST || "127.0.0.1";
const ALLOW_R2_ENV = process.env.EXAMPLE_ALLOW_R2 === "1";

function hasR2EnvSecrets() {
    return Boolean(
        process.env.R2_ACCESS_KEY_ID?.trim() &&
            process.env.R2_SECRET_ACCESS_KEY?.trim() &&
            process.env.R2_BUCKET?.trim(),
    );
}

if (hasR2EnvSecrets() && !ALLOW_R2_ENV) {
    console.error(
        "[oss-sdk-example] Refusing to start: R2 credentials found in .env but EXAMPLE_ALLOW_R2 is not 1.\n" +
            "  Set EXAMPLE_ALLOW_R2=1 to enable the r2 demo with env credentials (loopback only).",
    );
    process.exit(1);
}

await mkdir(STORAGE_ROOT, { recursive: true });
await mkdir(DOWNLOAD_ROOT, { recursive: true });

const localFs = createLocalFsStorageProvider({
    rootDir: STORAGE_ROOT,
    id: "fs:example-local",
});
const localClient = createStorageClient({ providers: [localFs] });

function safeUploadFilename(originalName) {
    const base = basename(String(originalName || "upload.bin").replace(/\\/g, "/"));
    const cleaned = base.replace(/[^\w.\-()+ ]+/g, "_").slice(0, 180);
    return cleaned || "upload.bin";
}

const upload = multer({
    storage: multer.diskStorage({
        destination: async (_req, _file, cb) => {
            try {
                const dir = await mkdtemp(join(tmpdir(), "oss-sdk-example-"));
                cb(null, dir);
            } catch (error) {
                cb(error);
            }
        },
        filename: (_req, file, cb) => {
            cb(null, safeUploadFilename(file.originalname));
        },
    }),
    limits: { fileSize: 512 * 1024 * 1024 },
});

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(PUBLIC_DIR));

function sendError(res, error) {
    const status =
        error?.code === "NOT_FOUND"
            ? 404
            : error?.code === "ALREADY_EXISTS" || error?.code === "CONFIG"
              ? 400
              : 500;
    res.status(status).json({
        ok: false,
        error: {
            message: error instanceof Error ? error.message : String(error),
            code: error?.code ?? "STORAGE_ERROR",
            provider: error?.provider,
        },
    });
}

function maskSecret(value) {
    const text = String(value ?? "");
    if (text === "") return "";
    if (text.length <= 4) return "****";
    if (text.length <= 8) return `${text.slice(0, 1)}****${text.slice(-1)}`;
    return `${text.slice(0, 2)}****${text.slice(-2)}`;
}

function redactSecrets(value) {
    if (value == null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(redactSecrets);
    const out = {};
    for (const [key, v] of Object.entries(value)) {
        if (/secret|password|token|accesskey|accountid|endpoint/i.test(key) && typeof v === "string" && v !== "") {
            out[key] = /endpoint/i.test(key) ? maskEndpoint(v) : maskSecret(v);
        } else if (v && typeof v === "object") {
            out[key] = redactSecrets(v);
        } else {
            out[key] = v;
        }
    }
    return out;
}

function maskEndpoint(endpoint) {
    const accountId = process.env.R2_ACCOUNT_ID || "";
    let value = endpoint;
    if (accountId && value.includes(accountId)) {
        value = value.replaceAll(accountId, maskSecret(accountId));
    }
    return value;
}

function truthyFlag(value) {
    return value === true || value === "true" || value === "1" || value === "on";
}

function isMaskedValue(value) {
    const typed = String(value ?? "").trim();
    return !typed || /^\*+$/.test(typed) || typed.includes("****") || typed === "********";
}

/**
 * Merge request body with .env only when useEnvCredentials is explicitly true.
 * When using env creds, pin endpoint/account/secrets from .env (ignore request endpoint).
 */
function resolveR2CredentialInput(body = {}) {
    const useEnv = truthyFlag(body.useEnvCredentials);
    if (useEnv && !ALLOW_R2_ENV) {
        const err = new Error("useEnvCredentials requires EXAMPLE_ALLOW_R2=1");
        err.code = "CONFIG";
        throw err;
    }

    const fromEnv = {
        providerId: process.env.R2_PROVIDER_ID || "media",
        accountId: process.env.R2_ACCOUNT_ID || "",
        endpoint: process.env.R2_ENDPOINT || "",
        accessKeyId: process.env.R2_ACCESS_KEY_ID || "",
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
        bucket: process.env.R2_BUCKET || "",
        region: process.env.R2_REGION || "auto",
    };

    if (useEnv) {
        return {
            providerId: String(body.providerId ?? "").trim() || fromEnv.providerId,
            accountId: fromEnv.accountId,
            endpoint: fromEnv.endpoint,
            accessKeyId: fromEnv.accessKeyId,
            secretAccessKey: fromEnv.secretAccessKey,
            bucket: String(body.bucket ?? "").trim() || fromEnv.bucket,
            region: String(body.region ?? "").trim() || fromEnv.region,
            useEnvCredentials: true,
        };
    }

    const accessKeyId = isMaskedValue(body.accessKeyId) ? "" : String(body.accessKeyId ?? "").trim();
    const secretAccessKey = isMaskedValue(body.secretAccessKey) ? "" : String(body.secretAccessKey ?? "").trim();
    const accountId = isMaskedValue(body.accountId) ? "" : String(body.accountId ?? "").trim();
    let endpoint = String(body.endpoint ?? "").trim();
    if (isMaskedValue(endpoint) || endpoint.includes("****")) {
        endpoint = "";
    }

    return {
        providerId: String(body.providerId ?? "").trim() || "media",
        accountId,
        endpoint,
        accessKeyId,
        secretAccessKey,
        bucket: String(body.bucket ?? "").trim(),
        region: String(body.region ?? "").trim() || "auto",
        useEnvCredentials: false,
    };
}

async function listStoredObjects(rootDir) {
    const objects = [];
    async function walk(dir) {
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(full);
                continue;
            }
            if (!entry.isFile()) continue;
            const info = await stat(full);
            objects.push({
                uniqueName: relative(rootDir, full).split(sep).join("/"),
                size: info.size,
                lastModified: info.mtime.toISOString(),
            });
        }
    }
    await walk(rootDir);
    objects.sort((a, b) => a.uniqueName.localeCompare(b.uniqueName));
    return objects;
}

function parseR2Credentials(body) {
    const accountId = String(body?.accountId ?? "").trim();
    const accessKeyId = String(body?.accessKeyId ?? "").trim();
    const secretAccessKey = String(body?.secretAccessKey ?? "").trim();
    const bucket = String(body?.bucket ?? "").trim();
    const endpoint = String(body?.endpoint ?? "").trim() || undefined;
    const region = String(body?.region ?? "").trim() || "auto";
    const id = String(body?.providerId ?? body?.id ?? "media").trim() || "media";

    if (!accessKeyId || !secretAccessKey || !bucket) {
        const err = new Error("accessKeyId, secretAccessKey, and bucket are required");
        err.code = "CONFIG";
        throw err;
    }
    if (!endpoint && !accountId) {
        const err = new Error("accountId or endpoint is required");
        err.code = "CONFIG";
        throw err;
    }

    return {
        id,
        accountId: accountId || undefined,
        endpoint,
        accessKeyId,
        secretAccessKey,
        bucket,
        region,
    };
}

function createEphemeralR2(body) {
    return createR2StorageProvider(parseR2Credentials(resolveR2CredentialInput(body)));
}

function pipeFileThenDelete(res, filePath, onError) {
    const stream = createReadStream(filePath);
    const cleanup = () => {
        rm(filePath, { force: true }).catch(() => undefined);
    };
    stream.on("error", (error) => {
        cleanup();
        onError(error);
    });
    res.on("finish", cleanup);
    res.on("close", cleanup);
    stream.pipe(res);
}

function publicGetResult(result) {
    return {
        uniqueName: result.uniqueName,
        size: result.size,
        contentType: result.contentType,
        etag: result.etag,
        destLocator: "(server temp download; deleted after response)",
    };
}

app.get("/", (_req, res) => {
    res.sendFile(join(PUBLIC_DIR, "index.html"));
});

app.get("/example/local-fs", (_req, res) => {
    res.sendFile(join(PUBLIC_DIR, "local-fs", "index.html"));
});

app.get("/example/r2", (_req, res) => {
    res.sendFile(join(PUBLIC_DIR, "r2", "index.html"));
});

app.get("/api/local-fs/meta", async (_req, res) => {
    const probe = (await localFs.probe?.()) ?? { ok: true, detail: { skipped: true } };
    res.json({
        ok: true,
        provider: { kind: localFs.kind, id: localFs.id, rootDir: "(local demo sandbox)" },
        probe: probe.ok ? { ok: true } : probe,
    });
});

app.get("/api/local-fs/objects", async (_req, res) => {
    try {
        res.json({ ok: true, objects: await listStoredObjects(STORAGE_ROOT) });
    } catch (error) {
        sendError(res, error);
    }
});

app.post("/api/local-fs/checkExist", async (req, res) => {
    try {
        const uniqueName = String(req.body?.uniqueName ?? "").trim();
        if (!uniqueName) {
            res.status(400).json({ ok: false, error: { message: "uniqueName required", code: "CONFIG" } });
            return;
        }
        const call = { provider: "localFs", uniqueName };
        const result = await localClient.checkExist(call);
        res.json({ ok: true, call, result });
    } catch (error) {
        sendError(res, error);
    }
});

app.post("/api/local-fs/create", upload.single("file"), async (req, res) => {
    const tempDir = req.file?.destination;
    try {
        const uniqueName = String(req.body?.uniqueName ?? "").trim();
        const upsert = String(req.body?.upsert ?? "true") !== "false";
        const contentType = req.body?.contentType || req.file?.mimetype || undefined;
        if (!uniqueName || !req.file?.path) {
            res.status(400).json({
                ok: false,
                error: { message: "uniqueName and file required", code: "CONFIG" },
            });
            return;
        }
        const call = {
            provider: "localFs",
            uniqueName,
            sourceLocator: req.file.path,
            contentType,
            upsert,
        };
        const result = await localClient.create(call);
        res.json({
            ok: true,
            call: { ...call, sourceLocator: "(uploaded temp file)" },
            result,
        });
    } catch (error) {
        sendError(res, error);
    } finally {
        if (tempDir) {
            await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
        }
    }
});

app.post("/api/local-fs/get", async (req, res) => {
    try {
        const uniqueName = String(req.body?.uniqueName ?? "").trim();
        if (!uniqueName) {
            res.status(400).json({ ok: false, error: { message: "uniqueName required", code: "CONFIG" } });
            return;
        }
        const safeName = basename(uniqueName.replace(/[\\/]/g, "__"));
        const destLocator = join(DOWNLOAD_ROOT, `local_${Date.now()}_${safeName}`);
        const result = await localClient.get({
            provider: "localFs",
            uniqueName,
            destLocator,
            overwrite: true,
            resume: false,
        });
        res.setHeader(
            "X-Oss-Sdk-Result",
            Buffer.from(JSON.stringify(publicGetResult(result)), "utf8").toString("base64url"),
        );
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader(
            "Content-Disposition",
            `attachment; filename="${encodeURIComponent(uniqueName.split("/").pop() || "download.bin")}"`,
        );
        pipeFileThenDelete(res, result.destLocator, (error) => {
            if (!res.headersSent) sendError(res, error);
            else res.destroy(error);
        });
    } catch (error) {
        sendError(res, error);
    }
});

app.post("/api/local-fs/delete", async (req, res) => {
    try {
        const uniqueName = String(req.body?.uniqueName ?? "").trim();
        if (!uniqueName) {
            res.status(400).json({ ok: false, error: { message: "uniqueName required", code: "CONFIG" } });
            return;
        }
        const call = { provider: "localFs", uniqueName };
        await localClient.delete(call);
        res.json({ ok: true, call, result: { deleted: true } });
    } catch (error) {
        sendError(res, error);
    }
});

app.get("/api/r2/defaults", (_req, res) => {
    const accountId = process.env.R2_ACCOUNT_ID || "";
    const accessKeyId = process.env.R2_ACCESS_KEY_ID || "";
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || "";
    let endpoint = process.env.R2_ENDPOINT || "";
    if (endpoint && accountId && endpoint.includes(accountId)) {
        endpoint = endpoint.replaceAll(accountId, maskSecret(accountId));
    }
    res.json({
        ok: true,
        allowEnvCredentials: ALLOW_R2_ENV,
        defaults: {
            providerId: process.env.R2_PROVIDER_ID || "media",
            accountId: accountId ? maskSecret(accountId) : "",
            endpoint,
            accessKeyId: accessKeyId ? maskSecret(accessKeyId) : "",
            secretAccessKey: secretAccessKey ? "********" : "",
            bucket: process.env.R2_BUCKET || "",
            region: process.env.R2_REGION || "auto",
            useEnvCredentials: ALLOW_R2_ENV,
        },
        configured: {
            accountId: Boolean(accountId),
            accessKeyId: Boolean(accessKeyId),
            secretAccessKey: Boolean(secretAccessKey),
            bucket: Boolean(process.env.R2_BUCKET),
            endpoint: Boolean(process.env.R2_ENDPOINT),
        },
        note: ALLOW_R2_ENV
            ? "Sensitive fields are masked. useEnvCredentials must be explicit; endpoint is pinned from .env."
            : "EXAMPLE_ALLOW_R2 is not set — fill credentials manually (or set EXAMPLE_ALLOW_R2=1).",
    });
});

app.post("/api/r2/probe", async (req, res) => {
    try {
        const resolved = resolveR2CredentialInput(req.body);
        const provider = createEphemeralR2(req.body);
        const probe = (await provider.probe?.()) ?? { ok: true, detail: { skipped: true } };
        const safeProbe =
            probe.ok === true
                ? { ok: true, detail: { bucket: resolved.bucket, region: resolved.region } }
                : probe;
        res.json({
            ok: true,
            call: redactSecrets({ action: "probe", credentials: parseR2Credentials(resolved) }),
            result: safeProbe,
        });
    } catch (error) {
        sendError(res, error);
    }
});

app.post("/api/r2/checkExist", async (req, res) => {
    try {
        const uniqueName = String(req.body?.uniqueName ?? "").trim();
        if (!uniqueName) {
            res.status(400).json({ ok: false, error: { message: "uniqueName required", code: "CONFIG" } });
            return;
        }
        const resolved = resolveR2CredentialInput(req.body);
        const provider = createEphemeralR2(req.body);
        const call = { uniqueName, bucket: req.body?.objectBucket || undefined };
        const result = await provider.checkExist(call);
        res.json({
            ok: true,
            call: redactSecrets({ ...call, credentials: parseR2Credentials(resolved) }),
            result,
        });
    } catch (error) {
        sendError(res, error);
    }
});

app.post("/api/r2/create", upload.single("file"), async (req, res) => {
    const tempDir = req.file?.destination;
    try {
        const uniqueName = String(req.body?.uniqueName ?? "").trim();
        const upsert = String(req.body?.upsert ?? "true") !== "false";
        const contentType = req.body?.contentType || req.file?.mimetype || undefined;
        if (!uniqueName || !req.file?.path) {
            res.status(400).json({
                ok: false,
                error: { message: "uniqueName and file required", code: "CONFIG" },
            });
            return;
        }
        const resolved = resolveR2CredentialInput(req.body);
        const provider = createEphemeralR2(req.body);
        const call = {
            uniqueName,
            sourceLocator: req.file.path,
            contentType,
            upsert,
            bucket: req.body?.objectBucket || undefined,
        };
        const result = await provider.create(call);
        res.json({
            ok: true,
            call: redactSecrets({
                ...call,
                sourceLocator: "(uploaded temp file)",
                credentials: parseR2Credentials(resolved),
            }),
            result,
        });
    } catch (error) {
        sendError(res, error);
    } finally {
        if (tempDir) {
            await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
        }
    }
});

app.post("/api/r2/get", async (req, res) => {
    try {
        const uniqueName = String(req.body?.uniqueName ?? "").trim();
        if (!uniqueName) {
            res.status(400).json({ ok: false, error: { message: "uniqueName required", code: "CONFIG" } });
            return;
        }
        const provider = createEphemeralR2(req.body);
        const safeName = basename(uniqueName.replace(/[\\/]/g, "__"));
        const destLocator = join(DOWNLOAD_ROOT, `r2_${Date.now()}_${safeName}`);
        const result = await provider.get({
            uniqueName,
            destLocator,
            overwrite: true,
            resume: false,
            bucket: req.body?.objectBucket || undefined,
        });
        res.setHeader(
            "X-Oss-Sdk-Result",
            Buffer.from(JSON.stringify(publicGetResult(result)), "utf8").toString("base64url"),
        );
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader(
            "Content-Disposition",
            `attachment; filename="${encodeURIComponent(uniqueName.split("/").pop() || "download.bin")}"`,
        );
        pipeFileThenDelete(res, result.destLocator, (error) => {
            if (!res.headersSent) sendError(res, error);
            else res.destroy(error);
        });
    } catch (error) {
        sendError(res, error);
    }
});

app.post("/api/r2/delete", async (req, res) => {
    try {
        const uniqueName = String(req.body?.uniqueName ?? "").trim();
        if (!uniqueName) {
            res.status(400).json({ ok: false, error: { message: "uniqueName required", code: "CONFIG" } });
            return;
        }
        const resolved = resolveR2CredentialInput(req.body);
        const provider = createEphemeralR2(req.body);
        const call = { uniqueName, bucket: req.body?.objectBucket || undefined };
        await provider.delete(call);
        res.json({
            ok: true,
            call: redactSecrets({ ...call, credentials: parseR2Credentials(resolved) }),
            result: { deleted: true },
        });
    } catch (error) {
        sendError(res, error);
    }
});

app.listen(PORT, HOST, () => {
    console.log(`[oss-sdk-example] http://${HOST}:${PORT}`);
    console.log(`[oss-sdk-example] local-fs → http://${HOST}:${PORT}/example/local-fs`);
    console.log(`[oss-sdk-example] r2       → http://${HOST}:${PORT}/example/r2`);
    console.log(`[oss-sdk-example] bind=${HOST} EXAMPLE_ALLOW_R2=${ALLOW_R2_ENV ? "1" : "0"}`);
});
