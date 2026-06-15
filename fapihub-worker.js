/**
 * IBI fapihub CORS Proxy — Cloudflare Worker
 * ------------------------------------------------------------------
 * Why this exists:
 *   fapihub's API (https://fapihub.com/v2/rembg/) does NOT allow the custom
 *   "ApiKey" header in its CORS preflight, so a browser can never call it
 *   directly. This Worker sits in the middle: the browser POSTs the image to
 *   the Worker (a simple CORS request, no preflight), and the Worker forwards
 *   it to fapihub server-to-server, where CORS rules do not apply. The PNG is
 *   returned to the browser with permissive CORS headers.
 *
 * How the browser calls it (already wired into IBI BgRemoverD v4.9):
 *   POST <worker-url>
 *   body = FormData { image: <file>, model: "falcon", apikey: "<your key>" }
 *   (no custom headers — that's what avoids the preflight)
 *
 * Deploy (2 minutes, free):
 *   1. Go to https://dash.cloudflare.com  →  Workers & Pages  →  Create  →  Create Worker
 *   2. Name it e.g. "ibi-fapihub-proxy", click Deploy.
 *   3. Click "Edit code", delete the sample, paste THIS whole file, click Deploy.
 *   4. Copy the Worker URL (e.g. https://ibi-fapihub-proxy.<your-subdomain>.workers.dev).
 *   5. Paste that URL into the app's "Cloudflare Worker proxy URL" field and Save.
 *
 * Optional (more secure): instead of sending the key from the browser, set it
 *   as a Worker Variable named FAPIHUB_KEY (Settings → Variables) and the Worker
 *   will use it when the request body has no "apikey". The browser may then send
 *   an empty key. Either way works.
 */

const FAPIHUB_ENDPOINT = "https://fapihub.com/v2/rembg/";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request, env) {
    // Preflight (shouldn't normally fire for a simple request, but handle it anyway)
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== "POST") {
      return jsonError("Method not allowed. Use POST with multipart form data.", 405);
    }

    let inForm;
    try {
      inForm = await request.formData();
    } catch (e) {
      return jsonError("Request body must be multipart/form-data.", 400);
    }

    const image = inForm.get("image");
    const model = inForm.get("model") || "falcon";
    const apiKey = (inForm.get("apikey") || "").toString().trim() || (env && env.FAPIHUB_KEY) || "";

    if (!image || typeof image === "string") {
      return jsonError("No image file provided in the 'image' field.", 400);
    }
    if (!apiKey) {
      return jsonError("No API key provided (send 'apikey' in the form or set FAPIHUB_KEY variable).", 401);
    }

    // Rebuild the request the way fapihub expects: field 'image', field 'model',
    // and the key in the 'ApiKey' HEADER (server-to-server, so no CORS issue).
    const outForm = new FormData();
    outForm.append("image", image, image.name || "image.png");
    outForm.append("model", model);

    let upstream;
    try {
      upstream = await fetch(FAPIHUB_ENDPOINT, {
        method: "POST",
        headers: { "ApiKey": apiKey },
        body: outForm,
      });
    } catch (e) {
      return jsonError("Failed to reach fapihub: " + (e && e.message ? e.message : e), 502);
    }

    // Pass fapihub's response straight back, preserving its status and content type,
    // but with our permissive CORS headers so the browser accepts it.
    const headers = new Headers(CORS_HEADERS);
    const contentType = upstream.headers.get("Content-Type") || "application/octet-stream";
    headers.set("Content-Type", contentType);
    headers.set("Cache-Control", "no-store");

    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
