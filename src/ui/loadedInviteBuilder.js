import { state } from "../state.js";
import { toast } from "./toast.js";
import { escapeHtml, uid } from "./dom.js";
import {
  supabase, createLoadedInvite, updateLoadedInvite, deleteLoadedInvite,
} from "../supabase.js";

// Open the loaded invite builder (create or edit mode)
// editInvite: null for new, or an existing invite object to edit
export function openLoadedInviteBuilder(editInvite = null) {
  // Gather user's projects (name → supabase lookup needed) and songs
  const allProjects = [...new Set([
    ...(state.settings?.defaultProject ? [state.settings.defaultProject.trim()] : []),
    ...(state.projects || []).map(p => p.trim()).filter(Boolean),
    ...state.songs.map(s => (s.project || "").trim()).filter(Boolean),
  ])].sort();

  const allSongs = state.songs.filter(s => s.title).slice(0, 50);

  // Pre-select items if editing
  const selectedProjects = new Set();
  const selectedSongIds = new Set();
  let selectedRole = editInvite?.role || "viewer";

  // If editing, pre-populate from cached project names and song IDs
  if (editInvite) {
    for (const sid of (editInvite.song_ids || [])) selectedSongIds.add(sid);
    if (editInvite._projectNames) {
      for (const n of editInvite._projectNames) selectedProjects.add(n);
    }
  }

  // Create overlay
  const overlay = document.createElement("div");
  overlay.className = "liBuilderOverlay";
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("open"));

  function close() {
    overlay.classList.remove("open");
    setTimeout(() => overlay.remove(), 300);
  }

  function renderBuilder() {
    const totalSelected = selectedProjects.size + selectedSongIds.size;

    const projRows = allProjects.map(name => {
      const checked = selectedProjects.has(name);
      const songCount = state.songs.filter(s => (s.project || "").trim() === name).length;
      return `
        <button class="liBuilderItem${checked ? " liSelected" : ""}" data-li-proj="${escapeHtml(name)}">
          <div class="liBuilderCheck">${checked ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>` : ""}</div>
          <div class="liBuilderItemBody">
            <div class="liBuilderItemTitle">${escapeHtml(name)}</div>
            <div class="liBuilderItemSub">${songCount} song${songCount !== 1 ? "s" : ""}</div>
          </div>
        </button>`;
    }).join("");

    const songRows = allSongs.map(s => {
      const checked = selectedSongIds.has(s.id);
      const projName = (s.project || "").trim();
      const projSelected = projName && selectedProjects.has(projName);
      return `
        <button class="liBuilderItem${checked ? " liSelected" : ""}${projSelected ? " liDimmed" : ""}" data-li-song="${escapeHtml(s.id)}">
          <div class="liBuilderCheck">${checked ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>` : ""}</div>
          <div class="liBuilderItemBody">
            <div class="liBuilderItemTitle">${escapeHtml(s.title)}</div>
            <div class="liBuilderItemSub">${escapeHtml(s.project || "No project")}</div>
          </div>
        </button>`;
    }).join("");

    overlay.innerHTML = `
      <div class="liBuilderHeader">
        <button class="liBuilderClose" id="liBuilderClose">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
        <div class="liBuilderTitle">${editInvite ? "Edit Invite" : "Loaded Invite"}</div>
        <div class="liBuilderCount">${totalSelected} selected</div>
      </div>

      <div class="liBuilderBody">
        <div class="liBuilderSection">
          <div class="liBuilderSectionLabel">Role</div>
          <div class="liBuilderRoleBar">
            <button class="liRoleBtn${selectedRole === "viewer" ? " liRoleActive" : ""}" data-li-role="viewer">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              Viewer
            </button>
            <button class="liRoleBtn${selectedRole === "collaborator" ? " liRoleActive" : ""}" data-li-role="collaborator">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              Collaborator
            </button>
          </div>
        </div>

        ${allProjects.length ? `
          <div class="liBuilderSection">
            <div class="liBuilderSectionLabel">Projects</div>
            ${projRows}
          </div>
        ` : ""}

        ${allSongs.length ? `
          <div class="liBuilderSection">
            <div class="liBuilderSectionLabel">Songs</div>
            ${songRows}
          </div>
        ` : ""}
      </div>

      <div class="liBuilderFooter">
        ${editInvite ? `<button class="liBuilderDelete" id="liBuilderDelete">Delete Invite</button>` : ""}
        <button class="liBuilderBtn" id="liBuilderCreate" ${totalSelected === 0 ? "disabled" : ""}>
          ${editInvite ? "Save Changes" : "Create & Share"}
        </button>
      </div>
    `;

    // Wire close
    overlay.querySelector("#liBuilderClose").addEventListener("click", close);

    // Wire role buttons
    overlay.querySelectorAll(".liRoleBtn").forEach(btn => {
      btn.addEventListener("click", () => {
        selectedRole = btn.dataset.liRole;
        renderBuilder();
      });
    });

    // Wire project toggles
    overlay.querySelectorAll("[data-li-proj]").forEach(btn => {
      btn.addEventListener("click", () => {
        const name = btn.dataset.liProj;
        if (selectedProjects.has(name)) selectedProjects.delete(name);
        else selectedProjects.add(name);
        renderBuilder();
      });
    });

    // Wire song toggles
    overlay.querySelectorAll("[data-li-song]").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.liSong;
        if (selectedSongIds.has(id)) selectedSongIds.delete(id);
        else selectedSongIds.add(id);
        renderBuilder();
      });
    });

    // Wire delete button (edit mode)
    overlay.querySelector("#liBuilderDelete")?.addEventListener("click", async () => {
      if (!editInvite) return;
      try {
        await deleteLoadedInvite(editInvite.id);
        toast("Invite deleted");
        close();
        _refreshLoadedInvites().then(() => { if (R.currentTab === "collab") _renderCollabPillContent(); });
      } catch (e) {
        toast(e.message || "Failed to delete");
      }
    });

    // Wire create/save button
    overlay.querySelector("#liBuilderCreate").addEventListener("click", async () => {
      const btn = overlay.querySelector("#liBuilderCreate");
      btn.disabled = true;
      btn.textContent = editInvite ? "Saving..." : "Creating...";

      try {
        // Resolve project names to Supabase IDs
        const projectIds = [];
        if (selectedProjects.size) {
          const { data: userData } = await supabase.auth.getUser();
          const uid = userData?.user?.id;
          if (uid) {
            for (const name of selectedProjects) {
              const { data: proj } = await supabase
                .from("projects").select("id").eq("owner_id", uid).eq("name", name).maybeSingle();
              if (proj?.id) projectIds.push(proj.id);
            }
          }
        }

        // Filter out songs that belong to selected projects (avoid double-sharing)
        const filteredSongIds = [...selectedSongIds].filter(sid => {
          const song = state.songs.find(s => s.id === sid);
          if (!song) return false;
          const projName = (song.project || "").trim();
          return !selectedProjects.has(projName);
        });

        if (!projectIds.length && !filteredSongIds.length) {
          toast("Select at least one item");
          btn.disabled = false;
          btn.textContent = editInvite ? "Save Changes" : "Create & Share";
          return;
        }

        if (editInvite) {
          await updateLoadedInvite(editInvite.id, {
            projectIds,
            songIds: filteredSongIds,
            role: selectedRole,
          });
          toast("Invite updated!");
          close();
          _refreshLoadedInvites().then(() => { if (R.currentTab === "collab") _renderCollabPillContent(); });
        } else {
          const result = await createLoadedInvite({
            projectIds,
            songIds: filteredSongIds,
            role: selectedRole,
          });

          const url = `${location.origin}/invite.html?li=${result.token}`;

          if (navigator.share) {
            try {
              await navigator.share({ title: "RiffBank Invite", text: "Check out my music on RiffBank!", url });
            } catch (e) {
              if (e.name !== "AbortError") {
                await navigator.clipboard.writeText(url).catch(() => {});
                toast("Link copied!");
              }
            }
          } else {
            await navigator.clipboard.writeText(url).catch(() => {});
            toast("Invite link copied!");
          }

          close();
          _refreshLoadedInvites().then(() => { if (R.currentTab === "collab") _renderCollabPillContent(); });
        }
      } catch (e) {
        console.error("Loaded invite error:", e);
        toast(e.message || "Something went wrong");
        btn.disabled = false;
        btn.textContent = editInvite ? "Save Changes" : "Create & Share";
      }
    });
  }

  renderBuilder();

  // ── Swipe-down-to-dismiss from header ──
  let _swY0 = 0, _swiping = false;
  overlay.addEventListener("touchstart", (e) => {
    const header = overlay.querySelector(".liBuilderHeader");
    if (!header || !header.contains(e.target)) return;
    _swY0 = e.touches[0].clientY;
    _swiping = true;
    overlay.style.transition = "none";
  }, { passive: true });

  overlay.addEventListener("touchmove", (e) => {
    if (!_swiping) return;
    const dy = e.touches[0].clientY - _swY0;
    if (dy < 0) { overlay.style.transform = ""; return; }
    overlay.style.transform = `translateY(${dy}px)`;
    overlay.style.opacity = String(Math.max(0, 1 - dy / 400));
  }, { passive: true });

  overlay.addEventListener("touchend", (e) => {
    if (!_swiping) return;
    _swiping = false;
    const dy = (e.changedTouches[0]?.clientY || 0) - _swY0;
    overlay.style.transition = "";
    if (dy > 120) {
      overlay.style.transform = `translateY(${window.innerHeight}px)`;
      overlay.style.opacity = "0";
      setTimeout(() => overlay.remove(), 250);
    } else {
      overlay.style.transform = "";
      overlay.style.opacity = "";
    }
  }, { passive: true });
}
