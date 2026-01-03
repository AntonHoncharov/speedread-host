/**
 * SpeedRead Host — Stage 1
 * Sources:
 *  ✅ Project Gutenberg (Gutendex)
 *  ✅ Standard Ebooks (через Gutenberg)
 *  💤 Internet Archive (disabled, scaffold only)
 *
 * Node 18+ (global fetch)
 */

import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 8787;

// ================= CONFIG =================
const GUTENDEX = "https://gutendex.com/books";

// ================= MIDDLEWARE =================
app.use(cors());
app.use(express.json());

// ================= HEALTH =================
app.get("/health", (_, res) => {
  res.type("text/plain").send("OK");
});

// ================= SEARCH =================
app.get("/search", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    const page = req.query.page || 1;

    if (!q) {
      return res.status(400).json({ error: "Empty query" });
    }

    const url = `${GUTENDEX}?search=${encodeURIComponent(q)}&page=${page}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error("Gutendex request failed");

    const data = await r.json();

    const results = data.results.map(b => ({
      id: b.id,
      title: b.title,
      author: (b.authors || []).map(a => a.name).join(", "),
      lang: (b.languages || [])[0] || "en"
    }));

    res.json({
      page,
      hasMore: Boolean(data.next),
      results
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ================= DOWNLOAD =================
app.get("/download-best", async (req, res) => {
  try {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: "Missing id" });

    // 1️⃣ Получаем метаданные книги
    const metaResp = await fetch(`${GUTENDEX}/${id}`);
    if (!metaResp.ok) throw new Error("Book metadata not found");

    const book = await metaResp.json();
    const formats = book.formats || {};

    // 2️⃣ Фильтруем только ПОЛНЫЕ КНИГИ
    const candidates = [
      "text/plain; charset=utf-8",
      "text/plain",
      "application/epub+zip"
    ];

    let fileUrl = null;
    let mime = null;

    for (const c of candidates) {
      if (formats[c]) {
        fileUrl = formats[c];
        mime = c;
        break;
      }
    }

    if (!fileUrl) {
      return res.status(404).json({
        error: "No full book format found"
      });
    }

    // ❌ отсекаем index/list страницы
    if (fileUrl.includes("index") || fileUrl.includes("contents")) {
      return res.status(400).json({
        error: "Index/list page — not a full book"
      });
    }

    // 3️⃣ Скачиваем файл
    const fileResp = await fetch(fileUrl);
    if (!fileResp.ok) throw new Error("File download failed");

    const buffer = Buffer.from(await fileResp.arrayBuffer());

    // ❌ Минимальный размер (защита от аннотаций)
    if (buffer.length < 15_000) {
      return res.status(400).json({
        error: "File too small — probably not a full book"
      });
    }

    const safeName = book.title
      .replace(/[^a-z0-9а-яё]/gi, "_")
      .slice(0, 80);

    res.setHeader(
      "Content-Type",
      mime.includes("epub") ? "application/epub+zip" : "text/plain; charset=utf-8"
    );
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${safeName}${mime.includes("epub") ? ".epub" : ".txt"}"`
    );

    res.send(buffer);

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ================= INTERNET ARCHIVE (DISABLED) =================
// TODO: later
// app.get("/ia-search", ...)

// ================= START =================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ SpeedRead Host running on port ${PORT}`);
});
   