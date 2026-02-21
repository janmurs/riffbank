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

  const lines = [
    "Indexing your universe",
    "Syncing sessions",
    "Entering RiffBank",
  ];

  const HOLD_1 = 2400;
  const HOLD_2 = 2400;
  const HOLD_3 = 900;

  const cssJump = (() => {
    try {
      const raw = getComputedStyle(document.documentElement)
        .getPropertyValue("--splash-jump-ms")
        .trim();
      const n = parseInt(raw, 10);
      return Number.isFinite(n) ? n : 520;
    } catch {
      return 520;
    }
  })();

  const JUMP_MS = cssJump;

  if (subText) subText.textContent = lines[0];

  if (subWrap) subWrap.classList.remove("show", "churn", "jumpIn", "jumpOut", "static");

  if (spinner) spinner.classList.remove("show");

  await sleep(1200);

  splash.classList.add("phase1");
  if (spinner) spinner.classList.add("show");

  if (subWrap) subWrap.classList.add("show", "churn", "static");

  await sleep(550);

  async function jumpSwap(nextText) {
    if (!subWrap || !subText) return;

    subWrap.classList.remove("static");

    subWrap.classList.remove("jumpIn", "jumpOut");
    void subWrap.offsetHeight;
    subWrap.classList.add("jumpOut");
    await sleep(JUMP_MS);

    subWrap.classList.remove("jumpOut");
    void subWrap.offsetHeight;
    subText.textContent = nextText;

    subWrap.classList.add("jumpIn");
    await sleep(JUMP_MS);

    subWrap.classList.remove("jumpIn");
    subWrap.classList.add("static");
  }

  await sleep(HOLD_1);
  await jumpSwap(lines[1]);
  await sleep(HOLD_2);
  await jumpSwap(lines[2]);
  await sleep(HOLD_3);

  splash.classList.add("hide");
  splash.setAttribute("aria-hidden", "true");
  await sleep(420);
  splash.remove();

  document.body.classList.remove("splashing");
}
