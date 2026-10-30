// v2rr-radar: a tiny read-only proxy for ONE Cloudflare Radar endpoint, so the API token never ships inside the APK.
// Only GET /radar/annotations/outages is forwarded, with a fixed list of query parameters. It is not an open proxy.
// Secret needed: CF_RADAR_TOKEN (Cloudflare API token with Account > Radar > Read).

const UPSTREAM = "https://api.cloudflare.com/client/v4/radar/annotations/outages";
const BUCKET_MS = 5 * 60 * 1000;     // dates are rounded to 5 minutes so identical requests share one cached answer
const TTL_MS = 5 * 60 * 1000;
const memo = new Map();              // per-isolate cache; best effort only

const reply = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });
const fail = (status, message) => reply({ success: false, errors: [{ message }], result: null }, status);

// Builds the upstream query from the app's query, or returns an error string. Exported for tests.
export function buildQuery(params) {
  const out = new URLSearchParams();
  const loc = params.get("location") ?? "IR";
  if (!/^[A-Za-z]{2}$/.test(loc)) return "bad location";
  out.set("location", loc.toUpperCase());
  const limit = Number(params.get("limit") ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return "bad limit";
  out.set("limit", String(limit));
  out.set("format", "JSON");
  for (const k of ["dateStart", "dateEnd"]) {
    const v = params.get(k);
    if (v === null) continue;
    const t = Date.parse(v);
    if (!Number.isFinite(t)) return "bad " + k;
    out.set(k, new Date(Math.floor(t / BUCKET_MS) * BUCKET_MS).toISOString().replace(/\.\d{3}Z$/, "Z"));
  }
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/") return new Response("v2rr-radar ok\n", { headers: { "content-type": "text/plain" } });
    if (url.pathname !== "/radar/annotations/outages") return fail(404, "not found");
    if (request.method !== "GET") return fail(405, "method not allowed");
    if (!env.CF_RADAR_TOKEN) return fail(500, "proxy token is not configured");

    const q = buildQuery(url.searchParams);
    if (typeof q === "string") return fail(400, q);
    const key = q.toString();

    const hit = memo.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return reply(hit.body, 200, { "x-proxy-cache": "hit" });

    let r;
    try {
      r = await fetch(`${UPSTREAM}?${key}`, { headers: { Authorization: `Bearer ${env.CF_RADAR_TOKEN}`, Accept: "application/json" } });
    } catch {
      return fail(502, "upstream unreachable");
    }
    let body;
    try { body = await r.json(); } catch { return fail(502, "upstream returned a non-JSON answer"); }
    if (r.ok && body && body.success) {
      if (memo.size > 50) memo.clear();
      memo.set(key, { at: Date.now(), body });
    }
    return reply(body, r.status, r.headers.get("retry-after") ? { "retry-after": r.headers.get("retry-after") } : {});
  },
}; 
