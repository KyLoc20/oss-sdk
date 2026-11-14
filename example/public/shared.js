export function decodeBase64UrlJson(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return JSON.parse(atob(padded + pad));
}

export async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: { message: text || `HTTP ${res.status}`, code: "HTTP_ERROR" } };
  }
}

export function createResultView({ logEl, statusEl }) {
  return {
    show(payload, ok = payload?.ok !== false) {
      statusEl.textContent = ok ? "OK" : "ERROR";
      statusEl.classList.toggle("ok", ok);
      statusEl.classList.remove("loading");
      statusEl.classList.toggle("fail", !ok);
      logEl.textContent = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
    },
    loading(message = "Requesting…") {
      statusEl.textContent = "LOADING";
      statusEl.classList.remove("ok", "fail");
      statusEl.classList.add("loading");
      logEl.textContent = message;
    },
    clear() {
      statusEl.textContent = "IDLE";
      statusEl.classList.remove("ok", "fail", "loading");
      logEl.textContent = "Results from calls on the left show here.";
    },
  };
}

/** Disable control and show loading label while fn runs. */
export async function withButtonLoading(button, fn, loadingText = "Working…") {
  if (!button) {
    return fn();
  }
  const original = button.textContent;
  const busy = button.getAttribute("data-loading") === "1";
  if (busy) {
    return undefined;
  }
  button.setAttribute("data-loading", "1");
  button.disabled = true;
  button.classList.add("is-loading");
  button.textContent = loadingText;
  try {
    return await fn();
  } finally {
    button.removeAttribute("data-loading");
    button.disabled = false;
    button.classList.remove("is-loading");
    button.textContent = original;
  }
}

/** Wire file input → contentType input (browser MIME). Manual override still allowed. */
export function bindAutoContentType(fileInput, contentTypeInput) {
  if (!fileInput || !contentTypeInput) {
    return;
  }
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (!file) {
      return;
    }
    // Only autofill when empty or previously autofilled.
    const wasAuto = contentTypeInput.dataset.autofilled === "1";
    if (!contentTypeInput.value || wasAuto) {
      contentTypeInput.value = file.type || guessMimeFromName(file.name) || "";
      contentTypeInput.dataset.autofilled = "1";
      contentTypeInput.placeholder = contentTypeInput.value
        ? contentTypeInput.value
        : "Not detected; enter manually";
    }
  });
  contentTypeInput.addEventListener("input", () => {
    contentTypeInput.dataset.autofilled = "0";
  });
}

function guessMimeFromName(name) {
  const ext = String(name).split(".").pop()?.toLowerCase();
  const map = {
    txt: "text/plain",
    json: "application/json",
    html: "text/html",
    css: "text/css",
    js: "text/javascript",
    mjs: "text/javascript",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    mp4: "video/mp4",
    webm: "video/webm",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    pdf: "application/pdf",
    zip: "application/zip",
  };
  return ext ? map[ext] : "";
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function escapeAttr(value) {
  return escapeHtml(value).replaceAll("'", "&#39;");
}
