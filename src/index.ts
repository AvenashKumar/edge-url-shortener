export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  BASE_URL: string;
}

const SLUG_RE = /^[a-zA-Z0-9_-]{3,64}$/;
const RESERVED = new Set(["api", "admin", "assets", "static", "health", "login", "signup"]);
const MAX_LINKS_PER_VISITOR = 100;

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function visitorIdFrom(request: Request): string | null {
  const cookie = request.headers.get("cookie") || "";
  const m = cookie.match(/(?:^|;\s*)visitor_id=([A-Za-z0-9-]{36})/);
  return m ? m[1] : null;
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
  if (/chrome|crios/i.test(ua)) return "Chrome";
  if (/firefox|fxios/i.test(ua)) return "Firefox";
  if (/safari/i.test(ua)) return "Safari";
  return "Other";
}

function osFromUA(ua: string): string {
  let m = ua.match(/Windows NT ([\d.]+)/);
  if (m) return "Windows " + (m[1].startsWith("10") ? "10/11" : m[1]);
  m = ua.match(/Mac OS X ([\d_]+)/);
  if (m) return "macOS " + m[1].replace(/_/g, ".");
  m = ua.match(/Android ([\d.]+)/);
  if (m) return "Android " + m[1];
  m = ua.match(/iPhone OS ([\d_]+)/) || ua.match(/CPU OS ([\d_]+)/);
  if (m) return "iOS " + m[1].replace(/_/g, ".");
  if (/Linux/i.test(ua)) return "Linux";
  return "Other";
}

function browserVersionFromUA(ua: string): string {
  let m = ua.match(/Edg\/([\d.]+)/);
  if (m) return "Edge " + m[1].split(".")[0];
  m = ua.match(/Chrome\/([\d.]+)/) || ua.match(/CriOS\/([\d.]+)/);
  if (m) return "Chrome " + m[1].split(".")[0];
  m = ua.match(/Firefox\/([\d.]+)/) || ua.match(/FxiOS\/([\d.]+)/);
  if (m) return "Firefox " + m[1].split(".")[0];
  m = ua.match(/Version\/([\d.]+).*Safari/);
  if (m) return "Safari " + m[1].split(".")[0];
  return browserFromUA(ua);
}

function deviceModelFromUA(ua: string): string {
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  const sm = ua.match(/SM-[A-Z0-9]+/);
  if (sm) return sm[0];
  const px = ua.match(/Pixel \d+(?: Pro|a)?/);
  if (px) return px[0];
  if (/Android/i.test(ua)) return "Android device";
  return "Desktop";
}

function isBotUA(ua: string): boolean {
  return /bot|crawler|spider|slurp|facebookexternalhit|twitterbot|linkedinbot|whatsapp|telegrambot|googlebot|bingbot|yandexbot|duckduckbot|baiduspider/i.test(ua);
}

function referrerDomain(referrer: string): string {
  if (!referrer) return "Direct";
  try {
    return new URL(referrer).hostname;
  } catch {
    return "Direct";
  }
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

  if (parts[1] === "links" && request.method === "POST" && parts.length === 2) {
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
    const maxClicks = body.maxClicks !== undefined && body.maxClicks !== null ? Number(body.maxClicks) : null;
    if (body.expiresAt && Number.isNaN(expiresAt)) return json({ error: "Invalid expiry date" }, 400);
    if (maxClicks !== null && (!Number.isInteger(maxClicks) || maxClicks < 1)) {
      return json({ error: "Click limit must be a whole number of 1 or more" }, 400);
    }

    const visitorId = visitorIdFrom(request) || crypto.randomUUID();
    const visitorCookie = `visitor_id=${visitorId}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${url.protocol === "https:" ? "; Secure" : ""}`;
    const count = await env.DB.prepare("SELECT COUNT(*) AS c FROM links WHERE visitor_id = ?").bind(visitorId).first() as any;
    if ((count?.c || 0) >= MAX_LINKS_PER_VISITOR) {
      return json({ error: "You have reached your limit of 100 links. Delete one of your links to create a new one." }, 429, { "set-cookie": visitorCookie });
    }

    try {
      await env.DB.prepare(
        "INSERT INTO links (id, slug, url, created_at, expires_at, max_clicks, visitor_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).bind(id, slug, target.toString(), now, expiresAt || null, maxClicks, visitorId).run();
    } catch {
      return json({ error: "That slug is already taken. Try another one." }, 409);
    }
    const base = env.BASE_URL.replace(/\/$/, "");
    return json({ id, slug, url: target.toString(), shortUrl: `${base}/${slug}`, createdAt: now, expiresAt, maxClicks, clickCount: 0, paused: false }, 201, { "set-cookie": visitorCookie });
  }

  if (parts[1] === "stats" && request.method === "GET" && parts.length === 2) {
    const total = await env.DB.prepare("SELECT COUNT(*) AS c, COALESCE(SUM(click_count), 0) AS clicks, COALESCE(SUM(CASE WHEN paused = 0 THEN 1 ELSE 0 END), 0) AS active FROM links").first() as any;
    return json({ totalLinks: total?.c || 0, totalClicks: total?.clicks || 0, activeLinks: total?.active || 0 });
  }

  if (parts[1] === "links" && parts[2] === "lookup" && request.method === "POST") {
    const body = await request.json().catch(() => null) as any;
    const slugs = Array.isArray(body?.slugs) ? body.slugs.filter((s: unknown) => typeof s === "string" && SLUG_RE.test(s)).slice(0, 100) : [];
    if (!slugs.length) return json({ links: [] });
    const placeholders = slugs.map(() => "?").join(",");
    const rows = await env.DB.prepare(`SELECT * FROM links WHERE slug IN (${placeholders}) ORDER BY created_at DESC`).bind(...slugs).all();
    return json({ links: rows.results || [] });
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
    const byOs = await env.DB.prepare(
      "SELECT COALESCE(os, 'Unknown') AS k, COUNT(*) AS c FROM clicks WHERE slug = ? AND clicked_at >= ? GROUP BY k ORDER BY c DESC"
    ).bind(slug, since).all();
    const byBrowserVersion = await env.DB.prepare(
      "SELECT COALESCE(browser_version, 'Unknown') AS k, COUNT(*) AS c FROM clicks WHERE slug = ? AND clicked_at >= ? GROUP BY k ORDER BY c DESC"
    ).bind(slug, since).all();
    const byDeviceModel = await env.DB.prepare(
      "SELECT COALESCE(device_model, 'Unknown') AS k, COUNT(*) AS c FROM clicks WHERE slug = ? AND clicked_at >= ? GROUP BY k ORDER BY c DESC"
    ).bind(slug, since).all();
    const byBot = await env.DB.prepare(
      "SELECT CASE WHEN is_bot = 1 THEN 'Bot' ELSE 'Human' END AS k, COUNT(*) AS c FROM clicks WHERE slug = ? AND clicked_at >= ? GROUP BY k ORDER BY c DESC"
    ).bind(slug, since).all();
    const byCity = await env.DB.prepare(
      "SELECT COALESCE(city, 'Unknown') AS k, COUNT(*) AS c FROM clicks WHERE slug = ? AND clicked_at >= ? GROUP BY k ORDER BY c DESC LIMIT 10"
    ).bind(slug, since).all();
    const byRegion = await env.DB.prepare(
      "SELECT COALESCE(region, 'Unknown') AS k, COUNT(*) AS c FROM clicks WHERE slug = ? AND clicked_at >= ? GROUP BY k ORDER BY c DESC LIMIT 10"
    ).bind(slug, since).all();
    const byTimezone = await env.DB.prepare(
      "SELECT COALESCE(timezone, 'Unknown') AS k, COUNT(*) AS c FROM clicks WHERE slug = ? AND clicked_at >= ? GROUP BY k ORDER BY c DESC"
    ).bind(slug, since).all();
    const byAsn = await env.DB.prepare(
      "SELECT COALESCE(asn, 'Unknown') AS k, COUNT(*) AS c FROM clicks WHERE slug = ? AND clicked_at >= ? GROUP BY k ORDER BY c DESC LIMIT 10"
    ).bind(slug, since).all();
    const byColo = await env.DB.prepare(
      "SELECT COALESCE(colo, 'Unknown') AS k, COUNT(*) AS c FROM clicks WHERE slug = ? AND clicked_at >= ? GROUP BY k ORDER BY c DESC"
    ).bind(slug, since).all();
    const byTls = await env.DB.prepare(
      "SELECT COALESCE(tls_version, 'Unknown') AS k, COUNT(*) AS c FROM clicks WHERE slug = ? AND clicked_at >= ? GROUP BY k ORDER BY c DESC"
    ).bind(slug, since).all();
    const byHourRaw = await env.DB.prepare(
      "SELECT strftime('%H', clicked_at / 1000, 'unixepoch') AS k, COUNT(*) AS c FROM clicks WHERE slug = ? AND clicked_at >= ? GROUP BY k ORDER BY k"
    ).bind(slug, since).all();
    const byHour = (byHourRaw.results || []).map((r: any) => ({ k: `${r.k}:00`, c: r.c }));
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const byDayOfWeekRaw = await env.DB.prepare(
      "SELECT strftime('%w', clicked_at / 1000, 'unixepoch') AS k, COUNT(*) AS c FROM clicks WHERE slug = ? AND clicked_at >= ? GROUP BY k ORDER BY c DESC"
    ).bind(slug, since).all();
    const byDayOfWeek = (byDayOfWeekRaw.results || []).map((r: any) => ({ k: dayNames[Number(r.k)] || r.k, c: r.c }));
    const allReferrers = await env.DB.prepare(
      "SELECT referrer, COUNT(*) AS c FROM clicks WHERE slug = ? AND clicked_at >= ? GROUP BY referrer"
    ).bind(slug, since).all();
    const domainCounts = new Map<string, number>();
    for (const r of (allReferrers.results || []) as any[]) {
      const d = referrerDomain(r.referrer || "");
      domainCounts.set(d, (domainCounts.get(d) || 0) + r.c);
    }
    const byReferrerDomain = [...domainCounts.entries()].map(([k, c]) => ({ k, c })).sort((a, b) => b.c - a.c).slice(0, 10);
    const range = await env.DB.prepare(
      "SELECT MIN(clicked_at) AS first, MAX(clicked_at) AS last FROM clicks WHERE slug = ? AND clicked_at >= ?"
    ).bind(slug, since).first() as any;
    return json({ link, byDay: byDay.results || [], byCountry: byCountry.results || [], byDevice: byDevice.results || [], byBrowser: byBrowser.results || [], byReferrer: byReferrer.results || [], byOs: byOs.results || [], byBrowserVersion: byBrowserVersion.results || [], byDeviceModel: byDeviceModel.results || [], byBot: byBot.results || [], byCity: byCity.results || [], byRegion: byRegion.results || [], byTimezone: byTimezone.results || [], byAsn: byAsn.results || [], byColo: byColo.results || [], byTls: byTls.results || [], byHour, byDayOfWeek, byReferrerDomain, firstClickAt: range?.first || null, lastClickAt: range?.last || null });
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
  const cf = (request as any).cf || {};
  const click = {
    id: crypto.randomUUID(),
    link_id: link.id,
    slug,
    clicked_at: Date.now(),
    country: cf.country || "Unknown",
    referrer: request.headers.get("referer") || "",
    user_agent: ua.slice(0, 500),
    device: deviceFromUA(ua),
    browser: browserFromUA(ua),
    os: osFromUA(ua),
    browser_version: browserVersionFromUA(ua),
    device_model: deviceModelFromUA(ua),
    is_bot: isBotUA(ua) ? 1 : 0,
    city: cf.city || null,
    region: cf.region || null,
    timezone: cf.timezone || null,
    asn: cf.asn ? `AS${cf.asn}` : null,
    colo: cf.colo || null,
    tls_version: cf.tlsVersion || null,
  };
  const p1 = env.DB.prepare(
    "INSERT INTO clicks (id, link_id, slug, clicked_at, country, referrer, user_agent, device, browser, os, browser_version, device_model, is_bot, city, region, timezone, asn, colo, tls_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(click.id, click.link_id, click.slug, click.clicked_at, click.country, click.referrer, click.user_agent, click.device, click.browser, click.os, click.browser_version, click.device_model, click.is_bot, click.city, click.region, click.timezone, click.asn, click.colo, click.tls_version).run();
  const p2 = env.DB.prepare("UPDATE links SET click_count = click_count + 1 WHERE slug = ?").bind(slug).run();
  await Promise.all([p1, p2]);
  return Response.redirect(link.url, 302);
}
