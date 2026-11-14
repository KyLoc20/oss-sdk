# npm Trusted Publishing (OIDC) from GitHub Actions

This guide records how `@kyloc20/oss-sdk` moved from a bootstrap token to **Trusted Publishing (OIDC)**. Use it as a checklist for other packages (for example `target-supabase-sdk`).

## Goal

- Publish on tag push from GitHub Actions.
- Use **short-lived OIDC** credentials. Do not rely on long-lived **Bypass 2FA** publish tokens.
- No OTP on every release (CI does not use account 2FA).

## End state (oss-sdk)

| Piece | Value |
|-------|--------|
| Package | `@kyloc20/oss-sdk` |
| GitHub | `KyLoc20/oss-sdk` |
| Workflow file | `.github/workflows/release.yml` (name on disk only; case-sensitive) |
| npm Trusted Publisher status | **Valid** |
| Publish step | No `NODE_AUTH_TOKEN` |
| npm in CI | **11.5.1+** (upgraded before `npm publish`) |

## Prerequisites

1. **npm account** owns the scope (for example `@kyloc20`).
2. **`package.json`**:
   - `name` matches the npm package.
   - `publishConfig.access`: `"public"` for scoped public packages.
   - `repository.url` matches the real GitHub repo, for example `git+https://github.com/OWNER/REPO.git`.
3. **GitHub workflow** (see [Reference workflow](#reference-workflow)).
4. **npm Trusted Publisher** row on the package (after the package exists on npm).

## Recommended path (two phases)

### Phase A — Bootstrap (first version on npm)

npm **Trusted Publisher** settings live on the **package** page. The package must **exist once** before you can bind OIDC in the UI. First publish often cannot rely on OIDC alone.

| Option | Needs account OTP? | Notes |
|--------|-------------------|--------|
| GitHub Actions + **Granular token** with **Bypass 2FA** | No | Used for oss-sdk `0.1.0`. Revoke after OIDC works. |
| Local `npm publish` | Yes (or Bypass token in `.npmrc`) | Skip if you avoid OTP. |

Steps for Phase A (oss-sdk pattern):

1. Create a **Granular Access Token**: scope the package, **Read and write (publish and stage)**, enable **Bypass 2FA**.
2. Store it as GitHub secret `NPM_TOKEN`.
3. In `release.yml`, set `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` on the publish step only.
4. Push `main`, push tag `vX.Y.Z` matching `package.json` `version`.
5. Confirm the package appears on npmjs.com.

**Deprecation note:** npm will revoke **direct publish + Bypass** tokens around **January 2027**. Treat them as bootstrap only.

### Phase B — Trusted Publisher + pure OIDC

1. On npm: package **Settings → Trusted publishing → GitHub Actions**:
   - Organization or user: GitHub owner (for example `KyLoc20`).
   - Repository: repo name (for example `oss-sdk`).
   - Workflow filename: **exact file** (for example `release.yml`).
   - Environment: leave blank unless the job uses `environment:`.
   - Allow **`npm publish`** (not stage-only unless you want manual approval).
2. Save. Status starts as **Pending validation**.
3. You must **publish once successfully via this workflow within 2 days**, or the config **expires** (delete and recreate).
4. Remove `NODE_AUTH_TOKEN` from the publish step.
5. Bump `package.json` version (you cannot republish the same version).
6. Ensure the **tag points at a commit that contains the OIDC workflow** (including `npm install -g npm@^11.5.1`).
7. Push tag. Confirm **Valid** on npm and the new version on the registry.
8. Delete GitHub secret `NPM_TOKEN` and revoke the bootstrap token on npm.
9. Optional: **Publishing access → Require 2FA and disallow bypass tokens** (OIDC still works).

**Account 2FA on npmjs.com:** Saving Trusted Publisher may require **one-time** account verification (Passkey, authenticator, etc.). That is **not** required on every CI release.

## Reference workflow

Minimal requirements for OIDC (see `.github/workflows/release.yml` in this repo):

```yaml
permissions:
  contents: read
  id-token: write   # Required for OIDC

# In the publish job:
- uses: actions/setup-node@v4
  with:
    node-version: 22.14   # npm doc: Node >= 22.14
    registry-url: https://registry.npmjs.org

- name: Upgrade npm for Trusted Publishing
  run: npm install -g npm@^11.5.1

- name: Publish to npm
  run: npm publish --access public
  # Do NOT set NODE_AUTH_TOKEN here when using OIDC only.
```

Tag trigger example: `on.push.tags: ["v*.*.*"]` with a step that compares tag to `package.json` `version`.

## Pitfalls (oss-sdk runbook)

### 1. `403` — Bypass 2FA required

**Symptom:** `403 Forbidden ... granular access token with bypass 2fa enabled is required`.

**Cause:** Publish needs either interactive **account 2FA (OTP)** or a token with **Bypass 2FA**. CI cannot enter OTP.

**Fix:** Bootstrap token with Bypass 2FA, or use OIDC after Trusted Publisher is **Valid**.

### 2. `404` on publish — registry identity missing (often misread)

**Symptom:** `404 Not Found - PUT ...` and `'@scope/pkg@x.y.z' is not in this registry` **even though the package exists**.

**Cause (oss-sdk):** **Node 22 ships npm 10**. npm **&lt; 11.5.1** does not do OIDC exchange. The request is effectively unauthenticated; npm often returns **404** instead of 401/403.

**Fix:** Before `npm publish`, run `npm install -g npm@^11.5.1`. Log `npm -v` in CI.

**Also check:**

- No `NODE_AUTH_TOKEN` on the publish step (leftover token can block OIDC).
- Workflow filename on npm **exactly** matches `.github/workflows/<file>`.
- Tag commit includes the upgraded workflow (see pitfall 3).

### 3. Tag points at an old commit

**Symptom:** Fix is on `main` (green **CI**), but **Release** on `vX.Y.Z` still fails.

**Cause:** Git tags are fixed pointers. Re-pushing `main` does not move a tag.

**Fix:**

```bash
git checkout main && git pull
git tag -f vX.Y.Z
git push origin :refs/tags/vX.Y.Z
git push origin vX.Y.Z
```

Verify: `git rev-parse vX.Y.Z` equals `git rev-parse main` (or the intended release commit).

### 4. Trusted Publisher **Pending validation** expires

**Symptom:** Orange banner: publish once before a UTC deadline.

**Cause:** New Trusted Publisher configs must complete **one successful OIDC publish within ~2 days**.

**Fix:** Publish via the bound workflow in time, or delete the connection and create a new one.

### 5. Trusted Publisher fields are immutable

**Symptom:** Yellow warning: cannot change provider fields later.

**Cause:** npm fixes owner, repo, and workflow filename at create time.

**Fix:** Double-check `OWNER`, `REPO`, and `release.yml` before save. To change, **Delete** and add a new connection.

### 6. `npm trust` / website setup vs CI

- **Trusted Publisher** is saved on the **package** Settings page (or `npm trust` with npm CLI 11.15+; CLI may require account 2FA).
- **CI** does not use Google Passkey or OTP when OIDC is valid.
- **Publishing access** (token policy) is separate; OIDC works with either option, but **disallow bypass tokens** is recommended after OIDC works.

### 7. Bypass token meaning

**Bypass 2FA** on a token means CI can **publish without OTP**. It is not “disable security forever”; it is an automation credential. Prefer OIDC and revoke bootstrap tokens.

### 8. Stage-only vs direct publish

**Read and write (stage only)** lets CI stage a version; a human must **approve** (often with 2FA). Not suitable for fully automatic tag releases. Allow **`npm publish`** on the Trusted Publisher.

### 9. First publish and OIDC

Community and npm issues: **OIDC alone for a brand-new package name** often fails until the package exists. Plan **one bootstrap publish** (Bypass token in Actions), then Trusted Publisher, then remove the token.

### 10. README / docs drift

After OIDC, update **Publish** sections so new contributors do not add `NPM_TOKEN` again.

### 11. Telemetry version drift

If `OSS_SDK_VERSION` in `src/telemetry/flush.ts` does not match `package.json`, telemetry payloads report the wrong SDK version. Run `node scripts/check-sdk-version.mjs` (part of `pnpm verify`) before each release.

## Checklist for a new repo (e.g. target-supabase-sdk)

Copy and adapt:

- [ ] `package.json`: `name`, `version`, `repository.url`, `publishConfig.access`.
- [ ] `.github/workflows/release.yml`: `id-token: write`, `registry-url`, tag/version check, **npm 11.5.1+** before publish.
- [ ] Bootstrap: one publish with Bypass token **or** manual first publish if you accept OTP.
- [ ] npm: Trusted Publisher → GitHub Actions → correct **workflow filename**.
- [ ] Remove `NODE_AUTH_TOKEN` from publish; bump version; tag on commit that has the final workflow.
- [ ] Confirm npm **Valid**; revoke bootstrap token; optional tighten **Publishing access**.

## Routine release (after setup)

```bash
# Bump version in package.json, commit to main
git tag vX.Y.Z
git push origin main vX.Y.Z
```

Do not reuse a version that already exists on npm.

## Related files (this repo)

- Workflow: `.github/workflows/release.yml`
- CI on push to `main`: `.github/workflows/ci.yml`