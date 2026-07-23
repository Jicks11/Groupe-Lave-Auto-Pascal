/**
 * Groupe Lave-auto Couche-Tard
 * API d'état partagé + fichiers statiques
 * Indépendant des groupes Loto Max / 6/49
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

const app = express();
app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"]
  })
);
app.use(express.json({ limit: "3mb" }));

// Si quelqu’un ouvre encore l’URL Render « nue », redirige vers le site propre (GitHub Pages)
// sauf pour /api/* et les assets déjà servis ici.
const PUBLIC_SITE = process.env.LAVE_AUTO_PUBLIC_SITE || "https://jicks11.github.io/Groupe-Lave-Auto-Pascal/";
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  // Laisser le front Render fonctionner aussi (fallback) — pas de redirect forcé
  // pour éviter de casser si Pages n’est pas encore actif.
  next();
});

function ensureDataDir() {
  const dir = path.dirname(DATA_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readState() {
  try {
    if (!fs.existsSync(DATA_PATH)) return null;
    const raw = fs.readFileSync(DATA_PATH, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.error("readState error", err.message);
    return null;
  }
}

function writeState(state) {
  ensureDataDir();
  const tmp = `${DATA_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, DATA_PATH);
}

app.get("/api/ping", (_req, res) => {
  res.json({
    ok: true,
    app: "groupe-lave-auto",
    at: new Date().toISOString()
  });
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    hasState: fs.existsSync(DATA_PATH),
    at: new Date().toISOString()
  });
});

/** Lecture publique de l'état (soldes visibles par tout le groupe) */
app.get("/api/state", (_req, res) => {
  const state = readState();
  res.set("Cache-Control", "no-store");
  res.json({
    ok: true,
    state,
    updatedAt: state?.updatedAt || null,
    source: state ? "server" : "empty"
  });
});

/** Écriture réservée au PIN admin */
app.post("/api/state", (req, res) => {
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
    writeState(state);
    return res.json({ ok: true, updatedAt: state.updatedAt });
  } catch (err) {
    console.error("writeState error", err.message);
    return res.status(500).json({ ok: false, error: "Erreur sauvegarde" });
  }
});

// Fichiers publics
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir, { extensions: ["html"] }));

// SPA fallback
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  const index = path.join(publicDir, "index.html");
  if (fs.existsSync(index)) return res.sendFile(index);
  res.status(404).send("Not found");
});

ensureDataDir();
app.listen(PORT, () => {
  console.log(`Lave-auto listening on :${PORT}`);
  console.log(`Data file: ${DATA_PATH}`);
});
