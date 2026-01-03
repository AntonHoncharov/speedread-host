/**
 * SpeedRead Proxy — multi-source
 * Sources:
 * - Project Gutenberg (Gutendex)
 * - Wikisource RU
 * - Wikisource UA
 *
 * Endpoints:
 * GET /health
 * GET /search?q=...&page=1
 * GET /download-best?id=...
 */

import express from "express";
import cors from "cors";

const app = express();

// ================= CONFIG =================
const PORT = process.env.PORT || 8787;

// Gutenberg
const GUTENDEX = "https://gutendex.com/books";

// Wikisource (MediaWiki API)
const WS_RU = "https://ru.wikisource.org/w/api.php";
const WS_UA = "https://uk.wikisource.org/w/api.php";

// ================= MIDDLEWARE =================
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.type("text/plain").send("SpeedRead API OK");
});

app.get("/health", (req, res) => {
  res.type("text/plain").send("OK");
});

// ================= HELPERS =================
function safeInt(v, def = 1) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

// Unified ID format:
// - gutenberg:<number>
// - wsrc-ru:<encodedTitle>
// - wsrc-ua:<encodedTitle>
function makeId(source, raw) {
  if (source === "gutenberg") return `gutenberg:${raw}`;
  if (source === "wsrc-ru") return `wsrc-ru:${encodeURIComponent(raw)}`;
  if (source === "wsrc-ua") return `wsrc-ua:${encodeURIComponent(raw)}`;
  throw new Error("Unknown source");
}

function parseId(id) {
  if (!id || typeof id !== "string") return null;
  const [prefix, rest] = id.split(":");
  if (!rest) return null;
  if (prefix === "gutenberg") return { source: "gutenberg", value: rest };
  if (prefix === "wsrc-ru") return { source: "wsrc-ru", value: decodeURIComponent(rest) };
  if (prefix === "wsrc-ua") return { source: "wsrc-ua", value: decodeURIComponent(rest) };
  return null;
}

function stripHtmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|br|h1|h2|h3|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ----- Content-Disposition (ASCII safe + RFC5987 filename*) -----

// Превращаем имя в ASCII-fallback: только [a-zA-Z0-9._-]
function asciiFallbackName(name, ext) {
  const base = (name || "book")
    .toString()
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "") // убрать всё не-ASCII
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");

  const safeBase = base.length ? base : "book";
  const safeExt = ext.startsWith(".") ? ext : `.${ext}`;
  return `${safeBase}${safeExt}`;
}

// RFC5987: filename*=UTF-8''<percent-encoded>
function rfc5987Encode(str) {
  return encodeURIComponent(str)
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/\*/g, "%2A");
}

function setDownloadHeaders(res, filenameUnicode, mime, ext) {
  const safeExt = ext.startsWith(".") ? ext : `.${ext}`;
  const fallback = asciiFallbackName(filenameUnicode, safeExt);
  const encoded = rfc5987Encode(`${filenameUnicode || "book"}${safeExt}`);

  // ВАЖНО: вся строка заголовка — ASCII, поэтому Node не падает
  const cd =
    `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;

  res.setHeader("Content-Type", mime);
  res.setHeader("Content-Disposition", cd);

  // Иногда полезно для прокси/браузеров
  res.setHeader("X-Content-Type-Options", "nosniff");
}

// ================= SEARCH: Gutenberg =================
async function searchGutenberg(q, page) {
  const url = `${GUTENDEX}?search=${encodeURIComponent(q)}&page=${page}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("Gutendex fetch failed");
  const data = await r.json();

  const items = (data.results || []).map((b) => ({
    id: makeId("gutenberg", b.id),
    title: b.title,
    author: (b.authors || []).map((a) => a.name).join(", "),
    lang: (b.languages || [])[0] || "",
    source: "gutenberg",
    formats: Object.keys(b.formats || {}),
  }));

  return { items, hasMore: Boolean(data.next) };
}

// ================= SEARCH: Wikisource =================
async function searchWikisource(apiUrl, q, page, tag) {
  const limit = 20;
  const offset = (page - 1) * limit;

  const url =
    `${apiUrl}?action=query&list=search` +
    `&srsearch=${encodeURIComponent(q)}` +
    `&srlimit=${limit}` +
    `&sroffset=${offset}` +
    `&format=json&origin=*`;

  const r = await fetch(url);
  if (!r.ok) throw new Error(`Wikisource ${tag} search failed`);
  const data = await r.json();

  const results = (data?.query?.search || []);
  const items = results.map((x) => ({
    id: makeId(tag, x.title),
    title: x.title,
    author: "",
    lang: tag === "wsrc-ua" ? "uk" : "ru",
    source: tag,
    formats: ["text/plain"]
  }));

  const total = data?.query?.searchinfo?.totalhits ?? 0;
  const hasMore = offset + results.length < total;

  return { items, hasMore };
}

// ================= DOWNLOAD: Gutenberg =================
async function downloadGutenberg(gutenbergId) {
  const r = await fetch(`${GUTENDEX}/${gutenbergId}`);
  if (!r.ok) throw new Error("Book not found");
  const book = await r.json();
  const formats = book.formats || {};

  // priority: txt > epub > html
  const candidates = [
    "text/plain; charset=utf-8",
    "text/plain",
    "application/epub+zip",
    "text/html; charset=utf-8"
  ];

  let url = null;
  let mime = null;

  for (const c of candidates) {
    if (formats[c]) {
      url = formats[c];
      mime = c;
      break;
    }
  }
  if (!url) throw new Error("No readable format found");

  const fileResp = await fetch(url);
  if (!fileResp.ok) throw new Error("Failed to fetch book file");

  const buffer = Buffer.from(await fileResp.arrayBuffer());

  // Определим “что это” и какое расширение отдавать
  let outMime = "application/octet-stream";
  let ext = "bin";

  if (mime.includes("epub")) {
    outMime = "application/epub+zip";
    ext = "epub";
  } else if (mime.includes("text/plain")) {
    outMime = "text/plain; charset=utf-8";
    ext = "txt";
  } else if (mime.includes("text/html")) {
    outMime = "text/plain; charset=utf-8";
    ext = "txt";
  }

  return {
    title: book.title || `gutenberg_${gutenbergId}`,
    mime: outMime,
    ext,
    buffer
  };
}

// ================= DOWNLOAD: Wikisource =================
async function downloadWikisource(apiUrl, title, tag) {
  const url =
    `${apiUrl}?action=parse&prop=text` +
    `&page=${encodeURIComponent(title)}` +
    `&format=json&origin=*`;

  const r = await fetch(url);
  if (!r.ok) throw new Error(`Wikisource ${tag} parse failed`);
  const data = await r.json();

  const html = data?.parse?.text?.["*"];
  if (!html) throw new Error("No text on page (maybe redirect/protected)");

  const text = stripHtmlToText(html);

  return {
    title,
    mime: "text/plain; charset=utf-8",
    ext: "txt",
    buffer: Buffer.from(text, "utf-8")
  };
}

// ================= PUBLIC SEARCH =================
app.get("/search", async (req, res) => {
  try {
    const q = (req.query.q || "").toString().trim();
    const page = safeInt(req.query.page, 1);

    if (!q) return res.status(400).json({ error: "Query is empty" });

    const [g, ru, ua] = await Promise.allSettled([
      searchGutenberg(q, page),
      searchWikisource(WS_RU, q, page, "wsrc-ru"),
      searchWikisource(WS_UA, q, page, "wsrc-ua"),
    ]);

    const items = [];
    let hasMore = false;

    for (const r of [g, ru, ua]) {
      if (r.status === "fulfilled") {
        items.push(...r.value.items);
        hasMore = hasMore || r.value.hasMore;
      }
    }

    const hasCyr = /[А-Яа-яЁёІіЇїЄєҐґ]/.test(q);
    items.sort((a, b) => {
      const w = (x) => {
        if (!hasCyr) return x.source === "gutenberg" ? 0 : 1;
        if (x.source === "wsrc-ru") return 0;
        if (x.source === "wsrc-ua") return 0;
        return 2;
      };
      return w(a) - w(b);
    });

    res.json({
      page,
      hasMore,
      results: items
    });

  } catch (err) {
    res.status(500).json({ error: err.message || "Unknown error" });
  }
});

// ================= PUBLIC DOWNLOAD =================
app.get("/download-best", async (req, res) => {
  try {
    const id = req.query.id?.toString();
    if (!id) return res.status(400).json({ error: "Missing id" });

    const parsed = parseId(id);
    if (!parsed) return res.status(400).json({ error: "Bad id format" });

    let file;

    if (parsed.source === "gutenberg") {
      file = await downloadGutenberg(parsed.value);
    } else if (parsed.source === "wsrc-ru") {
      file = await downloadWikisource(WS_RU, parsed.value, "wsrc-ru");
    } else if (parsed.source === "wsrc-ua") {
      file = await downloadWikisource(WS_UA, parsed.value, "wsrc-ua");
    } else {
      return res.status(400).json({ error: "Unknown source" });
    }

    // ✅ ВАЖНО: заголовок теперь валидный (ASCII) и не валит сервер
    const title = (file.title || "book").toString();
    setDownloadHeaders(res, title, file.mime, file.ext);

    res.send(file.buffer);

  } catch (err) {
    res.status(500).json({ error: err.message || "Unknown error" });
  }
});

// ================= START =================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ SpeedRead proxy running on port ${PORT}`);
});
