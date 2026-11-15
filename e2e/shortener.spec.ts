import { test, expect, request } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL || "https://go.avenash-kumar.com";
const proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy;
const api = () => request.newContext(proxyServer && !baseURL.includes("localhost") ? { proxy: { server: proxyServer } } : {});
const uniq = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

async function createLink(ctx: Awaited<ReturnType<typeof api>>, data: Record<string, unknown>, headers?: Record<string, string>) {
  return ctx.post(`${baseURL}/api/links`, { data, headers });
}

async function deleteLink(ctx: Awaited<ReturnType<typeof api>>, slug: string) {
  await ctx.delete(`${baseURL}/api/links/${slug}`);
}

test.describe("Edge URL Shortener", () => {
  test("@api health returns ok", async () => {
    const ctx = await api();
    const res = await ctx.get(`${baseURL}/health`);
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    await ctx.dispose();
  });

  test("@api create, redirect, and delete a link, cleaning up after itself", async () => {
    const ctx = await api();
    const slug = uniq("e2e");
    const create = await createLink(ctx, { url: "https://example.com", slug });
    expect(create.status(), await create.text()).toBe(201);
    const created = await create.json();
    expect(created.slug).toBe(slug);
    expect(created.shortUrl).toContain(`/${slug}`);

    const redirect = await ctx.get(`${baseURL}/${slug}`, { maxRedirects: 0 });
    expect(redirect.status()).toBe(302);
    expect(redirect.headers().location).toBe("https://example.com/");

    const del = await ctx.delete(`${baseURL}/api/links/${slug}`);
    expect(del.status()).toBe(200);
    const gone = await ctx.get(`${baseURL}/${slug}`, { maxRedirects: 0 });
    expect(gone.status()).toBe(404);
    await ctx.dispose();
  });

  test("@api the 100 link limit is per visitor, not global", async () => {
    const ctx = await api();
    const slug1 = uniq("vl");
    const create1 = await createLink(ctx, { url: "https://example.com", slug: slug1 });
    expect(create1.status(), await create1.text()).toBe(201);
    const setCookie = create1.headers()["set-cookie"] || "";
    expect(setCookie).toContain("visitor_id=");
    const visitorId = setCookie.match(/visitor_id=([A-Za-z0-9-]+)/)?.[1];
    expect(visitorId).toBeTruthy();
    const slug2 = uniq("vl");
    const create2 = await createLink(ctx, { url: "https://example.com", slug: slug2 }, { cookie: `visitor_id=${visitorId}` });
    expect(create2.status(), await create2.text()).toBe(201);
    const ctx2 = await api();
    const slug3 = uniq("vl");
    const create3 = await createLink(ctx2, { url: "https://example.com", slug: slug3 });
    expect(create3.status(), await create3.text()).toBe(201);
    await deleteLink(ctx, slug1);
    await deleteLink(ctx, slug2);
    await deleteLink(ctx2, slug3);
    await ctx.dispose();
    await ctx2.dispose();
  });

  test("@api create without a slug generates a random one", async () => {
    const ctx = await api();
    const create = await createLink(ctx, { url: "https://example.com" });
    expect(create.status(), await create.text()).toBe(201);
    const created = await create.json();
    expect(created.slug).toMatch(/^[A-Za-z0-9]{6}$/);
    const redirect = await ctx.get(`${baseURL}/${created.slug}`, { maxRedirects: 0 });
    expect(redirect.status()).toBe(302);
    await deleteLink(ctx, created.slug);
    await ctx.dispose();
  });

  test("@api an expired link returns 410", async () => {
    const ctx = await api();
    const slug = uniq("exp");
    const past = new Date(Date.now() - 60_000).toISOString();
    const create = await createLink(ctx, { url: "https://example.com", slug, expiresAt: past });
    expect(create.status()).toBe(201);
    const redirect = await ctx.get(`${baseURL}/${slug}`, { maxRedirects: 0 });
    expect(redirect.status()).toBe(410);
    await deleteLink(ctx, slug);
    await ctx.dispose();
  });

  test("@api a click limit returns 410 after the limit is reached", async () => {
    const ctx = await api();
    const slug = uniq("lim");
    const create = await createLink(ctx, { url: "https://example.com", slug, maxClicks: 1 });
    expect(create.status()).toBe(201);
    const first = await ctx.get(`${baseURL}/${slug}`, { maxRedirects: 0 });
    expect(first.status()).toBe(302);
    const second = await ctx.get(`${baseURL}/${slug}`, { maxRedirects: 0 });
    expect(second.status()).toBe(410);
    await deleteLink(ctx, slug);
    await ctx.dispose();
  });

  test("@api pause returns 410 and resume restores the redirect", async () => {
    const ctx = await api();
    const slug = uniq("pau");
    const create = await createLink(ctx, { url: "https://example.com", slug });
    expect(create.status()).toBe(201);
    const paused = await ctx.patch(`${baseURL}/api/links/${slug}`, { data: { paused: true } });
    expect(paused.status()).toBe(200);
    const blocked = await ctx.get(`${baseURL}/${slug}`, { maxRedirects: 0 });
    expect(blocked.status()).toBe(410);
    const resumed = await ctx.patch(`${baseURL}/api/links/${slug}`, { data: { paused: false } });
    expect(resumed.status()).toBe(200);
    const ok = await ctx.get(`${baseURL}/${slug}`, { maxRedirects: 0 });
    expect(ok.status()).toBe(302);
    await deleteLink(ctx, slug);
    await ctx.dispose();
  });

  test("@api stats show clicks and device and browser breakdowns", async () => {
    const ctx = await api();
    const slug = uniq("st");
    const create = await createLink(ctx, { url: "https://example.com", slug });
    expect(create.status()).toBe(201);
    await ctx.get(`${baseURL}/${slug}`, {
      maxRedirects: 0,
      headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36" },
    });
    await ctx.get(`${baseURL}/${slug}`, {
      maxRedirects: 0,
      headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148" },
    });
    const stats = await ctx.get(`${baseURL}/api/links/${slug}/stats?days=7`);
    expect(stats.status()).toBe(200);
    const data = await stats.json();
    expect(data.link.click_count).toBe(2);
    expect(data.byDevice.map((r: { k: string }) => r.k)).toContain("Desktop");
    expect(data.byDevice.map((r: { k: string }) => r.k)).toContain("Mobile");
    expect(data.byBrowser.map((r: { k: string }) => r.k)).toContain("Chrome");
    expect(Array.isArray(data.byDay)).toBe(true);
    expect(Array.isArray(data.byCountry)).toBe(true);
    expect(Array.isArray(data.byReferrer)).toBe(true);
    expect(data.byOs.map((r: { k: string }) => r.k)).toContain("Windows 10/11");
    expect(data.byOs.map((r: { k: string }) => r.k)).toContain("iOS 17.0");
    expect(data.byBrowserVersion.map((r: { k: string }) => r.k)).toContain("Chrome 120");
    expect(data.byDeviceModel.map((r: { k: string }) => r.k)).toContain("iPhone");
    expect(data.byBot.map((r: { k: string }) => r.k)).toContain("Human");
    expect(data.byHour.length).toBeGreaterThanOrEqual(1);
    expect(data.byHour[0].k).toMatch(/^\d{2}:00$/);
    expect(data.byDayOfWeek.length).toBeGreaterThanOrEqual(1);
    expect(data.byReferrerDomain.map((r: { k: string }) => r.k)).toContain("Direct");
    expect(typeof data.firstClickAt).toBe("number");
    expect(typeof data.lastClickAt).toBe("number");
    await deleteLink(ctx, slug);
    await ctx.dispose();
  });

  test("@api bot clicks are counted separately from human clicks", async () => {
    const ctx = await api();
    const slug = uniq("bot");
    const create = await createLink(ctx, { url: "https://example.com", slug });
    expect(create.status()).toBe(201);
    await ctx.get(`${baseURL}/${slug}`, {
      maxRedirects: 0,
      headers: { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" },
    });
    const stats = await ctx.get(`${baseURL}/api/links/${slug}/stats?days=7`);
    const data = await stats.json();
    expect(data.byBot.map((r: { k: string }) => r.k)).toContain("Bot");
    await deleteLink(ctx, slug);
    await ctx.dispose();
  });

  test("@api slug validation rejects bad slugs, reserved slugs, and bad options", async () => {
    const ctx = await api();
    const short = await createLink(ctx, { url: "https://example.com", slug: "ab" });
    expect(short.status()).toBe(400);
    const chars = await createLink(ctx, { url: "https://example.com", slug: "bad slug!" });
    expect(chars.status()).toBe(400);
    const reserved = await createLink(ctx, { url: "https://example.com", slug: "api" });
    expect(reserved.status()).toBe(400);
    const badExpiry = await createLink(ctx, { url: "https://example.com", slug: uniq("ok"), expiresAt: "not-a-date" });
    expect(badExpiry.status()).toBe(400);
    const badLimit = await createLink(ctx, { url: "https://example.com", slug: uniq("ok"), maxClicks: 0 });
    expect(badLimit.status()).toBe(400);
    await ctx.dispose();
  });

  test("@api invalid URL is rejected and duplicate slug returns 409", async () => {
    const ctx = await api();
    const bad = await createLink(ctx, { url: "not-a-url", slug: uniq("bad") });
    expect(bad.status()).toBe(400);
    const slug = uniq("dup");
    const first = await createLink(ctx, { url: "https://example.com", slug });
    expect(first.status()).toBe(201);
    const dup = await createLink(ctx, { url: "https://example.com", slug });
    expect(dup.status()).toBe(409);
    await deleteLink(ctx, slug);
    await ctx.dispose();
  });

  test("@api lookup returns only the requested slugs, never a global list", async () => {
    const ctx = await api();
    const slugA = uniq("lk");
    const slugB = uniq("lk");
    expect((await createLink(ctx, { url: "https://example.com", slug: slugA })).status()).toBe(201);
    expect((await createLink(ctx, { url: "https://example.com", slug: slugB })).status()).toBe(201);
    const found = await ctx.post(`${baseURL}/api/links/lookup`, { data: { slugs: [slugA, slugB] } });
    expect(found.status()).toBe(200);
    const foundData = await found.json();
    expect(foundData.links.map((l: { slug: string }) => l.slug).sort()).toEqual([slugA, slugB].sort());
    const missing = await ctx.post(`${baseURL}/api/links/lookup`, { data: { slugs: ["no-such-slug-xyz"] } });
    expect((await missing.json()).links).toEqual([]);
    const empty = await ctx.post(`${baseURL}/api/links/lookup`, { data: { slugs: [] } });
    expect((await empty.json()).links).toEqual([]);
    await deleteLink(ctx, slugA);
    await deleteLink(ctx, slugB);
    await ctx.dispose();
  });

  test("@api stats for an unknown slug returns 404", async () => {
    const ctx = await api();
    const res = await ctx.get(`${baseURL}/api/links/no-such-slug-xyz/stats`);
    expect(res.status()).toBe(404);
    await ctx.dispose();
  });

  test("@api stats returns totals without listing any links", async () => {
    const ctx = await api();
    const res = await ctx.get(`${baseURL}/api/stats`);
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.totalLinks).toBeLessThanOrEqual(100);
    expect(typeof data.totalClicks).toBe("number");
    expect(data.links).toBeUndefined();
    await ctx.dispose();
  });

  test("homepage loads with create form, links list, and favicon", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#long-url")).toBeVisible();
    await expect(page.locator("#slug")).toBeVisible();
    await expect(page.locator("#create-form")).toBeVisible();
    await expect(page.locator("#links-list")).toBeVisible();
    const fav = await page.request.get("/favicon.svg");
    expect(fav.status()).toBe(200);
    expect(fav.headers()["content-type"]).toContain("image/svg+xml");
  });

  test("try-example fills the long URL box without creating a link", async ({ page }) => {
    await page.goto("/");
    await page.locator('.try-examples button[data-url*="quic-birth"]').click();
    await expect(page.locator("#long-url")).toHaveValue("https://www.avenash-kumar.com/blog/quic-birth-of-new-protocol-in-layer4-family");
    await expect(page.locator("#result")).toBeHidden();
  });

  test("create a link through the form shows the result and a QR code", async ({ page }) => {
    const slug = uniq("ui");
    await page.goto("/");
    await page.locator("#long-url").fill("https://example.com");
    await page.locator("#slug").fill(slug);
    await page.locator("#create-form button[type='submit']").click();
    await expect(page.locator("#short-url")).toContainText(`/${slug}`);
    await expect(page.locator("#qr")).toBeVisible();
    await expect(page.locator("#links-list")).toContainText(slug);
    const ctx = await api();
    await deleteLink(ctx, slug);
    await ctx.dispose();
  });

  test("the short link in the list is clickable and opens the short URL", async ({ page }) => {
    const slug = uniq("ui");
    await page.goto("/");
    await page.locator("#long-url").fill("https://example.com");
    await page.locator("#slug").fill(slug);
    await page.locator("#create-form button[type='submit']").click();
    const link = page.locator(`.link-row a.short-link[href="${baseURL}/${slug}"]`);
    await expect(link).toBeVisible();
    await expect(link).toHaveText(`/${slug}`);
    await expect(link).toHaveAttribute("target", "_blank");
    const ctx = await api();
    await deleteLink(ctx, slug);
    await ctx.dispose();
  });

  test("search box filters the links list in the UI", async ({ page }) => {
    const token = uniq("ui");
    const slug = `${token}-a`;
    await page.goto("/");
    await page.locator("#long-url").fill("https://example.com");
    await page.locator("#slug").fill(slug);
    await page.locator("#create-form button[type='submit']").click();
    await expect(page.locator("#links-list")).toContainText(slug);
    await page.locator("#search").fill("no-such-token-xyz");
    await page.waitForTimeout(500);
    await expect(page.locator("#links-list")).not.toContainText(slug);
    await page.locator("#search").fill(token);
    await page.waitForTimeout(500);
    await expect(page.locator("#links-list")).toContainText(slug);
    const ctx = await api();
    await deleteLink(ctx, slug);
    await ctx.dispose();
  });

  test("links list shows only links created in this browser, not other people's", async ({ page }) => {
    const ctx = await api();
    const mine = uniq("mine");
    const other = uniq("other");
    expect((await createLink(ctx, { url: "https://example.com", slug: other })).status()).toBe(201);
    await page.goto("/");
    await page.locator("#long-url").fill("https://example.com");
    await page.locator("#slug").fill(mine);
    await page.locator("#create-form button[type='submit']").click();
    await expect(page.locator("#links-list")).toContainText(mine);
    await expect(page.locator("#links-list")).not.toContainText(other);
    await deleteLink(ctx, mine);
    await deleteLink(ctx, other);
    await ctx.dispose();
  });

  test("pause, resume, and delete work from the list buttons", async ({ page }) => {
    const slug = uniq("ui");
    await page.goto("/");
    await page.locator("#long-url").fill("https://example.com");
    await page.locator("#slug").fill(slug);
    await page.locator("#create-form button[type='submit']").click();
    const row = page.locator("#links-list", { hasText: slug });
    await expect(row).toBeVisible();
    const ctx = await api();
    await page.locator(`[data-pause="${slug}"]`).click();
    await expect(page.locator(`[data-pause="${slug}"]`)).toHaveText("Resume");
    const blocked = await ctx.get(`${baseURL}/${slug}`, { maxRedirects: 0 });
    expect(blocked.status()).toBe(410);
    await page.locator(`[data-pause="${slug}"]`).click();
    await expect(page.locator(`[data-pause="${slug}"]`)).toHaveText("Pause");
    const ok = await ctx.get(`${baseURL}/${slug}`, { maxRedirects: 0 });
    expect(ok.status()).toBe(302);
    page.on("dialog", (d) => d.accept());
    await page.locator(`[data-del="${slug}"]`).click();
    await expect(page.locator("#links-list")).not.toContainText(slug);
    await deleteLink(ctx, slug);
    await ctx.dispose();
  });

  test("analytics panel opens for a link and switches day ranges", async ({ page }) => {
    const slug = uniq("ui");
    await page.goto("/");
    await page.locator("#long-url").fill("https://example.com");
    await page.locator("#slug").fill(slug);
    await page.locator("#create-form button[type='submit']").click();
    const ctx = await api();
    await ctx.get(`${baseURL}/${slug}`, { maxRedirects: 0 });
    await page.locator(`[data-stats="${slug}"]`).click();
    await expect(page.locator("#analytics")).toBeVisible();
    await expect(page.locator("#analytics-title")).toContainText(slug);
    await expect(page.locator("#analytics-title")).toContainText("1 clicks");
    await page.locator('[data-days="30"]').click();
    await expect(page.locator('[data-days="30"]')).toHaveClass(/active/);
    await deleteLink(ctx, slug);
    await ctx.dispose();
  });

  test("analytics breakdowns use a sidebar layout", async ({ page }) => {
    const slug = uniq("ui");
    await page.goto("/");
    await page.locator("#long-url").fill("https://example.com");
    await page.locator("#slug").fill(slug);
    await page.locator("#create-form button[type='submit']").click();
    const ctx = await api();
    await ctx.get(`${baseURL}/${slug}`, { maxRedirects: 0 });
    await page.locator(`[data-stats="${slug}"]`).click();
    await expect(page.locator("#analytics")).toBeVisible();
    const nav = page.locator("#analytics-nav button");
    await expect(nav).toHaveCount(4);
    await expect(nav.nth(0)).toHaveClass(/active/);
    await expect(page.locator("#analytics-pane")).toContainText("Country");
    await nav.nth(1).click();
    await expect(nav.nth(1)).toHaveClass(/active/);
    await expect(page.locator("#analytics-pane")).toContainText("Operating system");
    await expect(page.locator("#analytics-pane")).not.toContainText("Country");
    await deleteLink(ctx, slug);
    await ctx.dispose();
  });
});
