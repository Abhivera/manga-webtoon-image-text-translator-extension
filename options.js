import { DEFAULT_SETTINGS } from "./shared/settings.js";
import { updateProviderSections } from "./shared/ui.js";

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

async function init() {
  const s = await getSettings();
  document.getElementById("modelProvider").value = s.modelProvider || "gemini";
  document.getElementById("geminiApiKey").value = s.geminiApiKey || "";
  document.getElementById("openaiApiKey").value = s.openaiApiKey || "";
  document.getElementById("deepseekApiKey").value = s.deepseekApiKey || "";
  document.getElementById("groqApiKey").value = s.groqApiKey || "";
  document.getElementById("ollamaApiKey").value = s.ollamaApiKey || "";
  document.getElementById("ollamaBaseUrl").value = s.ollamaBaseUrl || DEFAULT_SETTINGS.ollamaBaseUrl;
  document.getElementById("glmocrApiKey").value = s.glmocrApiKey || "";
  document.getElementById("glmocrBaseUrl").value = s.glmocrBaseUrl || DEFAULT_SETTINGS.glmocrBaseUrl;
  document.getElementById("mitBaseUrl").value = s.mitBaseUrl || DEFAULT_SETTINGS.mitBaseUrl;
  document.getElementById("mitTranslator").value = s.mitTranslator || DEFAULT_SETTINGS.mitTranslator;
  document.getElementById("mitDetector").value = s.mitDetector || DEFAULT_SETTINGS.mitDetector;
  document.getElementById("mitInpainter").value = s.mitInpainter || DEFAULT_SETTINGS.mitInpainter;
  document.getElementById("sourceLanguage").value = s.sourceLanguage || "ja";
  document.getElementById("targetLanguage").value = s.targetLanguage || "en";
  document.getElementById("model").value = s.model || DEFAULT_SETTINGS.model;
  document.getElementById("compactOverlayMode").checked = Boolean(s.compactOverlayMode);
  document.getElementById("replaceTextBlocks").checked = Boolean(s.replaceTextBlocks);
  document.getElementById("autoTranslateThenEdit").checked = Boolean(s.autoTranslateThenEdit);
  document.getElementById("inPlaceMode").checked = Boolean(s.inPlaceMode);
  updateProviderSections(s.modelProvider || "gemini", s.model);
}

async function save() {
  const payload = {
    modelProvider: document.getElementById("modelProvider").value,
    geminiApiKey: document.getElementById("geminiApiKey").value.trim(),
    openaiApiKey: document.getElementById("openaiApiKey").value.trim(),
    deepseekApiKey: document.getElementById("deepseekApiKey").value.trim(),
    groqApiKey: document.getElementById("groqApiKey").value.trim(),
    ollamaApiKey: document.getElementById("ollamaApiKey").value.trim(),
    ollamaBaseUrl: document.getElementById("ollamaBaseUrl").value.trim() || DEFAULT_SETTINGS.ollamaBaseUrl,
    glmocrApiKey: document.getElementById("glmocrApiKey").value.trim(),
    glmocrBaseUrl: document.getElementById("glmocrBaseUrl").value.trim() || DEFAULT_SETTINGS.glmocrBaseUrl,
    mitBaseUrl: document.getElementById("mitBaseUrl").value.trim() || DEFAULT_SETTINGS.mitBaseUrl,
    mitTranslator: document.getElementById("mitTranslator").value,
    mitDetector: document.getElementById("mitDetector").value,
    mitInpainter: document.getElementById("mitInpainter").value,
    sourceLanguage: document.getElementById("sourceLanguage").value,
    targetLanguage: document.getElementById("targetLanguage").value,
    model: document.getElementById("model").value,
    compactOverlayMode: document.getElementById("compactOverlayMode").checked,
    replaceTextBlocks: document.getElementById("replaceTextBlocks").checked,
    autoTranslateThenEdit: document.getElementById("autoTranslateThenEdit").checked,
    inPlaceMode: document.getElementById("inPlaceMode").checked,
  };
  await setSettings(payload);
  const status = document.getElementById("status");
  status.textContent = "Saved";
  setTimeout(() => (status.textContent = ""), 1200);
}

document.getElementById("save").addEventListener("click", save);
document.getElementById("modelProvider").addEventListener("change", (e) => {
  updateProviderSections(e.target.value);
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
