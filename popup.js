import {
  DEFAULT_SETTINGS,
  PROVIDER_LABELS,
  requiresApiKey,
} from "./shared/settings.js";
import { updateProviderSections } from "./shared/ui.js";

function getActive(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "MT_GET_ACTIVE" }, (resp) => {
      resolve(!chrome.runtime.lastError && Boolean(resp?.active));
    });
  });
}

function setActive(tabId, active) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "MT_SET_ACTIVE", active }, (resp) => {
      resolve(!chrome.runtime.lastError && Boolean(resp?.active));
    });
  });
}

function getContinuous(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "MT_GET_CONTINUOUS" }, (resp) => {
      resolve(!chrome.runtime.lastError && Boolean(resp?.ok && resp.enabled));
    });
  });
}

function setContinuous(tabId, enabled) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "MT_SET_CONTINUOUS", enabled }, (resp) => {
      resolve(chrome.runtime.lastError ? { ok: false } : resp || { ok: false });
    });
  });
}

function getStoredSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULT_SETTINGS, resolve);
  });
}

function updateApiWarning(apiWarning, settings, provider) {
  if (!apiWarning) return;
  if (!requiresApiKey(provider) || settings[`${provider}ApiKey`]?.trim()) {
    apiWarning.textContent = "";
    apiWarning.classList.remove("show");
    return;
  }
  apiWarning.textContent = `${PROVIDER_LABELS[provider] || provider} API key is missing. Add it in Settings before translating.`;
  apiWarning.classList.add("show");
}

function ensureContentScript(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "MT_GET_ACTIVE" }, async (resp) => {
      if (chrome.runtime.lastError) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ["content.js"],
          });
          setTimeout(() => resolve(true), 150);
        } catch (e) {
          resolve(false);
        }
      } else {
        resolve(true);
      }
    });
  });
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const currentSettings = await getStoredSettings();

  const toggleInput = document.getElementById("toggleActive");
  const toggleStateText = document.getElementById("toggleStateText");
  const translateOnceBtn = document.getElementById("translateOnce");
  const translateContinuousBtn = document.getElementById("translateContinuous");
  const modelProviderSelect = document.getElementById("modelProvider");
  const saveBtn = document.getElementById("saveSettings");
  const saveStatus = document.getElementById("saveStatus");
  const apiWarning = document.getElementById("apiWarning");

  const inputs = {
    geminiApiKey: document.getElementById("geminiApiKey"),
    openaiApiKey: document.getElementById("openaiApiKey"),
    deepseekApiKey: document.getElementById("deepseekApiKey"),
    groqApiKey: document.getElementById("groqApiKey"),
    ollamaApiKey: document.getElementById("ollamaApiKey"),
    ollamaBaseUrl: document.getElementById("ollamaBaseUrl"),
    glmocrApiKey: document.getElementById("glmocrApiKey"),
    glmocrBaseUrl: document.getElementById("glmocrBaseUrl"),
    mitBaseUrl: document.getElementById("mitBaseUrl"),
    mitTranslator: document.getElementById("mitTranslator"),
    sourceLanguage: document.getElementById("sourceLanguage"),
    targetLanguage: document.getElementById("targetLanguage"),
    model: document.getElementById("model"),
    compactOverlayMode: document.getElementById("compactOverlayMode"),
    replaceTextBlocks: document.getElementById("replaceTextBlocks"),
    autoTranslateThenEdit: document.getElementById("autoTranslateThenEdit"),
    inPlaceMode: document.getElementById("inPlaceMode"),
  };

  function setToggleUi(on) {
    if (toggleInput) toggleInput.checked = Boolean(on);
    if (toggleStateText) toggleStateText.textContent = on ? "On" : "Off";
  }

  function setContinuousUi(on) {
    if (!translateContinuousBtn) return;
    translateContinuousBtn.textContent = on
      ? "Translate as I Scroll: On"
      : "Translate as I Scroll: Off";
    translateContinuousBtn.classList.remove("btn-red", "btn-green");
    translateContinuousBtn.classList.add(on ? "btn-green" : "btn-red");
  }

  function readFormSnapshot() {
    return {
      modelProvider: modelProviderSelect?.value || "gemini",
      geminiApiKey: inputs.geminiApiKey?.value.trim() || "",
      openaiApiKey: inputs.openaiApiKey?.value.trim() || "",
      deepseekApiKey: inputs.deepseekApiKey?.value.trim() || "",
      groqApiKey: inputs.groqApiKey?.value.trim() || "",
      ollamaApiKey: inputs.ollamaApiKey?.value.trim() || "",
      ollamaBaseUrl: inputs.ollamaBaseUrl?.value.trim() || DEFAULT_SETTINGS.ollamaBaseUrl,
      glmocrApiKey: inputs.glmocrApiKey?.value.trim() || "",
      glmocrBaseUrl: inputs.glmocrBaseUrl?.value.trim() || DEFAULT_SETTINGS.glmocrBaseUrl,
      mitBaseUrl: inputs.mitBaseUrl?.value.trim() || DEFAULT_SETTINGS.mitBaseUrl,
      mitTranslator: inputs.mitTranslator?.value || DEFAULT_SETTINGS.mitTranslator,
      sourceLanguage: inputs.sourceLanguage?.value || "ja",
      targetLanguage: inputs.targetLanguage?.value || "en",
      model: inputs.model?.value || DEFAULT_SETTINGS.model,
      compactOverlayMode: Boolean(inputs.compactOverlayMode?.checked),
      replaceTextBlocks: Boolean(inputs.replaceTextBlocks?.checked),
      autoTranslateThenEdit: Boolean(inputs.autoTranslateThenEdit?.checked),
      inPlaceMode: Boolean(inputs.inPlaceMode?.checked),
    };
  }

  function loadForm(settings) {
    if (modelProviderSelect) {
      modelProviderSelect.value = settings.modelProvider || "gemini";
      updateProviderSections(settings.modelProvider || "gemini", settings.model);
    }
    if (inputs.geminiApiKey) inputs.geminiApiKey.value = settings.geminiApiKey || "";
    if (inputs.openaiApiKey) inputs.openaiApiKey.value = settings.openaiApiKey || "";
    if (inputs.deepseekApiKey) inputs.deepseekApiKey.value = settings.deepseekApiKey || "";
    if (inputs.groqApiKey) inputs.groqApiKey.value = settings.groqApiKey || "";
    if (inputs.ollamaApiKey) inputs.ollamaApiKey.value = settings.ollamaApiKey || "";
    if (inputs.ollamaBaseUrl) inputs.ollamaBaseUrl.value = settings.ollamaBaseUrl || DEFAULT_SETTINGS.ollamaBaseUrl;
    if (inputs.glmocrApiKey) inputs.glmocrApiKey.value = settings.glmocrApiKey || "";
    if (inputs.glmocrBaseUrl) inputs.glmocrBaseUrl.value = settings.glmocrBaseUrl || DEFAULT_SETTINGS.glmocrBaseUrl;
    if (inputs.mitBaseUrl) inputs.mitBaseUrl.value = settings.mitBaseUrl || DEFAULT_SETTINGS.mitBaseUrl;
    if (inputs.mitTranslator) inputs.mitTranslator.value = settings.mitTranslator || DEFAULT_SETTINGS.mitTranslator;
    if (inputs.sourceLanguage) inputs.sourceLanguage.value = settings.sourceLanguage || "ja";
    if (inputs.targetLanguage) inputs.targetLanguage.value = settings.targetLanguage || "en";
    if (inputs.model) inputs.model.value = settings.model || DEFAULT_SETTINGS.model;
    if (inputs.compactOverlayMode) inputs.compactOverlayMode.checked = Boolean(settings.compactOverlayMode);
    if (inputs.replaceTextBlocks) inputs.replaceTextBlocks.checked = Boolean(settings.replaceTextBlocks);
    if (inputs.autoTranslateThenEdit) inputs.autoTranslateThenEdit.checked = Boolean(settings.autoTranslateThenEdit);
    if (inputs.inPlaceMode) inputs.inPlaceMode.checked = Boolean(settings.inPlaceMode);
  }

  loadForm(currentSettings);
  updateApiWarning(apiWarning, currentSettings, currentSettings.modelProvider || "gemini");

  if (!tab?.id) {
    toggleInput.disabled = true;
    setToggleUi(false);
    if (translateOnceBtn) translateOnceBtn.disabled = true;
    if (translateContinuousBtn) translateContinuousBtn.disabled = true;
  } else {
    await ensureContentScript(tab.id);
    setToggleUi(await getActive(tab.id));
    setContinuousUi(await getContinuous(tab.id));

    toggleInput?.addEventListener("change", async () => {
      toggleInput.disabled = true;
      try {
        const next = Boolean(toggleInput.checked);
        const final = await setActive(tab.id, next);

        if (final !== next) {
          // If the state didn't change as expected, show a warning
          if (next === true && !final) {
            if (apiWarning) {
              const originalText = apiWarning.textContent;
              const originalShow = apiWarning.classList.contains("show");
              apiWarning.textContent = "Cannot turn on for this page. Try a normal website or refresh the page.";
              apiWarning.classList.add("show");
              setTimeout(() => {
                if (originalShow) {
                  apiWarning.textContent = originalText;
                } else {
                  apiWarning.classList.remove("show");
                }
              }, 3000);
            }
          }
          setToggleUi(await getActive(tab.id));
        } else {
          setToggleUi(final);
        }
      } finally {
        toggleInput.disabled = false;
      }
    });

    translateOnceBtn?.addEventListener("click", async () => {
      const originalText = translateOnceBtn.textContent;
      translateOnceBtn.disabled = true;
      if (!(await getActive(tab.id))) {
        translateOnceBtn.textContent = "Turn Translator On first";
        translateOnceBtn.disabled = false;
        setTimeout(() => { translateOnceBtn.textContent = originalText; }, 1500);
        return;
      }
      const latest = await getStoredSettings();
      if (!requiresApiKey(latest.modelProvider) || latest[`${latest.modelProvider}ApiKey`]?.trim()) {
        chrome.tabs.sendMessage(tab.id, { type: "MT_TRANSLATE_ONCE" }).catch(() => {});
        window.close();
        return;
      }
      updateApiWarning(apiWarning, latest, latest.modelProvider);
      translateOnceBtn.disabled = false;
      translateOnceBtn.textContent = originalText;
    });

    translateContinuousBtn?.addEventListener("click", async () => {
      const prevLabel = translateContinuousBtn.textContent;
      translateContinuousBtn.disabled = true;
      translateContinuousBtn.textContent = "Updating...";
      if (!(await getActive(tab.id))) {
        translateContinuousBtn.textContent = "Turn Translator On first";
        translateContinuousBtn.disabled = false;
        setTimeout(async () => setContinuousUi(await getContinuous(tab.id)), 1500);
        return;
      }
      const latest = await getStoredSettings();
      if (requiresApiKey(latest.modelProvider) && !latest[`${latest.modelProvider}ApiKey`]?.trim()) {
        updateApiWarning(apiWarning, latest, latest.modelProvider);
        translateContinuousBtn.disabled = false;
        translateContinuousBtn.textContent = prevLabel;
        return;
      }
      const resp = await setContinuous(tab.id, !(await getContinuous(tab.id)));
      translateContinuousBtn.disabled = false;
      if (resp?.ok) setContinuousUi(Boolean(resp.enabled));
      else {
        translateContinuousBtn.textContent = "Could not update";
        setTimeout(async () => setContinuousUi(await getContinuous(tab.id)), 1500);
      }
    });
  }

  document.getElementById("openOptions")?.addEventListener("click", (e) => {
    e.preventDefault();
    const panel = document.getElementById("quickSettings");
    if (panel) panel.style.display = panel.style.display === "none" ? "block" : "none";
  });

  modelProviderSelect?.addEventListener("change", () => {
    updateProviderSections(modelProviderSelect.value);
    updateApiWarning(apiWarning, readFormSnapshot(), modelProviderSelect.value);
  });

  saveBtn?.addEventListener("click", async () => {
    const payload = readFormSnapshot();
    await new Promise((resolve) => chrome.storage.local.set(payload, resolve));
    updateApiWarning(apiWarning, payload, payload.modelProvider);
    if (saveStatus) {
      saveStatus.textContent = "Saved";
      setTimeout(() => (saveStatus.textContent = ""), 1200);
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
