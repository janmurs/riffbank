// Serverless function — proxies Replicate so the API key stays server-side
// Called from the browser as: POST /api/generate-image
// Body: { prompt: string, model?: string }
// Returns the completed Replicate prediction object (output is array of image URLs)

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { prompt, model = "black-forest-labs/flux-schnell" } = req.body || {};

  if (!prompt || typeof prompt !== "string") {
    return res.status(400).json({ error: "prompt is required" });
  }

  const token = process.env.REPLICATE_API_TOKEN;
  if (!token || token.includes("PASTE_YOUR_FULL_TOKEN")) {
    return res.status(500).json({ error: "REPLICATE_API_TOKEN not configured in .env.local" });
  }

  try {
    // Use Prefer: wait=60 so Replicate waits for completion before returning.
    // flux-schnell finishes in ~1–3 seconds — well within the window.
    const response = await fetch(
      `https://api.replicate.com/v1/models/${model}/predictions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Prefer: "wait=60",
        },
        body: JSON.stringify({ input: { prompt } }),
      }
    );

    let prediction = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: prediction });
    }

    // If sync wait didn't complete it, poll until done (max ~30s)
    if (prediction.status !== "succeeded" && prediction.status !== "failed" && prediction.urls?.get) {
      for (let i = 0; i < 15; i++) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const poll = await fetch(prediction.urls.get, {
          headers: { Authorization: `Bearer ${token}` },
        });
        prediction = await poll.json();
        if (prediction.status === "succeeded" || prediction.status === "failed" || prediction.status === "canceled") break;
      }
    }

    return res.status(prediction.status === "succeeded" ? 200 : 500).json(prediction);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
