# @kyloc20/oss-sdk example (dev only)

Express demo pages. **Not included in the npm package.**

| Path | Notes |
|------|-------|
| `/` | Entry |
| `/example/local-fs` | localFs |
| `/example/r2` | r2 |

## Security defaults

- Listen on **`127.0.0.1` only** (you can override with `EXAMPLE_HOST`; not recommended)
- If `.env` has R2 secrets, you must set **`EXAMPLE_ALLOW_R2=1`** to start
- `useEnvCredentials` must be checked **explicitly**; then endpoint and secrets are **always read from .env** (request endpoint is ignored)
- Upload file names use `basename` only; download temp files are deleted after the response ends

## Start

```bash
pnpm install
pnpm build
# To use R2 from .env:
# EXAMPLE_ALLOW_R2=1 pnpm example
pnpm example
```

- http://127.0.0.1:3789/example/local-fs
- http://127.0.0.1:3789/example/r2

## r2 credentials

Copy root `.env.example` → `.env`, then fill in values (do not commit). The page shows redacted values only.
