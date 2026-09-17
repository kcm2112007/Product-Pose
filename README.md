# ProductForge

AI Product Image Generator — turn a product photo into store-ready visuals using real AI image generation.

## Features

- Upload a real product photo (PNG/JPG/WEBP)
- Choose a style, background, lighting, composition and aspect ratio
- Optional custom prompt and a saved Brand Kit (name, colors, tone)
- Real AI generation via Cloudflare Workers AI — the uploaded product is sent as an
  image reference so its shape, color, packaging and logo are preserved
- Before/after comparison slider, download, 4 variations, and a 5-image campaign mode
- Local generation history (last 20), saved on-device — no account required

This is a genuine AI application: there is no placeholder/simulated generation path.
If the AI backend fails or the free daily allowance is exhausted, the app shows a
clear message instead of faking a result.

## Architecture (zero cost)

```
GitHub repository (source)
        │
        ▼
Cloudflare Pages ──── serves index.html (static, no build step)
        │  fetch("/api/generate")
        ▼
Cloudflare Worker ──── worker/worker.js
        │  env.AI.run(...)
        ▼
Cloudflare Workers AI ──── @cf/black-forest-labs/flux-2-klein-4b
```

- **Frontend**: a single static `index.html` (vanilla HTML/CSS/JS, no build step,
  no framework). Deploys directly to Cloudflare Pages free tier.
- **Backend**: a Cloudflare Worker (`worker/worker.js`) on the Workers free plan.
  It receives the uploaded photo + settings, builds a structured prompt, and calls
  Workers AI using the native `AI` binding — no API key needed.
- **AI model**: [`@cf/black-forest-labs/flux-2-klein-4b`](https://developers.cloudflare.com/workers-ai/models/flux-2-klein-4b/),
  which unifies text-to-image and image-editing/multi-reference generation in one
  fast, distilled model — a good fit for a free-tier budget since its fixed 4-step
  inference uses far fewer Neurons per image than larger models like `flux-2-dev`.
  The uploaded product photo is sent as `input_image_0` so the model uses it as
  the actual reference, not just a text description.

## Free-tier limits (verify before relying on these)

Cloudflare's free Workers AI allocation and model catalog can change. Before
depending on any specific number, check:

- Models: https://developers.cloudflare.com/workers-ai/models/
- Pricing/limits: https://developers.cloudflare.com/workers-ai/platform/pricing/

As of this writing, Workers AI free accounts get a shared daily Neuron allowance
that resets at 00:00 UTC. `flux-2-klein-4b`'s fixed 4-step inference is one of the
cheaper image options in Neurons, which is why it's the default model here.

**Reference-image constraint**: `flux-2-klein-4b` requires each input reference
image to be 512×512 or smaller. The frontend resizes the uploaded photo
client-side (canvas) before sending it, so this is handled automatically.

## Repository layout

```
index.html            The entire frontend (deploy this to Cloudflare Pages)
worker/worker.js       The Cloudflare Worker backend
worker/wrangler.toml    Worker configuration (AI binding, CORS origin)
```

## Local development

You don't need a computer with a build toolchain — this is plain static HTML/JS —
but to run the *Worker* locally you'll need a machine (or Cloudflare's web-based
Worker editor) with:

1. Clone this repository.
2. Install Wrangler: `npm install -g wrangler` (only needed if working from a
   computer; on Cloudflare's dashboard you can also paste `worker.js` directly
   into the web-based Worker editor and skip Wrangler entirely).
3. `wrangler login` to authenticate with your Cloudflare account.
4. From `worker/`, run `wrangler dev` to test locally, or `wrangler deploy` to
   publish.
5. Open `index.html` (e.g. via Cloudflare Pages, or any static file server) and
   set the **Backend** field in the Studio sidebar to your deployed Worker URL
   (e.g. `https://productforge-api.<your-subdomain>.workers.dev`). This is saved
   in the browser so you only need to set it once per device.
6. Upload a test image and click **Generate Image**.

## Deploying on Cloudflare (no computer required)

### 1. Frontend — Cloudflare Pages

1. Push this repository to GitHub (the mobile GitHub web UI works fine for this
   — upload/commit `index.html` at the repo root).
2. In the Cloudflare dashboard: **Workers & Pages → Create → Pages → Connect to Git**.
3. Select this repository. Framework preset: **None**. Build command: none.
   Output directory: `/` (the repo root, since `index.html` lives there).
4. Deploy. Every push to your configured branch redeploys automatically.

### 2. Backend — Cloudflare Worker

1. In the Cloudflare dashboard: **Workers & Pages → Create → Worker**.
2. Paste the contents of `worker/worker.js` into the editor (or connect this repo
   and set the Worker's entry point to `worker/worker.js`).
3. Under **Settings → Bindings**, add a **Workers AI** binding named `AI`
   (this matches `env.AI` in the code — no API key required).
4. Under **Settings → Variables**, set `ALLOWED_ORIGIN` to your Cloudflare Pages
   URL (e.g. `https://productforge.pages.dev`) once you know it, so the Worker
   only accepts requests from your real frontend.
5. Deploy. Copy the Worker's `*.workers.dev` URL into the Studio's **Backend**
   field on your deployed frontend.

### GitHub Actions (optional)

Automated deploys aren't required — Cloudflare Pages' Git integration handles the
frontend, and the Worker can be deployed by hand from the dashboard or Wrangler.
If you do add a GitHub Actions workflow for `wrangler deploy`, store
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as **GitHub Secrets** —
never commit them to the repository.

## Security notes

- No AI credentials live in the frontend; the Worker uses Cloudflare's native
  `AI` binding, which requires no API key at all.
- `.gitignore` excludes `.env` and other local secret files.
- The Worker's CORS policy defaults to `*` for easy first setup — tighten
  `ALLOWED_ORIGIN` in `wrangler.toml` (or the dashboard) to your real Pages URL
  before treating this as production.

## Known limitations

- **Rate limiting** in `worker.js` is a best-effort, in-memory per-IP counter.
  It resets whenever the Worker's isolate recycles, so it is a soft speed bump
  against accidental abuse, not a hard guarantee. For stronger protection at
  scale, replace it with a
  [Durable Object](https://developers.cloudflare.com/durable-objects/) or
  Cloudflare's Rate Limiting binding.
- **Usage indicator**: the Studio shows "Free AI capacity applies" rather than an
  exact remaining count, because Workers AI doesn't expose reliable per-request
  quota data to the Worker itself. If Cloudflare adds this, `/api/status` in
  `worker.js` is the place to surface it.
- **History** is stored in `localStorage` on the device/browser used, capped at
  20 entries — it is not synced across devices and can be lost if browser data
  is cleared.
- If Cloudflare changes or retires `flux-2-klein-4b`, update `MODEL_ID` in
  `worker.js` after checking the current
  [model catalog](https://developers.cloudflare.com/workers-ai/models/) —
  don't assume the model name or its multipart field names are unchanged.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| "Set your Worker URL below to enable generation." | Backend field in the Studio sidebar is empty. |
| "Backend unreachable — check your Worker URL." | Worker isn't deployed, URL is wrong, or CORS is blocking the request. |
| "Today's free AI generation limit has been reached." | Daily Neuron allocation exhausted — resets at 00:00 UTC. |
| "AI generation is temporarily unavailable." | Workers AI returned an error unrelated to quota — check the Worker's logs. |
| Generated image doesn't look like the uploaded product | The reference image may be too large before resizing, or the model treated the request as text-to-image — check the browser console/network tab for the actual request sent. |
