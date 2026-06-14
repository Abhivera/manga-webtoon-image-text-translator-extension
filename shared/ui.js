import { DEFAULT_MODEL_BY_PROVIDER } from "./settings.js";

const PROVIDER_SECTION_IDS = {
  gemini: "geminiApiSection",
  openai: "openaiApiSection",
  deepseek: "deepseekApiSection",
  groq: "groqApiSection",
  ollama: "ollamaApiSection",
  glmocr: "glmocrApiSection",
  mit: "mitApiSection",
};

export function updateProviderSections(provider, preferredModel) {
  const modelSelect = document.getElementById("model");
  for (const [key, id] of Object.entries(PROVIDER_SECTION_IDS)) {
    const el = document.getElementById(id);
    if (el) el.style.display = key === provider ? "block" : "none";
  }

  if (!modelSelect) return;

  for (const option of modelSelect.options) {
    const p = option.getAttribute("data-provider");
    if (p) option.style.display = p === provider ? "block" : "none";
  }

  const defaultModel = DEFAULT_MODEL_BY_PROVIDER[provider] || "gemini-1.5-flash";
  const preferredOption = preferredModel
    ? modelSelect.querySelector(`option[data-provider="${provider}"][value="${preferredModel}"]`)
    : null;
  modelSelect.value = preferredOption ? preferredModel : defaultModel;
}
