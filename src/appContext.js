// ── App Context ──
// Shared references to app-level functions and DOM elements.
// Populated by app.js at init time via initAppContext().
// Imported by view modules to avoid circular dependencies.

export const ctx = {
  render: null,
  navigateForward: null,
  goBack: null,
  setHeader: null,
  syncTabs: null,
  getActiveScreenEl: null,
};

export function initAppContext({ render, navigateForward, goBack, setHeader, syncTabs, getActiveScreenEl }) {
  ctx.render = render;
  ctx.navigateForward = navigateForward;
  ctx.goBack = goBack;
  ctx.setHeader = setHeader;
  ctx.syncTabs = syncTabs;
  ctx.getActiveScreenEl = getActiveScreenEl;
}
