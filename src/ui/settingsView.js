import { R } from "../router.js";
import { ctx } from "../appContext.js";
import { state, saveState } from "../state.js";
import { toast } from "./toast.js";
import { $, escapeHtml } from "./dom.js";
import { coverCache, generatingArtSongs } from "./coverArt.js";
import { startBulkGenArt, bulkArtState } from "./coverArtOps.js";
import { cacheAllCloudAudio, backupAllAudioToCloud } from "../audio/cloudSync.js";
import {
  supabase, signOut, supabasePushState, supabasePullState,
  supabaseUploadAudio, supabaseDiscoverAudioPaths, supabaseFetchCoverBlob,
  updatePassword,
} from "../supabase.js";

// recoverAndUploadAudio is passed via initSettingsView since it's still in app.js
let _recoverAndUploadAudio = null;
export function initSettingsView({ recoverAndUploadAudio }) {
  _recoverAndUploadAudio = recoverAndUploadAudio;
}

function _setCollapseTitle() {
  const el = ctx.getActiveScreenEl();
  if (el._collapseTitleScroll) {
    el.removeEventListener("scroll", el._collapseTitleScroll);
    el._collapseTitleScroll = null;
  }
  const _screen = el;
  const _sm = document.querySelector(".app.collapseTitle .titleblock h1");
  if (!_sm) return;
  requestAnimationFrame(() => {
    const bt = _screen.querySelector(".setPageTitle");
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

function _setNav(view, title) {
  ctx.navigateForward(() => {
    R.settingsView = view;
    ctx.setHeader(title);
    ctx.syncTabs();
  });
}

export function renderSettings() {
  ctx.setHeader("Settings");
  const appEl = document.querySelector(".app");
  appEl?.classList.add("collapseTitle");
  const h1 = appEl?.querySelector(".titleblock h1");
  if (h1) h1.style.opacity = "0";

  const songCount = state.songs.length;
  const projCount = [...new Set(state.songs.map(s => (s.project || "").trim()).filter(Boolean))].length;

  ctx.getActiveScreenEl().innerHTML = `
    <div class="setPage">
      <div class="setPageTitle">Settings</div>

      <div class="setSection">
        <div class="setSectionLabel">Account</div>
        <div class="setGroup">
          <div class="setRow" data-set="account">
            <div class="setRowIcon setIconBlue">${_setIcons.account}</div>
            <div class="setRowLabel">Account</div>
            <div class="setRowValue">Signed in</div>
            ${_setChev}
          </div>
        </div>
      </div>

      <div class="setSection">
        <div class="setSectionLabel">Data</div>
        <div class="setGroup">
          <div class="setRow" data-set="cloud">
            <div class="setRowIcon setIconTeal">${_setIcons.cloud}</div>
            <div class="setRowLabel">Cloud Sync</div>
            <span class="setStatusBadge" style="background:rgba(78,205,196,.15);color:#4ecdc4;">Connected</span>
            ${_setChev}
          </div>
          <div class="setRow" data-set="library">
            <div class="setRowIcon setIconPurple">${_setIcons.library}</div>
            <div class="setRowLabel">Library</div>
            <div class="setRowValue">${songCount} songs, ${projCount} projects</div>
            ${_setChev}
          </div>
        </div>
      </div>

      <div class="setSection">
        <div class="setSectionLabel">Tools</div>
        <div class="setGroup">
          <div class="setRow" data-set="art">
            <div class="setRowIcon setIconAmber">${_setIcons.art}</div>
            <div class="setRowLabel">AI Art</div>
            ${_setChev}
          </div>
          <div class="setRow" data-set="debug">
            <div class="setRowIcon setIconGray">${_setIcons.debug}</div>
            <div class="setRowLabel">Debug Tools</div>
            ${_setChev}
          </div>
        </div>
      </div>

      <div class="setSection">
        <div class="setGroup">
          <div class="setRow setDanger" data-set="danger">
            <div class="setRowIcon setIconRed">${_setIcons.danger}</div>
            <div class="setRowLabel">Danger Zone</div>
            ${_setChev}
          </div>
        </div>
      </div>
    </div>
  `;

  // Wire row navigation
  ctx.getActiveScreenEl().querySelectorAll("[data-set]").forEach(el => {
    el.addEventListener("click", () => {
      const view = el.dataset.set;
      const titles = { account: "Account", cloud: "Cloud Sync", library: "Library", art: "AI Art", debug: "Debug Tools", danger: "Danger Zone" };
      _setNav(view, titles[view] || "Settings");
    });
  });

  _setCollapseTitle();
}

// ── Settings: Account ──
export function renderSettingsAccount() {
  ctx.setHeader("Account");
  const appEl = document.querySelector(".app");
  appEl?.classList.add("collapseTitle");
  const h1 = appEl?.querySelector(".titleblock h1");
  if (h1) h1.style.opacity = "0";

  ctx.getActiveScreenEl().innerHTML = `
    <div class="setPage">
      <div class="setPageTitle">Account</div>
      <div class="setContent">
        <div class="setSection">
          <div class="setSectionLabel">Profile</div>
          <div class="setGroup">
            <div class="setRow" style="cursor:default">
              <div class="setRowIcon setIconBlue">${_setIcons.account}</div>
              <div class="setRowLabel">Signed in</div>
              <span class="setStatusBadge" style="background:rgba(74,222,128,.15);color:#4ade80;">Active</span>
            </div>
          </div>
        </div>
        <div class="setSection">
          <div class="setSectionLabel">Password</div>
          <div class="setGroup" style="padding:14px;display:flex;flex-direction:column;gap:10px">
            <input id="setNewPass" type="password" placeholder="New password" autocomplete="new-password" minlength="6" style="width:100%;padding:12px;background:var(--panel);border:1px solid var(--line);border-radius:10px;color:var(--text);font-family:'Montserrat',sans-serif;font-size:14px" />
            <input id="setNewPassConfirm" type="password" placeholder="Confirm new password" autocomplete="new-password" minlength="6" style="width:100%;padding:12px;background:var(--panel);border:1px solid var(--line);border-radius:10px;color:var(--text);font-family:'Montserrat',sans-serif;font-size:14px" />
            <div id="setPassMsg" style="font-size:13px;min-height:16px;font-family:'Montserrat',sans-serif"></div>
            <button class="setBtn" id="setChangePass">Update password</button>
          </div>
          <div class="setDesc">Choose a new password. Use this to set one if you signed in via a reset link.</div>
        </div>
        <div class="setSection">
          <button class="setBtn setBtnRed" id="setSignOut">Sign Out</button>
          <div class="setDesc">Your local data stays on this device after signing out.</div>
        </div>
      </div>
    </div>
  `;

  $("#setSignOut")?.addEventListener("click", async () => {
    if (!confirm("Sign out? Your local data stays on this device.")) return;
    await signOut();
    window.location.reload();
  });

  $("#setChangePass")?.addEventListener("click", async () => {
    const pass = $("#setNewPass").value;
    const confirmPass = $("#setNewPassConfirm").value;
    const msg = $("#setPassMsg");
    msg.style.color = "#f87171";
    if (!pass || pass.length < 6) { msg.textContent = "Password must be at least 6 characters"; return; }
    if (pass !== confirmPass) { msg.textContent = "Passwords don't match"; return; }
    const btn = $("#setChangePass");
    btn.disabled = true;
    btn.textContent = "Updating...";
    try {
      await updatePassword(pass);
      msg.style.color = "#22c55e";
      msg.textContent = "Password updated.";
      $("#setNewPass").value = "";
      $("#setNewPassConfirm").value = "";
    } catch (err) {
      msg.textContent = err.message || "Couldn't update password";
    }
    btn.disabled = false;
    btn.textContent = "Update password";
  });

  _setCollapseTitle();
}

// ── Settings: Cloud Sync ──
export function renderSettingsCloud() {
  ctx.setHeader("Cloud Sync");
  const appEl = document.querySelector(".app");
  appEl?.classList.add("collapseTitle");
  const h1 = appEl?.querySelector(".titleblock h1");
  if (h1) h1.style.opacity = "0";

  ctx.getActiveScreenEl().innerHTML = `
    <div class="setPage">
      <div class="setPageTitle">Cloud Sync</div>
      <div class="setContent">
        <div class="setSection">
          <div class="setSectionLabel">Sync Actions</div>
          <div class="setGroup">
            <div class="setRow" id="cloudSyncPush">
              <div class="setRowIcon setIconTeal">${_setIcons.cloud}</div>
              <div class="setRowLabel">Push to Cloud</div>
              ${_setChev}
            </div>
            <div class="setRow" id="cloudSyncPull">
              <div class="setRowIcon setIconBlue">${_setIcons.cloud}</div>
              <div class="setRowLabel">Pull from Cloud</div>
              ${_setChev}
            </div>
          </div>
          <div class="setDesc">Push sends your local data to the cloud. Pull replaces local data with cloud data.</div>
        </div>

        <div class="setSection">
          <div class="setSectionLabel">Audio Storage</div>
          <div class="setGroup">
            <div class="setRow" id="cloudBackupAll">
              <div class="setRowIcon setIconGreen">${_setIcons.cloud}</div>
              <div class="setRowLabel">Backup All Audio to Cloud</div>
              ${_setChev}
            </div>
            <div class="setRow" id="cloudCacheAll">
              <div class="setRowIcon setIconPurple">${_setIcons.cloud}</div>
              <div class="setRowLabel">Cache All Audio Locally</div>
              ${_setChev}
            </div>
          </div>
          <div class="setDesc">Backup uploads local-only audio to the cloud. Cache downloads cloud audio to this device for offline playback.</div>
        </div>

        <div class="setSection">
          <div class="setSectionLabel">Recovery</div>
          <div class="setGroup">
            <div class="setRow" id="cloudRecoverAudio">
              <div class="setRowIcon setIconAmber">${_setIcons.debug}</div>
              <div class="setRowLabel">Recover Audio</div>
              ${_setChev}
            </div>
          </div>
          <div class="setDesc">Scans this device for disconnected audio blobs and re-links them to your songs.</div>
        </div>
      </div>
    </div>
  `;

  $("#cloudSyncPush")?.addEventListener("click", async () => {
    toast("Pushing to cloud…");
    const ok = await supabasePushState(state);
    toast(ok ? "Pushed to cloud" : "Push failed");
  });

  $("#cloudSyncPull")?.addEventListener("click", async () => {
    toast("Pulling from cloud…");
    const cloudState = await supabasePullState();
    if (cloudState?.songs) {
      if (!confirm(`Found ${cloudState.songs.length} songs in cloud. This will wipe all local data and replace it with cloud data. Continue?`)) return;
      toast("Clearing local data…");
      audioUrlCache.clear();
      try {
        const db = await openAudioDB();
        await new Promise((resolve, reject) => {
          const tx = db.transaction(AUDIO_STORE, "readwrite");
          tx.objectStore(AUDIO_STORE).clear();
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } catch (e) { console.warn("[Pull] IDB clear failed:", e); }
      setState(cloudState);
      normalizeState();
      const missingCount = state.songs.reduce((n, s) => n + (s.versions || []).filter(v => !v.audioPath).length, 0);
      if (missingCount) {
        toast(`Discovering audio for ${missingCount} versions…`);
        const discovered = await supabaseDiscoverAudioPaths(state.songs);
        toast(`Found ${discovered.length}/${missingCount} audio files in storage`);
      }
      localStorage.setItem(LS_KEY, JSON.stringify(state));
      ctx.render();
      toast("Caching cloud audio…");
      await supabasePushState(state).catch(console.warn);
      await cacheAllCloudAudio();
      await restoreCoverUrlsFromCache(state.songs, supabaseFetchCoverBlob);
    } else {
      toast("No data found in cloud");
    }
  });

  $("#cloudBackupAll")?.addEventListener("click", () => backupAllAudioToCloud());
  $("#cloudCacheAll")?.addEventListener("click", () => cacheAllCloudAudio());
  $("#cloudRecoverAudio")?.addEventListener("click", () => _recoverAndUploadAudio && _recoverAndUploadAudio());

  _setCollapseTitle();
}

// ── Settings: Library ──
export function renderSettingsLibrary() {
  ctx.setHeader("Library");
  const appEl = document.querySelector(".app");
  appEl?.classList.add("collapseTitle");
  const h1 = appEl?.querySelector(".titleblock h1");
  if (h1) h1.style.opacity = "0";

  ctx.getActiveScreenEl().innerHTML = `
    <div class="setPage">
      <div class="setPageTitle">Library</div>
      <div class="setContent">
        <div class="setSection">
          <div class="setSectionLabel">Defaults</div>
          <div class="setGroup" style="padding:16px">
            <div class="setInputGroup">
              <div class="setInputLabel">Default Project</div>
              <input class="setInput" id="defProject" type="text" value="${escapeHtml(state.settings.defaultProject || "")}" />
            </div>
            <div class="setInputGroup">
              <div class="setInputLabel">Default Genre</div>
              <input class="setInput" id="defGenre" type="text" value="${escapeHtml(state.settings.defaultGenre || "")}" />
            </div>
            <div class="setInputGroup" style="margin-bottom:0">
              <div class="setInputLabel">Default Sprint</div>
              <input class="setInput" id="defSprint" type="text" value="${escapeHtml(state.settings.defaultSprint || "")}" />
            </div>
          </div>
        </div>
        <div class="setSection">
          <button class="setBtn setBtnTeal" id="saveSettings">Save Defaults</button>
        </div>

        <div class="setSection">
          <div class="setSectionLabel">Health</div>
          <div class="setGroup" id="libraryHealthPanel" style="padding:16px">
            <div style="font-size:13px; opacity:.5">Scanning library…</div>
          </div>
        </div>
      </div>
    </div>
  `;

  $("#saveSettings")?.addEventListener("click", () => {
    state.settings.defaultProject = $("#defProject").value.trim() || "";
    state.settings.defaultGenre = $("#defGenre").value.trim() || "";
    state.settings.defaultSprint = $("#defSprint").value.trim() || "";
    saveState();
    toast("Saved");
  });

  // Library Health panel — async scan (same logic as before)
  (async () => {
    const panel = document.getElementById("libraryHealthPanel");
    if (!panel) return;
    const allBlobs = await audioGetAll().catch(() => []);
    const blobByName = new Map(), blobById = new Map(), blobByTitleKey = new Map();
    const allLocalBlobs = [];
    for (const rec of allBlobs) {
      if (rec.id.startsWith("supa:") || rec.id.startsWith("cover:")) continue;
      blobById.set(rec.id, rec); allLocalBlobs.push(rec);
      if (rec.name) {
        blobByName.set(rec.name, rec);
        const key = rec.name.replace(/\.[^.]+$/, "").toLowerCase().trim();
        if (key) blobByTitleKey.set(key, rec);
      }
    }
    const recoverable = [], unrecoverable = [], referencedBlobIds = new Set(), usedBlobIds = new Set();
    for (const song of (state.songs || [])) {
      let songHasAudio = false, songRecovered = false;
      for (const v of (song.versions || [])) {
        if (v.fileId) referencedBlobIds.add(v.fileId);
        if (v.localAudioId) referencedBlobIds.add(v.localAudioId);
        if (isPlayable(v)) { songHasAudio = true; continue; }
        let rec = blobById.get(v.fileId) || blobById.get(v.localAudioId) || blobByName.get(v.fileName) || blobByName.get(v.originalFileName);
        if (!rec) { const titleKey = (song.title || "").toLowerCase().trim(); if (titleKey) rec = blobByTitleKey.get(titleKey); }
        if (rec?.blob && !usedBlobIds.has(rec.id)) { usedBlobIds.add(rec.id); recoverable.push({ song, version: v, blobRec: rec }); songRecovered = true; }
      }
      if (!songHasAudio && !songRecovered) unrecoverable.push(song);
    }
    const recoverableBlobIds = new Set(recoverable.map(r => r.blobRec.id));
    let orphanCount = 0, orphanSize = 0;
    for (const rec of allBlobs) {
      if (rec.id.startsWith("supa:") || rec.id.startsWith("cover:")) continue;
      if (!referencedBlobIds.has(rec.id) && !recoverableBlobIds.has(rec.id)) { orphanCount++; orphanSize += (rec.size || rec.blob?.size || 0); }
    }
    const orphanMB = (orphanSize / 1024 / 1024).toFixed(1);

    if (!recoverable.length && !unrecoverable.length && !orphanCount) {
      panel.innerHTML = `
        <div style="display:flex; align-items:center; gap:8px">
          <span style="color:#4ade80; font-size:18px;">●</span>
          <span style="font-weight:700; font-size:14px;">Library is healthy</span>
        </div>
        <div style="font-size:13px; opacity:.5; margin-top:6px">${state.songs.length} songs, all playable. No orphaned data.</div>
      `;
      return;
    }
    const recoverableSongs = [...new Map(recoverable.map(r => [r.song.id, r.song])).values()];
    panel.innerHTML = `
      ${recoverable.length ? `
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px"><span style="color:#ffb84d; font-size:18px;">●</span><span style="font-weight:700; font-size:14px;">${recoverableSongs.length} song${recoverableSongs.length === 1 ? "" : "s"} can be repaired</span></div>
        <div style="font-size:13px; opacity:.5; margin-bottom:12px">Audio is on this device but disconnected. Repair will re-link and upload.</div>
        <button class="setBtn setBtnTeal" id="healthRepair">Repair ${recoverableSongs.length} song${recoverableSongs.length === 1 ? "" : "s"}</button>
      ` : ""}
      ${unrecoverable.length ? `
        <div style="display:flex; align-items:center; gap:8px; margin-top:${recoverable.length ? 16 : 0}px; margin-bottom:8px"><span style="color:#f87171; font-size:18px;">●</span><span style="font-weight:700; font-size:14px;">${unrecoverable.length} song${unrecoverable.length === 1 ? "" : "s"} with no audio</span></div>
        <div style="font-size:13px; opacity:.5; margin-bottom:12px">No matching audio found. Re-upload or delete these songs.</div>
        <button class="setBtn setBtnRed" id="healthDeleteBroken">Delete ${unrecoverable.length} broken song${unrecoverable.length === 1 ? "" : "s"}</button>
      ` : ""}
      ${orphanCount ? `
        <div style="display:flex; align-items:center; gap:8px; margin-top:16px; margin-bottom:8px"><span style="color:#888; font-size:18px;">●</span><span style="font-weight:700; font-size:14px;">${orphanCount} leftover blob${orphanCount === 1 ? "" : "s"} (${orphanMB} MB)</span></div>
        <button class="setBtn setBtnGray" id="healthCleanBlobs" style="margin-top:8px">Clean up (${orphanMB} MB)</button>
      ` : ""}
    `;

    document.getElementById("healthRepair")?.addEventListener("click", async () => {
      const btn = document.getElementById("healthRepair");
      if (btn) { btn.disabled = true; btn.textContent = "Repairing…"; }
      let relinked = 0, uploaded = 0, failed = 0;
      for (const { song, version: v, blobRec: rec } of recoverable) {
        v.fileId = rec.id; v.fileType = v.fileType || rec.type || ""; v.fileSize = v.fileSize || rec.size || 0; relinked++;
        if (!v.audioPath) {
          try {
            if (btn) btn.textContent = `Uploading ${song.title}…`;
            const uploadBlob = await compressAudioForUpload(rec.blob, globalAudio);
            const fileName = v.fileName || rec.name || "audio";
            const result = await supabaseUploadAudio({ blob: new File([uploadBlob], fileName, { type: uploadBlob.type || rec.type || "audio/*" }), songId: song.id, versionId: v.id, fileName });
            if (result.success) { v.audioPath = result.audioPath; uploaded++; } else { failed++; }
          } catch { failed++; }
        }
      }
      saveState(); await supabasePushState(state).catch(console.warn);
      toast(`Repaired ${relinked} song${relinked === 1 ? "" : "s"}` + (uploaded ? `, ${uploaded} uploaded` : "") + (failed ? `, ${failed} failed` : ""));
      renderSettingsLibrary();
    });

    document.getElementById("healthDeleteBroken")?.addEventListener("click", async () => {
      const ids = new Set(unrecoverable.map(s => s.id));
      if (!confirm(`Delete ${ids.size} song${ids.size === 1 ? "" : "s"} with no audio? This cannot be undone.`)) return;
      state.songs = state.songs.filter(s => !ids.has(s.id));
      saveState(); toast(`Deleted ${ids.size} broken song${ids.size === 1 ? "" : "s"}`);
      await supabasePushState(state).catch(console.warn);
      renderSettingsLibrary();
    });

    document.getElementById("healthCleanBlobs")?.addEventListener("click", async () => {
      if (!confirm(`Delete ${orphanCount} orphaned blob${orphanCount === 1 ? "" : "s"} (${orphanMB} MB)?`)) return;
      let cleaned = 0;
      try {
        const db = await openAudioDb();
        const tx = db.transaction(AUDIO_STORE, "readwrite");
        const store = tx.objectStore(AUDIO_STORE);
        for (const rec of allBlobs) {
          if (rec.id.startsWith("supa:") || rec.id.startsWith("cover:")) continue;
          if (!referencedBlobIds.has(rec.id) && !recoverableBlobIds.has(rec.id)) { store.delete(rec.id); cleaned++; }
        }
        await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
        db.close();
      } catch (e) { console.warn("[Health] Blob cleanup failed:", e); }
      toast(`Cleaned ${cleaned} blob${cleaned === 1 ? "" : "s"}`);
      renderSettingsLibrary();
    });
  })();

  _setCollapseTitle();
}

// ── Settings: AI Art ──
export function renderSettingsArt() {
  ctx.setHeader("AI Art");
  const appEl = document.querySelector(".app");
  appEl?.classList.add("collapseTitle");
  const h1 = appEl?.querySelector(".titleblock h1");
  if (h1) h1.style.opacity = "0";

  const artStatus = bulkArtState.running ? `${bulkArtState.done}/${bulkArtState.total} done…` : "";

  ctx.getActiveScreenEl().innerHTML = `
    <div class="setPage">
      <div class="setPageTitle">AI Art</div>
      <div class="setContent">
        <div class="setSection">
          <div class="setSectionLabel">Cover Art Generation</div>
          <div class="setGroup" style="padding:16px">
            <div style="font-size:13px; opacity:.5; margin-bottom:14px">Generate unique cover art for your songs using AI. Missing art only generates for songs without covers.</div>
            <button class="setBtn setBtnTeal" id="genMissingArt" ${bulkArtState.running ? "disabled" : ""} style="margin-bottom:10px">${artStatus || "Generate Missing Art"}</button>
            <button class="setBtn setBtnAmber" id="regenAllArt" ${bulkArtState.running ? "disabled" : ""}>${artStatus || "Regenerate All Art"}</button>
          </div>
        </div>
      </div>
    </div>
  `;

  $("#genMissingArt")?.addEventListener("click", () => startBulkGenArt(true));
  $("#regenAllArt")?.addEventListener("click", () => startBulkGenArt(false));

  _setCollapseTitle();
}

// ── Settings: Debug Tools ──
export function renderSettingsDebug() {
  ctx.setHeader("Debug Tools");
  const appEl = document.querySelector(".app");
  appEl?.classList.add("collapseTitle");
  const h1 = appEl?.querySelector(".titleblock h1");
  if (h1) h1.style.opacity = "0";

  ctx.getActiveScreenEl().innerHTML = `
    <div class="setPage">
      <div class="setPageTitle">Debug Tools</div>
      <div class="setContent">
        <div class="setSection">
          <div class="setSectionLabel">Sync Debug</div>
          <div class="setGroup">
            <div class="setRow" id="toggleSyncDebug">
              <div class="setRowIcon ${window.RIFFBANK_DEBUG_SYNC ? "setIconTeal" : "setIconGray"}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
              </div>
              <div class="setRowLabel">Sync Debug</div>
              <div class="setRowValue">${window.RIFFBANK_DEBUG_SYNC ? "ON" : "OFF"}</div>
              ${_setChev}
            </div>
            <div class="setRow" id="runSyncAudit">
              <div class="setRowIcon setIconGray">${_setIcons.debug}</div>
              <div class="setRowLabel">Run Sync Audit</div>
              ${_setChev}
            </div>
            <div class="setRow" id="debugRecoveryBtn">
              <div class="setRowIcon setIconGray">${_setIcons.debug}</div>
              <div class="setRowLabel">Debug Recovery</div>
              ${_setChev}
            </div>
          </div>
          <div class="setDesc">Sync debug shows colored dots on song cards: <span style="color:#4ade80">●</span> synced <span style="color:#facc15">●</span> local only <span style="color:#f87171">●</span> no audio</div>
        </div>
      </div>
    </div>
  `;

  $("#toggleSyncDebug")?.addEventListener("click", () => {
    window.RIFFBANK_DEBUG_SYNC = !window.RIFFBANK_DEBUG_SYNC;
    toast(`Sync debug ${window.RIFFBANK_DEBUG_SYNC ? "ON" : "OFF"}`);
    renderSettingsDebug();
  });

  $("#runSyncAudit")?.addEventListener("click", async () => {
    toast("Running sync audit…");
    const results = await window.auditSync();
    const reds = results.filter(r => r.status === "red");
    const yellows = results.filter(r => r.status === "yellow");
    const greens = results.length - reds.length - yellows.length;
    toast(`${results.length} versions: ${greens} synced, ${yellows.length} local only, ${reds.length} no audio`);
  });

  $("#debugRecoveryBtn")?.addEventListener("click", () => debugRecovery());

  _setCollapseTitle();
}

// ── Settings: Danger Zone ──
export function renderSettingsDanger() {
  ctx.setHeader("Danger Zone");
  const appEl = document.querySelector(".app");
  appEl?.classList.add("collapseTitle");
  const h1 = appEl?.querySelector(".titleblock h1");
  if (h1) h1.style.opacity = "0";

  ctx.getActiveScreenEl().innerHTML = `
    <div class="setPage">
      <div class="setPageTitle">Danger Zone</div>
      <div class="setContent">
        <div class="setSection">
          <div class="setSectionLabel">Clear Library</div>
          <div class="setGroup" style="padding:16px">
            <div style="font-size:13px; opacity:.5; margin-bottom:14px">
              Permanently delete <b>all songs, versions, projects, and audio</b> from both Supabase and this device. This cannot be undone.
            </div>
            <button class="setBtn setBtnRed" id="clearEntireLibrary">Clear Entire Library</button>
          </div>
        </div>

        <div class="setSection">
          <div class="setSectionLabel">Clear Songs Only</div>
          <div class="setGroup" style="padding:16px">
            <div style="font-size:13px; opacity:.5; margin-bottom:14px">
              Permanently delete <b>all songs, versions, and audio</b> but keep your projects. This cannot be undone.
            </div>
            <button class="setBtn setBtnRed" id="clearSongsOnly">Clear Songs</button>
          </div>
        </div>

        <div class="setSection">
          <div class="setSectionLabel">Local Data</div>
          <div class="setGroup" style="padding:16px">
            <div style="font-size:13px; opacity:.5; margin-bottom:14px">
              Wipe all local data (localStorage + IndexedDB) and sign out. Cloud data is untouched. Like deleting and reinstalling.
            </div>
            <button class="setBtn setBtnGray" id="wipe">Wipe Local Data & Sign Out</button>
          </div>
        </div>
      </div>
    </div>
  `;

  // Clear Entire Library — Supabase + local
  $("#clearEntireLibrary")?.addEventListener("click", async () => {
    if (!confirm("Delete ALL songs, versions, projects, and audio from your account and this device? This cannot be undone.")) return;
    if (!confirm("Are you absolutely sure? This will permanently erase your entire RiffBank library from the cloud.")) return;

    // Full-screen progress overlay
    const overlay = document.createElement("div");
    overlay.id = "clearLibOverlay";
    overlay.style.cssText = "position:fixed;inset:0;z-index:999999;background:var(--bg,#0d0d0f);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;padding:32px;";
    overlay.innerHTML = `
      <div style="font-size:24px;font-weight:700;color:#fff;letter-spacing:-0.3px;">Clearing Library</div>
      <div id="clearLibStatus" style="font-size:15px;color:rgba(255,255,255,.5);text-align:center;">Preparing…</div>
      <div style="width:240px;height:4px;background:rgba(255,255,255,.08);border-radius:2px;overflow:hidden;">
        <div id="clearLibBar" style="height:100%;width:0%;background:#f87171;border-radius:2px;transition:width .3s ease;"></div>
      </div>
      <div id="clearLibCount" style="font-size:13px;color:rgba(255,255,255,.3);font-variant-numeric:tabular-nums;">0 / 0</div>
    `;
    document.body.appendChild(overlay);

    const statusEl = overlay.querySelector("#clearLibStatus");
    const barEl = overlay.querySelector("#clearLibBar");
    const countEl = overlay.querySelector("#clearLibCount");

    const updateProgress = (i, total, label) => {
      const pct = total > 0 ? Math.round(((i + 1) / total) * 100) : 0;
      if (statusEl) statusEl.textContent = label;
      if (barEl) barEl.style.width = pct + "%";
      if (countEl) countEl.textContent = `${i + 1} / ${total}`;
    };

    try {
      const songsToDelete = [...(state.songs || [])];
      const total = songsToDelete.length;

      // 1. Delete each song from Supabase (DB rows + storage files)
      for (let i = 0; i < total; i++) {
        updateProgress(i, total, `Deleting "${songsToDelete[i].title || "Untitled"}"…`);
        await deleteSongEverywhere(songsToDelete[i]);
      }

      // 2. Delete all projects
      if (statusEl) statusEl.textContent = "Removing projects…";
      const session = await getSession();
      const userId = session?.user?.id;
      if (userId) {
        try { await supabase.from("projects").delete().eq("owner_id", userId); } catch {}
      }

      // 3. Clear local state
      if (statusEl) statusEl.textContent = "Clearing local data…";
      state.songs = [];
      state.projects = [];
      state.releases = [];
      normalizeState();
      saveState();

      // 4. Clear IndexedDB
      audioUrlCache.clear();
      try {
        const db = await openAudioDB();
        await new Promise((resolve, reject) => {
          const tx = db.transaction(AUDIO_STORE, "readwrite");
          tx.objectStore(AUDIO_STORE).clear();
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } catch (e) { console.warn("[ClearLib] IDB clear failed:", e); }

      // Done — show completion briefly then navigate away
      if (barEl) barEl.style.width = "100%";
      if (statusEl) { statusEl.textContent = "Library cleared"; statusEl.style.color = "#4ade80"; }
      await new Promise(r => setTimeout(r, 800));
      overlay.remove();
      R.settingsView = null;
      ctx.render();
    } catch (e) {
      console.error("[ClearLib] failed:", e);
      if (statusEl) { statusEl.textContent = "Failed — check console"; statusEl.style.color = "#f87171"; }
      setTimeout(() => overlay.remove(), 3000);
    }
  });

  // Clear Songs Only — delete songs/versions/audio but keep projects
  $("#clearSongsOnly")?.addEventListener("click", async () => {
    if (!confirm("Delete ALL songs, versions, and audio? Projects will be kept. This cannot be undone.")) return;
    if (!confirm("Are you absolutely sure? This will permanently erase all songs from your account.")) return;

    const overlay = document.createElement("div");
    overlay.id = "clearLibOverlay";
    overlay.style.cssText = "position:fixed;inset:0;z-index:999999;background:var(--bg,#0d0d0f);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;padding:32px;";
    overlay.innerHTML = `
      <div style="font-size:24px;font-weight:700;color:#fff;letter-spacing:-0.3px;">Clearing Songs</div>
      <div id="clearLibStatus" style="font-size:15px;color:rgba(255,255,255,.5);text-align:center;">Preparing…</div>
      <div style="width:240px;height:4px;background:rgba(255,255,255,.08);border-radius:2px;overflow:hidden;">
        <div id="clearLibBar" style="height:100%;width:0%;background:#f87171;border-radius:2px;transition:width .3s ease;"></div>
      </div>
      <div id="clearLibCount" style="font-size:13px;color:rgba(255,255,255,.3);font-variant-numeric:tabular-nums;">0 / 0</div>
    `;
    document.body.appendChild(overlay);

    const statusEl = overlay.querySelector("#clearLibStatus");
    const barEl = overlay.querySelector("#clearLibBar");
    const countEl = overlay.querySelector("#clearLibCount");

    const updateProgress = (i, total, label) => {
      const pct = total > 0 ? Math.round(((i + 1) / total) * 100) : 0;
      if (statusEl) statusEl.textContent = label;
      if (barEl) barEl.style.width = pct + "%";
      if (countEl) countEl.textContent = `${i + 1} / ${total}`;
    };

    try {
      const songsToDelete = [...(state.songs || [])];
      const total = songsToDelete.length;

      for (let i = 0; i < total; i++) {
        updateProgress(i, total, `Deleting "${songsToDelete[i].title || "Untitled"}"…`);
        await deleteSongEverywhere(songsToDelete[i]);
      }

      // Clear songs from local state but keep projects
      if (statusEl) statusEl.textContent = "Clearing local data…";
      state.songs = [];
      state.releases = [];
      normalizeState();
      saveState();

      // Clear IndexedDB audio
      audioUrlCache.clear();
      try {
        const db = await openAudioDB();
        await new Promise((resolve, reject) => {
          const tx = db.transaction(AUDIO_STORE, "readwrite");
          tx.objectStore(AUDIO_STORE).clear();
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } catch (e) { console.warn("[ClearSongs] IDB clear failed:", e); }

      if (barEl) barEl.style.width = "100%";
      if (statusEl) { statusEl.textContent = "Songs cleared"; statusEl.style.color = "#4ade80"; }
      await new Promise(r => setTimeout(r, 800));
      overlay.remove();
      R.settingsView = null;
      ctx.render();
    } catch (e) {
      console.error("[ClearSongs] failed:", e);
      if (statusEl) { statusEl.textContent = "Failed — check console"; statusEl.style.color = "#f87171"; }
      setTimeout(() => overlay.remove(), 3000);
    }
  });

  // Wipe local data
  $("#wipe")?.addEventListener("click", async () => {
    if (!confirm("Wipe all local RiffBank data and sign out? Cloud data is untouched.")) return;
    localStorage.clear();
    async function deleteIDB(name) {
      return new Promise((resolve) => {
        const req = indexedDB.deleteDatabase(name);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      });
    }
    try {
      if (indexedDB.databases) {
        const dbs = await indexedDB.databases();
        for (const db of dbs) { if (db.name) await deleteIDB(db.name); }
      } else { await deleteIDB(AUDIO_DB); }
    } catch { try { await deleteIDB(AUDIO_DB); } catch {} }
    try { await signOut(); } catch {}
    window.location.reload();
  });

  _setCollapseTitle();
}

