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

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Fetch failed: ${r.status} ${r.statusText}`);
  return await r.json();
}

// ----- Content-Disposition (ASCII safe + RFC5987 filename*) -----

// ASCII fallback: только [a-zA-Z0-9._-]
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
  const cd = `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;

  res.setHeader("Content-Type", mime);
  res.setHeader("Content-Disposition", cd);
  res.setHeader("X-Content-Type-Options", "nosniff");
}

// ================= SEARCH: Gutenberg =================
async function searchGutenberg(q, page) {
  const url = `${GUTENDEX}?search=${encodeURIComponent(q)}&page=${page}`;
  const data = await fetchJson(url);

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

  const data = await fetchJson(url);

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

// ================= Wikisource: smart download (plain text + auto-follow) =================

function isBadWikisourceTitle(t) {
  if (!t) return true;
  // отсекаем служебные пространства имён
  const badPrefixes = [
    "Категория:", "Category:",
    "Служебная:", "Special:",
    "Файл:", "File:",
    "Шаблон:", "Template:",
    "Обсуждение:", "Talk:",
    "Портал:", "Portal:",
    "Викиисточник:", "Wikisource:",
    "Index:", "Page:",
    "Автор:", "Author:"
  ];
  const s = t.trim();
  return badPrefixes.some((p) => s.startsWith(p));
}

function looksLikeIndexOrList(title, text) {
  const t = (title || "").trim();

  if (isBadWikisourceTitle(t)) return true;

  const x = (text || "").trim();
  if (!x) return true;

  // короткий текст часто означает "оглавление/указатель"
  if (x.length < 2000) {
    // но бывает короткое стихотворение — оставим шанс:
    // если очень много строк со списками/ссылками — точно индекс
    const lines = x.split("\n");
    const listy = lines.filter((l) => /^\s*[\*\-•]/.test(l)).length;
    if (listy >= 8) return true;
  }

  // явные маркеры содержания/указателя
  if (/==\s*(Содержание|Зміст|Contents)\s*==/i.test(x)) return true;
  if (/Оглавление|Зміст|Содержание/i.test(x) && x.length < 8000) return true;

  // страницы автора/списков
  if (/Произведения|Твори|Works/i.test(x) && x.length < 12000) return true;

  return false;
}

async function getWikisourcePlain(apiUrl, title) {
  // Plain text без HTML-энтити: extracts + explaintext
  const url =
    `${apiUrl}?action=query&prop=extracts` +
    `&explaintext=1&exsectionformat=plain` +
    `&redirects=1` +
    `&titles=${encodeURIComponent(title)}` +
    `&format=json&origin=*`;

  const data = await fetchJson(url);

  const pages = data?.query?.pages || {};
  const page = Object.values(pages)[0];

  if (!page || page.missing) throw new Error("Page not found");

  const outTitle = page.title || title;
  const text = (page.extract || "").trim();

  return { title: outTitle, text };
}

async function getWikisourceCandidateLinks(apiUrl, title, max = 80) {
  const url =
    `${apiUrl}?action=query&prop=links` +
    `&pllimit=${Math.min(max, 200)}` +
    `&titles=${encodeURIComponent(title)}` +
    `&format=json&origin=*`;

  const data = await fetchJson(url);
  const pages = data?.query?.pages || {};
  const page = Object.values(pages)[0];
  const links = page?.links || [];
  return links.map((l) => l.title).filter(Boolean);
}

function pickBestLink(currentTitle, links) {
  const cur = (currentTitle || "").trim();
  const filtered = links
    .map((s) => s.trim())
    .filter((s) => s && s !== cur)
    .filter((s) => !isBadWikisourceTitle(s));

  if (filtered.length === 0) return null;

  // Простая эвристика:
  // 1) предпочитаем без двоеточий (обычные страницы)
  // 2) предпочитаем то, что не похоже на "список"
  // 3) берем первый
  const noColon = filtered.filter((s) => !s.includes(":"));
  return (noColon[0] || filtered[0]) ?? null;
}

async function downloadWikisourceSmart(apiUrl, title, tag) {
  // 1) берём plain text текущей страницы
  let hopTitle = title;
  let { title: resolvedTitle, text } = await getWikisourcePlain(apiUrl, hopTitle);

  // 2) если это похоже на индекс/список — попробуем перейти по ссылкам на "произведение"
  // максимум 2 перехода, чтобы не зациклиться
  for (let hop = 0; hop < 2; hop++) {
    if (!looksLikeIndexOrList(resolvedTitle, text)) break;

    const links = await getWikisourceCandidateLinks(apiUrl, resolvedTitle, 120);
    const best = pickBestLink(resolvedTitle, links);
    if (!best) break;

    hopTitle = best;
    const next = await getWikisourcePlain(apiUrl, hopTitle);

    // если мы не продвинулись — стоп
    if (next.title === resolvedTitle) break;

    resolvedTitle = next.title;
    text = next.text;
  }

  if (!text || looksLikeIndexOrList(resolvedTitle, text)) {
    // Важно: лучше честно сказать, чем отдавать "оглавление вместо книги"
    throw new Error("This looks like an index/list page. Please choose a specific work page.");
  }

  return {
    title: resolvedTitle,
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

    // лёгкая сортировка: если кириллица — чаще интереснее wsrc-ru/ua
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
      file = await downloadWikisourceSmart(WS_RU, parsed.value, "wsrc-ru");
    } else if (parsed.source === "wsrc-ua") {
      file = await downloadWikisourceSmart(WS_UA, parsed.value, "wsrc-ua");
    } else {
      return res.status(400).json({ error: "Unknown source" });
    }

    // ✅ заголовки скачивания (без падений на кириллице)
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
