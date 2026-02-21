export const $ = (sel) => document.querySelector(sel);

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
