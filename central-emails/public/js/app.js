// ==============================================================================
// CENTRAL DE ENVIO SELETIVO DE E-MAILS DO EJC — CLIENT-SIDE JAVASCRIPT
// Módulo Independente de Gerenciamento, Filtragem e Disparo Seletivo
// ==============================================================================

(function () {
  "use strict";

  // --- ESTADO GLOBAL DA APLICAÇÃO ---
  const state = {
    token: sessionStorage.getItem("ejc_central_token") || "",
    participants: [],
    filteredParticipants: [],
    selectedIds: new Set(),
    whatsappLinks: {},
    batchSize: 5,
    isLoading: false
  };

  // --- ELEMENTOS DO DOM ---
  const DOM = {
    // Auth
    authOverlay: document.getElementById("authOverlay"),
    loginForm: document.getElementById("loginForm"),
    loginPassword: document.getElementById("loginPassword"),
    btnLogin: document.getElementById("btnLogin"),
    loginError: document.getElementById("loginError"),
    btnLogout: document.getElementById("btnLogout"),

    // App & Layout
    appContainer: document.getElementById("appContainer"),
    themeToggleBtn: document.getElementById("themeToggleBtn"),

    // Stats
    statTotalParticipants: document.getElementById("statTotalParticipants"),
    statTotalPaid: document.getElementById("statTotalPaid"),
    statTotalUnpaid: document.getElementById("statTotalUnpaid"),
    statSelectedCount: document.getElementById("statSelectedCount"),
    selectionStatusText: document.getElementById("selectionStatusText"),

    // Filters
    filterPayment: document.getElementById("filterPayment"),
    filterSub: document.getElementById("filterSub"),
    searchParticipant: document.getElementById("searchParticipant"),
    btnReloadParticipants: document.getElementById("btnReloadParticipants"),

    // Selection buttons
    btnSelectAll: document.getElementById("btnSelectAll"),
    btnDeselectAll: document.getElementById("btnDeselectAll"),
    checkMaster: document.getElementById("checkMaster"),

    // Table
    participantsTable: document.getElementById("participantsTable"),
    tableBodyParticipants: document.getElementById("tableBodyParticipants"),

    // Composer
    composerForm: document.getElementById("composerForm"),
    emailSubject: document.getElementById("emailSubject"),
    emailBody: document.getElementById("emailBody"),
    btnPreviewEmail: document.getElementById("btnPreviewEmail"),
    btnStartReview: document.getElementById("btnStartReview"),

    // Modals
    modalPreview: document.getElementById("modalPreview"),
    previewParticipantSelect: document.getElementById("previewParticipantSelect"),
    previewMetaInfo: document.getElementById("previewMetaInfo"),
    previewIframe: document.getElementById("previewIframe"),
    btnProceedFromPreview: document.getElementById("btnProceedFromPreview"),

    modalReview: document.getElementById("modalReview"),
    revTotalCount: document.getElementById("revTotalCount"),
    revCompletedCount: document.getElementById("revCompletedCount"),
    revPaidCount: document.getElementById("revPaidCount"),
    revUnpaidCount: document.getElementById("revUnpaidCount"),
    revSubDistribution: document.getElementById("revSubDistribution"),
    revConfirmCount: document.getElementById("revConfirmCount"),
    btnConfirmSendBatch: document.getElementById("btnConfirmSendBatch"),

    modalProgress: document.getElementById("modalProgress"),
    progressTitle: document.getElementById("progressTitle"),
    progressFill: document.getElementById("progressFill"),
    progressText: document.getElementById("progressText"),
    progressPercent: document.getElementById("progressPercent"),
    resultsTableBody: document.getElementById("resultsTableBody"),
    progressFooter: document.getElementById("progressFooter"),
    btnCloseProgress: document.getElementById("btnCloseProgress"),
    btnDoneProgress: document.getElementById("btnDoneProgress"),

    modalTestMode: document.getElementById("modalTestMode"),
    btnOpenTestMode: document.getElementById("btnOpenTestMode"),
    testTargetEmail: document.getElementById("testTargetEmail"),
    testTargetSub: document.getElementById("testTargetSub"),
    btnExecuteTestSend: document.getElementById("btnExecuteTestSend"),
    testSendFeedback: document.getElementById("testSendFeedback"),

    modalAuditLogs: document.getElementById("modalAuditLogs"),
    btnOpenAuditLogs: document.getElementById("btnOpenAuditLogs"),
    auditLogsTableBody: document.getElementById("auditLogsTableBody"),

    modalSettings: document.getElementById("modalSettings"),
    btnOpenSettings: document.getElementById("btnOpenSettings"),
    cfgBatchSize: document.getElementById("cfgBatchSize"),

    toastContainer: document.getElementById("toastContainer")
  };

  // --- API HELPER COM AUTENTICAÇÃO ---
  async function apiFetch(endpoint, options = {}) {
    const headers = {
      "Content-Type": "application/json",
      ...(options.headers || {})
    };

    if (state.token) {
      headers["Authorization"] = `Bearer ${state.token}`;
      headers["x-central-token"] = state.token;
    }

    try {
      const response = await fetch(endpoint, { ...options, headers });
      const data = await response.json().catch(() => null);

      if (response.status === 401) {
        showLoginOverlay("Sessão expirada. Faça login novamente.");
        throw new Error("Não autorizado");
      }

      return { status: response.status, ok: response.ok, data };
    } catch (err) {
      if (err.message !== "Não autorizado") {
        console.error(`Erro na requisição ${endpoint}:`, err);
      }
      throw err;
    }
  }

  // --- TOAST NOTIFICATIONS ---
  function showToast(message, type = "info") {
    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;

    let icon = '<i class="fa-solid fa-circle-info"></i>';
    if (type === "success") icon = '<i class="fa-solid fa-circle-check text-green"></i>';
    if (type === "warning") icon = '<i class="fa-solid fa-triangle-exclamation text-yellow"></i>';
    if (type === "error") icon = '<i class="fa-solid fa-circle-xmark text-red"></i>';

    toast.innerHTML = `${icon} <span>${message}</span>`;
    DOM.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(10px)";
      toast.style.transition = "all 0.3s ease";
      setTimeout(() => toast.remove(), 300);
    }, 4500);
  }

  // --- CONTROLE DE SESSÃO & LOGIN ---
  function showLoginOverlay(errorMsg = "") {
    state.token = "";
    sessionStorage.removeItem("ejc_central_token");
    DOM.authOverlay.style.display = "flex";
    DOM.appContainer.style.display = "none";
    if (errorMsg) {
      DOM.loginError.textContent = errorMsg;
      DOM.loginError.style.display = "block";
    } else {
      DOM.loginError.style.display = "none";
    }
    DOM.loginPassword.value = "";
    DOM.loginPassword.focus();
  }

  function hideLoginOverlay() {
    DOM.authOverlay.style.display = "none";
    DOM.appContainer.style.display = "block";
  }

  async function checkInitialSession() {
    if (!state.token) {
      showLoginOverlay();
      return;
    }

    try {
      const res = await apiFetch("/api/session");
      if (res.ok && res.data?.authenticated) {
        hideLoginOverlay();
        if (res.data?.brevo_configured !== undefined) {
          updateBrevoStatusUI(res.data.brevo_configured);
        }
        loadAllData();
      } else {
        showLoginOverlay();
      }
    } catch (e) {
      showLoginOverlay();
    }
  }

  DOM.loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const password = DOM.loginPassword.value.trim();
    if (!password) return;

    DOM.btnLogin.disabled = true;
    DOM.btnLogin.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Autenticando...';
    DOM.loginError.style.display = "none";

    try {
      const res = await apiFetch("/api/login", {
        method: "POST",
        body: JSON.stringify({ password })
      });

      if (res.ok && res.data?.token) {
        state.token = res.data.token;
        sessionStorage.setItem("ejc_central_token", state.token);
        hideLoginOverlay();
        showToast("Acesso autorizado com sucesso!", "success");
        loadAllData();
      } else {
        DOM.loginError.textContent = res.data?.error || "Senha incorreta.";
        DOM.loginError.style.display = "block";
      }
    } catch (err) {
      DOM.loginError.textContent = "Falha ao conectar ao servidor da Central.";
      DOM.loginError.style.display = "block";
    } finally {
      DOM.btnLogin.disabled = false;
      DOM.btnLogin.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Acessar Central';
    }
  });

  DOM.btnLogout.addEventListener("click", () => {
    showLoginOverlay();
    showToast("Sessão encerrada.", "info");
  });

  // --- TEMA CLARO / ESCURO ---
  function initTheme() {
    const saved = localStorage.getItem("ejc_central_theme") || "light";
    document.body.setAttribute("data-theme", saved);
    updateThemeIcon(saved);
  }

  function updateThemeIcon(theme) {
    if (theme === "dark") {
      DOM.themeToggleBtn.innerHTML = '<i class="fa-solid fa-sun"></i>';
      DOM.themeToggleBtn.title = "Alternar para Tema Claro";
    } else {
      DOM.themeToggleBtn.innerHTML = '<i class="fa-solid fa-moon"></i>';
      DOM.themeToggleBtn.title = "Alternar para Tema Escuro";
    }
  }

  DOM.themeToggleBtn.addEventListener("click", () => {
    const current = document.body.getAttribute("data-theme") || "light";
    const next = current === "light" ? "dark" : "light";
    document.body.setAttribute("data-theme", next);
    localStorage.setItem("ejc_central_theme", next);
    updateThemeIcon(next);
  });

  // --- CARREGAMENTO DE DADOS DO SISTEMA ---
  async function loadAllData() {
    if (state.isLoading) return;
    state.isLoading = true;
    DOM.btnReloadParticipants.disabled = true;
    DOM.btnReloadParticipants.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Atualizando...';
    DOM.tableBodyParticipants.innerHTML = `
      <tr>
        <td colspan="7" class="table-loading">
          <i class="fa-solid fa-spinner fa-spin"></i> Carregando participantes do sistema oficial...
        </td>
      </tr>
    `;

    try {
      const res = await apiFetch("/api/participants");
      if (!res.ok || !res.data?.success) {
        throw new Error(res.data?.error || "Erro ao consultar participantes.");
      }

      state.participants = res.data.participantes || [];
      state.whatsappLinks = res.data.whatsappMap || {};

      // Atualiza os cards de estatísticas globais
      DOM.statTotalParticipants.textContent = res.data.total || state.participants.length;
      DOM.statTotalPaid.textContent = res.data.pagos || 0;
      DOM.statTotalUnpaid.textContent = res.data.nao_pagos || 0;

      if (res.data?.brevo_configured !== undefined) {
        updateBrevoStatusUI(res.data.brevo_configured);
      }

      // Mantém a seleção de quem ainda existir
      const existingIds = new Set(state.participants.map(p => p.id));
      const newSelected = new Set();
      state.selectedIds.forEach(id => {
        if (existingIds.has(id)) newSelected.add(id);
      });
      state.selectedIds = newSelected;

      applyFilters();
      showToast(`${state.participants.length} participantes sincronizados com sucesso.`, "success");
    } catch (err) {
      DOM.tableBodyParticipants.innerHTML = `
        <tr>
          <td colspan="7" class="table-loading text-red">
            <i class="fa-solid fa-circle-exclamation"></i> Falha ao carregar dados: ${err.message}
          </td>
        </tr>
      `;
      showToast(`Erro ao carregar dados: ${err.message}`, "error");
    } finally {
      state.isLoading = false;
      DOM.btnReloadParticipants.disabled = false;
      DOM.btnReloadParticipants.innerHTML = '<i class="fa-solid fa-rotate"></i> Atualizar';
    }
  }

  DOM.btnReloadParticipants.addEventListener("click", loadAllData);

  // --- FILTRAGEM & RENDERIZAÇÃO DA TABELA ---
  function applyFilters() {
    const paymentFilter = DOM.filterPayment.value; // "todos", "pago", "nao_pago"
    const subFilter = DOM.filterSub.value; // "todos", "Verde", "Vermelho", etc.
    const search = DOM.searchParticipant.value.trim().toLowerCase();

    state.filteredParticipants = state.participants.filter(p => {
      // Filtro de Pagamento
      if (paymentFilter === "pago" && p.pagamento_status !== "pago") return false;
      if (paymentFilter === "nao_pago" && p.pagamento_status !== "nao_pago") return false;

      // Filtro de Sub
      if (subFilter !== "todos" && p.sub !== subFilter) return false;

      // Filtro de Busca por Nome ou E-mail
      if (search) {
        const matchNome = (p.nome || "").toLowerCase().includes(search);
        const matchEmail = (p.email || "").toLowerCase().includes(search);
        if (!matchNome && !matchEmail) return false;
      }

      return true;
    });

    renderTable();
    updateSelectionCounter();
  }

  DOM.filterPayment.addEventListener("change", applyFilters);
  DOM.filterSub.addEventListener("change", applyFilters);
  DOM.searchParticipant.addEventListener("input", applyFilters);

  function renderTable() {
    const list = state.filteredParticipants;
    if (list.length === 0) {
      DOM.tableBodyParticipants.innerHTML = `
        <tr>
          <td colspan="7" class="table-loading">
            <i class="fa-solid fa-inbox"></i> Nenhum participante encontrado com os filtros selecionados.
          </td>
        </tr>
      `;
      DOM.checkMaster.checked = false;
      return;
    }

    const fragment = document.createDocumentFragment();

    list.forEach(p => {
      const isSelected = state.selectedIds.has(p.id);
      const tr = document.createElement("tr");
      tr.id = `row-${p.id}`;
      if (isSelected) tr.classList.add("row-selected");

      // Badge do Sub
      const subClass = `badge-sub-${(p.sub || "verde").toLowerCase()}`;
      
      // Badge de Pagamento
      const payBadge = p.pagamento_status === "pago"
        ? '<span class="badge-status badge-paid"><i class="fa-solid fa-check"></i> Pago</span>'
        : '<span class="badge-status badge-unpaid"><i class="fa-solid fa-clock"></i> Não pago</span>';

      // Badge de Link WPP
      const wppBadge = p.tem_link_whatsapp
        ? '<span class="badge-status badge-wpp-ok" title="Link correspondente configurado"><i class="fa-brands fa-whatsapp"></i> OK</span>'
        : '<span class="badge-status badge-wpp-missing" title="Link não encontrado para o Sub deste participante! O envio será bloqueado."><i class="fa-solid fa-triangle-exclamation"></i> Falta Link</span>';

      tr.innerHTML = `
        <td style="text-align: center;">
          <input type="checkbox" class="part-checkbox" data-id="${p.id}" ${isSelected ? "checked" : ""}>
        </td>
        <td style="font-weight: 600;">${escapeHtml(p.nome)}</td>
        <td style="color: var(--text-muted);">${escapeHtml(p.email)}</td>
        <td><span class="badge-sub ${subClass}">Sub ${escapeHtml(p.sub)}</span></td>
        <td><span class="badge-status badge-paid"><i class="fa-solid fa-check-circle"></i> Concluída</span></td>
        <td>${payBadge}</td>
        <td style="text-align: center;">${wppBadge}</td>
      `;

      // Evento de clique no checkbox individual
      const chk = tr.querySelector(".part-checkbox");
      chk.addEventListener("change", (e) => {
        handleToggleSelect(p.id, e.target.checked);
      });

      fragment.appendChild(tr);
    });

    DOM.tableBodyParticipants.innerHTML = "";
    DOM.tableBodyParticipants.appendChild(fragment);

    // Atualiza estado do Checkbox Master
    const allFilteredSelected = list.every(p => state.selectedIds.has(p.id));
    const someFilteredSelected = list.some(p => state.selectedIds.has(p.id));
    DOM.checkMaster.checked = allFilteredSelected;
    DOM.checkMaster.indeterminate = !allFilteredSelected && someFilteredSelected;
  }

  // --- GERENCIAMENTO DE SELEÇÃO ---
  function handleToggleSelect(id, isChecked) {
    if (isChecked) {
      state.selectedIds.add(id);
      document.getElementById(`row-${id}`)?.classList.add("row-selected");
    } else {
      state.selectedIds.delete(id);
      document.getElementById(`row-${id}`)?.classList.remove("row-selected");
    }
    updateSelectionCounter();
  }

  function updateSelectionCounter() {
    const totalSelected = state.selectedIds.size;
    DOM.statSelectedCount.textContent = totalSelected;
    DOM.selectionStatusText.innerHTML = `<strong>${totalSelected}</strong> participantes selecionados de ${state.participants.length}`;

    // Atualiza o master checkbox
    const list = state.filteredParticipants;
    if (list.length > 0) {
      const allSelected = list.every(p => state.selectedIds.has(p.id));
      const someSelected = list.some(p => state.selectedIds.has(p.id));
      DOM.checkMaster.checked = allSelected;
      DOM.checkMaster.indeterminate = !allSelected && someSelected;
    } else {
      DOM.checkMaster.checked = false;
      DOM.checkMaster.indeterminate = false;
    }
  }

  // Selecionar todos os filtrados
  DOM.btnSelectAll.addEventListener("click", () => {
    state.filteredParticipants.forEach(p => state.selectedIds.add(p.id));
    renderTable();
    updateSelectionCounter();
    showToast(`${state.filteredParticipants.length} participantes marcados.`, "info");
  });

  // Desmarcar todos
  DOM.btnDeselectAll.addEventListener("click", () => {
    state.selectedIds.clear();
    renderTable();
    updateSelectionCounter();
    showToast("Todos os participantes foram desmarcados.", "info");
  });

  // Check Master no cabeçalho
  DOM.checkMaster.addEventListener("change", (e) => {
    const checkState = e.target.checked;
    state.filteredParticipants.forEach(p => {
      if (checkState) state.selectedIds.add(p.id);
      else state.selectedIds.delete(p.id);
    });
    renderTable();
    updateSelectionCounter();
  });

  // --- COMPOSITOR DE MENSAGENS: INSERÇÃO DE TAGS ---
  document.querySelectorAll("[data-insert]").forEach(btn => {
    btn.addEventListener("click", () => {
      const tag = btn.getAttribute("data-insert");
      const textarea = DOM.emailBody;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const text = textarea.value;

      textarea.value = text.substring(0, start) + tag + text.substring(end);
      textarea.focus();
      textarea.selectionStart = textarea.selectionEnd = start + tag.length;
    });
  });

  // --- MODAL 1: PRÉ-VISUALIZAÇÃO DE AMOSTRA REAL ---
  DOM.btnPreviewEmail.addEventListener("click", () => {
    openPreviewModal();
  });

  function openPreviewModal() {
    // Lista de participantes disponíveis para prévia
    let pool = state.participants.filter(p => state.selectedIds.has(p.id));
    if (pool.length === 0) pool = state.participants;

    if (pool.length === 0) {
      showToast("Não há participantes para pré-visualizar.", "warning");
      return;
    }

    // Preenche o select da prévia com participantes
    DOM.previewParticipantSelect.innerHTML = pool
      .slice(0, 50)
      .map(p => `<option value="${p.id}">${escapeHtml(p.nome)} — Sub ${p.sub} (${p.pagamento_label})</option>`)
      .join("");

    renderPreviewForSelectedParticipant();
    DOM.modalPreview.style.display = "flex";
  }

  DOM.previewParticipantSelect.addEventListener("change", () => {
    renderPreviewForSelectedParticipant();
  });

  async function renderPreviewForSelectedParticipant() {
    const partId = DOM.previewParticipantSelect.value;
    const part = state.participants.find(p => p.id === partId) || state.participants[0];
    if (!part) return;

    DOM.previewMetaInfo.innerHTML = `
      <span><strong>Destinatário:</strong> ${escapeHtml(part.nome)} &lt;${escapeHtml(part.email)}&gt;</span>
      <span><strong>Sub:</strong> <span class="badge-sub badge-sub-${part.sub.toLowerCase()}">Sub ${part.sub}</span></span>
      <span><strong>Pagamento:</strong> ${part.pagamento_label}</span>
      <span><strong>Link do Sub:</strong> <code style="font-size: 0.75rem; background: var(--bg-surface); padding: 2px 6px; border-radius: 4px;">${part.link_whatsapp || "NENHUM LINK"}</code></span>
    `;

    DOM.previewIframe.srcdoc = '<div style="padding: 24px; text-align: center; font-family: sans-serif; color: #64748b;">Carregando prévia real...</div>';

    try {
      const res = await apiFetch("/api/preview", {
        method: "POST",
        body: JSON.stringify({
          nome: part.nome,
          sub: part.sub,
          assunto: DOM.emailSubject.value.trim(),
          mensagem: DOM.emailBody.value.trim()
        })
      });

      if (res.ok && res.data?.html) {
        DOM.previewIframe.srcdoc = res.data.html;
      } else {
        DOM.previewIframe.srcdoc = `
          <div style="padding: 24px; font-family: sans-serif; color: #ef4444; text-align: center;">
            <h3>⚠️ Atenção: Não foi possível renderizar a prévia</h3>
            <p>${res.data?.error || "Erro desconhecido"}</p>
          </div>
        `;
      }
    } catch (e) {
      DOM.previewIframe.srcdoc = '<div style="padding: 24px; color: red;">Erro de comunicação ao gerar prévia.</div>';
    }
  }

  DOM.btnProceedFromPreview.addEventListener("click", () => {
    DOM.modalPreview.style.display = "none";
    openReviewModal();
  });

  // --- MODAL 2: REVISÃO PRÉ-VOO & CONFIRMAÇÃO ANTI-DUPLICIDADE ---
  DOM.btnStartReview.addEventListener("click", () => {
    openReviewModal();
  });

  function openReviewModal() {
    const selectedList = state.participants.filter(p => state.selectedIds.has(p.id));

    if (selectedList.length === 0) {
      showToast("Selecione pelo menos 1 participante na tabela para enviar.", "warning");
      return;
    }

    const assunto = DOM.emailSubject.value.trim();
    const mensagem = DOM.emailBody.value.trim();

    if (!assunto) {
      showToast("Informe o assunto do e-mail antes de prosseguir.", "warning");
      DOM.emailSubject.focus();
      return;
    }

    if (!mensagem) {
      showToast("Escreva a mensagem do e-mail antes de prosseguir.", "warning");
      DOM.emailBody.focus();
      return;
    }

    // Calcula estatísticas
    const total = selectedList.length;
    const pagos = selectedList.filter(p => p.pagamento_status === "pago").length;
    const naoPagos = selectedList.filter(p => p.pagamento_status !== "pago").length;

    // Contagem por Sub
    const subCounts = { Verde: 0, Vermelho: 0, Amarelo: 0, Laranja: 0 };
    selectedList.forEach(p => {
      if (subCounts[p.sub] !== undefined) subCounts[p.sub]++;
      else subCounts[p.sub] = 1;
    });

    DOM.revTotalCount.textContent = total;
    DOM.revCompletedCount.textContent = total;
    DOM.revPaidCount.textContent = `${pagos} participantes`;
    DOM.revUnpaidCount.textContent = `${naoPagos} participantes`;
    DOM.revConfirmCount.textContent = total;

    // Renderiza grid de Subs
    DOM.revSubDistribution.innerHTML = Object.entries(subCounts)
      .map(([subName, count]) => {
        const cls = `badge-sub-${subName.toLowerCase()}`;
        return `
          <div class="sub-dist-card">
            <span class="badge-sub ${cls}">Sub ${subName}</span>
            <span style="font-size: 1.1rem; color: var(--text-heading);">${count}</span>
          </div>
        `;
      })
      .join("");

    DOM.modalReview.style.display = "flex";
  }

  // --- MODAL 3: DISPARO EM MASSA & PROGRESSO ---
  DOM.btnConfirmSendBatch.addEventListener("click", async () => {
    DOM.modalReview.style.display = "none";
    executeBatchDispatch();
  });

  async function executeBatchDispatch() {
    const selectedList = state.participants.filter(p => state.selectedIds.has(p.id));
    if (selectedList.length === 0) return;

    const assunto = DOM.emailSubject.value.trim();
    const mensagem = DOM.emailBody.value.trim();
    const batchSize = parseInt(DOM.cfgBatchSize?.value || "5", 10);

    // Prepara tela de progresso
    DOM.modalProgress.style.display = "flex";
    DOM.progressTitle.innerHTML = '<i class="fa-solid fa-paper-plane fa-bounce text-primary"></i> Disparando Campanha em Lotes...';
    DOM.progressFill.style.width = "0%";
    DOM.progressPercent.textContent = "0%";
    DOM.progressText.textContent = `Preparando envio de ${selectedList.length} e-mails...`;
    DOM.resultsTableBody.innerHTML = "";
    DOM.progressFooter.style.display = "none";
    DOM.btnCloseProgress.style.display = "none";

    try {
      // Dispara a requisição de lote para o servidor independente
      const res = await apiFetch("/api/send-batch", {
        method: "POST",
        body: JSON.stringify({
          recipients: selectedList,
          assunto,
          mensagem,
          batchSize
        })
      });

      if (!res.ok || !res.data?.success) {
        throw new Error(res.data?.error || "Falha no processamento dos lotes.");
      }

      const resultados = res.data.resultados || [];
      const totalEnviados = res.data.total_enviados || 0;
      const totalErros = res.data.total_erros || 0;

      // Atualiza a tabela de resultados individuais
      renderBatchResults(resultados);

      // Conclui barra de progresso
      DOM.progressFill.style.width = "100%";
      DOM.progressPercent.textContent = "100%";
      DOM.progressText.textContent = `Disparo concluído: ${totalEnviados} enviado(s), ${totalErros} erro/bloqueio(s).`;
      DOM.progressTitle.innerHTML = '<i class="fa-solid fa-circle-check text-green"></i> Campanha Concluída';
      
      showToast(`Envio concluído: ${totalEnviados} enviados com sucesso!`, totalErros === 0 ? "success" : "warning");

    } catch (err) {
      DOM.progressTitle.innerHTML = '<i class="fa-solid fa-circle-xmark text-red"></i> Falha no Disparo';
      DOM.progressText.textContent = `Erro: ${err.message}`;
      showToast(`Erro no envio: ${err.message}`, "error");
    } finally {
      DOM.progressFooter.style.display = "flex";
      DOM.btnCloseProgress.style.display = "block";
    }
  }

  function renderBatchResults(resultados) {
    const fragment = document.createDocumentFragment();

    resultados.forEach(r => {
      const tr = document.createElement("tr");

      let statusBadge = "";
      if (r.success) {
        statusBadge = '<span class="badge-status badge-paid"><i class="fa-solid fa-check"></i> Enviado</span>';
      } else if (r.blocked) {
        statusBadge = `<span class="badge-status badge-wpp-missing" title="${escapeHtml(r.error)}"><i class="fa-solid fa-ban"></i> Bloqueado (Sem Link)</span>`;
      } else {
        statusBadge = `<span class="badge-status badge-unpaid" title="${escapeHtml(r.error)}"><i class="fa-solid fa-xmark"></i> Falhou</span>`;
      }

      const subBadge = `<span class="badge-sub badge-sub-${r.sub.toLowerCase()}">Sub ${escapeHtml(r.sub)}</span>`;
      const linkSnippet = r.link_utilizado
        ? `<a href="${r.link_utilizado}" target="_blank" style="color: var(--primary); font-size: 0.75rem;"><i class="fa-brands fa-whatsapp"></i> Link Verificado</a>`
        : `<span style="color: var(--danger); font-size: 0.75rem;">Sem Link</span>`;

      tr.innerHTML = `
        <td style="font-weight: 600;">${escapeHtml(r.nome)}</td>
        <td style="color: var(--text-muted); font-size: 0.85rem;">${escapeHtml(r.email)}</td>
        <td>${subBadge}</td>
        <td>${linkSnippet}</td>
        <td>${statusBadge}</td>
      `;

      fragment.appendChild(tr);
    });

    DOM.resultsTableBody.innerHTML = "";
    DOM.resultsTableBody.appendChild(fragment);
  }

  DOM.btnDoneProgress.addEventListener("click", () => {
    DOM.modalProgress.style.display = "none";
  });
  DOM.btnCloseProgress.addEventListener("click", () => {
    DOM.modalProgress.style.display = "none";
  });

  // --- MODAL 4: MODO TESTE INDEPENDENTE ---
  DOM.btnOpenTestMode.addEventListener("click", () => {
    DOM.testSendFeedback.style.display = "none";
    DOM.modalTestMode.style.display = "flex";
  });

  DOM.btnExecuteTestSend.addEventListener("click", async () => {
    const testEmail = DOM.testTargetEmail.value.trim();
    const testSub = DOM.testTargetSub.value;
    const assunto = DOM.emailSubject.value.trim();
    const mensagem = DOM.emailBody.value.trim();

    if (!testEmail || !testEmail.includes("@")) {
      showToast("Informe um e-mail de teste válido.", "warning");
      DOM.testTargetEmail.focus();
      return;
    }

    DOM.btnExecuteTestSend.disabled = true;
    DOM.btnExecuteTestSend.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Disparando Teste...';
    DOM.testSendFeedback.style.display = "none";

    try {
      const res = await apiFetch("/api/test-send", {
        method: "POST",
        body: JSON.stringify({
          testEmail,
          testSub,
          assunto,
          mensagem
        })
      });

      if (res.ok && res.data?.success) {
        DOM.testSendFeedback.className = "alert-box alert-info";
        DOM.testSendFeedback.innerHTML = `
          <i class="fa-solid fa-circle-check text-green"></i>
          <div>
            <strong>Teste Enviado com Sucesso!</strong><br>
            Destinatário: <code>${escapeHtml(testEmail)}</code><br>
            Sub Simulado: <strong>Sub ${res.data.sub}</strong><br>
            Link WhatsApp Utilizado: <a href="${res.data.linkUtilizado}" target="_blank" style="color: var(--primary);">${res.data.linkUtilizado}</a><br>
            Verifique a sua caixa postal (incluindo spam/promoções).
          </div>
        `;
        DOM.testSendFeedback.style.display = "flex";
        showToast("E-mail de teste disparado com sucesso!", "success");
      } else {
        DOM.testSendFeedback.className = "alert-box alert-warning";
        DOM.testSendFeedback.innerHTML = `
          <i class="fa-solid fa-triangle-exclamation text-red"></i>
          <div>
            <strong>Falha no Teste:</strong> ${res.data?.error || "Erro ao disparar pela Brevo."}
          </div>
        `;
        DOM.testSendFeedback.style.display = "flex";
      }
    } catch (e) {
      DOM.testSendFeedback.className = "alert-box alert-warning";
      DOM.testSendFeedback.innerHTML = `<i class="fa-solid fa-circle-xmark text-red"></i><div>Erro: ${e.message}</div>`;
      DOM.testSendFeedback.style.display = "flex";
    } finally {
      DOM.btnExecuteTestSend.disabled = false;
      DOM.btnExecuteTestSend.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Enviar E-mail de Teste';
    }
  });

  // --- MODAL 5: LOGS DE AUDITORIA & HISTÓRICO ---
  DOM.btnOpenAuditLogs.addEventListener("click", async () => {
    DOM.modalAuditLogs.style.display = "flex";
    DOM.auditLogsTableBody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 24px;"><i class="fa-solid fa-spinner fa-spin"></i> Carregando registros...</td></tr>';

    try {
      const res = await apiFetch("/api/audit-logs");
      if (res.ok && Array.isArray(res.data?.logs)) {
        renderAuditLogs(res.data.logs);
      } else {
        DOM.auditLogsTableBody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 24px;">Nenhum registro encontrado.</td></tr>';
      }
    } catch (e) {
      DOM.auditLogsTableBody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--danger); padding: 24px;">Erro ao consultar registros.</td></tr>';
    }
  });

  function renderAuditLogs(logs) {
    if (logs.length === 0) {
      DOM.auditLogsTableBody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 24px;">Nenhum disparo registrado ainda.</td></tr>';
      return;
    }

    DOM.auditLogsTableBody.innerHTML = logs.map(log => {
      const dateFormatted = new Date(log.data_hora).toLocaleString("pt-BR");
      return `
        <tr>
          <td style="font-size: 0.8rem; white-space: nowrap;">${dateFormatted}</td>
          <td style="font-weight: 600;">${escapeHtml(log.assunto)}</td>
          <td style="text-align: center; font-weight: 700;">${log.total_selecionado}</td>
          <td style="text-align: center; color: var(--success); font-weight: 700;">${log.total_enviado}</td>
          <td style="text-align: center; color: var(--danger); font-weight: 700;">${log.total_erro}</td>
          <td style="font-size: 0.8rem; color: var(--text-muted);">Pagos: ${log.destinatarios_resumo?.pagos || 0} | Não pagos: ${log.destinatarios_resumo?.nao_pagos || 0}</td>
        </tr>
      `;
    }).join("");
  }

  // --- MODAL 6: CONFIGURAÇÕES ---
  DOM.btnOpenSettings.addEventListener("click", () => {
    DOM.modalSettings.style.display = "flex";
  });

  // Fechamento genérico de modais via [data-close-modal]
  document.querySelectorAll("[data-close-modal]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      const modal = e.target.closest(".modal-backdrop");
      if (modal) modal.style.display = "none";
    });
  });

  // Fechar modal ao clicar fora do diálogo
  document.querySelectorAll(".modal-backdrop").forEach(backdrop => {
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop && backdrop.id !== "modalProgress") {
        backdrop.style.display = "none";
      }
    });
  });

  // Helper simples para sanitização de texto HTML
  function escapeHtml(text) {
    if (!text) return "";
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function updateBrevoStatusUI(isConfigured) {
    const statusBox = document.getElementById("cfgBrevoStatus");
    if (!statusBox) return;

    if (isConfigured) {
      statusBox.className = "alert-box alert-info";
      statusBox.innerHTML = '<i class="fa-solid fa-circle-check text-green"></i> <span><strong>Chave Brevo Reconhecida:</strong> Backend configurado via <code>BREVO_API_KEY</code>.</span>';
    } else {
      statusBox.className = "alert-box alert-warning";
      statusBox.innerHTML = '<i class="fa-solid fa-triangle-exclamation text-yellow"></i> <span><strong>Chave Brevo Não Configurada:</strong> Insira sua chave no arquivo <code>central-emails/.env</code> e reinicie o servidor.</span>';
    }
  }

  // --- INICIALIZAÇÃO ---
  initTheme();
  checkInitialSession();

})();
