// Background service worker (Manifest V3)
import {
  DEFAULT_SETTINGS,
  DEFAULT_MODEL_BY_PROVIDER,
  requiresApiKey,
  normalizeBaseUrl,
  buildMITConfig,
  mapLangToMIT,
  getLanguageLabel,
} from "./shared/settings.js";

const tabEnabledState = new Map();

function clearTabBadge(tabId) {
  try {
    chrome.action.setBadgeText({ tabId, text: "" });
  } catch {}
}

function isTabEnabled(tabId) {
  return tabEnabledState.get(tabId) || false;
}

function setTabEnabled(tabId, enabled) {
  if (enabled) {
    tabEnabledState.set(tabId, true);
    setActiveTabBadge(tabId);
  } else {
    tabEnabledState.delete(tabId);
    clearTabBadge(tabId);
  }
}

function setActiveTabBadge(tabId) {
  try {
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#0284c7" });
    chrome.action.setBadgeText({ tabId, text: "★" });
  } catch {}
}

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULT_SETTINGS, resolve);
  });
}

function setSettings(partial) {
  return new Promise((resolve) => {
    chrome.storage.local.set(partial, resolve);
  });
}

async function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBlob(base64, mime) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime || "image/png" });
}

async function fetchImageAsBase64(url) {
  const response = await fetch(url, { mode: "cors", credentials: "omit" });
  if (!response.ok) {
    throw new Error(
      `Image fetch failed: ${response.status} ${response.statusText}`
    );
  }
  const buffer = await response.arrayBuffer();
  const mime = response.headers.get("content-type") || "image/jpeg";
  return { base64: await arrayBufferToBase64(buffer), mime };
}

async function resolveImagePayload({ url, inlineBase64, inlineMime, tabId, elementRect, pageScale }) {
  if (inlineBase64) {
    return { base64: inlineBase64, mime: inlineMime || "image/png" };
  }
  try {
    return await fetchImageAsBase64(url);
  } catch (e) {
    if (!tabId || !elementRect) throw e;
    const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: "png" });
    const cropResp = await chrome.tabs.sendMessage(tabId, {
      type: "MT_CROP_SCREENSHOT",
      payload: { dataUrl, elementRect, pageScale },
    });
    if (!cropResp?.ok) throw e;
    return { base64: cropResp.base64, mime: "image/png" };
  }
}

function buildPrompt(sourceLanguage, targetLanguage) {
  const srcLabel =
    sourceLanguage === "auto"
      ? "the source language (auto-detect from the image)"
      : getLanguageLabel(sourceLanguage);
  const tgtLabel = getLanguageLabel(targetLanguage);
  return (
    `You are a professional manga/comic OCR and translation assistant.\n` +
    `Task: detect every speech bubble, caption, and on-image text block, then translate into ${tgtLabel}.\n` +
    `Source language: ${srcLabel}.\n\n` +
    `Rules:\n` +
    `- One JSON entry per distinct text block (each bubble or caption is separate).\n` +
    `- Bounding boxes must tightly cover ONLY the text area inside the bubble, not the bubble border or artwork.\n` +
    `- Preserve natural manga reading order (top-to-bottom, right-to-left for Japanese; top-to-bottom, left-to-right for English/Korean).\n` +
    `- Translate dialogue naturally for manga (keep tone, honorifics where appropriate, concise phrasing for bubbles).\n` +
    `- For vertical text blocks, set "direction":"vertical"; otherwise "direction":"horizontal".\n` +
    `- Use ellipsis (…) for trailing off speech; keep punctuation natural in ${tgtLabel}.\n\n` +
    `Return STRICT JSON only (no markdown, no commentary):\n` +
    `{"texts":[{"source":"original text","translation":"translated text","x":0,"y":0,"width":0,"height":0,"direction":"horizontal"}]}\n` +
    `Coordinates are percentages (0-100) from the top-left of the image.\n` +
    `Include ALL visible text blocks with accurate boxes.`
  );
}

async function callOpenAICompatible({
  providerName,
  url,
  apiKey,
  model,
  base64,
  mime,
  sourceLanguage,
  targetLanguage,
  maxTokens = 4096,
}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: buildPrompt(sourceLanguage, targetLanguage) },
            {
              type: "image_url",
              image_url: { url: `data:${mime};base64,${base64}`, detail: "high" },
            },
          ],
        },
      ],
      max_tokens: maxTokens,
      temperature: 0.1,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `${providerName} request failed: ${response.status} ${response.statusText} ${text}`
    );
  }

  const data = await response.json();
  return parseVisionResponse(data?.choices?.[0]?.message?.content || "");
}

async function callGeminiVision({ apiKey, model, base64, mime, sourceLanguage, targetLanguage }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: buildPrompt(sourceLanguage, targetLanguage) },
            { inline_data: { mime_type: mime, data: base64 } },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        topK: 32,
        topP: 1,
        maxOutputTokens: 4096,
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Gemini request failed: ${response.status} ${response.statusText} ${text}`
    );
  }

  const data = await response.json();
  return parseVisionResponse(data?.candidates?.[0]?.content?.parts?.[0]?.text || "");
}

async function callOllama({ model, base64, sourceLanguage, targetLanguage, baseUrl, apiKey }) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const response = await fetch(`${normalizeBaseUrl(baseUrl, DEFAULT_SETTINGS.ollamaBaseUrl)}/api/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        { role: "user", content: buildPrompt(sourceLanguage, targetLanguage), images: [base64] },
      ],
      options: { temperature: 0.1 },
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Ollama request failed: ${response.status} ${response.statusText} ${text}`
    );
  }

  const data = await response.json();
  return parseVisionResponse(data?.message?.content || "");
}

async function callGlmOcr({ model, base64, mime, sourceLanguage, targetLanguage, baseUrl, apiKey }) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const response = await fetch(
    `${normalizeBaseUrl(baseUrl, DEFAULT_SETTINGS.glmocrBaseUrl)}/v1/chat/completions`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: model || "zai-org/GLM-OCR",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: buildPrompt(sourceLanguage, targetLanguage) },
              { type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } },
            ],
          },
        ],
        max_tokens: 4096,
        temperature: 0.1,
      }),
    }
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `GLM-OCR request failed: ${response.status} ${response.statusText} ${text}`
    );
  }

  const data = await response.json();
  return parseVisionResponse(data?.choices?.[0]?.message?.content || "");
}

function convertMITJsonToExtensionFormat(mitData, imgWidth, imgHeight, targetLanguage) {
  const targetMIT = mapLangToMIT(targetLanguage);
  const w = Math.max(1, Number(imgWidth) || 1);
  const h = Math.max(1, Number(imgHeight) || 1);

  const texts = (mitData?.translations || [])
    .map((item) => {
      const textMap = item?.text || {};
      const translation = String(textMap[targetMIT] || "");
      const sourceKey =
        Object.keys(textMap).find((k) => k !== targetMIT) || Object.keys(textMap)[0] || "";
      const minX = Number(item.minX) || 0;
      const minY = Number(item.minY) || 0;
      const maxX = Number(item.maxX) || minX;
      const maxY = Number(item.maxY) || minY;
      return {
        source: String(textMap[sourceKey] || ""),
        translation,
        x: (minX / w) * 100,
        y: (minY / h) * 100,
        width: ((maxX - minX) / w) * 100,
        height: ((maxY - minY) / h) * 100,
      };
    })
    .filter((t) => t.translation.length > 0);

  return { texts };
}

async function callMIT({ settings, base64, mime, targetLanguage, inPlaceMode }) {
  const baseUrl = normalizeBaseUrl(settings.mitBaseUrl, DEFAULT_SETTINGS.mitBaseUrl);
  const blob = base64ToBlob(base64, mime);
  const formData = new FormData();
  formData.append("image", blob, "image.png");
  formData.append("config", JSON.stringify(buildMITConfig(settings, targetLanguage)));

  const endpoint = inPlaceMode ? "/translate/with-form/image" : "/translate/with-form/json";
  const response = await fetch(`${baseUrl}${endpoint}`, { method: "POST", body: formData });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Manga Image Translator request failed: ${response.status} ${response.statusText} ${text}`
    );
  }

  if (inPlaceMode) {
    return {
      translatedImageBase64: await arrayBufferToBase64(await response.arrayBuffer()),
      mime: "image/png",
    };
  }

  const data = await response.json();
  let imgWidth = 1;
  let imgHeight = 1;
  try {
    const bitmap = await createImageBitmap(blob);
    imgWidth = bitmap.width;
    imgHeight = bitmap.height;
    bitmap.close();
  } catch {}
  return convertMITJsonToExtensionFormat(data, imgWidth, imgHeight, targetLanguage);
}

function extractFirstJsonObject(text) {
  const src = String(text || "");
  const start = src.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

function parseTextLinesFallback(content) {
  const lines = String(content || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const candidates = [];
  for (const line of lines) {
    if (line.length < 2) continue;
    const cleaned = line.replace(/^[-*•\d\).\s]+/, "").replace(/^"(.*)"$/, "$1").trim();
    if (cleaned.length >= 2) candidates.push(cleaned);
  }
  return [...new Set(candidates)].slice(0, 20).map((translation, i) => ({
    source: "",
    translation,
    x: 3,
    y: Math.min(92, 4 + i * 8),
    width: 94,
    height: 8,
  }));
}

function parseVisionResponse(content) {
  const raw = String(content || "").trim();
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch {}
  if (!parsed) {
    const firstObj = extractFirstJsonObject(raw);
    if (firstObj) {
      try { parsed = JSON.parse(firstObj); } catch {}
    }
  }

  if (Array.isArray(parsed)) parsed = { texts: parsed };
  if (!parsed || !Array.isArray(parsed.texts)) parsed = { texts: [] };
  parsed.texts = parsed.texts.flat(Infinity);

  const toPercent = (value) => {
    const num = Number(value);
    return Number.isFinite(num) ? Math.max(0, Math.min(100, num)) : null;
  };

  const normalized = parsed.texts
    .map((t) => {
      const x = toPercent(t?.x ?? t?.left);
      const y = toPercent(t?.y ?? t?.top);
      const width = toPercent(t?.width ?? t?.w);
      const height = toPercent(t?.height ?? t?.h);
      const hasBox = x != null && y != null && width != null && height != null;
      const safeWidth = hasBox ? Math.min(width, Math.max(0, 100 - x)) : 0;
      const safeHeight = hasBox ? Math.min(height, Math.max(0, 100 - y)) : 0;
      const validBox = safeWidth > 0.25 && safeHeight > 0.25;
      return {
        source: String(t?.source || t?.japanese || t?.original || t?.text || ""),
        translation: String(t?.translation || t?.english || t?.translated || ""),
        direction: t?.direction === "vertical" ? "vertical" : "horizontal",
        x: validBox ? x : 0,
        y: validBox ? y : 0,
        width: validBox ? safeWidth : 0,
        height: validBox ? safeHeight : 0,
      };
    })
    .filter((t) => t.translation.length > 0);

  if (normalized.length > 0) {
    return {
      texts: normalized.map((t, i) => ({
        ...t,
        width: t.width > 0 ? t.width : 90,
        height: t.height > 0 ? t.height : 8,
        y: Number.isFinite(t.y) ? t.y : Math.min(92, 4 + i * 8),
      })),
    };
  }

  return { texts: parseTextLinesFallback(raw) };
}

async function callAIModel(settings, base64, mime, sourceLanguage, targetLanguage) {
  const { modelProvider } = settings;
  const apiKey = settings[`${modelProvider}ApiKey`];
  const model = settings.model || DEFAULT_MODEL_BY_PROVIDER[modelProvider] || DEFAULT_SETTINGS.model;

  if (requiresApiKey(modelProvider) && !apiKey) {
    throw new Error(`Missing ${modelProvider.toUpperCase()} API key. Set it in the Settings.`);
  }

  switch (modelProvider) {
    case "gemini":
      return callGeminiVision({ apiKey, model, base64, mime, sourceLanguage, targetLanguage });
    case "openai":
      return callOpenAICompatible({
        providerName: "OpenAI",
        url: "https://api.openai.com/v1/chat/completions",
        apiKey, model, base64, mime, sourceLanguage, targetLanguage,
      });
    case "deepseek":
      return callOpenAICompatible({
        providerName: "DeepSeek",
        url: "https://api.deepseek.com/chat/completions",
        apiKey, model, base64, mime, sourceLanguage, targetLanguage,
      });
    case "groq":
      return callOpenAICompatible({
        providerName: "Groq",
        url: "https://api.groq.com/openai/v1/chat/completions",
        apiKey, model, base64, mime, sourceLanguage, targetLanguage,
      });
    case "ollama":
      return callOllama({
        apiKey, model, base64, sourceLanguage, targetLanguage,
        baseUrl: settings.ollamaBaseUrl || DEFAULT_SETTINGS.ollamaBaseUrl,
      });
    case "glmocr":
      return callGlmOcr({
        apiKey, model, base64, mime, sourceLanguage, targetLanguage,
        baseUrl: settings.glmocrBaseUrl || DEFAULT_SETTINGS.glmocrBaseUrl,
      });
    case "mit":
      return callMIT({
        settings, base64, mime, targetLanguage,
        inPlaceMode: Boolean(settings.inPlaceMode),
      });
    default:
      throw new Error(`Unsupported model provider: ${modelProvider}`);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  for (const [id, title, contexts] of [
    ["translate-image", "Translate image", ["image"]],
    ["translate-all-images", "Translate all images on page", ["page"]],
  ]) {
    try {
      chrome.contextMenus.create({ id, title, contexts });
    } catch {}
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTabBadge(tabId);
  tabEnabledState.delete(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type) return;

  switch (message.type) {
    case "GET_SETTINGS":
      getSettings().then(sendResponse);
      return true;
    case "GET_TAB_ENABLED":
      sendResponse({ ok: true, enabled: isTabEnabled(sender?.tab?.id) });
      return;
    case "SET_TAB_ENABLED": {
      const tabId = sender?.tab?.id;
      setTabEnabled(tabId, Boolean(message.enabled));
      sendResponse({ ok: true, enabled: isTabEnabled(tabId) });
      return;
    }
    case "SET_SETTINGS":
      setSettings(message.payload || {}).then(() => sendResponse({ ok: true }));
      return true;
    case "TRANSLATE_IMAGE":
    case "TRANSLATE_REGION":
      (async () => {
        try {
          const settings = await getSettings();
          const { modelProvider } = settings;
          if (requiresApiKey(modelProvider) && !settings[`${modelProvider}ApiKey`]) {
            throw new Error(`Missing ${modelProvider.toUpperCase()} API key. Set it in the Settings.`);
          }

          const tabId = message.payload.tabId || sender?.tab?.id;
          let base64;
          let mime = "image/png";

          if (message.type === "TRANSLATE_REGION") {
            const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: "png" });
            const cropResp = await chrome.tabs.sendMessage(tabId, {
              type: "MT_CROP_SCREENSHOT",
              payload: {
                dataUrl,
                elementRect: message.payload.elementRect,
                pageScale: message.payload.pageScale,
              },
            });
            if (!cropResp?.ok) throw new Error(cropResp?.error || "Screenshot crop failed");
            base64 = cropResp.base64;
            const result = await callAIModel(
              settings,
              base64,
              mime,
              message.payload.overrideSourceLanguage || settings.sourceLanguage,
              message.payload.overrideTargetLanguage || settings.targetLanguage
            );
            sendResponse({ ok: true, result, cropBase64: base64 });
            return;
          }

          const resolved = await resolveImagePayload({
            ...message.payload,
            tabId,
          });
          base64 = resolved.base64;
          mime = resolved.mime;

          const result = await callAIModel(
            settings,
            base64,
            mime,
            message.payload.overrideSourceLanguage || settings.sourceLanguage,
            message.payload.overrideTargetLanguage || settings.targetLanguage
          );
          sendResponse({ ok: true, result });
        } catch (err) {
          sendResponse({ ok: false, error: String(err?.message || err) });
        }
      })();
      return true;
    default:
      return;
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;

  if (info.menuItemId === "translate-image" && info.srcUrl) {
    try {
      const settings = await getSettings();
      const { modelProvider } = settings;
      if (requiresApiKey(modelProvider) && !settings[`${modelProvider}ApiKey`]) {
        await chrome.tabs.sendMessage(tab.id, {
          type: "MT_NOTIFY",
          payload: { message: `Set ${modelProvider.toUpperCase()} API key in Settings` },
        });
        return;
      }

      const { base64, mime } = await fetchImageAsBase64(info.srcUrl);
      const result = await callAIModel(
        settings,
        base64,
        mime,
        settings.sourceLanguage,
        settings.targetLanguage
      );
      await chrome.tabs.sendMessage(tab.id, {
        type: "MT_TRANSLATE_RESULT",
        payload: { url: info.srcUrl, result },
      });
    } catch (err) {
      try {
        await chrome.tabs.sendMessage(tab.id, {
          type: "MT_NOTIFY",
          payload: { message: `Translate failed: ${String(err?.message || err)}` },
        });
      } catch {}
    }
    return;
  }

  if (info.menuItemId === "translate-all-images") {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "MT_TRANSLATE_ALL_NOW" });
    } catch {}
  }
});
