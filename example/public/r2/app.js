import {
  bindAutoContentType,
  createResultView,
  decodeBase64UrlJson,
  readJson,
  withButtonLoading,
} from "/shared.js";

const result = createResultView({
  logEl: document.getElementById("log"),
  statusEl: document.getElementById("result-status"),
});

const credForm = document.getElementById("cred-form");
const createForm = document.getElementById("create-form");
const SECRET_FIELDS = ["accountId", "accessKeyId", "secretAccessKey"];

bindAutoContentType(createForm.elements.namedItem("file"), createForm.elements.namedItem("contentType"));

function isMaskedValue(value) {
  return !value || /^\*+$/.test(value) || value.includes("****") || value === "********";
}

function credentialsPayload() {
  const data = new FormData(credForm);
  const useEnvCredentials = Boolean(data.get("useEnvCredentials"));
  const payload = {
    providerId: String(data.get("providerId") || "").trim(),
    accountId: String(data.get("accountId") || "").trim(),
    endpoint: String(data.get("endpoint") || "").trim(),
    accessKeyId: String(data.get("accessKeyId") || "").trim(),
    secretAccessKey: String(data.get("secretAccessKey") || "").trim(),
    bucket: String(data.get("bucket") || "").trim(),
    region: String(data.get("region") || "auto").trim(),
    useEnvCredentials,
  };

  for (const key of SECRET_FIELDS) {
    if (useEnvCredentials || isMaskedValue(payload[key])) {
      payload[key] = "";
    }
  }
  return payload;
}

function applyDefaults(defaults, allowEnvCredentials = false) {
  const useEnv = credForm.elements.namedItem("useEnvCredentials");
  if (useEnv) {
    useEnv.disabled = !allowEnvCredentials;
    useEnv.checked = Boolean(allowEnvCredentials && defaults?.useEnvCredentials);
    useEnv.title = allowEnvCredentials
      ? "Use .env explicitly; endpoint/secrets are fixed by the server; request endpoint is ignored"
      : "Set EXAMPLE_ALLOW_R2=1 to use .env credentials";
  }
  for (const [key, value] of Object.entries(defaults || {})) {
    if (key === "useEnvCredentials") continue;
    const input = credForm.elements.namedItem(key);
    if (input && typeof value === "string") {
      input.value = value;
      if (SECRET_FIELDS.includes(key)) {
        input.readOnly = useEnv?.checked ?? false;
        input.title = useEnv?.checked
          ? "Redacted display; server reads real secrets from .env"
          : "";
      }
    }
  }
}

function syncSecretInputs() {
  const useEnv = credForm.elements.namedItem("useEnvCredentials")?.checked;
  for (const key of SECRET_FIELDS) {
    const input = credForm.elements.namedItem(key);
    if (!input) continue;
    input.readOnly = Boolean(useEnv);
    input.classList.toggle("masked", Boolean(useEnv) || isMaskedValue(input.value));
  }
}

async function loadDefaults() {
  const data = await readJson(await fetch("/api/r2/defaults"));
  if (!data.ok) {
    result.show(data, false);
    return;
  }
  applyDefaults(data.defaults, data.allowEnvCredentials === true);
  syncSecretInputs();
  result.show(
    {
      ok: true,
      message: data.allowEnvCredentials
        ? "Prefilled (redacted). With useEnvCredentials, endpoint/secrets come from .env"
        : "Prefilled (redacted). EXAMPLE_ALLOW_R2=1 is not set; enter credentials or enable the flag and restart",
      defaults: data.defaults,
      configured: data.configured,
      allowEnvCredentials: data.allowEnvCredentials,
      note: data.note,
    },
    true,
  );
}

credForm.elements.namedItem("useEnvCredentials")?.addEventListener("change", () => {
  syncSecretInputs();
  if (credForm.elements.namedItem("useEnvCredentials")?.checked) {
    loadDefaults().catch((error) => result.show({ ok: false, error: String(error) }, false));
  } else {
    for (const key of SECRET_FIELDS) {
      const input = credForm.elements.namedItem(key);
      if (input && isMaskedValue(input.value)) {
        input.value = "";
        input.placeholder = "Enter plaintext (this request only)";
      }
    }
  }
});

document.getElementById("reload-defaults").addEventListener("click", async (event) => {
  await withButtonLoading(event.currentTarget, () => loadDefaults(), "Prefilling…");
});

document.getElementById("probe-btn").addEventListener("click", async (event) => {
  await withButtonLoading(event.currentTarget, async () => {
    result.loading("probe…");
    const data = await readJson(
      await fetch("/api/r2/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(credentialsPayload()),
      }),
    );
    result.show(data, data.ok && data.result?.ok !== false);
  });
});

createForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = createForm.querySelector('button[type="submit"]');
  await withButtonLoading(button, async () => {
    result.loading("create…");
    const body = new FormData(createForm);
    body.set("upsert", body.get("upsert") ? "true" : "false");
    if (!String(body.get("contentType") || "").trim()) {
      body.delete("contentType");
    }
    const creds = credentialsPayload();
    for (const [key, value] of Object.entries(creds)) {
      body.set(key, String(value));
    }
    const data = await readJson(await fetch("/api/r2/create", { method: "POST", body }));
    result.show(data, data.ok);
  });
});

document.getElementById("check-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  await withButtonLoading(button, async () => {
    result.loading("checkExist…");
    const uniqueName = new FormData(form).get("uniqueName");
    const data = await readJson(
      await fetch("/api/r2/checkExist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...credentialsPayload(), uniqueName }),
      }),
    );
    result.show(data, data.ok);
  });
});

document.getElementById("get-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  await withButtonLoading(button, async () => {
    result.loading("get…");
    const uniqueName = String(new FormData(form).get("uniqueName") || "");
    const res = await fetch("/api/r2/get", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...credentialsPayload(), uniqueName, overwrite: true }),
    });
    if (!res.ok) {
      result.show(await readJson(res), false);
      return;
    }
    const header = res.headers.get("X-Oss-Sdk-Result");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = uniqueName.split("/").pop() || "download.bin";
    a.click();
    URL.revokeObjectURL(url);
    let sdkResult = null;
    if (header) {
      try {
        sdkResult = decodeBase64UrlJson(header);
      } catch {
        sdkResult = header;
      }
    }
    result.show({ ok: true, downloaded: a.download, bytes: blob.size, result: sdkResult }, true);
  }, "Downloading…");
});

document.getElementById("delete-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  await withButtonLoading(button, async () => {
    result.loading("delete…");
    const uniqueName = new FormData(form).get("uniqueName");
    const data = await readJson(
      await fetch("/api/r2/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...credentialsPayload(), uniqueName }),
      }),
    );
    result.show(data, data.ok);
  });
});

document.getElementById("clear-log").addEventListener("click", () => result.clear());

await loadDefaults();
