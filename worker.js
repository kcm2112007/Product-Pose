/**
 * ProductForge — Cloudflare Worker backend
 * ------------------------------------------------------------
 * Free-tier architecture:
 *   Cloudflare Pages (frontend) -> this Worker -> Workers AI (free allocation)
 *
 * Model used: @cf/black-forest-labs/flux-2-klein-4b
 *   - Unifies text-to-image + image editing + multi-reference in one model.
 *   - Fixed 4-step inference (fast + cheap in Neurons -> more free generations/day).
 *   - Accepts up to 4 reference images, each must be <= 512x512, via
 *     multipart form fields named input_image_0 .. input_image_3.
 *   - Output: { image: "<base64 PNG>" }
 *   Docs: https://developers.cloudflare.com/workers-ai/models/flux-2-klein-4b/
 *
 * This is a genuine AI call — there is no fake/placeholder generation path.
 * If Workers AI errors or the free daily Neuron allocation is exhausted,
 * this Worker returns a clear error; it never fabricates a result.
 * ------------------------------------------------------------
 */

const MODEL_ID = "@cf/black-forest-labs/flux-2-klein-4b";

// Max size for the incoming base64 product photo (frontend resizes to <=512x512
// before sending, so this is a generous safety ceiling against abuse).
const MAX_IMAGE_BYTES = 3 * 1024 * 1024; // 3 MB
const MAX_CUSTOM_PROMPT_LEN = 400;

// Best-effort in-memory rate limiting. This resets whenever the Worker
// isolate recycles, so it is a soft speed bump, not a hard guarantee.
// For real per-IP guarantees at scale, swap this for a Durable Object
// or Cloudflare's Rate Limiting binding (see README).
const requestLog = new Map(); // ip -> array of timestamps (ms)
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 6;

function corsHeaders(env, request) {
  const origin = request.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGIN || "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const allowOrigin =
    allowed.includes("*") || allowed.length === 0
      ? "*"
      : allowed.includes(origin)
      ? origin
      : allowed[0];

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (requestLog.get(ip) || []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS
  );
  timestamps.push(now);
  requestLog.set(ip, timestamps);
  return timestamps.length > RATE_LIMIT_MAX_REQUESTS;
}

// ---- Prompt builder --------------------------------------------------

const STYLE_PROMPTS = {
  "clean-studio": "clean white studio background, soft even lighting",
  luxury: "luxury studio scene with dark marble surface, dramatic accent lighting",
  minimal: "minimal composition, generous negative space, understated",
  premium: "premium commercial product photography, refined and polished",
  editorial: "editorial fashion-magazine style product photography",
  "modern-home": "modern home interior setting, warm natural context",
  kitchen: "styled kitchen countertop scene, everyday lifestyle context",
  office: "contemporary office desk scene",
  outdoor: "natural outdoor setting, soft daylight",
  "natural-lifestyle": "candid lifestyle scene, natural use context",
  "sale-creative": "bold sale/promotional creative, high energy",
  "social-media": "square social-media-ready composition, vibrant and eye-catching",
  "hero-banner": "wide hero banner composition for a website header",
  "premium-advertisement": "premium advertisement layout with room for headline text",
  seasonal: "seasonal campaign styling",
};

const BACKGROUND_PROMPTS = {
  "pure-white": "pure white seamless background",
  "soft-grey": "soft neutral grey backdrop",
  marble: "polished marble surface backdrop",
  concrete: "textured concrete surface backdrop",
  wood: "natural wood surface backdrop",
  "luxury-interior": "luxury interior backdrop",
  "modern-studio": "modern photography studio backdrop",
  nature: "natural outdoor greenery backdrop",
  kitchen: "kitchen counter backdrop",
  office: "office desk backdrop",
};

const LIGHTING_PROMPTS = {
  softbox: "soft diffused softbox lighting",
  natural: "natural window light",
  dramatic: "dramatic directional lighting with deep shadows",
  "golden-hour": "warm golden-hour lighting",
  "high-key": "bright high-key lighting, minimal shadow",
  "low-key": "moody low-key lighting, strong contrast",
  studio: "balanced studio lighting setup",
  cinematic: "cinematic lighting with controlled highlights",
};

const POSITION_PROMPTS = {
  center: "product centered in frame",
  left: "product positioned to the left third of the frame",
  right: "product positioned to the right third of the frame",
  "close-up": "close-up hero shot of the product",
  wide: "wide scene with the product in context",
  hero: "dramatic hero angle on the product",
};

function pick(map, key, fallback) {
  return map[key] || fallback || key || "";
}

function buildPrompt(settings) {
  const style = pick(STYLE_PROMPTS, settings.style, settings.style);
  const background =
    settings.background === "custom" && settings.customBackground
      ? settings.customBackground
      : pick(BACKGROUND_PROMPTS, settings.background, settings.background);
  const lighting = pick(LIGHTING_PROMPTS, settings.lighting, settings.lighting);
  const position = pick(POSITION_PROMPTS, settings.position, settings.position);

  const parts = [
    "Use the product shown in image 0 as the exact product reference.",
    "Preserve the product's identity, shape, proportions, color, packaging, label placement, logo and visible text exactly as in image 0.",
    "Do not redesign, replace, duplicate, or add extra products.",
    `Create a professional commercial e-commerce product photograph: ${style}.`,
    `Background: ${background}.`,
    `Lighting: ${lighting}.`,
    `Composition: ${position}.`,
  ];

  if (settings.customPrompt) {
    parts.push(String(settings.customPrompt).slice(0, MAX_CUSTOM_PROMPT_LEN));
  }

  if (settings.brand && (settings.brand.name || settings.brand.tone)) {
    const brandBits = [];
    if (settings.brand.name) brandBits.push(`brand: ${settings.brand.name}`);
    if (settings.brand.tone) brandBits.push(`brand tone: ${settings.brand.tone}`);
    if (settings.brand.primaryColor)
      brandBits.push(`primary brand color accent: ${settings.brand.primaryColor}`);
    parts.push(`Incorporate subtle ${brandBits.join(", ")} where appropriate, without altering the product itself.`);
  }

  return parts.join(" ");
}

// ---- Aspect ratio -> generation dimensions ---------------------------

const ASPECT_DIMENSIONS = {
  "1:1": [1024, 1024],
  "4:5": [896, 1120],
  "3:4": [896, 1192],
  "16:9": [1344, 752],
  "9:16": [752, 1344],
};

function dimensionsFor(aspectRatio) {
  return ASPECT_DIMENSIONS[aspectRatio] || ASPECT_DIMENSIONS["1:1"];
}

// ---- Base64 helpers ----------------------------------------------------

function base64ToBytes(base64) {
  const clean = base64.includes(",") ? base64.split(",")[1] : base64;
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---- Main handler -------------------------------------------------------

async function handleGenerate(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return { error: "Invalid request body.", status: 400 };
  }

  const { image, mimeType, aspectRatio } = body;

  if (!image || typeof image !== "string") {
    return { error: "Please upload a product image first.", status: 400 };
  }

  if (!["image/png", "image/jpeg", "image/jpg", "image/webp"].includes(mimeType)) {
    return { error: "Unsupported image format.", status: 400 };
  }

  let imageBytes;
  try {
    imageBytes = base64ToBytes(image);
  } catch {
    return { error: "Could not read the uploaded image.", status: 400 };
  }

  if (imageBytes.byteLength > MAX_IMAGE_BYTES) {
    return { error: "Image is too large.", status: 413 };
  }

  const [width, height] = dimensionsFor(aspectRatio);
  const prompt = buildPrompt(body);

  const form = new FormData();
  form.append("prompt", prompt);
  form.append("width", String(width));
  form.append("height", String(height));
  form.append(
    "input_image_0",
    new Blob([imageBytes], { type: mimeType }),
    "product.png"
  );

  // FormData doesn't expose its serialized body/boundary directly, so we
  // route it through a Response to get a properly-framed multipart body,
  // exactly as Cloudflare's own Workers AI docs show for this model.
  const formResponse = new Response(form);
  const multipartBody = formResponse.body;
  const contentType = formResponse.headers.get("content-type");

  let result;
  try {
    result = await env.AI.run(MODEL_ID, {
      multipart: { body: multipartBody, contentType },
    });
  } catch (err) {
    const message = String(err && err.message ? err.message : err);
    if (/quota|limit|neuron/i.test(message)) {
      return {
        error:
          "Today's free AI generation limit has been reached. Please try again after the free allowance resets.",
        status: 429,
      };
    }
    return { error: "AI generation is temporarily unavailable. Please try again.", status: 502 };
  }

  if (!result || !result.image) {
    return { error: "Generation failed. Please try again.", status: 502 };
  }

  return {
    data: {
      image: `data:image/png;base64,${result.image}`,
      prompt,
      width,
      height,
    },
    status: 200,
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = corsHeaders(env, request);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers });
    }

    if (url.pathname === "/api/status" && request.method === "GET") {
      return json({ status: "available" }, 200, headers);
    }

    if (url.pathname === "/api/generate" && request.method === "POST") {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      if (isRateLimited(ip)) {
        return json(
          { error: "Too many requests. Please wait a moment and try again." },
          429,
          headers
        );
      }

      const result = await handleGenerate(request, env);
      if (result.error) {
        return json({ error: result.error }, result.status, headers);
      }
      return json(result.data, result.status, headers);
    }

    return json({ error: "Not found." }, 404, headers);
  },
};
