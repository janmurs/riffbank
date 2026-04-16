import { R } from "../router.js";
import { ctx } from "../appContext.js";
import { state, saveState, getSong, sharedData, setSharedData } from "../state.js";
import { toast } from "../ui/toast.js";
import { $, escapeHtml } from "../ui/dom.js";
import { coverSvg } from "../ui/coverArt.js";
import { sharedBadgeProject } from "../ui/syncBadges.js";
import { renderAvatarHtml } from "../ui/avatars.js";
import {
  sendFriendRequest, acceptFriendRequest, removeFriendship,
  getMyFriends, getPendingFriendRequests,
  sendMessage, getMessages, getConversations, markMessagesRead,
  searchUsers, fetchAllSharedData, getProfileById,
} from "../supabase.js";
import { openLoadedInviteBuilder } from "../ui/loadedInviteBuilder.js";

let _collabFriendsCache = null;
let _collabConvosCache = null;
let _pendingFriendCount = 0;

export function setCollabFriendsCache(v) { _collabFriendsCache = v; }
export function setCollabConvosCache(v) { _collabConvosCache = v; }
export function getPendingFriendCount() { return _pendingFriendCount; }
export function setPendingFriendCount(v) { _pendingFriendCount = v; }

export function renderCollab() {
  ctx.setHeader("Collab");
  const appEl = document.querySelector(".app");
  appEl?.classList.add("collapseTitle");
  const h1 = appEl?.querySelector(".titleblock h1");
  if (h1) h1.style.opacity = "0";

  // Apply cached badge counts immediately (no lag), then refresh in background
  _applyAllBadges(_unreadMsgCount, _pendingFriendCount);
  ctx.syncMessageBadges();

  const friendsBadgeHtml = _pendingFriendCount ? `<span class="collabPillBadge">${_pendingFriendCount}</span>` : "";
  const msgBadgeHtml = _unreadMsgCount ? `<span class="collabPillBadge">${_unreadMsgCount}</span>` : "";

  ctx.getActiveScreenEl().innerHTML = `
    <div class="songsPageTitle">Collab</div>

    <div class="collabPillBar">
      <button class="collabPill${R.collabPill === "projects" ? " collabPillActive" : ""}" data-cpill="projects">Projects</button>
      <button class="collabPill${R.collabPill === "friends" ? " collabPillActive" : ""}" data-cpill="friends">Friends${friendsBadgeHtml}</button>
      <button class="collabPill${R.collabPill === "messages" ? " collabPillActive" : ""}" data-cpill="messages">Messages${msgBadgeHtml}</button>
    </div>

    <div class="collabPillBody" id="collabPillBody"></div>

    <button class="sdFab" id="collabFab" aria-label="Action"></button>
  `;

  // Wire pill taps (skip if already on that pill)
  ctx.getActiveScreenEl().querySelectorAll(".collabPill").forEach(btn => {
    btn.addEventListener("click", () => {
      const target = btn.getAttribute("data-cpill");
      if (target === R.collabPill) return;
      R.collabPill = target;
      ctx.getActiveScreenEl().querySelectorAll(".collabPill").forEach(p => p.classList.remove("collabPillActive"));
      btn.classList.add("collabPillActive");
      _renderCollabPillContent();
    });
  });

  _renderCollabPillContent();

  // Prefetch Friends + Messages in background so tab switches are instant
  if (!_collabFriendsCache) getMyFriends().then(f => { _collabFriendsCache = f; }).catch(() => {});
  if (!_collabConvosCache) getConversations().then(c => { _collabConvosCache = c; }).catch(() => {});

  // Collapse title scroll handler
  if (ctx.getActiveScreenEl()._collapseTitleScroll) {
    ctx.getActiveScreenEl().removeEventListener("scroll", ctx.getActiveScreenEl()._collapseTitleScroll);
    ctx.getActiveScreenEl()._collapseTitleScroll = null;
  }
  const _screen = ctx.getActiveScreenEl();
  const _sm = document.querySelector(".app.collapseTitle .titleblock h1");
  if (_sm) {
    requestAnimationFrame(() => {
      const bt = _screen.querySelector(".songsPageTitle");
      if (!bt) return;
      const topbarEl = document.querySelector(".topbar");
      const screenTop = _screen.getBoundingClientRect().top;
      const topbarBottom = topbarEl ? topbarEl.getBoundingClientRect().bottom : 80;
      const fadeStart = bt.offsetTop - (topbarBottom - screenTop);
      const fadeEnd = fadeStart + (bt.offsetHeight || 40);
      const range = fadeEnd - fadeStart;
      const onScroll = () => {
        const progress = Math.min(1, Math.max(0, (_screen.scrollTop - fadeStart) / range));
        _sm.style.opacity = progress;
      };
      _screen._collapseTitleScroll = onScroll;
      _screen.addEventListener("scroll", onScroll, { passive: true });
      onScroll();
    });
  }
}

// ── Collab pill content renderers ──

export function _renderCollabPillContent() {
  const body = document.getElementById("collabPillBody");
  if (!body) return;
  if (R.collabPill === "projects") _renderCollabProjects(body);
  else if (R.collabPill === "friends") _renderCollabFriends(body);
  else if (R.collabPill === "messages") _renderCollabMessages(body);
  _updateCollabFab();
}

function _updateCollabFab() {
  const fab = document.getElementById("collabFab");
  if (!fab) return;
  // Remove old listener by replacing node
  const fresh = fab.cloneNode(false);
  fab.parentNode.replaceChild(fresh, fab);
  fresh.id = "collabFab";
  fresh.className = "sdFab";

  if (R.collabPill === "projects") {
    fresh.setAttribute("aria-label", "Share");
    fresh.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="24" height="24"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>`;
    fresh.addEventListener("click", () => _openShareFabMenu());
  } else if (R.collabPill === "friends") {
    fresh.setAttribute("aria-label", "Add");
    fresh.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
    fresh.addEventListener("click", () => _openFriendsFabMenu());
  } else if (R.collabPill === "messages") {
    fresh.setAttribute("aria-label", "New Message");
    fresh.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;
    fresh.addEventListener("click", () => _openNewMessagePicker());
  }
}

function _openShareFabMenu() {
  sheetMode = "shareFabMenu";
  openSheet("shareFabMenu");
  sheetContent.innerHTML = `
    <div class="sheetTitle">Share</div>
    <div class="sheetForm" style="gap:6px; margin-top:14px">
      <button class="sheetChoice" id="shareFabSingle">
        Share a Project or Song
        <span class="sub">share one item with an existing user</span>
      </button>
      <button class="sheetChoice" id="shareFabCancel">Cancel</button>
    </div>
  `;
  $("#shareFabSingle")?.addEventListener("click", () => { closeSheet(); openCollabSharePicker(); });
  $("#shareFabCancel")?.addEventListener("click", closeSheet);
}

function _openFriendsFabMenu() {
  sheetMode = "friendsFabMenu";
  openSheet("friendsFabMenu");
  sheetContent.innerHTML = `
    <div class="sheetTitle">Add</div>
    <div class="sheetForm" style="gap:6px; margin-top:14px">
      <button class="sheetChoice" id="friendsFabAdd">
        Add Friend
        <span class="sub">find someone by username</span>
      </button>
      <button class="sheetChoice" id="friendsFabLoaded">
        Loaded Invite
        <span class="sub">bundle projects & songs for a new user</span>
      </button>
      <button class="sheetChoice" id="friendsFabCancel">Cancel</button>
    </div>
  `;
  $("#friendsFabAdd")?.addEventListener("click", () => { closeSheet(); openAddFriend(); });
  $("#friendsFabLoaded")?.addEventListener("click", () => { closeSheet(); openLoadedInviteBuilder(); });
  $("#friendsFabCancel")?.addEventListener("click", closeSheet);
}

function _renderCollabProjects(body) {
  const { projects: sharedProjects, songs: sharedSongs, myProjects, mySongs } = sharedData;

  // Merge all shared data into unified project map: projName → { songs[], owners[] }
  const projMap = new Map();
  const _ensureProj = (name) => {
    if (!projMap.has(name)) projMap.set(name, { songs: [], songIds: new Set(), owners: new Set() });
    return projMap.get(name);
  };

  // Projects shared WITH me
  for (const sp of sharedProjects) {
    const p = _ensureProj(sp.projectName);
    p.owners.add(sp.ownerName);
    for (const s of sp.songs) {
      if (!p.songIds.has(s.id)) { p.songIds.add(s.id); p.songs.push(s); }
    }
  }
  // Individual songs shared WITH me (grouped by project)
  for (const ss of sharedSongs) {
    const projName = (ss.song?.project || "").trim();
    if (!projName) continue;
    const p = _ensureProj(projName);
    p.owners.add(ss.ownerName);
    if (!p.songIds.has(ss.song.id)) { p.songIds.add(ss.song.id); p.songs.push(ss.song); }
  }
  // Projects I shared
  for (const mp of myProjects) {
    const p = _ensureProj(mp.projectName);
    const matching = state.songs.filter(s => (s.project || "").trim() === mp.projectName);
    for (const s of matching) {
      if (!p.songIds.has(s.id)) { p.songIds.add(s.id); p.songs.push(s); }
    }
  }
  // Individual songs I shared (grouped by project)
  for (const ms of mySongs) {
    const projName = (ms.projectName || "").trim();
    if (!projName) continue;
    const p = _ensureProj(projName);
    const s = state.songs.find(x => x.id === ms.songId);
    if (s && !p.songIds.has(s.id)) { p.songIds.add(s.id); p.songs.push(s); }
  }

  // Build sorted project list (only those with at least one song)
  const projects = Array.from(projMap.entries())
    .filter(([, data]) => data.songs.length > 0)
    .sort((a, b) => a[0].localeCompare(b[0]));

  if (!projects.length) {
    body.innerHTML = `
      <div class="collabWrap">
        <div class="collabEmpty" style="padding:24px 0;text-align:center">
          No shared projects yet.
        </div>
      </div>
    `;
    return;
  }

  const projectCards = projects.map(([name, data], i) => {
    const count = data.songs.length;
    const repSong = data.songs[0] || { id: name, title: name, project: name, genre: "" };
    const ownerList = Array.from(data.owners);
    const meta = ownerList.length
      ? `${ownerList.join(", ")} · ${count} song${count !== 1 ? "s" : ""}`
      : `${count} song${count !== 1 ? "s" : ""}`;

    const sleeveItems = data.songs.slice(0, 4).map(s =>
      `<div class="pSleeveSong">${escapeHtml(s.title || "Untitled")}</div>`
    ).join("") + (count > 4 ? `<div class="pSleeveSong pSleeveMore">+${count - 4} more</div>` : "");

    return `
      <div class="pCard" data-collab-proj="${escapeHtml(name)}" style="animation-delay:${i * 60}ms">
        <div class="pCardInner">
          <div class="pSleeve">
            <div class="pSleeveContent">
              ${sleeveItems || `<div class="pSleeveSong" style="opacity:.4">No songs</div>`}
            </div>
          </div>
          <div class="pArt">
            ${coverSvg(repSong, { lite: true })}
            <div class="pShimmer"></div>
          </div>
          <div class="pInfo">
            <div class="pNameRow"><div class="pName">${escapeHtml(name)}</div>${sharedBadgeProject(name)}</div>
            <div class="pMeta"><span>${escapeHtml(meta)}</span></div>
          </div>
        </div>
      </div>
    `;
  }).join("");

  body.innerHTML = projectCards ? `<div class="pGrid">${projectCards}</div>` : "";

  // Wire project card taps → drill into project songs
  body.querySelectorAll("[data-collab-proj]").forEach(card => {
    card.addEventListener("click", () => {
      const name = card.getAttribute("data-collab-proj");
      ctx.navigateForward(() => {
        R.collabMode = true;
        R.projectDetailScreen = name;
      });
    });
  });
}

// Resolve project_ids to project names for the invite editor
async function _resolveInviteProjectNames(invite) {
  const enriched = { ...invite, _projectNames: [] };
  if (invite.project_ids?.length) {
    try {
      const { data: userData } = await supabase.auth.getUser();
      const uid = userData?.user?.id;
      if (uid) {
        const { data: projs } = await supabase
          .from("projects").select("id, name").eq("owner_id", uid)
          .in("id", invite.project_ids);
        if (projs) enriched._projectNames = projs.map(p => p.name);
      }
    } catch {}
  }
  return enriched;
}

// Short time-ago for invite cards
function _timeAgoShort(ts) {
  if (!ts) return "";
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function _renderCollabFriends(body) {
  // If we have cached data, render instantly
  if (_collabFriendsCache) {
    _renderCollabFriendsDOM(body, _collabFriendsCache);
    // Refresh in background (silent update)
    getMyFriends().then(friends => { _collabFriendsCache = friends; }).catch(() => {});
    return;
  }

  body.innerHTML = `
    <div id="collabFriendsPending" style="display:none"></div>
    <div class="collabFriendsBody" style="padding:0 0 40px; display:flex; flex-direction:column; gap:10px;">
      <div class="friendsEmpty"><div class="collabSpinner"></div><div style="margin-top:12px">Loading...</div></div>
    </div>
  `;

  // Load pending friend requests at top
  if (_pendingFriendCount) {
    _loadCollabPendingRequests(body);
  }

  // First load — fetch and cache
  getMyFriends().then(friends => {
    _collabFriendsCache = friends;
    _renderCollabFriendsDOM(body, friends);
  }).catch(() => {
    const friendsBody = body.querySelector(".collabFriendsBody");
    if (friendsBody) friendsBody.innerHTML = `<div class="friendsEmpty">Failed to load friends.</div>`;
  });
}

function _renderCollabFriendsDOM(body, friends) {
  // ── Loaded invite cards (pending invites the user created) ──
  const pendingInvites = (_loadedInvitesCache || []).filter(inv => !inv.claimed && !(inv.expires_at && new Date(inv.expires_at) < new Date()));

  const inviteCardsHtml = pendingInvites.map((inv, i) => {
    const projCount = (inv.project_ids || []).length;
    const songCount = (inv.song_ids || []).length;
    const parts = [];
    if (projCount) parts.push(`${projCount} project${projCount > 1 ? "s" : ""}`);
    if (songCount) parts.push(`${songCount} song${songCount > 1 ? "s" : ""}`);
    const roleBadge = inv.role === "collaborator"
      ? `<span class="liInvBadge liInvBadgeCollab">Collab</span>`
      : `<span class="liInvBadge liInvBadgeViewer">Viewer</span>`;
    const age = _timeAgoShort(inv.created_at);
    return `
      <div class="liInvCard" data-li-inv="${escapeHtml(inv.id)}" style="animation-delay:${i * 60}ms">
        <div class="liInvIcon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
        </div>
        <div class="liInvBody">
          <div class="liInvTitle">Loaded Invite ${roleBadge}</div>
          <div class="liInvMeta">${parts.join(" & ")} · ${age}</div>
        </div>
        <button class="liInvShareBtn" data-li-reshare="${escapeHtml(inv.id)}" title="Re-share link">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
        </button>
      </div>`;
  }).join("");

  const inviteSectionHtml = inviteCardsHtml ? `
    <div class="liInvSection">
      <div class="liInvSectionLabel">Pending Invites</div>
      ${inviteCardsHtml}
    </div>
  ` : "";

  body.innerHTML = `
    ${inviteSectionHtml}
    <div id="collabFriendsPending" style="display:none"></div>
    <div class="collabFriendsBody" style="padding:0 0 40px; display:flex; flex-direction:column; gap:10px;"></div>
  `;

  // Wire loaded invite cards — tap to edit, re-share button
  body.querySelectorAll("[data-li-inv]").forEach(card => {
    card.addEventListener("click", (e) => {
      if (e.target.closest("[data-li-reshare]")) return;
      const invId = card.dataset.liInv;
      const inv = (_loadedInvitesCache || []).find(i => i.id === invId);
      if (!inv) return;
      _resolveInviteProjectNames(inv).then(enriched => {
        openLoadedInviteBuilder(enriched);
      });
    });
  });
  body.querySelectorAll("[data-li-reshare]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const invId = btn.dataset.liReshare;
      const inv = (_loadedInvitesCache || []).find(i => i.id === invId);
      if (inv) _reshareLoadedInvite(inv);
    });
  });

  // Load pending friend requests
  if (_pendingFriendCount) {
    _loadCollabPendingRequests(body);
  }

  const friendsBody = body.querySelector(".collabFriendsBody");
  if (!friendsBody) return;
  if (!friends.length) {
    friendsBody.innerHTML = `<div class="friendsEmpty">No friends yet. Tap <strong>+</strong> to find people.</div>`;
    return;
  }
  friendsBody.innerHTML = friends.map(f => {
    const name = f.profile?.display_name || "Unknown";
    const fullName = [f.profile?.first_name, f.profile?.last_name].filter(Boolean).join(" ");
    return `
      <div class="friendRow" data-friend-id="${f.id}">
        ${_friendAvatarHTML(f.profile)}
        <div class="friendInfo">
          <div class="friendName">${escapeHtml(name)}</div>
          ${fullName ? `<div class="friendMeta">${escapeHtml(fullName)}</div>` : ""}
        </div>
        <button class="friendMsgBtn" data-msg="${f.friendId}" aria-label="Message">Message</button>
      </div>
    `;
  }).join("");

  friendsBody.querySelectorAll(".friendRow[data-friend-id]").forEach(row => {
    row.addEventListener("click", () => {
      const fId = row.getAttribute("data-friend-id");
      const friend = friends.find(f => String(f.id) === fId);
      if (!friend) return;
      ctx.navigateForward(() => { R.friendProfileId = friend.friendId; R.overlayView = "friendProfile"; });
    });
  });
  friendsBody.querySelectorAll(".friendMsgBtn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const uid = btn.getAttribute("data-msg");
      if (uid) openChat(uid);
    });
  });
}

function _loadCollabPendingRequests(body) {
  const pendingEl = body.querySelector("#collabFriendsPending");
  if (!pendingEl) return;
  getPendingFriendRequests().then(requests => {
    if (!requests.length || !pendingEl) return;
    pendingEl.style.display = "";
    pendingEl.innerHTML = `
      <div style="padding:0 0 8px">
        <div class="collabPendingSectionLabel">Pending Requests</div>
        ${requests.map(r => `
          <div class="collabPendingRow alertRowClickable" data-req-id="${r.id}" data-req-profile="${r.requester_id}">
            ${_friendAvatarHTML(r.profile)}
            <div class="friendInfo">
              <div class="friendName">${escapeHtml(r.profile?.display_name || "Unknown")}</div>
              <div class="friendMeta">${_friendMetaText(r.profile)}</div>
            </div>
            <div class="friendActions">
              <button class="friendAcceptBtn" data-cfl-accept="${r.id}">Accept</button>
              <button class="friendDeclineBtn" data-cfl-decline="${r.id}">Decline</button>
            </div>
          </div>
        `).join("")}
      </div>
    `;
    pendingEl.querySelectorAll("[data-cfl-accept]").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = btn.getAttribute("data-cfl-accept");
        btn.textContent = "...";
        try {
          await acceptFriendRequest(id);
          const row = btn.closest(".collabPendingRow");
          row.style.opacity = ".4";
          setTimeout(() => { row.remove(); if (!pendingEl.querySelector(".collabPendingRow")) pendingEl.style.display = "none"; }, 300);
          toast("Friend request accepted!");
          _pendingFriendCount = Math.max(0, _pendingFriendCount - 1);
          _applyAllBadges(_unreadMsgCount, _pendingFriendCount);
        } catch (err) { toast(err.message || "Failed"); btn.textContent = "Accept"; }
      });
    });
    pendingEl.querySelectorAll("[data-cfl-decline]").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = btn.getAttribute("data-cfl-decline");
        btn.textContent = "...";
        try {
          await removeFriendship(id);
          const row = btn.closest(".collabPendingRow");
          row.style.opacity = ".4";
          setTimeout(() => { row.remove(); if (!pendingEl.querySelector(".collabPendingRow")) pendingEl.style.display = "none"; }, 300);
          toast("Request declined");
          _pendingFriendCount = Math.max(0, _pendingFriendCount - 1);
          _applyAllBadges(_unreadMsgCount, _pendingFriendCount);
        } catch (err) { toast(err.message || "Failed"); btn.textContent = "Decline"; }
      });
    });
    pendingEl.querySelectorAll("[data-req-profile]").forEach(row => {
      row.addEventListener("click", (e) => {
        if (e.target.closest("[data-cfl-accept]") || e.target.closest("[data-cfl-decline]")) return;
        const userId = row.getAttribute("data-req-profile");
        if (userId) ctx.navigateForward(() => { R.friendProfileId = userId; R.overlayView = "friendProfile"; });
      });
    });
  }).catch(() => {});
}

function _renderCollabMessages(body) {
  // If we have cached data, render instantly
  if (_collabConvosCache) {
    _renderCollabMessagesDOM(body, _collabConvosCache);
    // Refresh in background (silent update)
    getConversations().then(convos => { _collabConvosCache = convos; }).catch(() => {});
    return;
  }

  body.innerHTML = `
    <div class="collabMsgBody" style="padding:0 0 40px; display:flex; flex-direction:column; gap:0;">
      <div class="friendsEmpty"><div class="collabSpinner"></div><div style="margin-top:12px">Loading...</div></div>
    </div>
  `;

  getConversations().then(convos => {
    _collabConvosCache = convos;
    _renderCollabMessagesDOM(body, convos);
  }).catch(() => {
    const msgBody = body.querySelector(".collabMsgBody");
    if (msgBody) msgBody.innerHTML = `<div class="friendsEmpty">Failed to load messages.</div>`;
  });
}

function _renderCollabMessagesDOM(body, convos) {
  body.innerHTML = `
    <div class="collabMsgBody" style="padding:0 0 40px; display:flex; flex-direction:column; gap:0;"></div>
  `;
  const msgBody = body.querySelector(".collabMsgBody");
  if (!msgBody) return;
  if (!convos.length) {
    msgBody.innerHTML = `<div class="friendsEmpty">No messages yet. Tap a friend's <strong>Message</strong> button to start a conversation.</div>`;
    return;
  }
  _renderConvoList(msgBody, convos);
}

function _openNewMessagePicker() {
  sheetMode = "newMessage";
  openSheet("newMessage");

  sheetContent.innerHTML = `
    <div class="sheetTitle">New Message</div>
    <div class="sheetForm" style="gap:6px; margin-top:14px; max-height:50vh; overflow-y:auto">
      <div class="friendsEmpty"><div class="collabSpinner"></div></div>
    </div>
  `;

  getMyFriends().then(friends => {
    const form = sheetContent?.querySelector(".sheetForm");
    if (!form) return;
    if (!friends.length) {
      form.innerHTML = `<div class="friendsEmpty">No friends yet. Add friends first to start messaging.</div>
        <button class="sheetChoice" id="newMsgCancel">Cancel</button>`;
      $("#newMsgCancel")?.addEventListener("click", () => closeSheet());
      return;
    }
    form.innerHTML = friends.map(f => {
      const name = f.profile?.display_name || "Unknown";
      return `<button class="sheetChoice" data-newmsg-uid="${f.friendId}">${escapeHtml(name)}</button>`;
    }).join("") + `<button class="sheetChoice" id="newMsgCancel">Cancel</button>`;

    form.querySelectorAll("[data-newmsg-uid]").forEach(btn => {
      btn.addEventListener("click", () => {
        const uid = btn.getAttribute("data-newmsg-uid");
        closeSheet();
        if (uid) openChat(uid);
      });
    });
    $("#newMsgCancel")?.addEventListener("click", () => closeSheet());
  }).catch(() => {
    const form = sheetContent?.querySelector(".sheetForm");
    if (form) form.innerHTML = `<div class="friendsEmpty">Failed to load friends.</div>
      <button class="sheetChoice" id="newMsgCancel">Cancel</button>`;
    $("#newMsgCancel")?.addEventListener("click", () => closeSheet());
  });
}

function _updateCollabBadges(friendCount, msgCount) {
  _applyAllBadges(friendCount, msgCount);
}

function _collabInlineBackHTML() {
  const total = (_unreadMsgCount || 0) + (_pendingFriendCount || 0);
  const badgeDisplay = total ? "flex" : "none";
  return `
    <button class="collabInlineBack" id="collabInlineBack" aria-label="Menu">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="24" height="24"><polyline points="15 18 9 12 15 6"/></svg>
      <span class="collabInlineBadge" style="display:${badgeDisplay}">${total || ""}</span>
    </button>
  `;
}

function _wireCollabInlineBack() {
  $("#collabInlineBack")?.addEventListener("click", () => {
    _finishSidebarSwipe(!_collabSidebarOpen);
  });
}

function _collabSidebarHTML() {
  const friendBadgeDisplay = _pendingFriendCount ? "flex" : "none";
  const msgBadgeDisplay = _unreadMsgCount ? "flex" : "none";
  return `
    <button class="collabSidebarBtn" data-sidebar="requests">
      <span class="friendsBadge" style="display:${friendBadgeDisplay}">${_pendingFriendCount || ""}</span>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>
      Requests
    </button>
    <button class="collabSidebarBtn" data-sidebar="friends">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>
      Friends
    </button>
    <button class="collabSidebarBtn" data-sidebar="messages">
      <span class="msgBadge" style="display:${msgBadgeDisplay}">${_unreadMsgCount || ""}</span>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
      Messages
    </button>
    <button class="collabSidebarBtn" data-sidebar="add">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      Add
    </button>
  `;
}

// ── Collab sidebar swipe (document-level, same sensitivity as nav back) ──
let _sidebarSwipe = { tracking: false, decided: false, startX: 0, startY: 0, lastX: 0, lastTime: 0 };
const _SIDEBAR_W = 72;

function _getCollabEls() {
  const shell = document.querySelector(".collabShell");
  if (!shell) return null;
  return { shell, mainEl: shell.querySelector(".collabMain"), sidebarEl: shell.querySelector(".collabSidebar") };
}

function _finishSidebarSwipe(commit) {
  const els = _getCollabEls();
  if (!els) return;
  const { shell, mainEl, sidebarEl } = els;
  const dur = 200;
  const ease = "cubic-bezier(.4,0,.2,1)";
  mainEl.style.transition = `transform ${dur}ms ${ease}`;
  sidebarEl.style.transition = `opacity ${dur}ms ${ease}`;

  if (commit) {
    mainEl.style.transform = `translateX(${_SIDEBAR_W}px)`;
    sidebarEl.style.opacity = "1";
    sidebarEl.style.pointerEvents = "auto";
    _collabSidebarOpen = true;
    shell.classList.add("sidebarOpen");
  } else {
    mainEl.style.transform = "translateX(0)";
    sidebarEl.style.opacity = "0";
    sidebarEl.style.pointerEvents = "none";
    _collabSidebarOpen = false;
    shell.classList.remove("sidebarOpen");
  }

  setTimeout(() => {
    mainEl.style.transition = "";
    sidebarEl.style.transition = "";
    if (!_collabSidebarOpen) {
      mainEl.style.transform = "";
      sidebarEl.style.opacity = "";
      sidebarEl.style.pointerEvents = "";
    }
  }, dur);
}

// Hooked into existing document touchstart/move/end below
function _sidebarTouchStart(t) {
  // Only on collab root (no drill-in, no overlay)
  if (R.currentTab !== "collab" || R.projectDetailScreen || R.selectedSongId || R.overlayView) return false;
  const els = _getCollabEls();
  if (!els) return false;

  const { mainEl, sidebarEl } = els;
  // Open: left edge (same <= 24 as nav back). Close: anywhere while open.
  if (t.clientX <= 24 && !_collabSidebarOpen) {
    _sidebarSwipe = { tracking: true, decided: false, startX: t.clientX, startY: t.clientY, lastX: t.clientX, lastTime: Date.now() };
    mainEl.style.transition = "none";
    sidebarEl.style.transition = "none";
    return true;
  }
  if (_collabSidebarOpen) {
    _sidebarSwipe = { tracking: true, decided: true, startX: t.clientX, startY: t.clientY, lastX: t.clientX, lastTime: Date.now() };
    mainEl.style.transition = "none";
    sidebarEl.style.transition = "none";
    return true;
  }
  return false;
}

function _sidebarTouchMove(t) {
  if (!_sidebarSwipe.tracking) return;
  const sw = _sidebarSwipe;
  const dx = t.clientX - sw.startX;
  const dy = Math.abs(t.clientY - sw.startY);

  if (!sw.decided) {
    if (Math.abs(dx) < 6 && dy < 6) return;
    if (dy > Math.abs(dx)) { sw.tracking = false; return; }
    sw.decided = true;
  }

  sw.lastX = t.clientX; sw.lastTime = Date.now();

  let offset;
  if (_collabSidebarOpen) {
    offset = Math.max(0, Math.min(_SIDEBAR_W, _SIDEBAR_W + dx));
  } else {
    offset = Math.max(0, Math.min(_SIDEBAR_W, dx));
  }

  const els = _getCollabEls();
  if (!els) return;
  const ratio = offset / _SIDEBAR_W;
  els.mainEl.style.transform = `translateX(${offset}px)`;
  els.sidebarEl.style.opacity = String(ratio);
}

function _sidebarTouchEnd(t) {
  if (!_sidebarSwipe.tracking) return;
  const sw = _sidebarSwipe;
  sw.tracking = false;

  if (!sw.decided) {
    if (_collabSidebarOpen) _finishSidebarSwipe(false);
    return;
  }

  const dx = t ? t.clientX - sw.startX : 0;
  const velocity = t ? (t.clientX - sw.lastX) / Math.max(1, Date.now() - sw.lastTime) : 0;

  let offset;
  if (_collabSidebarOpen) {
    offset = Math.max(0, Math.min(_SIDEBAR_W, _SIDEBAR_W + dx));
  } else {
    offset = Math.max(0, Math.min(_SIDEBAR_W, dx));
  }

  const ratio = offset / _SIDEBAR_W;

  if (_collabSidebarOpen) {
    const close = ratio < 0.5 || velocity < -0.3;
    _finishSidebarSwipe(!close);
  } else {
    const open = ratio > 0.5 || velocity > 0.3;
    _finishSidebarSwipe(open);
  }
}

function _wireCollabSidebar() {
  const shell = ctx.getActiveScreenEl().querySelector(".collabShell");
  if (!shell) return;

  // Tap on shifted main content → close sidebar
  const mainEl = shell.querySelector(".collabMain");
  mainEl.addEventListener("click", (e) => {
    if (_collabSidebarOpen) {
      e.preventDefault(); e.stopPropagation();
      _finishSidebarSwipe(false);
    }
  }, true);

  // Sidebar button taps
  shell.querySelectorAll("[data-sidebar]").forEach(btn => {
    btn.addEventListener("click", () => {
      const action = btn.getAttribute("data-sidebar");
      // Navigate first — forward slide captures the ace with sidebar still visible
      if (action === "requests") openFriendsRequests();
      else if (action === "friends") openFriendsList();
      else if (action === "messages") openMessages();
      else if (action === "add") openAddFriend();
      // Reset sidebar state AFTER capture so back-nav renders it closed
      _collabSidebarOpen = false;
    });
  });
}

export function renderCollabContent() {
  // Show loading shimmer while shared data is still being fetched
  if (!sharedData.loaded) {
    ctx.getActiveScreenEl().innerHTML = `
      <div class="collabShell">
        <div class="collabSidebar">${_collabSidebarHTML()}</div>
        <div class="collabMain">
          <div class="collabWrap">
            <div class="songsPageTitle">Collab</div>
            <div class="collabSection">
              <div class="collabSectionTitle">Shared With Me</div>
              <div class="sharedLoadingShimmer"></div>
              <div class="sharedLoadingShimmer" style="animation-delay:.15s"></div>
            </div>
          </div>
        </div>
      </div>`;
    return;
  }

  const { projects: sharedProjects, songs: sharedSongs, invites, myProjects, mySongs } = sharedData;

  // Gather local collaborators from songs
  const counts = {};
  state.songs.forEach(s => {
    const raw = (s.collaborators || "").split(",").map(x => x.trim()).filter(Boolean);
    raw.forEach(name => { counts[name] = (counts[name] || 0) + 1; });
  });

  const collabRows = Object.entries(counts)
    .sort((a,b) => b[1] - a[1])
    .map(([name, count]) => `
      <div class="collabRow" data-collab-name="${escapeHtml(name)}">
        <div class="collabAvatar">${escapeHtml(name.charAt(0).toUpperCase())}</div>
        <div class="collabInfo">
          <div class="collabName">${escapeHtml(name)}</div>
          <div class="collabMeta">${count} song${count === 1 ? "" : "s"}</div>
        </div>
      </div>
    `).join("");

  // Shared projects cards
  const sharedProjCards = sharedProjects.map(sp => {
    const count = sp.songs.length;
    const repSong = sp.songs[0] || { id: sp.projectId, title: sp.projectName, project: sp.projectName, genre: "" };
    const roleBadge = sp.role === "collaborator"
      ? `<span class="sharedRoleBadge collab">Collaborator</span>`
      : `<span class="sharedRoleBadge viewer">Viewer</span>`;
    return `
      <div class="sharedCard" data-shared-proj="${escapeHtml(sp.projectId)}">
        <div class="sharedCardArt">${coverSvg(repSong, { lite: true })}</div>
        <div class="sharedCardBody">
          <div class="sharedCardTitle">${escapeHtml(sp.projectName)}</div>
          <div class="sharedCardMeta">from ${escapeHtml(sp.ownerName)} · ${count} song${count !== 1 ? "s" : ""}</div>
          ${roleBadge}
        </div>
      </div>
    `;
  }).join("");

  // Shared individual songs
  const sharedSongCards = sharedSongs.map(ss => {
    const s = ss.song;
    const roleBadge = ss.role === "collaborator"
      ? `<span class="sharedRoleBadge collab">Collaborator</span>`
      : `<span class="sharedRoleBadge viewer">Viewer</span>`;
    return `
      <div class="sharedCard" data-shared-song="${escapeHtml(s.id)}">
        <div class="sharedCardArt">${coverSvg(s, { lite: true })}</div>
        <div class="sharedCardBody">
          <div class="sharedCardTitle">${escapeHtml(s.title)}</div>
          <div class="sharedCardMeta">from ${escapeHtml(ss.ownerName)} · ${s.project ? escapeHtml(s.project) : "No project"}</div>
          ${roleBadge}
        </div>
      </div>
    `;
  }).join("");

  // Pending invites you've sent
  const pendingInvites = invites.filter(i => !i.accepted && !i.expired);
  const pendingHtml = pendingInvites.map(inv => `
    <div class="collabRow" style="align-items:flex-start">
      <div class="collabAvatar" style="background:linear-gradient(135deg,#6366f1,#a78bfa);font-size:13px">
        ${inv.targetType === "project" ? "P" : "S"}
      </div>
      <div class="collabInfo" style="flex:1">
        <div class="collabName">${escapeHtml(inv.targetName || "Unknown")}</div>
        <div class="collabMeta">${escapeHtml(inv.role)} · pending</div>
      </div>
      <button class="sharedDeleteInvite" data-del-invite="${inv.id}" aria-label="Delete invite" style="background:none;border:none;color:rgba(255,255,255,.4);font-size:18px;cursor:pointer;padding:4px 8px">&times;</button>
    </div>
  `).join("");

  const hasShared = sharedProjects.length || sharedSongs.length;

  // "Shared By Me" cards — projects & songs the user has shared with others
  const mySharedProjCards = myProjects.map(mp => `
    <div class="collabRow">
      <div class="collabAvatar" style="background:linear-gradient(135deg,#8b5cf6,#a78bfa);font-size:13px">P</div>
      <div class="collabInfo" style="flex:1">
        <div class="collabName">${escapeHtml(mp.projectName)}</div>
        <div class="collabMeta">to ${escapeHtml(mp.recipientName)} · ${escapeHtml(mp.role)}</div>
      </div>
    </div>
  `).join("");

  const mySharedSongCards = mySongs.map(ms => `
    <div class="collabRow">
      <div class="collabAvatar" style="background:linear-gradient(135deg,#8b5cf6,#a78bfa);font-size:13px">S</div>
      <div class="collabInfo" style="flex:1">
        <div class="collabName">${escapeHtml(ms.songTitle)}</div>
        <div class="collabMeta">to ${escapeHtml(ms.recipientName)} · ${escapeHtml(ms.role)}</div>
      </div>
    </div>
  `).join("");

  const hasMyShared = myProjects.length || mySongs.length;

  ctx.getActiveScreenEl().innerHTML = `
    <div class="collabShell">
      <div class="collabSidebar">${_collabSidebarHTML()}</div>
      <div class="collabMain">
        <div class="collabWrap">
          <div class="songsPageTitle">Collab</div>
          ${hasShared ? `
            <!-- Shared With Me -->
            <div class="collabSection">
              <div class="collabSectionTitle">Shared With Me</div>
              ${sharedProjCards}
              ${sharedSongCards}
            </div>
          ` : `
            <div class="collabSection">
              <div class="collabSectionTitle">Shared With Me</div>
              <div class="collabEmpty">
                Nothing shared with you yet. When someone shares a project or song, it'll appear here.
              </div>
            </div>
          `}

          <!-- Shared By Me -->
          <div class="collabSection">
            <div class="collabSectionTitle">Shared By Me</div>
            ${hasMyShared ? `${mySharedProjCards}${mySharedSongCards}` : `
              <div class="collabEmpty">
                You haven't shared anything yet. Tap the share button to send a project or song to a collaborator.
              </div>
            `}
          </div>

          ${pendingInvites.length ? `
            <div class="collabSection">
              <div class="collabSectionTitle">Pending Invites</div>
              ${pendingHtml}
            </div>
          ` : ""}

          <!-- Your Collaborators -->
          <div class="collabSection">
            <div class="collabSectionTitle">Your Collaborators</div>
            ${collabRows || `
              <div class="collabEmpty">
                No collaborators yet. Add names to the "Collaborators" field on any song, or send an invite!
              </div>
            `}
          </div>
        </div>

      </div>
    </div>
    <button class="sdFab" id="collabShareFab" aria-label="Share">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="24" height="24">
        <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
        <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
      </svg>
    </button>
  `;

  // Wire sidebar swipe + buttons
  _wireCollabSidebar();

  // Wire FAB → share picker
  $("#collabShareFab")?.addEventListener("click", () => {
    // Open a sheet to pick what to share
    openCollabSharePicker();
  });

  // Wire shared project taps → drill into project songs (reuses renderProjectSongs)
  ctx.getActiveScreenEl().querySelectorAll("[data-shared-proj]").forEach(card => {
    card.addEventListener("click", () => {
      const projId = card.getAttribute("data-shared-proj");
      const sp = sharedProjects.find(p => p.projectId === projId);
      if (!sp) return;
      ctx.navigateForward(() => {
        R.collabMode = true;
        R.projectDetailScreen = sp.projectName;
      });
    });
  });

  // Wire shared song taps → drill into song detail (reuses renderSongDetail)
  ctx.getActiveScreenEl().querySelectorAll("[data-shared-song]").forEach(card => {
    card.addEventListener("click", () => {
      const songId = card.getAttribute("data-shared-song");
      const ss = sharedSongs.find(s => s.song.id === songId);
      if (!ss) return;
      // Ensure the shared song is in the cache so getSong() can find it
      if (!state._sharedSongsCache) state._sharedSongsCache = [];
      if (!state._sharedSongsCache.find(s => s.id === ss.song.id)) {
        state._sharedSongsCache.push(ss.song);
      }
      ctx.navigateForward(() => {
        R.collabMode = true;
        R.selectedSongId = ss.song.id;
      });
    });
  });

  // Wire delete invite buttons
  ctx.getActiveScreenEl().querySelectorAll("[data-del-invite]").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.getAttribute("data-del-invite");
      if (!confirm("Delete this invite?")) return;
      try {
        await deleteShareInvite(id);
        sharedData.invites = sharedData.invites.filter(i => i.id !== id);
        renderCollabContent();
        toast("Invite deleted");
      } catch (e) { toast(e.message || "Failed"); }
    });
  });

  // Wire collab row taps → filter songs
  ctx.getActiveScreenEl().querySelectorAll(".collabRow[data-collab-name]").forEach(row => {
    row.addEventListener("click", () => {
      const name = row.getAttribute("data-collab-name");
      if (!name) return;
      R.currentTab = "songs";
      R.songsView = "list";
      R.selectedSongId = null;
      R.drawerView = null;
      ctx.setHeader("Songs");
      ctx.syncTabs();
      ctx.render();
      setTimeout(() => {
        const q = $("#q");
        if (q) {
          q.value = name;
          q.dispatchEvent(new Event("input"));
          toast(`Showing: ${name}`);
        }
      }, 0);
    });
  });

  // Pull fresh data in background if stale — disabled for debugging
  // if (sharedData.loaded) {
  //   ctx.refreshSharedData().then(() => {}).catch(() => {});
  // }
}

// ── Friends Overlays ─────────────────────────────

function _closeFriendsOverlay() {
  if (!_friendsOverlayEl) return;
  _friendsOverlayEl.classList.remove("open");
  setTimeout(() => { _friendsOverlayEl?.remove(); _friendsOverlayEl = null; }, 300);
}

function _friendAvatarHTML(profile) {
  if (!profile) return `<div class="friendAvatar">?</div>`;
  if (profile.avatar_url) {
    if (profile.avatar_url.startsWith("preset:")) {
      const presetId = profile.avatar_url.replace("preset:", "");
      const preset = AVATAR_PRESETS.find(p => p.id === presetId);
      if (preset) return `<div class="friendAvatar">${renderAvatarPreset(preset)}</div>`;
    } else {
      return `<div class="friendAvatar"><img src="${escapeHtml(profile.avatar_url)}" alt=""></div>`;
    }
  }
  const initial = (profile.display_name || "?").charAt(0).toUpperCase();
  return `<div class="friendAvatar">${escapeHtml(initial)}</div>`;
}

function _friendMetaText(profile) {
  if (!profile) return "";
  const parts = [profile.instrument, profile.genre, profile.location].filter(Boolean);
  return parts.length ? escapeHtml(parts.join(" · ")) : "";
}

// ── Friend Requests View ──
function _collapseSidebarInAce() {
  // Patch the swipe-back ace snapshot so Collab appears with sidebar closed
  const entry = nav.appStack[nav.appStack.length - 1];
  if (!entry?.clone) return;
  const shell = entry.clone.querySelector(".collabShell");
  if (!shell) return;
  shell.classList.remove("sidebarOpen");
  const main = shell.querySelector(".collabMain");
  const side = shell.querySelector(".collabSidebar");
  if (main) { main.style.transform = ""; main.style.transition = ""; }
  if (side) { side.style.opacity = "0"; side.style.transition = ""; side.style.pointerEvents = "none"; }
}

function openFriendsRequests() {
  ctx.navigateForward(() => { R.overlayView = "friendRequests"; });
  _collapseSidebarInAce();
}

export function renderFriendRequests() {
  ctx.setHeader("Friend Requests");
  ctx.getActiveScreenEl().innerHTML = `
    <div class="friendsBody" style="padding:16px 16px 40px; display:flex; flex-direction:column; gap:10px;">
      <div class="friendsEmpty"><div class="collabSpinner"></div><div style="margin-top:12px">Loading...</div></div>
    </div>
  `;

  getPendingFriendRequests().then(requests => {
    const body = ctx.getActiveScreenEl().querySelector(".friendsBody");
    if (!body) return;
    if (!requests.length) {
      body.innerHTML = `<div class="friendsEmpty">No pending friend requests.</div>`;
      return;
    }
    body.innerHTML = requests.map(r => `
      <div class="friendRow" data-req-id="${r.id}">
        ${_friendAvatarHTML(r.profile)}
        <div class="friendInfo">
          <div class="friendName">${escapeHtml(r.profile?.display_name || "Unknown")}</div>
          <div class="friendMeta">${_friendMetaText(r.profile)}</div>
        </div>
        <div class="friendActions">
          <button class="friendAcceptBtn" data-accept="${r.id}">Accept</button>
          <button class="friendDeclineBtn" data-decline="${r.id}">Decline</button>
        </div>
      </div>
    `).join("");

    body.querySelectorAll("[data-accept]").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = btn.getAttribute("data-accept");
        btn.textContent = "...";
        try {
          await acceptFriendRequest(id);
          const row = btn.closest(".friendRow");
          row.style.opacity = ".4";
          setTimeout(() => row.remove(), 300);
          toast("Friend request accepted!");
          _pendingFriendCount = Math.max(0, _pendingFriendCount - 1);
          _applyAllBadges(_unreadMsgCount, _pendingFriendCount);
          const notifs = _loadNotifications();
          const match = notifs.find(n => n.type === "friend_request" && n.friendshipId === id);
          if (match) _updateFriendNotification(match.id, "accepted");
        } catch (err) { toast(err.message || "Failed"); }
      });
    });

    body.querySelectorAll("[data-decline]").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = btn.getAttribute("data-decline");
        btn.textContent = "...";
        try {
          await removeFriendship(id);
          const row = btn.closest(".friendRow");
          row.style.opacity = ".4";
          setTimeout(() => row.remove(), 300);
          toast("Request declined");
          _pendingFriendCount = Math.max(0, _pendingFriendCount - 1);
          _applyAllBadges(_unreadMsgCount, _pendingFriendCount);
          const notifs = _loadNotifications();
          const match = notifs.find(n => n.type === "friend_request" && n.friendshipId === id);
          if (match) _updateFriendNotification(match.id, "declined");
        } catch (err) { toast(err.message || "Failed"); }
      });
    });
  }).catch(() => {
    const body = ctx.getActiveScreenEl().querySelector(".friendsBody");
    if (body) body.innerHTML = `<div class="friendsEmpty">Failed to load requests.</div>`;
  });
}

// ── Friends List View ──
function openFriendsList() {
  ctx.navigateForward(() => { R.overlayView = "friendsList"; });
  _collapseSidebarInAce();
}

export function renderFriendsList() {
  ctx.setHeader("Friends");
  document.querySelector(".app")?.classList.add("collapseTitle");
  const _h1 = document.querySelector(".titleblock h1");
  if (_h1) _h1.style.opacity = "0";
  ctx.getActiveScreenEl().innerHTML = `
    <div class="songsPageTitle">Friends</div>
    <div id="friendsPendingSection" style="display:none"></div>
    <div class="friendsBody" style="padding:16px 16px 40px; display:flex; flex-direction:column; gap:10px;">
      <div class="friendsEmpty"><div class="collabSpinner"></div><div style="margin-top:12px">Loading...</div></div>
    </div>
  `;

  // Load pending friend requests at top
  if (_pendingFriendCount) {
    const pendingEl = ctx.getActiveScreenEl().querySelector("#friendsPendingSection");
    getPendingFriendRequests().then(requests => {
      if (!requests.length || !pendingEl) return;
      pendingEl.style.display = "";
      pendingEl.innerHTML = `
        <div style="padding:16px 16px 0">
          <div class="collabPendingSectionLabel">Pending Requests</div>
          ${requests.map(r => `
            <div class="collabPendingRow alertRowClickable" data-req-id="${r.id}" data-req-profile="${r.requester_id}">
              ${_friendAvatarHTML(r.profile)}
              <div class="friendInfo">
                <div class="friendName">${escapeHtml(r.profile?.display_name || "Unknown")}</div>
                <div class="friendMeta">${_friendMetaText(r.profile)}</div>
              </div>
              <div class="friendActions">
                <button class="friendAcceptBtn" data-fl-accept="${r.id}">Accept</button>
                <button class="friendDeclineBtn" data-fl-decline="${r.id}">Decline</button>
              </div>
            </div>
          `).join("")}
        </div>
      `;
      pendingEl.querySelectorAll("[data-fl-accept]").forEach(btn => {
        btn.addEventListener("click", async (e) => {
          e.stopPropagation();
          const id = btn.getAttribute("data-fl-accept");
          btn.textContent = "...";
          try {
            await acceptFriendRequest(id);
            const row = btn.closest(".collabPendingRow");
            row.style.opacity = ".4";
            setTimeout(() => { row.remove(); if (!pendingEl.querySelector(".collabPendingRow")) pendingEl.style.display = "none"; }, 300);
            toast("Friend request accepted!");
            _pendingFriendCount = Math.max(0, _pendingFriendCount - 1);
            _applyAllBadges(_unreadMsgCount, _pendingFriendCount);
            const notifs = _loadNotifications();
            const match = notifs.find(n => n.type === "friend_request" && n.friendshipId === id);
            if (match) _updateFriendNotification(match.id, "accepted");
          } catch (err) { toast(err.message || "Failed"); btn.textContent = "Accept"; }
        });
      });
      pendingEl.querySelectorAll("[data-fl-decline]").forEach(btn => {
        btn.addEventListener("click", async (e) => {
          e.stopPropagation();
          const id = btn.getAttribute("data-fl-decline");
          btn.textContent = "...";
          try {
            await removeFriendship(id);
            const row = btn.closest(".collabPendingRow");
            row.style.opacity = ".4";
            setTimeout(() => { row.remove(); if (!pendingEl.querySelector(".collabPendingRow")) pendingEl.style.display = "none"; }, 300);
            toast("Request declined");
            _pendingFriendCount = Math.max(0, _pendingFriendCount - 1);
            _applyAllBadges(_unreadMsgCount, _pendingFriendCount);
            const notifs = _loadNotifications();
            const match = notifs.find(n => n.type === "friend_request" && n.friendshipId === id);
            if (match) _updateFriendNotification(match.id, "declined");
          } catch (err) { toast(err.message || "Failed"); btn.textContent = "Decline"; }
        });
      });
      // Click row (outside buttons) → open profile with accept/decline bar
      pendingEl.querySelectorAll("[data-req-profile]").forEach(row => {
        row.addEventListener("click", (e) => {
          if (e.target.closest("[data-fl-accept]") || e.target.closest("[data-fl-decline]")) return;
          const userId = row.getAttribute("data-req-profile");
          if (userId) {
            ctx.navigateForward(() => {
              R.friendProfileId = userId;
              R.overlayView = "friendProfile";
            });
          }
        });
      });
    }).catch(() => {});
  }

  // Delay async fetch so view transition can capture snapshot first
  setTimeout(() => getMyFriends().then(friends => {
    const body = ctx.getActiveScreenEl().querySelector(".friendsBody");
    if (!body) return;
    if (!friends.length) {
      body.innerHTML = `<div class="friendsEmpty">No friends yet. Swipe right on the Collab tab and tap <strong>Add</strong> to find people.</div>`;
      return;
    }
    body.innerHTML = friends.map(f => {
      const name = f.profile?.display_name || "Unknown";
      const fullName = [f.profile?.first_name, f.profile?.last_name].filter(Boolean).join(" ");
      return `
        <div class="friendRow" data-friend-id="${f.id}">
          ${_friendAvatarHTML(f.profile)}
          <div class="friendInfo">
            <div class="friendName">${escapeHtml(name)}</div>
            ${fullName ? `<div class="friendMeta">${escapeHtml(fullName)}</div>` : ""}
          </div>
          <button class="friendMsgBtn" data-msg="${f.friendId}" aria-label="Message">Message</button>
          <button class="friendRemoveBtn" data-remove="${f.id}" aria-label="Remove friend">&times;</button>
        </div>
      `;
    }).join("");

    body.querySelectorAll("[data-remove]").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = btn.getAttribute("data-remove");
        if (!confirm("Remove this friend?")) return;
        try {
          await removeFriendship(id);
          const row = btn.closest(".friendRow");
          row.style.opacity = ".4";
          setTimeout(() => row.remove(), 300);
          toast("Friend removed");
        } catch (err) { toast(err.message || "Failed"); }
      });
    });

    // Message button → open chat
    body.querySelectorAll(".friendMsgBtn").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const uid = btn.getAttribute("data-msg");
        if (uid) openChat(uid);
      });
    });

    // Tap friend row → open public profile
    body.querySelectorAll(".friendRow[data-friend-id]").forEach(row => {
      row.addEventListener("click", () => {
        const fId = row.getAttribute("data-friend-id");
        const friend = friends.find(f => String(f.id) === fId);
        if (!friend) return;
        ctx.navigateForward(() => {
          R.friendProfileId = friend.friendId;
          R.overlayView = "friendProfile";
        });
      });
    });
  }).catch(() => {
    const body = ctx.getActiveScreenEl().querySelector(".friendsBody");
    if (body) body.innerHTML = `<div class="friendsEmpty">Failed to load friends.</div>`;
  }), 350); // 350ms delay to let view transition capture snapshot
}

// ── Public Profile View (friend/user profile) ──
export function renderFriendProfile(userId) {
  if (!userId) return;
  ctx.setHeader("Profile");
  // Hide topbar title — the hero has its own large title (same as song detail)
  const _tbH1 = document.querySelector(".topbar h1");
  if (_tbH1) _tbH1.textContent = "";
  const appEl = document.querySelector(".app");
  appEl?.classList.add("pdActive");
  appEl?.classList.remove("pdScrolled");

  ctx.getActiveScreenEl().innerHTML = `
    <div class="profileWrap">
      <div class="collabSpinner" style="margin:80px auto 0"></div>
    </div>
  `;

  // Fetch profile + shared data + pending friendship status in parallel
  Promise.all([
    supabase.from("profiles").select("id, first_name, last_name, display_name, avatar_url, location, instrument, genre, bio").eq("id", userId).maybeSingle(),
    _getSharedWithUser(userId),
    getPendingFriendRequests().catch(() => []),
  ]).then(([{ data: profile }, shared, pendingRequests]) => {
    if (!profile) {
      ctx.getActiveScreenEl().innerHTML = `<div class="profileWrap"><div class="friendsEmpty">Profile not found.</div></div>`;
      return;
    }
    // Auto-detect pending friend request from this user (works from any entry point)
    if (!_pendingFriendAction) {
      const pending = pendingRequests.find(r => r.requester_id === userId);
      if (pending) {
        const notifs = _loadNotifications();
        const match = notifs.find(n => n.type === "friend_request" && n.friendshipId === pending.id);
        _pendingFriendAction = { friendshipId: pending.id, notifId: match?.id || null };
      }
    }
    _renderFriendProfileContent(profile, shared);
  }).catch(() => {
    ctx.getActiveScreenEl().innerHTML = `<div class="profileWrap"><div class="friendsEmpty">Failed to load profile.</div></div>`;
  });
}

// Gather songs shared between current user and this friend
async function _getSharedWithUser(friendId) {
  const { projects, songs, myProjects, mySongs } = sharedData;

  // Songs they shared WITH me (from sharedData.songs and sharedData.projects)
  const fromThem = [];
  for (const sp of projects) {
    if (sp.ownerId === friendId) {
      for (const s of sp.songs) fromThem.push(s);
    }
  }
  for (const ss of songs) {
    if (ss.ownerId === friendId) fromThem.push(ss.song);
  }

  // Songs I shared WITH them (from sharedData.myProjects and sharedData.mySongs)
  const fromMe = [];
  for (const mp of myProjects) {
    if (mp.recipientId === friendId) {
      // Find matching songs from my own library
      const matching = state.songs.filter(s => (s.project || "").trim() === mp.projectName);
      fromMe.push(...matching);
    }
  }
  for (const ms of mySongs) {
    if (ms.recipientId === friendId) {
      const s = state.songs.find(x => x.id === ms.songId);
      if (s) fromMe.push(s);
    }
  }

  return { fromThem, fromMe };
}

function _renderFriendProfileContent(profile, shared) {
  // Match song detail screen setup: sticky topbar height, no padding, scrollable
  const topbarEl = document.querySelector(".topbar");
  const topbarH = topbarEl ? topbarEl.offsetHeight : 0;
  ctx.getActiveScreenEl().style.setProperty("--pd-topbar-h", topbarH + "px");
  ctx.getActiveScreenEl().style.paddingBottom = "0px";
  ctx.getActiveScreenEl().style.overflowY = "scroll";

  const displayName = profile.display_name || "RiffBanker";
  const fullName = [profile.first_name, profile.last_name].filter(Boolean).join(" ");
  const avatarSrc = profile.avatar_url || null;
  const initial = (displayName || "?").charAt(0).toUpperCase();

  const { fromThem, fromMe } = shared;
  // Deduplicate
  const seenIds = new Set();
  const allSongs = [];
  for (const s of [...fromThem, ...fromMe]) {
    if (!seenIds.has(s.id)) { seenIds.add(s.id); allSongs.push(s); }
  }
  const fromThemCount = fromThem.length;
  const fromMeCount = fromMe.length;
  const totalCount = allSongs.length;

  // Hero image — use avatar as full-bleed background
  const presetMatch = avatarSrc?.startsWith("preset:") && AVATAR_PRESETS.find(p => p.id === avatarSrc.slice(7));
  const heroImg = presetMatch
    ? `<div style="width:100%;height:100%;background:${presetMatch.bg};display:flex;align-items:center;justify-content:center;font-size:80px">${presetMatch.emoji}</div>`
    : avatarSrc?.startsWith("http")
      ? `<img src="${avatarSrc}" style="width:100%;height:100%;object-fit:cover;display:block" onerror="this.style.display='none'" />`
      : `<div style="width:100%;height:100%;background:linear-gradient(135deg,#a78bfa,#f472b6)"></div>`;

  // Song rows builder — matches song detail compact row style
  const songRow = (s, i) => {
    const art = coverSvg(s, { lite: true });
    return `
      <div class="pdSongRow" data-fp-song="${escapeHtml(s.id)}">
        <span class="pdSongNum">${i + 1}</span>
        <div class="songThumb" aria-hidden="true">${art}</div>
        <div class="songMain">
          <div class="songTop">
            <div class="songTitleRow">
              <div class="songTitle">${escapeHtml(s.title || "Untitled")}</div>
            </div>
          </div>
          <div class="songSub">${escapeHtml(s.project || "No project")}</div>
        </div>
      </div>
    `;
  };

  const sharedWithMeRows = fromThem.length
    ? fromThem.map(songRow).join("")
    : `<div class="small" style="padding:24px 0;text-align:center;opacity:.5">Nothing shared with you yet.</div>`;
  const mySharedRows = fromMe.length
    ? fromMe.map(songRow).join("")
    : `<div class="small" style="padding:24px 0;text-align:center;opacity:.5">You haven't shared anything with ${escapeHtml(displayName)}.</div>`;
  const allRows = allSongs.length
    ? allSongs.map(songRow).join("")
    : `<div class="small" style="padding:24px 0;text-align:center;opacity:.5">No songs shared between you.</div>`;

  ctx.getActiveScreenEl().innerHTML = `
    <div class="pdHero">
      <div class="pdHeroBg" aria-hidden="true">${heroImg}</div>
      <div class="pdHeroContent">
        <div class="pdHeroTitle">${escapeHtml(displayName)}</div>
        <div class="pdHeroMeta">${escapeHtml(fullName || "—")} · ${totalCount} shared song${totalCount !== 1 ? "s" : ""}</div>
      </div>
    </div>

    <div class="pdActions">
      <button class="pdPlayBtn" id="fpPlay" ${!allSongs.length ? "disabled" : ""}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
      </button>
      <button class="pdShuffleBtn" id="fpShuffle" ${!allSongs.length ? "disabled" : ""}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>
      </button>
      <button class="pdMoreBtn" id="fpMore" aria-label="Options">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
      </button>
    </div>

    <div class="pdSticky">
      <div class="pdTabs">
        <button class="pdTab pdTabActive" data-fp-tab="all">All</button>
        <button class="pdTab" data-fp-tab="my-shared">My Shared</button>
        <button class="pdTab" data-fp-tab="shared-with-me">Shared With Me</button>
      </div>
      <div class="pdTabBody" id="fpTabBody">
        <div class="pdSongList">${allRows}</div>
      </div>
    </div>
    ${_pendingFriendAction ? `
      <div class="friendActionBar" id="fpFriendActionBar">
        <button class="friendActionAccept" id="fpActionAccept">Accept Friend Request</button>
        <button class="friendActionDecline" id="fpActionDecline">Decline</button>
      </div>
    ` : ""}
  `;

  ctx.getActiveScreenEl().scrollTop = 0;

  // Wire accept/decline action bar if present
  if (_pendingFriendAction) {
    const action = _pendingFriendAction;
    _pendingFriendAction = null; // consume it
    $("#fpActionAccept")?.addEventListener("click", async () => {
      const btn = $("#fpActionAccept");
      btn.textContent = "Accepting...";
      try {
        await acceptFriendRequest(action.friendshipId);
        if (action.notifId) _updateFriendNotification(action.notifId, "accepted");
        _pendingFriendCount = Math.max(0, _pendingFriendCount - 1);
        _applyAllBadges(_unreadMsgCount, _pendingFriendCount);
        toast("Friend request accepted!");
        const bar = $("#fpFriendActionBar");
        if (bar) { bar.style.opacity = "0"; setTimeout(() => bar.remove(), 300); }
      } catch (err) { toast(err.message || "Failed"); btn.textContent = "Accept Friend Request"; }
    });
    $("#fpActionDecline")?.addEventListener("click", async () => {
      const btn = $("#fpActionDecline");
      btn.textContent = "...";
      try {
        await removeFriendship(action.friendshipId);
        if (action.notifId) _updateFriendNotification(action.notifId, "declined");
        _pendingFriendCount = Math.max(0, _pendingFriendCount - 1);
        _applyAllBadges(_unreadMsgCount, _pendingFriendCount);
        toast("Request declined");
        const bar = $("#fpFriendActionBar");
        if (bar) { bar.style.opacity = "0"; setTimeout(() => bar.remove(), 300); }
      } catch (err) { toast(err.message || "Failed"); btn.textContent = "Decline"; }
    });
  }

  // Tab switching
  const tabBody = $("#fpTabBody");
  ctx.getActiveScreenEl().querySelectorAll(".pdTab").forEach(tab => {
    tab.addEventListener("click", () => {
      ctx.getActiveScreenEl().querySelectorAll(".pdTab").forEach(t => t.classList.remove("pdTabActive"));
      tab.classList.add("pdTabActive");
      const which = tab.getAttribute("data-fp-tab");
      if (which === "shared-with-me") tabBody.innerHTML = `<div class="pdSongList">${sharedWithMeRows}</div>`;
      else if (which === "my-shared") tabBody.innerHTML = `<div class="pdSongList">${mySharedRows}</div>`;
      else tabBody.innerHTML = `<div class="pdSongList">${allRows}</div>`;
      _wireFpSongRows();
    });
  });

  // Play all shared songs
  $("#fpPlay")?.addEventListener("click", async () => {
    const items = _fpPlayableItems(allSongs);
    if (!items.length) return toast("No playable songs");
    state.player.nowPlaying = items[0];
    state.player.queue = items.slice(1);
    state.player.repeatQueue = items;
    state.player.shuffle = false;
    state.player.repeat = false;
    saveState();
    unlockAudioOnce();
    await playNowPlaying({ autoplay: true });
    syncMiniPlayerUI();
  });

  // Shuffle
  $("#fpShuffle")?.addEventListener("click", async () => {
    const items = shuffleArray(_fpPlayableItems(allSongs));
    if (!items.length) return toast("No playable songs");
    state.player.nowPlaying = items[0];
    state.player.queue = items.slice(1);
    state.player.repeatQueue = items;
    state.player.shuffle = true;
    state.player.repeat = false;
    saveState();
    unlockAudioOnce();
    await playNowPlaying({ autoplay: true });
    syncMiniPlayerUI();
  });

  // More menu — share profile
  $("#fpMore")?.addEventListener("click", async () => {
    const text = `Check out ${displayName} on RiffBank!`;
    if (navigator.share) {
      try { await navigator.share({ title: "RiffBank Profile", text }); return; } catch {}
    }
    try { await navigator.clipboard.writeText(text); toast("Copied!"); } catch { toast("Couldn't copy"); }
  });

  _wireFpSongRows();

  // Fade hero + actions to black, solid topbar as user scrolls (same as song detail)
  const heroEl = ctx.getActiveScreenEl().querySelector(".pdHero");
  const heroBgEl = heroEl?.querySelector(".pdHeroBg");
  const heroContentEl = heroEl?.querySelector(".pdHeroContent");
  const actionsEl = ctx.getActiveScreenEl().querySelector(".pdActions");
  const stickyEl = ctx.getActiveScreenEl().querySelector(".pdSticky");
  const appEl = document.querySelector(".app");
  if (stickyEl && heroEl) {
    let maxScroll = 0;
    const FADE_PX = 200;
    requestAnimationFrame(() => {
      maxScroll = ctx.getActiveScreenEl().scrollHeight - ctx.getActiveScreenEl().clientHeight;
    });
    ctx.getActiveScreenEl().addEventListener("scroll", () => {
      const scrolled = ctx.getActiveScreenEl().scrollTop;
      if (maxScroll > 0) {
        const remaining = maxScroll - scrolled;
        const opacity = remaining < FADE_PX ? Math.max(0, remaining / FADE_PX) : 1;
        if (heroBgEl) heroBgEl.style.opacity = opacity;
        if (heroContentEl) heroContentEl.style.opacity = opacity;
        if (actionsEl) actionsEl.querySelectorAll("button").forEach(b => b.style.opacity = opacity);
      }
      if (appEl) {
        const heroBottom = heroEl.getBoundingClientRect().bottom;
        const screenTop = ctx.getActiveScreenEl().getBoundingClientRect().top;
        if (heroBottom - screenTop < 60) {
          appEl.classList.add("pdScrolled");
        } else {
          appEl.classList.remove("pdScrolled");
        }
      }
    }, { passive: true });
  }
}

// Build playable queue items from shared songs
function _fpPlayableItems(songs) {
  const items = [];
  for (const s of songs) {
    const active = (s.versions || []).find(v => v.isActive) || (s.versions || [])[0];
    if (active && active.audioPath) {
      items.push({ songId: s.id, versionId: active.id, title: s.title, project: s.project, label: active.label, audioPath: active.audioPath });
    }
  }
  return items;
}

// Wire click on song rows to drill into song detail
function _wireFpSongRows() {
  document.querySelectorAll("[data-fp-song]").forEach(row => {
    row.addEventListener("click", () => {
      const songId = row.getAttribute("data-fp-song");
      // Check if it's a shared song (in sharedData) or a local song
      const localSong = state.songs.find(s => s.id === songId);
      const sharedSong = sharedData.songs.find(ss => ss.song.id === songId)?.song
        || sharedData.projects.flatMap(sp => sp.songs).find(s => s.id === songId);
      if (localSong) {
        ctx.navigateForward(() => {
          R.selectedSongId = songId;
          R.selectedVersionId = null;
        });
      } else if (sharedSong) {
        // Temporarily inject into state for viewing
        if (!state._sharedSongsCache) state._sharedSongsCache = {};
        state._sharedSongsCache[songId] = sharedSong;
        ctx.navigateForward(() => {
          R.selectedSongId = songId;
          R.selectedVersionId = null;
          R.collabMode = true;
        });
      }
    });
  });
}

// ── Messages ──────────────────────────────────────

function openMessages() {
  requestNotificationPermission();
  ctx.navigateForward(() => { R.overlayView = "messages"; });
  _collapseSidebarInAce();
}

function openChat(userId) {
  ctx.navigateForward(() => { R.friendProfileId = userId; R.overlayView = "chat"; });
}

let _msgPollTimer = null;

export function renderMessages() {
  ctx.setHeader("Messages");
  document.querySelector(".app")?.classList.add("collapseTitle");
  const _h1 = document.querySelector(".titleblock h1");
  if (_h1) _h1.style.opacity = "0";
  ctx.getActiveScreenEl().innerHTML = `
    <div class="songsPageTitle">Messages</div>
    <div class="msgBody" style="padding:16px 16px 40px; display:flex; flex-direction:column; gap:0;">
      <div class="friendsEmpty"><div class="collabSpinner"></div><div style="margin-top:12px">Loading...</div></div>
    </div>
  `;

  setTimeout(() => getConversations().then(convos => {
    const body = ctx.getActiveScreenEl().querySelector(".msgBody");
    if (!body) return;
    if (!convos.length) {
      body.innerHTML = `<div class="friendsEmpty">No messages yet. Tap a friend's <strong>Message</strong> button to start a conversation.</div>`;
      return;
    }
    _renderConvoList(body, convos);
  }).catch(() => {
    const body = ctx.getActiveScreenEl().querySelector(".msgBody");
    if (body) body.innerHTML = `<div class="friendsEmpty">Failed to load messages.</div>`;
  }), 350);
}

function _renderConvoList(body, convos) {
  body.innerHTML = convos.map(c => {
    const name = c.profile?.display_name || "Unknown";
    const avatar = _friendAvatarHTML(c.profile);
    const preview = c.body?.length > 40 ? c.body.slice(0, 40) + "..." : (c.body || "");
    const prefix = c.isFromMe ? "You: " : "";
    const unread = c.unreadCount ? `<span class="msgUnread">${c.unreadCount}</span>` : "";
    const time = _relativeTime(c.created_at);
    return `
      <div class="msgConvoRow" data-chat-user="${c.partnerId}">
        ${avatar}
        <div class="msgConvoInfo">
          <div class="msgConvoTop">
            <div class="msgConvoName${c.unreadCount ? " msgConvoBold" : ""}">${escapeHtml(name)}</div>
            <div class="msgConvoTime">${time}</div>
          </div>
          <div class="msgConvoPreview${c.unreadCount ? " msgConvoBold" : ""}">
            ${escapeHtml(prefix + preview)}
            ${unread}
          </div>
        </div>
      </div>
    `;
  }).join("");

  body.querySelectorAll("[data-chat-user]").forEach(row => {
    row.addEventListener("click", () => {
      const userId = row.getAttribute("data-chat-user");
      openChat(userId);
    });
  });
}

function _relativeTime(isoStr) {
  if (!isoStr) return "";
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return mins + "m";
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + "h";
  const days = Math.floor(hrs / 24);
  if (days < 7) return days + "d";
  return new Date(isoStr).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ── Chat View ──

export function renderChat(userId) {
  if (!userId) return;
  ctx.setHeader("Chat");

  ctx.getActiveScreenEl().innerHTML = `
    <div class="chatWrap">
      <div class="chatMessages" id="chatMessages">
        <div class="collabSpinner" style="margin:40px auto"></div>
      </div>
      <div class="chatInputBar">
        <input class="chatInput" id="chatInput" type="text" placeholder="Message..." autocomplete="off" autocorrect="off" />
        <button class="chatSendBtn" id="chatSend" aria-label="Send">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
        </button>
      </div>
    </div>
  `;

  // Fetch partner profile for header
  supabase.from("profiles").select("display_name, avatar_url").eq("id", userId).maybeSingle().then(({ data: prof }) => {
    if (prof?.display_name) ctx.setHeader(prof.display_name);
  });

  const messagesEl = $("#chatMessages");
  const inputEl = $("#chatInput");
  let _chatUserId = userId;

  // Load messages
  async function loadMessages() {
    const msgs = await getMessages(_chatUserId);
    if (!messagesEl) return;
    await markMessagesRead(_chatUserId);
    ctx.syncMessageBadges();

    if (!msgs.length) {
      messagesEl.innerHTML = `<div class="chatEmpty">No messages yet. Say hello!</div>`;
    } else {
      _renderChatMessages(messagesEl, msgs);
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  loadMessages();

  // Poll for new messages every 5s
  if (_msgPollTimer) clearInterval(_msgPollTimer);
  _msgPollTimer = setInterval(async () => {
    if (R.overlayView !== "chat" || R.friendProfileId !== _chatUserId) {
      clearInterval(_msgPollTimer);
      _msgPollTimer = null;
      return;
    }
    const msgs = await getMessages(_chatUserId);
    if (msgs.length && messagesEl) {
      const wasAtBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 60;
      _renderChatMessages(messagesEl, msgs);
      if (wasAtBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
      markMessagesRead(_chatUserId);
    }
  }, 5000);

  // Send message
  async function doSend() {
    const text = inputEl?.value?.trim();
    if (!text) return;
    inputEl.value = "";
    const msg = await sendMessage(_chatUserId, text);
    if (msg) {
      const msgs = await getMessages(_chatUserId);
      _renderChatMessages(messagesEl, msgs);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } else {
      toast("Failed to send");
    }
  }

  $("#chatSend")?.addEventListener("click", doSend);
  inputEl?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); }
  });

  // Focus input after render
  setTimeout(() => inputEl?.focus(), 350);
}

async function _getCurrentUserId() {
  const { data } = await supabase.auth.getUser();
  return data?.user?.id || null;
}

let _cachedCurrentUserId = null;

function _renderChatMessages(container, msgs) {
  // Get current user ID synchronously from cache, or kick off async
  if (!_cachedCurrentUserId) {
    _getCurrentUserId().then(id => {
      _cachedCurrentUserId = id;
      _renderChatMessages(container, msgs);
    });
    return;
  }
  const uid = _cachedCurrentUserId;

  container.innerHTML = msgs.map(m => {
    const isMine = m.sender_id === uid;
    return `<div class="chatBubble ${isMine ? "chatBubbleMine" : "chatBubbleTheirs"}">${escapeHtml(m.body)}</div>`;
  }).join("");
}

// Wire "Message" buttons on friend list to open chat
function _wireFriendMsgButtons() {
  document.querySelectorAll(".friendMsgBtn[data-msg]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openChat(btn.getAttribute("data-msg"));
    });
  });
}

// ── Invite Share Screen (Venmo-style QR + share) ──
async function openInviteShareScreen() {
  const inviteUrl = `${location.origin}/invite.html`;
  const displayName = state.settings?.displayName || "RiffBank User";
  const avatarUrl = state.settings?.profileAvatarUrl || "";
  const initial = displayName.charAt(0).toUpperCase();

  const overlay = document.createElement("div");
  overlay.className = "inviteShareScreen";
  overlay.innerHTML = `
    <div class="issHeader">
      <button class="issCloseBtn" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="24" height="24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>

    <div class="issBody">
      <div class="issAvatar">
        ${avatarUrl
          ? (avatarUrl.startsWith("preset:")
            ? (() => { const pr = AVATAR_PRESETS.find(a => a.id === avatarUrl.replace("preset:","")); return pr ? renderAvatarPreset(pr) : escapeHtml(initial); })()
            : `<img src="${escapeHtml(avatarUrl)}" alt="">`)
          : escapeHtml(initial)
        }
      </div>
      <div class="issName">${escapeHtml(displayName)}</div>
      <div class="issSub">Scan to add me on RiffBank</div>

      <div class="issQrCard">
        <canvas id="issQrCanvas" width="220" height="220"></canvas>
      </div>

      <div class="issUrl">${escapeHtml(inviteUrl)}</div>
    </div>

    <div class="issActions">
      <button class="issActionBtn" id="issCopyBtn">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
        Copy
      </button>
      <button class="issActionBtn" id="issShareBtn">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
        Share
      </button>
    </div>
  `;

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("open"));

  // Close
  const close = () => {
    overlay.classList.remove("open");
    setTimeout(() => overlay.remove(), 300);
  };
  overlay.querySelector(".issCloseBtn").addEventListener("click", close);

  // Generate QR code on canvas
  try {
    const { default: QRCode } = await import("https://esm.sh/qrcode@1.5.4");
    const canvas = overlay.querySelector("#issQrCanvas");
    await QRCode.toCanvas(canvas, inviteUrl, {
      width: 220,
      margin: 2,
      color: { dark: "#000000", light: "#ffffff" },
      errorCorrectionLevel: "M",
    });
  } catch (e) {
    console.warn("QR generation failed:", e);
    const card = overlay.querySelector(".issQrCard");
    card.innerHTML = `<div style="padding:20px;text-align:center;color:var(--muted);font-size:13px">QR code unavailable</div>`;
  }

  // Copy link
  overlay.querySelector("#issCopyBtn").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      const btn = overlay.querySelector("#issCopyBtn");
      btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Copied!`;
      setTimeout(() => {
        btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copy`;
      }, 2000);
    } catch {
      toast("Couldn't copy");
    }
  });

  // Share
  overlay.querySelector("#issShareBtn").addEventListener("click", async () => {
    const msg = `Join me on RiffBank! ${inviteUrl}`;
    if (navigator.share) {
      try { await navigator.share({ title: "Join RiffBank", text: msg, url: inviteUrl }); } catch {}
    } else {
      await navigator.clipboard.writeText(inviteUrl);
      toast("Link copied!");
    }
  });
}

// ── Add Friend View ──
function openAddFriend() {
  ctx.navigateForward(() => { R.overlayView = "addFriend"; });
  _collapseSidebarInAce();
}

export function renderAddFriend() {
  ctx.setHeader("Add Friend");
  document.querySelector(".app")?.classList.add("collapseTitle");
  const _h1 = document.querySelector(".titleblock h1");
  if (_h1) _h1.style.opacity = "0";
  ctx.getActiveScreenEl().innerHTML = `
    <div class="songsPageTitle">Add Friend</div>
    <div class="friendSearchWrap" style="padding:16px;">
      <button class="friendInviteBtn" id="friendInvitePhone">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
        Share a Link
      </button>
      <input class="friendSearchInput" type="text" placeholder="Search by name..." autocomplete="off" />
    </div>
    <div class="friendsBody" style="padding:0 16px 40px; display:flex; flex-direction:column; gap:10px;">
      <div class="friendsEmpty">Search for someone to add as a friend.</div>
    </div>
  `;

  ctx.getActiveScreenEl().querySelector("#friendInvitePhone")?.addEventListener("click", () => {
    openInviteShareScreen();
  });

  const input = ctx.getActiveScreenEl().querySelector(".friendSearchInput");
  const body = ctx.getActiveScreenEl().querySelector(".friendsBody");
  let searchTimer = null;

  input.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (!q) {
      body.innerHTML = `<div class="friendsEmpty">Search for someone to add as a friend.</div>`;
      return;
    }
    if (q.length < 2) return;
    searchTimer = setTimeout(async () => {
      body.innerHTML = `<div class="friendsEmpty"><div class="collabSpinner"></div></div>`;
      try {
        const results = await searchUsers(q);
        if (!results.length) {
          body.innerHTML = `<div class="friendsEmpty">No users found for "${escapeHtml(q)}"</div>`;
          return;
        }
        body.innerHTML = results.map(u => `
          <div class="friendRow" data-add-uid="${u.id}">
            ${_friendAvatarHTML(u)}
            <div class="friendInfo">
              <div class="friendName">${escapeHtml(u.display_name || "Unknown")}</div>
              <div class="friendMeta">${_friendMetaText(u)}</div>
            </div>
            <button class="friendAcceptBtn" data-send="${u.id}">Add</button>
          </div>
        `).join("");

        body.querySelectorAll("[data-send]").forEach(btn => {
          btn.addEventListener("click", async (e) => {
            e.stopPropagation();
            const uid = btn.getAttribute("data-send");
            btn.textContent = "...";
            btn.disabled = true;
            try {
              const result = await sendFriendRequest(uid);
              if (result.status === "accepted") {
                btn.textContent = "Friends";
                btn.style.background = "rgba(34,197,94,.2)";
                btn.style.color = "#22c55e";
              } else {
                btn.textContent = "Sent!";
                btn.style.background = "rgba(255,255,255,.08)";
                btn.style.color = "var(--muted)";
              }
            } catch (err) {
              btn.textContent = "Add";
              btn.disabled = false;
              toast(err.message || "Failed");
            }
          });
        });
      } catch (err) {
        body.innerHTML = `<div class="friendsEmpty">Search failed. Try again.</div>`;
      }
    }, 300);
  });

  setTimeout(() => input.focus(), 350);
}

// Open share picker — choose project or song to share
// ── Profile Tab ──────────────────────────────────

let _profileData = null; // cached from Supabase
let _profileDataVersion = 0; // bumped on save — used to skip redundant DOM rewrites
let _profileRenderedVersion = -1; // version last written to DOM

