export const DEFAULT_SETTINGS = {
  modelProvider: "gemini",
  geminiApiKey: "",
  openaiApiKey: "",
  deepseekApiKey: "",
  groqApiKey: "",
  ollamaApiKey: "",
  ollamaBaseUrl: "http://localhost:11434",
  glmocrApiKey: "",
  glmocrBaseUrl: "http://localhost:8080",
  mitBaseUrl: "http://localhost:5003",
  mitTranslator: "youdao",
  mitDetector: "default",
  mitInpainter: "lama_large",
  mitDetectionSize: 2048,
  mitInpaintingSize: 2048,
  sourceLanguage: "ja",
  targetLanguage: "en",
  model: "gemini-1.5-flash",
  compactOverlayMode: false,
  replaceTextBlocks: true,
  autoTranslateThenEdit: true,
  inPlaceMode: true,
};

export const DEFAULT_MODEL_BY_PROVIDER = {
  gemini: "gemini-1.5-flash",
  openai: "gpt-4o-mini",
  deepseek: "deepseek-chat",
  groq: "llama-3.2-11b-vision-preview",
  ollama: "llava:latest",
  glmocr: "zai-org/GLM-OCR",
  mit: "manga-image-translator",
};

export const LOCAL_PROVIDERS = new Set(["ollama", "glmocr", "mit"]);

export const PROVIDER_LABELS = {
  gemini: "Gemini",
  openai: "OpenAI",
  deepseek: "DeepSeek",
  groq: "Groq",
  ollama: "Ollama",
  glmocr: "GLM-OCR",
  mit: "Manga Image Translator",
};

export const EXTENSION_TO_MIT_LANG = {
  en: "ENG",
  ja: "JPN",
  ko: "KOR",
  zh: "CHS",
  "zh-TW": "CHT",
  es: "ESP",
  fr: "FRA",
  de: "DEU",
  pt: "PTB",
  auto: "ENG",
};

export const LANGUAGE_LABELS = {
  auto: "the detected source language",
  en: "English",
  ja: "Japanese",
  ko: "Korean",
  zh: "Simplified Chinese",
  "zh-TW": "Traditional Chinese",
  es: "Spanish",
  fr: "French",
  de: "German",
  pt: "Portuguese (Brazil)",
};

export function getLanguageLabel(code) {
  const key = String(code || "").trim();
  return LANGUAGE_LABELS[key] || LANGUAGE_LABELS[key.toLowerCase()] || key || "English";
}

export function requiresApiKey(provider) {
  return !LOCAL_PROVIDERS.has(provider);
}

export function normalizeBaseUrl(url, fallback) {
  const raw = String(url || "").trim();
  if (!raw) return fallback;
  return raw.replace(/\/+$/, "");
}

export function mapLangToMIT(lang) {
  const key = String(lang || "").trim();
  return EXTENSION_TO_MIT_LANG[key] || EXTENSION_TO_MIT_LANG[key.toLowerCase()] || "ENG";
}

export function buildMITConfig(settings, targetLanguage) {
  return {
    detector: {
      detector: settings.mitDetector || "default",
      detection_size: Number(settings.mitDetectionSize) || 2048,
    },
    render: { direction: "auto" },
    translator: {
      translator: settings.mitTranslator || "youdao",
      target_lang: mapLangToMIT(targetLanguage),
    },
    inpainter: {
      inpainter: settings.mitInpainter || "lama_large",
      inpainting_size: Number(settings.mitInpaintingSize) || 2048,
    },
    mask_dilation_offset: 20,
  };
}
