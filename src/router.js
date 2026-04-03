// ── Navigation / routing state ──
// Single mutable object shared across all modules.
// Import R and read/write properties directly: R.currentTab = "home"

export const R = {
  // Tab & view
  currentTab: "home",
  drawerView: null,
  overlayView: null,
  songsView: "list",
  settingsView: null,
  collabPill: "projects",
  collabMode: false,
  songsFromCollab: false,

  // Drill-down targets
  selectedSongId: null,
  selectedVersionId: null,
  projectDetailScreen: null,
  releaseDetailId: null,
  friendProfileId: null,
  lyricsEditSongId: null,

  // Player
  playerScreen: "list",
  playerFilter: "all",
  playerSort: "recent",
  playerQuery: "",
  fullPlayerOpen: false,
  isFullPlayerOpen: false,
  prevTabBeforeFullPlayer: null,
  prevSelectedSongIdBeforeFullPlayer: null,
  lastTabBeforeFullPlayer: null,
  isNowPlayingFullscreen: false,

  // Scroll & back targets
  songsListScrollTop: 0,
  songsBackTarget: null,
};
