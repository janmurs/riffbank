import { escapeHtml } from "./dom.js";

export const AVATAR_PRESETS = [
  { id: "fox",      bg: "#f97316", emoji: "🦊", label: "Fox" },
  { id: "bear",     bg: "#a78bfa", emoji: "🐻", label: "Bear" },
  { id: "cat",      bg: "#f472b6", emoji: "🐱", label: "Cat" },
  { id: "dog",      bg: "#60a5fa", emoji: "🐶", label: "Dog" },
  { id: "rabbit",   bg: "#34d399", emoji: "🐰", label: "Rabbit" },
  { id: "panda",    bg: "#6b7280", emoji: "🐼", label: "Panda" },
  { id: "owl",      bg: "#8b5cf6", emoji: "🦉", label: "Owl" },
  { id: "penguin",  bg: "#38bdf8", emoji: "🐧", label: "Penguin" },
  { id: "lion",     bg: "#fbbf24", emoji: "🦁", label: "Lion" },
  { id: "koala",    bg: "#a3a3a3", emoji: "🐨", label: "Koala" },
  { id: "unicorn",  bg: "#e879f9", emoji: "🦄", label: "Unicorn" },
  { id: "hedgehog", bg: "#d97706", emoji: "🦔", label: "Hedgehog" },
];

export function renderAvatarPreset(preset) {
  return `<div style="width:100%;height:100%;background:${preset.bg};display:flex;align-items:center;justify-content:center;font-size:28px;border-radius:inherit">${preset.emoji}</div>`;
}

/**
 * Opens an Instagram-style bottom sheet avatar picker.
 * @param {object} opts
 * @param {string|null} opts.currentSrc  - current avatar image URL
 * @param {function} opts.onPickFile     - called with File when user picks from library/camera
 * @param {function} opts.onPickPreset   - called with preset object { id, bg, emoji }
 * @param {function} opts.onRemove       - called when user removes current picture
 */
export function openAvatarPicker({ currentSrc, onPickFile, onPickPreset, onRemove }) {
  // Remove any existing picker
  document.getElementById("avatarPickerBackdrop")?.remove();
  document.getElementById("avatarPickerSheet")?.remove();

  const backdrop = document.createElement("div");
  backdrop.id = "avatarPickerBackdrop";
  backdrop.className = "avatarPickerBackdrop";

  const sheet = document.createElement("div");
  sheet.id = "avatarPickerSheet";
  sheet.className = "avatarPickerSheet";

  let activeTab = "photo"; // "photo" | "avatar"

  function renderSheet() {
    const initial = "?";
    const presetGrid = AVATAR_PRESETS.map(p => `
      <button class="avPresetBtn" data-preset="${p.id}">
        ${renderAvatarPreset(p)}
      </button>
    `).join("");

    sheet.innerHTML = `
      <div class="avPickerHandle"></div>
      <div class="avPickerTabs">
        <button class="avPickerTab ${activeTab === "photo" ? "active" : ""}" data-tab="photo">
          ${currentSrc
            ? `<img src="${currentSrc}" class="avPickerTabImg" />`
            : `<div class="avPickerTabFallback">${escapeHtml(initial)}</div>`
          }
        </button>
        <button class="avPickerTab ${activeTab === "avatar" ? "active" : ""}" data-tab="avatar">
          <div class="avPickerTabFallback" style="font-size:18px">🦔</div>
        </button>
      </div>

      ${activeTab === "photo" ? `
        <div class="avPickerOptions">
          <button class="avPickerOption" data-action="pick">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>
            <span>Choose photo</span>
          </button>
          ${currentSrc ? `
            <button class="avPickerOption avPickerOptionDanger" data-action="remove">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3,6 5,6 21,6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
              <span>Remove current picture</span>
            </button>
          ` : ""}
        </div>
      ` : `
        <div class="avPresetGrid">
          ${presetGrid}
        </div>
      `}
    `;

    // Wire tabs
    sheet.querySelectorAll(".avPickerTab").forEach(tab => {
      tab.addEventListener("click", () => {
        activeTab = tab.dataset.tab;
        renderSheet();
      });
    });

    // Wire "Choose photo" — iOS will show its native Photo Library / Take Photo / Files menu
    sheet.querySelector("[data-action='pick']")?.addEventListener("click", () => {
      let input = document.getElementById("_imagePicker");
      if (!input) {
        input = document.createElement("input");
        input.id = "_imagePicker";
        input.type = "file";
        input.accept = "image/*";
        input.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0;pointer-events:none";
        document.body.appendChild(input);
      }
      input.value = "";
      const handler = async () => {
        input.removeEventListener("change", handler);
        const file = input.files?.[0];
        if (!file) return;
        close();
        // Open crop overlay before passing to callback
        const cropped = await openAvatarCrop(file);
        if (cropped) onPickFile?.(cropped.file, cropped.previewUrl);
      };
      input.addEventListener("change", handler);
      input.click();
    });

    sheet.querySelector("[data-action='remove']")?.addEventListener("click", () => {
      close();
      onRemove?.();
    });

    // Wire preset avatars
    sheet.querySelectorAll(".avPresetBtn").forEach(btn => {
      btn.addEventListener("click", () => {
        const preset = AVATAR_PRESETS.find(p => p.id === btn.dataset.preset);
        if (preset) { close(); onPickPreset?.(preset); }
      });
    });
  }

  function close() {
    sheet.classList.remove("open");
    backdrop.classList.remove("open");
    setTimeout(() => { backdrop.remove(); sheet.remove(); }, 300);
  }

  backdrop.addEventListener("click", close);

  document.body.appendChild(backdrop);
  document.body.appendChild(sheet);
  renderSheet();
  requestAnimationFrame(() => { backdrop.classList.add("open"); sheet.classList.add("open"); });
}

// Helper: render an avatar from a URL or preset: string
export function renderAvatarHtml(src, size, fallbackInitial) {
  if (src?.startsWith("preset:")) {
    const presetId = src.replace("preset:", "");
    const preset = AVATAR_PRESETS.find(p => p.id === presetId);
    if (preset) return `<div style="width:${size}px;height:${size}px;border-radius:50%;overflow:hidden">${renderAvatarPreset(preset)}</div>`;
  }
  if (src?.startsWith("http")) {
    const fb = fallbackInitial || "?";
    return `<img style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;display:block" src="${src}" onerror="this.outerHTML='<div style=\\'width:${size}px;height:${size}px;border-radius:50%;background:linear-gradient(135deg,#a78bfa,#f472b6);display:flex;align-items:center;justify-content:center;font-weight:900;font-size:${Math.round(size * 0.4)}px;color:#fff\\'>${fb}</div>'" />`;
  }
  return `<div style="width:${size}px;height:${size}px;border-radius:50%;background:linear-gradient(135deg,#a78bfa,#f472b6);display:flex;align-items:center;justify-content:center;font-family:'Montserrat',sans-serif;font-weight:900;font-size:${Math.round(size * 0.4)}px;color:#fff">${fallbackInitial || "?"}</div>`;
}

/**
 * Opens a circular avatar crop overlay.
 * @param {File} file - image file to crop
 * @returns {Promise<{file: File, previewUrl: string} | null>} cropped result or null if cancelled
 */
export function openAvatarCrop(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const imageSrc = reader.result;

      document.querySelector(".avatarCropOverlay")?.remove();

      const overlay = document.createElement("div");
      overlay.className = "avatarCropOverlay";
      overlay.innerHTML = `
        <div class="avCropHeader">
          <button class="avCropCancel">Cancel</button>
          <span class="avCropTitle">Move and Scale</span>
          <button class="avCropDone">Done</button>
        </div>
        <div class="avCropBody">
          <div class="avCropFrame">
            <img class="avCropImg" src="${imageSrc}" draggable="false" />
            <div class="avCropMask"></div>
          </div>
        </div>
        <div class="avCropControls">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.4)" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
          <input type="range" class="avCropZoom" min="100" max="500" value="100" />
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.4)" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
        </div>
      `;

      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add("open"));

      const img = overlay.querySelector(".avCropImg");
      const frame = overlay.querySelector(".avCropFrame");
      const zoomSlider = overlay.querySelector(".avCropZoom");

      let baseScale = 1, userZoom = 1, tx = 0, ty = 0;
      let isDragging = false, startX = 0, startY = 0, startTx = 0, startTy = 0;
      // Pinch zoom state
      let pinchStartDist = 0, pinchStartZoom = 1;

      const totalScale = () => baseScale * userZoom;

      function applyTransform() {
        img.style.width = img.naturalWidth + "px";
        img.style.height = img.naturalHeight + "px";
        img.style.transform = `translate(${tx}px, ${ty}px) scale(${totalScale()})`;
      }

      function clampPosition() {
        const size = frame.clientWidth; // square
        const s = totalScale();
        const imgW = img.naturalWidth * s;
        const imgH = img.naturalHeight * s;
        if (imgW >= size) tx = Math.min(0, Math.max(size - imgW, tx));
        else tx = (size - imgW) / 2;
        if (imgH >= size) ty = Math.min(0, Math.max(size - imgH, ty));
        else ty = (size - imgH) / 2;
      }

      function initLayout() {
        const size = frame.clientWidth;
        const nw = img.naturalWidth, nh = img.naturalHeight;
        if (!nw || !nh || !size) return;
        baseScale = Math.max(size / nw, size / nh);
        tx = (size - nw * totalScale()) / 2;
        ty = (size - nh * totalScale()) / 2;
        applyTransform();
      }

      img.onload = () => initLayout();
      if (img.complete && img.naturalWidth) initLayout();

      // Zoom slider
      zoomSlider.addEventListener("input", () => {
        const oldZoom = userZoom;
        userZoom = parseInt(zoomSlider.value) / 100;
        const size = frame.clientWidth;
        const ratio = userZoom / oldZoom;
        tx = size / 2 - ratio * (size / 2 - tx);
        ty = size / 2 - ratio * (size / 2 - ty);
        clampPosition();
        applyTransform();
      });

      // Drag
      frame.addEventListener("touchstart", (e) => {
        if (e.touches.length === 2) {
          // Pinch start
          const dx = e.touches[0].clientX - e.touches[1].clientX;
          const dy = e.touches[0].clientY - e.touches[1].clientY;
          pinchStartDist = Math.hypot(dx, dy);
          pinchStartZoom = userZoom;
          return;
        }
        isDragging = true;
        startX = e.touches[0].clientX; startY = e.touches[0].clientY;
        startTx = tx; startTy = ty;
        e.preventDefault();
      }, { passive: false });

      frame.addEventListener("touchmove", (e) => {
        if (e.touches.length === 2 && pinchStartDist > 0) {
          // Pinch zoom
          const dx = e.touches[0].clientX - e.touches[1].clientX;
          const dy = e.touches[0].clientY - e.touches[1].clientY;
          const dist = Math.hypot(dx, dy);
          const newZoom = Math.max(1, Math.min(5, pinchStartZoom * (dist / pinchStartDist)));
          const oldZoom = userZoom;
          userZoom = newZoom;
          zoomSlider.value = Math.round(userZoom * 100);
          const size = frame.clientWidth;
          const ratio = userZoom / oldZoom;
          tx = size / 2 - ratio * (size / 2 - tx);
          ty = size / 2 - ratio * (size / 2 - ty);
          clampPosition();
          applyTransform();
          e.preventDefault();
          return;
        }
        if (!isDragging) return;
        const pt = e.touches[0];
        tx = startTx + (pt.clientX - startX);
        ty = startTy + (pt.clientY - startY);
        clampPosition();
        applyTransform();
        e.preventDefault();
      }, { passive: false });

      frame.addEventListener("touchend", () => { isDragging = false; pinchStartDist = 0; });
      frame.addEventListener("touchcancel", () => { isDragging = false; pinchStartDist = 0; });

      // Mouse drag fallback
      frame.addEventListener("mousedown", (e) => {
        isDragging = true; startX = e.clientX; startY = e.clientY; startTx = tx; startTy = ty;
      });
      window.addEventListener("mousemove", (e) => {
        if (!isDragging) return;
        tx = startTx + (e.clientX - startX);
        ty = startTy + (e.clientY - startY);
        clampPosition(); applyTransform();
      });
      window.addEventListener("mouseup", () => { isDragging = false; });

      function dismiss() {
        overlay.classList.remove("open");
        setTimeout(() => overlay.remove(), 300);
      }

      // Cancel
      overlay.querySelector(".avCropCancel").addEventListener("click", () => { dismiss(); resolve(null); });

      // Done — render cropped image to canvas
      overlay.querySelector(".avCropDone").addEventListener("click", () => {
        const size = frame.clientWidth;
        const s = totalScale();
        const canvas = document.createElement("canvas");
        const outputSize = 512; // hi-res output
        canvas.width = outputSize;
        canvas.height = outputSize;
        const ctx = canvas.getContext("2d");

        // Map frame coordinates to source image coordinates
        const srcX = -tx / s;
        const srcY = -ty / s;
        const srcSize = size / s;

        ctx.drawImage(img, srcX, srcY, srcSize, srcSize, 0, 0, outputSize, outputSize);

        canvas.toBlob((blob) => {
          if (!blob) { dismiss(); resolve(null); return; }
          const croppedFile = new File([blob], "avatar.jpg", { type: "image/jpeg" });
          const previewUrl = URL.createObjectURL(blob);
          dismiss();
          resolve({ file: croppedFile, previewUrl });
        }, "image/jpeg", 0.92);
      });
    };
    reader.readAsDataURL(file);
  });
}
