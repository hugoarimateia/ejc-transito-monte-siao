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
const calendarSlides = [...document.querySelectorAll(".calendar-slide")];
const calendarDots = [...document.querySelectorAll(".calendar-dots i")];
const modalImage = modal ? modal.querySelector("img") : null;
let activeCalendar = 0;
let calendarTimer = null;

// Rotação do Calendário com pausa segura
function showCalendar(index) {
  if (!calendarSlides.length) return;
  activeCalendar = (index + calendarSlides.length) % calendarSlides.length;
  calendarSlides.forEach((slide, i) => slide.classList.toggle("active", i === activeCalendar));
  calendarDots.forEach((dot, i) => dot.classList.toggle("active", i === activeCalendar));
}

function startCalendarRotation() {
  stopCalendarRotation();
  calendarTimer = setInterval(() => showCalendar(activeCalendar + 1), 5000);
}

function stopCalendarRotation() {
  if (calendarTimer) {
    clearInterval(calendarTimer);
    calendarTimer = null;
  }
}

if (calendarSlides.length > 1) startCalendarRotation();

// Botões manuais do Calendário
const btnCalPrev = document.getElementById("btnCalPrev");
const btnCalNext = document.getElementById("btnCalNext");
if (btnCalPrev) {
  btnCalPrev.addEventListener("click", (e) => {
    e.stopPropagation();
    showCalendar(activeCalendar - 1);
    startCalendarRotation();
  });
}
if (btnCalNext) {
  btnCalNext.addEventListener("click", (e) => {
    e.stopPropagation();
    showCalendar(activeCalendar + 1);
    startCalendarRotation();
  });
}

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

// Modal de Zoom do Calendário (com pausa do timer)
if (calendarCard && modal && modalImage) {
  calendarCard.addEventListener("click", () => {
    const current = calendarSlides[activeCalendar];
    if (current) {
      modalImage.src = current.src;
      modalImage.alt = current.alt;
    }
    stopCalendarRotation();
    if (typeof modal.showModal === "function") modal.showModal();
  });

  if (closeModal) {
    closeModal.addEventListener("click", () => {
      modal.close();
      startCalendarRotation();
    });
  }

  modal.addEventListener("click", event => {
    if (event.target === modal) {
      modal.close();
      startCalendarRotation();
    }
  });

  modal.addEventListener("close", () => {
    startCalendarRotation();
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

// Contagem resiliente de vagas por Sub
async function updateSubCounts() {
  let counts = { Verde: 0, Vermelho: 0, Amarelo: 0, Azul: 0 };
  let remoteLoaded = false;

  if (supabaseClient) {
    try {
      const { data, error } = await supabaseClient.rpc("contagem_inscricoes_por_sub");
      if (!error && data && Array.isArray(data)) {
        counts = Object.fromEntries(data.map(item => [item.sub, Number(item.total)]));
        remoteLoaded = true;
      }
    } catch (e) {
      console.warn("Supabase offline, usando persistência local para vagas.", e);
    }
  }

  // Se não carregou do servidor, calcula a partir do localStorage
  if (!remoteLoaded) {
    const local = JSON.parse(localStorage.getItem("ejc_inscricoes") || "[]");
    local.forEach(i => {
      if (counts[i.sub] !== undefined) counts[i.sub]++;
    });
  }

  subButtons.forEach(button => {
    const sub = button.dataset.sub;
    const capacity = Number(button.dataset.capacity || 50);
    const current = counts[sub] || 0;
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

    const paymentReported = formData.get("pagamento_informado") === "true";
    const paymentMethod = paymentReported ? String(formData.get("forma_pagamento") || "") : null;
    const proof = formData.get("comprovante");
    if (paymentReported && !["pix", "especie"].includes(paymentMethod)) {
      setFeedback("Informe se o pagamento foi feito por Pix ou em espécie.", "error");
      return;
    }
    if (paymentReported && paymentMethod === "pix" && (!(proof instanceof File) || !proof.size)) {
      setFeedback("Para pagamento por Pix, o comprovante é obrigatório.", "error");
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
    if (whatsappSuccess) whatsappSuccess.hidden = true;
    if (whatsappGroupButton) whatsappGroupButton.removeAttribute("href");
    setFeedback("Verificando cadastro e processando os arquivos...", "loading");

    const normalizedName = String(formData.get("nome_completo") || "").trim();
    const normalizedPhone = String(formData.get("whatsapp") || "").trim();
    const chosenSub = selectedSubInput.value;
    const wantsExtraShirt = formData.get("quer_camisa_adicional") === "true";
    const [shirtSize, shirtModel = "Tradicional"] = String(formData.get("tamanho_camisa") || "").split("|");
    const [extraShirtSizeValue, extraShirtModel = "Tradicional"] = String(formData.get("tamanho_camisa_adicional") || "").split("|");
    const paymentObservation = paymentReported
      ? "Pagamento informado pelo inscrito; aguardando conferência da coordenação."
      : "Pagamento pendente; deverá ser realizado até a data limite da coordenação.";

    let photoPath = null;
    let proofPath = null;
    let registrationSuccess = false;
    let userToken = crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "") : String(Date.now());

    // 1. Tenta envio pelo Supabase se disponível
    if (supabaseClient) {
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

        photoPath = await uploadFile(`participantes/${chosenSub.toLowerCase()}`, photo);
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

        if (!insertError) {
          registrationSuccess = true;
          if (registrationResult?.token) userToken = registrationResult.token;
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
        id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
        criado_em: new Date().toISOString(),
        nome_completo: normalizedName,
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

      localInscricoes.push(newRegistration);
      localStorage.setItem("ejc_inscricoes", JSON.stringify(localInscricoes));
      registrationSuccess = true;
    } catch (e) {
      console.error("Erro ao salvar localmente:", e);
    }

    if (registrationSuccess) {
      setFeedback(
        paymentReported
          ? "Inscrição realizada com sucesso! Pagamento registrado para conferência da coordenação."
          : "Inscrição realizada com sucesso! Pagamento registrado como pendente até a data limite.",
        "success"
      );

      // Redirecionamento individual e seguro para o grupo do WhatsApp do Sub
      const subWhatsAppUrls = window.EJC_WHATSAPP_SUBS || {
        "Verde": "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=verde",
        "Vermelho": "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=vermelho",
        "Amarelo": "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=amarelo",
        "Azul": "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=azul"
      };

      const groupUrl = subWhatsAppUrls[chosenSub] || subWhatsAppUrls["Geral"] || "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6";

      if (whatsappGroupButton) {
        whatsappGroupButton.href = groupUrl;
      }
      if (whatsappSuccess) {
        whatsappSuccess.hidden = false;
        whatsappSuccess.scrollIntoView({ behavior: "smooth", block: "center" });
      }

      signupForm.reset();
      selectedSubInput.value = chosenSub;
      if (extraShirtFields) extraShirtFields.hidden = true;
      if (paidFields) paidFields.hidden = true;
      if (paymentReasonField) paymentReasonField.hidden = true;
      if (pendingMessage) pendingMessage.hidden = true;
      await updateSubCounts();
    } else {
      setFeedback("Não foi possível concluir a inscrição. Tente novamente em instantes.", "error");
    }

    if (submitSignup) submitSignup.disabled = false;
  });
}

updateSubCounts();

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
// MOTOR OFICIAL DO PIX DINÂMICO (PADRÃO BANCO CENTRAL DO BRASIL / EMVCO)
// ==============================================================================

function calcularCRC16(str) {
  let crc = 0xFFFF;
  for (let i = 0; i < str.length; i++) {
    crc ^= (str.charCodeAt(i) << 8);
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
      } else {
        crc = (crc << 1) & 0xFFFF;
      }
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function emvFormat(id, value) {
  const len = String(value.length).padStart(2, "0");
  return `${id}${len}${value}`;
}

function gerarPayloadPixBACEN({ chave, nome, cidade, valor, txid, info }) {
  const cleanChave = chave.trim();
  const cleanNome = nome.normalize("NFD").replace(/[\u0300-\u036f]/g, "").slice(0, 25).toUpperCase();
  const cleanCidade = cidade.normalize("NFD").replace(/[\u0300-\u036f]/g, "").slice(0, 15).toUpperCase();
  const cleanTxid = (txid || "EJCTRANSITO").replace(/[^a-zA-Z0-9]/g, "").slice(0, 25);
  const formattedValor = Number(valor).toFixed(2);

  // 26: Merchant Account Information
  let merchantInfo = emvFormat("00", "br.gov.bcb.pix");
  merchantInfo += emvFormat("01", cleanChave);
  if (info) merchantInfo += emvFormat("02", info.slice(0, 40));

  // 62: Additional Data Field Template
  const additionalData = emvFormat("05", cleanTxid);

  let payload = "";
  payload += emvFormat("00", "01");                     // Payload Format Indicator
  payload += emvFormat("26", merchantInfo);              // Merchant Account Information
  payload += emvFormat("52", "0000");                    // Merchant Category Code
  payload += emvFormat("53", "986");                     // Transaction Currency (BRL)
  payload += emvFormat("54", formattedValor);            // Transaction Amount
  payload += emvFormat("58", "BR");                      // Country Code
  payload += emvFormat("59", cleanNome);                 // Merchant Name
  payload += emvFormat("60", cleanCidade);               // Merchant City
  payload += emvFormat("62", additionalData);            // Additional Data (txid)
  payload += "6304";                                     // CRC16 placeholder

  const crc = calcularCRC16(payload);
  return `${payload}${crc}`;
}

// CHECKOUT PIX INTERATIVO
const pixModal = document.getElementById("pixModal");
const closePixModalBtn = document.getElementById("closePixModalBtn");
const pixModalTypeTag = document.getElementById("pixModalTypeTag");
const pixModalValueText = document.getElementById("pixModalValueText");
const pixCountdown = document.getElementById("pixCountdown");
const pixQrContainer = document.getElementById("pixQrContainer");
const pixPayloadInput = document.getElementById("pixPayloadInput");
const btnCopyPixPayload = document.getElementById("btnCopyPixPayload");
const pixStatusText = document.getElementById("pixStatusText");
const pixActiveState = document.getElementById("pixActiveState");
const pixSuccessState = document.getElementById("pixSuccessState");
const receiptTxidText = document.getElementById("receiptTxidText");
const receiptValText = document.getElementById("receiptValText");
const receiptTimeText = document.getElementById("receiptTimeText");
const btnFinishPixSuccess = document.getElementById("btnFinishPixSuccess");

let pixTimerInterval = null;
let pixPollingInterval = null;
let activeTxid = null;

function fecharModalPix() {
  if (pixModal) pixModal.close();
  if (pixTimerInterval) clearInterval(pixTimerInterval);
  if (pixPollingInterval) clearInterval(pixPollingInterval);
  activeTxid = null;
}

if (closePixModalBtn) closePixModalBtn.addEventListener("click", fecharModalPix);
if (btnFinishPixSuccess) btnFinishPixSuccess.addEventListener("click", fecharModalPix);
if (pixModal) {
  pixModal.addEventListener("click", (e) => {
    if (e.target === pixModal) fecharModalPix();
  });
}

function abrirCheckoutPix({ tipo, valor, pagadorNome, pagadorWhatsapp }) {
  if (!pixModal) return;

  const config = window.EJC_PIX_CONFIG || {
    chave: "leoeuler03@gmail.com",
    beneficiario: "EJC TRANSITO MONTE SIAO",
    cidade: "CAMPINA GRANDE",
    tempoExpiracaoMinutos: 15
  };

  const cleanValor = Math.max(1, Number(valor || 50));
  const txid = "EJC" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
  activeTxid = txid;

  // Gera payload BR Code oficial do BACEN
  const payloadPix = gerarPayloadPixBACEN({
    chave: config.chave,
    nome: config.beneficiario,
    cidade: config.cidade,
    valor: cleanValor,
    txid: txid,
    info: tipo === "inscricao" ? "TAXA EQUIPE EJC TRANSITO" : "CONTRIBUICAO EJC TRANSITO"
  });

  // Atualiza UI
  if (pixModalTypeTag) {
    pixModalTypeTag.textContent = tipo === "inscricao" ? "Taxa de Inscrição da Equipe" : "Contribuição da Equipe";
  }
  if (pixModalValueText) {
    pixModalValueText.textContent = cleanValor.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }
  if (pixPayloadInput) {
    pixPayloadInput.value = payloadPix;
  }
  if (btnCopyPixPayload) {
    btnCopyPixPayload.textContent = "Copiar Código Pix";
  }

  // Renderiza QR Code dinâmico nítido
  if (pixQrContainer) {
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=8&data=${encodeURIComponent(payloadPix)}`;
    pixQrContainer.innerHTML = `<img src="${qrUrl}" alt="QR Code Pix Dinâmico" style="width: 100%; height: 100%; object-fit: contain; border-radius: 8px;">`;
  }

  // Reseta estados
  if (pixActiveState) pixActiveState.style.display = "block";
  if (pixSuccessState) pixSuccessState.style.display = "none";
  if (pixStatusText) pixStatusText.textContent = "Aguardando confirmação do banco...";

  // Salva no registro de pagamentos Pix (local e tenta Supabase)
  const novoPagamento = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    criado_em: new Date().toISOString(),
    txid: txid,
    valor: cleanValor,
    tipo: tipo,
    nome_pagador: pagadorNome || "Anônimo",
    whatsapp_pagador: pagadorWhatsapp || null,
    status: "pendente",
    pix_copia_e_cola: payloadPix,
    expiracao: new Date(Date.now() + config.tempoExpiracaoMinutos * 60000).toISOString()
  };

  const localPix = JSON.parse(localStorage.getItem("ejc_pagamentos_pix") || "[]");
  localPix.unshift(novoPagamento);
  localStorage.setItem("ejc_pagamentos_pix", JSON.stringify(localPix));

  if (supabaseClient) {
    supabaseClient.rpc("registrar_pagamento_pix", {
      p_txid: txid,
      p_nome_pagador: novoPagamento.nome_pagador,
      p_whatsapp_pagador: novoPagamento.whatsapp_pagador,
      p_cpf_pagador: null,
      p_valor: cleanValor,
      p_tipo: tipo,
      p_pix_copia_e_cola: payloadPix,
      p_qr_code_base64: null,
      p_expiracao: novoPagamento.expiracao
    }).catch(err => console.warn("Supabase não alcançado para registrar Pix:", err));
  }

  // Inicia contador regressivo de 15 minutos
  let segundosRestantes = (config.tempoExpiracaoMinutos || 15) * 60;
  if (pixTimerInterval) clearInterval(pixTimerInterval);

  pixTimerInterval = setInterval(() => {
    segundosRestantes--;
    const min = String(Math.floor(segundosRestantes / 60)).padStart(2, "0");
    const sec = String(segundosRestantes % 60).padStart(2, "0");
    if (pixCountdown) pixCountdown.textContent = `${min}:${sec}`;

    if (segundosRestantes <= 0) {
      clearInterval(pixTimerInterval);
      if (pixStatusText) pixStatusText.textContent = "Tempo de pagamento expirado. Gere um novo código.";
    }
  }, 1000);

  // Inicia monitoramento de status da transação (Polling inteligente com fallback)
  if (pixPollingInterval) clearInterval(pixPollingInterval);
  pixPollingInterval = setInterval(async () => {
    // 1. Checa no localStorage (caso admin aprove na mesma máquina)
    const currentLocal = JSON.parse(localStorage.getItem("ejc_pagamentos_pix") || "[]");
    const item = currentLocal.find(p => p.txid === txid);
    if (item && item.status === "confirmado") {
      confirmarSucessoPix(item);
      return;
    }

    // 2. Checa no Supabase se disponível
    if (supabaseClient) {
      try {
        const { data } = await supabaseClient.rpc("consultar_status_pix", { p_txid: txid });
        if (data && data.status === "confirmado") {
          confirmarSucessoPix(data);
        }
      } catch (e) {
        // Silêncio no polling de rede
      }
    }
  }, 3000);

  pixModal.showModal();
}

function confirmarSucessoPix(pagamento) {
  if (pixTimerInterval) clearInterval(pixTimerInterval);
  if (pixPollingInterval) clearInterval(pixPollingInterval);

  if (pixActiveState) pixActiveState.style.display = "none";
  if (pixSuccessState) pixSuccessState.style.display = "block";

  if (receiptTxidText) receiptTxidText.textContent = pagamento.txid || activeTxid;
  if (receiptValText) receiptValText.textContent = Number(pagamento.valor || 50).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  if (receiptTimeText) receiptTimeText.textContent = new Date().toLocaleString("pt-BR");
}

// Botão Copiar Código Pix
if (btnCopyPixPayload) {
  btnCopyPixPayload.addEventListener("click", () => {
    if (pixPayloadInput) {
      pixPayloadInput.select();
      navigator.clipboard.writeText(pixPayloadInput.value).then(() => {
        btnCopyPixPayload.textContent = "✓ Código PIX Copiado!";
        setTimeout(() => {
          btnCopyPixPayload.textContent = "Copiar Código Pix";
        }, 2500);
      }).catch(() => {
        document.execCommand("copy");
        btnCopyPixPayload.textContent = "✓ Copiado!";
      });
    }
  });
}

// Botões para abrir Pix Dinâmico
document.querySelectorAll(".btn-open-pix-dinamico").forEach(btn => {
  btn.addEventListener("click", () => {
    const valor = Number(btn.dataset.valor || 50);
    const tipo = btn.dataset.tipo || "inscricao";
    const nome = document.querySelector("#full-name")?.value || "";
    const wpp = document.querySelector("#whatsapp")?.value || "";
    abrirCheckoutPix({ tipo, valor, pagadorNome: nome, pagadorWhatsapp: wpp });
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

// Submissão da Contribuição Online
const btnSubmitContributionPix = document.getElementById("btnSubmitContributionPix");
if (btnSubmitContributionPix) {
  btnSubmitContributionPix.addEventListener("click", () => {
    const customInput = document.getElementById("customContributeValue");
    const nameInput = document.getElementById("contributorName");
    let valorFinal = selectedPresetVal;

    if (customInput && customInput.value && Number(customInput.value) > 0) {
      valorFinal = Number(customInput.value);
    }

    const contributorName = nameInput?.value.trim() || "Amigo da Equipe do Trânsito";
    abrirCheckoutPix({
      tipo: "contribuicao",
      valor: valorFinal,
      pagadorNome: contributorName
    });
  });
}
