import express from "express";
import cors from "cors";

const app = express();
app.use(cors());

const PORT = process.env.PORT || 10000;

// ===== Sources toggles =====
const ENABLE_GUTENBERG = true;
const ENABLE_STANDARD_EBOOKS = true;
const ENABLE_INTERNET_ARCHIVE = false; // заложили, но выключили

// ===== Helpers =====
function clampStr(s, max = 200) {
  s = (s ?? "").toString().trim();
  if (s.length > max) s = s.slice(0, max);
  return s;
}

function safeAsciiFilename(name) {
  // ASCII-only fallback for header "filename="
  const base = (name || "book")
    .toString()
    .replace(/[^\x20-\x7E]/g, "") // remove non-ascii
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return base.length ? base : "book";
}

function contentDisposition(filenameUtf8) {
  const fallback = safeAsciiFilename(filenameUtf8);
  const encoded = encodeURIComponent(filenameUtf8 || fallback);
  // RFC 5987 + safe fallback
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function pickBestFormat(formats) {
  // Prefer EPUB, then plain text
  const candidates = [
    "application/epub+zip",
    "application/x-mobipocket-ebook",
    "text/plain; charset=utf-8",
    "text/plain",
  ];

  for (const mime of candidates) {
    const url = formats?.[mime];
    if (url) return { mime, url };
  }

  // Some Gutenberg entries have "text/plain; charset=us-ascii" etc
  const key = Object.keys(formats || {}).find((k) => k.startsWith("text/plain"));
  if (key) return { mime: key, url: formats[key] };

  return null;
}

function normalizeBook({ id, title, author, lang, source, formats }) {
  return {
    id,
    title: title || "",
    author: author || "",
    lang: lang || "",
    source,
    formats: formats || [],
  };
}

// ===== Gutenberg (Gutendex) =====
async function searchGutenberg(q) {
  // Gutendex: https://gutendex.com/
  const url = `https://gutendex.com/books/?search=${encodeURIComponent(q)}`;
  const r = await fetch(url, { headers: { "User-Agent": "SpeedRead/1.0" } });
  if (!r.ok) throw new Error(`Gutenberg search failed: ${r.status}`);
  const data = await r.json();

  const results = (data.results || []).slice(0, 30).map((b) => {
    const title = b.title || "";
    const author = (b.authors && b.authors[0] && b.authors[0].name) ? b.authors[0].name : "";
    const lang = (b.languages && b.languages[0]) ? b.languages[0] : "";
    const formats = b.formats || {};
    const available = Object.keys(formats || {});
    return normalizeBook({
      id: `gutenberg:${b.id}`,
      title,
      author,
      lang,
      source: "gutenberg",
      formats: available,
    });
  });

  return results;
}

async function downloadGutenberg(gId) {
  // gId is numeric Gutenberg book id
  const url = `https://gutendex.com/books/${encodeURIComponent(gId)}`;
  const r = await fetch(url, { headers: { "User-Agent": "SpeedRead/1.0" } });
  if (!r.ok) throw new Error(`Gutenberg book failed: ${r.status}`);
  const b = await r.json();

  const best = pickBestFormat(b.formats || {});
  if (!best) throw new Error("No downloadable format found");

  const fileResp = await fetch(best.url, { headers: { "User-Agent": "SpeedRead/1.0" } });
  if (!fileResp.ok) throw new Error(`Download failed: ${fileResp.status}`);

  const bytes = Buffer.from(await fileResp.arrayBuffer());
  // Extension guess
  let ext = ".bin";
  const mimeLower = (best.mime || "").toLowerCase();
  if (mimeLower.includes("epub")) ext = ".epub";
  else if (mimeLower.includes("text/plain")) ext = ".txt";
  else if (mimeLower.includes("mobipocket") || mimeLower.includes("mobi")) ext = ".mobi";

  const title = b.title || `gutenberg-${gId}`;
  const filename = `${title}${ext}`;

  return {
    bytes,
    contentType: best.mime.split(";")[0] || "application/octet-stream",
    filename,
  };
}

// ===== Standard Ebooks (OPDS feed) =====
async function searchStandardEbooks(q) {
  // OPDS: https://standardebooks.org/opds/all?query=...
  const url = `https://standardebooks.org/opds/all?query=${encodeURIComponent(q)}`;
  const r = await fetch(url, { headers: { "User-Agent": "SpeedRead/1.0" } });
  if (!r.ok) throw new Error(`Standard Ebooks search failed: ${r.status}`);
  const xml = await r.text();

  // Very lightweight parsing (good enough for OPDS)
  const entries = xml.split("<entry>").slice(1);
  const results = [];

  for (const e of entries.slice(0, 30)) {
    const titleMatch = e.match(/<title>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].replace(/&amp;/g, "&").trim() : "";

    const authorMatch = e.match(/<name>([\s\S]*?)<\/name>/i);
    const author = authorMatch ? authorMatch[1].replace(/&amp;/g, "&").trim() : "";

    // Prefer open-access acquisition (usually epub)
    const linkMatch =
      e.match(/<link[^>]*rel="http:\/\/opds-spec\.org\/acquisition\/open-access"[^>]*href="([^"]+)"[^>]*type="([^"]+)"[^>]*\/?>/i) ||
      e.match(/<link[^>]*href="([^"]+)"[^>]*type="application\/epub\+zip"[^>]*\/?>/i);

    const href = linkMatch ? linkMatch[1] : "";
    const type = linkMatch ? (linkMatch[2] || "application/epub+zip") : "";

    // ID: use href as stable id
    if (title && href) {
      results.push(
        normalizeBook({
          id: `standard:${href}`,
          title,
          author,
          lang: "en",
          source: "standard",
          formats: [type],
        })
      );
    }
  }

  return results;
}

async function downloadStandardEbooks(href) {
  const fileResp = await fetch(href, { headers: { "User-Agent": "SpeedRead/1.0" } });
  if (!fileResp.ok) throw new Error(`Download failed: ${fileResp.status}`);

  const bytes = Buffer.from(await fileResp.arrayBuffer());

  // Try to get filename from final URL
  const finalUrl = fileResp.url || href;
  const last = finalUrl.split("/").pop() || "standard-ebook.epub";
  const filename = decodeURIComponent(last);

  return {
    bytes,
    contentType: "application/epub+zip",
    filename: filename.endsWith(".epub") ? filename : `${filename}.epub`,
  };
}

// ===== Internet Archive (placeholder; disabled) =====
async function searchInternetArchive(_q) {
  if (!ENABLE_INTERNET_ARCHIVE) return [];
  return [];
}

// ===== Routes =====
app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/search", async (req, res) => {
  try {
    const q = clampStr(req.query.q, 120);
    if (!q) return res.json({ page: 1, hasMore: false, results: [] });

    const tasks = [];

    if (ENABLE_GUTENBERG) tasks.push(searchGutenberg(q));
    if (ENABLE_STANDARD_EBOOKS) tasks.push(searchStandardEbooks(q));
    if (ENABLE_INTERNET_ARCHIVE) tasks.push(searchInternetArchive(q));

    const chunks = await Promise.allSettled(tasks);
    const results = [];

    for (const c of chunks) {
      if (c.status === "fulfilled") results.push(...c.value);
    }

    res.json({ page: 1, hasMore: false, results });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.get("/download-best", async (req, res) => {
  try {
    const id = clampStr(req.query.id, 400);
    if (!id) return res.status(400).send("Missing id");

    const [source, rest] = id.split(":", 2);
    let out;

    if (source === "gutenberg") {
      out = await downloadGutenberg(rest);
    } else if (source === "standard") {
      // rest is URL (href)
      const href = id.slice("standard:".length);
      out = await downloadStandardEbooks(href);
    } else if (source === "archive") {
      if (!ENABLE_INTERNET_ARCHIVE) {
        return res.status(400).json({ error: "Internet Archive source is disabled (stage 1)." });
      }
      return res.status(400).json({ error: "Internet Archive not implemented yet." });
    } else {
      return res.status(400).json({ error: "Unknown source" });
    }

    res.setHeader("Content-Type", out.contentType || "application/octet-stream");
    res.setHeader("Content-Disposition", contentDisposition(out.filename || "book.bin"));
    res.send(out.bytes);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`✅ SpeedRead proxy running on port ${PORT}`);
});
