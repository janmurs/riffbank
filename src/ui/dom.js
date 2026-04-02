export const $ = (sel) => document.querySelector(sel);

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function nowStamp(d = new Date()) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}${mi}`;
}

export function slug(s) {
  return String(s || "")
    .trim()
    .replace(/[\/\\:*?"<>|#%{}[\]^`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function escapeTextarea(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function uid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return (
    "id-" +
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 10) +
    "-" +
    Math.random().toString(36).slice(2, 10)
  );
}

export function basenameNoExt(path) {
  const base = String(path || "").split("/").pop() || "";
  return base.replace(/\.[a-z0-9]+$/i, "");
}

export function titleizeFromSlug(s) {
  return String(s || "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

export function safeString(x) {
  return (x == null ? "" : String(x)).trim();
}

export function normalizeFileUrl(file) {
  // Accept "./library/...", "/library/...", or "library/..."
  let f = safeString(file);
  if (!f) return "";
  if (f.startsWith("http://") || f.startsWith("https://")) return f;
  if (f.startsWith("/")) return f;
  if (f.startsWith("./")) return f;
  if (f.startsWith("library/")) return "./" + f;
  return "./" + f;
}

export function extFromPath(p) {
  const m = String(p || "").match(/\.([a-z0-9]+)$/i);
  return (m?.[1] || "").toLowerCase();
}

export function yyyymmddFromDate(d) {
  const s = safeString(d);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return "";
  return `${m[1]}${m[2]}${m[3]}`;
}

export function guessNumericSuffixFromTitle(t) {
  const s = safeString(t);
  // e.g. "Wasting 20260206 2" -> "2"
  const m = s.match(/\b(\d{1,2})\b\s*$/);
  return m ? m[1] : "";
}

export function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function normalizeAudioLink(link) {
  if (!link) return link;

  // Leave absolute / special URLs alone
  if (/^(https?:)?\/\//i.test(link)) return link;
  if (link.startsWith("blob:")) return link;
  if (link.startsWith("data:")) return link;

  let out = String(link).trim();

  // Remove leading "./"
  if (out.startsWith("./")) out = out.slice(1); // "./public/.." -> "/public/.."

  // Ensure it starts with "/"
  if (!out.startsWith("/")) out = "/" + out;

  // Fix "public/..." paths -> served from root
  if (out.startsWith("/public/")) out = out.slice("/public".length); // "/public/library/.." -> "/library/.."

  return out;
}

export const yieldToMain = () => new Promise(r => setTimeout(r, 0));

export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
