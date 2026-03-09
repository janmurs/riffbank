import { sleep } from "../ui/dom.js";

export async function runSplashSequence() {
  const splash = document.getElementById("splash");
  const title = document.getElementById("splashTitle");
  const subWrap = document.getElementById("splashSub");       // wrapper div (IMPORTANT)
  const subText = document.getElementById("splashSubText");   // text span
  const spinner = document.getElementById("splashSpinner");

  if (!splash) return;

  document.body.classList.add("splashing");

  if (title) title.classList.add("shimmer");

  if (subText) subText.textContent = "Indexing your universe";

  if (subWrap) subWrap.classList.remove("show", "churn", "jumpIn", "jumpOut", "static");

  if (spinner) spinner.classList.remove("show");

  await sleep(1200);

  splash.classList.add("phase1");
  if (spinner) spinner.classList.add("show");

  if (subWrap) subWrap.classList.add("show", "churn", "static");

  await sleep(2400);

  splash.classList.add("hide");
  splash.setAttribute("aria-hidden", "true");
  await sleep(420);
  splash.remove();

  document.body.classList.remove("splashing");
}

/** Re-inject splash DOM and replay the sequence (used after wipe). */
export async function replaySplash() {
  // Remove any leftover splash
  document.getElementById("splash")?.remove();

  const splashEl = document.createElement("div");
  splashEl.id = "splash";
  splashEl.setAttribute("aria-hidden", "false");
  splashEl.innerHTML = `
    <div class="splashInner">
      <div id="splashTitle">RiffBank</div>
      <div id="splashSub" class="splashSub">
        <span id="splashSubText" class="splashSubText">Indexing your universe</span>
        <span class="splashEllipsis" aria-hidden="true">
          <span></span><span></span><span></span>
        </span>
      </div>
    </div>`;
  document.body.prepend(splashEl);

  await runSplashSequence();
}
