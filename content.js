import { DEFAULT_SETTINGS } from "./shared/settings.js";
import {
  ensureMangaFonts,
  getFontFamilyForLanguage,
  isCjkLanguage,
} from "./shared/lang-utils.js";

const BUTTON_CLASS = "manga-translator-btn";
const OVERLAY_CLASS = "manga-translation-overlay";
const TOOLBAR_ID = "mt-torii-toolbar";
const CROP_LAYER_ID = "mt-crop-layer";
const HUD_ID = "manga-translation-hud";

let isTabEnabled = false;
let isEditMode = false;
let isCropMode = false;
const imageHoverButtons = new WeakMap();
let isBulkTranslating = false;
let bulkAbort = false;
let isCurrentTabActive = true;
/** Session-only: translate images as they enter viewport while scrolling */
let isContinuousMode = false;
let scrollIntersectionObserver = null;
let domMutationTimer = null;
const CONCURRENCY = 3;
let lazyQueue = [];
let lazyQueueSet = new WeakSet();
let lazyActiveWorkers = 0;

let settings = { ...DEFAULT_SETTINGS };

const urlToResultCache = new Map();
const editedTranslationsByImage = new Map();
/** WeakMap<HTMLCanvasElement, HTMLImageElement> — stores original <img> for in-place restore */
const canvasToOriginalImg = new WeakMap();
/** WeakMap<HTMLImageElement, HTMLCanvasElement> — tracks which images have been in-place rendered */
const imgToCanvas = new WeakMap();

function notifyActiveChanged() {
  try {
    chrome.runtime.sendMessage({
      type: "SET_TAB_ENABLED",
      enabled: isTabEnabled,
    });
  } catch {}
}

function requestTabEnabled() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_TAB_ENABLED" }, (resp) => {
      if (resp && resp.ok) {
        isTabEnabled = resp.enabled;
      }
      resolve(isTabEnabled);
    });
  });
}

function requestSettings() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (resp) => {
      if (resp) {
        settings = resp;
      }
      resolve(settings);
    });
  });
}

function ensureStyles() {
  ensureMangaFonts();
  if (document.getElementById("manga-translator-style")) return;
  const style = document.createElement("style");
  style.id = "manga-translator-style";
  style.textContent = `
    #${TOOLBAR_ID} {
      position: fixed;
      right: 16px;
      top: 50%;
      transform: translateY(-50%);
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      padding: 10px 8px;
      border-radius: 18px;
      background: rgba(18, 18, 20, 0.88);
      border: 1px solid rgba(255, 255, 255, 0.1);
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      user-select: none;
      opacity: 0;
      transition: opacity 200ms ease, transform 200ms ease;
    }
    #${TOOLBAR_ID}:hover {
      opacity: 1;
    }
    #${TOOLBAR_ID} .mt-torii-brand {
      width: 36px;
      height: 36px;
      border-radius: 12px;
      background: linear-gradient(135deg, #ff6b4a, #ff8f6b);
      color: #fff;
      font-weight: 800;
      font-size: 15px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 2px;
      box-shadow: 0 4px 14px rgba(255, 107, 74, 0.45);
      cursor: grab;
    }
    #${TOOLBAR_ID} .mt-torii-brand:active { cursor: grabbing; }
    #${TOOLBAR_ID} .mt-torii-btn {
      width: 40px;
      height: 40px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.06);
      color: #f1f5f9;
      font-size: 15px;
      font-weight: 700;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 140ms ease, border-color 140ms ease, transform 100ms ease, box-shadow 140ms ease;
      padding: 0;
      line-height: 1;
    }
    #${TOOLBAR_ID} .mt-torii-btn:hover {
      background: rgba(255, 255, 255, 0.14);
      border-color: rgba(255, 255, 255, 0.22);
    }
    #${TOOLBAR_ID} .mt-torii-btn:active {
      transform: scale(0.94);
    }
    #${TOOLBAR_ID} .mt-torii-btn.mt-active {
      background: linear-gradient(135deg, #ff6b4a, #ff8f6b);
      border-color: transparent;
      color: #fff;
      box-shadow: 0 4px 16px rgba(255, 107, 74, 0.5);
    }
    #${TOOLBAR_ID} .mt-torii-btn.mt-busy {
      animation: mt-pulse 1.2s ease-in-out infinite;
    }
    #${TOOLBAR_ID} .mt-torii-divider {
      width: 28px;
      height: 1px;
      background: rgba(255, 255, 255, 0.12);
      margin: 2px 0;
    }
    @keyframes mt-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.55; }
    }
    .${BUTTON_CLASS} {
      position: absolute;
      z-index: 2147483646;
      background: rgba(18, 18, 20, 0.82);
      color: #fff;
      border: 2px solid rgba(255, 107, 74, 0.85);
      border-radius: 50%;
      padding: 0;
      width: 52px;
      height: 52px;
      font-size: 12px;
      cursor: pointer;
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.4);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      opacity: 0;
      pointer-events: none;
      transform: translate(-50%, -50%) scale(0.88);
      transition: opacity 160ms ease, transform 160ms ease;
    }
    .${BUTTON_CLASS}.mt-hover-visible {
      opacity: 1;
      pointer-events: auto;
      transform: translate(-50%, -50%) scale(1);
    }
    .${BUTTON_CLASS}:hover {
      border-color: #ff6b4a;
      box-shadow: 0 8px 28px rgba(255, 107, 74, 0.35);
    }
    .${BUTTON_CLASS} .mt-icon {
      width: 32px;
      height: 32px;
      display: block;
      margin: 0 auto;
    }
    .${BUTTON_CLASS} .mt-icon.mt-rotating {
      animation: mt-spin 0.8s linear infinite;
    }
    #${CROP_LAYER_ID} {
      position: fixed;
      inset: 0;
      z-index: 2147483646;
      cursor: crosshair;
      background: rgba(0, 0, 0, 0.35);
    }
    #${CROP_LAYER_ID} .mt-crop-hint {
      position: fixed;
      top: 16px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(18, 18, 20, 0.92);
      color: #f8fafc;
      padding: 10px 16px;
      border-radius: 12px;
      font: 600 13px/1.3 -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
      pointer-events: none;
    }
    #${CROP_LAYER_ID} .mt-crop-selection {
      position: fixed;
      border: 2px dashed #ff6b4a;
      background: rgba(255, 107, 74, 0.12);
      box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.35);
      pointer-events: none;
    }
    .mt-crop-result {
      position: fixed;
      z-index: 2147483645;
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
      pointer-events: auto;
    }
    .mt-crop-result img {
      display: block;
      max-width: 100%;
      height: auto;
    }
    .mt-crop-result .mt-crop-close {
      position: absolute;
      top: 6px;
      right: 6px;
      width: 28px;
      height: 28px;
      border: none;
      border-radius: 8px;
      background: rgba(18, 18, 20, 0.85);
      color: #fff;
      font-size: 16px;
      cursor: pointer;
      line-height: 1;
    }
    .${OVERLAY_CLASS} {
      position: absolute;
      z-index: 2147483645;
      background: rgba(255,255,255,0.92);
      color: #111;
      padding: 8px 10px;
      border-radius: 10px;
      border: 1px solid rgba(15, 23, 42, 0.18);
      font: 650 13px/1.35 -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
      letter-spacing: 0.01em;
      max-width: 60%;
      box-shadow: 0 6px 20px rgba(0,0,0,0.22);
      backdrop-filter: blur(1.5px);
      -webkit-backdrop-filter: blur(1.5px);
      white-space: pre-wrap;
      word-break: break-word;
    }
    .${OVERLAY_CLASS}.mt-replace {
      word-break: break-all;
      letter-spacing: 0.02em;
      overflow-wrap: anywhere;
      pointer-events: none;
      opacity: 0;
      transform: translateY(3px) scale(0.985);
      transition: opacity 180ms ease, transform 180ms ease;
      border-radius: 6px;
      padding: 4px 6px;
      box-shadow: none;
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
    }
    .${OVERLAY_CLASS}.mt-visible {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
    .${OVERLAY_CLASS}.mt-compact {
      padding: 4px 6px;
      border-radius: 7px;
      font: 600 11px/1.2 -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
      max-width: 48%;
    }
    .${OVERLAY_CLASS}.mt-overlay-fallback {
      left: 0;
      right: 0;
      margin-left: auto;
      margin-right: auto;
      max-width: min(92vw, 560px);
    }
    .${OVERLAY_CLASS}.mt-editable {
      pointer-events: auto;
      cursor: text;
      outline: none;
    }
    .${OVERLAY_CLASS}.mt-editable:focus {
      box-shadow: 0 0 0 2px rgba(14, 165, 233, 0.7);
    }
    @media (prefers-reduced-motion: reduce) {
      .${OVERLAY_CLASS} {
        transition: none;
        transform: none;
      }
    }
    #${HUD_ID} {
      position: fixed;
      right: 80px;
      bottom: 24px;
      z-index: 2147483647;
      background: rgba(18, 18, 20, 0.92);
      color: #fff;
      padding: 12px 14px;
      border-radius: 14px;
      font-size: 12px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      box-shadow: 0 10px 30px rgba(0,0,0,0.35);
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 200px;
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
    }
    #${HUD_ID} .mt-spinner {
      width: 16px;
      height: 16px;
      border: 2px solid rgba(255,255,255,0.3);
      border-top-color: #fff;
      border-radius: 50%;
      animation: mt-spin 0.8s linear infinite;
    }
    @keyframes mt-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    #${HUD_ID} .mt-cancel {
      margin-left: auto;
      background: transparent;
      color: #fff;
      border: 1px solid rgba(255,255,255,0.35);
      border-radius: 999px;
      padding: 4px 8px;
      cursor: pointer;
      font-size: 12px;
    }
    #${HUD_ID} .mt-cancel:hover { background: rgba(255,255,255,0.1); }
    .mt-restore-btn {
      position: absolute;
      z-index: 2147483646;
      top: 8px;
      right: 8px;
      background: rgba(15, 23, 42, 0.78);
      color: #f8fafc;
      border: 1px solid rgba(148, 163, 184, 0.35);
      border-radius: 8px;
      padding: 5px 10px;
      font: 600 12px/1.2 -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
      cursor: pointer;
      opacity: 0;
      transform: translateY(-3px);
      transition: opacity 180ms ease, transform 180ms ease, background 120ms ease;
      pointer-events: auto;
    }
    .mt-restore-btn.mt-visible {
      opacity: 1;
      transform: translateY(0);
    }
    .mt-restore-btn:hover {
      background: rgba(14, 165, 233, 0.85);
    }
    .mt-inplace-wrap {
      position: relative;
      display: inline-block;
    }
    .mt-inplace-wrap canvas {
      display: block;
      max-width: 100%;
      height: auto;
    }
  `;
  document.documentElement.appendChild(style);
}

function updateToolbarState() {
  const toolbar = document.getElementById(TOOLBAR_ID);
  if (!toolbar) return;
  toolbar.querySelector('[data-action="power"]')?.classList.toggle("mt-active", isTabEnabled);
  toolbar.querySelector('[data-action="scroll"]')?.classList.toggle("mt-active", isContinuousMode);
  toolbar.querySelector('[data-action="edit"]')?.classList.toggle("mt-active", isEditMode);
  toolbar.querySelector('[data-action="auto"]')?.classList.toggle("mt-busy", isBulkTranslating);
}

function setTabEnabledState(enabled) {
  if (enabled === isTabEnabled) {
    updateToolbarState();
    return;
  }
  isTabEnabled = enabled;
  notifyActiveChanged();
  updateToolbarState();
  if (isTabEnabled && isCurrentTabActive) {
    scanAllImages();
    if (isContinuousMode) observeEligibleImagesForScroll();
  } else {
    cleanupAll();
  }
}

function makeToolbarDraggable(toolbar, handle) {
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startRight = 0;
  let startTop = 0;

  handle.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    dragging = true;
    const rect = toolbar.getBoundingClientRect();
    startX = e.clientX;
    startY = e.clientY;
    startRight = window.innerWidth - rect.right;
    startTop = rect.top;
    toolbar.style.transform = "none";
    toolbar.style.top = `${startTop}px`;
    toolbar.style.right = `${startRight}px`;
    e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    toolbar.style.top = `${Math.max(8, Math.min(window.innerHeight - toolbar.offsetHeight - 8, startTop + dy))}px`;
    toolbar.style.right = `${Math.max(8, Math.min(window.innerWidth - toolbar.offsetWidth - 8, startRight - dx))}px`;
  });

  window.addEventListener("mouseup", () => {
    dragging = false;
  });
}

function createToolbar() {
  if (document.getElementById(TOOLBAR_ID)) return document.getElementById(TOOLBAR_ID);

  const toolbar = document.createElement("div");
  toolbar.id = TOOLBAR_ID;
  toolbar.innerHTML = `
    <div class="mt-torii-brand" title="Drag to move">文</div>
    <button type="button" class="mt-torii-btn" data-action="power" title="Toggle translator (Alt+T)">⏻</button>
    <div class="mt-torii-divider"></div>
    <button type="button" class="mt-torii-btn" data-action="auto" title="Translate all images">A</button>
    <button type="button" class="mt-torii-btn" data-action="scroll" title="Translate as you scroll">↻</button>
    <button type="button" class="mt-torii-btn" data-action="edit" title="Edit translations">✎</button>
    <button type="button" class="mt-torii-btn" data-action="crop" title="Crop &amp; translate region">⬚</button>
  `;

  toolbar.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    e.stopPropagation();
    const action = btn.dataset.action;
    if (action === "power") setTabEnabledState(!isTabEnabled);
    else if (action === "auto") {
      if (!isTabEnabled) {
        setTabEnabledState(true);
      }
      translateOnce();
    } else if (action === "scroll") {
      if (!isTabEnabled) {
        setTabEnabledState(true);
      }
      if (isContinuousMode) disableContinuousMode();
      else enableContinuousMode();
      updateToolbarState();
    } else if (action === "edit") {
      isEditMode = !isEditMode;
      document.querySelectorAll(`.${OVERLAY_CLASS}`).forEach((el) => {
        if (isEditMode) {
          el.classList.add("mt-editable");
          el.setAttribute("contenteditable", "plaintext-only");
        } else {
          el.removeAttribute("contenteditable");
        }
      });
      updateToolbarState();
    } else if (action === "crop") {
      if (!isTabEnabled) setTabEnabledState(true);
      startCropMode();
    }
  });

  document.documentElement.appendChild(toolbar);
  makeToolbarDraggable(toolbar, toolbar.querySelector(".mt-torii-brand"));
  updateToolbarState();
  return toolbar;
}

function startCropMode() {
  if (isCropMode) return;
  if (!isTabEnabled || !isCurrentTabActive) return;
  isCropMode = true;

  const layer = document.createElement("div");
  layer.id = CROP_LAYER_ID;
  layer.innerHTML = `<div class="mt-crop-hint">Drag to select an area · Esc to cancel</div>`;
  document.documentElement.appendChild(layer);

  const selection = document.createElement("div");
  selection.className = "mt-crop-selection";
  selection.style.display = "none";
  layer.appendChild(selection);

  let startX = 0;
  let startY = 0;
  let dragging = false;

  const cleanup = () => {
    isCropMode = false;
    layer.remove();
    window.removeEventListener("keydown", onKey);
  };

  const onKey = (e) => {
    if (e.key === "Escape") cleanup();
  };
  window.addEventListener("keydown", onKey);

  layer.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    selection.style.display = "block";
    selection.style.left = `${startX}px`;
    selection.style.top = `${startY}px`;
    selection.style.width = "0";
    selection.style.height = "0";
  });

  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const left = Math.min(startX, e.clientX);
    const top = Math.min(startY, e.clientY);
    const width = Math.abs(e.clientX - startX);
    const height = Math.abs(e.clientY - startY);
    selection.style.left = `${left}px`;
    selection.style.top = `${top}px`;
    selection.style.width = `${width}px`;
    selection.style.height = `${height}px`;
  });

  window.addEventListener(
    "mouseup",
    async (e) => {
      if (!dragging) return;
      dragging = false;
      const left = Math.min(startX, e.clientX);
      const top = Math.min(startY, e.clientY);
      const width = Math.abs(e.clientX - startX);
      const height = Math.abs(e.clientY - startY);
      cleanup();
      if (width < 24 || height < 24) return;

      const elementRect = { left, top, width, height };

      try {
        const resp = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage(
            {
              type: "TRANSLATE_REGION",
              payload: {
                elementRect,
                pageScale: window.devicePixelRatio || 1,
                overrideSourceLanguage: settings.sourceLanguage,
                overrideTargetLanguage: settings.targetLanguage,
              },
            },
            (r) => {
              if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
              else resolve(r);
            }
          );
        });
        if (!resp?.ok) throw new Error(resp?.error || "Region translate failed");
        showCropResult(left, top, width, height, resp);
      } catch (err) {
        console.warn("crop translate error", err);
        try {
          alert("Crop translate failed: " + String(err?.message || err));
        } catch {}
      }
    },
    { once: true }
  );
}

function showCropResult(viewLeft, viewTop, viewW, viewH, resp) {
  const payload = unwrapResult(resp.result);
  const wrap = document.createElement("div");
  wrap.className = "mt-crop-result";
  wrap.style.left = `${viewLeft}px`;
  wrap.style.top = `${viewTop}px`;
  wrap.style.width = `${viewW}px`;

  const close = document.createElement("button");
  close.className = "mt-crop-close";
  close.type = "button";
  close.textContent = "×";
  close.title = "Close";
  if (payload.translatedImageBase64) {
    const img = document.createElement("img");
    img.src = `data:image/png;base64,${payload.translatedImageBase64}`;
    img.alt = "Translated region";
    close.addEventListener("click", () => wrap.remove());
    wrap.appendChild(img);
    wrap.appendChild(close);
    document.documentElement.appendChild(wrap);
    return;
  }

  if (!resp.cropBase64) return;

  const img = document.createElement("img");
  img.alt = "Cropped region";
  img.style.width = `${viewW}px`;
  img.style.height = `${viewH}px`;
  img.style.display = "block";
  img.style.objectFit = "fill";

  img.onload = () => {
    wrap.appendChild(img);
    wrap.appendChild(close);
    close.addEventListener("click", () => {
      document
        .querySelectorAll(`.${OVERLAY_CLASS}[data-for="${cssEscape(img.src)}"]`)
        .forEach((el) => el.remove());
      wrap.remove();
    });
    document.documentElement.appendChild(wrap);

    if (settings.inPlaceMode) {
      renderInPlaceTranslation(img, resp.result);
    } else {
      overlayTranslations(img, resp.result, {
        editable: isEditMode || Boolean(settings.autoTranslateThenEdit),
      });
    }
  };
  img.src = `data:image/png;base64,${resp.cropBase64}`;
}

function getOrCreateHud(mode) {
  let hud = document.getElementById(HUD_ID);
  if (hud) {
    hud.dataset.mtMode = mode || "once";
    setHudMode(mode || "once");
    return hud;
  }
  hud = document.createElement("div");
  hud.id = HUD_ID;
  hud.dataset.mtMode = mode || "once";
  hud.innerHTML = `
    <div class="mt-spinner" aria-hidden="true"></div>
    <div class="mt-text">Preparing…</div>
    <button class="mt-cancel" type="button">Cancel</button>
  `;
  hud.querySelector(".mt-cancel").addEventListener("click", () => {
    const m = hud.dataset.mtMode;
    if (m === "scroll") {
      disableContinuousMode();
    } else {
      bulkAbort = true;
    }
  });
  document.documentElement.appendChild(hud);
  setHudMode(mode || "once");
  return hud;
}

function setHudMode(mode) {
  const hud = document.getElementById(HUD_ID);
  if (hud) hud.dataset.mtMode = mode;
  const btn = hud?.querySelector(".mt-cancel");
  if (btn) btn.textContent = mode === "scroll" ? "Stop" : "Cancel";
}

function updateHud(done, total) {
  const hud = getOrCreateHud("once");
  const txt = hud.querySelector(".mt-text");
  if (txt) txt.textContent = `Translating images… ${done}/${total}`;
}

function updateScrollHud(message) {
  const hud = getOrCreateHud("scroll");
  setHudMode("scroll");
  const txt = hud.querySelector(".mt-text");
  if (txt) txt.textContent = message || "Translating as you scroll…";
  const spin = hud.querySelector(".mt-spinner");
  if (spin) spin.style.display = lazyQueue.length > 0 ? "block" : "none";
}

function hideHud() {
  const hud = document.getElementById(HUD_ID);
  if (hud) hud.remove();
}

async function translateSingleImage(img) {
  let result;
  const cached = urlToResultCache.get(img.src);
  if (cached) {
    result = cached;
  } else {
    const rect = img.getBoundingClientRect();
    const elementRect = {
      left: rect.left + window.scrollX,
      top: rect.top + window.scrollY,
      width: rect.width,
      height: rect.height,
    };
    result = await translateImage(
      img.src,
      elementRect,
      window.devicePixelRatio || 1
    );
    urlToResultCache.set(img.src, result);
  }
  applyTranslationResult(img, result);
  img.dataset.mangaTranslatorTranslated = "1";
}

function unwrapResult(result) {
  return result?.result || result || {};
}

function applyTranslationResult(img, result) {
  const payload = unwrapResult(result);
  if (payload.translatedImageBase64) {
    renderServerInPlaceTranslation(img, payload.translatedImageBase64);
    return;
  }
  if (settings.inPlaceMode) {
    renderInPlaceTranslation(img, result);
  } else {
    overlayTranslations(img, result, {
      editable: isEditMode || Boolean(settings.autoTranslateThenEdit),
    });
  }
}

function mountInplaceCanvas(img, canvas) {
  const existingCanvas = imgToCanvas.get(img);
  if (existingCanvas?.isConnected) restoreOriginalImage(existingCanvas);

  const wrapper = document.createElement("div");
  wrapper.className = "mt-inplace-wrap";
  wrapper.style.width = img.style.width || (img.width ? `${img.width}px` : "auto");
  wrapper.style.height = img.style.height || "auto";
  wrapper.style.maxWidth = img.style.maxWidth || "100%";

  const displayW = img.width || img.clientWidth;
  const displayH = img.height || img.clientHeight;
  canvas.style.width = displayW ? `${displayW}px` : "100%";
  canvas.style.height = displayH ? `${displayH}px` : "auto";

  const restoreBtn = document.createElement("button");
  restoreBtn.className = "mt-restore-btn";
  restoreBtn.textContent = "⟲ Restore";
  restoreBtn.title = "Restore original image";
  restoreBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    restoreOriginalImage(canvas);
  });

  wrapper.appendChild(canvas);
  wrapper.appendChild(restoreBtn);
  canvasToOriginalImg.set(canvas, img);
  imgToCanvas.set(img, canvas);
  img.parentNode?.replaceChild(wrapper, img);
  requestAnimationFrame(() => restoreBtn.classList.add("mt-visible"));
}

function renderServerInPlaceTranslation(img, base64) {
  const canvas = document.createElement("canvas");
  canvas.dataset.mangaTranslatorInplace = "1";
  const translated = new Image();
  translated.onload = () => {
    canvas.width = translated.naturalWidth || translated.width;
    canvas.height = translated.naturalHeight || translated.height;
    canvas.getContext("2d")?.drawImage(translated, 0, 0);
    mountInplaceCanvas(img, canvas);
  };
  translated.onerror = () => console.warn("Failed to load translated image");
  translated.src = `data:image/png;base64,${base64}`;
}

// ─── In-Place Canvas Renderer ──────────────────────────────

/**
 * Sample the dominant background colour from the edges of a bounding box region.
 * Reads edge strips and interior samples, then returns the median RGB.
 */
function sampleBackgroundColour(ctx, x, y, w, h, canvasW, canvasH) {
  const strip = Math.max(2, Math.floor(Math.min(w, h) * 0.04));
  const pixels = [];
  const regions = [
    [x, y, w, Math.min(strip, h)],
    [x, Math.max(y, y + h - strip), w, Math.min(strip, h)],
    [x, y, Math.min(strip, w), h],
    [Math.max(x, x + w - strip), y, Math.min(strip, w), h],
  ];
  for (const [rx, ry, rw, rh] of regions) {
    const sx = Math.max(0, Math.min(Math.round(rx), canvasW - 1));
    const sy = Math.max(0, Math.min(Math.round(ry), canvasH - 1));
    const sw = Math.max(1, Math.min(Math.round(rw), canvasW - sx));
    const sh = Math.max(1, Math.min(Math.round(rh), canvasH - sy));
    try {
      const imgData = ctx.getImageData(sx, sy, sw, sh);
      const d = imgData.data;
      for (let i = 0; i < d.length; i += 4) {
        pixels.push([d[i], d[i + 1], d[i + 2]]);
      }
    } catch { /* cross-origin: ignore */ }
  }
  if (pixels.length === 0) return [255, 255, 255];
  const median = (arr) => { arr.sort((a, b) => a - b); return arr[Math.floor(arr.length / 2)]; };
  const r = median(pixels.map(p => p[0]));
  const g = median(pixels.map(p => p[1]));
  const b = median(pixels.map(p => p[2]));
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (luminance > 175) return [255, 255, 255];
  return [r, g, b];
}

function roundRectPath(ctx, x, y, w, h, radius) {
  const r = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function inpaintTextRegion(ctx, bx, by, bw, bh, bgR, bgG, bgB) {
  const luminance = 0.2126 * bgR + 0.7152 * bgG + 0.0722 * bgB;
  const isLightBubble = luminance > 165;
  const radius = Math.min(bw, bh) * 0.06;

  if (isLightBubble) {
    ctx.fillStyle = "#ffffff";
    roundRectPath(ctx, bx, by, bw, bh, radius);
    ctx.fill();
    return { isLightBubble: true, textColour: "#1a1a1a" };
  }

  const feather = Math.min(8, Math.floor(Math.min(bw, bh) * 0.1));
  for (let f = feather; f >= 0; f--) {
    const alpha = f === 0 ? 1.0 : 0.35;
    ctx.fillStyle = `rgba(${bgR}, ${bgG}, ${bgB}, ${alpha})`;
    ctx.fillRect(bx - f, by - f, bw + f * 2, bh + f * 2);
  }
  const textColour = luminance > 128 ? "#0f172a" : "#f8fafc";
  return { isLightBubble: false, textColour };
}

/**
 * Wrap text to fit within maxWidth pixels. Uses character-based wrapping for CJK.
 */
function wordWrap(ctx, text, maxWidth, isCjk) {
  const normalized = String(text || "").replace(/\s+/g, isCjk ? "" : " ").trim();
  if (!normalized) return [""];

  if (!isCjk) {
    const words = normalized.split(/\s+/);
    if (words.length === 0) return [""];
    const lines = [];
    let current = words[0];
    for (let i = 1; i < words.length; i++) {
      const test = current + " " + words[i];
      if (ctx.measureText(test).width <= maxWidth) {
        current = test;
      } else {
        lines.push(current);
        current = words[i];
      }
    }
    lines.push(current);
    return lines;
  }

  const lines = [];
  let current = "";
  for (const char of normalized) {
    if (char === "\n") {
      if (current) lines.push(current);
      current = "";
      continue;
    }
    const test = current + char;
    if (ctx.measureText(test).width <= maxWidth) {
      current = test;
    } else {
      if (current) lines.push(current);
      current = char;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

/**
 * Auto-fit font size: start large, shrink until the text (with wrap) fits the box.
 */
function autoFitText(ctx, text, boxW, boxH, fontFamily, isCjk) {
  const padding = isCjk ? 6 : 4;
  const availW = boxW - padding * 2;
  const availH = boxH - padding * 2;
  const maxSize = isCjk ? Math.min(42, Math.floor(boxH * 0.65)) : Math.min(48, Math.floor(boxH * 0.7));
  let fontSize = Math.max(8, maxSize);
  let lines = [];
  const lineHeightRatio = isCjk ? 1.35 : 1.25;
  const weight = isCjk ? "700" : "bold";
  for (; fontSize >= 7; fontSize--) {
    ctx.font = `${weight} ${fontSize}px ${fontFamily}`;
    lines = wordWrap(ctx, text, availW, isCjk);
    const totalHeight = lines.length * fontSize * lineHeightRatio;
    if (totalHeight <= availH) {
      let fits = true;
      for (const line of lines) {
        if (ctx.measureText(line).width > availW) { fits = false; break; }
      }
      if (fits) break;
    }
  }
  return { fontSize: Math.max(7, fontSize), lines, lineHeightRatio, weight };
}

function renderVerticalText(ctx, text, bx, by, bw, bh, fontFamily, isCjk, textColour, strokeColour, useStroke) {
  const padding = 6;
  const availW = bw - padding * 2;
  const availH = bh - padding * 2;
  const chars = String(text || "").replace(/\s+/g, isCjk ? "" : " ").split("");
  let fontSize = Math.max(8, Math.min(36, Math.floor(bw * 0.75)));
  const weight = isCjk ? "700" : "bold";
  const charGap = 1.15;

  for (; fontSize >= 7; fontSize--) {
    ctx.font = `${weight} ${fontSize}px ${fontFamily}`;
    const totalH = chars.length * fontSize * charGap;
    let maxCharW = 0;
    for (const ch of chars) {
      maxCharW = Math.max(maxCharW, ctx.measureText(ch).width);
    }
    if (totalH <= availH && maxCharW <= availW) break;
  }

  ctx.font = `${weight} ${fontSize}px ${fontFamily}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const cx = bx + bw / 2;
  const totalH = chars.length * fontSize * charGap;
  let cy = by + (bh - totalH) / 2 + fontSize / 2;

  for (const ch of chars) {
    if (useStroke) {
      ctx.strokeStyle = strokeColour;
      ctx.lineWidth = Math.max(1, Math.round(fontSize / 12));
      ctx.lineJoin = "round";
      ctx.strokeText(ch, cx, cy);
    }
    ctx.fillStyle = textColour;
    ctx.fillText(ch, cx, cy);
    cy += fontSize * charGap;
  }
}

/**
 * Render translations directly onto the image via a canvas, replacing the <img> in the DOM.
 */
function renderInPlaceTranslation(img, result) {
  const texts = unwrapResult(result).texts || [];
  if (texts.length === 0) return;

  const natW = img.naturalWidth;
  const natH = img.naturalHeight;
  if (!natW || !natH) return;

  ensureMangaFonts();

  const targetLang = settings.targetLanguage || "en";
  const isCjkTarget = isCjkLanguage(targetLang);
  const fontFamily = getFontFamilyForLanguage(targetLang);

  const canvas = document.createElement("canvas");
  canvas.width = natW;
  canvas.height = natH;
  canvas.dataset.mangaTranslatorInplace = "1";
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return;

  try {
    ctx.drawImage(img, 0, 0, natW, natH);
  } catch {
    return;
  }

  for (const t of texts) {
    if (!t.translation) continue;
    const hasBox =
      Number.isFinite(Number(t.x)) &&
      Number.isFinite(Number(t.y)) &&
      Number(t.width) > 0 &&
      Number(t.height) > 0;
    if (!hasBox) continue;

    let bx = (Number(t.x) / 100) * natW;
    let by = (Number(t.y) / 100) * natH;
    let bw = (Number(t.width) / 100) * natW;
    let bh = (Number(t.height) / 100) * natH;

    const paddingX = bw * 0.12;
    const paddingY = bh * 0.08;
    bx = Math.max(0, bx - paddingX);
    by = Math.max(0, by - paddingY);
    bw = Math.min(natW - bx, bw + paddingX * 2);
    bh = Math.min(natH - by, bh + paddingY * 2);

    const cx = bx + bw / 2;
    const cy = by + bh / 2;
    const isVertical = t.direction === "vertical" || (isCjkTarget && bh > bw * 1.35 && t.direction !== "horizontal");

    // Expand vertical JA boxes only when translating to horizontal Latin scripts
    if (!isCjkTarget && !isVertical && bh > bw * 1.2) {
      const area = bw * bh;
      bw = Math.max(bw * 1.8, Math.sqrt(area) * 1.2);
      bh = Math.max(bh, Math.sqrt(area));
      bw = Math.min(bw, natW * 0.95);
      bh = Math.min(bh, natH * 0.95);
      bx = Math.max(0, Math.min(cx - bw / 2, natW - bw));
      by = Math.max(0, Math.min(cy - bh / 2, natH - bh));
    }

    const [bgR, bgG, bgB] = sampleBackgroundColour(ctx, bx, by, bw, bh, natW, natH);
    const { isLightBubble, textColour: inpaintTextColour } = inpaintTextRegion(ctx, bx, by, bw, bh, bgR, bgG, bgB);

    if (isVertical) {
      const bgLuminance = 0.2126 * bgR + 0.7152 * bgG + 0.0722 * bgB;
      const strokeColour = bgLuminance > 128 ? "#ffffff" : "#0f172a";
      renderVerticalText(
        ctx, t.translation, bx, by, bw, bh, fontFamily, isCjkTarget,
        inpaintTextColour, strokeColour, !isLightBubble
      );
      continue;
    }

    const { fontSize, lines, lineHeightRatio, weight } = autoFitText(
      ctx, t.translation, bw, bh, fontFamily, isCjkTarget
    );

    const bgLuminance = 0.2126 * bgR + 0.7152 * bgG + 0.0722 * bgB;
    const textColour = inpaintTextColour;
    const strokeColour = bgLuminance > 128 ? "#ffffff" : "#0f172a";
    const useStroke = !isLightBubble && !isCjkTarget;

    ctx.font = `${weight} ${fontSize}px ${fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    const lineHeight = fontSize * lineHeightRatio;
    const totalTextH = lines.length * lineHeight;
    const startY = by + (bh - totalTextH) / 2;

    for (let i = 0; i < lines.length; i++) {
      const lx = cx;
      const ly = startY + i * lineHeight;

      if (useStroke) {
        ctx.strokeStyle = strokeColour;
        ctx.lineWidth = Math.max(1, Math.round(fontSize / 10));
        ctx.lineJoin = "round";
        ctx.strokeText(lines[i], lx, ly);
      }

      ctx.fillStyle = textColour;
      ctx.fillText(lines[i], lx, ly);
    }
  }

  mountInplaceCanvas(img, canvas);
}

/**
 * Swap a translated canvas back to the original <img>.
 */
function restoreOriginalImage(canvas) {
  const originalImg = canvasToOriginalImg.get(canvas);
  if (!originalImg) return;

  const wrapper = canvas.closest(".mt-inplace-wrap");
  const parent = wrapper ? wrapper.parentNode : canvas.parentNode;
  const target = wrapper || canvas;

  if (parent && target) {
    // Clear translated state so it can be re-translated
    delete originalImg.dataset.mangaTranslatorTranslated;
    parent.replaceChild(originalImg, target);
  }

  canvasToOriginalImg.delete(canvas);
  imgToCanvas.delete(originalImg);
}

function disconnectScrollObserver() {
  if (scrollIntersectionObserver) {
    scrollIntersectionObserver.disconnect();
    scrollIntersectionObserver = null;
  }
}

function ensureScrollObserver() {
  if (scrollIntersectionObserver) return scrollIntersectionObserver;
  scrollIntersectionObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const img = entry.target;
        if (!(img instanceof HTMLImageElement)) continue;
        try {
          scrollIntersectionObserver.unobserve(img);
        } catch {}
        enqueueLazyTranslate(img);
      }
    },
    { root: null, rootMargin: "200px", threshold: 0.05 }
  );
  return scrollIntersectionObserver;
}

function observeEligibleImagesForScroll() {
  if (!isContinuousMode || !isTabEnabled || !isCurrentTabActive) return;
  const io = ensureScrollObserver();
  eligibleImages().forEach((img) => {
    if (img.dataset.mangaTranslatorTranslated === "1") return;
    try {
      io.observe(img);
    } catch {}
  });
}

function enqueueLazyTranslate(img) {
  if (!isContinuousMode || !isTabEnabled || !isCurrentTabActive) return;
  if (!img || !img.isConnected) return;
  if (img.dataset.mangaTranslatorTranslated === "1") return;
  if (img.width < 120 || img.height < 120) return;
  if (lazyQueueSet.has(img)) return;
  lazyQueueSet.add(img);
  lazyQueue.push(img);
  updateScrollHud();
  pumpLazyQueue();
}

function pumpLazyQueue() {
  while (
    lazyActiveWorkers < CONCURRENCY &&
    lazyQueue.length &&
    isContinuousMode &&
    isTabEnabled &&
    isCurrentTabActive
  ) {
    const img = lazyQueue.shift();
    if (img) {
      try {
        lazyQueueSet.delete(img);
      } catch {}
    }
    if (!img || !img.isConnected) continue;
    lazyActiveWorkers += 1;
    translateSingleImage(img)
      .catch((err) => console.warn("lazy translate error", err))
      .finally(() => {
        lazyActiveWorkers -= 1;
        if (
          isContinuousMode &&
          isTabEnabled &&
          isCurrentTabActive &&
          img.isConnected &&
          img.dataset.mangaTranslatorTranslated !== "1"
        ) {
          try {
            ensureScrollObserver().observe(img);
          } catch {}
        }
        updateScrollHud();
        pumpLazyQueue();
      });
  }
}

function disableContinuousMode() {
  isContinuousMode = false;
  lazyQueue = [];
  lazyQueueSet = new WeakSet();
  disconnectScrollObserver();
  const hud = document.getElementById(HUD_ID);
  if (hud && hud.dataset.mtMode === "scroll") hideHud();
  updateToolbarState();
}

function enableContinuousMode() {
  if (!isTabEnabled || !isCurrentTabActive) return;
  isContinuousMode = true;
  lazyQueue = [];
  lazyQueueSet = new WeakSet();
  getOrCreateHud("scroll");
  setHudMode("scroll");
  updateScrollHud("Translating as you scroll…");
  observeEligibleImagesForScroll();
  updateToolbarState();
}

function positionHoverButton(button, img) {
  const r = img.getBoundingClientRect();
  button.style.left = `${r.left + window.scrollX + r.width - 40}px`;
  button.style.top = `${r.top + window.scrollY + 40}px`;
}

function showHoverButton(img) {
  const entry = imageHoverButtons.get(img);
  if (!entry) return;
  positionHoverButton(entry.button, img);
  entry.button.classList.add("mt-hover-visible");
  if (entry.hideTimer) {
    clearTimeout(entry.hideTimer);
    entry.hideTimer = null;
  }
}

function hideHoverButton(img, delay = 120) {
  const entry = imageHoverButtons.get(img);
  if (!entry || entry.button.disabled) return;
  if (entry.hideTimer) clearTimeout(entry.hideTimer);
  entry.hideTimer = setTimeout(() => {
    entry.button.classList.remove("mt-hover-visible");
    entry.hideTimer = null;
  }, delay);
}

function addTranslateButton(img) {
  if (img.dataset.mangaTranslatorHasButton === "1") return;
  img.dataset.mangaTranslatorHasButton = "1";

  const button = document.createElement("button");
  button.className = BUTTON_CLASS;
  button.setAttribute("aria-label", "Translate image");
  button.title = "Translate image";
  const icon = document.createElement("img");
  icon.className = "mt-icon";
  icon.src = chrome.runtime.getURL("icons/translate_icon_32.svg");
  icon.alt = "";
  icon.onerror = () => {
    icon.remove();
    button.textContent = "文";
    button.style.font = "700 18px/52px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif";
  };
  button.appendChild(icon);
  positionHoverButton(button, img);
  document.documentElement.appendChild(button);

  const onPosition = () => {
    if (button.classList.contains("mt-hover-visible")) {
      positionHoverButton(button, img);
    }
  };
  const ro = new ResizeObserver(onPosition);
  ro.observe(img);
  window.addEventListener("scroll", onPosition, { passive: true });

  const entry = { button, hideTimer: null, ro, onPosition };
  imageHoverButtons.set(img, entry);

  img.addEventListener("mouseenter", () => showHoverButton(img));
  img.addEventListener("mouseleave", () => hideHoverButton(img));
  button.addEventListener("mouseenter", () => showHoverButton(img));
  button.addEventListener("mouseleave", () => hideHoverButton(img));

  button.addEventListener("click", async (e) => {
    e.stopPropagation();
    button.disabled = true;
    icon.classList.add("mt-rotating");
    try {
      await translateSingleImage(img);
    } catch (err) {
      console.warn("translate error", err);
      alert(
        "Translate failed: " + String(err && err.message ? err.message : err)
      );
    } finally {
      button.disabled = false;
      icon.classList.remove("mt-rotating");
      hideHoverButton(img, 0);
    }
  });
}

function removeTranslateButton(img) {
  const entry = imageHoverButtons.get(img);
  if (!entry) return;
  try {
    entry.ro.disconnect();
  } catch {}
  window.removeEventListener("scroll", entry.onPosition);
  if (entry.hideTimer) clearTimeout(entry.hideTimer);
  entry.button.remove();
  imageHoverButtons.delete(img);
}

function getEditKey(imgSrc, index) {
  return `${imgSrc}::${index}`;
}

function applyEditableBehavior(div, img, index, textItem) {
  if (!div) return;
  const key = getEditKey(img.src, index);
  const initialText = String(div.textContent || "").trim();
  const saved = editedTranslationsByImage.get(key);
  if (saved) div.textContent = saved;
  div.classList.add("mt-editable");
  div.setAttribute("contenteditable", "plaintext-only");
  div.setAttribute("spellcheck", "true");
  div.title = "Click to edit translation";

  const save = () => {
    const next = String(div.textContent || "").trim();
    if (!next) {
      div.textContent = editedTranslationsByImage.get(key) || initialText;
      return;
    }
    editedTranslationsByImage.set(key, next);
    if (textItem && typeof textItem === "object") {
      textItem.translation = next;
    }
  };

  div.addEventListener("blur", save);
  div.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      div.blur();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      div.textContent = editedTranslationsByImage.get(key) || initialText;
      div.blur();
    }
  });
}

function overlayTranslations(img, result, options = {}) {
  ensureMangaFonts();
  const targetLang = settings.targetLanguage || "en";
  const isCjkTarget = isCjkLanguage(targetLang);
  const overlayFont = getFontFamilyForLanguage(targetLang);

  const rect = img.getBoundingClientRect();
  const pageX = rect.left + window.scrollX;
  const pageY = rect.top + window.scrollY;

  // clear previous overlays for this image
  document
    .querySelectorAll(`.${OVERLAY_CLASS}[data-for="${cssEscape(img.src)}"]`)
    .forEach((el) => el.remove());

  const texts = unwrapResult(result).texts || [];
  const imagePadding = 6;
  let fallbackRow = 0;
  const placedRects = [];

  function intersects(a, b) {
    return (
      a.left < b.right &&
      a.right > b.left &&
      a.top < b.bottom &&
      a.bottom > b.top
    );
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function resolveCollision(initialLeft, initialTop, boxWidth, boxHeight) {
    const minLeft = pageX + imagePadding;
    const maxLeft = pageX + Math.max(imagePadding, rect.width - imagePadding - boxWidth);
    const minTop = pageY + imagePadding;
    const maxTop = pageY + Math.max(imagePadding, rect.height - imagePadding - boxHeight);

    let left = clamp(initialLeft, minLeft, maxLeft);
    let top = clamp(initialTop, minTop, maxTop);
    let candidate = { left, top, right: left + boxWidth, bottom: top + boxHeight };

    if (!placedRects.some((r) => intersects(r, candidate))) return candidate;

    const yStep = settings.compactOverlayMode ? 14 : 20;
    const xStep = settings.compactOverlayMode ? 12 : 18;
    for (let pass = 0; pass < 2; pass++) {
      for (let attempt = 0; attempt < 28; attempt++) {
        if (pass === 0) {
          top = clamp(top + yStep, minTop, maxTop);
        } else {
          left = clamp(left + xStep, minLeft, maxLeft);
          top = clamp(initialTop + (attempt % 8) * yStep, minTop, maxTop);
        }
        candidate = { left, top, right: left + boxWidth, bottom: top + boxHeight };
        if (!placedRects.some((r) => intersects(r, candidate))) return candidate;
      }
    }
    return candidate;
  }

  for (const [index, t] of texts.entries()) {
    if (!t.translation) continue;
    const div = document.createElement("div");
    div.className = OVERLAY_CLASS;
    div.dataset.for = img.src;
    div.dataset.index = String(index);
    if (settings.compactOverlayMode) div.classList.add("mt-compact");

    const editKey = getEditKey(img.src, index);
    const editedTranslation = editedTranslationsByImage.get(editKey);
    div.textContent = editedTranslation || t.translation;
    applyOverlayColorStyles(div, img, t);
    const hasXY = Number.isFinite(Number(t.x)) && Number.isFinite(Number(t.y));
    const widthPct = Number(t.width);
    const heightPct = Number(t.height);
    
    let width = Number.isFinite(widthPct) ? (widthPct / 100) * rect.width : 0;
    let height = Number.isFinite(heightPct) ? (heightPct / 100) * rect.height : 0;
    let preferredLeft = hasXY
      ? pageX + (Number(t.x) / 100) * rect.width
      : pageX + imagePadding;
    let preferredTop = hasXY
      ? pageY + (Number(t.y) / 100) * rect.height
      : pageY + imagePadding + fallbackRow * 30;

    // Expand and reshape bounds for overlays to ensure coverage and fit
    if (width > 0 && height > 0) {
      const paddingX = width * 0.15;
      const paddingY = height * 0.10;
      preferredLeft = Math.max(pageX, preferredLeft - paddingX);
      preferredTop = Math.max(pageY, preferredTop - paddingY);
      width = width + paddingX * 2;
      height = height + paddingY * 2;

      const cx = preferredLeft + width / 2;
      const cy = preferredTop + height / 2;
      if (!isCjkTarget && height > width * 1.2) {
        const area = width * height;
        width = Math.max(width * 1.8, Math.sqrt(area) * 1.2);
        height = Math.max(height, Math.sqrt(area));
        
        width = Math.min(width, rect.width * 0.95);
        height = Math.min(height, rect.height * 0.95);
        preferredLeft = Math.max(pageX, Math.min(cx - width / 2, pageX + rect.width - width));
        preferredTop = Math.max(pageY, Math.min(cy - height / 2, pageY + rect.height - height));
      }
    }
    const replaceMode =
      settings.replaceTextBlocks && hasXY && width > 0 && height > 0;

    const maxWidthPx = width > 0 ? Math.max(100, width) : Math.max(160, rect.width * 0.6);
    if (replaceMode) {
      div.classList.add("mt-replace");
      div.style.fontFamily = overlayFont;
      div.style.fontWeight = isCjkTarget ? "700" : "650";
      const paddedWidth = Math.max(64, width + 12);
      const paddedHeight = Math.max(28, height + 10);
      div.style.maxWidth = `${Math.min(
        rect.width - imagePadding * 2,
        paddedWidth
      )}px`;
      div.style.width = `${Math.min(rect.width - imagePadding * 2, paddedWidth)}px`;
      div.style.minHeight = `${paddedHeight}px`;
      div.style.display = "flex";
      div.style.alignItems = "center";
      div.style.justifyContent = "center";
      div.style.textAlign = "center";
      applyReplacementStyles(div, img, t);
    } else {
      div.style.maxWidth = `${Math.min(rect.width - imagePadding * 2, maxWidthPx)}px`;
    }

    if (options.editable) {
      applyEditableBehavior(div, img, index, t);
    }

    // Measure then position with collision-avoidance.
    div.style.visibility = "hidden";
    document.documentElement.appendChild(div);
    const measured = div.getBoundingClientRect();
    const positioned = replaceMode
      ? {
          left: clamp(preferredLeft, pageX + imagePadding, pageX + Math.max(imagePadding, rect.width - imagePadding - Math.max(40, measured.width))),
          top: clamp(preferredTop, pageY + imagePadding, pageY + Math.max(imagePadding, rect.height - imagePadding - Math.max(20, measured.height))),
          right: 0,
          bottom: 0,
        }
      : resolveCollision(
          preferredLeft,
          preferredTop,
          Math.max(40, measured.width),
          Math.max(20, measured.height)
        );
    div.style.left = `${positioned.left}px`;
    div.style.top = `${positioned.top}px`;
    if (!replaceMode) {
      placedRects.push(positioned);
    }

    if (!hasXY) {
      div.classList.add("mt-overlay-fallback");
      fallbackRow += 1;
    }
    div.style.visibility = "visible";
    requestAnimationFrame(() => div.classList.add("mt-visible"));
  }
}

function estimateImageLuminance(img, xPct, yPct) {
  try {
    if (!img || !img.naturalWidth || !img.naturalHeight) return null;
    const cx = Math.max(
      1,
      Math.min(img.naturalWidth - 2, Math.round((xPct / 100) * img.naturalWidth))
    );
    const cy = Math.max(
      1,
      Math.min(img.naturalHeight - 2, Math.round((yPct / 100) * img.naturalHeight))
    );
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, cx - 1, cy - 1, 2, 2, 0, 0, 1, 1);
    const data = ctx.getImageData(0, 0, 1, 1).data;
    return 0.2126 * data[0] + 0.7152 * data[1] + 0.0722 * data[2];
  } catch {
    return null;
  }
}

function applyOverlayColorStyles(element, img, textItem) {
  if (!element) return;
  const centerX = Number.isFinite(Number(textItem?.x))
    ? Number(textItem.x) + Number(textItem.width || 0) / 2
    : 50;
  const centerY = Number.isFinite(Number(textItem?.y))
    ? Number(textItem.y) + Number(textItem.height || 0) / 2
    : 50;
  const luminance = estimateImageLuminance(img, centerX, centerY);
  const useDarkOverlay =
    luminance == null
      ? !window.matchMedia("(prefers-color-scheme: dark)").matches
      : luminance > 145;

  if (useDarkOverlay) {
    element.style.background = "rgba(15, 23, 42, 0.84)";
    element.style.color = "#f8fafc";
    element.style.borderColor = "rgba(148, 163, 184, 0.35)";
  } else {
    element.style.background = "rgba(248, 250, 252, 0.9)";
    element.style.color = "#0f172a";
    element.style.borderColor = "rgba(15, 23, 42, 0.24)";
  }
}

function applyReplacementStyles(element, img, textItem) {
  if (!element) return;
  const centerX = Number.isFinite(Number(textItem?.x))
    ? Number(textItem.x) + Number(textItem.width || 0) / 2
    : 50;
  const centerY = Number.isFinite(Number(textItem?.y))
    ? Number(textItem.y) + Number(textItem.height || 0) / 2
    : 50;
  const luminance = estimateImageLuminance(img, centerX, centerY);
  const useDarkText = luminance == null ? true : luminance > 145;
  element.style.background = useDarkText ? "#ffffff" : "#0f172a";
  element.style.color = useDarkText ? "#1a1a1a" : "#f8fafc";
  element.style.borderColor = useDarkText ? "transparent" : "#334155";
  element.style.opacity = "1";
  element.style.borderRadius = "4px";
}

function cssEscape(s) {
  try {
    return CSS.escape(s);
  } catch {
    return s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
  }
}

function eligibleImages() {
  return Array.from(document.images).filter(
    (img) => img.width >= 120 && img.height >= 120
  );
}

function scanAllImages() {
  if (!isTabEnabled || !isCurrentTabActive) return;
  eligibleImages().forEach(addTranslateButton);
}

function cleanupAll() {
  disableContinuousMode();
  bulkAbort = true;
  Array.from(document.images).forEach((img) => {
    removeTranslateButton(img);
    delete img.dataset.mangaTranslatorHasButton;
    delete img.dataset.mangaTranslatorTranslated;
  });
  document.querySelectorAll(`.${OVERLAY_CLASS}`).forEach((el) => el.remove());
  // Restore all in-place translated canvases
  document.querySelectorAll("canvas[data-manga-translator-inplace]").forEach((canvas) => {
    restoreOriginalImage(canvas);
  });
  document.querySelectorAll(".mt-crop-result").forEach((el) => el.remove());
  hideHud();
  isBulkTranslating = false;
  bulkAbort = false;
  lazyActiveWorkers = 0;
  updateToolbarState();
}

/** One-shot: translate all eligible images currently in the document (this viewport load only). */
async function translateOnce() {
  if (!isTabEnabled || !isCurrentTabActive) return;
  if (isBulkTranslating) return;
  isBulkTranslating = true;
  bulkAbort = false;
  updateToolbarState();

  const list = eligibleImages();
  const targets = list.filter(
    (img) => img.dataset.mangaTranslatorTranslated !== "1"
  );
  if (targets.length === 0) {
    isBulkTranslating = false;
    bulkAbort = false;
    updateToolbarState();
    try {
      alert("No translatable images found on this page.");
    } catch {}
    return;
  }

  getOrCreateHud("once");
  setHudMode("once");
  updateHud(0, targets.length);

  let done = 0;
  let idx = 0;

  const runWorker = async () => {
    while (!bulkAbort) {
      const i = idx++;
      if (i >= targets.length) break;
      const img = targets[i];
      try {
        await translateSingleImage(img);
      } catch (err) {
        console.warn("translate-once error", err);
      } finally {
        done += 1;
        updateHud(done, targets.length);
      }
    }
  };

  const workers = Array.from({ length: CONCURRENCY }, () => runWorker());
  await Promise.all(workers);

  hideHud();
  isBulkTranslating = false;
  bulkAbort = false;
  updateToolbarState();
  if (isContinuousMode && isTabEnabled && isCurrentTabActive) {
    getOrCreateHud("scroll");
    setHudMode("scroll");
    updateScrollHud("Translating as you scroll…");
    observeEligibleImagesForScroll();
  }
}

function translateImage(url, elementRect, pageScale) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: "TRANSLATE_IMAGE",
        payload: {
          url,
          tabId: null, // background will infer from sender if needed
          elementRect,
          pageScale,
          overrideSourceLanguage: settings.sourceLanguage,
          overrideTargetLanguage: settings.targetLanguage,
        },
      },
      (resp) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        if (!resp || !resp.ok)
          return reject(
            new Error(resp && resp.error ? resp.error : "Unknown error")
          );
        resolve(resp);
      }
    );
  });
}

function addGlobalKeyboardShortcut() {
  window.addEventListener("keydown", (e) => {
    if (e.altKey && e.key.toLowerCase() === "t") {
      setTabEnabledState(!isTabEnabled);
    }
  });
}

function handleTabVisibilityChange() {
  isCurrentTabActive = !document.hidden;
  if (!isCurrentTabActive) {
    disconnectScrollObserver();
    bulkAbort = true;
    lazyQueue = [];
    lazyQueueSet = new WeakSet();
    const hud = document.getElementById(HUD_ID);
    if (hud && hud.dataset.mtMode === "scroll") hideHud();
    isBulkTranslating = false;
    bulkAbort = false;
  } else if (isTabEnabled) {
    scanAllImages();
    if (isContinuousMode) {
      getOrCreateHud("scroll");
      setHudMode("scroll");
      updateScrollHud("Translating as you scroll…");
      observeEligibleImagesForScroll();
    }
  }
}

async function init() {
  ensureStyles();
  createToolbar();
  await requestSettings();
  await requestTabEnabled();
  updateToolbarState();
  addGlobalKeyboardShortcut();

  // Listen for tab visibility changes
  document.addEventListener("visibilitychange", handleTabVisibilityChange);

  notifyActiveChanged();
  if (isTabEnabled && isCurrentTabActive) {
    scanAllImages();
  }

  const observer = new MutationObserver(() => {
    if (domMutationTimer) clearTimeout(domMutationTimer);
    domMutationTimer = setTimeout(() => {
      domMutationTimer = null;
      scanAllImages();
      if (isContinuousMode && isTabEnabled && isCurrentTabActive) {
        observeEligibleImagesForScroll();
      }
    }, 250);
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      const keys = [
        "modelProvider",
        "geminiApiKey",
        "openaiApiKey",
        "deepseekApiKey",
        "groqApiKey",
        "ollamaApiKey",
        "ollamaBaseUrl",
        "glmocrApiKey",
        "glmocrBaseUrl",
        "mitBaseUrl",
        "mitTranslator",
        "mitDetector",
        "mitInpainter",
        "mitDetectionSize",
        "mitInpaintingSize",
        "model",
        "sourceLanguage",
        "targetLanguage",
        "compactOverlayMode",
        "replaceTextBlocks",
        "inPlaceMode",
        "autoTranslateThenEdit",
        "inPlaceMode",
      ];
      let needsRestyle = false;
      for (const k of keys) {
        if (changes[k] && Object.prototype.hasOwnProperty.call(changes, k)) {
          settings[k] = changes[k].newValue;
          if (
            k === "compactOverlayMode" ||
            k === "replaceTextBlocks" ||
            k === "autoTranslateThenEdit"
          ) {
            needsRestyle = true;
          }
        }
      }
      if (needsRestyle) {
        document.querySelectorAll(`.${OVERLAY_CLASS}`).forEach((el) => {
          const url = el.dataset.for;
          const img = url
            ? Array.from(document.images).find((i) => i.src === url)
            : null;
          if (settings.compactOverlayMode) el.classList.add("mt-compact");
          else el.classList.remove("mt-compact");
          if (img) {
            applyOverlayColorStyles(el, img, {
              x: 50,
              y: 50,
              width: 10,
              height: 10,
            });
          }
        });
      }
    });
  } catch {}
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

function handleTranslateResult(url, result) {
  const img = Array.from(document.images).find((i) => i.src === url);
  if (!img) return;
  applyTranslationResult(img, result);
  img.dataset.mangaTranslatorTranslated = "1";
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type) return;

  switch (message.type) {
    case "MT_NOTIFY":
      if (message.payload?.message) alert(message.payload.message);
      return;
    case "MT_TRANSLATE_RESULT":
      if (message.payload?.url && message.payload?.result) {
        handleTranslateResult(message.payload.url, message.payload.result);
      }
      return;
    case "MT_TRANSLATE_ALL_NOW":
      translateOnce();
      return;
    case "MT_GET_ACTIVE":
      sendResponse({ ok: true, active: isTabEnabled });
      return;
    case "MT_GET_CONTINUOUS":
      sendResponse({ ok: true, enabled: isContinuousMode });
      return;
    case "MT_SET_CONTINUOUS": {
      const want = Boolean(message.enabled);
      if (want && (!isTabEnabled || !isCurrentTabActive)) {
        sendResponse({
          ok: false,
          enabled: false,
          error: "Turn Translator on for this tab first.",
        });
        return;
      }
      if (want) enableContinuousMode();
      else disableContinuousMode();
      sendResponse({ ok: true, enabled: isContinuousMode });
      return;
    }
    case "MT_TRANSLATE_ONCE":
      if (!isTabEnabled || !isCurrentTabActive) {
        sendResponse({ ok: false, error: "Translator is off or tab inactive." });
        return;
      }
      translateOnce();
      sendResponse({ ok: true });
      return;
    case "MT_SET_ACTIVE": {
      setTabEnabledState(Boolean(message.active));
      sendResponse({ ok: true, active: isTabEnabled });
      return;
    }
    case "MT_CROP_SCREENSHOT":
      break;
    default:
      return;
  }

  if (message.type !== "MT_CROP_SCREENSHOT") return;
  const { dataUrl, elementRect, pageScale } = message.payload || {};
  try {
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Number(pageScale) || 1;
        const sx = Math.max(0, Math.round(elementRect.left * scale));
        const sy = Math.max(0, Math.round(elementRect.top * scale));
        const sw = Math.max(1, Math.round(elementRect.width * scale));
        const sh = Math.max(1, Math.round(elementRect.height * scale));

        const canvas = document.createElement("canvas");
        canvas.width = sw;
        canvas.height = sh;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
        const out = canvas.toDataURL("image/png");
        sendResponse({ ok: true, base64: out.split(",")[1] });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    };
    img.onerror = () =>
      sendResponse({ ok: false, error: "screenshot decode failed" });
    img.src = dataUrl;
  } catch (e) {
    sendResponse({ ok: false, error: String(e) });
  }
  return true; // async response
});
