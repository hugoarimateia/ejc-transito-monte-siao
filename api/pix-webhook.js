// ==============================================================================
// VERCEL SERVERLESS FUNCTION: /api/pix-webhook
// Recepção assíncrona de webhooks de Gateways de Pagamento (Pix / PSPs)
// Confirmação resiliente, conciliação unificada e envio de comprovante com await
// ==============================================================================

const settingsStore = require("./_settings-store");
const { sendPaymentReceiptEmail } = require("./email-comprovante");
const { confirmarPagamentoResiliente } = require("./checkout-process");

// Lista de tokens de status indicando aprovação/liquidação efetiva
const APPROVED_STATUS_TOKENS = new Set([
  "approved",
  "paid",
  "confirmed",
  "completed",
  "payment_received",
  "concluida",
  "liquidado",
  "settled",
  "pago"
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

    // Identifica o identificador da transação conforme os padrões de mercado
    // (Mercado Pago, Efí Pay, Asaas, PagBank, Pagar.me, etc.)
    const txid = payload.txid ||
      payload.external_reference ||
      payload.data?.external_reference ||
      payload.data?.id ||
      payload.pix?.[0]?.txid ||
      payload.id ||
      payload.payment?.id;

    if (!txid) {
      return res.status(400).json({ error: "Identificador da transação ausente no payload" });
    }

    // Avaliação de status enviada pelo gateway
    const rawStatus = String(
      payload.status ||
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
      rawStatus.includes("concluid") ||
      !rawStatus; // Se gateway não enviou campo de status explícito, trata como notificação de crédito

    if (!isApprovedStatus) {
      console.log(`[Webhook] Notificação recebida para txid ${txid} com status intermediário: "${rawStatus}". Sem alteração de aprovação.`);
      return res.status(200).json({ success: true, processedTxid: txid, status: rawStatus, confirmed: false });
    }

    // Executa conciliação unificada resiliente (RPC Supabase + Store Local + Comprovante com Await)
    const result = await confirmarPagamentoResiliente({
      txid: String(txid),
      gateway: "pix_webhook",
      payload: payload,
      executado_por: "gateway_webhook"
    });

    console.log(`[Webhook] Transação ${txid} processada com sucesso. Database: ${result.confirmedOnDatabase}, Email: ${result.emailEnviado}`);
    return res.status(200).json({
      success: true,
      processedTxid: txid,
      confirmed: true,
      database_updated: result.confirmedOnDatabase,
      email_dispatched: result.emailEnviado
    });
  } catch (err) {
    console.error("[Webhook Exception]", err);
    return res.status(500).json({ error: "Falha interna no processamento do webhook" });
  }
};
