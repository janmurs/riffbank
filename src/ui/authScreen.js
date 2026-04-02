import { signUp, signIn, verifyOtp, resendConfirmation } from "../supabase.js";
import { salSvg } from "./onboarding.js";

export function showAuthScreen() {
  return new Promise((resolve) => {
    const el = document.createElement("div");
    el.id = "authScreen";
    el.className = "authScreen";

    // Step 1: Login / Signup form
    // Render shell first WITHOUT inputs — iOS scans DOM on first paint for autofill.
    // Inputs are injected after a delay so iOS never sees a "login form".
    function renderForm() {
      el.innerHTML = `
        <div class="authCard">
          <div class="authSalWrap">${salSvg(80)}</div>
          <div class="authLogo">RiffBank</div>
          <div class="authToggle">
            <button class="authToggleBtn active" data-mode="login">Log In</button>
            <button class="authToggleBtn" data-mode="signup">Sign Up</button>
          </div>
          <form id="authForm" autocomplete="off">
            <div id="authInputs"></div>
            <div id="authError" class="authError"></div>
            <button id="authSubmit" type="submit" class="authSubmitBtn">Log In</button>
          </form>
        </div>
      `;
      // Inject inputs after iOS autofill scan completes, then fade the screen in
      setTimeout(() => {
        const slot = el.querySelector("#authInputs");
        if (!slot) return;
        slot.innerHTML = `
          <input id="authEmail" type="text" inputmode="email" placeholder="Email" required autocomplete="off" />
          <div class="authPassWrap">
            <input id="authPass" type="password" placeholder="Password" required autocomplete="off" />
            <button type="button" class="authEyeBtn" id="authEye" aria-label="Show password">
              <svg class="authEyeOpen" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              <svg class="authEyeClosed" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
            </button>
          </div>
        `;
        wireForm();
        // Fade in now that the form is fully built (no partial flash)
        requestAnimationFrame(() => { el.style.opacity = ""; });
      }, 500);
    }

    // Step 2: OTP code entry (after signup)
    function renderOtp(email) {
      el.innerHTML = `
        <div class="authCard">
          <div class="authSalWrap">${salSvg(80)}</div>
          <div class="authLogo">Check Your Email</div>
          <div class="authOtpHint">
            We sent a 6-digit code to<br><strong>${email}</strong>
          </div>
          <form id="otpForm">
            <div class="authOtpRow">
              <input class="authOtpDigit" type="text" inputmode="numeric" maxlength="1" autocomplete="one-time-code" />
              <input class="authOtpDigit" type="text" inputmode="numeric" maxlength="1" />
              <input class="authOtpDigit" type="text" inputmode="numeric" maxlength="1" />
              <input class="authOtpDigit" type="text" inputmode="numeric" maxlength="1" />
              <input class="authOtpDigit" type="text" inputmode="numeric" maxlength="1" />
              <input class="authOtpDigit" type="text" inputmode="numeric" maxlength="1" />
            </div>
            <div id="authError" class="authError"></div>
            <button id="otpSubmit" type="submit" class="authSubmitBtn">Verify</button>
          </form>
          <div class="authOtpLinks">
            <button class="authLinkBtn" id="otpResend">Resend code</button>
            <button class="authLinkBtn" id="otpBack">Back to login</button>
          </div>
        </div>
      `;
      wireOtp(email);
    }

    function wireForm() {
      let mode = "login";
      const toggleBtns = el.querySelectorAll(".authToggleBtn");
      const submitBtn = el.querySelector("#authSubmit");
      const errorEl = el.querySelector("#authError");
      const passInput = el.querySelector("#authPass");
      const eyeBtn = el.querySelector("#authEye");

      // Password visibility toggle
      eyeBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const isHidden = passInput.type === "password";
        passInput.type = isHidden ? "text" : "password";
        eyeBtn.classList.toggle("showing", isHidden);
      });

      toggleBtns.forEach((btn) => {
        btn.addEventListener("click", () => {
          mode = btn.dataset.mode;
          toggleBtns.forEach((b) => b.classList.toggle("active", b === btn));
          submitBtn.textContent = mode === "login" ? "Log In" : "Create Account";
          errorEl.textContent = "";
        });
      });

      el.querySelector("#authForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const email = el.querySelector("#authEmail").value.trim();
        const pass = el.querySelector("#authPass").value;
        errorEl.textContent = "";
        errorEl.style.color = "";
        submitBtn.disabled = true;
        submitBtn.textContent = mode === "login" ? "Logging in..." : "Creating account...";

        try {
          if (mode === "signup") {
            const data = await signUp(email, pass);
            if (data.user && !data.session) {
              // Email confirmation required — show OTP screen
              renderOtp(email);
              return;
            }
            // Supabase returns a user with a fake session if the email already
            // exists but is unconfirmed — detect that and resend confirmation
            if (data.user && data.user.identities?.length === 0) {
              // User exists already — resend confirmation and go to OTP
              try { await resendConfirmation(email); } catch {}
              renderOtp(email);
              return;
            }
          } else {
            await signIn(email, pass);
          }
          el.classList.add("authFadeOut");
          setTimeout(() => { el.remove(); resolve(); }, 300);
        } catch (err) {
          const msg = err.message || "Something went wrong";
          // If login fails with "invalid credentials" it might be an unconfirmed account
          if (mode === "login" && msg.toLowerCase().includes("invalid")) {
            errorEl.style.color = "";
            errorEl.innerHTML = `Invalid credentials. Haven't confirmed your email? <button class="authInlineLink" id="authResendFromError">Resend code</button>`;
            const resendLink = el.querySelector("#authResendFromError");
            if (resendLink) {
              resendLink.addEventListener("click", async () => {
                resendLink.textContent = "Sending...";
                try {
                  await resendConfirmation(email);
                  renderOtp(email);
                } catch (e2) {
                  errorEl.textContent = e2.message || "Couldn't resend";
                }
              });
            }
          } else {
            errorEl.style.color = "";
            errorEl.textContent = msg;
          }
          submitBtn.disabled = false;
          submitBtn.textContent = mode === "login" ? "Log In" : "Create Account";
        }
      });
    }

    function wireOtp(email) {
      const digits = el.querySelectorAll(".authOtpDigit");
      const submitBtn = el.querySelector("#otpSubmit");
      const errorEl = el.querySelector("#authError");

      // Auto-focus first input
      digits[0].focus({ preventScroll: true });

      // Auto-advance on input, support paste
      digits.forEach((input, i) => {
        input.addEventListener("input", () => {
          const val = input.value.replace(/\D/g, "");
          input.value = val.slice(0, 1);
          if (val && i < digits.length - 1) digits[i + 1].focus({ preventScroll: true });
        });
        input.addEventListener("keydown", (e) => {
          if (e.key === "Backspace" && !input.value && i > 0) {
            digits[i - 1].focus({ preventScroll: true });
          }
        });
        input.addEventListener("paste", (e) => {
          e.preventDefault();
          const pasted = (e.clipboardData.getData("text") || "").replace(/\D/g, "").slice(0, 6);
          pasted.split("").forEach((ch, j) => {
            if (digits[j]) digits[j].value = ch;
          });
          if (pasted.length > 0) digits[Math.min(pasted.length, digits.length) - 1].focus({ preventScroll: true });
        });
      });

      el.querySelector("#otpForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const code = Array.from(digits).map(d => d.value).join("");
        if (code.length !== 6) {
          errorEl.textContent = "Enter all 6 digits";
          return;
        }
        errorEl.textContent = "";
        submitBtn.disabled = true;
        submitBtn.textContent = "Verifying...";

        try {
          await verifyOtp(email, code);
          el.classList.add("authFadeOut");
          setTimeout(() => { el.remove(); resolve(); }, 300);
        } catch (err) {
          errorEl.textContent = err.message || "Invalid code — try again";
          submitBtn.disabled = false;
          submitBtn.textContent = "Verify";
        }
      });

      // Resend code
      const resendBtn = el.querySelector("#otpResend");
      resendBtn.addEventListener("click", async () => {
        resendBtn.disabled = true;
        resendBtn.textContent = "Sending...";
        try {
          await resendConfirmation(email);
          errorEl.style.color = "#22c55e";
          errorEl.textContent = "New code sent!";
          // Clear old digits
          digits.forEach(d => { d.value = ""; });
          digits[0].focus({ preventScroll: true });
        } catch (err) {
          errorEl.style.color = "";
          errorEl.textContent = err.message || "Couldn't resend — try again";
        }
        resendBtn.disabled = false;
        resendBtn.textContent = "Resend code";
      });

      el.querySelector("#otpBack").addEventListener("click", () => renderForm());
    }

    // Render form content BEFORE appending to DOM so there's no empty flash.
    // The card starts hidden and fades in once inputs are injected (500ms iOS autofill workaround).
    renderForm();
    el.style.opacity = "0";
    document.body.appendChild(el);

    // Prevent iOS from scrolling behind the auth overlay on any input focus
    el.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });

    if (window.visualViewport) {
      let lastH = window.visualViewport.height;
      const onResize = () => {
        const vv = window.visualViewport;
        lastH = vv.height;
        el.style.height = vv.height + "px";
        el.style.top = vv.offsetTop + "px";
        el.style.bottom = "auto";
        window.scrollTo(0, 0);
      };
      const onScroll = () => {
        const vv = window.visualViewport;
        el.style.top = vv.offsetTop + "px";
      };
      window.visualViewport.addEventListener("resize", onResize);
      window.visualViewport.addEventListener("scroll", onScroll);
      const obs = new MutationObserver(() => {
        if (!document.getElementById("authScreen")) {
          window.visualViewport.removeEventListener("resize", onResize);
          window.visualViewport.removeEventListener("scroll", onScroll);
          obs.disconnect();
        }
      });
      obs.observe(document.body, { childList: true });
    }
  });
}
