/**
 * Groupe Lave-auto Couche-Tard (Pascal)
 * 9 membres · 39,60 $ / mois · échéance le 20 à 00:01
 * Sync serveur (/api/state) + cache localStorage
 */

const STORAGE_KEY = "lave-auto-state-v4";
const SELECTED_KEY = "lave-auto-selected-member";
const ADMIN_PIN_KEY = "lave-auto-admin-pin";
const DEFAULT_ADMIN_PIN = "2020";
const SHEET_SEED_VERSION = "feuille-2026-07-22-autofee";
/** Premier mois où le prélèvement auto peut s'appliquer (AAAA-MM) */
const FEE_START_YEAR_MONTH = "2026-08";
const FEE_CHECK_INTERVAL_MS = 30000;
const REFRESH_INTERVAL_MS = 25000;

/** Même origine en prod Render ; override possible via window.LAVE_AUTO_API_ORIGIN */
const API_ORIGIN = String(window.LAVE_AUTO_API_ORIGIN || "").replace(/\/$/, "");
const API_BASE = `${API_ORIGIN}/api`;

let serverSyncEnabled = true;
let serverSaveInFlight = false;
let lastServerUpdatedAt = null;

// Noms + soldes d’après la feuille Couche-Tard (22 juillet 2026)
const DEFAULT_MEMBERS = [
  { id: "m1", name: "Pascal Taillefer", active: true },
  { id: "m2", name: "Gabrielle Gagnon", active: true },
  { id: "m3", name: "Christian Taillefer", active: true },
  { id: "m4", name: "Nancy Reeves", active: true },
  { id: "m5", name: "Alexandre Genest", active: true },
  { id: "m6", name: "Alain Ashton", active: true },
  { id: "m7", name: "Réjean Léger", active: true },
  { id: "m8", name: "Annie Théoret", active: true },
  { id: "m9", name: "Luc Arseneault", active: true }
];

function seedAugustPayments() {
  const ym = "2026-08";
  const paidFull = ["m1", "m2", "m3", "m5", "m7", "m8"];
  const payments = paidFull.map((memberId, i) => ({
    id: `seed_aug_${memberId}`,
    type: "payment",
    memberId,
    yearMonth: ym,
    amount: 39.6,
    date: "2026-07-20",
    mode: "Interac",
    note: "Août payé (import feuille)",
    createdAt: `2026-07-22T12:00:0${i}.000Z`
  }));
  // Nancy : reste 6,20 $ → déjà payé 33,40 $
  payments.push({
    id: "seed_aug_m4",
    type: "payment",
    memberId: "m4",
    yearMonth: ym,
    amount: 33.4,
    date: "2026-07-20",
    mode: "Interac",
    note: "Partiel — reste 6,20 $",
    createdAt: "2026-07-22T12:00:10.000Z"
  });
  // Réjean : surplus 27,20 $ en plus du mois payé
  payments.push({
    id: "seed_surplus_m7",
    type: "payment",
    memberId: "m7",
    yearMonth: ym,
    amount: 27.2,
    date: "2026-07-20",
    mode: "Interac",
    note: "27,20 $ en surplus",
    createdAt: "2026-07-22T12:00:11.000Z"
  });
  // Luc : août + septembre + octobre payés (solde à jour)
  for (const [i, lucYm] of ["2026-08", "2026-09", "2026-10"].entries()) {
    payments.push({
      id: `seed_luc_${lucYm}`,
      type: "payment",
      memberId: "m9",
      yearMonth: lucYm,
      amount: 39.6,
      date: lucYm === "2026-08" ? "2026-07-20" : lucYm === "2026-09" ? "2026-08-20" : "2026-09-20",
      mode: "Interac",
      note: `Payé (${lucYm}) — solde à jour`,
      createdAt: `2026-07-22T12:00:1${i}.000Z`
    });
  }
  // Alain : 39,60 $ impayé (août) — aucun paiement
  // Les prélèvements (type fee) sont créés auto le 20 à 00:01
  return payments;
}

function createDefaultState() {
  return {
    groupName: "Groupe Lave-auto Couche-Tard (Pascal)",
    monthlyFee: 39.6,
    dueDay: 20,
    adminPin: DEFAULT_ADMIN_PIN,
    seedVersion: SHEET_SEED_VERSION,
    feeStartYearMonth: FEE_START_YEAR_MONTH,
    members: DEFAULT_MEMBERS.map((m) => ({ ...m })),
    payments: seedAugustPayments(),
    memberNotes: {},
    updatedAt: "2026-07-22T12:00:00.000Z"
  };
}

function normalizeLedgerEntry(p, i = 0) {
  const type = p.type === "fee" ? "fee" : "payment";
  return {
    id: p.id || `legacy_${i}`,
    type,
    memberId: p.memberId,
    yearMonth: p.yearMonth,
    amount: Math.round(Number(p.amount || 0) * 100) / 100,
    date: p.date || "",
    mode: p.mode || (type === "fee" ? "Prélèvement auto" : "Interac"),
    note: p.note || "",
    createdAt: p.createdAt || new Date().toISOString()
  };
}

function loadState() {
  try {
    // Purge anciennes clés
    ["lave-auto-state-v1", "lave-auto-state-v2", "lave-auto-state-v3"].forEach((k) => {
      try {
        localStorage.removeItem(k);
      } catch {
        /* ignore */
      }
    });

    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createDefaultState();
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.members)) return createDefaultState();

    // Si la feuille n’a jamais été importée, forcer les 9 noms + soldes
    if (parsed.seedVersion !== SHEET_SEED_VERSION) {
      return createDefaultState();
    }

    const base = createDefaultState();
    return {
      ...base,
      ...parsed,
      groupName: "Groupe Lave-auto Couche-Tard (Pascal)",
      seedVersion: SHEET_SEED_VERSION,
      feeStartYearMonth: parsed.feeStartYearMonth || FEE_START_YEAR_MONTH,
      monthlyFee: Number(parsed.monthlyFee) > 0 ? Number(parsed.monthlyFee) : base.monthlyFee,
      dueDay: clampDueDay(parsed.dueDay ?? base.dueDay),
      members: Array.isArray(parsed.members) && parsed.members.length
        ? parsed.members.map((m, i) => ({
            id: m.id || `m${i + 1}`,
            name: String(m.name || DEFAULT_MEMBERS[i]?.name || `Membre ${i + 1}`).trim(),
            active: m.active !== false
          }))
        : base.members,
      payments: Array.isArray(parsed.payments)
        ? parsed.payments.map((p, i) => normalizeLedgerEntry(p, i))
        : base.payments,
      memberNotes: parsed.memberNotes || base.memberNotes
    };
  } catch {
    return createDefaultState();
  }
}

function saveStateLocalOnly() {
  state.updatedAt = new Date().toISOString();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* quota */
  }
  setText(els.lastUpdated, `Dernière mise à jour: ${formatDateTime(state.updatedAt)}`);
}

function getAdminPinForApi() {
  return sessionStorage.getItem(ADMIN_PIN_KEY) || (adminUnlocked ? state.adminPin : null);
}

async function pushStateToServer() {
  if (!serverSyncEnabled) return false;
  const pin = getAdminPinForApi();
  if (!pin) return false;
  if (serverSaveInFlight) return false;
  serverSaveInFlight = true;
  try {
    const res = await fetch(`${API_BASE}/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adminPin: pin, state }),
      cache: "no-store"
    });
    if (res.status === 401) {
      sessionStorage.removeItem(ADMIN_PIN_KEY);
      adminUnlocked = false;
      toast("PIN admin refusé par le serveur");
      return false;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.updatedAt) {
      state.updatedAt = data.updatedAt;
      lastServerUpdatedAt = data.updatedAt;
    }
    return true;
  } catch (err) {
    console.warn("pushStateToServer", err);
    return false;
  } finally {
    serverSaveInFlight = false;
  }
}

function saveState() {
  saveStateLocalOnly();
  // Pousse au serveur si admin (soldes partagés pour tout le groupe)
  if (adminUnlocked || sessionStorage.getItem(ADMIN_PIN_KEY)) {
    pushStateToServer().then((ok) => {
      if (ok) setText(els.lastUpdated, `Dernière mise à jour: ${formatDateTime(state.updatedAt)} · serveur`);
    });
  }
}

function mergeRemoteState(remote) {
  if (!remote || !Array.isArray(remote.members)) return null;
  const base = createDefaultState();
  return {
    ...base,
    ...remote,
    groupName: "Groupe Lave-auto Couche-Tard (Pascal)",
    seedVersion: remote.seedVersion || SHEET_SEED_VERSION,
    feeStartYearMonth: remote.feeStartYearMonth || FEE_START_YEAR_MONTH,
    monthlyFee: Number(remote.monthlyFee) > 0 ? Number(remote.monthlyFee) : base.monthlyFee,
    dueDay: clampDueDay(remote.dueDay ?? base.dueDay),
    members: remote.members.map((m, i) => ({
      id: m.id || `m${i + 1}`,
      name: String(m.name || DEFAULT_MEMBERS[i]?.name || `Membre ${i + 1}`).trim(),
      active: m.active !== false
    })),
    payments: Array.isArray(remote.payments)
      ? remote.payments.map((p, i) => normalizeLedgerEntry(p, i))
      : base.payments,
    memberNotes: remote.memberNotes || base.memberNotes,
    updatedAt: remote.updatedAt || new Date().toISOString()
  };
}

async function pullStateFromServer() {
  try {
    const res = await fetch(`${API_BASE}/state`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    serverSyncEnabled = true;
    if (data?.state && Array.isArray(data.state.members)) {
      const merged = mergeRemoteState(data.state);
      if (merged) {
        state = merged;
        lastServerUpdatedAt = data.state.updatedAt || data.updatedAt;
        saveStateLocalOnly();
        return "server";
      }
    }
    // Serveur vide : si on a un état local et le PIN, on seed le serveur
    return "empty";
  } catch (err) {
    console.warn("pullStateFromServer — mode local", err);
    serverSyncEnabled = false;
    return "offline";
  }
}

async function seedServerIfEmpty() {
  const pin = getAdminPinForApi() || state.adminPin || DEFAULT_ADMIN_PIN;
  if (!serverSyncEnabled) return;
  try {
    const res = await fetch(`${API_BASE}/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adminPin: pin, state }),
      cache: "no-store"
    });
    if (res.ok) {
      lastServerUpdatedAt = state.updatedAt;
      toast("État initial envoyé au serveur");
    }
  } catch {
    /* ignore */
  }
}

function clampDueDay(day) {
  const n = Math.round(Number(day) || 20);
  return Math.min(28, Math.max(1, n));
}

function money(value) {
  return new Intl.NumberFormat("fr-CA", {
    style: "currency",
    currency: "CAD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(Number(value || 0));
}

function formatDateTime(iso) {
  try {
    return new Date(iso).toLocaleString("fr-CA", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return "—";
  }
}

function formatDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(`${String(iso).slice(0, 10)}T12:00:00`).toLocaleDateString("fr-CA", {
      day: "numeric",
      month: "long",
      year: "numeric"
    });
  } catch {
    return String(iso);
  }
}

function yearMonthLabel(ym) {
  const [y, m] = String(ym).split("-").map(Number);
  if (!y || !m) return ym;
  const d = new Date(y, m - 1, 1);
  return d.toLocaleDateString("fr-CA", { month: "long", year: "numeric" });
}

function currentYearMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Moment exact du prélèvement : le 20 (ou dueDay) à 00:01 locale */
function feeMomentForYearMonth(yearMonth, dueDay = 20) {
  const [y, m] = String(yearMonth).split("-").map(Number);
  if (!y || !m) return null;
  return new Date(y, m - 1, clampDueDay(dueDay), 0, 1, 0, 0);
}

function yearMonthFromDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function addMonthsYearMonth(ym, delta) {
  const [y, m] = String(ym).split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return yearMonthFromDate(d);
}

function nextDueDate(dueDay, from = new Date()) {
  const day = clampDueDay(dueDay);
  let candidate = new Date(from.getFullYear(), from.getMonth(), day, 0, 1, 0, 0);
  // si on a dépassé le 20 à 00:01 ce mois-ci → mois suivant
  if (candidate <= from) {
    candidate = new Date(from.getFullYear(), from.getMonth() + 1, day, 0, 1, 0, 0);
  }
  return candidate;
}

function isPaymentEntry(p) {
  return !p.type || p.type === "payment";
}

function isFeeEntry(p) {
  return p.type === "fee";
}

/** Propriétaire du groupe : toujours « mois payé », jamais de dû */
function isOwnerMember(memberOrId) {
  if (!memberOrId) return false;
  if (typeof memberOrId === "string") {
    const m = state?.members?.find((x) => x.id === memberOrId);
    return isOwnerMember(m);
  }
  const id = String(memberOrId.id || "");
  const name = String(memberOrId.name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
  if (id === "m1") return true;
  return name === "pascal taillefer" || name.startsWith("pascal taillefer");
}

function billableMembers() {
  return activeMembers().filter((m) => !isOwnerMember(m));
}

function hasMonthlyFee(memberId, yearMonth) {
  if (isOwnerMember(memberId)) return true; // jamais de prélèvement propriétaire
  return state.payments.some(
    (p) => isFeeEntry(p) && p.memberId === memberId && p.yearMonth === yearMonth
  );
}

function monthFeeApplied(yearMonth) {
  return billableMembers().some((m) =>
    state.payments.some((p) => isFeeEntry(p) && p.memberId === m.id && p.yearMonth === yearMonth)
  );
}

/**
 * Prélève 39,60 $ (monthlyFee) à tous les membres actifs SAUF Pascal (propriétaire)
 * pour chaque mois dont le 20 à 00:01 est déjà passé.
 * Idempotent : ne double pas un prélèvement déjà fait.
 */
function applyScheduledMonthlyFees(now = new Date(), { silent = false } = {}) {
  if (!state || !dbEnabled()) return 0;

  const fee = Math.round(Number(state.monthlyFee) * 100) / 100;
  const dueDay = clampDueDay(state.dueDay);
  const startYm = state.feeStartYearMonth || FEE_START_YEAR_MONTH;
  const currentYm = yearMonthFromDate(now);

  let appliedCount = 0;
  let ym = startYm;

  // Parcourt du premier mois jusqu'au mois courant (+1 de marge si on est pile à 00:01)
  for (let guard = 0; guard < 48; guard += 1) {
    if (ym > addMonthsYearMonth(currentYm, 1)) break;

    const dueAt = feeMomentForYearMonth(ym, dueDay);
    if (!dueAt || dueAt > now) {
      // pas encore l'heure pour ce mois ni les suivants
      if (ym >= currentYm) break;
      ym = addMonthsYearMonth(ym, 1);
      continue;
    }

    for (const member of billableMembers()) {
      if (
        state.payments.some(
          (p) => isFeeEntry(p) && p.memberId === member.id && p.yearMonth === ym
        )
      ) {
        continue;
      }
      state.payments.unshift({
        id: `fee_${ym}_${member.id}`,
        type: "fee",
        memberId: member.id,
        yearMonth: ym,
        amount: fee,
        date: `${ym}-${String(dueDay).padStart(2, "0")}`,
        mode: "Prélèvement auto",
        note: `Cotisation ${monthShortLabel(ym)} — prélèvement auto le ${dueDay} à 00:01`,
        createdAt: now.toISOString()
      });
      appliedCount += 1;
    }

    // Propriétaire : s'assurer d'une couverture « payé » sans dû
    ensureOwnerMonthPaid(ym, now);

    ym = addMonthsYearMonth(ym, 1);
  }

  // Même pour le mois affiché / courant (avant le 20) : Pascal reste payé
  let ownerChanged = false;
  ownerChanged = ensureOwnerMonthPaid(currentYm, now) || ownerChanged;
  if (typeof selectedMonth === "string" && selectedMonth) {
    ownerChanged = ensureOwnerMonthPaid(selectedMonth, now) || ownerChanged;
  }

  if (appliedCount > 0 || ownerChanged) {
    saveState();
    if (!silent && appliedCount > 0) {
      const people = billableMembers().length || 1;
      const months = Math.max(1, Math.round(appliedCount / people));
      toast(
        `Prélèvement auto : −${money(fee)} × ${people} membre${people > 1 ? "s" : ""} (sauf Pascal)${
          months > 1 ? ` × ${months} mois` : ""
        }`
      );
    }
  }
  return appliedCount;
}

/**
 * Pascal n'est jamais débité : solde du mois toujours à jour (« Mois payé »).
 * Crée au besoin un paiement de couverture (sans prélèvement).
 */
function ensureOwnerMonthPaid(yearMonth, now = new Date()) {
  if (!yearMonth || !state) return false;
  const owner = state.members.find((m) => isOwnerMember(m));
  if (!owner || owner.active === false) return false;

  // Retirer d'éventuels prélèvements auto sur Pascal (sécurité)
  const before = state.payments.length;
  state.payments = state.payments.filter(
    (p) => !(isFeeEntry(p) && p.memberId === owner.id)
  );
  let changed = state.payments.length !== before;

  const fee = Math.round(Number(state.monthlyFee) * 100) / 100;
  const paid = paidAmount(owner.id, yearMonth);
  // Évite les doublons de couverture propriétaire
  const alreadyCovered = state.payments.some(
    (p) =>
      isPaymentEntry(p) &&
      p.memberId === owner.id &&
      p.yearMonth === yearMonth &&
      String(p.id || "").startsWith("owner_cover_")
  );
  if (!alreadyCovered && paid + 0.001 < fee) {
    const need = Math.round((fee - paid) * 100) / 100;
    state.payments.unshift({
      id: `owner_cover_${yearMonth}_${owner.id}`,
      type: "payment",
      memberId: owner.id,
      yearMonth,
      amount: need,
      date: `${yearMonth}-01`,
      mode: "Propriétaire",
      note: "Pascal (propriétaire) — toujours payé, pas de cotisation",
      createdAt: now.toISOString()
    });
    changed = true;
  }
  return changed;
}

function dbEnabled() {
  return !!(state && state.members);
}

function daysBetween(a, b) {
  const ms = b.getTime() - a.getTime();
  return Math.round(ms / (24 * 60 * 60 * 1000));
}

function uid() {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function activeMembers() {
  return state.members.filter((m) => m.active !== false);
}

function paymentsFor(memberId, yearMonth) {
  return state.payments.filter(
    (p) => isPaymentEntry(p) && p.memberId === memberId && p.yearMonth === yearMonth
  );
}

function feesFor(memberId, yearMonth) {
  return state.payments.filter(
    (p) => isFeeEntry(p) && p.memberId === memberId && p.yearMonth === yearMonth
  );
}

function paidAmount(memberId, yearMonth) {
  return paymentsFor(memberId, yearMonth).reduce((sum, p) => sum + Number(p.amount || 0), 0);
}

function chargedAmount(memberId, yearMonth) {
  const fees = feesFor(memberId, yearMonth);
  if (fees.length) {
    return fees.reduce((sum, p) => sum + Number(p.amount || 0), 0);
  }
  // Avant le prélèvement auto : on affiche quand même la cotisation attendue
  return Number(state.monthlyFee);
}

/** Solde du mois = paiements − prélèvements (négatif = dû) */
function monthBalance(memberId, yearMonth) {
  if (isOwnerMember(memberId)) return 0; // toujours à jour
  const paid = paidAmount(memberId, yearMonth);
  const charged = feesFor(memberId, yearMonth).reduce((s, p) => s + Number(p.amount || 0), 0);
  // Si pas encore prélevé, comparer au tarif mensuel (avance / à payer)
  const due = charged > 0 ? charged : Number(state.monthlyFee);
  return Math.round((paid - due) * 100) / 100;
}

/** Solde cumulatif tous mois (paiements − fees) */
function runningBalance(memberId) {
  if (isOwnerMember(memberId)) return 0;
  let bal = 0;
  for (const p of state.payments) {
    if (p.memberId !== memberId) continue;
    if (isFeeEntry(p)) bal -= Number(p.amount || 0);
    else bal += Number(p.amount || 0);
  }
  return Math.round(bal * 100) / 100;
}

function memberStatus(memberId, yearMonth) {
  const member = state.members.find((m) => m.id === memberId);
  if (!member || member.active === false) return "inactive";
  if (isOwnerMember(member) || isOwnerMember(memberId)) return "paid";
  const bal = monthBalance(memberId, yearMonth);
  if (bal >= -0.001) return "paid";
  if (paidAmount(memberId, yearMonth) > 0) return "partial";
  return "unpaid";
}

function statusLabel(status) {
  if (status === "paid") return "Payé";
  if (status === "partial") return "Partiel";
  if (status === "inactive") return "Inactif";
  return "Impayé";
}

/** Texte solde style feuille Excel (colonne Soldes) */
function soldeLabel(memberId, yearMonth) {
  const member = state.members.find((m) => m.id === memberId);
  if (!member || member.active === false) return { text: "Inactif", kind: "inactive" };

  const monthShort = monthShortLabel(yearMonth);

  // Pascal (toi) : toujours le mois correspondant payé
  if (isOwnerMember(member) || isOwnerMember(memberId)) {
    return { text: `${monthShort} payé`, kind: "paid" };
  }

  const note = state.memberNotes?.[memberId];
  const paid = paidAmount(memberId, yearMonth);
  const bal = monthBalance(memberId, yearMonth);
  const remaining = Math.max(0, -bal);
  const surplus = Math.max(0, bal);
  const feeDone = hasMonthlyFee(memberId, yearMonth);

  // Note spéciale (ex. Luc → 1er novembre) si rien payé et pas encore prélevé
  if (note && paid < 0.01 && !feeDone) {
    return { text: note, kind: "note" };
  }

  if (surplus > 0.01) {
    return {
      text: `${money(surplus)} en surplus / ${monthShort} payé`,
      kind: "surplus"
    };
  }

  if (bal >= -0.001) {
    return { text: `${monthShort} payé`, kind: "paid" };
  }

  if (remaining > 0.01 && paid > 0.01) {
    return { text: `(${money(remaining)})`, kind: "partial" };
  }

  return { text: `(${money(remaining)})`, kind: "unpaid" };
}

function monthShortLabel(ym) {
  const [y, m] = String(ym).split("-").map(Number);
  if (!y || !m) return "";
  const names = [
    "",
    "Janvier",
    "Février",
    "Mars",
    "Avril",
    "Mai",
    "Juin",
    "Juillet",
    "Août",
    "Septembre",
    "Octobre",
    "Novembre",
    "Décembre"
  ];
  return names[m] || "";
}

const els = {
  startupOverlay: document.querySelector("#startupOverlay"),
  startupMessage: document.querySelector("#startupMessage"),
  startupProgress: document.querySelector("#startupProgress"),
  lastUpdated: document.querySelector("#lastUpdated"),
  nextPaymentLabel: document.querySelector("#nextPaymentLabel"),
  periodLabel: document.querySelector("#periodLabel"),
  feeAmount: document.querySelector("#feeAmount"),
  groupExpected: document.querySelector("#groupExpected"),
  dueDayLabel: document.querySelector("#dueDayLabel"),
  monthMeterFill: document.querySelector("#monthMeterFill"),
  monthMeterText: document.querySelector("#monthMeterText"),
  monthStatus: document.querySelector("#monthStatus"),
  collectedMonth: document.querySelector("#collectedMonth"),
  collectedMeta: document.querySelector("#collectedMeta"),
  remainingMonth: document.querySelector("#remainingMonth"),
  expectedMonth: document.querySelector("#expectedMonth"),
  activeCountLabel: document.querySelector("#activeCountLabel"),
  collectedAll: document.querySelector("#collectedAll"),
  paidPill: document.querySelector("#paidPill"),
  participantList: document.querySelector("#participantList"),
  detailTitle: document.querySelector("#detailTitle"),
  detailStatus: document.querySelector("#detailStatus"),
  memberDetail: document.querySelector("#memberDetail"),
  historyList: document.querySelector("#historyList"),
  adminPanel: document.querySelector("#adminPanel"),
  adminToggle: document.querySelector("#adminToggle"),
  adminUnlockBtn: document.querySelector("#adminUnlockBtn"),
  paymentForm: document.querySelector("#paymentForm"),
  payMember: document.querySelector("#payMember"),
  payMonth: document.querySelector("#payMonth"),
  payAmount: document.querySelector("#payAmount"),
  payDate: document.querySelector("#payDate"),
  payMode: document.querySelector("#payMode"),
  payNote: document.querySelector("#payNote"),
  markAllPaid: document.querySelector("#markAllPaid"),
  memberForm: document.querySelector("#memberForm"),
  editMember: document.querySelector("#editMember"),
  editName: document.querySelector("#editName"),
  editActive: document.querySelector("#editActive"),
  settingsForm: document.querySelector("#settingsForm"),
  settingFee: document.querySelector("#settingFee"),
  settingDueDay: document.querySelector("#settingDueDay"),
  exportData: document.querySelector("#exportData"),
  importData: document.querySelector("#importData"),
  importFile: document.querySelector("#importFile"),
  toast: document.querySelector("#toast")
};

let state = loadState();
let selectedId = localStorage.getItem(SELECTED_KEY) || state.members[0]?.id;
// Afficher août 2026 par défaut si on est encore en juillet 2026 (mois de cotisation en cours)
let selectedMonth = (() => {
  const now = currentYearMonth();
  return now <= "2026-08" ? "2026-08" : now;
})();
let adminUnlocked = false;
let toastTimer = null;

function setText(el, value) {
  if (el) el.textContent = value;
}

function toast(message) {
  if (!els.toast) return;
  els.toast.textContent = message;
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), 2800);
}

function monthOptions() {
  // 18 months: 6 past + current + 11 future
  const opts = [];
  const now = new Date();
  for (let i = -6; i <= 11; i += 1) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    opts.push(ym);
  }
  // include months that already have payments
  for (const p of state.payments) {
    if (p.yearMonth && !opts.includes(p.yearMonth)) opts.push(p.yearMonth);
  }
  opts.sort();
  return opts;
}

/** Mois de référence de la feuille (pas de menu déroulant) */
function syncSheetMonth() {
  // Affiche le mois de cotisation courant (ou août 2026 tant qu'on y est)
  const now = currentYearMonth();
  selectedMonth = now <= "2026-08" ? "2026-08" : now;
}

function fillAdminSelects() {
  const options = state.members
    .map((m) => `<option value="${m.id}">${escapeHtml(m.name)}${m.active === false ? " (inactif)" : ""}</option>`)
    .join("");
  els.payMember.innerHTML = options;
  els.editMember.innerHTML = options;
  if (selectedId) {
    els.payMember.value = selectedId;
    els.editMember.value = selectedId;
    syncEditFields();
  }
  els.payMonth.value = selectedMonth;
  els.payAmount.value = String(state.monthlyFee);
  els.payDate.value = new Date().toISOString().slice(0, 10);
  els.settingFee.value = String(state.monthlyFee);
  els.settingDueDay.value = String(state.dueDay);
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function syncEditFields() {
  const m = state.members.find((x) => x.id === els.editMember.value);
  if (!m) return;
  els.editName.value = m.name;
  els.editActive.value = m.active === false ? "false" : "true";
}

function renderParticipants() {
  const fee = Number(state.monthlyFee);
  const header = `
    <div class="balance-table-head" aria-hidden="true">
      <span class="col-num">#</span>
      <span class="col-name">Participants</span>
      <span class="col-solde">Soldes</span>
    </div>`;

  const rows = state.members.map((m, index) => {
    const status = memberStatus(m.id, selectedMonth);
    const paid = paidAmount(m.id, selectedMonth);
    const bal = monthBalance(m.id, selectedMonth);
    const remaining = Math.max(0, -bal);
    const feeDone = hasMonthlyFee(m.id, selectedMonth);
    const owner = isOwnerMember(m);
    const solde = soldeLabel(m.id, selectedMonth);
    const selected = m.id === selectedId ? "selected" : "";
    const stripe = index % 2 === 1 ? "stripe" : "";

    return `
      <div class="member-row ${selected} ${stripe}" data-id="${m.id}" role="button" tabindex="0">
        <span class="col-num">${index + 1}</span>
        <div class="col-name">
          <div class="name">${escapeHtml(m.name)}${owner ? ' <span class="meta">(toi)</span>' : ""}</div>
          <div class="meta">${
            owner
              ? "Propriétaire — toujours le mois payé"
              : `${money(paid)} versé · cotisation ${money(fee)}${
                  feeDone ? " · prélevé" : " · prélèv. le 20 00:01"
                }`
          }</div>
        </div>
        <div class="col-solde">
          <span class="solde-text solde-${solde.kind}">${escapeHtml(solde.text)}</span>
          ${
            remaining > 0.01 && status !== "inactive"
              ? `<span class="solde-sub">dû: ${money(remaining)}</span>`
              : status === "paid" || solde.kind === "surplus"
                ? `<span class="solde-sub ok">à jour</span>`
                : ""
          }
        </div>
      </div>`;
  });

  els.participantList.innerHTML =
    header + (rows.join("") || "<p class='muted'>Aucun membre.</p>");

  els.participantList.querySelectorAll(".member-row").forEach((row) => {
    row.addEventListener("click", () => {
      selectedId = row.dataset.id;
      localStorage.setItem(SELECTED_KEY, selectedId);
      render();
    });
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        row.click();
      }
    });
  });
}

function renderDetail() {
  const member = state.members.find((m) => m.id === selectedId) || state.members[0];
  if (!member) {
    els.memberDetail.innerHTML = "<p class='muted'>Aucun membre sélectionné.</p>";
    return;
  }
  selectedId = member.id;
  const status = memberStatus(member.id, selectedMonth);
  const paid = paidAmount(member.id, selectedMonth);
  const fee = Number(state.monthlyFee);
  const bal = monthBalance(member.id, selectedMonth);
  const remaining = Math.max(0, -bal);
  const surplus = Math.max(0, bal);
  const runBal = runningBalance(member.id);
  const feeDone = hasMonthlyFee(member.id, selectedMonth);
  const owner = isOwnerMember(member);
  const history = state.payments
    .filter((p) => p.memberId === member.id)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, 16);

  setText(els.detailTitle, member.name);
  setText(els.detailStatus, statusLabel(status));

  const historyHtml = history.length
    ? history
        .map((p) => {
          const isFee = isFeeEntry(p);
          const sign = isFee ? "−" : "+";
          const label = isFee ? "Prélèvement" : "Paiement";
          return `
      <div class="history-item">
        <strong style="color:${isFee ? "#ff6b78" : "#3dff9a"}">${sign}${money(p.amount)} · ${label} · ${yearMonthLabel(p.yearMonth)}</strong>
        <small>${formatDate(p.date)} · ${escapeHtml(p.mode || "—")}${p.note ? " · " + escapeHtml(p.note) : ""}</small>
        ${
          adminUnlocked
            ? `<button class="ghost-button compact-button" data-del="${p.id}" type="button" style="margin-top:8px">Supprimer</button>`
            : ""
        }
      </div>`;
        })
        .join("")
    : "<p class='muted'>Aucune opération pour ce membre.</p>";

  const note = state.memberNotes?.[member.id];

  els.memberDetail.innerHTML = `
    <div class="detail-card">
      <h3>${escapeHtml(member.name)}${owner ? " (toi)" : ""}</h3>
      <p class="muted" style="margin:0 0 8px">${yearMonthLabel(selectedMonth)}${
        owner
          ? " · propriétaire — toujours payé"
          : feeDone
            ? " · cotisation prélevée"
            : " · prélèvement auto le 20 à 00:01"
      }</p>
      ${
        owner
          ? `<p style="margin:0 0 4px"><strong style="color:#3dff9a">${monthShortLabel(selectedMonth)} payé</strong></p>
             <p class="muted" style="margin:0">Tu gères le groupe : pas de cotisation à te prélever.</p>`
          : `<p style="margin:0 0 4px"><strong>${money(paid)}</strong> payé · cotisation <strong>${money(fee)}</strong></p>
             <p class="muted" style="margin:0">Reste: <strong>${money(remaining)}</strong> · Statut: <strong>${statusLabel(status)}</strong>${
               surplus > 0 ? ` · Surplus: <strong>${money(surplus)}</strong>` : ""
             }</p>
             <p class="muted" style="margin:8px 0 0">Solde cumulatif: <strong style="color:${
               runBal < -0.01 ? "#ff6b78" : "#3dff9a"
             }">${money(runBal)}</strong></p>`
      }
      ${note && !owner ? `<p style="margin:10px 0 0;color:#7ef0ff;font-weight:700">${escapeHtml(note)}</p>` : ""}
      ${
        adminUnlocked && !owner && status !== "paid" && member.active !== false
          ? `<div class="detail-actions" style="margin-top:12px">
              <button class="accent-button compact-button" id="quickPayFull" type="button">Marquer payé (${money(remaining || fee)})</button>
            </div>`
          : ""
      }
    </div>
    <div class="detail-card">
      <h3>Historique (paiements &amp; prélèvements)</h3>
      <div class="history-list">${historyHtml}</div>
    </div>`;

  const quick = document.querySelector("#quickPayFull");
  if (quick) {
    quick.addEventListener("click", () => {
      addPayment({
        memberId: member.id,
        yearMonth: selectedMonth,
        amount: remaining > 0 ? remaining : fee,
        date: new Date().toISOString().slice(0, 10),
        mode: "Interac",
        note: "Marqué payé (rapide)"
      });
    });
  }

  els.memberDetail.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!confirm("Supprimer ce paiement ?")) return;
      state.payments = state.payments.filter((p) => p.id !== btn.dataset.del);
      saveState();
      toast("Paiement supprimé");
      render();
    });
  });
}

function renderHistory() {
  const list = [...state.payments]
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, 30);

  if (!list.length) {
    els.historyList.innerHTML = "<p class='muted'>Aucune opération pour l'instant.</p>";
    return;
  }

  els.historyList.innerHTML = list
    .map((p) => {
      const member = state.members.find((m) => m.id === p.memberId);
      const name = member?.name || "Membre";
      const isFee = isFeeEntry(p);
      const sign = isFee ? "−" : "+";
      const kind = isFee ? "Prélèvement auto" : escapeHtml(p.mode || "Paiement");
      return `
        <div class="history-item">
          <strong style="color:${isFee ? "#ff6b78" : "#3dff9a"}">${escapeHtml(name)} · ${sign}${money(p.amount)}</strong>
          <small>${formatDate(p.date)} · ${yearMonthLabel(p.yearMonth)} · ${kind}</small>
        </div>`;
    })
    .join("");
}

function renderHeroAndMetrics() {
  const fee = Number(state.monthlyFee);
  const actives = activeMembers();
  const billable = billableMembers();
  // Attendu = les autres seulement (Pascal ne se paie pas)
  const expected = billable.length * fee;
  let collected = 0;
  let paidCount = 0;
  for (const m of actives) {
    if (isOwnerMember(m)) {
      paidCount += 1;
      continue;
    }
    const paid = paidAmount(m.id, selectedMonth);
    collected += Math.min(paid, fee);
    if (memberStatus(m.id, selectedMonth) === "paid") paidCount += 1;
  }
  // encaissements seulement (pas les prélèvements)
  const collectedRaw = state.payments
    .filter((p) => isPaymentEntry(p) && p.yearMonth === selectedMonth)
    .reduce((s, p) => s + Number(p.amount || 0), 0);
  const remaining = Math.max(0, expected - collected);
  const allTime = state.payments
    .filter((p) => isPaymentEntry(p))
    .reduce((s, p) => s + Number(p.amount || 0), 0);

  const due = nextDueDate(state.dueDay);
  const feeApplied = monthFeeApplied(selectedMonth);
  setText(
    els.nextPaymentLabel,
    `Le ${due.getDate()} ${due.toLocaleDateString("fr-CA", { month: "long", year: "numeric" })} à 00:01`
  );
  setText(
    els.periodLabel,
    `Période affichée: ${yearMonthLabel(selectedMonth)}${
      feeApplied ? " · prélèvement déjà appliqué" : " · prélèvement auto à 00:01 le 20"
    }`
  );
  setText(els.feeAmount, money(fee));
  setText(
    els.groupExpected,
    `${billable.length} × ${money(fee)} = ${money(expected)} / mois (auto le 20 à 00:01, sauf Pascal)`
  );
  setText(els.dueDayLabel, `Chaque ${state.dueDay} du mois à 00:01`);

  // meter: progression dans le mois vers le jour d'échéance
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const totalDays = end.getDate();
  const day = now.getDate();
  const pct = Math.min(100, Math.round((day / totalDays) * 100));
  if (els.monthMeterFill) els.monthMeterFill.style.width = `${pct}%`;
  const msToDue = due.getTime() - now.getTime();
  const hoursToDue = Math.ceil(msToDue / (60 * 60 * 1000));
  const daysToDue = daysBetween(
    new Date(now.getFullYear(), now.getMonth(), now.getDate()),
    new Date(due.getFullYear(), due.getMonth(), due.getDate())
  );
  setText(
    els.monthMeterText,
    msToDue <= 0
      ? "Prélèvement en cours ou déjà appliqué — prochain cycle le mois suivant."
      : daysToDue === 0
        ? `Aujourd'hui à 00:01 : −${money(fee)} à chaque membre actif${hoursToDue > 0 ? ` (dans ~${hoursToDue} h)` : ""}.`
        : `Dans ${daysToDue} jour${daysToDue > 1 ? "s" : ""} — le ${state.dueDay} à 00:01, −${money(fee)} à tous.`
  );

  setText(
    els.monthStatus,
    `${paidCount}/${actives.length} payés · ${money(collectedRaw)} reçu`
  );
  setText(els.collectedMonth, money(collectedRaw));
  setText(els.collectedMeta, `${paidCount} / ${actives.length} payés`);
  setText(els.remainingMonth, money(remaining));
  setText(els.expectedMonth, money(expected));
  setText(els.activeCountLabel, `${actives.length} membre${actives.length > 1 ? "s" : ""} actif${actives.length > 1 ? "s" : ""}`);
  setText(els.collectedAll, money(allTime));
  setText(els.paidPill, `${paidCount} payé${paidCount > 1 ? "s" : ""}`);
  setText(els.lastUpdated, `Dernière mise à jour: ${formatDateTime(state.updatedAt)}`);
}

function render() {
  applyScheduledMonthlyFees(new Date(), { silent: true });
  syncSheetMonth();
  fillAdminSelects();
  renderHeroAndMetrics();
  renderParticipants();
  renderDetail();
  renderHistory();
  els.adminPanel.classList.toggle("locked", !adminUnlocked);
  els.adminPanel.classList.toggle("unlocked", adminUnlocked);
  setText(els.adminToggle, adminUnlocked ? "Verrouiller admin" : "Mode Admin");
}

function addPayment({ memberId, yearMonth, amount, date, mode, note }) {
  const amt = Number(amount);
  if (!memberId || !yearMonth || !Number.isFinite(amt) || amt <= 0) {
    toast("Paiement invalide");
    return;
  }
  state.payments.unshift({
    id: uid(),
    type: "payment",
    memberId,
    yearMonth,
    amount: Math.round(amt * 100) / 100,
    date: date || new Date().toISOString().slice(0, 10),
    mode: mode || "Interac",
    note: (note || "").trim(),
    createdAt: new Date().toISOString()
  });
  saveState();
  toast(`Paiement enregistré: ${money(amt)}`);
  render();
}

function tryUnlockAdmin() {
  const saved = sessionStorage.getItem(ADMIN_PIN_KEY);
  if (saved && saved === state.adminPin) {
    adminUnlocked = true;
    render();
    return;
  }
  const entered = window.prompt("PIN admin Lave Auto");
  if (entered == null) return;
  if (entered === state.adminPin) {
    sessionStorage.setItem(ADMIN_PIN_KEY, entered);
    adminUnlocked = true;
    toast("Mode admin déverrouillé");
    render();
    return;
  }
  toast("PIN incorrect");
}

function lockAdmin() {
  adminUnlocked = false;
  sessionStorage.removeItem(ADMIN_PIN_KEY);
  render();
}

// ─── Events ───────────────────────────────────────────────

els.adminToggle.addEventListener("click", () => {
  if (adminUnlocked) lockAdmin();
  else tryUnlockAdmin();
});

els.adminUnlockBtn.addEventListener("click", tryUnlockAdmin);

els.paymentForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (!adminUnlocked) return toast("Déverrouille le mode admin");
  addPayment({
    memberId: els.payMember.value,
    yearMonth: els.payMonth.value,
    amount: els.payAmount.value,
    date: els.payDate.value,
    mode: els.payMode.value,
    note: els.payNote.value
  });
  els.payNote.value = "";
});

els.markAllPaid.addEventListener("click", () => {
  if (!adminUnlocked) return toast("Déverrouille le mode admin");
  if (!confirm(`Marquer tous les membres actifs comme payés pour ${yearMonthLabel(selectedMonth)} ?`)) return;
  const fee = Number(state.monthlyFee);
  let count = 0;
  for (const m of billableMembers()) {
    const status = memberStatus(m.id, selectedMonth);
    if (status === "paid") continue;
    const paid = paidAmount(m.id, selectedMonth);
    const need = Math.max(0, fee - paid);
    if (need <= 0) continue;
    state.payments.unshift({
      id: uid(),
      type: "payment",
      memberId: m.id,
      yearMonth: selectedMonth,
      amount: Math.round(need * 100) / 100,
      date: new Date().toISOString().slice(0, 10),
      mode: "Interac",
      note: "Marqué payé (tous)",
      createdAt: new Date().toISOString()
    });
    count += 1;
  }
  saveState();
  toast(count ? `${count} paiement(s) ajouté(s)` : "Tous étaient déjà payés");
  render();
});

els.editMember.addEventListener("change", syncEditFields);

els.memberForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (!adminUnlocked) return toast("Déverrouille le mode admin");
  const id = els.editMember.value;
  const idx = state.members.findIndex((m) => m.id === id);
  if (idx < 0) return;
  const name = els.editName.value.trim();
  if (!name) return toast("Nom requis");
  state.members[idx] = {
    ...state.members[idx],
    name,
    active: els.editActive.value === "true"
  };
  saveState();
  toast("Membre mis à jour");
  render();
});

els.settingsForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (!adminUnlocked) return toast("Déverrouille le mode admin");
  const fee = Number(els.settingFee.value);
  const due = clampDueDay(els.settingDueDay.value);
  if (!Number.isFinite(fee) || fee < 0) return toast("Montant invalide");
  state.monthlyFee = Math.round(fee * 100) / 100;
  state.dueDay = due;
  saveState();
  toast("Réglages enregistrés");
  render();
});

els.exportData.addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `lave-auto-backup-${currentYearMonth()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast("Export téléchargé");
});

els.importData.addEventListener("click", () => els.importFile.click());

els.importFile.addEventListener("change", async () => {
  const file = els.importFile.files?.[0];
  els.importFile.value = "";
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!parsed?.members || !Array.isArray(parsed.members)) {
      toast("Fichier invalide");
      return;
    }
    if (!confirm("Remplacer toutes les données locales par ce fichier ?")) return;
    state = {
      ...createDefaultState(),
      ...parsed,
      monthlyFee: Number(parsed.monthlyFee) > 0 ? Number(parsed.monthlyFee) : 39.6,
      dueDay: clampDueDay(parsed.dueDay ?? 20),
      payments: Array.isArray(parsed.payments) ? parsed.payments : []
    };
    saveState();
    toast("Import réussi");
    render();
  } catch {
    toast("Erreur d'import");
  }
});

// boot
(async function boot() {
  if (els.startupProgress) els.startupProgress.style.width = "40%";
  setText(els.startupMessage, "Connexion au serveur du groupe…");

  const source = await pullStateFromServer();
  if (els.startupProgress) els.startupProgress.style.width = "75%";

  if (source === "empty") {
    // Première mise en ligne : publier l'état par défaut (membres + soldes feuille)
    state = loadState();
    setText(els.startupMessage, "Initialisation des soldes sur le serveur…");
    await seedServerIfEmpty();
  } else if (source === "offline") {
    state = loadState();
    setText(els.startupMessage, "Mode hors-ligne (données locales)…");
  } else {
    setText(els.startupMessage, "Soldes chargés depuis le serveur…");
  }

  applyScheduledMonthlyFees(new Date(), { silent: true });
  // Si admin session active, republier après prélèvements auto
  if (sessionStorage.getItem(ADMIN_PIN_KEY)) {
    await pushStateToServer();
  }

  render();
  if (els.startupProgress) els.startupProgress.style.width = "100%";
  setTimeout(() => els.startupOverlay?.classList.add("hidden"), 120);

  // Prélèvement auto le 20 à 00:01
  window.setInterval(() => {
    if (!state) return;
    const n = applyScheduledMonthlyFees(new Date(), { silent: false });
    if (n > 0) {
      if (sessionStorage.getItem(ADMIN_PIN_KEY)) pushStateToServer();
      render();
    }
  }, FEE_CHECK_INTERVAL_MS);

  // Rafraîchit les soldes pour tout le groupe (lecture serveur)
  window.setInterval(async () => {
    if (!serverSyncEnabled || adminUnlocked) return; // admin en édition : pas d'écrasement
    const prev = lastServerUpdatedAt;
    const src = await pullStateFromServer();
    if (src === "server" && lastServerUpdatedAt && lastServerUpdatedAt !== prev) {
      applyScheduledMonthlyFees(new Date(), { silent: true });
      render();
    }
  }, REFRESH_INTERVAL_MS);
})();
