import { escapeHtml } from "./dom.js";
import { getCoverBlobUrl, putCoverBlob, coverUrlCache } from "../audio/audioDB.js";

// ── Dependencies injected via initCoverArt() ──
let _supabaseFetchCoverBlob = null;
let _saveState = null;
let _render = null;

export function initCoverArt({ supabaseFetchCoverBlob, saveState, render }) {
  _supabaseFetchCoverBlob = supabaseFetchCoverBlob;
  _saveState = saveState;
  _render = render;
}

// ── Pure helpers ──

export function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

export function hashStr(str){
  str = String(str || "");
  let h = 2166136261;
  for (let i=0;i<str.length;i++){
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0);
}

export function makeRng(seed){
  let t = seed >>> 0;
  return () => {
    // xorshift32
    t ^= t << 13; t >>>= 0;
    t ^= t >> 17; t >>>= 0;
    t ^= t << 5;  t >>>= 0;
    return (t >>> 0) / 4294967296;
  };
}

// --- Cover caching + iOS "lite" mode ---
export const coverCache = new Map();
export const generatingArtSongs = new Set(); // song IDs currently generating art

export function isIOSDevice(){
  // iPadOS can report as MacIntel with touch points
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

// ── buildArtPrompt (pure — no side effects) ──

export function buildArtPrompt(song) {
  // Deterministic hash from song title + project to pick scene/style combos
  const seed = (song.title || "").length * 7 + (song.project || "").length * 13
    + (song.title || "").charCodeAt(0) * 31
    + ((song.title || "").charCodeAt(1) || 0) * 17;

  const scenes = [
    "vast mountain landscape at golden hour, dramatic peaks, alpine lake reflection, wildflowers in foreground, volumetric light rays through clouds",
    "deep ocean underwater scene, bioluminescent jellyfish, coral reef, shafts of sunlight through water, ethereal blue-green glow, floating particles",
    "abandoned industrial warehouse, shattered windows, overgrown vines reclaiming concrete, dramatic god-rays, dust particles in light beams",
    "dense enchanted forest, towering ancient trees, mystical fog, fireflies glowing, moss-covered roots, dappled moonlight filtering through canopy",
    "vast desert at twilight, sand dunes with wind ripples, lone joshua tree silhouette, purple-orange gradient sky, stars emerging",
    "futuristic neon cityscape from rooftop, holographic billboards, flying vehicles, rain-slicked streets far below, cyberpunk atmosphere, glowing windows",
    "frozen tundra landscape, northern lights aurora borealis, ice formations, starfield sky, teal and purple light dancing, snow-covered terrain",
    "lush tropical coastline at sunset, palm trees swaying, turquoise waves crashing, dramatic cloud formations, golden hour warmth, volcanic island in distance",
    "cosmic nebula scene, swirling galaxies, colorful interstellar gas clouds, distant stars, asteroid field, deep space, celestial wonder",
    "overgrown ancient temple ruins, jungle reclaiming stone architecture, shafts of green-tinted light, carved stone faces, hanging vines, mystical atmosphere",
    "stormy seascape, towering waves, lightning illuminating dark clouds, lighthouse beam cutting through rain, dramatic ocean spray, powerful nature",
    "cherry blossom garden at night, lantern-lit pathway, pink petals falling, koi pond reflection, misty atmosphere, Japanese aesthetic",
    "volcanic landscape, molten lava flows, dark rock formations, fiery orange glow against dark sky, smoke and ash, raw elemental power",
    "abstract fluid art, swirling metallic paint, iridescent colors blending, macro photography feel, glossy surface tension, mesmerizing patterns",
    "sunflower field stretching to horizon, dramatic cumulus clouds, warm afternoon light, single weathered barn, painted sky, rural serenity",
    "underground crystal cavern, massive amethyst and quartz formations, underground river, bioluminescent fungi, prismatic light reflections",
  ];

  const styles = [
    "cinematic photography",
    "oil painting, thick brushstrokes",
    "moody atmospheric digital art",
    "watercolor illustration, soft edges",
    "retro analog film grain aesthetic",
    "hyper-detailed digital matte painting",
    "minimalist graphic art, bold shapes",
    "dreamlike surrealist composition",
  ];

  const palettes = [
    "warm amber and deep crimson tones",
    "cool blues and silver moonlight",
    "vibrant teal and electric magenta",
    "muted earth tones, olive and rust",
    "pastel pink and lavender haze",
    "deep indigo and gold accents",
    "emerald green and copper highlights",
    "monochrome with one vivid accent color",
  ];

  const scene = scenes[seed % scenes.length];
  const style = styles[(seed * 3 + 5) % styles.length];
  const palette = palettes[(seed * 7 + 11) % palettes.length];

  return [
    "album cover art",
    song.genre ? `${song.genre} music mood` : null,
    scene,
    style,
    palette,
    "no text, no words, no letters, no numbers, no typography, no writing, no logos, no symbols, no watermarks, textless, wordless, purely visual composition, square format"
  ].filter(Boolean).join(", ");
}

// ── Main cover SVG generator ──

export function coverSvg(song, { lite = false } = {}) {
  const forceLite = lite || isIOSDevice();
  const key = `${song.id}|${song.title}|${song.project}|${song.genre}|${song.coverImageUrl || ""}|${song.userCoverImageUrl || ""}|${song.coverSource || "ai"}|${forceLite ? "lite" : "full"}`;

  if (generatingArtSongs.has(song.id)) {
    return `<div style="width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;background:linear-gradient(135deg,#1a1a2e,#16213e);border-radius:inherit;color:#888;font-size:13px;gap:8px">
      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#666" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="animation:spin 2s linear infinite">
        <path d="M12 2a10 10 0 0 1 10 10" /><style>@keyframes spin{to{transform:rotate(360deg)}}</style>
      </svg>
      <span style="opacity:.6">Generating…</span>
    </div>`;
  }

  if (coverCache.has(key)) return coverCache.get(key);

  // User-uploaded cover takes priority when coverSource is "user"
  if (song.coverSource === "user" && song.userCoverImageUrl) {
    const errHandler = song.userCoverPath
      ? ` onerror="this.onerror=null;window._refreshUserCoverFromCloud&&window._refreshUserCoverFromCloud('${escapeHtml(song.id)}','${escapeHtml(song.userCoverPath)}',this)"`
      : ` onerror="this.onerror=null;window._clearBrokenUserCover&&window._clearBrokenUserCover('${escapeHtml(song.id)}',this)"`;

    const img = `<img src="${escapeHtml(song.userCoverImageUrl)}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;display:block" decoding="sync" alt=""${errHandler}>`;
    coverCache.set(key, img);
    return img;
  }

  // Resolve user cover from cache/cloud if path exists but URL doesn't
  if (song.coverSource === "user" && !song.userCoverImageUrl && !song._userCoverResolving) {
    song._userCoverResolving = true;
    (async () => {
      const localKey = `user_${song.id}_cover.jpg`;
      let url = song.userCoverPath ? await getCoverBlobUrl(song.userCoverPath) : null;
      if (!url) url = await getCoverBlobUrl(localKey);
      if (!url && song.userCoverPath && _supabaseFetchCoverBlob) {
        const blob = await _supabaseFetchCoverBlob(song.userCoverPath).catch(() => null);
        if (blob) {
          await putCoverBlob(song.userCoverPath, blob);
          url = URL.createObjectURL(blob);
          coverUrlCache.set(song.userCoverPath, url);
        }
      }
      song._userCoverResolving = false;
      if (url) {
        song.userCoverImageUrl = url;
        coverCache.clear();
        if (_saveState) _saveState();
        if (_render) _render();
      }
    })().catch(() => { song._userCoverResolving = false; });
  }

  if (song.coverImageUrl) {
    const errHandler = song.coverPath
      ? ` onerror="this.onerror=null;window._refreshCoverFromCloud&&window._refreshCoverFromCloud('${escapeHtml(song.id)}','${escapeHtml(song.coverPath)}',this)"`
      : ` onerror="this.onerror=null;window._clearBrokenCover&&window._clearBrokenCover('${escapeHtml(song.id)}',this)"`;

    const img = `<img src="${escapeHtml(song.coverImageUrl)}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;display:block" decoding="sync" alt=""${errHandler}>`;
    coverCache.set(key, img);
    return img;
  }

  // coverImageUrl is missing but cloud path exists — resolve from IDB cache or Supabase
  if (song.coverPath && !song._coverResolving) {
    song._coverResolving = true;
    (async () => {
      let url = await getCoverBlobUrl(song.coverPath);
      if (!url && _supabaseFetchCoverBlob) {
        const blob = await _supabaseFetchCoverBlob(song.coverPath);
        if (blob) {
          await putCoverBlob(song.coverPath, blob);
          url = URL.createObjectURL(blob);
          coverUrlCache.set(song.coverPath, url);
        }
      }
      song._coverResolving = false;
      if (url) {
        song.coverImageUrl = url;
        coverCache.clear();
        if (_saveState) _saveState();
        if (_render) _render();
      }
    })().catch(() => { song._coverResolving = false; });
  }

  const seed = hashStr(`${song.id}|${song.title}|${song.project}|${song.genre}`);
  const r = makeRng(seed);
  const u = (seed >>> 0).toString(36); // unique prefix for SVG IDs

  const h1 = Math.floor(r()*360);
  const h2 = (h1 + 90 + Math.floor(r()*90)) % 360;
  const h3 = (h2 + 90 + Math.floor(r()*90)) % 360;

  const c1 = `hsl(${h1} 95% 60%)`;
  const c2 = `hsl(${h2} 95% 58%)`;
  const c3 = `hsl(${h3} 95% 62%)`;

  const b = Array.from({length: 3}).map(() => ({
    x: Math.floor(r()*120),
    y: Math.floor(r()*120),
    rad: Math.floor(40 + r()*55),
    col: [c1,c2,c3][Math.floor(r()*3)]
  }));

  const sx1 = Math.floor(r()*40);
  const sy1 = Math.floor(30 + r()*60);
  const sx2 = Math.floor(90 + r()*40);
  const sy2 = Math.floor(20 + r()*80);

  // LITE: no turbulence/grain, no SVG filter stack (huge iOS win)
  const svg = forceLite ? `
  <svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="g${u}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${c1}" stop-opacity=".95"/>
        <stop offset=".55" stop-color="${c2}" stop-opacity=".85"/>
        <stop offset="1" stop-color="${c3}" stop-opacity=".9"/>
      </linearGradient>
      <radialGradient id="v${u}" cx="50%" cy="45%" r="70%">
        <stop offset="55%" stop-color="rgba(0,0,0,0)"/>
        <stop offset="100%" stop-color="rgba(0,0,0,.28)"/>
      </radialGradient>
    </defs>

    <rect width="120" height="120" fill="url(#g${u})"/>
    ${b.map(x => `<circle cx="${x.x}" cy="${x.y}" r="${x.rad}" fill="${x.col}" opacity=".22"/>`).join("")}

    <path d="M ${sx1} ${sy1} C ${sx1+35} ${sy1-30}, ${sx2-35} ${sy2+30}, ${sx2} ${sy2}"
      stroke="rgba(255,255,255,.55)" stroke-width="5" stroke-linecap="round" opacity=".18"/>

    <rect width="120" height="120" fill="url(#v${u})"/>
  </svg>` : `
  <svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="g${u}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${c1}" stop-opacity=".95"/>
        <stop offset=".55" stop-color="${c2}" stop-opacity=".85"/>
        <stop offset="1" stop-color="${c3}" stop-opacity=".9"/>
      </linearGradient>

      <filter id="b${u}">
        <feGaussianBlur stdDeviation="12" />
      </filter>

      <filter id="n${u}">
        <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" />
        <feColorMatrix type="matrix" values="
          1 0 0 0 0
          0 1 0 0 0
          0 0 1 0 0
          0 0 0 .12 0"/>
      </filter>

      <filter id="w${u}">
        <feGaussianBlur stdDeviation="3" result="b"/>
        <feMerge>
          <feMergeNode in="b"/>
          <feMergeNode in="SourceGraphic"/>
        </feMerge>
      </filter>

      <radialGradient id="v${u}" cx="50%" cy="45%" r="70%">
        <stop offset="55%" stop-color="rgba(0,0,0,0)"/>
        <stop offset="100%" stop-color="rgba(0,0,0,.35)"/>
      </radialGradient>
    </defs>

    <rect width="120" height="120" fill="url(#g${u})"/>

    <g filter="url(#b${u})" opacity=".9">
      ${b.map(x => `<circle cx="${x.x}" cy="${x.y}" r="${x.rad}" fill="${x.col}" opacity=".55"/>`).join("")}
    </g>

    <path d="M ${sx1} ${sy1} C ${sx1+35} ${sy1-30}, ${sx2-35} ${sy2+30}, ${sx2} ${sy2}"
      stroke="rgba(255,255,255,.65)" stroke-width="6" stroke-linecap="round" opacity=".22" filter="url(#w${u})"/>

    <rect width="120" height="120" fill="url(#v${u})"/>
    <rect width="120" height="120" filter="url(#n${u})" opacity=".55"/>
  </svg>`;

  coverCache.set(key, svg);
  return svg;
}
