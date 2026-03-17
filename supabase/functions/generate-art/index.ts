// Supabase Edge Function — Replicate API proxy for cover art generation
// Model: black-forest-labs/flux-schnell ($0.003/image)
//
// Auth: Uses the user's JWT (passed via Authorization header) to identify the user.
// Rate limit: 20 images per user per hour (tracked in the "art_rate_limits" table).
//
// Secrets (set via `supabase secrets set KEY=value`):
//   REPLICATE_API_TOKEN — your Replicate API token
//
// Deploy: supabase functions deploy generate-art --no-verify-jwt

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
  "Access-Control-Max-Age": "86400",
};

const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 3600000; // 1 hour

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  if (req.method !== "POST") {
    return jsonResponse(405, { detail: "Method not allowed" });
  }

  // --- Auth: verify user via their JWT ---
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonResponse(401, { detail: "Missing Authorization header" });
  }

  // Create a client using the SERVICE_ROLE key so we can do rate-limit writes,
  // but verify the user's token to identify them.
  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Create a client with the user's JWT to verify their identity
  const supabaseUser = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } }
  );

  const { data: { user }, error: authError } = await supabaseUser.auth.getUser();
  if (authError || !user) {
    return jsonResponse(401, { detail: "Invalid or expired token" });
  }

  // --- Rate limiting via art_rate_limits table ---
  const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();
  const { count } = await supabaseAdmin
    .from("art_rate_limits")
    .select("*", { count: "exact", head: true })
    .eq("user_id", user.id)
    .gte("created_at", windowStart);

  if ((count ?? 0) >= RATE_LIMIT_MAX) {
    return jsonResponse(429, {
      detail: "Rate limit exceeded — max 20 images per hour. Try again later.",
    });
  }

  // Record this request (use admin client to bypass RLS)
  await supabaseAdmin.from("art_rate_limits").insert({ user_id: user.id });

  // --- Proxy to Replicate ---
  const replicateToken = Deno.env.get("REPLICATE_API_TOKEN");
  if (!replicateToken) {
    return jsonResponse(500, { detail: "REPLICATE_API_TOKEN not configured" });
  }

  const body = await req.json();

  const res = await fetch(
    "https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${replicateToken}`,
        "Content-Type": "application/json",
        Prefer: "wait",
      },
      body: JSON.stringify(body),
    }
  );

  const data = await res.text();
  return new Response(data, {
    status: res.status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
});

function jsonResponse(status: number, data: Record<string, string>) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}
