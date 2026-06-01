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
  setActiveScreen: null,
  getActiveScreenEl: null,
  _updateNotifBadge: null,
  resetSongsFilters: null,
  getSongsListState: null,
  getProjectsOwnerFilter: null,
  setProjectsOwnerFilter: null,
  openCreateOverlay: null,
  openSheet: null,
  openSongMenu: null,
  playVersion: null,
  addToQueue: null,
  createVersion: null,
  setActive: null,
  openSongFilters: null,
  pickAudioFile: null,
  getGlobalAudio: null,
  unlockAudioOnce: null,
  playNowPlaying: null,
  syncMiniPlayerUI: null,
  shareInviteSong: null,
  openVersionMenu: null,
  nav: null,
  refreshSharedData: null,
  syncMessageBadges: null,
};

export function initAppContext(opts) {
  const { render, navigateForward, goBack, setHeader, syncTabs, setActiveScreen, getActiveScreenEl, _updateNotifBadge, resetSongsFilters, getSongsListState, getProjectsOwnerFilter, setProjectsOwnerFilter, openCreateOverlay, openSheet, openSongMenu, playVersion, addToQueue, createVersion, setActive, openSongFilters, pickAudioFile, getGlobalAudio, unlockAudioOnce, playNowPlaying, syncMiniPlayerUI, shareInviteSong, openVersionMenu, nav, refreshSharedData, syncMessageBadges } = opts;
  ctx.render = render;
  ctx.navigateForward = navigateForward;
  ctx.goBack = goBack;
  ctx.setHeader = setHeader;
  ctx.syncTabs = syncTabs;
  ctx.setActiveScreen = setActiveScreen;
  ctx.getActiveScreenEl = getActiveScreenEl;
  ctx._updateNotifBadge = _updateNotifBadge;
  ctx.resetSongsFilters = resetSongsFilters;
  ctx.getSongsListState = getSongsListState;
  ctx.getProjectsOwnerFilter = getProjectsOwnerFilter;
  ctx.setProjectsOwnerFilter = setProjectsOwnerFilter;
  ctx.openCreateOverlay = openCreateOverlay;
  ctx.openSheet = openSheet;
  ctx.openSongMenu = openSongMenu;
  ctx.playVersion = playVersion;
  ctx.addToQueue = addToQueue;
  ctx.createVersion = createVersion;
  ctx.setActive = setActive;
  ctx.openSongFilters = openSongFilters;
  ctx.pickAudioFile = pickAudioFile;
  ctx.getGlobalAudio = getGlobalAudio;
  ctx.unlockAudioOnce = unlockAudioOnce;
  ctx.playNowPlaying = playNowPlaying;
  ctx.syncMiniPlayerUI = syncMiniPlayerUI;
  ctx.shareInviteSong = shareInviteSong;
  ctx.openVersionMenu = openVersionMenu;
  ctx.nav = nav;
  ctx.refreshSharedData = refreshSharedData;
  ctx.syncMessageBadges = syncMessageBadges;
}
