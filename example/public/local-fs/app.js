import {
  bindAutoContentType,
  createResultView,
  decodeBase64UrlJson,
  escapeAttr,
  escapeHtml,
  readJson,
  withButtonLoading,
} from "/shared.js";

const result = createResultView({
  logEl: document.getElementById("log"),
  statusEl: document.getElementById("result-status"),
});

const metaEl = document.getElementById("meta");
const objectsEl = document.getElementById("objects");
const createForm = document.getElementById("create-form");

bindAutoContentType(createForm.elements.namedItem("file"), createForm.elements.namedItem("contentType"));

function fillUniqueName(uniqueName) {
  for (const form of document.querySelectorAll("form")) {
    const input = form.elements.namedItem("uniqueName");
    if (input) input.value = uniqueName;
  }
}

async function loadMeta() {
  const data = await readJson(await fetch("/api/local-fs/meta"));
  if (!data.ok) {
    metaEl.textContent = data.error?.message ?? "meta failed";
    return;
  }
  const probe = data.probe?.ok ? "probe ok" : `probe fail: ${data.probe?.error ?? "?"}`;
  metaEl.textContent = `${data.provider.id} · ${data.provider.rootDir} · ${probe}`;
}

async function loadObjects() {
  const data = await readJson(await fetch("/api/local-fs/objects"));
  if (!data.ok) {
    objectsEl.innerHTML = `<p class="hint">${escapeHtml(data.error?.message ?? "failed")}</p>`;
    return;
  }
  if (!data.objects.length) {
    objectsEl.innerHTML = `<p class="hint">No objects</p>`;
    return;
  }
  objectsEl.innerHTML = data.objects
    .map(
      (obj) => `
      <article class="object">
        <div>
          <strong>${escapeHtml(obj.uniqueName)}</strong>
          <div class="object-meta">${obj.size} bytes · ${escapeHtml(obj.lastModified)}</div>
        </div>
        <button type="button" data-fill="${escapeAttr(obj.uniqueName)}">Fill</button>
      </article>`,
    )
    .join("");
}

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
    const data = await readJson(await fetch("/api/local-fs/create", { method: "POST", body }));
    result.show(data, data.ok);
    await loadObjects();
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
      await fetch("/api/local-fs/checkExist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uniqueName }),
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
    const res = await fetch("/api/local-fs/get", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uniqueName, overwrite: true }),
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
      await fetch("/api/local-fs/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uniqueName }),
      }),
    );
    result.show(data, data.ok);
    await loadObjects();
  });
});

document.getElementById("refresh-objects").addEventListener("click", async (event) => {
  await withButtonLoading(event.currentTarget, () => loadObjects(), "Refreshing…");
});
document.getElementById("clear-log").addEventListener("click", () => result.clear());
objectsEl.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-fill]");
  if (button) fillUniqueName(button.getAttribute("data-fill") || "");
});

await loadMeta();
await loadObjects();
