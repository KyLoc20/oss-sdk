import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { StorageError } from "./errors.js";

export interface SafeHttpUrlOptions {
    /** Allow private / link-local / loopback targets. Default false. */
    allowPrivateNetwork?: boolean;
    /** Max redirects when following manually. Default 3. */
    maxRedirects?: number;
}

const BLOCKED_HOSTNAMES = new Set([
    "localhost",
    "localhost.localdomain",
    "metadata.google.internal",
    "metadata",
]);

function ipv4ToInt(ip: string): number {
    const parts = ip.split(".").map((p) => Number(p));
    return ((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!;
}

function isPrivateOrLocalIp(ip: string): boolean {
    const v = isIP(ip);
    if (v === 4) {
        const n = ipv4ToInt(ip);
        // 0.0.0.0/8, 10/8, 127/8, 169.254/16, 172.16/12, 192.168/16, 100.64/10
        if ((n & 0xff000000) === 0x00000000) return true;
        if ((n & 0xff000000) === 0x0a000000) return true;
        if ((n & 0xff000000) === 0x7f000000) return true;
        if ((n & 0xffff0000) === 0xa9fe0000) return true;
        if ((n & 0xfff00000) === 0xac100000) return true;
        if ((n & 0xffff0000) === 0xc0a80000) return true;
        if ((n & 0xffc00000) === 0x64400000) return true;
        return false;
    }
    if (v === 6) {
        const normalized = ip.toLowerCase();
        if (normalized === "::" || normalized === "::1") return true;
        if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // ULA
        if (normalized.startsWith("fe80")) return true; // link-local
        if (normalized.startsWith("::ffff:")) {
            const mapped = normalized.slice("::ffff:".length);
            if (isIP(mapped) === 4) {
                return isPrivateOrLocalIp(mapped);
            }
        }
        return false;
    }
    return true;
}

/** Validate http(s) URL and resolve hostname to a non-private address (unless allowed). */
export async function assertSafeHttpUrl(raw: string, options: SafeHttpUrlOptions = {}): Promise<URL> {
    let url: URL;
    try {
        url = new URL(raw.trim());
    } catch (error) {
        throw new StorageError(`Invalid URL: ${raw}`, { code: "CONFIG", cause: error });
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new StorageError(`Only http(s) URLs are allowed (got ${url.protocol})`, { code: "CONFIG" });
    }
    if (url.username || url.password) {
        throw new StorageError("URL credentials are not allowed", { code: "CONFIG" });
    }

    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (BLOCKED_HOSTNAMES.has(host) || host.endsWith(".localhost") || host.endsWith(".local")) {
        if (!options.allowPrivateNetwork) {
            throw new StorageError(`Blocked hostname for SSRF protection: ${host}`, { code: "CONFIG" });
        }
    }

    if (options.allowPrivateNetwork) {
        return url;
    }

    const ipVersion = isIP(host);
    if (ipVersion) {
        if (isPrivateOrLocalIp(host)) {
            throw new StorageError(`Blocked private/link-local IP: ${host}`, { code: "CONFIG" });
        }
        return url;
    }

    let addresses: string[];
    try {
        const result = await lookup(host, { all: true });
        addresses = result.map((r) => r.address);
    } catch (error) {
        throw new StorageError(`DNS lookup failed for ${host}`, { code: "CONFIG", cause: error });
    }
    if (addresses.length === 0) {
        throw new StorageError(`DNS lookup returned no addresses for ${host}`, { code: "CONFIG" });
    }
    for (const address of addresses) {
        if (isPrivateOrLocalIp(address)) {
            throw new StorageError(`Blocked hostname resolving to private IP (${host} → ${address})`, {
                code: "CONFIG",
            });
        }
    }
    return url;
}

/** Validate proxy URL scheme (http/https only). */
export function assertSafeProxyUrl(proxyUrl: string): string {
    const trimmed = proxyUrl.trim();
    let url: URL;
    try {
        url = new URL(trimmed);
    } catch (error) {
        throw new StorageError(`Invalid proxyUrl: ${proxyUrl}`, { code: "CONFIG", cause: error });
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new StorageError(`proxyUrl must be http(s) (got ${url.protocol})`, { code: "CONFIG" });
    }
    return trimmed;
}

/**
 * Fetch with redirect:manual and SSRF re-check on each Location.
 * Returns the final Response (caller consumes body).
 */
export async function fetchWithSsrfGuard(
    doFetch: typeof fetch,
    rawUrl: string,
    init: RequestInit | undefined,
    options: SafeHttpUrlOptions = {},
): Promise<Response> {
    const maxRedirects = options.maxRedirects ?? 3;
    let current = (await assertSafeHttpUrl(rawUrl, options)).toString();

    for (let hop = 0; hop <= maxRedirects; hop += 1) {
        const res = await doFetch(current, { ...init, redirect: "manual" });
        if (res.status >= 300 && res.status < 400) {
            const location = res.headers.get("location");
            await res.body?.cancel?.().catch(() => undefined);
            if (!location) {
                throw new StorageError(`Redirect ${res.status} missing Location`, { code: "GET_FAILED" });
            }
            const next = new URL(location, current).toString();
            current = (await assertSafeHttpUrl(next, options)).toString();
            continue;
        }
        return res;
    }
    throw new StorageError(`Too many redirects (>${maxRedirects})`, { code: "GET_FAILED" });
}
