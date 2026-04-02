import { supabasePullStateSilent, supabaseFetchAudioBlob, supabaseCountUserSongs } from "../supabase.js";
import { state, normalizeState, saveState } from "../state.js";
import { putAudioBlob } from "../audio/audioDB.js";
import { coverSvg } from "./coverArt.js";
import { salSvg } from "./onboarding.js";
import { openSalOnboarding } from "./onboarding.js";
import { escapeHtml } from "./dom.js";

let _importFlowRan = false;
export function getImportFlowRan() { return _importFlowRan; }
export function setImportFlowRan(v) { _importFlowRan = v; }

export function showSalImportOffer(count) {
  return new Promise((resolve) => {
    const el = document.createElement("div");
    el.className = "salImportOffer";
    el.innerHTML = `
      <div class="salImportOfferCard">
        <div class="salImportOfferSal salBounce">${salSvg(96)}</div>
        <div class="salImportOfferMsg">
          Hey, welcome back! Looks like you've got <strong>${count} song${count !== 1 ? "s" : ""}</strong> floating in the cloud. Want me to grab ${count !== 1 ? "them" : "it"} for you?
        </div>
        <button class="salImportBtn" id="salImportGo">Let's go!</button>
        <button class="salImportSkipBtn" id="salImportSkip">Skip for now</button>
      </div>
    `;

    el.querySelector("#salImportGo").addEventListener("click", () => {
      el.classList.add("salImportFadeOut");
      setTimeout(() => { el.remove(); resolve("import"); }, 300);
    });
    el.querySelector("#salImportSkip").addEventListener("click", () => {
      el.classList.add("salImportFadeOut");
      setTimeout(() => { el.remove(); resolve("skip"); }, 300);
    });

    document.body.appendChild(el);
  });
}

function showSalImportScreen() {
  return new Promise(async (resolve) => {
    const el = document.createElement("div");
    el.className = "salImportScreen";

    // Pull full cloud state
    el.innerHTML = `
      <div class="salImportCard">
        <div class="salImportSalWrap"><div class="salIdle salBounce">${salSvg(80)}</div></div>
        <div class="salImportProgress">Preparing import...</div>
        <div class="salImportList"></div>
        <div class="salImportOverallBar"><div class="salImportOverallFill"></div></div>
      </div>
    `;
    document.body.appendChild(el);

    // Cycle Sal animations
    const salEl = el.querySelector(".salIdle");
    const salAnims = ["salBounce", "salSpin", "salSlide", "salPeek"];
    let salAnimIdx = 0;
    const salAnimTimer = setInterval(() => {
      salEl.classList.remove(...salAnims);
      salAnimIdx = (salAnimIdx + 1) % salAnims.length;
      salEl.classList.add(salAnims[salAnimIdx]);
    }, 4000);

    const listEl = el.querySelector(".salImportList");
    const progressEl = el.querySelector(".salImportProgress");
    const overallFill = el.querySelector(".salImportOverallFill");

    // Fetch cloud data
    const cloudState = await supabasePullStateSilent();
    if (!cloudState?.songs?.length) {
      clearInterval(salAnimTimer);
      el.classList.add("salImportFadeOut");
      setTimeout(() => { el.remove(); resolve({ succeeded: [], failed: [] }); }, 300);
      return;
    }

    // Merge cloud songs into local state
    state.songs = cloudState.songs;
    state.releases = cloudState.releases || state.releases;
    state.projects = cloudState.projects || state.projects;
    normalizeState();
    saveState();

    // Build a list of ALL songs, and track which versions need audio downloaded
    const allSongs = state.songs;
    const toDownload = []; // { song, version, row } — versions needing audio blobs
    let done = 0;
    const total = allSongs.length;

    // Phase 1: Show all songs, instantly check off metadata-only ones
    for (const song of allSongs) {
      done++;
      progressEl.textContent = `Importing ${done} of ${total}...`;
      overallFill.style.width = `${(done / total) * 100}%`;

      const row = document.createElement("div");
      row.className = "salImportItem";

      // Check if this song has any versions with cloud audio to download
      let needsAudio = false;
      for (const v of (song.versions || [])) {
        if (!v.audioPath) continue;
        try {
          const existing = await audioGet(`supa:${v.audioPath}`);
          if (existing?.blob) { cachedAudioPaths.add(v.audioPath); continue; }
        } catch {}
        needsAudio = true;
        toDownload.push({ song, version: v, row });
      }

      const versionCount = (song.versions || []).length;
      const subtitle = needsAudio
        ? `${versionCount} version${versionCount !== 1 ? "s" : ""} — downloading audio...`
        : `${versionCount} version${versionCount !== 1 ? "s" : ""}`;

      row.innerHTML = `
        <div class="salImportArt">${coverSvg(song, { lite: true })}</div>
        <div class="salImportMeta">
          <div class="salImportTitle">${song.title || "Untitled"}</div>
          <div class="salImportSub">${subtitle}</div>
        </div>
        <div class="salImportStatus ${needsAudio ? "salImportSpinner" : "salImportCheck"}"></div>
      `;
      listEl.appendChild(row);

      // Small stagger so cards animate in visibly
      await new Promise(r => setTimeout(r, 60));
      listEl.scrollTop = listEl.scrollHeight;
    }

    // Phase 2: Download audio blobs for versions that need them
    const succeeded = [];
    const failed = [];

    if (toDownload.length) {
      let audioDone = 0;
      progressEl.textContent = `Downloading audio: 0 of ${toDownload.length}...`;

      for (const item of toDownload) {
        const { song, version: v, row } = item;
        audioDone++;
        progressEl.textContent = `Downloading audio: ${audioDone} of ${toDownload.length}...`;

        try {
          const blob = await supabaseFetchAudioBlob(v.audioPath);
          if (blob) {
            await putAudioBlob({
              id: `supa:${v.audioPath}`,
              blob,
              name: v.fileName || v.label || "audio",
              type: v.fileType || blob.type || "audio/*",
              size: blob.size,
            });
            cachedAudioPaths.add(v.audioPath);
            succeeded.push(item);
          } else {
            failed.push(item);
          }
        } catch {
          failed.push(item);
        }

        // Update the row status — check if all versions for this song are done
        const songItems = toDownload.filter(d => d.song === song);
        const songDone = songItems.every(d => succeeded.includes(d) || failed.includes(d));
        if (songDone) {
          const anyFailed = songItems.some(d => failed.includes(d));
          row.querySelector(".salImportStatus").className = `salImportStatus ${anyFailed ? "salImportFail" : "salImportCheck"}`;
          const vCount = (song.versions || []).length;
          row.querySelector(".salImportSub").textContent = anyFailed
            ? `${vCount} version${vCount !== 1 ? "s" : ""} — some audio failed`
            : `${vCount} version${vCount !== 1 ? "s" : ""}`;
        }
      }
    }

    clearInterval(salAnimTimer);

    if (!failed.length) {
      // All succeeded
      salEl.classList.remove(...salAnims);
      salEl.classList.add("salBounce");
      progressEl.innerHTML = `<strong>All done — happy riffing!</strong>`;
      overallFill.style.width = "100%";
      setTimeout(() => {
        el.classList.add("salImportFadeOut");
        setTimeout(() => { el.remove(); resolve({ succeeded, failed }); }, 300);
      }, 1800);
    } else {
      // Some failed — show continue button, user will handle failures in retry screen
      progressEl.innerHTML = `Imported ${succeeded.length} of ${toDownload.length}. Some didn't make it.`;
      const contBtn = document.createElement("button");
      contBtn.className = "salImportBtn";
      contBtn.style.marginTop = "16px";
      contBtn.textContent = "Continue";
      el.querySelector(".salImportCard").appendChild(contBtn);
      contBtn.addEventListener("click", () => {
        el.classList.add("salImportFadeOut");
        setTimeout(() => { el.remove(); resolve({ succeeded, failed }); }, 300);
      });
    }
  });
}

function showSalImportRetry(failedItems) {
  return new Promise((resolve) => {
    const el = document.createElement("div");
    el.className = "salImportOffer";
    el.innerHTML = `
      <div class="salImportOfferCard">
        <div class="salImportOfferSal">${salSvg(72)}</div>
        <div class="salImportOfferMsg">
          Almost there! ${failedItems.length} song${failedItems.length !== 1 ? "s" : ""} didn't make it.
        </div>
        <div class="salRetryList" id="salRetryList"></div>
        <button class="salImportBtn" id="salRetryContinue">Continue to RiffBank</button>
      </div>
    `;

    const listEl = el.querySelector("#salRetryList");

    for (const item of failedItems) {
      const { song, version: v } = item;
      const row = document.createElement("div");
      row.className = "salRetryItem";
      row.innerHTML = `
        <div class="salImportMeta">
          <div class="salImportTitle">${song.title || "Untitled"}</div>
          <div class="salImportSub">${v.label || "Version"}</div>
        </div>
        <div class="salRetryActions">
          <button class="salRetryBtn" data-action="retry">Retry</button>
          <button class="salRetryBtn salRetryBtnDanger" data-action="delete">Delete</button>
        </div>
      `;

      row.querySelector('[data-action="retry"]').addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        btn.textContent = "...";
        btn.disabled = true;
        try {
          const blob = await supabaseFetchAudioBlob(v.audioPath);
          if (blob) {
            await putAudioBlob({
              id: `supa:${v.audioPath}`,
              blob,
              name: v.fileName || v.label || "audio",
              type: v.fileType || blob.type || "audio/*",
              size: blob.size,
            });
            cachedAudioPaths.add(v.audioPath);
            row.classList.add("salRetryDone");
            row.querySelector(".salRetryActions").innerHTML = `<span style="color:#22c55e;font-size:13px;font-weight:700;">Done!</span>`;
          } else {
            btn.textContent = "Retry";
            btn.disabled = false;
          }
        } catch {
          btn.textContent = "Retry";
          btn.disabled = false;
        }
      });

      row.querySelector('[data-action="delete"]').addEventListener("click", () => {
        // Remove audioPath from version so it's treated as metadata-only
        v.audioPath = null;
        saveState();
        row.classList.add("salRetryDone");
        row.querySelector(".salRetryActions").innerHTML = `<span style="color:var(--muted);font-size:13px;font-weight:700;">Removed</span>`;
      });

      listEl.appendChild(row);
    }

    el.querySelector("#salRetryContinue").addEventListener("click", () => {
      el.classList.add("salImportFadeOut");
      setTimeout(() => { el.remove(); resolve(); }, 300);
    });

    document.body.appendChild(el);
  });
}

function showSalRefresherPrompt() {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "actionSheetBackdrop";

    const sheet = document.createElement("div");
    sheet.className = "actionSheet";
    sheet.style.cssText = "padding: 0; overflow: hidden; border-radius: 22px;";
    sheet.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;padding:32px 24px 20px;gap:14px;">
        ${salSvg(72)}
        <div style="font-size:18px;font-weight:800;color:#fff;letter-spacing:-0.3px;text-align:center;">Want a refresher on how things work?</div>
        <div style="font-size:14px;color:rgba(255,255,255,.5);text-align:center;line-height:1.6;max-width:280px;">
          I can walk you through everything RiffBank has to offer.
        </div>
      </div>
      <div style="height:1px;background:rgba(255,255,255,.08);margin:0 16px;"></div>
      <div style="padding:8px 0 6px;display:flex;flex-direction:column;">
        <button class="actionSheetBtn" id="salRefresherYes" style="font-weight:700;color:#a78bfa;">Sure!</button>
        <button class="actionSheetBtn" id="salRefresherNo" style="font-weight:700;">I'm good</button>
      </div>
    `;

    function close() {
      backdrop.remove();
      sheet.remove();
      localStorage.setItem("salOnboardingDone", "1");
      resolve();
    }

    backdrop.addEventListener("click", close);
    sheet.querySelector("#salRefresherNo").addEventListener("click", close);
    sheet.querySelector("#salRefresherYes").addEventListener("click", () => {
      backdrop.remove();
      sheet.remove();
      openSalOnboarding({ force: true });
      // Resolve after a short delay so onboarding sheet is visible
      setTimeout(resolve, 100);
    });

    document.body.appendChild(backdrop);
    document.body.appendChild(sheet);
  });
}

// ── Avatar Picker Sheet ──────────────────────────

// Preset cartoon avatars — cute Sal-style characters
// AVATAR_PRESETS, renderAvatarPreset, openAvatarPicker, renderAvatarHtml, openAvatarCrop now in ui/avatars.js


export async function runSalImportFlow() {
  // Only run once per session
  if (_importFlowRan) return;
  _importFlowRan = true;

  // Only run on first login (fresh install / after wipe). Skip on subsequent launches.
  if (localStorage.getItem("salImportFlowDone")) return;

  // Check if this is a fresh login (no local songs yet) and cloud has data
  const cloudCount = await supabaseCountUserSongs();
  console.log("[ImportFlow] cloudCount =", cloudCount);

  if (cloudCount === 0) {
    // New user — run existing onboarding
    localStorage.setItem("salImportFlowDone", "1");
    openSalOnboarding({ force: true });
    return;
  }

  // Returning user with cloud songs
  const userChoice = await showSalImportOffer(cloudCount);

  if (userChoice === "import") {
    const result = await showSalImportScreen();
    if (result.failed.length) {
      await showSalImportRetry(result.failed);
    }
  } else {
    // User skipped — set nudge flag
    localStorage.setItem("salImportSkipped", JSON.stringify({
      count: cloudCount,
      skippedAt: Date.now(),
    }));
  }

  // Mark import flow as complete so it doesn't re-run on next launch
  localStorage.setItem("salImportFlowDone", "1");
}
