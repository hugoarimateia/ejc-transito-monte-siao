// ==============================================================================
// MÓDULO CANÔNICO MERCADO PAGO: api/_mercadopago.js
// Cliente centralizado server-side para API oficial do Mercado Pago (Pix Dinâmico)
// Consome a variável oficial configurada na Vercel: MERCADOPAGO_ACCESS_TOKEN
// ==============================================================================

const MP_API_BASE = "https://api.mercadopago.com/v1";

/**
 * Obtém o Access Token privado do Mercado Pago configurado na Vercel.
 * Prioriza MERCADOPAGO_ACCESS_TOKEN (oficial) com fallback para GATEWAY_PIX_API_KEY.
 * NUNCA é exposto ao cliente/frontend.
 */
function getAccessToken() {
  return (
    process.env.MERCADOPAGO_ACCESS_TOKEN ||
    process.env.GATEWAY_PIX_API_KEY ||
    ""
  ).trim();
}

/**
 * Retorna se o Access Token do Mercado Pago está configurado no ambiente.
 */
function isConfigured() {
  const token = getAccessToken();
  return Boolean(token && token.length > 10 && !token.includes("seu_token"));
}

/**
 * Cria uma cobrança Pix dinâmica oficial na API do Mercado Pago.
 * Extrai o QR Code em texto (Copia e Cola) e a imagem em Base64 nativos do Mercado Pago.
 *
 * @param {Object} params
 * @param {number} params.valor - Valor em reais (ex: 50.00)
 * @param {string} params.nome - Nome do pagador
 * @param {string} params.email - E-mail do pagador (obrigatório pelo MP)
 * @param {string} [params.cpf] - CPF do pagador (opcional)
 * @param {string} params.txid - Identificador único da transação (external_reference)
 * @param {string} [params.descricao] - Descrição da cobrança
 * @param {string} [params.notificationUrl] - URL do webhook oficial
 * @returns {Promise<Object>} Dados do pagamento criado
 */
async function criarPagamentoPix({
  valor,
  nome,
  email,
  cpf,
  txid,
  descricao = "Inscrição EJC Trânsito Monte Sião",
  notificationUrl
}) {
  const token = getAccessToken();
  if (!token) {
    console.warn("[MercadoPago] Tentativa de criar pagamento Pix sem token configurado.");
    return null;
  }

  const nomePartes = String(nome || "Participante EJC").trim().split(/\s+/);
  const firstName = nomePartes[0] || "Participante";
  const lastName = nomePartes.slice(1).join(" ") || "EJC";

  const payerObj = {
    email: String(email).trim().toLowerCase(),
    first_name: firstName,
    last_name: lastName
  };

  const cleanCpf = cpf ? String(cpf).replace(/\D/g, "") : "";
  if (cleanCpf && cleanCpf.length === 11) {
    payerObj.identification = {
      type: "CPF",
      number: cleanCpf
    };
  }

  const bodyPayload = {
    transaction_amount: Number(valor),
    description: String(descricao).substring(0, 60),
    payment_method_id: "pix",
    payer: payerObj,
    external_reference: String(txid)
  };

  if (notificationUrl) {
    bodyPayload.notification_url = notificationUrl;
  }

  const response = await fetch(`${MP_API_BASE}/payments`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Idempotency-Key": `PIX-${txid}`
    },
    body: JSON.stringify(bodyPayload),
    signal: AbortSignal.timeout(12000)
  });

  const responseData = await response.json();

  if (!response.ok) {
    const errorMsg =
      responseData?.message ||
      responseData?.error ||
      `Erro na API Mercado Pago (HTTP ${response.status})`;
    let detailMsg = "";
    if (Array.isArray(responseData?.cause)) {
      detailMsg = responseData.cause.map(c => c.description || c.code || JSON.stringify(c)).join("; ");
    } else if (responseData?.cause) {
      detailMsg = typeof responseData.cause === "string" ? responseData.cause : JSON.stringify(responseData.cause);
    }
    throw new Error(`${errorMsg}${detailMsg ? ` - ${detailMsg}` : ""}`);
  }

  const pointOfInteraction = responseData.point_of_interaction || {};
  const transactionData = pointOfInteraction.transaction_data || {};

  const qrCode = transactionData.qr_code;
  const qrCodeBase64 = transactionData.qr_code_base64;

  if (!qrCode) {
    throw new Error("Mercado Pago não retornou point_of_interaction.transaction_data.qr_code");
  }

  return {
    success: true,
    id: String(responseData.id),
    status: responseData.status || "pending",
    status_detail: responseData.status_detail || "pending_waiting_transfer",
    external_reference: responseData.external_reference || txid,
    qr_code: qrCode,
    qr_code_base64: qrCodeBase64 || null,
    ticket_url: transactionData.ticket_url || null,
    date_of_expiration: responseData.date_of_expiration || null,
    raw: responseData
  };
}

/**
 * Consulta os detalhes de um pagamento por ID no Mercado Pago.
 *
 * @param {string|number} paymentId - ID numérico gerado pelo Mercado Pago
 * @returns {Promise<Object|null>}
 */
async function consultarPagamentoPorId(paymentId) {
  const token = getAccessToken();
  if (!token || !paymentId) return null;

  try {
    const response = await fetch(`${MP_API_BASE}/payments/${encodeURIComponent(paymentId)}`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) return null;
    return await response.json();
  } catch (err) {
    console.warn("[MercadoPago consultarPagamentoPorId] Erro ao consultar:", err.message);
    return null;
  }
}

/**
 * Busca pagamento no Mercado Pago usando a referência externa (nosso txid).
 *
 * @param {string} externalReference - Nosso txid (ex: PIXMTNZOAI7F4MN)
 * @returns {Promise<Object|null>} Primeiro pagamento correspondente aprovado ou pendente
 */
async function consultarPagamentoPorExternalReference(externalReference) {
  const token = getAccessToken();
  if (!token || !externalReference) return null;

  try {
    const url = `${MP_API_BASE}/payments/search?external_reference=${encodeURIComponent(externalReference)}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) return null;
    const data = await response.json();

    if (Array.isArray(data.results) && data.results.length > 0) {
      // Prioriza se houver algum pagamento aprovado
      const approved = data.results.find(p => p.status === "approved");
      return approved || data.results[0];
    }
    return null;
  } catch (err) {
    console.warn("[MercadoPago search] Erro ao consultar por external_reference:", err.message);
    return null;
  }
}

/**
 * Cria uma cobrança por Cartão de Crédito na API oficial do Mercado Pago.
 * Suporta tokenização segura via Card Payment Brick (MercadoPago.js v2).
 *
 * @param {Object} params
 * @param {string} params.token - Token seguro gerado pelo Card Payment Brick
 * @param {number} params.transaction_amount - Valor total da cobrança
 * @param {number} params.installments - Quantidade de parcelas
 * @param {string} params.payment_method_id - ID da bandeira (ex: "visa", "master")
 * @param {string|number} [params.issuer_id] - ID do banco emissor
 * @param {Object} params.payer - Dados do pagador (email, identification, etc.)
 * @param {string} params.txid - Nosso identificador (external_reference)
 * @param {string} [params.description] - Descrição da cobrança
 * @param {string} [params.notification_url] - URL de notificação / Webhook
 * @returns {Promise<Object>} Resultado oficial retornado pelo Mercado Pago
 */
async function criarPagamentoCartao({
  token,
  transaction_amount,
  installments,
  payment_method_id,
  issuer_id,
  payer,
  txid,
  description = "Inscrição EJC Trânsito Monte Sião",
  notification_url
}) {
  const mpAccessToken = getAccessToken();
  if (!mpAccessToken) {
    throw new Error("Mercado Pago não está configurado no servidor (MERCADOPAGO_ACCESS_TOKEN ausente).");
  }

  const payload = {
    token: String(token).trim(),
    transaction_amount: Number(Number(transaction_amount).toFixed(2)),
    installments: Math.max(1, parseInt(installments, 10) || 1),
    payment_method_id: String(payment_method_id || "").toLowerCase(),
    description: String(description).substring(0, 60),
    external_reference: String(txid),
    payer: {
      email: String(payer?.email || "").trim().toLowerCase()
    }
  };

  if (issuer_id) {
    payload.issuer_id = String(issuer_id);
  }

  if (payer?.identification?.number) {
    payload.payer.identification = {
      type: payer.identification.type || "CPF",
      number: String(payer.identification.number).replace(/\D/g, "")
    };
  }

  if (payer?.first_name) {
    payload.payer.first_name = String(payer.first_name).trim();
  }
  if (payer?.last_name) {
    payload.payer.last_name = String(payer.last_name).trim();
  }

  if (notification_url) {
    payload.notification_url = notification_url;
  }

  const response = await fetch(`${MP_API_BASE}/payments`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${mpAccessToken}`,
      "Content-Type": "application/json",
      "X-Idempotency-Key": `CARD-${txid}`
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000)
  });

  const responseData = await response.json();

  if (!response.ok) {
    const errorMsg =
      responseData?.message ||
      responseData?.error ||
      `Erro ao processar pagamento com cartão no Mercado Pago (HTTP ${response.status})`;
    let detailMsg = "";
    if (Array.isArray(responseData?.cause)) {
      detailMsg = responseData.cause.map(c => c.description || c.code || JSON.stringify(c)).join("; ");
    } else if (responseData?.cause) {
      detailMsg = typeof responseData.cause === "string" ? responseData.cause : JSON.stringify(responseData.cause);
    }
    const err = new Error(`${errorMsg}${detailMsg ? ` - ${detailMsg}` : ""}`);
    err.status = response.status;
    err.mpData = responseData;
    throw err;
  }

  return {
    success: true,
    id: String(responseData.id),
    status: responseData.status || "pending",
    status_detail: responseData.status_detail || "",
    transaction_amount: responseData.transaction_amount,
    installments: responseData.installments,
    payment_method_id: responseData.payment_method_id,
    payment_type_id: responseData.payment_type_id,
    card: {
      first_six_digits: responseData.card?.first_six_digits || null,
      last_four_digits: responseData.card?.last_four_digits || null
    },
    external_reference: responseData.external_reference || txid,
    raw: responseData
  };
}

function getPublicKey() {
  return (
    process.env.NEXT_PUBLIC_MERCADO_PAGO_PUBLIC_KEY ||
    process.env.MERCADOPAGO_PUBLIC_KEY ||
    process.env.MP_PUBLIC_KEY ||
    ""
  ).trim();
}

module.exports = {
  getAccessToken,
  getPublicKey,
  isConfigured,
  criarPagamentoPix,
  criarPagamentoCartao,
  consultarPagamentoPorId,
  getPayment: consultarPagamentoPorId,
  consultarPagamentoPorExternalReference
};
