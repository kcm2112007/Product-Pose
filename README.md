# ProductForge backend

Real AI image-editing backend for ProductForge. Keeps the provider API key
server-side and turns the app's style/background/lighting/position choices
into one coherent generation instruction sent alongside the uploaded photo.

## Architecture

```
Frontend (productforge.html)
        │  multipart/form-data: image + settings
        ▼
POST /api/generate/image
        │  buildPrompt(settings) → instruction text
        ▼
providers/index.js  (selects provider by AI_PROVIDER)
        ▼
providers/openaiProvider.js
        │  client.images.edit({ model, image, prompt, size })
        ▼
OpenAI Images API (gpt-image-1) — uses the uploaded photo as the
actual reference image, not just a text description
        │
        ▼
lib/aspectRatio.js — center-crops to the exact requested ratio
        │
        ▼
{ image: "data:image/png;base64,...", prompt }
```

## Setup

```bash
cp .env.example .env
# edit .env and set AI_API_KEY to a real OpenAI API key
npm install
npm start
```

The server listens on `PORT` (default `8787`).

## Connecting the frontend

Open the published ProductForge page, open the **Backend connection**
panel (right-hand settings column), and paste your backend's public URL,
e.g. `https://your-backend.example.com`. The frontend checks
`GET /api/generate/status` and only enables real generation once it gets
back `{ configured: true }`. Until then it shows an honest
"AI generation is not configured" state rather than faking a result.

## Swapping providers

Implement a new file in `providers/` with the same two exports
(`generateProductImage`, error classes) as `openaiProvider.js`, register it
in `providers/index.js`, and set `AI_PROVIDER` to its key. Nothing else in
the server or frontend needs to change.

## Notes

- Uploaded images are only held in memory for the duration of a request —
  nothing is written to disk or persisted server-side.
- `MAX_UPLOAD_BYTES` and `RATE_LIMIT_PER_MINUTE` are basic cost/abuse
  controls; tune them for your traffic.
- The OpenAI Images edit endpoint (`gpt-image-1`) natively supports
  `1024x1024`, `1536x1024`, and `1024x1536`. Ratios that don't match one of
  those exactly (4:5, 3:4, 9:16) are requested at the closest native size
  and then center-cropped to the exact ratio — never stretched.
