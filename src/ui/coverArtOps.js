import { state, saveState, getSong } from "../state.js";
import { toast } from "./toast.js";
import { escapeHtml, nowStamp, $ } from "./dom.js";
import { coverSvg, coverCache, generatingArtSongs, buildArtPrompt } from "./coverArt.js";
import { getCoverBlobUrl, putCoverBlob, coverUrlCache } from "../audio/audioDB.js";
import {
  supabaseFetchCoverBlob, supabaseUploadCover,
  getSession, SUPABASE_URL, SUPABASE_ANON_KEY,
} from "../supabase.js";

// ── Dependencies injected via initCoverArtOps() ──
let _render = null;
let _getSelectedSongId = null;

export function initCoverArtOps({ render, getSelectedSongId }) {
  _render = render;
  _getSelectedSongId = getSelectedSongId;
}

// Auto-generate art for a newly created song (fire-and-forget)
export function autoGenerateArt(song) {
  if (song.coverImageUrl || song.coverPath) return;
  generatingArtSongs.add(song.id);
  coverCache.clear();
  if (_render) _render();
  generateArtForSong(song)
    .then(() => { coverCache.clear(); saveState(); })
    .catch(e => console.warn("Auto art generation failed:", e))
    .finally(() => { generatingArtSongs.delete(song.id); coverCache.clear(); if (_render) _render(); });
}

// Global handler: refresh cover image from cloud when cached URL expires
window._refreshCoverFromCloud = async (songId, coverPath, imgEl) => {
  let url = await getCoverBlobUrl(coverPath);
  if (!url) {
    const blob = await supabaseFetchCoverBlob(coverPath);
    if (blob) {
      await putCoverBlob(coverPath, blob);
      url = URL.createObjectURL(blob);
      coverUrlCache.set(coverPath, url);
    }
  }
  if (url && imgEl) {
    imgEl.onerror = () => {
      imgEl.onerror = null;
      window._clearBrokenCover && window._clearBrokenCover(songId, imgEl);
    };
    imgEl.src = url;
    const song = state.songs.find(s => s.id === songId);
    if (song) {
      song.coverImageUrl = url;
      coverCache.clear();
      saveState();
    }
  } else if (imgEl) {
    const song = state.songs.find(s => s.id === songId);
    if (song) {
      song.coverImageUrl = null;
      coverCache.clear();
    }
    if (imgEl.parentElement) {
      imgEl.parentElement.innerHTML = coverSvg(song || { id: songId, title: "", project: "", genre: "" }, { lite: true });
    }
  }
};
// Fallback: if cover URL is broken (expired URL, no cloud backup), clear it so SVG art shows
window._clearBrokenCover = (songId, imgEl) => {
  const song = state.songs.find(s => s.id === songId);
  if (song) {
    song.coverImageUrl = null;
    coverCache.clear();
    saveState();
  }
  if (imgEl?.parentElement) {
    imgEl.parentElement.innerHTML = coverSvg(song || { id: songId, title: "", project: "", genre: "" }, { lite: true });
  }
};
window._refreshUserCoverFromCloud = async (songId, userCoverPath, imgEl) => {
  let url = await getCoverBlobUrl(userCoverPath);
  if (!url) {
    const blob = await supabaseFetchCoverBlob(userCoverPath);
    if (blob) {
      await putCoverBlob(userCoverPath, blob);
      url = URL.createObjectURL(blob);
      coverUrlCache.set(userCoverPath, url);
    }
  }
  if (url && imgEl) {
    imgEl.onerror = () => {
      imgEl.onerror = null;
      window._clearBrokenUserCover && window._clearBrokenUserCover(songId, imgEl);
    };
    imgEl.src = url;
    const song = state.songs.find(s => s.id === songId);
    if (song) {
      song.userCoverImageUrl = url;
      coverCache.clear();
      saveState();
    }
  } else if (imgEl) {
    const song = state.songs.find(s => s.id === songId);
    if (song) {
      song.coverSource = "ai"; // fall back to AI art
      song.userCoverImageUrl = null;
      coverCache.clear();
      saveState();
    }
    if (imgEl.parentElement) {
      imgEl.parentElement.innerHTML = coverSvg(song || { id: songId, title: "", project: "", genre: "" }, { lite: true });
    }
  }
};
window._clearBrokenUserCover = (songId, imgEl) => {
  const song = state.songs.find(s => s.id === songId);
  if (song) {
    song.coverSource = "ai";
    song.userCoverImageUrl = null;
    coverCache.clear();
    saveState();
  }
  if (imgEl?.parentElement) {
    imgEl.parentElement.innerHTML = coverSvg(song || { id: songId, title: "", project: "", genre: "" }, { lite: true });
  }
};
// ── Cover crop overlay ──────────────────────────────
export function openCoverCropOverlay(songId) {
  const song = getSong(songId);
  if (!song) return;

  // Show action sheet: Choose from Gallery / Take Photo
  document.querySelectorAll(".actionSheetBackdrop, .actionSheet").forEach(el => el.remove());

  const backdrop = document.createElement("div");
  backdrop.className = "actionSheetBackdrop";
  const sheet = document.createElement("div");
  sheet.className = "actionSheet";
  sheet.innerHTML = `
    <div class="actionSheetHeader">Cover Photo</div>
    <button class="actionSheetBtn" data-act="gallery">Choose from Gallery</button>
    <button class="actionSheetBtn" data-act="camera">Take Photo</button>
    <button class="actionSheetBtn" data-act="cancel">Cancel</button>
  `;
  document.body.append(backdrop, sheet);
  requestAnimationFrame(() => { backdrop.classList.add("show"); sheet.classList.add("show"); });

  function dismiss() {
    backdrop.classList.remove("show");
    sheet.classList.remove("show");
    setTimeout(() => { backdrop.remove(); sheet.remove(); }, 300);
  }

  function pickFile(useCamera) {
    dismiss();
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    if (useCamera) fileInput.setAttribute("capture", "environment");
    fileInput.style.display = "none";
    document.body.appendChild(fileInput);

    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      fileInput.remove();
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => showCropOverlay(songId, reader.result);
      reader.readAsDataURL(file);
    });

    fileInput.click();
  }

  sheet.querySelector('[data-act="gallery"]').addEventListener("click", () => pickFile(false));
  sheet.querySelector('[data-act="camera"]').addEventListener("click", () => pickFile(true));
  sheet.querySelector('[data-act="cancel"]').addEventListener("click", dismiss);
  backdrop.addEventListener("click", dismiss);
}

export function showCropOverlay(songId, imageSrc) {
  // Remove any existing overlay
  document.querySelector(".cropOverlay")?.remove();

  const overlay = document.createElement("div");
  overlay.className = "cropOverlay";
  overlay.innerHTML = `
    <div class="cropHeader">
      <button class="cropCancel">Cancel</button>
      <span class="cropTitle">Crop Cover</span>
      <button class="cropDone">Done</button>
    </div>
    <div class="cropArea">
      <div class="cropFrame">
        <img class="cropImg" src="${imageSrc}" draggable="false" />
      </div>
    </div>
    <div class="cropControls">
      <svg class="cropZoomIcon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
      <input type="range" class="cropZoom" min="100" max="400" value="100" />
      <svg class="cropZoomIcon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
    </div>
  `;

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("cropVisible"));

  const img = overlay.querySelector(".cropImg");
  const frame = overlay.querySelector(".cropFrame");
  const zoomSlider = overlay.querySelector(".cropZoom");

  // baseScale: fits image to "cover" the square frame. userZoom: extra zoom [1..4]
  let baseScale = 1;
  let userZoom = 1;
  let tx = 0, ty = 0;
  let isDragging = false;
  let startX = 0, startY = 0, startTx = 0, startTy = 0;

  function totalScale() { return baseScale * userZoom; }

  function applyTransform() {
    const s = totalScale();
    img.style.width = img.naturalWidth + "px";
    img.style.height = img.naturalHeight + "px";
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
  }

  function initLayout() {
    const fw = frame.clientWidth;
    const fh = frame.clientHeight;
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    if (!nw || !nh || !fw || !fh) return;
    baseScale = Math.max(fw / nw, fh / nh);
    tx = (fw - nw * totalScale()) / 2;
    ty = (fh - nh * totalScale()) / 2;
    applyTransform();
  }

  function clampPosition() {
    const fw = frame.clientWidth;
    const fh = frame.clientHeight;
    const s = totalScale();
    const imgW = img.naturalWidth * s;
    const imgH = img.naturalHeight * s;
    // Image must always cover the frame
    if (imgW >= fw) {
      tx = Math.min(0, Math.max(fw - imgW, tx));
    } else {
      tx = (fw - imgW) / 2;
    }
    if (imgH >= fh) {
      ty = Math.min(0, Math.max(fh - imgH, ty));
    } else {
      ty = (fh - imgH) / 2;
    }
  }

  img.onload = () => initLayout();
  if (img.complete && img.naturalWidth) initLayout();

  // Zoom slider
  zoomSlider.addEventListener("input", () => {
    const oldZoom = userZoom;
    userZoom = parseInt(zoomSlider.value) / 100;
    // Zoom toward center of frame
    const fw = frame.clientWidth;
    const fh = frame.clientHeight;
    const ratio = userZoom / oldZoom;
    tx = fw / 2 - ratio * (fw / 2 - tx);
    ty = fh / 2 - ratio * (fh / 2 - ty);
    clampPosition();
    applyTransform();
  });

  // Mouse/touch drag
  function onPointerDown(e) {
    if (e.touches && e.touches.length > 1) return;
    isDragging = true;
    const pt = e.touches ? e.touches[0] : e;
    startX = pt.clientX;
    startY = pt.clientY;
    startTx = tx;
    startTy = ty;
    e.preventDefault();
  }
  function onPointerMove(e) {
    if (!isDragging) return;
    if (e.touches && e.touches.length > 1) return;
    const pt = e.touches ? e.touches[0] : e;
    tx = startTx + (pt.clientX - startX);
    ty = startTy + (pt.clientY - startY);
    clampPosition();
    applyTransform();
    e.preventDefault();
  }
  function onPointerUp() {
    isDragging = false;
  }

  frame.addEventListener("mousedown", onPointerDown);
  frame.addEventListener("touchstart", onPointerDown, { passive: false });
  window.addEventListener("mousemove", onPointerMove);
  window.addEventListener("touchmove", onPointerMove, { passive: false });
  window.addEventListener("mouseup", onPointerUp);
  window.addEventListener("touchend", onPointerUp);

  // Pinch to zoom
  let pinchStartDist = 0;
  let pinchStartZoom = 1;
  frame.addEventListener("touchstart", (e) => {
    if (e.touches.length === 2) {
      isDragging = false;
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      pinchStartDist = Math.hypot(dx, dy);
      pinchStartZoom = userZoom;
    }
  }, { passive: true });
  frame.addEventListener("touchmove", (e) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.hypot(dx, dy);
      const oldZoom = userZoom;
      userZoom = Math.max(1, Math.min(4, pinchStartZoom * (dist / pinchStartDist)));
      zoomSlider.value = Math.round(userZoom * 100);
      // Zoom toward pinch center
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      const frameRect = frame.getBoundingClientRect();
      const px = midX - frameRect.left;
      const py = midY - frameRect.top;
      const ratio = userZoom / oldZoom;
      tx = px - ratio * (px - tx);
      ty = py - ratio * (py - ty);
      clampPosition();
      applyTransform();
    }
  }, { passive: true });

  function cleanup() {
    window.removeEventListener("mousemove", onPointerMove);
    window.removeEventListener("touchmove", onPointerMove);
    window.removeEventListener("mouseup", onPointerUp);
    window.removeEventListener("touchend", onPointerUp);
    overlay.classList.remove("cropVisible");
    setTimeout(() => overlay.remove(), 250);
  }

  // Cancel
  overlay.querySelector(".cropCancel").addEventListener("click", cleanup);

  // Done — crop and save
  overlay.querySelector(".cropDone").addEventListener("click", async () => {
    const fw = frame.clientWidth;
    const fh = frame.clientHeight;
    const s = totalScale();

    const canvas = document.createElement("canvas");
    const SIZE = 800; // output resolution
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext("2d");

    // tx, ty = pixel offset of scaled image top-left relative to frame top-left
    const sx = -tx / s;
    const sy = -ty / s;
    const sw = fw / s;
    const sh = fh / s;

    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, SIZE, SIZE);

    canvas.toBlob(async (blob) => {
      if (!blob) { cleanup(); return; }

      const song = getSong(songId);
      if (!song) { cleanup(); return; }

      // Save to IndexedDB + Supabase
      const userCoverPath = `user_${song.id}_cover.jpg`;
      await putCoverBlob(userCoverPath, blob);
      const url = URL.createObjectURL(blob);
      coverUrlCache.set(userCoverPath, url);

      song.userCoverImageUrl = url;
      song.userCoverPath = userCoverPath;
      song.coverSource = "user";
      coverCache.clear();
      saveState();
      if (_render) _render();
      toast("Cover photo saved");

      // Upload to Supabase in background and store the cloud path
      supabaseUploadCover({ blob, songId: song.id, pathOverride: `user_cover` }).then((result) => {
        if (result?.success && result.coverPath) {
          // Also cache under the Supabase storage path so pull can find it
          putCoverBlob(result.coverPath, blob).catch(() => {});
          coverUrlCache.set(result.coverPath, url);
          // Update song's userCoverPath to the cloud path for cross-device sync
          song.userCoverPath = result.coverPath;
          saveState();
          supabaseSyncStateSoon(state);
        }
      }).catch(() => {});

      cleanup();
    }, "image/jpeg", 0.92);
  });
}

export let artCooldownUntil = 0; // timestamp — global 10s cooldown after any art request
export function setArtCooldownUntil(v) { artCooldownUntil = v; }
export const bulkArtState = { running: false, done: 0, total: 0 }; // bulk art gen progress

// buildArtPrompt now in ui/coverArt.js

export async function generateArtForSong(song) {
  const session = await getSession();
  if (!session?.access_token) throw new Error("Sign in to generate art");
  const prompt = buildArtPrompt(song);
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 20000);
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/generate-art`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
        "apikey": SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ input: { prompt, aspect_ratio: "1:1" } }),
      signal: ac.signal,
    });
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Art generation timed out — try again");
    throw e;
  } finally {
    clearTimeout(timeout);
  }
  const data = await res.json();
  console.log("[ArtGen] Worker response:", res.status, data);
  if (!res.ok) throw new Error(data.detail || data.title || JSON.stringify(data));
  if (!data.output) throw new Error("No image returned");
  let url = Array.isArray(data.output) ? data.output[0] : data.output;
  console.log("[ArtGen] Image URL:", url);

  // Download image and upload to Supabase Storage for persistence
  try {
    const imgAc = new AbortController();
    const imgTimeout = setTimeout(() => imgAc.abort(), 15000);
    let imgRes;
    try {
      imgRes = await fetch(url, { signal: imgAc.signal });
    } finally {
      clearTimeout(imgTimeout);
    }
    if (imgRes.ok) {
      const blob = await imgRes.blob();
      const coverResult = await Promise.race([
        supabaseUploadCover({ blob, songId: song.id }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Cover upload timed out")), 15000)),
      ]);
      if (coverResult.success) {
        song.coverPath = coverResult.coverPath;
        await putCoverBlob(coverResult.coverPath, blob);
        const cachedUrl = URL.createObjectURL(blob);
        coverUrlCache.set(coverResult.coverPath, cachedUrl);
        url = cachedUrl;
      }
    }
  } catch (e) {
    console.warn("Cover art cloud upload failed (art still saved as URL):", e);
  }

  song.coverImageUrl = url;
  song.updatedAt = nowStamp();
}

export async function startBulkGenArt(onlyMissing) {
  if (bulkArtState.running) { toast("Bulk art generation already in progress"); return; }

  const songs = onlyMissing
    ? state.songs.filter(s => !s.coverImageUrl)
    : [...state.songs];

  if (!songs.length) { toast(onlyMissing ? "All songs already have art" : "No songs to generate art for"); return; }

  const label = onlyMissing ? "missing" : "all";
  if (!confirm(`Generate art for ${songs.length} ${label} song${songs.length === 1 ? "" : "s"}? This may take a while.`)) return;

  bulkArtState.running = true;
  bulkArtState.done = 0;
  bulkArtState.total = songs.length;
  for (const s of songs) generatingArtSongs.add(s.id);
  coverCache.clear();
  if (_render) _render();

  let succeeded = 0;
  let lastError = "";

  for (const song of songs) {
    try {
      await generateArtForSong(song);
      succeeded++;
    } catch (e) {
      console.error(`Art gen failed for "${song.title}":`, e);
      lastError = e.message;
    }
    generatingArtSongs.delete(song.id);
    coverCache.clear();
    bulkArtState.done++;
    saveState();
    // Live-update the song card art if songs list is visible
    const cardArtEl = document.querySelector(`.songCard[data-id="${song.id}"] .songCardArt`);
    if (cardArtEl) cardArtEl.innerHTML = coverSvg(song, { lite: true });
    // Also update song detail hero if viewing this song
    const heroArt = document.querySelector(".albumArt");
    if (heroArt && (_getSelectedSongId ? _getSelectedSongId() : null) === song.id) heroArt.innerHTML = coverSvg(song);
    // Live-update project row thumbnail if projects view is visible
    if (song.project) {
      const projThumb = document.querySelector(`[data-proj-thumb="${CSS.escape(song.project.trim())}"]`);
      if (projThumb) projThumb.innerHTML = coverSvg(song, { lite: true });
    }
    // Rate limit: wait 12s between requests (6 req/min limit)
    if (bulkArtState.done < bulkArtState.total) await new Promise(r => setTimeout(r, 12000));
    // Update settings buttons if they're currently visible
    const btnMissing = $("#genMissingArt");
    const btnAll = $("#regenAllArt");
    if (btnMissing || btnAll) {
      const txt = `${bulkArtState.done}/${bulkArtState.total} done…`;
      if (btnMissing) { btnMissing.disabled = true; btnMissing.textContent = txt; }
      if (btnAll) { btnAll.disabled = true; btnAll.textContent = txt; }
    }
  }

  bulkArtState.running = false;
  coverCache.clear();
  const total = bulkArtState.total;
  if (succeeded === 0) {
    toast(lastError ? `Art generation failed: ${lastError}` : "No art was generated");
  } else if (succeeded < total) {
    toast(`Generated art for ${succeeded}/${total} songs (${total - succeeded} failed)`);
  } else {
    toast(`Generated art for ${succeeded} song${succeeded === 1 ? "" : "s"} ✨`);
  }
  if (_render) _render();
}
