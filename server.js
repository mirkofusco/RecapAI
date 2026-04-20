import { createServer } from "node:http";
import { connect as tlsConnect } from "node:tls";
import { connect as netConnect } from "node:net";
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
const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || "gpt-4o-transcribe-diarize";
const SUMMARY_MODEL = process.env.SUMMARY_MODEL || "gpt-5.4-nano";
const TRANSCRIBE_PROMPT = process.env.TRANSCRIBE_PROMPT || [
  "Trascrivi in italiano in modo fedele una visita o consulenza professionale.",
  "Mantieni nomi, misure, alimenti, farmaci, patologie e indicazioni cosi' come vengono detti.",
  "Non aggiungere commenti, non riassumere, non inventare parole mancanti.",
  "Se una parola e' incerta, trascrivi la forma piu' probabile senza scrivere note tecniche."
].join(" ");
const STORE_PATH = join(process.cwd(), "data", "clients.json");
const APP_URL = process.env.APP_URL || "https://recap-ai-frky.onrender.com";
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;
const clientSessions = new Map();
const MAX_RECENT_VISITS = 12;
const MAX_SAVED_VISITS = 10;
const MAX_AUDIO_BYTES = Number(process.env.MAX_AUDIO_BYTES || 80 * 1024 * 1024);
const MAX_JSON_BYTES = Number(process.env.MAX_JSON_BYTES || 2 * 1024 * 1024);
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

    if (req.method === "POST" && req.url === "/api/transcribe-chunk") {
      await handleTranscribeChunk(req, res);
      return;
    }

    if (req.method === "POST" && req.url === "/api/recap-text") {
      await handleRecapText(req, res);
      return;
    }

    if (req.method === "POST" && req.url === "/api/rework-transcript") {
      await handleReworkTranscript(req, res);
      return;
    }

    if (req.method === "POST" && req.url === "/api/draft/start") {
      await handleDraftStart(req, res);
      return;
    }

    if (req.method === "POST" && req.url === "/api/draft/discard") {
      await handleDraftDiscard(req, res);
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

server.listen(PORT, HOST, () => {
  console.log(`Recap AI pronto su http://${HOST}:${PORT}`);
});

function createLogId() {
  return randomBytes(4).toString("hex");
}

function logEvent(event, details = {}) {
  console.log(JSON.stringify({
    at: new Date().toISOString(),
    event,
    ...details
  }));
}

async function handleRecap(req, res) {
  const requestId = createLogId();
  if (!hasValidOpenAiKey()) {
    logEvent("recap_config_error", { requestId, reason: "missing_openai_key" });
    sendJson(res, 400, {
      error: "Manca una chiave OpenAI valida. Apri CONFIGURA_CHIAVE.txt e sostituisci incolla_la_tua_chiave_qui con la chiave reale."
    });
    return;
  }

  const contentType = req.headers["content-type"] || "";
  if (!contentType.includes("multipart/form-data")) {
    logEvent("recap_bad_request", { requestId, reason: "invalid_content_type" });
    sendJson(res, 400, { error: "Registra una visita prima di generare il riassunto." });
    return;
  }

  const contentLength = Number(req.headers["content-length"] || 0);
  if (contentLength > MAX_AUDIO_BYTES) {
    logEvent("recap_rejected", { requestId, reason: "audio_too_large", contentLength });
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
    logEvent("recap_unauthorized", { requestId });
    sendJson(res, 401, { error: "Sessione scaduta. Effettua di nuovo il login." });
    return;
  }

  refreshClientMonth(client);
  if (client.status !== "active") {
    logEvent("recap_forbidden", { requestId, clientId: client.id, reason: "client_inactive" });
    sendJson(res, 403, { error: "Cliente sospeso. Contatta l'amministratore." });
    return;
  }

  if (client.usedThisMonth >= client.monthlyLimit) {
    logEvent("recap_forbidden", { requestId, clientId: client.id, reason: "monthly_limit" });
    sendJson(res, 403, { error: "Limite visite mensile raggiunto. Contatta l'amministratore." });
    return;
  }

  logEvent("recap_started", {
    requestId,
    clientId: client.id,
    durationSeconds,
    contentLength,
    audioBytes: audio.size || 0
  });

  let transcript;
  let summaryResult;
  try {
    transcript = await transcribeAudio(audio, requestId);
    summaryResult = await summarizeVisit(transcript, visitType, visitContext, client.summaryPrompt, requestId);
  } catch (error) {
    logEvent("recap_failed", {
      requestId,
      clientId: client.id,
      message: error.message
    });
    throw error;
  }

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
  logEvent("recap_completed", {
    requestId,
    clientId: client.id,
    usedThisMonth: client.usedThisMonth,
    monthlyLimit: client.monthlyLimit
  });

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

async function handleTranscribeChunk(req, res) {
  const requestId = createLogId();
  if (!hasValidOpenAiKey()) {
    logEvent("chunk_config_error", { requestId, reason: "missing_openai_key" });
    sendJson(res, 400, { error: "Manca una chiave OpenAI valida." });
    return;
  }

  const contentType = req.headers["content-type"] || "";
  if (!contentType.includes("multipart/form-data")) {
    logEvent("chunk_bad_request", { requestId, reason: "invalid_content_type" });
    sendJson(res, 400, { error: "Audio non ricevuto." });
    return;
  }

  const contentLength = Number(req.headers["content-length"] || 0);
  if (contentLength > MAX_AUDIO_BYTES) {
    logEvent("chunk_rejected", { requestId, reason: "audio_too_large", contentLength });
    sendJson(res, 413, { error: "Blocco audio troppo grande." });
    return;
  }

  const store = await loadStore();
  const client = getClientFromSession(req, store);
  if (!client) {
    logEvent("chunk_unauthorized", { requestId });
    sendJson(res, 401, { error: "Sessione scaduta. Effettua di nuovo il login." });
    return;
  }

  refreshClientMonth(client);
  if (client.status !== "active") {
    logEvent("chunk_forbidden", { requestId, clientId: client.id, reason: "client_inactive" });
    sendJson(res, 403, { error: "Cliente sospeso. Contatta l'amministratore." });
    return;
  }

  if (client.usedThisMonth >= client.monthlyLimit) {
    logEvent("chunk_forbidden", { requestId, clientId: client.id, reason: "monthly_limit" });
    sendJson(res, 403, { error: "Limite visite mensile raggiunto. Contatta l'amministratore." });
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
  const chunkIndex = Number(form.get("chunkIndex") || 0);
  const chunkDurationSeconds = Number(form.get("chunkDurationSeconds") || 0);
  const draftId = String(form.get("draftId") || "");

  if (!audio || typeof audio === "string") {
    sendJson(res, 400, { error: "Audio non ricevuto." });
    return;
  }

  logEvent("chunk_transcription_started", {
    requestId,
    clientId: client.id,
    chunkIndex,
    audioBytes: audio.size || 0
  });

  try {
    const text = await transcribeAudio(audio, requestId);
    const transcriptionCostUsd = transcriptionCostForSeconds(chunkDurationSeconds);
    applyTranscriptionUsageStats(client, chunkDurationSeconds, transcriptionCostUsd);
    if (draftId && client.activeDraft?.id === draftId) {
      appendDraftTranscript(client.activeDraft, chunkIndex, text);
      client.activeDraft.transcriptionCostUsd = Number(client.activeDraft.transcriptionCostUsd || 0) + transcriptionCostUsd;
    }
    await saveStore(store);
    logEvent("chunk_transcription_completed", {
      requestId,
      clientId: client.id,
      chunkIndex,
      chunkDurationSeconds,
      transcriptionCostUsd,
      characters: text.length
    });
    sendJson(res, 200, { transcript: text, chunkIndex });
  } catch (error) {
    logEvent("chunk_transcription_failed", {
      requestId,
      clientId: client.id,
      chunkIndex,
      message: error.message
    });
    throw error;
  }
}

async function handleRecapText(req, res) {
  const requestId = createLogId();
  if (!hasValidOpenAiKey()) {
    logEvent("recap_text_config_error", { requestId, reason: "missing_openai_key" });
    sendJson(res, 400, { error: "Manca una chiave OpenAI valida." });
    return;
  }

  const body = await readJsonBody(req);
  const draftId = String(body.draftId || "");
  let transcript = String(body.transcript || "").trim();
  let patientName = String(body.patientName || "");
  let visitType = String(body.visitType || "visita nutrizionale");
  let visitContext = String(body.visitContext || "");
  let durationSeconds = Number(body.durationSeconds || 0);

  const store = await loadStore();
  const client = getClientFromSession(req, store);
  if (!client) {
    logEvent("recap_text_unauthorized", { requestId });
    sendJson(res, 401, { error: "Sessione scaduta. Effettua di nuovo il login." });
    return;
  }

  refreshClientMonth(client);
  if (client.status !== "active") {
    logEvent("recap_text_forbidden", { requestId, clientId: client.id, reason: "client_inactive" });
    sendJson(res, 403, { error: "Cliente sospeso. Contatta l'amministratore." });
    return;
  }

  if (client.usedThisMonth >= client.monthlyLimit) {
    logEvent("recap_text_forbidden", { requestId, clientId: client.id, reason: "monthly_limit" });
    sendJson(res, 403, { error: "Limite visite mensile raggiunto. Contatta l'amministratore." });
    return;
  }

  if (draftId && client.activeDraft?.id === draftId) {
    transcript = String(client.activeDraft.transcript || transcript).trim();
    patientName = String(client.activeDraft.patientName || patientName);
    visitType = String(client.activeDraft.visitType || visitType);
    visitContext = String(client.activeDraft.visitContext || visitContext);
    durationSeconds = Number(durationSeconds || client.activeDraft.durationSeconds || 0);
  }

  if (!transcript) {
    sendJson(res, 400, { error: "Trascrizione vuota. Riprova la registrazione." });
    return;
  }

  logEvent("recap_text_started", {
    requestId,
    clientId: client.id,
    durationSeconds,
    transcriptCharacters: transcript.length
  });

  let summaryResult;
  try {
    summaryResult = await summarizeVisit(transcript, visitType, visitContext, client.summaryPrompt, requestId);
  } catch (error) {
    logEvent("recap_text_failed", {
      requestId,
      clientId: client.id,
      message: error.message
    });
    throw error;
  }

  const summary = summaryResult.text;
  const liveTranscriptionCostUsd = draftId && client.activeDraft?.id === draftId
    ? Number(client.activeDraft.transcriptionCostUsd || 0)
    : 0;
  const visitStats = buildVisitStats(durationSeconds, summaryResult.usage, {
    transcribeCostUsd: liveTranscriptionCostUsd
  });
  client.usedThisMonth += 1;
  client.totalVisits = (client.totalVisits || 0) + 1;
  applyUsageStats(client, visitStats, { includeTranscriptionCost: !liveTranscriptionCostUsd });
  saveClientVisit(client, {
    patientName,
    visitType,
    transcript,
    summary,
    stats: visitStats
  });
  if (draftId && client.activeDraft?.id === draftId) {
    delete client.activeDraft;
  }
  client.lastUsedAt = new Date().toISOString();
  await saveStore(store);
  logEvent("recap_text_completed", {
    requestId,
    clientId: client.id,
    usedThisMonth: client.usedThisMonth,
    monthlyLimit: client.monthlyLimit
  });

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

async function handleReworkTranscript(req, res) {
  const requestId = createLogId();
  const body = await readJsonBody(req);
  const transcript = String(body.transcript || "").trim();
  const visitType = String(body.visitType || "visita professionale");

  if (!transcript) {
    sendJson(res, 400, { error: "Trascrizione vuota." });
    return;
  }

  const store = await loadStore();
  const client = getClientFromSession(req, store);
  if (!client) {
    logEvent("rework_unauthorized", { requestId });
    sendJson(res, 401, { error: "Sessione scaduta. Effettua di nuovo il login." });
    return;
  }

  refreshClientMonth(client);
  if (client.status !== "active") {
    sendJson(res, 403, { error: "Cliente sospeso. Contatta l'amministratore." });
    return;
  }

  logEvent("rework_started", {
    requestId,
    clientId: client.id,
    transcriptCharacters: transcript.length
  });

  try {
    const result = await reworkTranscript(transcript, visitType, requestId);
    applyTextModelUsageStats(client, result.usage);
    await saveStore(store);
    logEvent("rework_completed", {
      requestId,
      clientId: client.id,
      characters: result.text.length
    });
    sendJson(res, 200, {
      transcript: result.text,
      usage: {
        stats: clientUsageStats(client)
      }
    });
  } catch (error) {
    logEvent("rework_failed", {
      requestId,
      clientId: client.id,
      message: error.message
    });
    throw error;
  }
}

async function handleDraftStart(req, res) {
  const requestId = createLogId();
  const body = await readJsonBody(req);
  const store = await loadStore();
  const client = getClientFromSession(req, store);
  if (!client) {
    logEvent("draft_start_unauthorized", { requestId });
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

  client.activeDraft = {
    id: randomUUID(),
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    patientName: String(body.patientName || ""),
    visitType: String(body.visitType || "visita nutrizionale"),
    visitContext: String(body.visitContext || ""),
    durationSeconds: 0,
    transcriptionCostUsd: 0,
    transcriptParts: [],
    transcript: ""
  };
  await saveStore(store);
  logEvent("draft_started", { requestId, clientId: client.id, draftId: client.activeDraft.id });
  sendJson(res, 201, { draft: publicDraft(client.activeDraft) });
}

async function handleDraftDiscard(req, res) {
  const requestId = createLogId();
  const body = await readJsonBody(req);
  const draftId = String(body.draftId || "");
  const store = await loadStore();
  const client = getClientFromSession(req, store);
  if (!client) {
    logEvent("draft_discard_unauthorized", { requestId });
    sendJson(res, 401, { error: "Sessione scaduta. Effettua di nuovo il login." });
    return;
  }

  if (!draftId || client.activeDraft?.id === draftId) {
    delete client.activeDraft;
    await saveStore(store);
  }
  logEvent("draft_discarded", { requestId, clientId: client.id, draftId });
  sendJson(res, 200, { discarded: true });
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
    const welcomeEmail = await sendWelcomeEmail(client, password);
    sendJson(res, 201, { client: adminClient(client), password, welcomeEmail });
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
    const welcomeEmail = body.sendWelcomeEmail === true ? await sendWelcomeEmail(client, password) : { sent: false, reason: "not_requested" };
    sendJson(res, 200, { client: adminClient(client), password, welcomeEmail });
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
    client.monthlyTranscriptionSeconds = 0;
    client.monthlySummaryInputTokens = 0;
    client.monthlySummaryOutputTokens = 0;
    client.monthlyTranscriptionCostUsd = 0;
    client.monthlyTextModelCostUsd = 0;
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

async function transcribeAudio(audioFile, requestId) {
  logEvent("transcription_started", {
    requestId,
    model: TRANSCRIBE_MODEL,
    audioBytes: audioFile.size || 0
  });
  const data = new FormData();
  data.append("model", TRANSCRIBE_MODEL);
  data.append("language", "it");
  data.append("response_format", "json");
  data.append("prompt", TRANSCRIBE_PROMPT);
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
    logEvent("transcription_failed", {
      requestId,
      status: response.status,
      message: payload.error?.message || "Trascrizione non riuscita."
    });
    throw new Error(payload.error?.message || "Trascrizione non riuscita.");
  }

  logEvent("transcription_completed", {
    requestId,
    characters: (payload.text || "").length
  });
  return payload.text || "";
}

async function summarizeVisit(transcript, visitType, visitContext, summaryPrompt, requestId) {
  logEvent("summary_started", {
    requestId,
    model: SUMMARY_MODEL,
    transcriptCharacters: transcript.length
  });
  const clientPrompt = cleanOptionalText(summaryPrompt || defaultSummaryPrompt());
  const prompt = `
Prompt generale del cliente:
${clientPrompt}

Compito:
Trasforma la trascrizione di una ${visitType} in una scheda precisa, utile e modificabile.

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
    logEvent("summary_failed", {
      requestId,
      status: response.status,
      message: payload.error?.message || "Riassunto non riuscito."
    });
    throw new Error(payload.error?.message || "Riassunto non riuscito.");
  }

  const text = payload.output_text || extractResponseText(payload);
  logEvent("summary_completed", {
    requestId,
    characters: text.length
  });

  return {
    text,
    usage: normalizeResponseUsage(payload.usage)
  };
}

async function reworkTranscript(transcript, visitType, requestId) {
  const prompt = `
Rielabora questa trascrizione di una ${visitType}.

Obiettivo:
- Correggi refusi evidenti della trascrizione.
- Metti le informazioni in ordine logico e leggibile.
- Mantieni il contenuto fedele: non inventare dati, diagnosi, misure, farmaci, alimenti o indicazioni.
- Se una frase e' incerta, mantienila con "Da verificare".
- Non creare un riassunto: conserva i dettagli importanti, ma rendili chiari.
- Rimuovi ripetizioni, esitazioni e frammenti inutili solo se non cambiano il significato.

Formato:
Trascrizione rielaborata

Partecipanti / contesto:

Punti emersi in ordine:

Dettagli citati:

Indicazioni o decisioni:

Punti da verificare:

Testo ordinato:

Trascrizione originale:
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
      temperature: 0.1
    })
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error?.message || "Rielaborazione non riuscita.");
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

function defaultSummaryPrompt() {
  return `Sei Recap AI, un assistente di documentazione per professionisti sanitari e consulenze.
Il cliente principale e' una nutrizionista: crea un riepilogo preciso, professionale e utile per cartella/appunti.
Evidenzia motivo della visita, obiettivi, dati citati, abitudini alimentari, stile di vita, criticita', indicazioni concordate, azioni per il paziente, azioni per il professionista, follow-up e note da verificare.
Non inventare informazioni non presenti nella trascrizione. Se qualcosa non emerge, scrivi "Non emerso".`;
}

function normalizeSummaryPrompt(value) {
  const text = String(value || "").trim();
  return text || defaultSummaryPrompt();
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

async function sendWelcomeEmail(client, password) {
  if (!SMTP_HOST || !SMTP_FROM) {
    return { sent: false, reason: "smtp_not_configured" };
  }

  const subject = "Benvenuto in Recap AI";
  const text = [
    `Ciao ${client.name},`,
    "",
    "la tua area Recap AI e' pronta.",
    "",
    `Link: ${APP_URL}`,
    `Email: ${client.email}`,
    `Password: ${password}`,
    "",
    "Ti consigliamo di conservare queste credenziali in modo sicuro.",
    "",
    "Recap AI"
  ].join("\n");

  try {
    await sendSmtpMail({
      to: client.email,
      subject,
      text
    });
    logEvent("welcome_email_sent", { clientId: client.id, email: client.email });
    return { sent: true };
  } catch (error) {
    logEvent("welcome_email_failed", { clientId: client.id, email: client.email, message: error.message });
    return { sent: false, reason: error.message };
  }
}

async function sendSmtpMail({ to, subject, text }) {
  let socket = await openSmtpSocket(SMTP_PORT === 465);
  try {
    await expectSmtp(socket, 220);
    await smtpCommand(socket, `EHLO ${SMTP_HOST}`, 250);

    if (SMTP_PORT !== 465) {
      await smtpCommand(socket, "STARTTLS", 220);
      socket = await upgradeSmtpSocket(socket);
      await smtpCommand(socket, `EHLO ${SMTP_HOST}`, 250);
    }

    if (SMTP_USER && SMTP_PASS) {
      await smtpCommand(socket, "AUTH LOGIN", 334);
      await smtpCommand(socket, Buffer.from(SMTP_USER).toString("base64"), 334);
      await smtpCommand(socket, Buffer.from(SMTP_PASS).toString("base64"), 235);
    }

    const fromAddress = extractEmailAddress(SMTP_FROM);
    const message = buildEmailMessage(fromAddress, to, subject, text);
    await smtpCommand(socket, `MAIL FROM:<${fromAddress}>`, 250);
    await smtpCommand(socket, `RCPT TO:<${to}>`, 250);
    await smtpCommand(socket, "DATA", 354);
    await smtpCommand(socket, `${message}\r\n.`, 250);
    await smtpCommand(socket, "QUIT", 221);
  } finally {
    socket.end();
  }
}

function openSmtpSocket(secure) {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tlsConnect(SMTP_PORT, SMTP_HOST, { servername: SMTP_HOST }, () => resolve(socket))
      : netConnect(SMTP_PORT, SMTP_HOST, () => resolve(socket));
    socket.setTimeout(15000, () => {
      socket.destroy();
      reject(new Error("Timeout invio email."));
    });
    socket.once("error", reject);
  });
}

function upgradeSmtpSocket(socket) {
  return new Promise((resolve, reject) => {
    socket.removeAllListeners("data");
    socket.removeAllListeners("error");
    const tlsSocket = tlsConnect({ socket, servername: SMTP_HOST }, () => resolve(tlsSocket));
    tlsSocket.setTimeout(15000, () => {
      tlsSocket.destroy();
      reject(new Error("Timeout invio email."));
    });
    tlsSocket.once("error", reject);
  });
}

function smtpCommand(socket, command, expectedCode) {
  socket.write(`${command}\r\n`);
  return expectSmtp(socket, expectedCode);
}

function expectSmtp(socket, expectedCode) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      const lastLine = lines.at(-1) || "";
      if (/^\d{3}-/.test(lastLine) || !/^\d{3} /.test(lastLine)) return;
      cleanup();
      if (!lastLine.startsWith(String(expectedCode))) {
        reject(new Error(`SMTP ${lastLine || "risposta non valida"}`));
        return;
      }
      resolve(lastLine);
    };
    socket.on("data", onData);
    socket.once("error", onError);
  });
}

function buildEmailMessage(from, to, subject, text) {
  return [
    `From: ${SMTP_FROM}`,
    `To: ${to}`,
    `Subject: ${encodeMailSubject(subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    text.replace(/^\./gm, "..").replace(/\r?\n/g, "\r\n")
  ].join("\r\n");
}

function encodeMailSubject(subject) {
  return `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

function extractEmailAddress(value) {
  const match = String(value || "").match(/<([^>]+)>/);
  return (match?.[1] || value || SMTP_USER).trim();
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
    summaryPrompt: normalizeSummaryPrompt(body.summaryPrompt),
    totalVisits: 0,
    totalSeconds: 0,
    monthlySeconds: 0,
    totalTranscriptionSeconds: 0,
    monthlyTranscriptionSeconds: 0,
    totalSummaryInputTokens: 0,
    totalSummaryOutputTokens: 0,
    monthlySummaryInputTokens: 0,
    monthlySummaryOutputTokens: 0,
    totalTranscriptionCostUsd: 0,
    monthlyTranscriptionCostUsd: 0,
    totalTextModelCostUsd: 0,
    monthlyTextModelCostUsd: 0,
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
  if (body.summaryPrompt !== undefined) client.summaryPrompt = normalizeSummaryPrompt(body.summaryPrompt);
  refreshClientMonth(client);
}

function refreshClientMonth(client) {
  const month = currentMonth();
  if (client.month !== month) {
    client.month = month;
    client.usedThisMonth = 0;
    client.monthlySeconds = 0;
    client.monthlyTranscriptionSeconds = 0;
    client.monthlySummaryInputTokens = 0;
    client.monthlySummaryOutputTokens = 0;
    client.monthlyTranscriptionCostUsd = 0;
    client.monthlyTextModelCostUsd = 0;
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
    savedVisits: client.savedVisits || [],
    activeDraft: client.activeDraft ? publicDraft(client.activeDraft) : null
  };
}

function publicDraft(draft) {
  return {
    id: draft.id,
    startedAt: draft.startedAt,
    updatedAt: draft.updatedAt,
    patientName: draft.patientName || "",
    visitType: draft.visitType || "visita nutrizionale",
    visitContext: draft.visitContext || "",
    durationSeconds: Number(draft.durationSeconds || 0),
    transcript: draft.transcript || ""
  };
}

function adminClient(client) {
  return {
    ...publicClient(client),
    createdAt: client.createdAt,
    notes: client.notes || "",
    summaryPrompt: client.summaryPrompt || defaultSummaryPrompt(),
    hasPassword: Boolean(client.passwordHash)
  };
}

function applyUsageStats(client, stats, options = {}) {
  const includeTranscriptionCost = options.includeTranscriptionCost !== false;
  client.totalSeconds = Number(client.totalSeconds || 0) + stats.durationSeconds;
  client.monthlySeconds = Number(client.monthlySeconds || 0) + stats.durationSeconds;
  client.totalSummaryInputTokens = Number(client.totalSummaryInputTokens || 0) + stats.summaryInputTokens;
  client.totalSummaryOutputTokens = Number(client.totalSummaryOutputTokens || 0) + stats.summaryOutputTokens;
  client.monthlySummaryInputTokens = Number(client.monthlySummaryInputTokens || 0) + stats.summaryInputTokens;
  client.monthlySummaryOutputTokens = Number(client.monthlySummaryOutputTokens || 0) + stats.summaryOutputTokens;
  if (includeTranscriptionCost) {
    client.totalTranscriptionCostUsd = Number(client.totalTranscriptionCostUsd || 0) + stats.transcribeCostUsd;
    client.monthlyTranscriptionCostUsd = Number(client.monthlyTranscriptionCostUsd || 0) + stats.transcribeCostUsd;
    client.totalTranscriptionSeconds = Number(client.totalTranscriptionSeconds || 0) + stats.durationSeconds;
    client.monthlyTranscriptionSeconds = Number(client.monthlyTranscriptionSeconds || 0) + stats.durationSeconds;
  }
  client.totalTextModelCostUsd = Number(client.totalTextModelCostUsd || 0) + stats.summaryCostUsd;
  client.monthlyTextModelCostUsd = Number(client.monthlyTextModelCostUsd || 0) + stats.summaryCostUsd;
  const costToAdd = stats.summaryCostUsd + (includeTranscriptionCost ? stats.transcribeCostUsd : 0);
  client.totalEstimatedCostUsd = Number(client.totalEstimatedCostUsd || 0) + costToAdd;
  client.monthlyEstimatedCostUsd = Number(client.monthlyEstimatedCostUsd || 0) + costToAdd;
  client.recentVisits = [
    {
      at: new Date().toISOString(),
      durationSeconds: stats.durationSeconds,
      summaryInputTokens: stats.summaryInputTokens,
      summaryOutputTokens: stats.summaryOutputTokens,
      transcribeCostUsd: stats.transcribeCostUsd,
      summaryCostUsd: stats.summaryCostUsd,
      estimatedCostUsd: stats.estimatedCostUsd
    },
    ...(client.recentVisits || [])
  ].slice(0, MAX_RECENT_VISITS);
}

function applyTranscriptionUsageStats(client, durationSeconds, costUsd) {
  client.totalTranscriptionCostUsd = Number(client.totalTranscriptionCostUsd || 0) + costUsd;
  client.monthlyTranscriptionCostUsd = Number(client.monthlyTranscriptionCostUsd || 0) + costUsd;
  client.totalEstimatedCostUsd = Number(client.totalEstimatedCostUsd || 0) + costUsd;
  client.monthlyEstimatedCostUsd = Number(client.monthlyEstimatedCostUsd || 0) + costUsd;
  client.totalTranscriptionSeconds = Number(client.totalTranscriptionSeconds || 0) + Number(durationSeconds || 0);
  client.monthlyTranscriptionSeconds = Number(client.monthlyTranscriptionSeconds || 0) + Number(durationSeconds || 0);
}

function applyTextModelUsageStats(client, usage) {
  const inputTokens = Number(usage.inputTokens || 0);
  const outputTokens = Number(usage.outputTokens || 0);
  const costUsd =
    (inputTokens / 1_000_000) * summaryInputCostPerMillion() +
    (outputTokens / 1_000_000) * summaryOutputCostPerMillion();

  client.totalSummaryInputTokens = Number(client.totalSummaryInputTokens || 0) + inputTokens;
  client.totalSummaryOutputTokens = Number(client.totalSummaryOutputTokens || 0) + outputTokens;
  client.monthlySummaryInputTokens = Number(client.monthlySummaryInputTokens || 0) + inputTokens;
  client.monthlySummaryOutputTokens = Number(client.monthlySummaryOutputTokens || 0) + outputTokens;
  client.totalTextModelCostUsd = Number(client.totalTextModelCostUsd || 0) + costUsd;
  client.monthlyTextModelCostUsd = Number(client.monthlyTextModelCostUsd || 0) + costUsd;
  client.totalEstimatedCostUsd = Number(client.totalEstimatedCostUsd || 0) + costUsd;
  client.monthlyEstimatedCostUsd = Number(client.monthlyEstimatedCostUsd || 0) + costUsd;
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
      durationSeconds: visit.stats.durationSeconds,
      estimatedCostUsd: visit.stats.estimatedCostUsd
    },
    ...(client.savedVisits || [])
  ].slice(0, MAX_SAVED_VISITS);
}

function appendDraftTranscript(draft, chunkIndex, text) {
  draft.transcriptParts = Array.isArray(draft.transcriptParts) ? draft.transcriptParts : [];
  draft.transcriptParts[chunkIndex] = String(text || "").trim();
  draft.transcript = draft.transcriptParts.filter(Boolean).join("\n\n");
  draft.updatedAt = new Date().toISOString();
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

function buildVisitStats(durationSeconds, usage, options = {}) {
  const safeDuration = Math.max(0, Number(durationSeconds || 0));
  const summaryInputTokens = Number(usage.inputTokens || 0);
  const summaryOutputTokens = Number(usage.outputTokens || 0);
  const audioMinutes = safeDuration / 60;
  const transcribeCostUsd = options.transcribeCostUsd !== undefined
    ? Number(options.transcribeCostUsd || 0)
    : transcriptionCostForSeconds(safeDuration);
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

function transcriptionCostForSeconds(seconds) {
  return (Math.max(0, Number(seconds || 0)) / 60) * transcribeCostPerMinute();
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
    monthlyTranscriptionSeconds: Number(client.monthlyTranscriptionSeconds || 0),
    totalTranscriptionSeconds: Number(client.totalTranscriptionSeconds || 0),
    monthlyMinutes: Number((Number(client.monthlySeconds || 0) / 60).toFixed(1)),
    totalMinutes: Number((Number(client.totalSeconds || 0) / 60).toFixed(1)),
    monthlyTranscriptionMinutes: Number((Number(client.monthlyTranscriptionSeconds || 0) / 60).toFixed(1)),
    totalTranscriptionMinutes: Number((Number(client.totalTranscriptionSeconds || 0) / 60).toFixed(1)),
    monthlySummaryInputTokens: monthlyInput,
    monthlySummaryOutputTokens: monthlyOutput,
    monthlySummaryTotalTokens: monthlyInput + monthlyOutput,
    totalSummaryInputTokens: totalInput,
    totalSummaryOutputTokens: totalOutput,
    totalSummaryTotalTokens: totalInput + totalOutput,
    monthlyTranscriptionCostUsd: Number(client.monthlyTranscriptionCostUsd || 0),
    totalTranscriptionCostUsd: Number(client.totalTranscriptionCostUsd || 0),
    monthlyTextModelCostUsd: Number(client.monthlyTextModelCostUsd || 0),
    totalTextModelCostUsd: Number(client.totalTextModelCostUsd || 0),
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
      stats.monthlyTranscriptionCostUsd += usage.monthlyTranscriptionCostUsd;
      stats.totalTranscriptionCostUsd += usage.totalTranscriptionCostUsd;
      stats.monthlyTextModelCostUsd += usage.monthlyTextModelCostUsd;
      stats.totalTextModelCostUsd += usage.totalTextModelCostUsd;
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
      monthlyTranscriptionCostUsd: 0,
      totalTranscriptionCostUsd: 0,
      monthlyTextModelCostUsd: 0,
      totalTextModelCostUsd: 0,
      monthlyEstimatedCostUsd: 0,
      totalEstimatedCostUsd: 0
    }
  );
}

function transcribeCostPerMinute() {
  return TRANSCRIBE_MODEL.includes("mini") ? 0.003 : 0.006;
}

function summaryInputCostPerMillion() {
  if (SUMMARY_MODEL === "gpt-5.4") return 2.5;
  if (SUMMARY_MODEL.includes("mini")) return 0.75;
  if (SUMMARY_MODEL.includes("nano")) return 0.2;
  if (SUMMARY_MODEL.startsWith("gpt-5.2")) return 1.75;
  if (SUMMARY_MODEL.startsWith("gpt-5.1") || SUMMARY_MODEL.startsWith("gpt-5")) return 1.25;
  if (SUMMARY_MODEL.startsWith("gpt-4o")) return 2.5;
  return 0.2;
}

function summaryOutputCostPerMillion() {
  if (SUMMARY_MODEL === "gpt-5.4") return 15;
  if (SUMMARY_MODEL.includes("mini")) return 4.5;
  if (SUMMARY_MODEL.includes("nano")) return 1.25;
  if (SUMMARY_MODEL.startsWith("gpt-5.2")) return 14;
  if (SUMMARY_MODEL.startsWith("gpt-5.1") || SUMMARY_MODEL.startsWith("gpt-5")) return 10;
  if (SUMMARY_MODEL.startsWith("gpt-4o")) return 10;
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

function hasValidOpenAiKey() {
  return Boolean(OPENAI_API_KEY && OPENAI_API_KEY !== "incolla_la_tua_chiave_qui");
}
