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
  _updateNotifBadge: null,
  resetSongsFilters: null,
  getSongsListState: null,
  getProjectsOwnerFilter: null,
  setProjectsOwnerFilter: null,
};

export function initAppContext({ render, navigateForward, goBack, setHeader, syncTabs, getActiveScreenEl, _updateNotifBadge, resetSongsFilters, getSongsListState, getProjectsOwnerFilter, setProjectsOwnerFilter }) {
  ctx.render = render;
  ctx.navigateForward = navigateForward;
  ctx.goBack = goBack;
  ctx.setHeader = setHeader;
  ctx.syncTabs = syncTabs;
  ctx.getActiveScreenEl = getActiveScreenEl;
  ctx._updateNotifBadge = _updateNotifBadge;
  ctx.resetSongsFilters = resetSongsFilters;
  ctx.getSongsListState = getSongsListState;
  ctx.getProjectsOwnerFilter = getProjectsOwnerFilter;
  ctx.setProjectsOwnerFilter = setProjectsOwnerFilter;
}
