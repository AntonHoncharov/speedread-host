import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());

const PORT = process.env.PORT || 10000;

/* ===============================
   SOURCES SWITCHES
================================ */
const ENABLE_GUTENBERG = true;
const ENABLE_STANDARD_EBOOKS = true;
const ENABLE_INTERNET_ARCHIVE = false; // ⏸ выключен, задел на будущее

/* ===============================
   HELPERS
================================ */
function normalizeText(s) {
  return s?.replace(/\s+/g, " ").trim() || "";
}

function makeId(prefix, value) {
  return `${prefix}:${value}`;
}

/* ===============================
   GUTENBERG
================================ */
async function searchGutenberg(q) {
  const url = `https://gutendex.com/books/?search=${encodeURIComponent(q)}`;
  const res = await fetch(url);
  const json = await res.json();

  return (json.results || []).map(b => ({
    id: makeId("gutenberg", b.id),
    title: normalizeText(b.title),
    author: normalizeText(b.authors?.[0]?.name || "Unknown author"),
    downloadUrl:
      b.formats["application/epub+zip"] ||
      b.formats["text/plain; charset=utf-8"] ||
      b.formats["text/plain"]
  })).filter(b => b.downloadUrl);
}

async function downloadGutenberg(id) {
  const bookId = id.split(":")[1];
  const url = `https://gutendex.com/books/${bookId}`;
  const res = await fetch(url);
  const json = await res.json();

  const fileUrl =
    json.formats["application/epub+zip"] ||
    json.formats["text/plain; charset=utf-8"] ||
    json.formats["text/plain"];

  if (!fileUrl) throw new Error("No downloadable file");

  return fetch(fileUrl);
}

/* ===============================
   STANDARD EBOOKS
================================ */
async function searchStandardEbooks(q) {
  const indexUrl = "https://standardebooks.org/opds/all";
  const res = await fetch(indexUrl);
  const xml = await res.text();

  const regex = /<entry>([\s\S]*?)<\/entry>/g;
  const results = [];

  let match;
  while ((match = regex.exec(xml)) !== null) {
    const entry = match[1];

    const title = entry.match(/<title>(.*?)<\/title>/)?.[1];
    const author = entry.match(/<name>(.*?)<\/name>/)?.[1];
    const epub = entry.match(/href="(https:\/\/standardebooks\.org\/ebooks\/[^"]+\.epub)"/)?.[1];

    if (!title || !epub) continue;
    if (!title.toLowerCase().includes(q.toLowerCase())) continue;

    results.push({
      id: makeId("se", epub),
      title: normalizeText(title),
      author: normalizeText(author || "Unknown author"),
      downloadUrl: epub
    });
  }

  return results;
}

async function downloadStandardEbooks(id) {
  const url = id.replace("se:", "");
  return fetch(url);
}

/* ===============================
   INTERNET ARCHIVE (OFF)
================================ */
// Заглушка — логика есть, но источник выключен
async function searchInternetArchive(_) {
  return [];
}

/* ===============================
   SEARCH ENDPOINT
================================ */
app.get("/search", async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json({ results: [] });

  let results = [];

  try {
    if (ENABLE_GUTENBERG) {
      results.push(...await searchGutenberg(q));
    }

    if (ENABLE_STANDARD_EBOOKS) {
      results.push(...await searchStandardEbooks(q));
    }

    if (ENABLE_INTERNET_ARCHIVE) {
      results.push(...await searchInternetArchive(q));
    }

    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ===============================
   DOWNLOAD ENDPOINT
================================ */
app.get("/download", async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).send("Missing id");

  try {
    let response;

    if (id.startsWith("gutenberg:")) {
      response = await downloadGutenberg(id);
    } else if (id.startsWith("se:")) {
      response = await downloadStandardEbooks(id);
    } else {
      return res.status(400).send("Unknown source");
    }

    res.setHeader("Content-Type", response.headers.get("content-type") || "application/octet-stream");
    res.setHeader("Content-Disposition", "attachment");

    response.body.pipe(res);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

/* ===============================
   START
================================ */
app.listen(PORT, () => {
  console.log(`✅ SpeedReader server running on port ${PORT}`);
});
