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
    signal: AbortSignal.timeout(8000)
  });

  const responseData = await response.json();

  if (!response.ok) {
    const errorMsg =
      responseData?.message ||
      responseData?.error ||
      `Erro na API Mercado Pago (HTTP ${response.status})`;
    const detailMsg = responseData?.cause?.[0]?.description || "";
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

module.exports = {
  getAccessToken,
  isConfigured,
  criarPagamentoPix,
  consultarPagamentoPorId,
  consultarPagamentoPorExternalReference
};
