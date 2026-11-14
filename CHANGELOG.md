# Changelog

## 0.1.2 — 2026-11-15

### Fixed

- Sync `OSS_SDK_VERSION` with `package.json` (was still `0.1.0` after `0.1.1`).

### CI / release

- Add `scripts/check-sdk-version.mjs` and run it in `pnpm verify`.
- Release workflow runs full `pnpm verify` before OIDC publish.
- CI uses `pnpm verify` (typecheck + build + version check).

## 0.1.1 — 2026-11-15

- npm Trusted Publishing (OIDC) from GitHub Actions.
- Upgrade npm CLI to 11.5.1+ in the release job.

## 0.1.0 — 2026-11-15

- Initial public release.