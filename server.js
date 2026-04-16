import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";

loadEnv();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = join(process.cwd(), "public");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "recap-admin";
const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";
const SUMMARY_MODEL = process.env.SUMMARY_MODEL || "gpt-5.4-nano";
const STORE_PATH = join(process.cwd(), "data", "clients.json");
const clientSessions = new Map();
const MAX_RECENT_VISITS = 12;
const MAX_SAVED_VISITS = 10;
const MAX_AUDIO_BYTES = Number(process.env.MAX_AUDIO_BYTES || 80 * 1024 * 1024);
const MAX_JSON_BYTES = Number(process.env.MAX_JSON_BYTES || 128 * 1024);
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 12 * 60 * 60 * 1000);
const rateBuckets = new Map();

if (process.env.NODE_ENV === "production" && ADMIN_PASSWORD === "recap-admin") {
  throw new Error("Imposta ADMIN_PASSWORD in produzione.");
}

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const server = createServer(async (req, res) => {
  try {
    applySecurityHeaders(res);
    if (!allowRequest(req, res)) return;

    if (req.url?.startsWith("/api/admin/")) {
      await handleAdmin(req, res);
      return;
    }

    if (req.url?.startsWith("/api/client/")) {
      await handleClient(req, res);
      return;
    }

    if (req.method === "POST" && req.url === "/api/recap") {
      await handleRecap(req, res);
      return;
    }

    if (req.method === "GET") {
      await serveStatic(req, res);
      return;
    }

    sendJson(res, 405, { error: "Metodo non supportato." });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, {
      error: "Qualcosa e' andato storto. Controlla il terminale del server."
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server attivo sulla porta ${PORT}`);
});

async function handleRecap(req, res) {
  if (!OPENAI_API_KEY) {
    sendJson(res, 400, {
      error: "Manca OPENAI_API_KEY. Crea un file .env partendo da .env.example."
    });
    return;
  }

  const contentType = req.headers["content-type"] || "";
  if (!contentType.includes("multipart/form-data")) {
    sendJson(res, 400, { error: "Registra una visita prima di generare il riassunto." });
    return;
  }

  const contentLength = Number(req.headers["content-length"] || 0);
  if (contentLength > MAX_AUDIO_BYTES) {
    sendJson(res, 413, { error: "Audio troppo grande. Riduci la durata della registrazione." });
    return;
  }

  const request = new Request(`http://localhost${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: req,
    duplex: "half"
  });

  const form = await request.formData();
  const audio = form.get("audio");
  const patientName = form.get("patientName") || "";
  const visitType = form.get("visitType") || "visita nutrizionale";
  const visitContext = form.get("visitContext") || "";
  const durationSeconds = Number(form.get("durationSeconds") || 0);

  if (!audio || typeof audio === "string") {
    sendJson(res, 400, { error: "Audio non ricevuto." });
    return;
  }

  const store = await loadStore();
  const client = getClientFromSession(req, store);
  if (!client) {
    sendJson(res, 401, { error: "Sessione scaduta. Effettua di nuovo il login." });
    return;
  }

  refreshClientMonth(client);
  if (client.status !== "active") {
    sendJson(res, 403, { error: "Cliente sospeso. Contatta l'amministratore." });
    return;
  }

  if (client.usedThisMonth >= client.monthlyLimit) {
    sendJson(res, 403, { error: "Limite visite mensile raggiunto. Contatta l'amministratore." });
    return;
  }

  const transcript = await transcribeAudio(audio);
  const summaryResult = await summarizeVisit(transcript, visitType, visitContext);
  const summary = summaryResult.text;
  const visitStats = buildVisitStats(durationSeconds, summaryResult.usage);
  client.usedThisMonth += 1;
  client.totalVisits = (client.totalVisits || 0) + 1;
  applyUsageStats(client, visitStats);
  saveClientVisit(client, {
    patientName: String(patientName),
    visitType: String(visitType),
    transcript,
    summary,
    stats: visitStats
  });
  client.lastUsedAt = new Date().toISOString();
  await saveStore(store);

  sendJson(res, 200, {
    transcript,
    summary,
    audioSaved: false,
    usage: {
      usedThisMonth: client.usedThisMonth,
      monthlyLimit: client.monthlyLimit,
      stats: clientUsageStats(client),
      lastVisit: visitStats,
      savedVisits: client.savedVisits || []
    }
  });
}

async function handleAdmin(req, res) {
  if (!isAdmin(req)) {
    sendJson(res, 401, { error: "Password admin non valida." });
    return;
  }

  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && url.pathname === "/api/admin/clients") {
    const store = await loadStore();
    store.clients.forEach(refreshClientMonth);
    await saveStore(store);
    sendJson(res, 200, {
      clients: store.clients.map(adminClient),
      stats: aggregateStats(store.clients)
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/admin/clients") {
    const body = await readJsonBody(req);
    const store = await loadStore();
    const { client, password } = createClient(body);
    store.clients.unshift(client);
    await saveStore(store);
    sendJson(res, 201, { client: adminClient(client), password });
    return;
  }

  const updateMatch = url.pathname.match(/^\/api\/admin\/clients\/([^/]+)$/);
  if (req.method === "PATCH" && updateMatch) {
    const body = await readJsonBody(req);
    const store = await loadStore();
    const client = store.clients.find((item) => item.id === updateMatch[1]);
    if (!client) {
      sendJson(res, 404, { error: "Cliente non trovato." });
      return;
    }

    updateClient(client, body);
    await saveStore(store);
    sendJson(res, 200, { client: adminClient(client) });
    return;
  }

  const deleteMatch = url.pathname.match(/^\/api\/admin\/clients\/([^/]+)$/);
  if (req.method === "DELETE" && deleteMatch) {
    const store = await loadStore();
    const index = store.clients.findIndex((item) => item.id === deleteMatch[1]);
    if (index === -1) {
      sendJson(res, 404, { error: "Cliente non trovato." });
      return;
    }

    const [deletedClient] = store.clients.splice(index, 1);
    for (const [token, session] of clientSessions.entries()) {
      if (session.clientId === deletedClient.id) clientSessions.delete(token);
    }
    await saveStore(store);
    sendJson(res, 200, { deleted: true, client: adminClient(deletedClient) });
    return;
  }

  const passwordMatch = url.pathname.match(/^\/api\/admin\/clients\/([^/]+)\/password$/);
  if (req.method === "POST" && passwordMatch) {
    const store = await loadStore();
    const client = store.clients.find((item) => item.id === passwordMatch[1]);
    if (!client) {
      sendJson(res, 404, { error: "Cliente non trovato." });
      return;
    }

    const body = await readJsonBody(req);
    const password = String(body.password || "").trim() || createPassword();
    setClientPassword(client, password);
    await saveStore(store);
    sendJson(res, 200, { client: adminClient(client), password });
    return;
  }

  const resetMatch = url.pathname.match(/^\/api\/admin\/clients\/([^/]+)\/reset$/);
  if (req.method === "POST" && resetMatch) {
    const store = await loadStore();
    const client = store.clients.find((item) => item.id === resetMatch[1]);
    if (!client) {
      sendJson(res, 404, { error: "Cliente non trovato." });
      return;
    }

    client.usedThisMonth = 0;
    client.month = currentMonth();
    client.monthlySeconds = 0;
    client.monthlySummaryInputTokens = 0;
    client.monthlySummaryOutputTokens = 0;
    client.monthlyEstimatedCostUsd = 0;
    await saveStore(store);
    sendJson(res, 200, { client: adminClient(client) });
    return;
  }

  sendJson(res, 404, { error: "Endpoint admin non trovato." });
}

async function handleClient(req, res) {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "POST" && url.pathname === "/api/client/login") {
    const body = await readJsonBody(req);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const store = await loadStore();
    const client = store.clients.find((item) => item.email.toLowerCase() === email);

    if (!client || !verifyClientPassword(client, password)) {
      sendJson(res, 401, { error: "Email o password non corrette." });
      return;
    }

    refreshClientMonth(client);
    if (client.status !== "active") {
      sendJson(res, 403, { error: "Utenza sospesa. Contatta l'amministratore." });
      return;
    }

    await saveStore(store);
    const token = randomBytes(24).toString("hex");
    clientSessions.set(token, {
      clientId: client.id,
      expiresAt: Date.now() + SESSION_TTL_MS
    });
    sendJson(res, 200, { token, client: publicClient(client) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/client/me") {
    const store = await loadStore();
    const client = getClientFromSession(req, store);
    if (!client) {
      sendJson(res, 401, { error: "Sessione scaduta." });
      return;
    }

    refreshClientMonth(client);
    await saveStore(store);
    sendJson(res, 200, { client: publicClient(client) });
    return;
  }

  sendJson(res, 404, { error: "Endpoint cliente non trovato." });
}

async function transcribeAudio(audioFile) {
  const data = new FormData();
  data.append("model", TRANSCRIBE_MODEL);
  data.append("language", "it");
  data.append("response_format", "json");
  data.append("file", audioFile, audioFile.name || "visita.webm");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: data
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error?.message || "Trascrizione non riuscita.");
  }

  return payload.text || "";
}

async function summarizeVisit(transcript, visitType, visitContext) {
  const prompt = `
Ruolo:
Sei Recap AI, un assistente di documentazione per professionisti sanitari e consulenze.
Devi trasformare la trascrizione di una ${visitType} in una scheda precisa, utile e modificabile.

Regole di precisione:
- Non inventare diagnosi, misure, prescrizioni, allergie, patologie, farmaci o obiettivi.
- Usa solo informazioni presenti nella trascrizione o nel contesto inserito dal professionista.
- Se un'informazione e' incerta, scrivi "Da verificare" e spiega cosa manca.
- Se un'informazione non emerge, scrivi "Non emerso".
- Distingui fatti riferiti dal paziente, osservazioni del professionista e indicazioni concordate.
- Mantieni tono professionale, sintetico e pratico.
- Non usare frasi promozionali o spiegazioni sull'AI.

Contesto inserito prima della visita:
${cleanOptionalText(visitContext)}

Formato obbligatorio:

Riepilogo visita

Tipo visita:

Motivo della visita:

Obiettivi dichiarati:

Dati e misure citate:

Abitudini alimentari:
- Colazione:
- Pranzo:
- Cena:
- Spuntini:
- Idratazione:
- Alcol / bevande:

Stile di vita:
- Attivita' fisica:
- Sonno:
- Lavoro / routine:
- Stress / fame emotiva:

Punti critici emersi:

Preferenze, vincoli o alimenti da evitare:

Indicazioni concordate:

Azioni per il paziente:

Azioni per il professionista:

Follow-up:

Note da verificare:

Sintesi breve per cartella:

Trascrizione completa:
${transcript}
`;

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: SUMMARY_MODEL,
      input: prompt,
      temperature: 0.2
    })
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error?.message || "Riassunto non riuscito.");
  }

  return {
    text: payload.output_text || extractResponseText(payload),
    usage: normalizeResponseUsage(payload.usage)
  };
}

function cleanOptionalText(value) {
  const text = String(value || "").trim();
  return text || "Non inserito.";
}

function extractResponseText(payload) {
  return (payload.output || [])
    .flatMap((item) => item.content || [])
    .map((content) => content.text || "")
    .join("\n")
    .trim();
}

async function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  const cleanPath = normalize(url.pathname === "/" ? "/index.html" : url.pathname);
  const filePath = join(PUBLIC_DIR, cleanPath);

  if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath)) {
    sendText(res, 404, "Pagina non trovata.");
    return;
  }

  const ext = extname(filePath);
  const body = await readFile(filePath);
  res.writeHead(200, {
    "Content-Type": contentTypes[ext] || "application/octet-stream"
  });
  res.end(body);
}

function sendJson(res, status, payload) {
  applySecurityHeaders(res);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, text) {
  applySecurityHeaders(res);
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function applySecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), geolocation=(), payment=()");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cache-Control", "no-store");
}

function allowRequest(req, res) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "local";
  const bucketKey = `${ip}:${req.url?.startsWith("/api/admin/") ? "admin" : "app"}`;
  const now = Date.now();
  const windowMs = 60 * 1000;
  const limit = req.url?.startsWith("/api/admin/") || req.url?.startsWith("/api/client/login") ? 30 : 90;
  const bucket = rateBuckets.get(bucketKey) || { count: 0, resetAt: now + windowMs };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + windowMs;
  }
  bucket.count += 1;
  rateBuckets.set(bucketKey, bucket);
  if (bucket.count > limit) {
    sendJson(res, 429, { error: "Troppe richieste. Riprova tra poco." });
    return false;
  }
  return true;
}

function isAdmin(req) {
  return req.headers["x-admin-password"] === ADMIN_PASSWORD;
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) {
      throw new Error("JSON troppo grande.");
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function loadStore() {
  if (!existsSync(STORE_PATH)) {
    return { clients: [] };
  }

  return JSON.parse(await readFile(STORE_PATH, "utf8"));
}

async function saveStore(store) {
  await mkdir(dirname(STORE_PATH), { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(store, null, 2));
}

function createClient(body) {
  const plan = body.plan || "Starter";
  const password = String(body.password || "").trim() || createPassword();
  const client = {
    id: randomUUID(),
    name: String(body.name || "Nuovo cliente").trim(),
    email: String(body.email || "").trim(),
    status: body.status === "suspended" ? "suspended" : "active",
    plan,
    monthlyLimit: Number(body.monthlyLimit || defaultLimitForPlan(plan)),
    usedThisMonth: 0,
    month: currentMonth(),
    notes: String(body.notes || "").trim(),
    totalVisits: 0,
    totalSeconds: 0,
    monthlySeconds: 0,
    totalSummaryInputTokens: 0,
    totalSummaryOutputTokens: 0,
    monthlySummaryInputTokens: 0,
    monthlySummaryOutputTokens: 0,
    totalEstimatedCostUsd: 0,
    monthlyEstimatedCostUsd: 0,
    recentVisits: [],
    savedVisits: [],
    createdAt: new Date().toISOString(),
    lastUsedAt: null
  };
  setClientPassword(client, password);
  return { client, password };
}

function updateClient(client, body) {
  if (body.name !== undefined) client.name = String(body.name).trim();
  if (body.email !== undefined) client.email = String(body.email).trim();
  if (body.status !== undefined) {
    client.status = body.status === "suspended" ? "suspended" : "active";
  }
  if (body.plan !== undefined) client.plan = String(body.plan).trim() || client.plan;
  if (body.monthlyLimit !== undefined) {
    client.monthlyLimit = Math.max(1, Number(body.monthlyLimit));
  }
  if (body.notes !== undefined) client.notes = String(body.notes).trim();
  refreshClientMonth(client);
}

function refreshClientMonth(client) {
  const month = currentMonth();
  if (client.month !== month) {
    client.month = month;
    client.usedThisMonth = 0;
    client.monthlySeconds = 0;
    client.monthlySummaryInputTokens = 0;
    client.monthlySummaryOutputTokens = 0;
    client.monthlyEstimatedCostUsd = 0;
  }
}

function currentMonth() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit"
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return `${year}-${month}`;
}

function defaultLimitForPlan(plan) {
  const limits = {
    Starter: 20,
    Pro: 120,
    Studio: 300
  };
  return limits[plan] || 20;
}

function getClientFromSession(req, store) {
  const token = String(req.headers["x-client-token"] || "");
  const session = clientSessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    clientSessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return store.clients.find((item) => item.id === session.clientId) || null;
}

function publicClient(client) {
  return {
    id: client.id,
    name: client.name,
    email: client.email,
    status: client.status,
    plan: client.plan,
    monthlyLimit: client.monthlyLimit,
    usedThisMonth: client.usedThisMonth,
    totalVisits: client.totalVisits || 0,
    lastUsedAt: client.lastUsedAt,
    usageStats: clientUsageStats(client),
    recentVisits: client.recentVisits || [],
    savedVisits: client.savedVisits || []
  };
}

function adminClient(client) {
  return {
    ...publicClient(client),
    createdAt: client.createdAt,
    notes: client.notes || "",
    hasPassword: Boolean(client.passwordHash)
  };
}

function applyUsageStats(client, stats) {
  client.totalSeconds = Number(client.totalSeconds || 0) + stats.durationSeconds;
  client.monthlySeconds = Number(client.monthlySeconds || 0) + stats.durationSeconds;
  client.totalSummaryInputTokens = Number(client.totalSummaryInputTokens || 0) + stats.summaryInputTokens;
  client.totalSummaryOutputTokens = Number(client.totalSummaryOutputTokens || 0) + stats.summaryOutputTokens;
  client.monthlySummaryInputTokens = Number(client.monthlySummaryInputTokens || 0) + stats.summaryInputTokens;
  client.monthlySummaryOutputTokens = Number(client.monthlySummaryOutputTokens || 0) + stats.summaryOutputTokens;
  client.totalEstimatedCostUsd = Number(client.totalEstimatedCostUsd || 0) + stats.estimatedCostUsd;
  client.monthlyEstimatedCostUsd = Number(client.monthlyEstimatedCostUsd || 0) + stats.estimatedCostUsd;
  client.recentVisits = [
    {
      at: new Date().toISOString(),
      durationSeconds: stats.durationSeconds,
      summaryInputTokens: stats.summaryInputTokens,
      summaryOutputTokens: stats.summaryOutputTokens,
      estimatedCostUsd: stats.estimatedCostUsd
    },
    ...(client.recentVisits || [])
  ].slice(0, MAX_RECENT_VISITS);
}

function saveClientVisit(client, visit) {
  const now = new Date().toISOString();
  const patientName = cleanPatientName(visit.patientName) || inferPatientName(visit.transcript);
  const title = createVisitTitle(patientName, visit.visitType, now);
  client.savedVisits = [
    {
      id: randomUUID(),
      title,
      patientName,
      visitType: visit.visitType,
      at: now,
      summary: trimStoredText(visit.summary, 18000),
      transcript: trimStoredText(visit.transcript, 30000),
      durationSeconds: visit.stats.durationSeconds
    },
    ...(client.savedVisits || [])
  ].slice(0, MAX_SAVED_VISITS);
}

function createVisitTitle(patientName, visitType, isoDate) {
  const date = new Date(isoDate).toLocaleString("it-IT", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
  const titleName = patientName || "Paziente non indicato";
  return `${titleName} - ${date}`;
}

function inferPatientName(transcript) {
  const text = String(transcript || "").replace(/\s+/g, " ");
  const patterns = [
    /\b(?:paziente|cliente|signora|signor)\s+(?:si chiama|e'|è)\s+([\p{L}][\p{L}'-]+(?:\s+[\p{L}][\p{L}'-]+){0,2})/iu,
    /\bnome(?:\s+(?:paziente|cliente))?\s*[:\-]?\s+([\p{L}][\p{L}'-]+(?:\s+[\p{L}][\p{L}'-]+){0,2})/iu,
    /\bmi chiamo\s+([\p{L}][\p{L}'-]+(?:\s+[\p{L}][\p{L}'-]+){0,2})/iu
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const name = cleanPatientName(match?.[1] || "");
    if (name) return name;
  }

  return "";
}

function cleanPatientName(value) {
  const blockedWords = new Set(["oggi", "allora", "bene", "visita", "paziente", "cliente"]);
  const name = String(value || "")
    .replace(/[.,;:!?()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 3)
    .join(" ");

  if (name.length < 2 || name.length > 70) return "";
  if (blockedWords.has(name.toLowerCase())) return "";
  return name;
}

function trimStoredText(value, maxLength) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n\n[Testo abbreviato]` : text;
}

function buildVisitStats(durationSeconds, usage) {
  const safeDuration = Math.max(0, Number(durationSeconds || 0));
  const summaryInputTokens = Number(usage.inputTokens || 0);
  const summaryOutputTokens = Number(usage.outputTokens || 0);
  const audioMinutes = safeDuration / 60;
  const transcribeCostUsd = audioMinutes * transcribeCostPerMinute();
  const summaryCostUsd =
    (summaryInputTokens / 1_000_000) * summaryInputCostPerMillion() +
    (summaryOutputTokens / 1_000_000) * summaryOutputCostPerMillion();

  return {
    durationSeconds: safeDuration,
    audioMinutes,
    summaryInputTokens,
    summaryOutputTokens,
    summaryTotalTokens: summaryInputTokens + summaryOutputTokens,
    transcribeCostUsd,
    summaryCostUsd,
    estimatedCostUsd: transcribeCostUsd + summaryCostUsd
  };
}

function normalizeResponseUsage(usage = {}) {
  return {
    inputTokens: Number(usage.input_tokens || usage.inputTokens || 0),
    outputTokens: Number(usage.output_tokens || usage.outputTokens || 0)
  };
}

function clientUsageStats(client) {
  const monthlyInput = Number(client.monthlySummaryInputTokens || 0);
  const monthlyOutput = Number(client.monthlySummaryOutputTokens || 0);
  const totalInput = Number(client.totalSummaryInputTokens || 0);
  const totalOutput = Number(client.totalSummaryOutputTokens || 0);

  return {
    monthlySeconds: Number(client.monthlySeconds || 0),
    totalSeconds: Number(client.totalSeconds || 0),
    monthlyMinutes: Number((Number(client.monthlySeconds || 0) / 60).toFixed(1)),
    totalMinutes: Number((Number(client.totalSeconds || 0) / 60).toFixed(1)),
    monthlySummaryInputTokens: monthlyInput,
    monthlySummaryOutputTokens: monthlyOutput,
    monthlySummaryTotalTokens: monthlyInput + monthlyOutput,
    totalSummaryInputTokens: totalInput,
    totalSummaryOutputTokens: totalOutput,
    totalSummaryTotalTokens: totalInput + totalOutput,
    monthlyEstimatedCostUsd: Number(client.monthlyEstimatedCostUsd || 0),
    totalEstimatedCostUsd: Number(client.totalEstimatedCostUsd || 0)
  };
}

function aggregateStats(clients) {
  return clients.reduce(
    (stats, client) => {
      const usage = clientUsageStats(client);
      stats.monthlyVisits += Number(client.usedThisMonth || 0);
      stats.totalVisits += Number(client.totalVisits || 0);
      stats.monthlyMinutes += usage.monthlyMinutes;
      stats.totalMinutes += usage.totalMinutes;
      stats.monthlyTokens += usage.monthlySummaryTotalTokens;
      stats.totalTokens += usage.totalSummaryTotalTokens;
      stats.monthlyEstimatedCostUsd += usage.monthlyEstimatedCostUsd;
      stats.totalEstimatedCostUsd += usage.totalEstimatedCostUsd;
      return stats;
    },
    {
      monthlyVisits: 0,
      totalVisits: 0,
      monthlyMinutes: 0,
      totalMinutes: 0,
      monthlyTokens: 0,
      totalTokens: 0,
      monthlyEstimatedCostUsd: 0,
      totalEstimatedCostUsd: 0
    }
  );
}

function transcribeCostPerMinute() {
  return TRANSCRIBE_MODEL.includes("mini") ? 0.003 : 0.006;
}

function summaryInputCostPerMillion() {
  if (SUMMARY_MODEL.includes("mini")) return 0.75;
  if (SUMMARY_MODEL.includes("nano")) return 0.2;
  return 0.2;
}

function summaryOutputCostPerMillion() {
  if (SUMMARY_MODEL.includes("mini")) return 4.5;
  if (SUMMARY_MODEL.includes("nano")) return 1.25;
  return 1.25;
}

function createPassword() {
  return `${randomWord()}-${randomBytes(2).toString("hex").toUpperCase()}-${randomWord()}`;
}

function randomWord() {
  const words = ["Luna", "Verde", "Nota", "Sole", "Mela", "Fiume", "Vento", "Fiore"];
  return words[Math.floor(Math.random() * words.length)];
}

function setClientPassword(client, password) {
  const salt = randomBytes(16).toString("hex");
  client.passwordSalt = salt;
  client.passwordHash = hashPassword(password, salt);
}

function verifyClientPassword(client, password) {
  if (!client.passwordSalt || !client.passwordHash) return false;
  const expected = Buffer.from(client.passwordHash, "hex");
  const actual = Buffer.from(hashPassword(password, client.passwordSalt), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function hashPassword(password, salt) {
  return scryptSync(password, salt, 32).toString("hex");
}

function loadEnv() {
  const envPath = join(process.cwd(), ".env");
  const visibleEnvPath = join(process.cwd(), "CONFIGURA_CHIAVE.txt");
  const configPath = existsSync(envPath) ? envPath : visibleEnvPath;
  if (!existsSync(configPath)) return;

  const env = awaitableReadEnv(configPath);
  for (const line of env.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    const value = rawValue.replace(/^["']|["']$/g, "");

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function awaitableReadEnv(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}
