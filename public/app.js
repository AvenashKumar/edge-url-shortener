const $ = (id) => document.getElementById(id);
let currentSlug = null;
let currentDays = 7;
const MY_LINKS_KEY = "go-shortener-links";

function readMySlugs() {
  try { return JSON.parse(localStorage.getItem(MY_LINKS_KEY) || "[]"); } catch (e) { return []; }
}
function saveMyLink(entry) {
  try {
    const list = readMySlugs().filter((x) => x.slug !== entry.slug);
    list.unshift(entry);
    localStorage.setItem(MY_LINKS_KEY, JSON.stringify(list.slice(0, 100)));
  } catch (e) {}
}
function removeMyLink(slug) {
  try { localStorage.setItem(MY_LINKS_KEY, JSON.stringify(readMySlugs().filter((x) => x.slug !== slug))); } catch (e) {}
}

async function loadLinks() {
  const search = $("search").value.trim();
  const filter = $("filter").value;
  const stats = await (await fetch("/api/stats")).json().catch(() => ({}));
  $("total-links").textContent = stats.totalLinks || 0;
  $("total-clicks").textContent = stats.totalClicks || 0;
  $("active-links").textContent = stats.activeLinks || 0;
  const mySlugs = readMySlugs().map((x) => x.slug);
  let links = [];
  if (mySlugs.length) {
    const res = await fetch("/api/links/lookup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slugs: mySlugs }) });
    links = (await res.json()).links || [];
  }
  if (search && /^[A-Za-z0-9_-]{3,64}$/.test(search) && !mySlugs.includes(search)) {
    const res = await fetch("/api/links/lookup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slugs: [search] }) });
    const found = (await res.json()).links || [];
    if (found.length) { saveMyLink({ slug: found[0].slug, url: found[0].url, createdAt: found[0].created_at }); links = links.concat(found); }
  }
  const q = search.toLowerCase();
  if (q) links = links.filter((l) => l.slug.toLowerCase().includes(q) || l.url.toLowerCase().includes(q));
  if (filter === "paused") links = links.filter((l) => l.paused);
  if (filter === "expired") links = links.filter((l) => l.expires_at && l.expires_at < Date.now());
  const list = $("links-list");
  if (!links.length) {
    list.innerHTML = '<p class="muted">No links yet in this browser. Create your first one above. Only links you create here are shown, no login needed.</p>';
    return;
  }
  list.innerHTML = links.map((l) => `
    <div class="link-row">
      <div><strong>/${l.slug}</strong> <span class="muted">${l.click_count} clicks</span><br>
      <a href="${l.url}" target="_blank" rel="noreferrer">${l.url}</a></div>
      <div class="link-actions">
        <button class="btn" data-copy="${location.origin}/${l.slug}">Copy</button>
        <button class="btn" data-stats="${l.slug}">Analytics</button>
        <button class="btn" data-pause="${l.slug}" data-paused="${l.paused ? 0 : 1}">${l.paused ? "Resume" : "Pause"}</button>
        <button class="btn" data-del="${l.slug}">Delete</button>
      </div>
    </div>`).join("");
}

document.addEventListener("click", async (e) => {
  const t = e.target.closest("button");
  if (!t) return;
  if (t.dataset.copy) { await navigator.clipboard.writeText(t.dataset.copy); t.textContent = "Copied"; setTimeout(() => t.textContent = "Copy", 1500); }
  if (t.dataset.stats) { currentSlug = t.dataset.stats; loadStats(); }
  if (t.dataset.pause) { await fetch(`/api/links/${t.dataset.pause}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ paused: t.dataset.paused === "1" }) }); loadLinks(); }
  if (t.dataset.del) { if (confirm("Delete this link?")) { await fetch(`/api/links/${t.dataset.del}`, { method: "DELETE" }); removeMyLink(t.dataset.del); loadLinks(); } }
  if (t.dataset.days) { currentDays = Number(t.dataset.days); document.querySelectorAll(".chip").forEach((c) => c.classList.remove("active")); t.classList.add("active"); loadStats(); }
});

async function loadStats() {
  if (!currentSlug) return;
  const res = await fetch(`/api/links/${currentSlug}/stats?days=${currentDays}`);
  const data = await res.json();
  $("analytics").classList.remove("hidden");
  $("analytics-title").textContent = `Analytics for /${currentSlug} - ${data.link.click_count} clicks`;
  drawChart(data.byDay || []);
  const groups = [["Country", data.byCountry], ["Device", data.byDevice], ["Browser", data.byBrowser], ["Referrer", data.byReferrer]];
  $("breakdown").innerHTML = groups.map(([title, rows]) => `<div><h3>${title}</h3>${(rows || []).map((r) => `<p>${r.k}: <strong>${r.c}</strong></p>`).join("") || '<p class="muted">No clicks yet in this range.</p>'}</div>`).join("");
  $("analytics").scrollIntoView({ behavior: "smooth" });
}

function drawChart(byDay) {
  const c = $("chart"); const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, c.width, c.height);
  const max = Math.max(1, ...byDay.map((d) => d.c));
  ctx.fillStyle = "#4F46E5";
  byDay.forEach((d, i) => {
    const w = c.width / Math.max(1, byDay.length);
    const h = (d.c / max) * 160;
    ctx.fillRect(i * w + 8, 200 - h, w - 16, h);
    ctx.fillStyle = "#64748B"; ctx.font = "12px Manrope"; ctx.fillText(d.day.slice(5), i * w + 8, 216); ctx.fillStyle = "#4F46E5";
  });
  if (!byDay.length) { ctx.fillStyle = "#64748B"; ctx.font = "16px Manrope"; ctx.fillText("No clicks in this range yet.", 20, 100); }
}

$("create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("form-error").textContent = "";
  const payload = { url: $("long-url").value.trim(), slug: $("slug").value.trim() || undefined, expiresAt: $("expires").value || undefined, maxClicks: $("max-clicks").value ? Number($("max-clicks").value) : undefined };
  const res = await fetch("/api/links", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const data = await res.json();
  if (!res.ok) { $("form-error").textContent = data.error || "Could not create the link."; return; }
  $("result").classList.remove("hidden");
  $("short-url").textContent = data.shortUrl;
  $("result-meta").textContent = data.url;
  if (window.QRCode) QRCode.toCanvas($("qr"), data.shortUrl, { width: 160, color: { dark: "#0F172A", light: "#ffffff" } });
  saveMyLink({ slug: data.slug, url: data.url, createdAt: data.createdAt });
  $("copy-btn").onclick = async () => { await navigator.clipboard.writeText(data.shortUrl); $("copy-btn").textContent = "Copied"; setTimeout(() => $("copy-btn").textContent = "Copy link", 1500); };
  $("open-btn").onclick = () => window.open(data.shortUrl, "_blank");
  currentSlug = data.slug;
  loadLinks();
});

$("search").addEventListener("input", loadLinks);
$("filter").addEventListener("change", loadLinks);
$("refresh").addEventListener("click", loadLinks);
loadLinks();
