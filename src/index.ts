export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  BASE_URL: string;
}

const SLUG_RE = /^[a-zA-Z0-9_-]{3,64}$/;
const RESERVED = new Set(["api", "admin", "assets", "static", "health", "login", "signup"]);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function randomSlug(length = 6): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  for (const b of bytes) out += chars[b % chars.length];
  return out;
}

function deviceFromUA(ua: string): string {
  if (/mobile|android|iphone|ipad/i.test(ua)) return "Mobile";
  if (/tablet|ipad/i.test(ua)) return "Tablet";
  return "Desktop";
}

function browserFromUA(ua: string): string {
  if (/edg/i.test(ua)) return "Edge";
  if (/chrome/i.test(ua)) return "Chrome";
  if (/firefox/i.test(ua)) return "Firefox";
  if (/safari/i.test(ua)) return "Safari";
  return "Other";
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/health") return json({ ok: true });

    if (path.startsWith("/api/")) return handleApi(request, env, url);

    if (path === "/" || path === "/index.html") {
      return env.ASSETS.fetch(request);
    }

    const slug = decodeURIComponent(path.slice(1)).split("/")[0];
    if (slug && SLUG_RE.test(slug) && !RESERVED.has(slug)) {
      return handleRedirect(request, env, slug);
    }

    return env.ASSETS.fetch(request);
  },
};

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const parts = url.pathname.split("/").filter(Boolean);

  if (parts[1] === "links" && request.method === "POST") {
    const body = await request.json().catch(() => null) as any;
    if (!body || typeof body.url !== "string") return json({ error: "url is required" }, 400);
    let target: URL;
    try {
      target = new URL(body.url);
      if (!["http:", "https:"].includes(target.protocol)) throw new Error("bad protocol");
    } catch {
      return json({ error: "Enter a valid http or https URL" }, 400);
    }
    let slug = typeof body.slug === "string" && body.slug.trim() ? body.slug.trim() : randomSlug();
    if (!SLUG_RE.test(slug)) return json({ error: "Slug must be 3 to 64 letters, numbers, hyphens, or underscores" }, 400);
    if (RESERVED.has(slug.toLowerCase())) return json({ error: "That slug is reserved" }, 400);

    const id = crypto.randomUUID();
    const now = Date.now();
    const expiresAt = body.expiresAt ? Date.parse(body.expiresAt) : null;
    const maxClicks = body.maxClicks ? Number(body.maxClicks) : null;
    if (expiresAt && Number.isNaN(expiresAt)) return json({ error: "Invalid expiry date" }, 400);
    if (maxClicks !== null && (!Number.isInteger(maxClicks) || maxClicks < 1)) {
      return json({ error: "Click limit must be a whole number of 1 or more" }, 400);
    }

    try {
      await env.DB.prepare(
        "INSERT INTO links (id, slug, url, created_at, expires_at, max_clicks) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(id, slug, target.toString(), now, expiresAt || null, maxClicks).run();
    } catch {
      return json({ error: "That slug is already taken. Try another one." }, 409);
    }
    const base = env.BASE_URL.replace(/\/$/, "");
    return json({ id, slug, url: target.toString(), shortUrl: `${base}/${slug}`, createdAt: now, expiresAt, maxClicks, clickCount: 0, paused: false }, 201);
  }

  if (parts[1] === "links" && request.method === "GET" && parts.length === 2) {
    const search = url.searchParams.get("search") || "";
    const filter = url.searchParams.get("filter") || "all";
    let sql = "SELECT * FROM links";
    const params: unknown[] = [];
    const where: string[] = [];
    if (search) { where.push("(slug LIKE ? OR url LIKE ?)"); params.push(`%${search}%`, `%${search}%`); }
    if (filter === "paused") where.push("paused = 1");
    if (filter === "expired") where.push("expires_at IS NOT NULL AND expires_at < ?");
    if (filter === "expired") params.push(Date.now());
    if (where.length) sql += " WHERE " + where.join(" AND ");
    sql += " ORDER BY created_at DESC LIMIT 200";
    const rows = await env.DB.prepare(sql).bind(...params).all();
    const total = await env.DB.prepare("SELECT COUNT(*) AS c, COALESCE(SUM(click_count), 0) AS clicks FROM links").first() as any;
    return json({ links: rows.results || [], totalLinks: total?.c || 0, totalClicks: total?.clicks || 0 });
  }

  if (parts[1] === "links" && parts.length === 4 && parts[3] === "stats") {
    const slug = parts[2];
    const days = Math.min(30, Math.max(1, Number(url.searchParams.get("days") || "7")));
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const link = await env.DB.prepare("SELECT * FROM links WHERE slug = ?").bind(slug).first();
    if (!link) return json({ error: "Link not found" }, 404);
    const byDay = await env.DB.prepare(
      "SELECT date(clicked_at / 1000, 'unixepoch') AS day, COUNT(*) AS c FROM clicks WHERE slug = ? AND clicked_at >= ? GROUP BY day ORDER BY day"
    ).bind(slug, since).all();
    const byCountry = await env.DB.prepare(
      "SELECT COALESCE(country, 'Unknown') AS k, COUNT(*) AS c FROM clicks WHERE slug = ? AND clicked_at >= ? GROUP BY k ORDER BY c DESC LIMIT 10"
    ).bind(slug, since).all();
    const byDevice = await env.DB.prepare(
      "SELECT COALESCE(device, 'Unknown') AS k, COUNT(*) AS c FROM clicks WHERE slug = ? AND clicked_at >= ? GROUP BY k ORDER BY c DESC"
    ).bind(slug, since).all();
    const byBrowser = await env.DB.prepare(
      "SELECT COALESCE(browser, 'Unknown') AS k, COUNT(*) AS c FROM clicks WHERE slug = ? AND clicked_at >= ? GROUP BY k ORDER BY c DESC"
    ).bind(slug, since).all();
    const byReferrer = await env.DB.prepare(
      "SELECT COALESCE(NULLIF(referrer, ''), 'Direct') AS k, COUNT(*) AS c FROM clicks WHERE slug = ? AND clicked_at >= ? GROUP BY k ORDER BY c DESC LIMIT 10"
    ).bind(slug, since).all();
    return json({ link, byDay: byDay.results || [], byCountry: byCountry.results || [], byDevice: byDevice.results || [], byBrowser: byBrowser.results || [], byReferrer: byReferrer.results || [] });
  }

  if (parts[1] === "links" && request.method === "PATCH" && parts.length === 3) {
    const body = await request.json().catch(() => null) as any;
    await env.DB.prepare("UPDATE links SET paused = ? WHERE slug = ?").bind(body?.paused ? 1 : 0, parts[2]).run();
    return json({ ok: true });
  }

  if (parts[1] === "links" && request.method === "DELETE" && parts.length === 3) {
    await env.DB.prepare("DELETE FROM clicks WHERE slug = ?").bind(parts[2]).run();
    await env.DB.prepare("DELETE FROM links WHERE slug = ?").bind(parts[2]).run();
    return json({ ok: true });
  }

  return json({ error: "Not found" }, 404);
}

async function handleRedirect(request: Request, env: Env, slug: string): Promise<Response> {
  const link = await env.DB.prepare("SELECT * FROM links WHERE slug = ?").bind(slug).first() as any;
  if (!link) return new Response("Short link not found", { status: 404 });
  if (link.paused) return new Response("This link is paused", { status: 410 });
  if (link.expires_at && link.expires_at < Date.now()) return new Response("This link has expired", { status: 410 });
  if (link.max_clicks && link.click_count >= link.max_clicks) return new Response("This link has reached its click limit", { status: 410 });

  const ua = request.headers.get("user-agent") || "";
  const click = {
    id: crypto.randomUUID(),
    link_id: link.id,
    slug,
    clicked_at: Date.now(),
    country: (request as any).cf?.country || "Unknown",
    referrer: request.headers.get("referer") || "",
    user_agent: ua.slice(0, 500),
    device: deviceFromUA(ua),
    browser: browserFromUA(ua),
  };
  const p1 = env.DB.prepare(
    "INSERT INTO clicks (id, link_id, slug, clicked_at, country, referrer, user_agent, device, browser) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(click.id, click.link_id, click.slug, click.clicked_at, click.country, click.referrer, click.user_agent, click.device, click.browser).run();
  const p2 = env.DB.prepare("UPDATE links SET click_count = click_count + 1 WHERE slug = ?").bind(slug).run();
  await Promise.all([p1, p2]);
  return Response.redirect(link.url, 302);
}
