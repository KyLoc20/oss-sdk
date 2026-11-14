import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const flush = readFileSync(new URL("../src/telemetry/flush.ts", import.meta.url), "utf8");
const match = flush.match(/export const OSS_SDK_VERSION = "([^"]+)";/);
if (!match) {
    console.error("check-sdk-version: OSS_SDK_VERSION not found in src/telemetry/flush.ts");
    process.exit(1);
}
if (match[1] !== pkg.version) {
    console.error(
        `check-sdk-version: package.json is ${pkg.version} but OSS_SDK_VERSION is ${match[1]}`,
    );
    process.exit(1);
}
console.log(`check-sdk-version: OK (${pkg.version})`);