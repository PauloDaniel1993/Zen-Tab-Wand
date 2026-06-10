// Zen Tab Wand - DeepSeek HTTP transport layer.
//
// DeepSeek exposes an OpenAI-compatible chat completions API. This wrapper
// keeps API-key handling, timeout behavior, health checks, and JSON parsing out
// of the classifier orchestration.

import { CONFIG, LOG } from "./config.mjs";
import { showToast } from "./ui-toast.mjs";

const PING_TIMEOUT_MS = 5000;
const GENERATE_TIMEOUT_MS = 180000;

export const normalizeDeepSeekBaseUrl = (baseUrl) => {
  let h = (baseUrl || "").trim();
  if (!h) h = CONFIG.AI_DEEPSEEK_BASE_URL_DEFAULT;
  if (!/^https?:\/\//i.test(h)) h = "https://" + h;
  return h.replace(/\/+$/, "");
};

const fetchWithTimeout = async (url, opts = {}, timeoutMs = PING_TIMEOUT_MS) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

export const checkDeepSeekReady = async (baseUrl, apiKey, model) => {
  if (!apiKey) {
    return { reachable: false, authenticated: false, modelAvailable: false, error: "missing API key" };
  }

  const base = normalizeDeepSeekBaseUrl(baseUrl);
  try {
    const res = await fetchWithTimeout(
      `${base}/models`,
      {
        cache: "no-store",
        headers: { Authorization: `Bearer ${apiKey}` },
      },
      PING_TIMEOUT_MS
    );
    if (res.status === 401 || res.status === 403) {
      return { reachable: true, authenticated: false, modelAvailable: false, error: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { reachable: false, authenticated: false, modelAvailable: false, error: `HTTP ${res.status}` };
    }

    const data = await res.json();
    const models = Array.isArray(data?.data) ? data.data : [];
    const have = models.map((m) => String(m?.id || "").toLowerCase()).filter(Boolean);
    const target = String(model || "").trim().toLowerCase();
    const found = !target || have.includes(target);
    return { reachable: true, authenticated: true, modelAvailable: found, availableModels: have };
  } catch (e) {
    return {
      reachable: false,
      authenticated: false,
      modelAvailable: false,
      error: e.name === "AbortError" ? `timeout after ${PING_TIMEOUT_MS}ms` : (e.message || String(e)),
    };
  }
};

export const deepseekGenerateJson = async (baseUrl, apiKey, model, prompt) => {
  const base = normalizeDeepSeekBaseUrl(baseUrl);
  let res;
  try {
    res = await fetchWithTimeout(
      `${base}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "system",
              content: "Return only valid JSON. Do not include markdown, explanations, or prose.",
            },
            { role: "user", content: prompt },
          ],
          stream: false,
          response_format: { type: "json_object" },
          max_tokens: 8192,
          thinking: { type: "disabled" },
        }),
      },
      GENERATE_TIMEOUT_MS
    );
  } catch (e) {
    return {
      ok: false,
      errorType: "network",
      error: e.name === "AbortError" ? `timeout after ${GENERATE_TIMEOUT_MS}ms` : (e.message || String(e)),
    };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, errorType: "http", error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
  }

  const data = await res.json();
  const text = String(data?.choices?.[0]?.message?.content || "").trim();
  if (!text) {
    return { ok: false, errorType: "empty", error: "DeepSeek returned empty response" };
  }
  try {
    return { ok: true, parsed: JSON.parse(text) };
  } catch {
    return { ok: false, errorType: "parse", error: `Invalid JSON: ${text.slice(0, 200)}` };
  }
};

export const reportDeepSeekError = (baseUrl, model, status) => {
  const base = normalizeDeepSeekBaseUrl(baseUrl);
  if (!status.authenticated && status.error === "missing API key") {
    const msg = "DeepSeek API key is missing. Add it in Zen Tab Wand settings.";
    console.warn(`${LOG} ${msg}`);
    showToast(msg);
    return;
  }
  if (!status.reachable) {
    const msg = `DeepSeek not reachable at ${base} (${status.error || "unknown error"})`;
    console.warn(`${LOG} ${msg}`);
    showToast(msg);
    return;
  }
  if (!status.authenticated) {
    const msg = `DeepSeek rejected the API key (${status.error || "authentication failed"})`;
    console.warn(`${LOG} ${msg}`);
    showToast(msg);
    return;
  }
  if (!status.modelAvailable) {
    const have = (status.availableModels || []).join(", ") || "(no models returned)";
    const msg = `DeepSeek model "${model}" was not listed by ${base}`;
    console.warn(`${LOG} ${msg} - available models: ${have}`);
    showToast(msg);
  }
};
