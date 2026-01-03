// server.js
import express from "express";
import cors from "cors";

const app = express();
app.use(cors());

// ----------------------------
// Config
// ----------------------------
const PORT = process.env.PORT || 8787;

// Sources (Stage 1)
const ENABLE_GUTENBERG = true;
const ENABLE_STANDARD_EBOOKS = true;

// Keep in code but disabled for now
const ENABLE_INTERNET_ARCHIVE = false;

// Standard Ebooks OPDS (best-effort; этот эндпоинт у них реально есть в OPDS-формате)
const SE_OPDS_SEARCH_URL = "https://standardebooks.org/opds/search";

// ----------------------------
// Helpers
// ----------------------------
function clampInt(v, def, min, max) {
  const n = Number.parseInt(String(v ?? ""), 10);
  if (Number.isNaN(n)) return def;
  return Math.max(min, Math.min(max, n));
}

function safeFilename(name) {
  const base = String(name || "book")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);

  // ASCII-only for Content-Disposition safety
  const ascii = base
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .trim();

  return (ascii || "book").replace(/\s+/g, "_");
}

async function fetchText(url) {
  const r = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": "SpeedReadHost/1.0 (+https://example.local)",
      "Accept": "text/html,application/xml,text/xml;q=0.9,*/*;q=0.8",
    },
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`HTTP ${r.status} fetching ${url}: ${t.slice(0, 200)}`);
  }
  return await r.text();
}

async function fetchBytes(url) {
  const r = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": "SpeedReadHost/1.0 (+https://example.local)",
      "Accept": "*/*",
    },
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`HTTP ${r.status} fetching ${url}: ${t.slice(0, 200)}`);
  }
  const ab = await r.arrayBuffer();
  return new Uint8Array(ab);
}

function toB64Url(str) {
  return Buffer.from(str, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromB64Url(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64url.length + 3) % 4);
  return Buffer.from(b64, "base64").toString("utf8");
}

// Very small XML helper (OPDS/Atom)
function extractTag(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = xml.match(re);
  return m ? m[1].trim() : "";
}

function stripXml(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[/g, "")
    .replace(/\]\]>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function parseOpdsEntries(xml) {
  const entries = [];
  const parts = xml.split(/<entry\b[^>]*>/i);
  for (let i = 1; i < parts.length; i++) {
    const chunk = parts[i];
    const entryXml = "<entry>" + chunk;

    const title = stripXml(extractTag(entryXml, "title"));
    const authorBlock = extractTag(entryXml, "author");
    const authorName = stripXml(extractTag(authorBlock, "name"));

    // Find best acquisition link:
    // Prefer text/plain, else epub
    let textUrl = null;
    let epubUrl = null;

    const linkRe = /<link\b[^>]*>/gi;
    let lm;
    while ((lm = linkRe.exec(entryXml))) {
      const tag = lm[0];
      const href = (tag.match(/\bhref="([^"]+)"/i) || [])[1];
      const type = (tag.match(/\btype="([^"]+)"/i) || [])[1];
      const rel = (tag.match(/\brel="([^"]+)"/i) || [])[1];

      if (!href) continue;

      // acquisition-ish
      const isAcq = rel ? rel.includes("opds-spec.org/acquisition") : true;

      if (!isAcq) continue;

      if (type && type.toLowerCase().includes("text/plain")) textUrl = textUrl || href;
      if (type && type.toLowerCase().includes("application/epub+zip")) epubUrl = epubUrl || href;
    }

    if (!title) continue;

    entries.push({
      title,
      author: authorName || "",
      textUrl,
      epubUrl,
    });
  }
  return entries;
}

// ----------------------------
// Gutenberg
// ----------------------------
async function searchGutenberg(q, page) {
  // Gutendex supports ?search= & ?page=
  const url = `https://gutendex.com/books?search=${encodeURIComponent(q)}&page=${page}`;
  const r = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": "SpeedReadHost/1.0",
      "Accept": "application/json",
    },
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Gutenberg HTTP ${r.status}: ${t.slice(0, 200)}`);
  }

  const data = await r.json();

  const results = [];
  for (const b of data.results || []) {
    const title = b.title || "";
    const author = (b.authors && b.authors[0] && b.authors[0].name) ? b.authors[0].name : "";
    const lang = (b.languages && b.languages[0]) ? b.languages[0] : "en";

    const formats = b.formats || {};
    // Prefer plain text
    const plain =
      formats["text/plain; charset=utf-8"] ||
      formats["text/plain; charset=us-ascii"] ||
      formats["text/plain"] ||
      null;

    const epub = formats["application/epub+zip"] || null;

    // We expose formats just for client logic; UI can ignore it
    const fmts = [];
    if (plain) fmts.push("text/plain");
    if (epub) fmts.push("application/epub+zip");

    // For download-best we only need the id
    results.push({
      id: `gutenberg:${b.id}`,
      title,
      author,
      lang,
      formats: fmts,
    });
  }

  return {
    page,
    hasMore: Boolean(data.next),
    results,
  };
}

async function gutenbergDownloadBest(idStr) {
  const id = idStr.replace(/^gutenberg:/i, "");
  const url = `https://gutendex.com/books/${encodeURIComponent(id)}`;
  const r = await fetch(url, {
    headers: {
      "User-Agent": "SpeedReadHost/1.0",
      "Accept": "application/json",
    },
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Gutenberg book HTTP ${r.status}: ${t.slice(0, 200)}`);
  }
  const b = await r.json();
  const formats = b.formats || {};

  const plain =
    formats["text/plain; charset=utf-8"] ||
    formats["text/plain; charset=us-ascii"] ||
    formats["text/plain"] ||
    null;

  const epub = formats["application/epub+zip"] || null;

  const title = b.title || "book";

  if (plain) {
    return { url: plain, filename: safeFilename(title) + ".txt", mime: "text/plain; charset=utf-8" };
  }
  if (epub) {
    return { url: epub, filename: safeFilename(title) + ".epub", mime: "application/epub+zip" };
  }
  throw new Error("No downloadable formats found (neither text nor epub).");
}

// ----------------------------
// Standard Ebooks (OPDS)
// ----------------------------
async function searchStandardEbooks(q, page) {
  // OPDS search doesn’t always support pagination like Gutenberg; we fake paging by slicing
  const url = `${SE_OPDS_SEARCH_URL}?query=${encodeURIComponent(q)}`;
  const xml = await fetchText(url);
  const entries = parseOpdsEntries(xml);

  // page size
  const pageSize = 25;
  const start = (page - 1) * pageSize;
  const slice = entries.slice(start, start + pageSize);

  const results = slice.map((e) => {
    // Prefer text/plain. If only epub exists — still return, but formats tell the client what it is.
    const bestUrl = e.textUrl || e.epubUrl;
    const bestType = e.textUrl ? "text/plain" : (e.epubUrl ? "application/epub+zip" : "");
    const id = bestUrl ? `se:${toB64Url(bestUrl)}` : `se:${toB64Url("about:blank")}`;

    return {
      id,
      title: e.title,
      author: e.author,
      lang: "en",
      formats: bestType ? [bestType] : [],
    };
  });

  return {
    page,
    hasMore: start + pageSize < entries.length,
    results,
  };
}

async function standardEbooksDownloadBest(idStr) {
  const payload = idStr.replace(/^se:/i, "");
  const url = fromB64Url(payload);

  if (!url || url === "about:blank") {
    throw new Error("Standard Ebooks: missing download URL.");
  }

  // We don’t know title here; will just name it "standard_ebook"
  const isTxt = url.toLowerCase().includes(".txt") || url.toLowerCase().includes("text");
  return {
    url,
    filename: isTxt ? "standard_ebook.txt" : "standard_ebook.epub",
    mime: isTxt ? "text/plain; charset=utf-8" : "application/epub+zip",
  };
}

// ----------------------------
// Internet Archive (disabled placeholder)
// ----------------------------
async function searchInternetArchive(_q, _page) {
  // placeholder
  return { page: _page, hasMore: false, results: [] };
}

// ----------------------------
// Routes
// ----------------------------
app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const page = clampInt(req.query.page, 1, 1, 999);

    if (!q) {
      return res.json({ page, hasMore: false, results: [] });
    }

    const results = [];
    let hasMore = false;

    if (ENABLE_GUTENBERG) {
      const g = await searchGutenberg(q, page);
      results.push(...g.results);
      hasMore = hasMore || g.hasMore;
    }

    if (ENABLE_STANDARD_EBOOKS) {
      try {
        const se = await searchStandardEbooks(q, page);
        results.push(...se.results);
        hasMore = hasMore || se.hasMore;
      } catch (e) {
        // Don’t fail whole search if SE is temporarily down
        console.warn("Standard Ebooks search failed:", e?.message || e);
      }
    }

    if (ENABLE_INTERNET_ARCHIVE) {
      const ia = await searchInternetArchive(q, page);
      results.push(...ia.results);
      hasMore = hasMore || ia.hasMore;
    }

    res.json({ page, hasMore, results });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.get("/download-best", async (req, res) => {
  try {
    const id = String(req.query.id || "").trim();
    if (!id) return res.status(400).send("Missing id");

    let pick;

    if (/^gutenberg:/i.test(id)) {
      pick = await gutenbergDownloadBest(id);
    } else if (/^se:/i.test(id)) {
      pick = await standardEbooksDownloadBest(id);
    } else {
      return res.status(400).send("Unknown id prefix");
    }

    const bytes = await fetchBytes(pick.url);

    res.setHeader("Content-Type", pick.mime);
    res.setHeader("Content-Disposition", `attachment; filename="${pick.filename}"`);
    res.status(200).send(Buffer.from(bytes));
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`✅ SpeedRead host running on port ${PORT}`);
});
  