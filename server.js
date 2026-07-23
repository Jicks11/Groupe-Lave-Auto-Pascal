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

/**
 * Ancien lien Render déjà envoyé aux participants → redirection vers le site propre.
 * /api/* reste sur Render (données partagées).
 */
const PUBLIC_SITE =
  process.env.LAVE_AUTO_PUBLIC_SITE || "https://jicks11.github.io/Groupe-Lave-Auto-Pascal/";
const REDIRECT_ENABLED = process.env.LAVE_AUTO_REDIRECT !== "0";

function wantsHtml(req) {
  const accept = String(req.headers.accept || "");
  return accept.includes("text/html") || req.method === "GET";
}

function redirectToPublicSite(req, res) {
  const target = PUBLIC_SITE.replace(/\/?$/, "/");
  // 302 pour pouvoir désactiver plus tard si besoin
  res.set("Cache-Control", "no-store");
  return res.redirect(302, target);
}

/** Page de secours branding (si redirect bloqué) */
function brandedRedirectHtml() {
  const target = PUBLIC_SITE.replace(/\/?$/, "/");
  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="refresh" content="0;url=${target}" />
  <title>Groupe Lave-auto</title>
  <style>
    html,body{margin:0;min-height:100%;background:#06151c;color:#f0fbff;
      font-family:Segoe UI,system-ui,sans-serif;display:grid;place-items:center}
    .card{text-align:center;padding:28px;max-width:360px}
    .logo{width:88px;height:88px;margin:0 auto 12px;border-radius:14px;background:#fff;
      display:grid;place-items:center;border:2px solid #e31c23}
    .name{color:#00205b;font-weight:900;background:#fff;display:inline-block;
      padding:4px 12px;border-radius:8px;margin-top:6px}
    a{color:#2fe0ff}
  </style>
  <script>location.replace(${JSON.stringify(target)});</script>
</head>
<body>
  <div class="card">
    <div class="logo"><span class="name">Pascal</span></div>
    <p>Ouverture du groupe…</p>
    <p><a href="${target}">Continuer</a></p>
  </div>
</body>
</html>`;
}

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

// Fichiers publics (fallback local / si redirect désactivé)
const publicDir = path.join(__dirname, "public");

// Lien Render déjà partagé → envoie tout le monde vers GitHub Pages (sauf /api)
app.get(["/", "/index.html"], (req, res) => {
  if (REDIRECT_ENABLED) {
    // Page branding + redirect JS (meilleur que rester sur Render)
    res.set("Cache-Control", "no-store");
    return res.status(200).type("html").send(brandedRedirectHtml());
  }
  return res.sendFile(path.join(publicDir, "index.html"));
});

app.use((req, res, next) => {
  if (!REDIRECT_ENABLED) return next();
  if (req.path.startsWith("/api/")) return next();
  // Assets/API non concernés : pages HTML → redirect
  if (wantsHtml(req) && (req.path === "/" || req.path.endsWith(".html") || !path.extname(req.path))) {
    return redirectToPublicSite(req, res);
  }
  next();
});

app.use(express.static(publicDir, { extensions: ["html"] }));

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  if (REDIRECT_ENABLED) return redirectToPublicSite(req, res);
  const index = path.join(publicDir, "index.html");
  if (fs.existsSync(index)) return res.sendFile(index);
  res.status(404).send("Not found");
});

ensureDataDir();
app.listen(PORT, () => {
  console.log(`Lave-auto listening on :${PORT}`);
  console.log(`Data file: ${DATA_PATH}`);
  if (REDIRECT_ENABLED) {
    console.log(`Browser redirect → ${PUBLIC_SITE}`);
  }
});
