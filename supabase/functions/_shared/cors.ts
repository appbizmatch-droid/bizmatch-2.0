// Exact port of backend/src/app.js's origin-matching logic — there's no
// Express middleware chain here, so this is called manually per-function.
// Primary allow-list is FRONTEND_URL (see below); this is just a fallback
// for this project's own Netlify/Vercel sites so deploy previews work
// without needing every preview URL added to FRONTEND_URL by hand.
const NETLIFY_SITE = "matchappbiz.netlify.app";
const VERCEL_PROJECT_PREFIX = "bizmatch-2-0-";
const VERCEL_PROD_SITE = "bizmatch-2-0.vercel.app";
const allowedOrigins = (Deno.env.get("FRONTEND_URL") ?? "")
  .split(",").map((o) => o.trim()).filter(Boolean);
const isDev = Deno.env.get("ENVIRONMENT") === "development";

export function corsHeaders(req: Request): Headers {
  const origin = req.headers.get("origin");
  const headers = new Headers({
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
    "Access-Control-Allow-Credentials": "true",
  });

  if (isDev) {
    headers.set("Access-Control-Allow-Origin", origin ?? "*");
    return headers;
  }
  if (!origin) {
    headers.set("Access-Control-Allow-Origin", "*");
    return headers;
  }
  const isNetlify = origin === `https://${NETLIFY_SITE}` || origin.endsWith(`--${NETLIFY_SITE}`);
  const isVercel = origin === `https://${VERCEL_PROD_SITE}` ||
    (origin.startsWith(`https://${VERCEL_PROJECT_PREFIX}`) && origin.endsWith(".vercel.app"));
  if (isNetlify || isVercel || allowedOrigins.includes(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
  }
  return headers;
}
