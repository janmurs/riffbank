import { supabase, upsertProfile } from "../supabase.js";
import { uid } from "./dom.js";
import { state } from "../state.js";
import { salSvg } from "./onboarding.js";
import { AVATAR_PRESETS, renderAvatarPreset, openAvatarPicker } from "./avatars.js";

export async function showProfileSetupIfNeeded() {
  try {
    const { data: userData } = await supabase.auth.getUser();
    const uid = userData?.user?.id;
    console.log("[ProfileSetup] uid:", uid);
    if (!uid) { console.log("[ProfileSetup] no uid, skipping"); return; }

    // Check if profile already exists in DB — skip setup if so
    const { data: existing } = await supabase
      .from("profiles").select("id, display_name").eq("id", uid).maybeSingle();
    console.log("[ProfileSetup] existing:", existing);
    if (existing?.display_name) {
      console.log("[ProfileSetup] profile exists, skipping");
      localStorage.setItem("profileSetupDone", "1");
      return;
    }
  } catch (e) {
    console.warn("[ProfileSetup] error:", e);
    // profiles table may not exist yet — still show setup
    if (localStorage.getItem("profileSetupDone")) return;
  }

  console.log("[ProfileSetup] showing setup");
  await showProfileSetup();
}

export function showProfileSetup() {
  return new Promise((resolve) => {
    const el = document.createElement("div");
    el.className = "profileSetup";
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add("open"));

    // Collected data across steps
    const profile = { firstName: "", lastName: "", username: "", location: "", avatarBlob: null, avatarPreview: null, avatarPreset: null, instrument: "", genre: "" };
    let checkTimer = null;

    // ── Step 1: Name + Profile Picture ──
    function renderStep1() {
      el.innerHTML = `
        <div class="profileSetupInner">
          <div class="profileSetupSal">${salSvg(80)}</div>
          <div class="profileSetupTitle">What's your name?</div>
          <div class="profileSetupSub">This is how other musicians will see you</div>

          <div class="profileSetupForm">
            <button class="psAvatarPicker" id="psAvatarPicker">
              <div class="psAvatarPreview" id="psAvatarPreview">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>
              </div>
              <div class="psAvatarLabel">Add photo</div>
            </button>

            <div class="profileSetupRow">
              <div class="profileSetupField">
                <label class="profileSetupLabel">First Name</label>
                <input id="psFirstName" class="profileSetupInput" type="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" data-form-type="other" />
              </div>
              <div class="profileSetupField">
                <label class="profileSetupLabel">Last Name</label>
                <input id="psLastName" class="profileSetupInput" type="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" data-form-type="other" />
              </div>
            </div>
          </div>

          <button class="profileSetupBtn" id="psNext1">Continue</button>
        </div>
      `;

      // Restore values if going back
      if (profile.firstName) $("#psFirstName").value = profile.firstName;
      if (profile.lastName) $("#psLastName").value = profile.lastName;
      if (profile.avatarPreview) {
        const prev = $("#psAvatarPreview");
        prev.innerHTML = `<img src="${profile.avatarPreview}" />`;
        prev.classList.add("hasImg");
      } else if (profile.avatarPreset) {
        const prev = $("#psAvatarPreview");
        prev.innerHTML = renderAvatarPreset(profile.avatarPreset);
        prev.classList.add("hasImg");
      }

      // Avatar picker — opens bottom sheet
      $("#psAvatarPicker")?.addEventListener("click", () => {
        openAvatarPicker({
          currentSrc: profile.avatarPreview,
          onPickFile: (file, previewUrl) => {
            profile.avatarBlob = file;
            profile.avatarPreset = null;
            profile.avatarPreview = previewUrl || URL.createObjectURL(file);
            const prev = $("#psAvatarPreview");
            if (prev) { prev.innerHTML = `<img src="${profile.avatarPreview}" />`; prev.classList.add("hasImg"); }
          },
          onPickPreset: (preset) => {
            profile.avatarPreset = preset;
            profile.avatarBlob = null;
            profile.avatarPreview = null;
            const prev = $("#psAvatarPreview");
            if (prev) { prev.innerHTML = renderAvatarPreset(preset); prev.classList.add("hasImg"); }
          },
          onRemove: () => {
            profile.avatarBlob = null;
            profile.avatarPreset = null;
            profile.avatarPreview = null;
            const prev = $("#psAvatarPreview");
            if (prev) {
              prev.innerHTML = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>`;
              prev.classList.remove("hasImg");
            }
          },
        });
      });

      $("#psNext1")?.addEventListener("click", () => {
        profile.firstName = ($("#psFirstName")?.value || "").trim();
        profile.lastName = ($("#psLastName")?.value || "").trim();
        renderStep2();
      });

    }

    // ── Step 2: Username ──
    function renderStep2() {
      el.innerHTML = `
        <div class="profileSetupInner">
          <div class="profileSetupSal">${salSvg(80)}</div>
          <div class="profileSetupTitle">Pick a username</div>
          <div class="profileSetupSub">This is your unique handle on RiffBank</div>

          <div class="profileSetupForm">
            <div class="profileSetupField">
              <div class="profileSetupInputWrap">
                <span class="profileSetupAt">@</span>
                <input id="psUsername" class="profileSetupInput profileSetupInputAt" type="text" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" data-form-type="other" />
              </div>
              <div class="psUsernameStatus" id="psUsernameStatus"></div>
            </div>
          </div>

          <button class="profileSetupBtn" id="psNext2" disabled>Continue</button>
          <button class="profileSetupSkip" id="psBack2">Back</button>
        </div>
      `;

      if (profile.username) {
        $("#psUsername").value = profile.username;
      }

      let usernameValid = false;

      const checkUsername = async (raw) => {
        const statusEl = $("#psUsernameStatus");
        const nextBtn = $("#psNext2");
        const cleaned = raw.replace(/[^a-zA-Z0-9_]/g, "").toLowerCase();

        // Update input to cleaned value
        const input = $("#psUsername");
        if (input && input.value !== cleaned) {
          input.value = cleaned;
        }

        if (!cleaned || cleaned.length < 2) {
          statusEl.textContent = "";
          statusEl.className = "psUsernameStatus";
          nextBtn.disabled = true;
          usernameValid = false;
          return;
        }

        statusEl.textContent = "Checking...";
        statusEl.className = "psUsernameStatus checking";
        nextBtn.disabled = true;
        usernameValid = false;

        try {
          // Check if username is taken by someone else (allow own username)
          const { data: userData } = await supabase.auth.getUser();
          const myUid = userData?.user?.id;

          const { data } = await supabase
            .from("profiles")
            .select("id")
            .eq("display_name", cleaned)
            .maybeSingle();

          // Check if input changed while we were checking
          if (($("#psUsername")?.value || "").toLowerCase().replace(/[^a-zA-Z0-9_]/g, "") !== cleaned) return;

          if (data && data.id !== myUid) {
            statusEl.textContent = "Sorry, that username is taken";
            statusEl.className = "psUsernameStatus taken";
            nextBtn.disabled = true;
            usernameValid = false;
          } else if (data && data.id === myUid) {
            statusEl.textContent = "Existing profile found — new values will overwrite";
            statusEl.className = "psUsernameStatus existing";
            nextBtn.disabled = false;
            usernameValid = true;
          } else {
            statusEl.textContent = "Available!";
            statusEl.className = "psUsernameStatus available";
            nextBtn.disabled = false;
            usernameValid = true;
          }
        } catch {
          // If profiles table doesn't exist, just allow it
          statusEl.textContent = "Looks good!";
          statusEl.className = "psUsernameStatus available";
          nextBtn.disabled = false;
          usernameValid = true;
        }
      };

      $("#psUsername")?.addEventListener("input", (e) => {
        clearTimeout(checkTimer);
        checkTimer = setTimeout(() => checkUsername(e.target.value), 400);
      });

      // If we already had a username, re-check it
      if (profile.username) {
        checkUsername(profile.username);
      }

      setTimeout(() => $("#psUsername")?.focus(), 150);

      $("#psNext2")?.addEventListener("click", () => {
        if (!usernameValid) return;
        profile.username = ($("#psUsername")?.value || "").trim().toLowerCase().replace(/[^a-zA-Z0-9_]/g, "");
        renderStep3();
      });

      $("#psBack2")?.addEventListener("click", () => renderStep1());
    }

    // ── Step 3: Location, Instrument + Genre ──
    function renderStep3() {
      el.innerHTML = `
        <div class="profileSetupInner">
          <div class="profileSetupSal">${salSvg(80)}</div>
          <div class="profileSetupTitle">Tell us more</div>
          <div class="profileSetupSub">Help others find musicians like you</div>

          <div class="profileSetupForm">
            <div class="profileSetupField">
              <label class="profileSetupLabel">Location</label>
              <input id="psLocation" class="profileSetupInput" type="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" data-form-type="other" />
            </div>

            <div class="profileSetupField">
              <label class="profileSetupLabel">Primary Instrument</label>
              <input id="psInstrument" class="profileSetupInput" type="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" data-form-type="other" />
            </div>

            <div class="profileSetupField">
              <label class="profileSetupLabel">Favorite Genre</label>
              <input id="psGenre" class="profileSetupInput" type="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" data-form-type="other" />
            </div>
          </div>

          <button class="profileSetupBtn" id="psFinish">Let's Go!</button>
          <button class="profileSetupSkip" id="psBack3">Back</button>
        </div>
      `;

      if (profile.location) $("#psLocation").value = profile.location;
      if (profile.instrument) $("#psInstrument").value = profile.instrument;
      if (profile.genre) $("#psGenre").value = profile.genre;

      setTimeout(() => $("#psLocation")?.focus(), 150);

      $("#psFinish")?.addEventListener("click", () => {
        profile.location = ($("#psLocation")?.value || "").trim();
        profile.instrument = ($("#psInstrument")?.value || "").trim();
        profile.genre = ($("#psGenre")?.value || "").trim();
        finishSetup(false);
      });

      $("#psBack3")?.addEventListener("click", () => {
        profile.location = ($("#psLocation")?.value || "").trim();
        profile.instrument = ($("#psInstrument")?.value || "").trim();
        profile.genre = ($("#psGenre")?.value || "").trim();
        renderStep2();
      });
    }

    // ── Save & Close ──
    async function finishSetup(skipped) {
      let autoAssignedPreset = null;

      if (!skipped) {
        const displayName = profile.username || [profile.firstName, profile.lastName].filter(Boolean).join(" ") || "RiffBanker";

        try {
          const { data: userData } = await supabase.auth.getUser();
          const uid = userData?.user?.id;
          if (uid) {
            const row = {
              id: uid,
              first_name: profile.firstName || null,
              last_name: profile.lastName || null,
              display_name: displayName,
              location: profile.location || null,
              instrument: profile.instrument || null,
              genre: profile.genre || null,
              bio: null,
              updated_at: new Date().toISOString(),
            };
            console.log("[ProfileSetup] Saving profile:", row);
            const { error } = await supabase.from("profiles").upsert(row, { onConflict: "id" });
            if (error) console.error("[ProfileSetup] Upsert error:", error);

            // Upload avatar or save preset
            if (profile.avatarBlob) {
              try {
                const ext = profile.avatarBlob.name?.split(".").pop() || "jpg";
                const path = `${uid}/avatar.${ext}`;
                const { error: uploadErr } = await supabase.storage.from("covers").upload(path, profile.avatarBlob, { upsert: true, contentType: profile.avatarBlob.type || "image/jpeg" });
                if (uploadErr) { console.warn("[ProfileSetup] Avatar upload failed:", uploadErr); }
                else {
                  // Use signed URL (1 year) — public URL returns 400 if bucket isn't public
                  const { data: signedData, error: signErr } = await supabase.storage.from("covers").createSignedUrl(path, 60 * 60 * 24 * 365);
                  const avatarUrl = signedData?.signedUrl;
                  if (avatarUrl) {
                    await supabase.from("profiles").update({ avatar_url: avatarUrl }).eq("id", uid);
                    state.settings.profileAvatarUrl = avatarUrl;
                  } else {
                    console.warn("[ProfileSetup] Signed URL failed:", signErr);
                  }
                }
              } catch (e) { console.warn("[ProfileSetup] Avatar upload failed:", e); }
            } else if (profile.avatarPreset) {
              // Save preset as avatar_url with special prefix
              const presetUrl = `preset:${profile.avatarPreset.id}`;
              await supabase.from("profiles").update({ avatar_url: presetUrl }).eq("id", uid);
              state.settings.profileAvatarUrl = presetUrl;
            } else {
              // No avatar chosen — auto-assign a random animal
              autoAssignedPreset = AVATAR_PRESETS[Math.floor(Math.random() * AVATAR_PRESETS.length)];
              const presetUrl = `preset:${autoAssignedPreset.id}`;
              await supabase.from("profiles").update({ avatar_url: presetUrl }).eq("id", uid);
              state.settings.profileAvatarUrl = presetUrl;
            }
          }
        } catch (e) {
          console.warn("[ProfileSetup] Failed to save:", e);
        }

        state.settings.displayName = displayName;
        saveState();
      } else {
        // Skipped setup entirely — still assign a random animal avatar
        try {
          const { data: userData } = await supabase.auth.getUser();
          const uid = userData?.user?.id;
          if (uid) {
            autoAssignedPreset = AVATAR_PRESETS[Math.floor(Math.random() * AVATAR_PRESETS.length)];
            const presetUrl = `preset:${autoAssignedPreset.id}`;
            await supabase.from("profiles").update({ avatar_url: presetUrl }).eq("id", uid);
            state.settings.profileAvatarUrl = presetUrl;
          }
        } catch (e) {
          console.warn("[ProfileSetup] Failed to auto-assign avatar:", e);
        }
      }

      // Show the salty reveal if we auto-assigned an avatar
      if (autoAssignedPreset) {
        await showAutoAvatarReveal(el, autoAssignedPreset);
      }

      localStorage.setItem("profileSetupDone", "1");
      el.classList.remove("open");
      setTimeout(() => { el.remove(); resolve(); }, 300);
    }

    // ── Salty reveal when user didn't pick a profile pic ──
    function showAutoAvatarReveal(container, preset) {
      return new Promise((revealResolve) => {
        const saltyLines = [
          `No profile pic? Bold move. Say hello to your new face.`,
          `You had the chance to pick your own pic… so we picked for you.`,
          `Too cool for a selfie? Fine. You're a ${preset.label} now.`,
          `We gave you a whole avatar picker and you said "nah." Meet your ${preset.label}.`,
          `Since you couldn't be bothered… congratulations, you're a ${preset.label}.`,
          `Profile pic? Never heard of her. Anyway, you're a ${preset.label} now.`,
        ];
        const line = saltyLines[Math.floor(Math.random() * saltyLines.length)];

        container.innerHTML = `
          <div class="profileSetupInner" style="text-align:center">
            <div class="psAutoAvatar" style="width:120px;height:120px;border-radius:50%;margin:0 auto 24px;overflow:hidden;animation:psAvatarBounceIn 0.5s cubic-bezier(0.34,1.56,0.64,1)">
              <div style="width:100%;height:100%;background:${preset.bg};display:flex;align-items:center;justify-content:center;font-size:56px;border-radius:inherit">${preset.emoji}</div>
            </div>
            <div class="profileSetupTitle" style="font-size:20px;line-height:1.4;max-width:280px;margin:0 auto 24px">${line}</div>
            <div class="profileSetupSub" style="margin-bottom:24px">You can always change it later in your profile.</div>
            <button class="profileSetupBtn" id="psAutoAvatarOk">Got it</button>
          </div>
        `;

        $("#psAutoAvatarOk")?.addEventListener("click", () => revealResolve());
      });
    }

    // Start at step 1
    renderStep1();
  });
}
