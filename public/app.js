const clientLoginView = document.querySelector("#clientLoginView");
const appView = document.querySelector("#appView");
const clientLoginForm = document.querySelector("#clientLoginForm");
const clientEmail = document.querySelector("#clientEmail");
const clientPassword = document.querySelector("#clientPassword");
const loginStatus = document.querySelector("#loginStatus");
const clientLogoutBtn = document.querySelector("#clientLogoutBtn");
const clientBadge = document.querySelector("#clientBadge");
const clientNameLabel = document.querySelector("#clientNameLabel");
const clientUsageLabel = document.querySelector("#clientUsageLabel");
const clientUsageDetails = document.querySelector("#clientUsageDetails");
const clientRecentVisits = document.querySelector("#clientRecentVisits");
const savedVisitsList = document.querySelector("#savedVisitsList");
const startBtn = document.querySelector("#startBtn");
const stopBtn = document.querySelector("#stopBtn");
const resetBtn = document.querySelector("#resetBtn");
const downloadAudioBtn = document.querySelector("#downloadAudioBtn");
const copySummaryBtn = document.querySelector("#copySummaryBtn");
const printSummaryBtn = document.querySelector("#printSummaryBtn");
const pdfSummaryBtn = document.querySelector("#pdfSummaryBtn");
const copyTranscriptBtn = document.querySelector("#copyTranscriptBtn");
const reworkTranscriptBtn = document.querySelector("#reworkTranscriptBtn");
const printTranscriptBtn = document.querySelector("#printTranscriptBtn");
const pdfTranscriptBtn = document.querySelector("#pdfTranscriptBtn");
const consent = document.querySelector("#consent");
const patientName = document.querySelector("#patientName");
const visitType = document.querySelector("#visitType");
const visitContext = document.querySelector("#visitContext");
const statusText = document.querySelector("#status");
const timerText = document.querySelector("#timer");
const recordingPanel = document.querySelector("#recordingPanel");
const audioReviewPanel = document.querySelector("#audioReviewPanel");
const audioPlayer = document.querySelector("#audioPlayer");
const voiceOrb = document.querySelector("#voiceOrb");
const voiceMeter = document.querySelector("#voiceMeter");
const recordingHint = document.querySelector("#recordingHint");
const processingPanel = document.querySelector("#processingPanel");
const processingTitle = document.querySelector("#processingTitle");
const processingHint = document.querySelector("#processingHint");
const summary = document.querySelector("#summary");
const transcript = document.querySelector("#transcript");
const LIVE_CHUNK_MS = 45000;
const LIVE_TRANSCRIPTION_ENABLED = false;
const RECORDING_AUDIO_BITS_PER_SECOND = 128000;
const CHUNK_RETRY_DELAYS = [900, 2200, 4200];

let recorder;
let chunks = [];
let chunkUploadChain = Promise.resolve();
let liveTranscriptParts = [];
let liveTranscriptionFailed = false;
let liveChunkIndex = 0;
let lastChunkStartedAt = 0;
let recordingSessionId = 0;
let timer;
let audioContext;
let analyser;
let meterAnimation;
let processingTimer;
let startedAt = 0;
let shouldProcessRecording = false;
let clientToken = localStorage.getItem("recapClientToken") || "";
let currentClient = null;
let currentSummaryTitle = "Riassunto visita";
let currentDraft = null;
let latestAudioBlob = null;
let latestAudioUrl = "";
let autoRecoveryDraftId = "";

clientLoginForm.addEventListener("submit", loginClient);
clientLogoutBtn.addEventListener("click", logoutClient);
startBtn.addEventListener("click", startRecording);
stopBtn.addEventListener("click", stopRecording);
resetBtn.addEventListener("click", resetVisit);
downloadAudioBtn.addEventListener("click", downloadRecordedAudio);
copySummaryBtn.addEventListener("click", () => copyText(summary.value, "Riassunto copiato."));
printSummaryBtn.addEventListener("click", () => printDocument("Riassunto", summary.value));
pdfSummaryBtn.addEventListener("click", () => downloadPdf("Riassunto", summary.value));
copyTranscriptBtn.addEventListener("click", () => copyText(transcript.value, "Trascrizione copiata."));
reworkTranscriptBtn.addEventListener("click", reworkTranscriptText);
printTranscriptBtn.addEventListener("click", () => printDocument("Trascrizione", transcript.value));
pdfTranscriptBtn.addEventListener("click", () => downloadPdf("Trascrizione", transcript.value));
initVoiceMeter();

if (clientToken) {
  restoreSession();
}

async function loginClient(event) {
  event.preventDefault();

  const response = await fetch("/api/client/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: clientEmail.value,
      password: clientPassword.value
    })
  });

  const payload = await response.json();

  if (!response.ok) {
    loginStatus.textContent = payload.error || "Accesso non riuscito.";
    return;
  }

  clientToken = payload.token;
  currentClient = payload.client;
  localStorage.setItem("recapClientToken", clientToken);
  showApp();
}

async function restoreSession() {
  const response = await fetch("/api/client/me", {
    headers: { "x-client-token": clientToken }
  });

  if (!response.ok) {
    logoutClient();
    return;
  }

  const payload = await response.json();
  currentClient = payload.client;
  showApp();
}

function logoutClient() {
  localStorage.removeItem("recapClientToken");
  clientToken = "";
  currentClient = null;
  appView.classList.add("hidden");
  clientLoginView.classList.remove("hidden");
}

function showApp() {
  clientLoginView.classList.add("hidden");
  appView.classList.remove("hidden");
  updateClientLabels();
}

function updateClientLabels() {
  if (!currentClient) return;
  clientBadge.textContent = `${currentClient.name} - Piano ${currentClient.plan}`;
  clientNameLabel.textContent = currentClient.name;
  clientUsageLabel.textContent = `Visite mese: ${currentClient.usedThisMonth}/${currentClient.monthlyLimit}`;
  renderUsageDetails();
  renderSavedVisits();
  void autoRecoverDraft();
}

async function startRecording() {
  if (!clientToken) {
    setStatus("Effettua il login prima di registrare.");
    return;
  }

  if (!consent.checked) {
    setStatus("Prima conferma il consenso alla registrazione.");
    return;
  }

  if (currentClient?.activeDraft) await discardDraft(false);

  try {
    clearAudioDownload();
    currentDraft = await startDraft();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: { ideal: 1 },
        sampleRate: { ideal: 48000 }
      }
    });
    chunks = [];
    recordingSessionId += 1;
    chunkUploadChain = Promise.resolve();
    liveTranscriptParts = [];
    liveTranscriptionFailed = false;
    liveChunkIndex = 0;
    lastChunkStartedAt = Date.now();
    transcript.value = "";
    summary.value = "";
    setTranscriptActionsEnabled(false);
    setSummaryActionsEnabled(false);
    shouldProcessRecording = true;
    const mimeType = preferredMimeType();
    recorder = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: RECORDING_AUDIO_BITS_PER_SECOND
    });

    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
        if (LIVE_TRANSCRIPTION_ENABLED && shouldProcessRecording) {
          const now = Date.now();
          const chunkDurationSeconds = Math.max(1, Math.round((now - lastChunkStartedAt) / 1000));
          lastChunkStartedAt = now;
          queueLiveTranscription(event.data, recordingSessionId, chunkDurationSeconds);
        }
      }
    });

    recorder.addEventListener("stop", () => {
      stream.getTracks().forEach((track) => track.stop());
      stopVoiceMeter();
      if (shouldProcessRecording) {
        processAudio();
      }
    });

    recorder.start(LIVE_CHUNK_MS);
    startVoiceMeter(stream);
    startedAt = Date.now();
    timer = window.setInterval(updateTimer, 500);

    startBtn.disabled = true;
    stopBtn.disabled = false;
    consent.disabled = true;
    patientName.disabled = true;
    visitType.disabled = true;
    visitContext.disabled = true;
    recordingPanel.classList.remove("hidden");
    processingPanel.classList.add("hidden");
    setStatus("Registrazione in corso.");
  } catch (error) {
    setStatus(error?.message || "Microfono non disponibile o permesso negato.");
  }
}

function stopRecording() {
  if (!recorder || recorder.state !== "recording") return;

  stopBtn.disabled = true;
  shouldProcessRecording = true;
  window.clearInterval(timer);
  recordingPanel.classList.add("hidden");
  prepareAudioDownload();
  showProcessing("Sto trascrivendo la visita...", "Sto trasformando l'audio in testo.");
  setStatus("Sto chiudendo gli ultimi blocchi e preparo il riassunto.");
  recorder.stop();
}

async function processAudio() {
  try {
    prepareAudioDownload();
    showProcessing("Sto trascrivendo la visita completa...", "Uso l'audio intero per massima precisione.");
    if (LIVE_TRANSCRIPTION_ENABLED) await chunkUploadChain;

    const liveTranscript = liveTranscriptParts.filter(Boolean).join("\n\n").trim();
    try {
      await processFullAudio(currentDraft?.id || "");
    } catch (fullAudioError) {
      if (LIVE_TRANSCRIPTION_ENABLED && liveTranscript) {
        setStatus("Trascrizione completa non riuscita. Uso la bozza live recuperata.");
        await summarizeLiveTranscript(liveTranscript, currentDraft?.id || "");
        return;
      }
      throw fullAudioError;
    }
  } catch (error) {
    setStatus(humanError(error));
  } finally {
    startBtn.disabled = false;
    consent.disabled = false;
    patientName.disabled = false;
    visitType.disabled = false;
    visitContext.disabled = false;
    shouldProcessRecording = false;
    hideProcessing();
  }
}

function queueLiveTranscription(blob, sessionId, chunkDurationSeconds) {
  const chunkIndex = liveChunkIndex;
  liveChunkIndex += 1;
  chunkUploadChain = chunkUploadChain
    .then(() => uploadLiveChunkWithRetry(blob, chunkIndex, sessionId, chunkDurationSeconds))
    .catch((error) => {
      liveTranscriptionFailed = true;
      console.warn("Trascrizione live non riuscita, usero' il metodo completo.", error);
      setStatus("Continuo a registrare. Recupero automaticamente la trascrizione a fine visita.");
    });
}

async function uploadLiveChunkWithRetry(blob, chunkIndex, sessionId, chunkDurationSeconds) {
  let lastError;
  for (let attempt = 0; attempt <= CHUNK_RETRY_DELAYS.length; attempt += 1) {
    try {
      await uploadLiveChunk(blob, chunkIndex, sessionId, chunkDurationSeconds);
      return;
    } catch (error) {
      lastError = error;
      if (attempt >= CHUNK_RETRY_DELAYS.length || sessionId !== recordingSessionId) break;
      await wait(CHUNK_RETRY_DELAYS[attempt]);
    }
  }
  throw lastError;
}

async function uploadLiveChunk(blob, chunkIndex, sessionId, chunkDurationSeconds) {
  if (!clientToken || sessionId !== recordingSessionId || blob.size < 1200) return;

  const fileName = `visita-blocco-${chunkIndex + 1}-${new Date().toISOString().replace(/[:.]/g, "-")}.webm`;
  const form = new FormData();
  form.append("audio", blob, fileName);
  form.append("chunkIndex", chunkIndex);
  form.append("chunkDurationSeconds", chunkDurationSeconds);
  if (currentDraft?.id) form.append("draftId", currentDraft.id);

  const response = await fetch("/api/transcribe-chunk", {
    method: "POST",
    headers: { "x-client-token": clientToken },
    body: form
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Blocco audio non trascritto.");
  }

  const text = String(payload.transcript || "").trim();
  if (!text || sessionId !== recordingSessionId) return;

  liveTranscriptParts[chunkIndex] = text;
  transcript.value = liveTranscriptParts.filter(Boolean).join("\n\n");
  if (currentClient?.activeDraft?.id === currentDraft?.id) {
    currentClient.activeDraft.transcript = transcript.value;
    currentClient.activeDraft.updatedAt = new Date().toISOString();
  }
  setTranscriptActionsEnabled(true);
  setStatus(`Trascrizione live aggiornata: blocco ${chunkIndex + 1}.`);
}

async function summarizeLiveTranscript(liveTranscript, draftId = "") {
  transcript.value = liveTranscript;
  showProcessing("Sto preparando il riassunto per te...", "La trascrizione era gia' pronta: ora ordino i punti importanti.");

  const response = await fetch("/api/recap-text", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-client-token": clientToken
    },
    body: JSON.stringify({
      patientName: patientName.value,
      visitType: visitType.value,
      visitContext: visitContext.value,
      durationSeconds: Math.floor((Date.now() - startedAt) / 1000),
      transcript: liveTranscript,
      draftId
    })
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Riassunto non riuscito.");
  }

  applyRecapPayload(payload);
}

async function startDraft() {
  const response = await fetch("/api/draft/start", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-client-token": clientToken
    },
    body: JSON.stringify({
      patientName: patientName.value,
      visitType: visitType.value,
      visitContext: visitContext.value
    })
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Bozza non creata.");
  }

  currentClient.activeDraft = payload.draft;
  return payload.draft;
}

async function processFullAudio(draftId = "") {
  const audioBlob = getRecordedAudioBlob();
  const fileName = `visita-${new Date().toISOString().replace(/[:.]/g, "-")}.webm`;
  const form = new FormData();
  form.append("audio", audioBlob, fileName);
  form.append("patientName", patientName.value);
  form.append("visitType", visitType.value);
  form.append("visitContext", visitContext.value);
  form.append("durationSeconds", Math.floor((Date.now() - startedAt) / 1000));
  if (draftId) form.append("draftId", draftId);

  showProcessing("Sto trascrivendo la visita completa...", "Uso l'audio intero per massima precisione.");
  const response = await fetch("/api/recap", {
    method: "POST",
    headers: { "x-client-token": clientToken },
    body: form
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || "Elaborazione non riuscita.");
  }

  applyRecapPayload(payload);
}

function applyRecapPayload(payload) {
  transcript.value = payload.transcript;
  summary.value = payload.summary;
  setTranscriptActionsEnabled(Boolean(payload.transcript));
  setSummaryActionsEnabled(Boolean(payload.summary));
  currentClient.usedThisMonth = payload.usage.usedThisMonth;
  currentClient.monthlyLimit = payload.usage.monthlyLimit;
  currentClient.usageStats = payload.usage.stats;
  currentClient.recentVisits = [
    {
      at: new Date().toISOString(),
      ...payload.usage.lastVisit
    },
    ...(currentClient.recentVisits || [])
  ].slice(0, 12);
  currentClient.savedVisits = payload.usage.savedVisits || currentClient.savedVisits || [];
  currentClient.activeDraft = null;
  currentDraft = null;
  currentSummaryTitle = currentClient.savedVisits?.[0]?.title || buildLocalVisitTitle();
  updateClientLabels();
  setStatus(`Riassunto pronto. Visite usate: ${payload.usage.usedThisMonth}/${payload.usage.monthlyLimit}.`);
}

function resetVisit() {
  if (recorder?.state === "recording") {
    shouldProcessRecording = false;
    recorder.stop();
  }

  chunks = [];
  clearAudioDownload();
  recordingSessionId += 1;
  chunkUploadChain = Promise.resolve();
  liveTranscriptParts = [];
  liveTranscriptionFailed = false;
  liveChunkIndex = 0;
  if (currentDraft?.id) void discardDraft(false);
  currentDraft = null;
  transcript.value = "";
  summary.value = "";
  setTranscriptActionsEnabled(false);
  setSummaryActionsEnabled(false);
  currentSummaryTitle = "Riassunto visita";
  startBtn.disabled = false;
  stopBtn.disabled = true;
  downloadAudioBtn.disabled = true;
  recordingPanel.classList.add("hidden");
  hideProcessing();
  stopVoiceMeter();
  consent.disabled = false;
  patientName.disabled = false;
  patientName.value = "";
  visitType.disabled = false;
  visitContext.disabled = false;
  window.clearInterval(timer);
  timerText.textContent = "00:00";
  setStatus("Pronto per iniziare.");
}

async function autoRecoverDraft() {
  const draft = currentClient?.activeDraft;
  if (!draft?.transcript || transcript.value || summary.value || autoRecoveryDraftId === draft.id) return;
  autoRecoveryDraftId = draft.id;
  currentDraft = draft;
  patientName.value = draft.patientName || "";
  visitType.value = draft.visitType || visitType.value;
  visitContext.value = draft.visitContext || "";
  transcript.value = draft.transcript || "";
  summary.value = "";
  setTranscriptActionsEnabled(Boolean(transcript.value));
  setSummaryActionsEnabled(false);
  setStatus("Recupero automatico della visita in corso.");

  try {
    showProcessing("Sto recuperando la visita...", "Ho trovato una trascrizione salvata automaticamente e preparo il riassunto.");
    await summarizeLiveTranscript(draft.transcript, draft.id);
  } catch (error) {
    setStatus(`Trascrizione recuperata. ${humanError(error)}`);
  } finally {
    hideProcessing();
  }
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function humanError(error) {
  const message = String(error?.message || "");
  if (/sessione|unauthorized|401/i.test(message)) {
    return "Sessione scaduta. Accedi di nuovo e riprova.";
  }
  if (/limite|monthly/i.test(message)) {
    return "Limite visite raggiunto. Contatta l'amministratore.";
  }
  if (/network|fetch|failed|timeout|ECONN|ETIMEDOUT/i.test(message)) {
    return "Connessione instabile. La trascrizione salvata verra' recuperata automaticamente.";
  }
  if (/audio|trascr/i.test(message)) {
    return "Non sono riuscito a completare la trascrizione. Scarica l'audio e riprova.";
  }
  if (/riassunto|summary/i.test(message)) {
    return "La trascrizione e' pronta, ma il riassunto non e' riuscito. Riprova tra poco.";
  }
  return "Qualcosa non e' andato. Ho mantenuto quello che era gia' stato salvato.";
}

async function discardDraft(showMessage = true) {
  const draft = currentClient?.activeDraft;
  if (!draft) return;

  const response = await fetch("/api/draft/discard", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-client-token": clientToken
    },
    body: JSON.stringify({ draftId: draft.id })
  });

  if (response.ok) {
    currentClient.activeDraft = null;
    currentDraft = null;
    if (showMessage) setStatus("Bozza eliminata.");
  }
}

function prepareAudioDownload() {
  if (!chunks.length) return;
  latestAudioBlob = getRecordedAudioBlob();
  if (latestAudioUrl) URL.revokeObjectURL(latestAudioUrl);
  latestAudioUrl = URL.createObjectURL(latestAudioBlob);
  audioPlayer.src = latestAudioUrl;
  audioReviewPanel.classList.remove("hidden");
  downloadAudioBtn.disabled = false;
}

function getRecordedAudioBlob() {
  return latestAudioBlob || new Blob(chunks, { type: chunks[0]?.type || "audio/webm" });
}

function downloadRecordedAudio() {
  if (!latestAudioBlob) prepareAudioDownload();
  if (!latestAudioUrl) {
    setStatus("Nessun audio disponibile da scaricare.");
    return;
  }

  const link = document.createElement("a");
  link.href = latestAudioUrl;
  link.download = `recap-audio-${new Date().toISOString().replace(/[:.]/g, "-")}.webm`;
  document.body.append(link);
  link.click();
  link.remove();
  setStatus("Audio scaricato. Il file resta solo sul dispositivo.");
}

function clearAudioDownload() {
  latestAudioBlob = null;
  if (latestAudioUrl) URL.revokeObjectURL(latestAudioUrl);
  latestAudioUrl = "";
  audioPlayer.removeAttribute("src");
  audioPlayer.load();
  audioReviewPanel.classList.add("hidden");
  downloadAudioBtn.disabled = true;
}

async function copyText(value, message) {
  if (!value) return;
  await navigator.clipboard.writeText(value);
  setStatus(message);
}

function updateTimer() {
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  timerText.textContent = `${pad(minutes)}:${pad(remainder)}`;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function setStatus(message) {
  statusText.textContent = message;
}

function initVoiceMeter() {
  voiceMeter.innerHTML = Array.from({ length: 16 }, (_, index) => `<span style="--i:${index}"></span>`).join("");
}

function startVoiceMeter(stream) {
  audioContext = new AudioContext({ sampleRate: 48000 });
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.72;
  const source = audioContext.createMediaStreamSource(stream);
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  const bars = [...voiceMeter.querySelectorAll("span")];

  const draw = () => {
    analyser.getByteFrequencyData(data);
    const average = data.reduce((sum, value) => sum + value, 0) / data.length;
    const voiceLevel = Math.min(1, average / 48);
    bars.forEach((bar, index) => {
      const wave = Math.sin(Date.now() / 130 + index * 0.65) * 0.18 + 0.82;
      const height = Math.max(10, Math.round((voiceLevel * wave + 0.08) * 58));
      bar.style.height = `${height}px`;
      bar.style.opacity = String(Math.max(0.28, voiceLevel + 0.22));
    });
    const orbScale = (1 + voiceLevel * 0.32).toFixed(3);
    voiceOrb.style.setProperty("--voice-level", voiceLevel.toFixed(3));
    voiceOrb.style.setProperty("--orb-glow", `${Math.round(22 + voiceLevel * 34)}px`);
    voiceOrb.style.setProperty("--orb-glow-wide", `${Math.round(48 + voiceLevel * 58)}px`);
    voiceOrb.style.setProperty("--orb-ring-1", `${Math.round(-15 - voiceLevel * 18)}px`);
    voiceOrb.style.setProperty("--orb-ring-2", `${Math.round(-28 - voiceLevel * 22)}px`);
    voiceOrb.style.setProperty("--orb-ring-3", `${Math.round(-42 - voiceLevel * 25)}px`);
    voiceOrb.style.setProperty("--orb-opacity", (0.34 + voiceLevel * 0.54).toFixed(3));
    voiceOrb.style.transform = `scale(${orbScale})`;
    recordingHint.textContent = voiceLevel > 0.10 ? "Voce rilevata. Registrazione in corso." : "Sto ascoltando. Parla vicino al microfono.";
    meterAnimation = requestAnimationFrame(draw);
  };

  draw();
}

function stopVoiceMeter() {
  if (meterAnimation) cancelAnimationFrame(meterAnimation);
  meterAnimation = null;
  if (audioContext) audioContext.close().catch(() => {});
  audioContext = null;
  analyser = null;
  voiceOrb.style.setProperty("--voice-level", "0");
  voiceOrb.style.setProperty("--orb-glow", "22px");
  voiceOrb.style.setProperty("--orb-glow-wide", "48px");
  voiceOrb.style.setProperty("--orb-ring-1", "-15px");
  voiceOrb.style.setProperty("--orb-ring-2", "-28px");
  voiceOrb.style.setProperty("--orb-ring-3", "-42px");
  voiceOrb.style.setProperty("--orb-opacity", "0.34");
  voiceOrb.style.transform = "scale(1)";
}

function showProcessing(title, hint) {
  processingPanel.classList.remove("hidden");
  processingTitle.textContent = title;
  processingHint.textContent = hint;
  window.clearTimeout(processingTimer);
  processingTimer = window.setTimeout(() => {
    processingTitle.textContent = "Sto preparando il riassunto per te...";
    processingHint.textContent = "Sto mettendo in ordine punti salienti, indicazioni e follow-up.";
  }, 2200);
}

function hideProcessing() {
  processingPanel.classList.add("hidden");
  window.clearTimeout(processingTimer);
}

function renderUsageDetails() {
  const remainingVisits = Math.max(0, currentClient.monthlyLimit - currentClient.usedThisMonth);
  clientUsageDetails.innerHTML = `
    <div><strong>${currentClient.usedThisMonth}/${currentClient.monthlyLimit}</strong><span>Visite mese</span></div>
    <div><strong>${remainingVisits}</strong><span>Visite disponibili</span></div>
    <div><strong>${currentClient.plan}</strong><span>Piano attivo</span></div>
    <div><strong>${currentClient.lastUsedAt ? new Date(currentClient.lastUsedAt).toLocaleDateString("it-IT") : "Mai"}</strong><span>Ultimo recap</span></div>
  `;

  const visits = currentClient.recentVisits || [];
  clientRecentVisits.innerHTML = visits.length
    ? visits
        .slice(0, 5)
        .map((visit) => {
          return `<p>${new Date(visit.at).toLocaleString("it-IT")} - recap generato</p>`;
        })
        .join("")
    : "<p>Nessun recap generato.</p>";
}

function renderSavedVisits() {
  const visits = currentClient?.savedVisits || [];
  if (!visits.length) {
    savedVisitsList.innerHTML = `<p class="empty-history">Nessuna visita salvata.</p>`;
    return;
  }

  savedVisitsList.innerHTML = "";
  visits.slice(0, 10).forEach((visit) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "saved-visit-item";
    button.innerHTML = `
      <strong>${escapeHtml(visit.title || "Visita")}</strong>
      <span>${escapeHtml(visit.visitType || "Visita")} - ${new Date(visit.at).toLocaleString("it-IT")}</span>
    `;
    button.addEventListener("click", () => openSavedVisit(visit));
    savedVisitsList.append(button);
  });
}

function openSavedVisit(visit) {
  summary.value = visit.summary || "";
  transcript.value = visit.transcript || "";
  setSummaryActionsEnabled(Boolean(summary.value));
  setTranscriptActionsEnabled(Boolean(transcript.value));
  currentSummaryTitle = visit.title || "Riassunto visita";
  setStatus(`Visita caricata: ${visit.title || "recap salvato"}.`);
}

function setSummaryActionsEnabled(enabled) {
  copySummaryBtn.disabled = !enabled;
  printSummaryBtn.disabled = !enabled;
  pdfSummaryBtn.disabled = !enabled;
}

function setTranscriptActionsEnabled(enabled) {
  copyTranscriptBtn.disabled = !enabled;
  reworkTranscriptBtn.disabled = !enabled;
  printTranscriptBtn.disabled = !enabled;
  pdfTranscriptBtn.disabled = !enabled;
}

async function reworkTranscriptText() {
  if (!transcript.value.trim()) {
    setStatus("Non c'e' ancora una trascrizione da rielaborare.");
    return;
  }

  try {
    reworkTranscriptBtn.disabled = true;
    showProcessing("Sto rielaborando la trascrizione...", "Metto il testo in ordine logico senza inventare informazioni.");
    const response = await fetch("/api/rework-transcript", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-client-token": clientToken
      },
      body: JSON.stringify({
        visitType: visitType.value,
        transcript: transcript.value
      })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Rielaborazione non riuscita.");
    }

    transcript.value = payload.transcript || transcript.value;
    if (currentClient && payload.usage?.stats) {
      currentClient.usageStats = payload.usage.stats;
      renderUsageDetails();
    }
    setTranscriptActionsEnabled(Boolean(transcript.value));
    setStatus("Trascrizione rielaborata e ordinata.");
  } catch (error) {
    setStatus(humanError(error));
  } finally {
    hideProcessing();
    reworkTranscriptBtn.disabled = !transcript.value.trim();
  }
}

function printDocument(kind, text) {
  if (!text.trim()) {
    setStatus("Non c'e' ancora un documento da stampare.");
    return;
  }

  const printWindow = window.open("", "_blank", "width=900,height=1100");
  if (!printWindow) {
    setStatus("Consenti i popup per stampare il documento.");
    return;
  }

  const title = `${kind} - ${currentSummaryTitle || buildLocalVisitTitle()}`;
  const createdAt = new Date().toLocaleString("it-IT");
  const body = escapeHtml(text).replaceAll("\n", "<br />");

  printWindow.document.write(`
    <!doctype html>
    <html lang="it">
      <head>
        <meta charset="UTF-8" />
        <title>${escapeHtml(title)}</title>
        <style>
          body {
            margin: 0;
            padding: 34px;
            color: #17201f;
            font-family: Arial, Helvetica, sans-serif;
            line-height: 1.55;
          }
          header {
            border-bottom: 1px solid #d9e4e2;
            margin-bottom: 24px;
            padding-bottom: 16px;
          }
          .brand {
            color: #087b83;
            font-size: 12px;
            letter-spacing: 0.08em;
            text-transform: uppercase;
          }
          h1 {
            margin: 8px 0;
            font-size: 24px;
            font-weight: 500;
          }
          .meta {
            color: #5b6968;
            font-size: 13px;
          }
          .document-text {
            font-size: 15px;
            white-space: normal;
          }
          @page {
            margin: 18mm;
          }
        </style>
      </head>
      <body>
        <header>
          <div class="brand">Recap AI</div>
          <h1>${escapeHtml(title)}</h1>
          <div class="meta">Documento generato il ${escapeHtml(createdAt)}</div>
        </header>
        <main class="document-text">${body}</main>
        <script>
          window.addEventListener("load", () => {
            window.print();
          });
        <\/script>
      </body>
    </html>
  `);
  printWindow.document.close();

  setStatus("Finestra di stampa aperta.");
}

function downloadPdf(kind, text) {
  if (!text.trim()) {
    setStatus("Non c'e' ancora un documento da salvare.");
    return;
  }

  const title = `${kind} - ${currentSummaryTitle || buildLocalVisitTitle()}`;
  const pdf = createTextPdf(title, text);
  const blob = new Blob([pdf], { type: "application/pdf" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${slugify(title)}.pdf`;
  document.body.append(link);
  link.click();
  URL.revokeObjectURL(link.href);
  link.remove();
  setStatus(`${kind} scaricata in PDF.`);
}

function createTextPdf(title, text) {
  const pageWidth = 595;
  const pageHeight = 842;
  const margin = 48;
  const lineHeight = 15;
  const maxChars = 88;
  const lines = [
    "Recap AI",
    title,
    `Documento generato il ${new Date().toLocaleString("it-IT")}`,
    "",
    ...wrapPdfText(text, maxChars)
  ];
  const pages = [];
  let pageLines = [];
  const maxLines = Math.floor((pageHeight - margin * 2) / lineHeight);

  lines.forEach((line) => {
    if (pageLines.length >= maxLines) {
      pages.push(pageLines);
      pageLines = [];
    }
    pageLines.push(line);
  });
  pages.push(pageLines);

  const objects = [];
  const addObject = (content) => {
    objects.push(content);
    return objects.length;
  };

  const catalogId = addObject("<< /Type /Catalog /Pages 2 0 R >>");
  const pagesId = addObject("");
  const fontId = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pageIds = [];

  pages.forEach((page) => {
    const stream = buildPdfPageStream(page, margin, pageHeight, lineHeight);
    const streamId = addObject(`<< /Length ${byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    const pageId = addObject(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${streamId} 0 R >>`);
    pageIds.push(pageId);
  });

  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return pdf;
}

function buildPdfPageStream(lines, margin, pageHeight, lineHeight) {
  const commands = ["BT", "/F1 11 Tf", `${margin} ${pageHeight - margin} Td`];
  lines.forEach((line, index) => {
    if (index > 0) commands.push(`0 -${lineHeight} Td`);
    commands.push(`<${encodePdfTextHex(line)}> Tj`);
  });
  commands.push("ET");
  return commands.join("\n");
}

function wrapPdfText(text, maxChars) {
  const output = [];
  String(text || "").split(/\n/).forEach((paragraph) => {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      output.push("");
      return;
    }

    let line = "";
    words.forEach((word) => {
      const next = line ? `${line} ${word}` : word;
      if (next.length > maxChars) {
        output.push(line);
        line = word;
      } else {
        line = next;
      }
    });
    if (line) output.push(line);
  });
  return output;
}

function encodePdfTextHex(value) {
  const text = `\uFEFF${String(value || "")}`;
  let hex = "";
  for (let index = 0; index < text.length; index += 1) {
    hex += text.charCodeAt(index).toString(16).padStart(4, "0");
  }
  return hex.toUpperCase();
}

function byteLength(value) {
  return new TextEncoder().encode(value).length;
}

function slugify(value) {
  return String(value || "recap-ai")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "recap-ai";
}

function buildLocalVisitTitle() {
  const name = patientName.value.trim() || "Riassunto visita";
  const date = new Date().toLocaleString("it-IT", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
  return `${name} - ${date}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function preferredMimeType() {
  const types = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  return types.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}
