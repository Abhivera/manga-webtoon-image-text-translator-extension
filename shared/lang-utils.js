export function isCjkLanguage(lang) {
  const c = String(lang || "").toLowerCase();
  return c === "zh" || c === "zh-tw" || c === "zh-hant" || c === "ja" || c === "ko";
}

export function getFontFamilyForLanguage(lang) {
  const c = String(lang || "").toLowerCase();
  if (c === "zh") {
    return '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", "SimHei", sans-serif';
  }
  if (c === "zh-tw" || c === "zh-hant") {
    return '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif';
  }
  if (c === "ja") {
    return '"Noto Sans JP", "Hiragino Sans", "Yu Gothic", "Meiryo", sans-serif';
  }
  if (c === "ko") {
    return '"Noto Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
  }
  return '"Bangers", "Arial Black", Impact, "Segoe UI", sans-serif';
}

export function ensureMangaFonts() {
  if (document.getElementById("mt-manga-fonts")) return;
  const link = document.createElement("link");
  link.id = "mt-manga-fonts";
  link.rel = "stylesheet";
  link.href =
    "https://fonts.googleapis.com/css2?family=Bangers&family=Noto+Sans+JP:wght@400;700&family=Noto+Sans+KR:wght@400;700&family=Noto+Sans+SC:wght@400;700&family=Noto+Sans+TC:wght@400;700&display=swap";
  document.head.appendChild(link);
}
