// ==============================================================================
// VERCEL SERVERLESS FUNCTION: /api/pix-webhook
// Recepção assíncrona de webhooks de Gateways de Pagamento (Pix / PSPs)
// Confirmação resiliente, conciliação unificada e envio de comprovante com await
// ==============================================================================

const settingsStore = require("./_settings-store");
const { sendPaymentReceiptEmail } = require("./email-comprovante");
const { confirmarPagamentoResiliente } = require("./checkout-process");
const mercadoPago = require("./_mercadopago");

// Lista de tokens de status indicando aprovação/liquidação efetiva
const APPROVED_STATUS_TOKENS = new Set([
  "approved",
  "paid",
  "confirmed",
  "completed",
  "payment_received",
  "pix_received",
  "pix.received",
  "concluida",
  "concluido",
  "liquidado",
  "settled",
  "pago",
  "received"
]);

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-webhook-secret, x-signature");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método não permitido" });
  }

  try {
    const payload = req.body || {};
    const webhookSecret = process.env.PIX_WEBHOOK_SECRET;

    // Se configurado segredo de webhook, valida token recebido no header ou query
    if (webhookSecret) {
      const headerSecret = req.headers["x-webhook-secret"] || req.headers["x-signature"] || req.query.secret;
      if (headerSecret !== webhookSecret) {
        console.warn("[Webhook Security] Tentativa de webhook com assinatura inválida");
        return res.status(401).json({ error: "Assinatura de webhook não autorizada" });
      }
    }

    // 1. Identificação robusta do identificador da transação (Mercado Pago, Efí Pay, Asaas, PagBank, etc.)
    let txid = payload.txid ||
      payload.external_reference ||
      payload.externalReference ||
      payload.data?.external_reference ||
      payload.data?.externalReference ||
      payload.payment?.externalReference ||
      payload.payment?.external_reference ||
      payload.order_id ||
      payload.orderId ||
      payload.data?.order_id ||
      payload.pix?.[0]?.txid ||
      payload.data?.id ||
      payload.id ||
      payload.payment?.id;

    // 2. Tratamento Especial Mercado Pago (Busca ativa de detalhes se Access Token estiver disponível)
    const isMercadoPagoEvent = (payload.type === "payment" || (payload.action && String(payload.action).startsWith("payment"))) && (payload.data?.id || payload.id);
    const mpPaymentId = isMercadoPagoEvent ? (payload.data?.id || payload.id) : null;
    let mpPayloadFetched = null;

    if (mpPaymentId && mercadoPago.isConfigured()) {
      try {
        mpPayloadFetched = await mercadoPago.consultarPagamentoPorId(mpPaymentId);
        if (mpPayloadFetched?.external_reference) {
          txid = mpPayloadFetched.external_reference;
        }
      } catch (eMp) {
        console.warn("[Webhook MP Fetch Warning]", eMp.message);
      }
    }

    if (!txid) {
      return res.status(400).json({ error: "Identificador da transação ausente no payload" });
    }

    // 3. Avaliação de status enviada pelo gateway ou obtida na consulta ativa
    const rawStatus = String(
      mpPayloadFetched?.status ||
      payload.status ||
      payload.payment?.status ||
      payload.event ||
      payload.action ||
      payload.data?.status ||
      payload.pix?.[0]?.status ||
      ""
    ).toLowerCase();

    // Se o evento não representar liquidação (ex.: criação pendente), apenas confirma recebimento
    const isApprovedStatus = APPROVED_STATUS_TOKENS.has(rawStatus) ||
      rawStatus.includes("approved") ||
      rawStatus.includes("liquidado") ||
      rawStatus.includes("paid") ||
      rawStatus.includes("received") ||
      rawStatus.includes("concluid") ||
      !rawStatus; // Se gateway não enviou campo de status explícito, trata como notificação de crédito

    if (!isApprovedStatus) {
      console.log(`[Webhook] Notificação recebida para txid ${txid} com status intermediário: "${rawStatus}". Sem alteração de aprovação.`);
      return res.status(200).json({ success: true, processedTxid: txid, status: rawStatus, confirmed: false });
    }

    // 4. Executa conciliação unificada resiliente (RPC Supabase + Store Local + Comprovante com Await)
    const result = await confirmarPagamentoResiliente({
      txid: String(txid),
      gateway: mpPayloadFetched ? "mercadopago_webhook" : "pix_webhook",
      payload: mpPayloadFetched || payload,
      executado_por: "gateway_webhook"
    });

    console.log(`[Webhook] Transação ${txid} processada com sucesso. Database: ${result.confirmedOnDatabase}, Email: ${result.emailEnviado}`);
    return res.status(200).json({
      success: true,
      processedTxid: txid,
      confirmed: true,
      payment_id: result.payment_id || null,
      order_id: result.order_id || null,
      database_updated: result.confirmedOnDatabase,
      email_dispatched: result.emailEnviado
    });
  } catch (err) {
    console.error("[Webhook Exception]", err);
    return res.status(500).json({ error: "Falha interna no processamento do webhook" });
  }
};
