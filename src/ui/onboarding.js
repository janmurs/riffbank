import { state } from "../state.js";

// ── Sal SVG mascot ──
export function salSvg(size = 140) {
  return `<img src="./sal.svg" alt="Sal" width="${size}" style="height:auto;">`;
}

// ── Onboarding cleanup — fades + removes all onboarding overlays ──
export function dismissOnboarding() {
  document.querySelectorAll(".welcomeScreen, .driveScreen").forEach(el => {
    el.classList.add("welcomeOut");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  });
  document.body.classList.remove("welcoming");
}

// ── Welcome screen (Duolingo-style landing after splash) ──
// Returns a promise that resolves when user taps a button.
// result: "getStarted" or "hasAccount"
export function showWelcomeScreen() {
  return new Promise(resolve => {
    document.body.classList.add("welcoming");
    const el = document.createElement("div");
    el.id = "welcomeScreen";
    el.className = "welcomeScreen welcomeIn";
    el.innerHTML = `
      <div class="welcomeSalWrap">
        ${salSvg(140)}
      </div>
      <div class="welcomeTitle">RiffBank</div>
      <div class="welcomeSub">Your music. Everywhere.</div>
      <div class="welcomeBtns">
        <button class="welcomeBtn welcomeBtnPrimary" data-action="getStarted">GET STARTED</button>
        <button class="welcomeBtn welcomeBtnSecondary" data-action="hasAccount">I ALREADY HAVE AN ACCOUNT</button>
      </div>
    `;

    el.addEventListener("click", e => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      resolve(btn.dataset.action);
    });

    document.body.appendChild(el);
    document.body.classList.remove("splashing");
  });
}

// ── Drive connect screen (Duolingo-style, after welcome) ──
// Returns a promise: { action: "connected"|"skip"|"back" }
export function showDriveScreen() {
  return new Promise(resolve => {
    const el = document.createElement("div");
    el.className = "driveScreen";
    el.innerHTML = `
      <button class="driveBackBtn" data-action="back">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="15 18 9 12 15 6"/>
        </svg>
      </button>
      <div class="driveBubbleArea">
        <div class="driveBubble">
          <strong>RiffBank</strong> stores, manages, and releases all of your in-progress songs in the cloud.
        </div>
        <div class="driveSalWrap">${salSvg(120)}</div>
      </div>
      <div class="driveBtns">
        <button class="driveBtnConnect" data-action="connect">CONNECT GOOGLE DRIVE</button>
        <button class="driveBtnSkip" data-action="skip">Maybe later</button>
      </div>
    `;

    el.addEventListener("click", async e => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;

      if (action === "back" || action === "skip") {
        resolve({ action });
        return;
      }

      if (action === "connect" || action === "connectExisting" || action === "pick") {
        resolve({ action: "skip" });
      }
    });

    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add("welcomeIn"));
  });
}

// ── Sal help sheet ──
export function openSalSheet() {
  document.getElementById("salSheetBackdrop")?.remove();
  document.getElementById("salSheet")?.remove();

  const backdrop = document.createElement("div");
  backdrop.id = "salSheetBackdrop";
  backdrop.className = "actionSheetBackdrop";

  const sheet = document.createElement("div");
  sheet.id = "salSheet";
  sheet.className = "actionSheet";
  sheet.style.cssText = "padding: 0; overflow: hidden; border-radius: 22px;";
  sheet.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;padding:28px 24px 12px;gap:12px;">
      ${salSvg(80)}
      <div style="font-size:22px;font-weight:900;color:#fff;letter-spacing:-0.4px;">Hey, I'm Sal!</div>
      <div style="font-size:14px;color:rgba(255,255,255,.55);text-align:center;line-height:1.6;max-width:280px;">
        Your RiffBank guide. I'll help you manage songs, projects, versions, and everything in between.
      </div>
    </div>
    <div style="height:1px;background:rgba(255,255,255,.08);margin:0 16px;"></div>
    <button class="actionSheetBtn" id="salClose">Got it</button>
  `;

  function close() { backdrop.remove(); sheet.remove(); }
  backdrop.addEventListener("click", close);
  sheet.querySelector("#salClose")?.addEventListener("click", close);

  document.body.appendChild(backdrop);
  document.body.appendChild(sheet);
}

// ── Sal first-time onboarding ──
export function openSalOnboarding({ force = false } = {}) {
  if (!force && localStorage.getItem("salOnboardingDone")) return;
  if (!force && state.songs?.length) { localStorage.setItem("salOnboardingDone", "1"); return; }

  document.getElementById("salSheetBackdrop")?.remove();
  document.getElementById("salSheet")?.remove();

  const backdrop = document.createElement("div");
  backdrop.id = "salSheetBackdrop";
  backdrop.className = "actionSheetBackdrop";

  const sheet = document.createElement("div");
  sheet.id = "salSheet";
  sheet.className = "actionSheet";
  sheet.style.cssText = "padding: 0; overflow: hidden; border-radius: 22px;";
  sheet.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;padding:32px 24px 20px;gap:14px;">
      ${salSvg(96)}
      <div style="font-size:24px;font-weight:900;color:#fff;letter-spacing:-0.4px;">Welcome to RiffBank!</div>
      <div style="font-size:15px;color:rgba(255,255,255,.55);text-align:center;line-height:1.7;max-width:290px;">
        Hey, I'm <strong style="color:#fff;">Sal</strong>! I'll be your guide around here.<br><br>
        RiffBank keeps all your songs, versions, and projects safe in the <strong style="color:#fff;">cloud</strong> — record on any device and access your music anywhere.
      </div>
    </div>
    <div style="height:1px;background:rgba(255,255,255,.08);margin:0 16px;"></div>
    <div style="padding:8px 0 6px;display:flex;flex-direction:column;">
      <button class="actionSheetBtn" id="salDismiss" style="font-weight:700;">Got it, let's go!</button>
    </div>
  `;

  function close() { backdrop.remove(); sheet.remove(); localStorage.setItem("salOnboardingDone", "1"); }

  backdrop.addEventListener("click", close);
  sheet.querySelector("#salDismiss")?.addEventListener("click", close);

  document.body.appendChild(backdrop);
  document.body.appendChild(sheet);
}
