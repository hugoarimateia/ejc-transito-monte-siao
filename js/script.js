// ==============================================================================
// EJC - TRÂNSITO MONTE SIÃO - SCRIPT PRINCIPAL
// ==============================================================================

const header = document.querySelector(".site-header");
const menuButton = document.querySelector(".menu-button");
const nav = document.querySelector(".nav");
const backToTop = document.querySelector(".back-to-top");
const modal = document.querySelector(".image-modal");
const calendarCard = document.querySelector(".calendar-card");
const closeModal = document.querySelector(".modal-close");
const modalImage = modal ? modal.querySelector("img") : null;

// Scroll e cabeçalho fixo
function handleScroll() {
  const y = window.scrollY;
  if (header) header.classList.toggle("scrolled", y > 20);
  if (backToTop) backToTop.classList.toggle("visible", y > 650);
}
handleScroll();
window.addEventListener("scroll", handleScroll, { passive: true });

// Menu Mobile
if (menuButton && nav) {
  menuButton.addEventListener("click", () => {
    const isOpen = nav.classList.toggle("open");
    menuButton.setAttribute("aria-expanded", String(isOpen));
  });

  document.querySelectorAll(".nav a").forEach(link => {
    link.addEventListener("click", () => {
      nav.classList.remove("open");
      menuButton.setAttribute("aria-expanded", "false");
    });
  });
}

if (backToTop) {
  backToTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
}

function scrollToElementWithHeader(element, extraOffset = 18) {
  if (!element) return;
  const headerHeight = header?.offsetHeight || 0;
  const top = element.getBoundingClientRect().top + window.scrollY - headerHeight - extraOffset;
  window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
}

document.querySelectorAll('a[href="#inscricoes"]').forEach(link => {
  link.addEventListener("click", event => {
    event.preventDefault();
    nav?.classList.remove("open");
    menuButton?.setAttribute("aria-expanded", "false");
    scrollToElementWithHeader(document.querySelector("#inscricoes"), 14);
  });
});

// Animação reveal
const observer = new IntersectionObserver(
  entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add("visible");
        observer.unobserve(entry.target);
      }
    });
  },
  { threshold: 0.14 }
);
document.querySelectorAll(".reveal").forEach(element => observer.observe(element));

// Modal de Zoom do Calendário
if (calendarCard && modal && modalImage) {
  calendarCard.addEventListener("click", () => {
    const calendarImg = calendarCard.querySelector("img");
    if (calendarImg) {
      modalImage.src = calendarImg.src;
      modalImage.alt = calendarImg.alt;
    }
    if (typeof modal.showModal === "function") modal.showModal();
  });

  if (closeModal) {
    closeModal.addEventListener("click", () => {
      modal.close();
    });
  }

  modal.addEventListener("click", event => {
    if (event.target === modal) {
      modal.close();
    }
  });
}

// ==============================================================================
// GESTÃO DE INSCRIÇÕES E PERSISTÊNCIA
// ==============================================================================
const signupForm = document.querySelector("#signup-form");
const subButtons = [...document.querySelectorAll(".sub-choice")];
const selectedSubInput = document.querySelector("#selected-sub");
const selectedSubTitle = document.querySelector("#selected-sub-title");
const submitSignup = document.querySelector(".submit-signup");
const formFeedback = document.querySelector("#form-feedback");
const extraShirtFields = document.querySelector("#extra-shirt-fields");
const extraShirtQuantity = document.querySelector("#extra-shirt-quantity");
const extraShirtSize = document.querySelector("#extra-shirt-size");
const paidFields = document.querySelector("#paid-fields");
const paymentProofField = document.querySelector("#payment-proof-field");
const paymentProof = document.querySelector("#payment-proof");
const paymentReasonField = document.querySelector("#payment-reason-field");
const paymentReason = document.querySelector("#payment-reason");
const pendingMessage = document.querySelector("#pending-message");
const whatsappSuccess = document.querySelector("#whatsapp-success");
const whatsappGroupButton = document.querySelector("#whatsapp-group-button");
if (whatsappSuccess) {
  whatsappSuccess.hidden = true;
  whatsappSuccess.style.display = "none";
}

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const PROOF_TYPES = new Set([...PHOTO_TYPES, "application/pdf"]);

const hasSupabaseConfig = Boolean(
  window.EJC_SUPABASE_URL &&
  window.EJC_SUPABASE_ANON_KEY &&
  !window.EJC_SUPABASE_URL.includes("COLE_AQUI") &&
  !window.EJC_SUPABASE_ANON_KEY.includes("COLE_AQUI")
);

const supabaseClient = (hasSupabaseConfig && window.supabase)
  ? window.supabase.createClient(window.EJC_SUPABASE_URL, window.EJC_SUPABASE_ANON_KEY)
  : null;

function setFeedback(message, type = "") {
  if (!formFeedback) return;
  formFeedback.textContent = message;
  formFeedback.className = `form-feedback ${type}`.trim();
}

function selectSub(sub) {
  if (!selectedSubInput || !selectedSubTitle) return;
  selectedSubInput.value = sub;
  selectedSubTitle.textContent = `Inscrição — Sub ${sub}`;
  if (submitSignup) submitSignup.disabled = false;
  subButtons.forEach(button => button.classList.toggle("selected", button.dataset.sub === sub));
  
  const subReminder = document.getElementById("subSelectionReminder");
  if (subReminder) {
    subReminder.innerHTML = `<i class="fa-solid fa-circle-check" aria-hidden="true"></i> Sub <strong>${sub}</strong> selecionado com sucesso!`;
    subReminder.classList.add("sub-selected");
  }
  
  scrollToElementWithHeader(signupForm, 16);
}
subButtons.forEach(button => button.addEventListener("click", () => selectSub(button.dataset.sub)));

document.querySelectorAll('input[name="quer_camisa_adicional"]').forEach(input => {
  input.addEventListener("change", () => {
    const wantsExtra = input.value === "true";
    if (extraShirtFields) extraShirtFields.hidden = !wantsExtra;
    if (extraShirtQuantity) extraShirtQuantity.required = wantsExtra;
    if (extraShirtSize) extraShirtSize.required = wantsExtra;
    if (!wantsExtra) {
      if (extraShirtQuantity) extraShirtQuantity.value = "";
      if (extraShirtSize) extraShirtSize.value = "";
    }
  });
});

function updatePaymentFields() {
  const paidChoice = document.querySelector('input[name="pagamento_informado"]:checked');
  const isPaid = paidChoice?.value === "true";
  const method = document.querySelector('input[name="forma_pagamento"]:checked')?.value || "";

  // Atualiza classe .selected nos cards de opções de pagamento
  document.querySelectorAll(".payment-card-option").forEach(card => {
    const radio = card.querySelector('input[name="pagamento_informado"]');
    card.classList.toggle("selected", Boolean(radio && radio.checked));
  });

  if (paidFields) paidFields.hidden = !isPaid;
  if (paymentReasonField) paymentReasonField.hidden = isPaid;
  if (pendingMessage) pendingMessage.hidden = isPaid;
  if (paymentReason) paymentReason.required = !isPaid && Boolean(paidChoice);

  if (paymentProofField) paymentProofField.hidden = !isPaid || method !== "pix";
  if (paymentProof) paymentProof.required = isPaid && method === "pix";

  document.querySelectorAll('input[name="forma_pagamento"]').forEach(el => {
    el.required = isPaid;
    if (!isPaid) el.checked = false;
  });

  if ((!isPaid || method !== "pix") && paymentProof) paymentProof.value = "";
  if (isPaid && paymentReason) paymentReason.value = "";
}

document.querySelectorAll('input[name="pagamento_informado"], input[name="forma_pagamento"]').forEach(input => {
  input.addEventListener("change", updatePaymentFields);
});

// Upload dinâmico: exibição de arquivo selecionado e feedback visual
const photoInput = document.getElementById("photo");
const photoUploadZone = document.getElementById("photoUploadZone");
const photoUploadTitle = document.getElementById("photoUploadTitle");

if (photoInput && photoUploadZone && photoUploadTitle) {
  photoInput.addEventListener("change", () => {
    if (photoInput.files && photoInput.files[0]) {
      const fileName = photoInput.files[0].name;
      photoUploadTitle.innerHTML = `<i class="fa-solid fa-check" style="color: #10b981; margin-right: 6px;"></i> Foto: <strong>${fileName}</strong>`;
      photoUploadZone.classList.add("has-file");
    } else {
      photoUploadTitle.textContent = "Clique ou arraste para anexar sua foto";
      photoUploadZone.classList.remove("has-file");
    }
  });
}

const proofInput = document.getElementById("payment-proof");
const proofUploadZone = document.getElementById("proofUploadZone");
const proofUploadTitle = document.getElementById("proofUploadTitle");

if (proofInput && proofUploadZone && proofUploadTitle) {
  proofInput.addEventListener("change", () => {
    if (proofInput.files && proofInput.files[0]) {
      const fileName = proofInput.files[0].name;
      proofUploadTitle.innerHTML = `<i class="fa-solid fa-check" style="color: #10b981; margin-right: 6px;"></i> Comprovante: <strong>${fileName}</strong>`;
      proofUploadZone.classList.add("has-file");
    } else {
      proofUploadTitle.textContent = "Clique para anexar o comprovante";
      proofUploadZone.classList.remove("has-file");
    }
  });
}

let latestCountRequestId = 0;

async function updateSubCounts() {
  const currentRequestId = ++latestCountRequestId;
  let counts = null;
  let capacities = { Verde: 85, Vermelho: 85, Amarelo: 85, Laranja: 85 };
  let remoteLoaded = false;

  // 1. Consulta o endpoint central oficial com anti-cache estrito (suporte a Edge Functions e Rollback)
  try {
    const scEndpoint = window.EJC_ENDPOINTS.subCounts();
    const res = await fetch(`${scEndpoint}?_t=${Date.now()}`, {
      headers: { "Cache-Control": "no-cache", "Pragma": "no-cache" },
      cache: "no-store"
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.success && data.counts) {
        counts = { Verde: 0, Vermelho: 0, Amarelo: 0, Laranja: 0, ...data.counts };
        if (data.capacities) {
          capacities = { ...capacities, ...data.capacities };
        }
        remoteLoaded = true;
      }
    }
  } catch (errApi) {
    console.warn("[updateSubCounts] Falha ao consultar endpoint de contagens:", errApi);
  }

  // 2. Se a API não respondeu e Supabase estiver configurado, tenta Supabase
  if (!remoteLoaded && typeof supabaseClient !== "undefined" && supabaseClient) {
    try {
      const { data, error } = await supabaseClient.rpc("contagem_inscricoes_por_sub");
      if (!error && data && Array.isArray(data)) {
        counts = { Verde: 0, Vermelho: 0, Amarelo: 0, Laranja: 0 };
        data.forEach(item => {
          const s = (item.sub === "Azul") ? "Laranja" : item.sub;
          if (counts[s] !== undefined) {
            counts[s] = (counts[s] || 0) + Number(item.total || 0);
          }
        });
        remoteLoaded = true;
      }
    } catch (e) {
      console.warn("Supabase offline, usando persistência local para vagas.", e);
    }
  }

  // Descarta resposta obsoleta se outra requisição mais nova foi disparada
  if (currentRequestId !== latestCountRequestId) return;

  // Se nenhuma fonte retornou dados válidos, não sobrescreve os valores na tela com falso zero
  if (!remoteLoaded || !counts) {
    console.warn("[updateSubCounts] Não foi possível obter contagem oficial atualizada.");
    return;
  }

  subButtons.forEach(button => {
    const sub = button.dataset.sub;
    const capacity = Number((capacities && capacities[sub]) || button.dataset.capacity || 85);
    const current = Number(counts[sub] || 0);
    const countEl = document.querySelector(`[data-count-for="${sub}"]`);
    const progressEl = document.querySelector(`[data-progress-for="${sub}"]`);
    if (countEl) countEl.textContent = current;
    if (progressEl) progressEl.style.width = `${Math.min(100, (current / capacity) * 100)}%`;
    if (current >= capacity) {
      button.disabled = true;
      const textEl = button.querySelector(".sub-button-text");
      if (textEl) textEl.textContent = "Vagas encerradas";
    } else {
      button.disabled = false;
      const textEl = button.querySelector(".sub-button-text");
      if (textEl) textEl.textContent = "Quero este Sub";
    }
  });
}

function safeFileName(file) {
  const extension = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "");
  const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${id}.${extension}`;
}

function validateFile(file, allowedTypes, label) {
  if (!(file instanceof File) || !file.size) return `${label} não foi selecionado.`;
  if (file.size > MAX_FILE_SIZE) return `${label} deve ter no máximo 5 MB.`;
  if (!allowedTypes.has(file.type)) return `${label} está em um formato não permitido.`;
  return "";
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function uploadFile(folder, file) {
  if (!supabaseClient) throw new Error("Supabase não configurado");
  const path = `${folder}/${safeFileName(file)}`;
  const { error } = await supabaseClient.storage
    .from("fotos")
    .upload(path, file, { cacheControl: "3600", upsert: false, contentType: file.type });
  if (error) throw new Error(error.message);
  return path;
}

// Helpers para upload de foto de participantes direto para Cloudflare R2
async function obterPresignedUrlFotoR2(sub, file) {
  const endpoint = window.EJC_ENDPOINTS?.r2PresignedUrl
    ? window.EJC_ENDPOINTS.r2PresignedUrl()
    : "https://guppedddwnuvluhiaaas.supabase.co/functions/v1/r2-presigned-url";

  const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "");

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      action: "get_upload_url",
      sub: sub,
      extension: ext,
      mimeType: file.type || "image/jpeg"
    })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success || !data.uploadUrl || !data.storageKey) {
    throw new Error(data.error || "Não foi possível obter autorização para envio da foto para o R2.");
  }

  return data;
}

async function uploadFotoDiretoR2(uploadUrl, file) {
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": file.type || "image/jpeg"
    },
    body: file
  });

  if (!res.ok) {
    throw new Error(`Falha no upload direto para Cloudflare R2: HTTP ${res.status}`);
  }

  return true;
}

async function cleanupFotoR2(storageKey, cleanupToken) {
  if (!storageKey || !cleanupToken) return;
  const endpoint = window.EJC_ENDPOINTS?.r2PresignedUrl
    ? window.EJC_ENDPOINTS.r2PresignedUrl()
    : "https://guppedddwnuvluhiaaas.supabase.co/functions/v1/r2-presigned-url";

  try {
    await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "cleanup",
        storageKey,
        cleanupToken
      })
    });
  } catch (err) {
    console.warn("[Cleanup R2] Erro na tentativa de cleanup:", err);
  }
}

// Submissão do Formulário com Fallback Resiliente
if (signupForm) {
  signupForm.addEventListener("submit", async event => {
    event.preventDefault();
    if (!selectedSubInput?.value) {
      setFeedback("Escolha um Sub antes de finalizar.", "error");
      return;
    }

    const formData = new FormData(signupForm);
    const photo = formData.get("foto");
    const photoError = validateFile(photo, PHOTO_TYPES, "A foto");
    if (photoError) {
      setFeedback(photoError, "error");
      return;
    }

    const emailValue = String(formData.get("email") || "").trim().toLowerCase();
    if (!emailValue || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailValue)) {
      setFeedback("Por favor, informe um endereço de e-mail válido para recebimento do comprovante.", "error");
      return;
    }

    const paymentChoice = formData.get("pagamento_informado");
    const isCheckout = paymentChoice === "checkout";
    const paymentReported = paymentChoice === "true";
    const paymentMethod = paymentReported ? String(formData.get("forma_pagamento") || "") : (isCheckout ? "checkout_online" : null);
    const proof = formData.get("comprovante");

    if (paymentReported && !["pix", "especie"].includes(paymentMethod)) {
      setFeedback("Informe se o pagamento foi feito por Pix ou em espécie.", "error");
      return;
    }
    if (paymentReported && paymentMethod === "pix" && (!(proof instanceof File) || !proof.size)) {
      setFeedback("Para pagamento por Pix informado, o comprovante é obrigatório.", "error");
      return;
    }
    if (paymentReported && proof instanceof File && proof.size) {
      const proofError = validateFile(proof, PROOF_TYPES, "O comprovante");
      if (proofError) {
        setFeedback(proofError, "error");
        return;
      }
    }

    if (submitSignup) submitSignup.disabled = true;
    if (whatsappSuccess) {
      whatsappSuccess.hidden = true;
      whatsappSuccess.style.display = "none";
    }
    if (whatsappGroupButton) whatsappGroupButton.removeAttribute("href");
    setFeedback("Verificando cadastro e processando...", "loading");

    const normalizedName = String(formData.get("nome_completo") || "").trim();
    const normalizedPhone = String(formData.get("whatsapp") || "").trim();
    const chosenSub = selectedSubInput.value;
    const wantsExtraShirt = formData.get("quer_camisa_adicional") === "true";
    const [shirtSize, shirtModel = "Tradicional"] = String(formData.get("tamanho_camisa") || "").split("|");
    const [extraShirtSizeValue, extraShirtModel = "Tradicional"] = String(formData.get("tamanho_camisa_adicional") || "").split("|");
    const paymentObservation = isCheckout
      ? "Redirecionado para o Checkout Oficial (Pix/Cartão)."
      : (paymentReported
        ? "Pagamento informado pelo inscrito; aguardando conferência da coordenação."
        : "Pagamento pendente; deverá ser realizado até a data limite da coordenação.");

    let photoPath = null;
    let proofPath = null;
    let registrationSuccess = false;
    let userToken = crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "") : String(Date.now());
    let registeredId = null;

    // 1. Tenta envio pelo Supabase se disponível
    if (supabaseClient) {
      let r2UploadData = null;
      try {
        const { data: canRegister } = await supabaseClient.rpc("pode_realizar_inscricao", {
          p_nome_completo: normalizedName,
          p_sub: chosenSub
        });

        if (canRegister && canRegister.allowed === false) {
          setFeedback(canRegister.message || "Já existe uma inscrição com este nome.", "error");
          if (submitSignup) submitSignup.disabled = false;
          return;
        }

        // Upload de Foto de Participante: Direto para Cloudflare R2 via Presigned URL
        try {
          setFeedback("Obtendo autorização segura de envio de foto...", "loading");
          r2UploadData = await obterPresignedUrlFotoR2(chosenSub, photo);

          setFeedback("Enviando foto para armazenamento seguro...", "loading");
          await uploadFotoDiretoR2(r2UploadData.uploadUrl, photo);
          photoPath = r2UploadData.storageKey;
        } catch (r2Err) {
          console.error("[Signup] Erro no upload R2:", r2Err);
          setFeedback(`Erro no envio da foto: ${r2Err.message || "Falha no armazenamento seguro."}`, "error");
          if (submitSignup) submitSignup.disabled = false;
          return;
        }

        // Upload de Comprovante: Supabase Storage inalterado
        if (paymentReported && paymentMethod === "pix" && proof instanceof File && proof.size) {
          proofPath = await uploadFile(`comprovantes/${chosenSub.toLowerCase()}`, proof);
        }

        const { data: registrationResult, error: insertError } = await supabaseClient.rpc("realizar_inscricao_com_link", {
          p_nome_completo: normalizedName,
          p_sub: chosenSub,
          p_whatsapp: normalizedPhone,
          p_modelo_camisa: shirtModel,
          p_tamanho_camisa: shirtSize,
          p_quer_camisa_adicional: wantsExtraShirt,
          p_quantidade_camisas_adicionais: wantsExtraShirt ? Number(formData.get("quantidade_camisas_adicionais")) : 0,
          p_modelo_camisa_adicional: wantsExtraShirt ? extraShirtModel : null,
          p_tamanho_camisa_adicional: wantsExtraShirt ? extraShirtSizeValue : null,
          p_talento: String(formData.get("talento") || "").trim() || null,
          p_foto_caminho: photoPath,
          p_comprovante_caminho: proofPath,
          p_forma_pagamento: paymentMethod,
          p_pagamento_informado: paymentReported,
          p_pagamento_status: paymentReported ? (paymentMethod === "pix" ? "confirmado" : "informado") : "pendente",
          p_justificativa_pagamento: String(formData.get("justificativa_pagamento") || "").trim() || null,
          p_observacao_pagamento: paymentObservation
        });

        if (insertError) {
          // CONSISTÊNCIA / CLEANUP (PARTE 6): RPC falhou após upload no R2
          console.warn("[Signup] RPC falhou após upload no R2. Acionando cleanup imediato:", insertError.message);
          if (r2UploadData?.storageKey && r2UploadData?.cleanupToken) {
            await cleanupFotoR2(r2UploadData.storageKey, r2UploadData.cleanupToken).catch(err => {
              console.error("[Signup] Falha no cleanup do R2:", err);
            });
          }
          throw new Error(insertError.message);
        }

        if (!insertError) {
          registrationSuccess = true;
          if (registrationResult?.token) userToken = registrationResult.token;
          if (registrationResult?.id) registeredId = registrationResult.id;
          // Salva o e-mail da inscrição via RPC protegida pelo token secreto (a tabela não aceita mais UPDATE público)
          if (registrationResult?.id && registrationResult?.token) {
            Promise.resolve(supabaseClient.rpc("definir_email_inscricao", {
              p_id: registrationResult.id,
              p_token: registrationResult.token,
              p_email: emailValue
            })).catch(() => {});
          }
        }
      } catch (err) {
        console.warn("Falha no envio ao Supabase remoto, acionando persistência resiliente.", err);
      }
    }

    // 2. Persistência Resiliente Local (garantia de gravação)
    try {
      const localInscricoes = JSON.parse(localStorage.getItem("ejc_inscricoes") || "[]");
      
      // Valida duplicidade local
      const existsPhone = localInscricoes.some(i => i.whatsapp === normalizedPhone);
      const existsName = localInscricoes.some(i => (i.nome_completo || "").toLowerCase() === normalizedName.toLowerCase());
      
      if (!registrationSuccess && existsPhone) {
        setFeedback("Já existe uma inscrição realizada com este número de WhatsApp.", "error");
        if (submitSignup) submitSignup.disabled = false;
        return;
      }
      if (!registrationSuccess && existsName) {
        setFeedback("Este nome já possui uma inscrição realizada.", "error");
        if (submitSignup) submitSignup.disabled = false;
        return;
      }

      const photoDataUrl = photo instanceof File ? await fileToDataUrl(photo) : photoPath;
      const proofDataUrl = proof instanceof File && proof.size ? await fileToDataUrl(proof) : proofPath;

      const newRegistration = {
        id: registeredId || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
        criado_em: new Date().toISOString(),
        nome_completo: normalizedName,
        email: emailValue,
        sub: chosenSub,
        whatsapp: normalizedPhone,
        modelo_camisa: shirtModel,
        tamanho_camisa: shirtSize,
        quer_camisa_adicional: wantsExtraShirt,
        quantidade_camisas_adicionais: wantsExtraShirt ? Number(formData.get("quantidade_camisas_adicionais")) : 0,
        modelo_camisa_adicional: wantsExtraShirt ? extraShirtModel : null,
        tamanho_camisa_adicional: wantsExtraShirt ? extraShirtSizeValue : null,
        talento: String(formData.get("talento") || "").trim() || null,
        foto_caminho: photoDataUrl,
        comprovante_caminho: proofDataUrl,
        forma_pagamento: paymentMethod,
        pagamento_informado: paymentReported,
        pagamento_status: paymentReported ? (paymentMethod === "pix" ? "confirmado" : "informado") : "pendente",
        justificativa_pagamento: String(formData.get("justificativa_pagamento") || "").trim() || null,
        observacao_pagamento: paymentObservation,
        token_acesso: userToken
      };

      if (!registeredId) registeredId = newRegistration.id;

      // 2.1 Sincronização direta com a base persistente central (/api/sub-counts)
      try {
        const syncRes = await fetch("/api/sub-counts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(newRegistration)
        });
        if (syncRes.ok) {
          const syncJson = await syncRes.json();
          if (syncJson && syncJson.success) {
            registrationSuccess = true;
            if (syncJson.id) registeredId = syncJson.id;
          }
        }
      } catch (errSync) {
        console.warn("[Signup] Sync central indisponível no momento, mantendo gravação local:", errSync);
      }

      // 2.2 Gravação local apenas com confirmação efetiva do backend
      if (registrationSuccess) {
        localInscricoes.push(newRegistration);
        localStorage.setItem("ejc_inscricoes", JSON.stringify(localInscricoes));
      }
    } catch (e) {
      console.error("Erro ao salvar inscrição:", e);
    }

    if (registrationSuccess) {
      const activeValor = (window.EJC_ACTIVE_PRICE && Number(window.EJC_ACTIVE_PRICE) > 0) ? Number(window.EJC_ACTIVE_PRICE) : "";
      const activeLote = window.EJC_ACTIVE_LOTE || "Aguardando Coordenação";
      const activeVersao = window.EJC_ACTIVE_VERSION || 0;
      const inscricaoIdParam = registeredId || "";
      const tokenAcessoParam = userToken || "";

      // Preserva contexto completo da inscrição na sessionStorage para o Checkout
      try {
        sessionStorage.setItem("ejc_checkout_sub", chosenSub);
        sessionStorage.setItem("ejc_checkout_inscricao_id", inscricaoIdParam);
        sessionStorage.setItem("ejc_checkout_nome", normalizedName);
        sessionStorage.setItem("ejc_checkout_email", emailValue);
        sessionStorage.setItem("ejc_checkout_whatsapp", normalizedPhone);
      } catch (eStore) {}

      const checkoutUrl = `/checkout?tipo=inscricao&valor=${activeValor}&lote=${encodeURIComponent(activeLote)}&v=${activeVersao}&nome=${encodeURIComponent(normalizedName)}&email=${encodeURIComponent(emailValue)}&whatsapp=${encodeURIComponent(normalizedPhone)}&sub=${encodeURIComponent(chosenSub)}&inscricao_id=${encodeURIComponent(inscricaoIdParam)}&token=${encodeURIComponent(tokenAcessoParam)}`;

      const btnPayAfterSignup = document.getElementById("btnPayAfterSignup");
      if (btnPayAfterSignup) {
        btnPayAfterSignup.href = checkoutUrl;
        btnPayAfterSignup.style.display = "flex";
        btnPayAfterSignup.onclick = (e) => {
          e.preventDefault();
          try {
            sessionStorage.setItem("ejc_checkout_sub", chosenSub);
            sessionStorage.setItem("ejc_checkout_inscricao_id", inscricaoIdParam);
            sessionStorage.setItem("ejc_checkout_nome", normalizedName);
            sessionStorage.setItem("ejc_checkout_email", emailValue);
            sessionStorage.setItem("ejc_checkout_whatsapp", normalizedPhone);
          } catch(err) {}
          window.location.href = checkoutUrl;
        };
      }

      if (isCheckout) {
        setFeedback("Inscrição realizada! Redirecionando para o Checkout Oficial...", "success");
        setTimeout(() => {
          window.location.href = checkoutUrl;
        }, 1000);
      } else {
        setFeedback(
          paymentReported
            ? "Inscrição realizada com sucesso! Pagamento registrado para conferência da coordenação."
            : "Inscrição realizada com sucesso! Pagamento registrado como pendente até a data limite.",
          "success"
        );
      }

      // Acesso ao Grupo do WhatsApp do Sub escolhido após a inscrição (sem pagamento)
      let subKey = String(chosenSub || "").trim();
      if (subKey.toLowerCase() === "azul") subKey = "Laranja";

      const subGroupUrl = (window.EJC_WHATSAPP_SUBS && (
        window.EJC_WHATSAPP_SUBS[subKey] ||
        window.EJC_WHATSAPP_SUBS[subKey.toLowerCase()] ||
        window.EJC_WHATSAPP_SUBS[subKey.charAt(0).toUpperCase() + subKey.slice(1).toLowerCase()]
      )) || "";

      if (whatsappGroupButton) {
        whatsappGroupButton.removeAttribute("data-whatsapp-target");
        if (subGroupUrl && typeof subGroupUrl === "string" && subGroupUrl.startsWith("http")) {
          whatsappGroupButton.href = subGroupUrl;
          whatsappGroupButton.innerHTML = `<i class="fa-brands fa-whatsapp" aria-hidden="true"></i> Entrar no grupo do Sub ${chosenSub}`;
          whatsappGroupButton.style.pointerEvents = "auto";
          whatsappGroupButton.style.opacity = "1";
        } else if (tokenAcessoParam) {
          whatsappGroupButton.href = window.EJC_ENDPOINTS.whatsapp(tokenAcessoParam);
          whatsappGroupButton.innerHTML = `<i class="fa-brands fa-whatsapp" aria-hidden="true"></i> Entrar no grupo do Sub ${chosenSub}`;
          whatsappGroupButton.style.pointerEvents = "auto";
          whatsappGroupButton.style.opacity = "1";
        } else {
          whatsappGroupButton.removeAttribute("href");
          whatsappGroupButton.innerHTML = `<i class="fa-brands fa-whatsapp" aria-hidden="true"></i> Entrar no grupo do Sub ${chosenSub}`;
          whatsappGroupButton.style.pointerEvents = "none";
          whatsappGroupButton.style.opacity = "0.6";
        }
      }
      if (whatsappSuccess) {
        whatsappSuccess.hidden = false;
        whatsappSuccess.style.display = "flex";
        whatsappSuccess.scrollIntoView({ behavior: "smooth", block: "center" });
      }

      signupForm.reset();
      selectedSubInput.value = chosenSub;
      if (extraShirtFields) extraShirtFields.hidden = true;
      if (paidFields) paidFields.hidden = true;
      if (paymentReasonField) paymentReasonField.hidden = true;
      if (pendingMessage) pendingMessage.hidden = true;
      if (photoUploadTitle) photoUploadTitle.textContent = "Clique ou arraste para anexar sua foto";
      if (photoUploadZone) photoUploadZone.classList.remove("has-file");
      if (proofUploadTitle) proofUploadTitle.textContent = "Clique para anexar o comprovante";
      if (proofUploadZone) proofUploadZone.classList.remove("has-file");
      updatePaymentFields();
      await updateSubCounts();
    } else {
      if (whatsappSuccess) {
        whatsappSuccess.hidden = true;
        whatsappSuccess.style.display = "none";
      }
      setFeedback("Não foi possível concluir a inscrição no servidor. Verifique sua conexão e tente novamente.", "error");
    }

    if (submitSignup) submitSignup.disabled = false;
  });
}

updateSubCounts();

// Sincronização automática contínua entre dispositivos
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    updateSubCounts();
  }
});
setInterval(() => {
  if (document.visibilityState === "visible") {
    updateSubCounts();
  }
}, 30000);

// Máscara dinâmica de telefone
document.addEventListener("DOMContentLoaded", () => {
  const w = document.getElementById("whatsapp");
  if (w) {
    w.addEventListener("input", function() {
      let v = this.value.replace(/\D/g, "").substring(0, 11);
      if (v.length > 10) {
        v = v.replace(/(\d{2})(\d{5})(\d+)/, "($1) $2-$3");
      } else {
        v = v.replace(/(\d{2})(\d{4})(\d+)/, "($1) $2-$3");
      }
      this.value = v;
    });
  }
});

// ==============================================================================
// SINCRONIZAÇÃO DINÂMICA DA CONFIGURAÇÃO FINANCEIRA PÚBLICA (PREÇO, LOTE)
// ==============================================================================
window.EJC_ACTIVE_PRICE = null;
window.EJC_ACTIVE_LOTE = "Aguardando Coordenação";
window.EJC_ACTIVE_VERSION = 0;

function aplicarConfiguracaoNaPagina(cfg) {
  if (!cfg) return;

  // Atualiza links de WhatsApp se presentes no payload oficial (independe de versão financeira)
  if (cfg.whatsapp) {
    window.EJC_WHATSAPP_SUBS = window.EJC_WHATSAPP_SUBS || {};
    Object.assign(window.EJC_WHATSAPP_SUBS, cfg.whatsapp);
    const geralLink = cfg.whatsapp.geral || cfg.whatsapp.Geral;
    if (geralLink && typeof geralLink === "string" && geralLink.startsWith("http")) {
      document.querySelectorAll('[data-whatsapp-target="geral"]').forEach(el => {
        if (el.id !== "whatsapp-group-button") {
          el.href = geralLink;
        }
      });
      const floatBtn = document.querySelector(".whatsapp-float");
      if (floatBtn) floatBtn.href = geralLink;
      const navWpp = document.querySelector(".nav-cta");
      if (navWpp) navWpp.href = geralLink;
    }
  }

  const pixData = cfg.pix || cfg;
  const incomingVersion = Number(cfg.versao || pixData.versao || 0);
  const currentVersion = Number(window.EJC_ACTIVE_VERSION || 0);

  // Proteção anti-downgrade financeiro: impede que réplica serverless fria reverta preço
  if (currentVersion > 0 && incomingVersion > 0 && incomingVersion < currentVersion) {
    console.warn(`[Landing] Ignorando payload financeiro desatualizado v${incomingVersion} < v${currentVersion}`);
    return;
  }
  if (incomingVersion > 0) {
    window.EJC_ACTIVE_VERSION = incomingVersion;
  }

  const rawVal = pixData.valorTaxaInscricao !== undefined ? pixData.valorTaxaInscricao : (pixData.valor_inscricao !== undefined ? pixData.valor_inscricao : cfg.valor_inscricao);
  const isConfigurado = Boolean(cfg.configurado || pixData.configurado || (rawVal !== null && rawVal !== undefined && rawVal !== "" && Number(rawVal) > 0));
  const valorInscricao = (rawVal !== null && rawVal !== undefined && rawVal !== "") ? Number(rawVal) : null;
  const lote = pixData.loteAtual || pixData.lote_atual || cfg.lote_atual || "Aguardando Coordenação";

  if (!isConfigurado || valorInscricao === null || isNaN(valorInscricao) || valorInscricao <= 0) {
    window.EJC_ACTIVE_PRICE = null;
    window.EJC_ACTIVE_LOTE = lote;

    const heroFeeText = document.getElementById("heroFeeText");
    if (heroFeeText) {
      heroFeeText.textContent = "Inscrições da equipe. Pagamento via Cartão de crédito em até 12x ou Pix com baixa imediata.";
    }
    const feeLotBadge = document.getElementById("feeLotBadge");
    if (feeLotBadge) {
      feeLotBadge.textContent = "Taxa da equipe";
    }
    const mainFeePriceDisplay = document.getElementById("mainFeePriceDisplay");
    if (mainFeePriceDisplay) {
      mainFeePriceDisplay.textContent = "A definir";
    }
    const paymentLegend = document.getElementById("paymentLegendTitle");
    if (paymentLegend) {
      paymentLegend.textContent = "Taxa de inscrição da equipe (Aguardando Coordenação)";
    }
    const btnPayFeeSection = document.getElementById("btnPayFeeSection");
    if (btnPayFeeSection) {
      btnPayFeeSection.textContent = "Acessar Checkout";
    }
    return;
  }

  const promo = (pixData.valorPromocional !== undefined && pixData.valorPromocional !== null)
    ? Number(pixData.valorPromocional)
    : (cfg.valor_promocional !== undefined && cfg.valor_promocional !== null ? Number(cfg.valor_promocional) : null);
  
  const precoEfetivo = (cfg.preco_efetivo || cfg.precoEfetivo || pixData.preco_efetivo || pixData.precoEfetivo)
    ? Number(cfg.preco_efetivo || cfg.precoEfetivo || pixData.preco_efetivo || pixData.precoEfetivo)
    : ((promo !== null && !isNaN(promo) && promo > 0 && promo < valorInscricao) ? promo : valorInscricao);

  window.EJC_ACTIVE_PRICE = precoEfetivo;
  window.EJC_ACTIVE_LOTE = lote;

  const valorFormatado = precoEfetivo.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const valorOriginalFormatado = valorInscricao.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const hasPromo = promo !== null && promo < valorInscricao && promo > 0;

  const heroFeeText = document.getElementById("heroFeeText");
  if (heroFeeText) {
    if (hasPromo) {
      heroFeeText.innerHTML = `Taxa promocional de <strong>${valorFormatado}</strong> <del style="opacity: 0.7;">${valorOriginalFormatado}</del> (${lote}). Cartão ou Pix com baixa imediata.`;
    } else {
      heroFeeText.textContent = `Taxa única de ${valorFormatado} (${lote}). Cartão de crédito em até 12x ou Pix com baixa imediata.`;
    }
  }

  const feeLotBadge = document.getElementById("feeLotBadge");
  if (feeLotBadge) {
    feeLotBadge.textContent = `Taxa da equipe (${lote})`;
  }

  const mainFeePriceDisplay = document.getElementById("mainFeePriceDisplay");
  if (mainFeePriceDisplay) {
    mainFeePriceDisplay.textContent = valorFormatado;
  }

  const paymentLegend = document.getElementById("paymentLegendTitle");
  if (paymentLegend) {
    paymentLegend.textContent = `Como você deseja pagar a taxa de inscrição (${valorFormatado})?`;
  }

  const btnPayFeeSection = document.getElementById("btnPayFeeSection");
  if (btnPayFeeSection) {
    btnPayFeeSection.textContent = `Pagar Taxa de ${valorFormatado} (Pix ou Cartão)`;
  }
}

function carregarConfiguracaoPublica() {
  // 1. Aplicação imediata síncrona do cache local para prevenir FOUC (flash de dados antigos)
  try {
    const cached = localStorage.getItem("ejc_config_financeira");
    if (cached) {
      aplicarConfiguracaoNaPagina(JSON.parse(cached));
    }
  } catch (e) {}

  // 2. Busca remota no servidor com headers anti-cache estritos e versão do cliente
  const headers = {
    "Cache-Control": "no-cache",
    "Pragma": "no-cache"
  };
  if (window.EJC_ACTIVE_VERSION) {
    headers["x-client-version"] = String(window.EJC_ACTIVE_VERSION);
  }

  const cfgEndpoint = window.EJC_ENDPOINTS.config();

  fetch(`${cfgEndpoint}?_t=${Date.now()}`, {
    cache: "no-store",
    headers: headers
  })
    .then(res => res.ok ? res.json() : null)
    .then(data => {
      if (data) {
        aplicarConfiguracaoNaPagina(data);
      }
    })
    .catch(err => console.warn("[Config Publica] Erro ao carregar configuração:", err));
}

// Ouvinte para atualização em tempo real entre abas no mesmo navegador
window.addEventListener("storage", (e) => {
  if (e.key === "ejc_config_financeira" && e.newValue) {
    try {
      aplicarConfiguracaoNaPagina(JSON.parse(e.newValue));
    } catch(err) {}
  }
});

// Inicialização imediata
carregarConfiguracaoPublica();

// ==============================================================================
// REDIRECIONAMENTO PARA O CHECKOUT OFICIAL CENTRALIZADO (PIX & CARTÃO)
// ==============================================================================
document.querySelectorAll(".btn-open-pix-dinamico, .btn-open-checkout").forEach(btn => {
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    const tipo = btn.dataset.tipo || "inscricao";
    const activePrice = (window.EJC_ACTIVE_PRICE && Number(window.EJC_ACTIVE_PRICE) > 0) ? Number(window.EJC_ACTIVE_PRICE) : null;
    const valor = tipo === "inscricao" ? activePrice : Number(btn.dataset.valor || 25);
    const lote = tipo === "inscricao" ? (window.EJC_ACTIVE_LOTE || "") : "";
    const v = tipo === "inscricao" ? (window.EJC_ACTIVE_VERSION || 0) : 0;
    const nome = document.querySelector("#full-name")?.value || "";
    const email = document.querySelector("#email")?.value || "";
    const wpp = document.querySelector("#whatsapp")?.value || "";
    const sub = document.querySelector("#selected-sub")?.value || "";
    let checkoutUrl = `/checkout?tipo=${tipo}`;
    if (valor !== null && valor !== undefined) checkoutUrl += `&valor=${valor}`;
    if (nome) checkoutUrl += `&nome=${encodeURIComponent(nome)}`;
    if (email) checkoutUrl += `&email=${encodeURIComponent(email)}`;
    if (wpp) checkoutUrl += `&whatsapp=${encodeURIComponent(wpp)}`;
    if (sub) checkoutUrl += `&sub=${encodeURIComponent(sub)}`;
    if (lote) checkoutUrl += `&lote=${encodeURIComponent(lote)}`;
    if (v) checkoutUrl += `&v=${v}`;
    window.location.href = checkoutUrl;
  });
});

// Seleção de valores pré-definidos na Contribuição
let selectedPresetVal = 25;
const presetButtons = document.querySelectorAll(".preset-val-btn");
presetButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    presetButtons.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    selectedPresetVal = Number(btn.dataset.val || 25);
    const customInput = document.getElementById("customContributeValue");
    if (customInput) customInput.value = "";
  });
});

// Submissão da Contribuição -> Direciona ao Checkout Oficial Seguro
const btnSubmitContributionCheckout = document.getElementById("btnSubmitContributionCheckout") || document.getElementById("btnSubmitContributionPix");
if (btnSubmitContributionCheckout) {
  btnSubmitContributionCheckout.addEventListener("click", () => {
    const customInput = document.getElementById("customContributeValue");
    const nameInput = document.getElementById("contributorName");
    let valorFinal = selectedPresetVal;

    if (customInput && customInput.value && Number(customInput.value) > 0) {
      valorFinal = Number(customInput.value);
    }

    const contributorName = nameInput?.value.trim() || "Amigo da Equipe do Trânsito";
    window.location.href = `/checkout?tipo=contribuicao&valor=${valorFinal}&nome=${encodeURIComponent(contributorName)}`;
  });
}

// Sincronização dinâmica de links do WhatsApp com base na configuração central
function sincronizarLinksWhatsApp() {
  if (!window.EJC_ENDPOINTS || typeof window.EJC_ENDPOINTS.whatsapp !== "function") return;
  const defaultHref = window.EJC_ENDPOINTS.whatsapp();
  document.querySelectorAll('a[data-whatsapp-target="geral"], .whatsapp-float, .nav-cta, #whatsapp-group-button').forEach(el => {
    const currentHref = el.getAttribute("href");
    if (!currentHref || currentHref === "#" || currentHref.includes("/api/whatsapp") || currentHref.includes("/functions/v1/whatsapp")) {
      el.href = defaultHref;
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", sincronizarLinksWhatsApp);
} else {
  sincronizarLinksWhatsApp();
}

// Garantidor dinâmico e resiliente de redirecionamento para o Grupo Geral do WhatsApp
document.addEventListener("click", (e) => {
  const target = e.target.closest('[data-whatsapp-target="geral"], .whatsapp-float, .nav-cta');
  if (!target || target.id === "whatsapp-group-button") return;
  const currentHref = target.getAttribute("href");
  if (!currentHref || currentHref === "#" || currentHref.trim() === "" || currentHref.includes("/api/whatsapp") || currentHref.includes("/functions/v1/whatsapp")) {
    e.preventDefault();
    const liveGeral = (window.EJC_WHATSAPP_SUBS && (window.EJC_WHATSAPP_SUBS["Geral"] || window.EJC_WHATSAPP_SUBS["geral"])) || "";
    if (liveGeral && liveGeral.startsWith("http")) {
      window.open(liveGeral, "_blank", "noopener,noreferrer");
    } else {
      window.open(window.EJC_ENDPOINTS.whatsapp(), "_blank", "noopener,noreferrer");
    }
  }
});
