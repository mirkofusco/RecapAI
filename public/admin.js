const loginView = document.querySelector("#loginView");
const dashboardView = document.querySelector("#dashboardView");
const loginForm = document.querySelector("#loginForm");
const loginStatus = document.querySelector("#loginStatus");
const adminPassword = document.querySelector("#adminPassword");
const logoutBtn = document.querySelector("#logoutBtn");
const newClientBtn = document.querySelector("#newClientBtn");
const refreshBtn = document.querySelector("#refreshBtn");
const adminStatus = document.querySelector("#adminStatus");
const clientList = document.querySelector("#clientList");
const detailPanel = document.querySelector("#detailPanel");
const detailTemplate = document.querySelector("#detailTemplate");
const totalClients = document.querySelector("#totalClients");
const activeClients = document.querySelector("#activeClients");
const monthlyVisits = document.querySelector("#monthlyVisits");
const monthlyTokens = document.querySelector("#monthlyTokens");
const monthlyCost = document.querySelector("#monthlyCost");
const currentMonthLabel = document.querySelector("#currentMonthLabel");

const planLimits = {
  Starter: 20,
  Pro: 120,
  Studio: 300
};

let clients = [];
let dashboardStats = {};
let selectedClientId = null;
let lastCredentials = null;

adminPassword.value = localStorage.getItem("recapAdminPassword") || "";

loginForm.addEventListener("submit", login);
logoutBtn.addEventListener("click", logout);
newClientBtn.addEventListener("click", () => openDetail(null));
refreshBtn.addEventListener("click", loadClients);

if (adminPassword.value) {
  showDashboard();
  loadClients();
}

async function login(event) {
  event.preventDefault();
  localStorage.setItem("recapAdminPassword", adminPassword.value);
  const response = await adminFetch("/api/admin/clients", {}, loginStatus);

  if (!response.ok) return;

  showDashboard();
  const payload = await response.json();
  setClients(payload.clients, payload.stats);
  setStatus("Accesso effettuato.");
}

function logout() {
  localStorage.removeItem("recapAdminPassword");
  adminPassword.value = "";
  selectedClientId = null;
  clients = [];
  dashboardView.classList.add("hidden");
  loginView.classList.remove("hidden");
  clientList.innerHTML = "";
  showEmptyDetail();
}

function showDashboard() {
  loginView.classList.add("hidden");
  dashboardView.classList.remove("hidden");
}

async function loadClients() {
  const response = await adminFetch("/api/admin/clients");
  if (!response.ok) return;

  const payload = await response.json();
  setClients(payload.clients, payload.stats);
  setStatus("Lista aggiornata.");
}

function setClients(items, stats = {}) {
  clients = items;
  dashboardStats = stats;
  renderSidebar();
  updateStats();

  if (selectedClientId) {
    const selected = clients.find((client) => client.id === selectedClientId);
    selected ? openDetail(selected) : showEmptyDetail();
  } else {
    showEmptyDetail();
  }
}

function renderSidebar() {
  clientList.innerHTML = "";

  if (!clients.length) {
    clientList.innerHTML = `<p class="sidebar-empty">Nessuna utenza creata.</p>`;
    return;
  }

  for (const client of clients) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `sidebar-client ${client.id === selectedClientId ? "selected" : ""}`;
    button.innerHTML = `
      <strong>${escapeHtml(client.name)}</strong>
      <span>${escapeHtml(client.email || "Email mancante")}</span>
      <small>${client.status === "active" ? "Attivo" : "Sospeso"} - ${escapeHtml(client.plan)}</small>
    `;
    button.addEventListener("click", () => openDetail(client));
    clientList.append(button);
  }
}

function openDetail(client) {
  selectedClientId = client?.id || null;
  lastCredentials = null;
  renderSidebar();

  const fragment = detailTemplate.content.cloneNode(true);
  detailPanel.innerHTML = "";
  detailPanel.append(fragment);

  const form = detailPanel.querySelector("#clientDetailForm");
  const title = detailPanel.querySelector("#detailTitle");
  const statusPill = detailPanel.querySelector("#detailStatusPill");
  const name = detailPanel.querySelector("#detailName");
  const email = detailPanel.querySelector("#detailEmail");
  const password = detailPanel.querySelector("#detailPassword");
  const plan = detailPanel.querySelector("#detailPlan");
  const limit = detailPanel.querySelector("#detailLimit");
  const status = detailPanel.querySelector("#detailStatus");
  const summaryPrompt = detailPanel.querySelector("#detailSummaryPrompt");
  const usagePanel = detailPanel.querySelector("#usagePanel");
  const copyCredentialsBtn = detailPanel.querySelector("#copyCredentialsBtn");
  const setPasswordBtn = detailPanel.querySelector("#setPasswordBtn");
  const resetMonthBtn = detailPanel.querySelector("#resetMonthBtn");
  const deleteClientBtn = detailPanel.querySelector("#deleteClientBtn");

  const isNew = !client;
  title.textContent = isNew ? "Nuovo cliente" : client.name;
  statusPill.textContent = isNew ? "Nuovo" : client.status === "active" ? "Attivo" : "Sospeso";
  statusPill.className = `status-pill ${client?.status === "suspended" ? "danger" : ""}`;
  name.value = client?.name || "";
  email.value = client?.email || "";
  password.value = "";
  plan.value = client?.plan || "Starter";
  limit.value = client?.monthlyLimit || planLimits[plan.value];
  status.value = client?.status || "active";
  summaryPrompt.value = client?.summaryPrompt || defaultSummaryPrompt();
  copyCredentialsBtn.disabled = isNew && !password.value;
  setPasswordBtn.disabled = isNew;
  resetMonthBtn.disabled = isNew;
  deleteClientBtn.disabled = isNew;

  renderUsage(usagePanel, client);

  plan.addEventListener("change", () => {
    limit.value = planLimits[plan.value] || 20;
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = {
      name: name.value,
      email: email.value,
      password: password.value,
      plan: plan.value,
      monthlyLimit: Number(limit.value),
      status: status.value,
      summaryPrompt: summaryPrompt.value
    };

    if (isNew) {
      const response = await adminFetch("/api/admin/clients", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      if (!response.ok) return;

      const data = await response.json();
      lastCredentials = formatCredentials(data.client.email, data.password);
      await navigator.clipboard.writeText(lastCredentials).catch(() => {});
      selectedClientId = data.client.id;
      await loadClients();
      setStatus("Cliente creato. Credenziali copiate.");
      return;
    }

    delete payload.password;
    const response = await adminFetch(`/api/admin/clients/${client.id}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    });
    if (response.ok) {
      await loadClients();
      setStatus("Cliente salvato.");
    }
  });

  setPasswordBtn.addEventListener("click", async () => {
    if (!client) return;
    const chosenPassword = password.value.trim();
    const response = await adminFetch(`/api/admin/clients/${client.id}/password`, {
      method: "POST",
      body: JSON.stringify({ password: chosenPassword })
    });
    if (!response.ok) return;

    const data = await response.json();
    lastCredentials = formatCredentials(data.client.email, data.password);
    await navigator.clipboard.writeText(lastCredentials).catch(() => {});
    password.value = "";
    setStatus("Password aggiornata. Credenziali copiate.");
  });

  copyCredentialsBtn.addEventListener("click", async () => {
    const value = lastCredentials || formatCredentials(email.value, password.value || "PASSWORD_DA_INSERIRE");
    await navigator.clipboard.writeText(value).catch(() => {});
    setStatus("Credenziali copiate.");
  });

  resetMonthBtn.addEventListener("click", async () => {
    if (!client) return;
    const response = await adminFetch(`/api/admin/clients/${client.id}/reset`, {
      method: "POST"
    });
    if (response.ok) {
      await loadClients();
      setStatus("Conteggio mese azzerato.");
    }
  });

  deleteClientBtn.addEventListener("click", async () => {
    if (!client) return;
    const confirmed = window.confirm(`Eliminare definitivamente ${client.name}? Questa azione non si puo' annullare.`);
    if (!confirmed) return;

    const response = await adminFetch(`/api/admin/clients/${client.id}`, {
      method: "DELETE"
    });
    if (response.ok) {
      selectedClientId = null;
      await loadClients();
      setStatus("Cliente eliminato.");
    }
  });
}

function renderUsage(container, client) {
  if (!client) {
    container.innerHTML = `
      <div>
        <strong>Nuova utenza</strong>
        <span>Compila i dati e scegli la password da consegnare al cliente.</span>
      </div>
    `;
    return;
  }

  const usagePercent = Math.min(100, Math.round((client.usedThisMonth / client.monthlyLimit) * 100));
  const stats = client.usageStats || {};
  const recentVisits = client.recentVisits || [];
  container.innerHTML = `
    <div>
      <strong>${client.usedThisMonth}/${client.monthlyLimit}</strong>
      <span>visite usate questo mese</span>
    </div>
    <div class="usage-bar" aria-hidden="true">
      <span style="width: ${usagePercent}%"></span>
    </div>
    <div class="client-meta">
      Minuti mese: ${formatNumber(stats.monthlyMinutes || 0)}<br />
      Token mese: ${formatInteger(stats.monthlySummaryTotalTokens || 0)}<br />
      Costo mese stimato: ${formatMoney(stats.monthlyEstimatedCostUsd || 0)}<br />
      Costo totale stimato: ${formatMoney(stats.totalEstimatedCostUsd || 0)}<br />
      Totale visite: ${client.totalVisits || 0}<br />
      Ultimo uso: ${client.lastUsedAt ? new Date(client.lastUsedAt).toLocaleString("it-IT") : "Mai"}<br />
      Password impostata: ${client.hasPassword ? "Si" : "No"}
    </div>
    <div class="recent-visits">
      <strong>Ultimi recap</strong>
      ${
        recentVisits.length
          ? recentVisits
              .slice(0, 5)
              .map((visit) => {
                const minutes = formatNumber((visit.durationSeconds || 0) / 60);
                const tokens = formatInteger((visit.summaryInputTokens || 0) + (visit.summaryOutputTokens || 0));
                return `<p>${new Date(visit.at).toLocaleString("it-IT")} - ${minutes} min - ${tokens} token - ${formatMoney(visit.estimatedCostUsd || 0)}</p>`;
              })
              .join("")
          : "<p>Nessun recap generato.</p>"
      }
    </div>
  `;
}

function showEmptyDetail() {
  detailPanel.innerHTML = `
    <div class="empty-state">
      <h2>Seleziona un cliente</h2>
      <p>Clicca un'utenza a sinistra per vedere dettagli, piano, stato e password.</p>
    </div>
  `;
}

function updateStats() {
  totalClients.textContent = clients.length;
  activeClients.textContent = clients.filter((client) => client.status === "active").length;
  monthlyVisits.textContent = formatInteger(dashboardStats.monthlyVisits ?? clients.reduce((total, client) => total + Number(client.usedThisMonth || 0), 0));
  monthlyTokens.textContent = formatInteger(dashboardStats.monthlyTokens || 0);
  monthlyCost.textContent = formatMoney(dashboardStats.monthlyEstimatedCostUsd || 0);
  currentMonthLabel.textContent = new Date().toLocaleDateString("it-IT", { month: "short", year: "numeric" });
}

async function adminFetch(url, options = {}, targetStatus = adminStatus) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "x-admin-password": adminPassword.value,
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: "Errore sconosciuto." }));
    targetStatus.textContent = payload.error;
  }

  return response;
}

function setStatus(message) {
  adminStatus.textContent = message;
}

function formatCredentials(email, password) {
  return `Recap AI\nEmail: ${email}\nPassword: ${password}\nLink: https://recap-ai-frky.onrender.com`;
}

function defaultSummaryPrompt() {
  return `Sei Recap AI, un assistente di documentazione per professionisti sanitari e consulenze.
Il cliente principale e' una nutrizionista: crea un riepilogo preciso, professionale e utile per cartella/appunti.
Evidenzia motivo della visita, obiettivi, dati citati, abitudini alimentari, stile di vita, criticita', indicazioni concordate, azioni per il paziente, azioni per il professionista, follow-up e note da verificare.
Non inventare informazioni non presenti nella trascrizione. Se qualcosa non emerge, scrivi "Non emerso".`;
}

function formatMoney(value) {
  return `$${Number(value || 0).toFixed(4)}`;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("it-IT", { maximumFractionDigits: 1 });
}

function formatInteger(value) {
  return Number(value || 0).toLocaleString("it-IT", { maximumFractionDigits: 0 });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
