import { R } from "../router.js";
import { ctx } from "../appContext.js";
import { state } from "../state.js";
import { renderGlobalSearch } from "./searchView.js";

export function renderHome() {
  // Cleanup previous particle system if re-rendering
  const prevGrid = ctx.getActiveScreenEl().querySelector(".homeGrid");
  if (prevGrid && prevGrid._cleanupHome) prevGrid._cleanupHome();

  R.overlayView = null;
  R.currentTab = "home";
  ctx.setHeader("RiffBank");

  ctx.getActiveScreenEl().innerHTML = `
    <div class="homeWrap">
      <div class="homeTopbar">
        <div class="homeTopbarLeft">
          <span class="homeTopTitle">Build your sound</span>
        </div>
        <div class="homeTopbarRight">
          <button class="htbBtn" id="htbNotif" aria-label="Notifications">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/>
              <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
            </svg>
          </button>
          <button class="htbBtn" id="htbSearch" aria-label="Search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="8"/>
              <line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
          </button>
          <button class="htbBtn" id="htbSettings" aria-label="Settings">
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2"/>
              <path d="M10.29 3.86a1 1 0 0 1 3.42 0l.38 1.32a7 7 0 0 1 1.73.99l1.32-.42a1 1 0 0 1 1.14.46l1.71 2.96a1 1 0 0 1-.26 1.31l-1.08.77c.04.25.05.5.05.75s-.01.5-.05.75l1.08.77a1 1 0 0 1 .26 1.31l-1.71 2.96a1 1 0 0 1-1.14.46l-1.32-.42a7 7 0 0 1-1.73.99l-.38 1.32a1 1 0 0 1-3.42 0l-.38-1.32a7 7 0 0 1-1.73-.99l-1.32.42a1 1 0 0 1-1.14-.46l-1.71-2.96a1 1 0 0 1 .26-1.31l1.08-.77A7.1 7.1 0 0 1 5.3 12c0-.25.01-.5.05-.75l-1.08-.77a1 1 0 0 1-.26-1.31l1.71-2.96a1 1 0 0 1 1.14-.46l1.32.42a7 7 0 0 1 1.73-.99l.38-1.32Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
            </svg>
          </button>
        </div>
      </div>

      <div class="homeScene">
        <div class="homeGrid">

          <!-- Songs — tall left card, spans 2 rows -->
          <div class="hCard hSongs" role="button" tabindex="0" data-home="songs" aria-label="Songs">
            <div class="hArt"><img src="./songs-card.jpg" style="width:100%;height:100%;object-fit:cover;object-position:35% center;display:block;"></div>
            <canvas class="hWarp"></canvas>
            <canvas class="hParticles"></canvas>
            <div class="hShimmer"></div>
            <div class="hGrad"></div>
            <div class="hDarken"></div>
            <div class="hBody">
              <div class="hLabel">Songs</div>
            </div>
          </div>

          <!-- Projects — small, right column top -->
          <div class="hCard hProjects" role="button" tabindex="0" data-home="projects" aria-label="Projects">
            <div class="hArt"><img src="./projects-card.jpg" style="width:100%;height:100%;object-fit:cover;object-position:center 22%;display:block;"></div>
            <canvas class="hWarp"></canvas>
            <canvas class="hParticles"></canvas>
            <div class="hShimmer"></div>
            <div class="hGrad"></div>
            <div class="hDarken"></div>
            <div class="hBody">
              <div class="hLabel">Projects</div>
            </div>
          </div>

          <!-- Releases — small, right column bottom -->
          <div class="hCard hPlayer" role="button" tabindex="0" data-home="releases" aria-label="Releases">
            <div class="hArt"><img src="./releases-card.jpg" style="width:100%;height:100%;object-fit:cover;object-position:center 45%;display:block;"></div>
            <canvas class="hWarp"></canvas>
            <canvas class="hParticles"></canvas>
            <div class="hShimmer"></div>
            <div class="hGrad"></div>
            <div class="hDarken"></div>
            <div class="hBody">
              <div class="hLabel">Releases</div>
            </div>
          </div>

          <!-- Lyrics — full width -->
          <div class="hCard hLyrics hWide" role="button" tabindex="0" data-home="lyrics" aria-label="Lyrics">
            <div class="hArt"><img src="./lyrics-card.jpg" style="width:100%;height:150%;object-fit:cover;transform:scale(1.1);display:block;"></div>
            <canvas class="hWarp"></canvas>
            <canvas class="hParticles"></canvas>
            <div class="hShimmer"></div>
            <div class="hGrad"></div>
            <div class="hDarken"></div>
            <div class="hBody">
              <div class="hLabel">Lyrics</div>
            </div>
          </div>

          <!-- Actions — full width -->
          <div class="hCard hNext hWide" role="button" tabindex="0" data-home="next" aria-label="Actions">
            <div class="hArt"><img src="./actions-card.jpg" style="width:100%;height:100%;object-fit:cover;transform:scale(1.1);display:block;"></div>
            <canvas class="hWarp"></canvas>
            <canvas class="hParticles"></canvas>
            <div class="hShimmer"></div>
            <div class="hGrad"></div>
            <div class="hDarken"></div>
            <div class="hBody">
              <div class="hLabel">Actions</div>
            </div>
          </div>

        </div>
      </div>
    </div>
  `;

  // Topbar button actions
  ctx.getActiveScreenEl().querySelector("#htbNotif")?.addEventListener("click", () => {
    ctx.navigateForward(() => {
      R.drawerView = "alerts";
      ctx.setHeader("Alerts");
      ctx.syncTabs();
    });
  });
  ctx.getActiveScreenEl().querySelector("#htbSearch")?.addEventListener("click", () => {
    R.drawerView = "globalSearch";
    ctx.setActiveScreen("drawer");
    renderGlobalSearch();
  });
  ctx.getActiveScreenEl().querySelector("#htbSettings")?.addEventListener("click", () => {
    ctx.navigateForward(() => {
      R.currentTab = "settings";
    });
  });

  // Apply bell badge now that #htbNotif exists in the DOM
  ctx._updateNotifBadge();

  // Card navigation
  ctx.getActiveScreenEl().querySelectorAll("[data-home]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.getAttribute("data-home");
      if (target === "songs") {
        ctx.navigateForward(() => {
          ctx.resetSongsFilters({ keepSort: true });
          ctx.getSongsListState().ownerFilter = "all";
          R.songsFromCollab = false;
          R.songsBackTarget = null;
          R.songsListScrollTop = 0;
          R.currentTab = "songs";
          R.songsView = "list";
          R.selectedSongId = null;
        });
        return;
      }
      if (target === "projects") {
        ctx.navigateForward(() => {
          ctx.setProjectsOwnerFilter("all");
          R.drawerView = "projects";

          R.selectedSongId = null;
        });
        return;
      }
      if (target === "releases") {
        ctx.navigateForward(() => {
          R.drawerView = "releases";

          R.selectedSongId = null;
        });
        return;
      }
      if (target === "lyrics") {
        ctx.navigateForward(() => {
          R.lyricsEditSongId = null;
          R.overlayView = "lyrics";
          ctx.setHeader("Lyrics");
          renderLyricsScratch();
        });
        return;
      }
      if (target === "next") return renderNextActions();
    });
  });

  // === Sal nudge for users who skipped import ===
  const skipData = JSON.parse(localStorage.getItem("salImportSkipped") || "null");
  if (skipData && !document.querySelector(".salNudge")) {
    const daysSince = (Date.now() - skipData.skippedAt) / 86400000;
    const dismissed = localStorage.getItem("salNudgeDismissed");
    const secondDismissed = localStorage.getItem("salNudgeSecondDismissed");
    const showNudge = !dismissed || (!secondDismissed && daysSince >= 7);

    if (showNudge) {
      const nudge = document.createElement("div");
      nudge.className = "salNudge salNudgeIn";
      nudge.innerHTML = `
        <div class="salNudgeBubble">
          <button class="salNudgeClose" aria-label="Dismiss">&times;</button>
          <div style="display:flex;align-items:center;gap:10px;">
            ${salSvg(32)}
            <span>Still got ${skipData.count} song${skipData.count !== 1 ? "s" : ""} in the cloud whenever you're ready.</span>
          </div>
        </div>
      `;

      nudge.querySelector(".salNudgeBubble").addEventListener("click", (e) => {
        if (e.target.closest(".salNudgeClose")) return;
        nudge.classList.add("salNudgeOut");
        localStorage.removeItem("salImportSkipped");
        setTimeout(() => { nudge.remove(); runSalImportFlow(); }, 300);
      });

      nudge.querySelector(".salNudgeClose").addEventListener("click", () => {
        nudge.classList.add("salNudgeOut");
        if (!dismissed) {
          localStorage.setItem("salNudgeDismissed", String(Date.now()));
        } else {
          localStorage.setItem("salNudgeSecondDismissed", String(Date.now()));
        }
        setTimeout(() => nudge.remove(), 300);
      });

      // Delay entrance slightly so home screen paints first
      setTimeout(() => document.body.appendChild(nudge), 1500);
    }
  }

  // === Portal energy system: particles + magnetic touch ===
  const homeGrid = ctx.getActiveScreenEl().querySelector(".homeGrid");
  if (homeGrid) {
    const cards = [...homeGrid.querySelectorAll(".hCard")];

    // Stranger Things upside-down particle palettes per card
    const particlePalettes = {
      hSongs:    { core: [220,38,38],  mid: [239,68,68],  hi: [252,165,165], dim: [153,27,27]  },  // Red
      hProjects: { core: [147,51,234], mid: [168,85,247], hi: [216,180,254], dim: [88,28,135]  },  // Purple
      hPlayer:   { core: [37,99,235],  mid: [59,130,246], hi: [147,197,253], dim: [30,64,175]  },  // Blue
      hLyrics:   { core: [234,179,8],  mid: [250,204,21], hi: [254,240,138], dim: [161,98,7]   },  // Gold
      hNext:     { core: [234,88,12],  mid: [249,115,22], hi: [253,186,116], dim: [154,52,18]  },  // Orange
    };

    function getPalette(card) {
      for (const cls of Object.keys(particlePalettes)) {
        if (card.classList.contains(cls)) return particlePalettes[cls];
      }
      return { core: [255,255,255], mid: [200,200,200], hi: [255,255,255], dim: [120,120,120] };
    }

    // Per-card personality — each card has its own river speed/direction/touch feel
    const cardPersonality = {
      hSongs:    { flowAngle: -80, flowSpeed: 0.35, wobble: 0.5, touchRadius: 55, touchStrength: 0.12 },
      hProjects: { flowAngle: -95, flowSpeed: 0.25, wobble: 0.6, touchRadius: 50, touchStrength: 0.10 },
      hPlayer:   { flowAngle: -70, flowSpeed: 0.30, wobble: 0.45, touchRadius: 60, touchStrength: 0.14 },
      hLyrics:   { flowAngle: -110, flowSpeed: 0.20, wobble: 0.7, touchRadius: 45, touchStrength: 0.09 },
      hNext:     { flowAngle: -85, flowSpeed: 0.40, wobble: 0.4, touchRadius: 55, touchStrength: 0.13 },
    };

    function getPersonality(card) {
      for (const cls of Object.keys(cardPersonality)) {
        if (card.classList.contains(cls)) return cardPersonality[cls];
      }
      return { flowAngle: -90, flowSpeed: 0.3, wobble: 0.5, touchRadius: 50, touchStrength: 0.11 };
    }

    // Per-card particle systems
    const cardSystems = cards.map(card => {
      const canvas = card.querySelector(".hParticles");
      const ctx = canvas.getContext("2d");
      const pal = getPalette(card);
      const persona = getPersonality(card);
      const particles = [];
      const COUNT = 75;
      let w = 0, h = 0;
      let touchX = -1, touchY = -1, isTouched = false;
      let warpIntensity = 0; // 0→1 ramp over ~1.2s

      // Convert flow angle to velocity components
      const flowRad = persona.flowAngle * Math.PI / 180;
      const baseFlowVx = Math.cos(flowRad) * persona.flowSpeed;
      const baseFlowVy = Math.sin(flowRad) * persona.flowSpeed;

      function rgba([r,g,b], a) { return `rgba(${r},${g},${b},${a})`; }

      // === Mesh warp system ===
      const warpCanvas = card.querySelector(".hWarp");
      const warpCtx = warpCanvas.getContext("2d");
      const imgEl = card.querySelector(".hArt img");
      let warpReady = false;
      let warpSrc = null; // offscreen canvas with the visible image portion
      const WARP_COLS = 14, WARP_ROWS = 18;
      const WARP_STRENGTH = 0.07;

      function initWarp() {
        if (!imgEl || !imgEl.naturalWidth || !w || !h) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        warpCanvas.width = w * dpr;
        warpCanvas.height = h * dpr;
        warpCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

        // Compute the visible source rect (object-fit:cover math)
        const artEl = card.querySelector(".hArt");
        const cardRect = card.getBoundingClientRect();
        const artRect = artEl.getBoundingClientRect();
        const imgW = imgEl.naturalWidth, imgH = imgEl.naturalHeight;
        const artW = artRect.width, artH = artRect.height;

        // Parse object-position
        const style = imgEl.getAttribute("style") || "";
        let posX = 0.5, posY = 0.5;
        const posMatch = style.match(/object-position:\s*([^\s;]+)\s+([^\s;]+)/);
        if (posMatch) {
          posX = posMatch[1] === "center" ? 0.5 : parseFloat(posMatch[1]) / 100;
          posY = posMatch[2] === "center" ? 0.5 : parseFloat(posMatch[2]) / 100;
        }

        // How img covers the art element
        const imgAspect = imgW / imgH, artAspect = artW / artH;
        let cropSx, cropSy, cropSw, cropSh;
        if (imgAspect > artAspect) {
          cropSh = imgH; cropSw = imgH * artAspect;
          cropSx = (imgW - cropSw) * posX; cropSy = 0;
        } else {
          cropSw = imgW; cropSh = imgW / artAspect;
          cropSx = 0; cropSy = (imgH - cropSh) * posY;
        }

        // Offset for card viewport within the larger art
        const offX = cardRect.left - artRect.left;
        const offY = cardRect.top - artRect.top;
        const scaleX = cropSw / artW, scaleY = cropSh / artH;

        // Pre-render the visible portion to an offscreen canvas
        const off = document.createElement("canvas");
        off.width = w * dpr; off.height = h * dpr;
        const offCtx = off.getContext("2d");
        offCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        offCtx.drawImage(imgEl,
          cropSx + offX * scaleX, cropSy + offY * scaleY,
          cardRect.width * scaleX, cardRect.height * scaleY,
          0, 0, w, h
        );
        warpSrc = off;
        warpReady = true;
      }

      // Wait for image load then init warp
      if (imgEl) {
        if (imgEl.complete && imgEl.naturalWidth) setTimeout(initWarp, 50);
        else imgEl.addEventListener("load", () => setTimeout(initWarp, 50), { once: true });
      }

      function drawWarp(tx, ty) {
        if (!warpReady) return;
        // Ramp intensity up over ~1.2s (~72 frames at 60fps)
        warpIntensity = Math.min(1, warpIntensity + 1 / 72);
        const intensity = warpIntensity;

        const cellW = w / WARP_COLS, cellH = h / WARP_ROWS;
        const srcCW = warpSrc.width / WARP_COLS, srcCH = warpSrc.height / WARP_ROWS;
        const radius = Math.min(w, h) * 0.7;
        // Overlap margin to eliminate grid seams
        const m = 2;

        warpCtx.clearRect(0, 0, w, h);
        for (let row = 0; row < WARP_ROWS; row++) {
          for (let col = 0; col < WARP_COLS; col++) {
            const destX = col * cellW, destY = row * cellH;
            const cenX = destX + cellW / 2, cenY = destY + cellH / 2;
            const dx = tx - cenX, dy = ty - cenY;
            const dist = Math.sqrt(dx * dx + dy * dy);

            let offX = 0, offY = 0;
            if (dist < radius && dist > 0.5) {
              const t = 1 - dist / radius;
              const pull = t * t * WARP_STRENGTH * intensity;
              offX = -dx * pull;
              offY = -dy * pull;
            }

            warpCtx.drawImage(warpSrc,
              col * srcCW - m, row * srcCH - m, srcCW + m * 2, srcCH + m * 2,
              destX + offX - m, destY + offY - m, cellW + m * 2, cellH + m * 2
            );
          }
        }
      }

      function clearWarp() {
        warpCtx.clearRect(0, 0, w, h);
      }

      function resize() {
        const rect = card.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        w = rect.width; h = rect.height;
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        // Re-init warp source on resize
        warpReady = false;
        initWarp();
      }

      function makeParticle(respawnEdge) {
        const roll = Math.random();
        let r, spdMult, baseAlpha, type;
        if (roll < 0.50) {
          type = "dust";
          r = Math.random() * 1.2 + 0.3;
          spdMult = 0.6 + Math.random() * 0.8;
          baseAlpha = Math.random() * 0.35 + 0.12;
        } else if (roll < 0.85) {
          type = "ember";
          r = Math.random() * 2 + 0.8;
          spdMult = 0.8 + Math.random() * 0.6;
          baseAlpha = Math.random() * 0.5 + 0.18;
        } else {
          type = "orb";
          r = Math.random() * 3.5 + 2;
          spdMult = 0.3 + Math.random() * 0.3;
          baseAlpha = Math.random() * 0.25 + 0.08;
        }

        const colors = type === "orb" ? [pal.core, pal.mid] :
                       type === "ember" ? [pal.core, pal.mid, pal.hi] :
                       [pal.mid, pal.hi, pal.dim];
        const color = colors[Math.floor(Math.random() * colors.length)];

        // River flow + individual variance
        const vx = baseFlowVx * spdMult + (Math.random() - 0.5) * 0.1;
        const vy = baseFlowVy * spdMult + (Math.random() - 0.5) * 0.1;

        // Spawn position: either random (init) or from the bottom/side edge (respawn)
        let x, y;
        if (respawnEdge) {
          // Respawn from the downstream edge so the river keeps flowing
          x = Math.random() * (w || 200);
          y = (h || 300) + Math.random() * 30;
        } else {
          x = Math.random() * (w || 200);
          y = Math.random() * (h || 300);
        }

        return {
          x, y, vx, vy, r, color, baseAlpha, type,
          // Store base velocity for restoring after touch
          bvx: vx, bvy: vy,
          phase: Math.random() * Math.PI * 2,
          flicker: type === "ember" ? 0.002 + Math.random() * 0.003 : 0.0008 + Math.random() * 0.0006,
          wobAmp: persona.wobble * (type === "orb" ? 1.4 : type === "ember" ? 0.8 : 0.5) + Math.random() * 0.3,
          // Absorption state: when a particle reaches the finger it fades and respawns
          absorb: 0, // 0 = normal, ramps to 1 = fully absorbed
        };
      }

      function initParticles() {
        resize();
        particles.length = 0;
        for (let i = 0; i < COUNT; i++) particles.push(makeParticle(false));
      }

      function draw(time) {
        // Draw localized mesh warp when touched — ramps in with intensity
        if (isTouched && touchX >= 0 && warpReady) {
          drawWarp(touchX, touchY);
          // Fade warp canvas in and original img out in sync with intensity
          warpCanvas.style.opacity = warpIntensity;
          if (imgEl) imgEl.style.opacity = 1 - warpIntensity;
        }

        ctx.clearRect(0, 0, w, h);
        for (let i = 0; i < particles.length; i++) {
          const p = particles[i];

          // Move along river flow
          p.x += p.vx;
          p.y += p.vy;

          // Off-screen? Respawn from downstream edge
          if (p.y < -15 || p.y > h + 20 || p.x < -15 || p.x > w + 20) {
            particles[i] = makeParticle(true);
            continue;
          }

          // If fully absorbed, respawn
          if (p.absorb >= 1) {
            particles[i] = makeParticle(true);
            continue;
          }

          // Sine wobble
          const wobX = Math.sin(time * 0.0005 + p.phase) * p.wobAmp;
          const wobY = Math.cos(time * 0.00045 + p.phase * 1.3) * p.wobAmp * 0.8;

          let drawX = p.x + wobX;
          let drawY = p.y + wobY;
          let drawR = p.r;

          // Flicker/breathe
          const breathe = 0.5 + 0.5 * Math.sin(time * p.flicker + p.phase);
          let alpha = p.baseAlpha * (0.4 + 0.6 * breathe);

          // Touch interaction — nearby fish drift toward finger, absorb on arrival
          if (isTouched && touchX >= 0) {
            const dx = touchX - drawX;
            const dy = touchY - drawY;
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist < persona.touchRadius) {
              // Nearby particle: gently steer toward finger
              const t = 1 - dist / persona.touchRadius; // 0 at edge, 1 at finger
              p.vx += (dx / (dist + 10)) * persona.touchStrength;
              p.vy += (dy / (dist + 10)) * persona.touchStrength;
              // Dampen slightly so approach is smooth, not jittery
              p.vx *= 0.96;
              p.vy *= 0.96;
              // Brighten as it approaches
              alpha = Math.min(1, alpha + t * 0.3);
              drawR *= 1 + t * 0.6;

              // Very close to finger — start absorbing (fade out)
              if (dist < 14) {
                p.absorb += 0.06;
                alpha *= (1 - p.absorb);
                drawR *= (1 - p.absorb * 0.5);
              }
            } else {
              // Far away fish — keep swimming, don't care about finger
              // Gently restore to base river velocity
              p.vx += (p.bvx - p.vx) * 0.02;
              p.vy += (p.bvy - p.vy) * 0.02;
            }
          } else {
            // No touch — restore to river flow
            p.vx += (p.bvx - p.vx) * 0.03;
            p.vy += (p.bvy - p.vy) * 0.03;
            // Reset any partial absorption
            if (p.absorb > 0) p.absorb = Math.max(0, p.absorb - 0.04);
          }

          if (alpha <= 0.01) continue;

          // Draw particle
          ctx.beginPath();
          ctx.arc(drawX, drawY, drawR, 0, Math.PI * 2);
          ctx.fillStyle = rgba(p.color, alpha);
          ctx.fill();

          // Glow halo
          const glowMult = p.type === "orb" ? 4.5 : p.type === "ember" ? 3 : 2;
          const glowAlpha = p.type === "orb" ? alpha * 0.12 : alpha * 0.1;
          if (drawR > 0.5) {
            ctx.beginPath();
            ctx.arc(drawX, drawY, drawR * glowMult, 0, Math.PI * 2);
            ctx.fillStyle = rgba(p.color, glowAlpha);
            ctx.fill();
          }
        }
      }

      // Darken overlay — animated manually in rAF, not CSS
      const darkenEl = card.querySelector(".hDarken");
      let darkenOpacity = 0;
      const DARKEN_MAX = 0.10;      // noticeable but not heavy
      const DARKEN_RATE = 0.0005;   // per-frame increment (~3.3s to reach max at 60fps)
      const DARKEN_FADE = 0.002;    // fade-out ~1s

      function updateDarken() {
        if (isTouched) {
          darkenOpacity = Math.min(DARKEN_MAX, darkenOpacity + DARKEN_RATE);
        } else if (darkenOpacity > 0) {
          darkenOpacity = Math.max(0, darkenOpacity - DARKEN_FADE);
        }
        if (darkenEl) darkenEl.style.opacity = darkenOpacity;
      }

      initParticles();
      return { card, canvas, ctx, draw, resize, particles, initParticles, updateDarken,
        clearWarp() { clearWarp(); warpIntensity = 0; warpCanvas.style.opacity = 0; if (imgEl) imgEl.style.opacity = ""; },
        setTouch(x, y) { if (!isTouched) warpIntensity = 0; touchX = x; touchY = y; isTouched = true; },
        clearTouch() { touchX = -1; touchY = -1; isTouched = false; },
        get warpIntensity() { return warpIntensity; }
      };
    });

    // Animation loop — single rAF for all cards
    let homeAnimId = null;
    function animLoop(time) {
      for (const sys of cardSystems) { sys.draw(time); sys.updateDarken(); }
      homeAnimId = requestAnimationFrame(animLoop);
    }

    // Observe visibility to pause when off-screen
    const observer = new IntersectionObserver(entries => {
      const visible = entries.some(e => e.isIntersecting);
      if (visible && !homeAnimId) homeAnimId = requestAnimationFrame(animLoop);
      if (!visible && homeAnimId) { cancelAnimationFrame(homeAnimId); homeAnimId = null; }
    }, { threshold: 0.1 });
    observer.observe(homeGrid);
    homeAnimId = requestAnimationFrame(animLoop);

    // Resize handler
    let resizeTimer;
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => cardSystems.forEach(s => s.resize()), 150);
    };
    window.addEventListener("resize", onResize);

    // === Magnetic touch interaction ===
    let hgStartX = 0, hgStartY = 0, hgDragged = false;
    let activeCard = null;

    // Smooth interpolation — art/card position eases toward target each frame
    const smoothEase = "transform 0.15s cubic-bezier(.25,.46,.45,.94)";

    homeGrid.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) return;
      hgStartX = e.touches[0].clientX;
      hgStartY = e.touches[0].clientY;
      hgDragged = false;

      // Find which card was touched
      const touch = e.touches[0];
      activeCard = null;
      for (const sys of cardSystems) {
        const rect = sys.card.getBoundingClientRect();
        if (touch.clientX >= rect.left && touch.clientX <= rect.right &&
            touch.clientY >= rect.top && touch.clientY <= rect.bottom) {
          activeCard = sys;
          const lx = touch.clientX - rect.left;
          const ly = touch.clientY - rect.top;
          sys.setTouch(lx, ly);
          sys.card.classList.add("is-touched");

          // Subtle global tilt transition
          const art = sys.card.querySelector(".hArt");
          if (art) art.style.transition = "transform 0.6s cubic-bezier(.25,.46,.45,.94), scale 8s cubic-bezier(.25,.46,.45,.94)";
          const pCanvas = sys.card.querySelector(".hParticles");
          if (pCanvas) pCanvas.style.transition = smoothEase;

          // Shimmer: shift toward touch point (portal energy drawn to finger)
          const shimmer = sys.card.querySelector(".hShimmer");
          if (shimmer) {
            const cx = rect.width / 2, cy = rect.height / 2;
            const sNormX = (lx - cx) / cx;
            const sNormY = (ly - cy) / cy;
            shimmer.style.transform = `translate(${sNormX * 15}%, ${sNormY * 15}%) scale(1.10)`;
          }
          break;
        }
      }
    }, { passive: true });

    homeGrid.addEventListener("touchmove", (e) => {
      if (e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - hgStartX;
      const dy = e.touches[0].clientY - hgStartY;
      if (!hgDragged && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
        hgDragged = true;
        homeGrid.classList.add("is-dragging");
      }

      if (activeCard) {
        const rect = activeCard.card.getBoundingClientRect();
        const lx = e.touches[0].clientX - rect.left;
        const ly = e.touches[0].clientY - rect.top;
        activeCard.setTouch(lx, ly);

        const cx = rect.width / 2, cy = rect.height / 2;
        const normX = (lx - cx) / cx; // -1 to 1
        const normY = (ly - cy) / cy; // -1 to 1

        // Localized warp is handled by canvas in the draw loop (reads touchX/Y)
        // Subtle global tilt + parallax — scaled by warp ramp so nothing moves instantly
        const wi = activeCard.warpIntensity;
        const art = activeCard.card.querySelector(".hArt");
        if (art) art.style.transform = `perspective(1400px) rotateX(${-normY * 1.5 * wi}deg) rotateY(${normX * 2 * wi}deg) translate(${normX * 2 * wi}px, ${normY * 2 * wi}px)`;

        const pCanvas = activeCard.card.querySelector(".hParticles");
        if (pCanvas) pCanvas.style.transform = `translate(${normX * 2 * wi}px, ${normY * 2 * wi}px)`;

        // Shimmer: energy drawn toward finger
        const shimmer = activeCard.card.querySelector(".hShimmer");
        if (shimmer) shimmer.style.transform = `translate(${normX * 18 * wi}%, ${normY * 18 * wi}%) scale(${1 + 0.12 * wi})`;
      }
    }, { passive: true });

    const releaseCard = () => {
      homeGrid.classList.remove("is-dragging");
      if (hgDragged) {
        homeGrid.addEventListener("click", e => { e.stopPropagation(); e.preventDefault(); }, { once: true, capture: true });
      }
      if (activeCard) {
        activeCard.clearTouch();
        activeCard.clearWarp();
        activeCard.card.classList.remove("is-touched");

        const ease = "transform 0.5s cubic-bezier(.22,1,.36,1)";

        // Spring art tilt back
        const art = activeCard.card.querySelector(".hArt");
        if (art) {
          art.style.transition = ease + ", scale 4s cubic-bezier(.25,.46,.45,.94)";
          art.style.transform = "";
        }

        // Spring particles canvas back
        const pCanvas = activeCard.card.querySelector(".hParticles");
        if (pCanvas) {
          pCanvas.style.transition = ease;
          pCanvas.style.transform = "";
        }

        // Spring shimmer back to center (CSS animation resumes via removing .is-touched)
        const shimmer = activeCard.card.querySelector(".hShimmer");
        if (shimmer) {
          shimmer.style.transition = "transform 0.6s cubic-bezier(.22,1,.36,1), opacity 0.5s ease, filter 0.5s ease";
          shimmer.style.transform = "";
        }

        // Clean up inline transitions after spring completes
        const artRef = art, pRef = pCanvas, shimRef = shimmer;
        const onEnd = () => {
          if (artRef) artRef.style.transition = "";
          if (pRef) pRef.style.transition = "";
          if (shimRef) shimRef.style.transition = "";
        };
        (art || pCanvas)?.addEventListener("transitionend", onEnd, { once: true });
        activeCard = null;
      }
    };

    homeGrid.addEventListener("touchend", releaseCard, { passive: true });
    homeGrid.addEventListener("touchcancel", releaseCard, { passive: true });

    // Pause/resume — freeze particle positions AND CSS animations when home goes off-screen
    homeGrid._pauseHome = () => {
      if (homeAnimId) { cancelAnimationFrame(homeAnimId); homeAnimId = null; }
      homeGrid.querySelectorAll(".hShimmer, .hCard").forEach(el => {
        el.style.animationPlayState = "paused";
      });
    };
    homeGrid._resumeHome = () => {
      if (!homeAnimId) homeAnimId = requestAnimationFrame(animLoop);
      homeGrid.querySelectorAll(".hShimmer, .hCard").forEach(el => {
        el.style.animationPlayState = "";
      });
    };

    // Cleanup when navigating away
    const cleanupHome = () => {
      if (homeAnimId) { cancelAnimationFrame(homeAnimId); homeAnimId = null; }
      observer.disconnect();
      window.removeEventListener("resize", onResize);
    };
    homeGrid._cleanupHome = cleanupHome;
  }
}
