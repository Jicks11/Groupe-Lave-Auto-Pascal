/**
 * Groupe Lave-auto Couche-Tard
 * Même logique que les groupes Loto : app complète (UI + API) sur Render,
 * données persistantes en PostgreSQL si DATABASE_URL est défini.
 */
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 5190;
const DATA_PATH =
  process.env.LAVE_AUTO_DATA_PATH ||
  process.env.DATA_PATH ||
  path.join(__dirname, "data", "state.json");
const ADMIN_PIN = process.env.LAVE_AUTO_ADMIN_PIN || process.env.ADMIN_PIN || "2020";
const DATABASE_URL =
  process.env.DATABASE_URL ||
  process.env.SUPABASE_DB_CONNECTION ||
  process.env.LAVE_AUTO_DATABASE_URL ||
  "";

let pool = null;

async function initDb() {
  if (!DATABASE_URL) {
    console.log("Storage: file", DATA_PATH);
    return;
  }
  try {
    const { Pool } = require("pg");
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false }
    });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lave_auto_state (
        id integer PRIMARY KEY DEFAULT 1,
        payload jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    console.log("Storage: postgres (lave_auto_state)");
  } catch (err) {
    console.error("Postgres init failed, fallback file:", err.message);
    pool = null;
  }
}

function ensureDataDir() {
  const dir = path.dirname(DATA_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function readState() {
  if (pool) {
    try {
      const result = await pool.query(
        "SELECT payload FROM lave_auto_state WHERE id = 1 LIMIT 1"
      );
      if (result.rows[0]?.payload) {
        return result.rows[0].payload;
      }
      return null;
    } catch (err) {
      console.error("readState pg:", err.message);
    }
  }
  try {
    if (!fs.existsSync(DATA_PATH)) return null;
    const raw = fs.readFileSync(DATA_PATH, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.error("readState file:", err.message);
    return null;
  }
}

async function writeState(state) {
  if (pool) {
    await pool.query(
      `
      INSERT INTO lave_auto_state (id, payload, updated_at)
      VALUES (1, $1::jsonb, now())
      ON CONFLICT (id)
      DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()
      `,
      [JSON.stringify(state)]
    );
    // Miroir fichier (secours)
    try {
      ensureDataDir();
      fs.writeFileSync(DATA_PATH, JSON.stringify(state, null, 2), "utf8");
    } catch {
      /* ignore */
    }
    return;
  }
  ensureDataDir();
  const tmp = `${DATA_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, DATA_PATH);
}

const app = express();
app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"]
  })
);
app.use(express.json({ limit: "3mb" }));

app.get("/api/ping", (_req, res) => {
  res.json({
    ok: true,
    app: "groupe-lave-auto",
    storage: pool ? "postgres" : "file",
    at: new Date().toISOString()
  });
});

app.get("/api/health", async (_req, res) => {
  const state = await readState();
  res.json({
    ok: true,
    hasState: !!state,
    storage: pool ? "postgres" : "file",
    at: new Date().toISOString()
  });
});

app.get("/api/state", async (_req, res) => {
  const state = await readState();
  res.set("Cache-Control", "no-store");
  res.json({
    ok: true,
    state,
    updatedAt: state?.updatedAt || null,
    source: state ? "server" : "empty",
    storage: pool ? "postgres" : "file"
  });
});

app.post("/api/state", async (req, res) => {
  const pin = String(req.body?.adminPin || "");
  if (pin !== ADMIN_PIN) {
    return res.status(401).json({ ok: false, error: "PIN admin incorrect" });
  }
  const state = req.body?.state;
  if (!state || typeof state !== "object" || !Array.isArray(state.members)) {
    return res.status(400).json({ ok: false, error: "État invalide" });
  }
  state.updatedAt = new Date().toISOString();
  state.groupName = state.groupName || "Groupe Lave-auto Couche-Tard";
  try {
    await writeState(state);
    return res.json({
      ok: true,
      updatedAt: state.updatedAt,
      storage: pool ? "postgres" : "file"
    });
  } catch (err) {
    console.error("writeState error", err.message);
    return res.status(500).json({ ok: false, error: "Erreur sauvegarde" });
  }
});

// App complète même origine (comme Loto) — plus de redirect Pages
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir, {
  extensions: ["html"],
  setHeaders(res, filePath) {
    if (filePath.endsWith("sw.js")) {
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Service-Worker-Allowed", "/");
    }
    if (filePath.endsWith("manifest.webmanifest")) {
      res.setHeader("Content-Type", "application/manifest+json; charset=utf-8");
    }
  }
}));

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  const index = path.join(publicDir, "index.html");
  if (fs.existsSync(index)) return res.sendFile(index);
  res.status(404).send("Not found");
});

(async () => {
  ensureDataDir();
  await initDb();
  app.listen(PORT, () => {
    console.log(`Lave-auto listening on :${PORT}`);
    console.log(`Storage: ${pool ? "postgres" : "file " + DATA_PATH}`);
  });
})();
