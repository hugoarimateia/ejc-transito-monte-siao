// ==============================================================================
// VERCEL SERVERLESS FUNCTION: /api/pix-webhook
// Recepção assíncrona de webhooks de Gateways de Pagamento (Pix / PSPs)
// Confirmação resiliente, conciliação unificada e envio de comprovante com await
// ==============================================================================

const crypto = require("crypto");
const settingsStore = require("./_settings-store");
const { sendPaymentReceiptEmail } = require("./email-comprovante");
const { confirmarPagamentoResiliente } = require("./checkout-process");
const mercadoPago = require("./_mercadopago");

// Comparação em tempo constante do segredo do webhook
function segredoValido(recebido, esperado) {
  if (!recebido || !esperado) return false;
  const h = (v) => crypto.createHash("sha256").update(String(v)).digest();
  return crypto.timingSafeEqual(h(recebido), h(esperado));
}

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

    // O segredo é OBRIGATÓRIO: sem ele qualquer pessoa poderia simular confirmações de pagamento.
    if (!webhookSecret) {
      console.error("[Webhook Security] PIX_WEBHOOK_SECRET não configurado. Webhook recusado.");
      return res.status(503).json({ error: "Webhook não configurado no servidor." });
    }

    // Aceita o segredo por header ou por ?secret= (necessário para gateways como Mercado Pago)
    const bearer = String(req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
    const candidatos = [req.headers["x-webhook-secret"], req.headers["x-signature"], bearer, req.query?.secret];
    const autorizado = candidatos.map((c) => segredoValido(c, webhookSecret)).some(Boolean);
    if (!autorizado) {
      console.warn("[Webhook Security] Tentativa de webhook com assinatura inválida");
      return res.status(401).json({ error: "Assinatura de webhook não autorizada" });
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
      payload.payment?.id ||
      req.query?.["data.id"] ||
      req.query?.id;

    // 2. Tratamento Especial Mercado Pago (Busca ativa de detalhes se Access Token estiver disponível)
    const isMercadoPagoEvent = (
      payload.type === "payment" ||
      (payload.action && String(payload.action).startsWith("payment")) ||
      req.query?.type === "payment" ||
      req.query?.topic === "payment"
    ) && (payload.data?.id || payload.id || req.query?.["data.id"] || req.query?.id);
    const mpPaymentId = isMercadoPagoEvent ? (payload.data?.id || payload.id || req.query?.["data.id"] || req.query?.id) : null;
    let mpPayloadFetched = null;

    if (mpPaymentId && mercadoPago.isConfigured()) {
      try {
        console.log(`[Webhook MP] Consultando status real do pagamento ${mpPaymentId} no Mercado Pago...`);
        mpPayloadFetched = await mercadoPago.getPayment(mpPaymentId);
        if (mpPayloadFetched) {
          if (mpPayloadFetched.external_reference) {
            txid = mpPayloadFetched.external_reference;
          }
        }
      } catch (mpErr) {
        console.warn(`[Webhook MP] Falha ao consultar detalhes do pagamento ${mpPaymentId}:`, mpErr.message);
      }
    }

    if (isMercadoPagoEvent && mercadoPago.isConfigured() && !mpPayloadFetched) {
      // Não foi possível confirmar o pagamento junto ao Mercado Pago: não aprovar com base no corpo recebido externamente.
      // Responder 502 faz o gateway tentar novamente mais tarde.
      return res.status(502).json({ error: "Não foi possível validar o pagamento no gateway. Tente novamente." });
    }

    if (!txid) {
      return res.status(400).json({ error: "Identificador da transação ausente no payload" });
    }

    // 3. Normalização do status de pagamento
    const effectivePayload = mpPayloadFetched || payload;
    const rawStatus = (
      effectivePayload.status ||
      effectivePayload.payment?.status ||
      effectivePayload.data?.status ||
      effectivePayload.pix?.[0]?.status ||
      effectivePayload.action ||
      ""
    ).toLowerCase().trim();

    console.log(`[Webhook] Recebido evento para TXID/Ref: ${txid} | Status detectado: ${rawStatus}`);

    const isApproved = APPROVED_STATUS_TOKENS.has(rawStatus) ||
      rawStatus.includes("approved") ||
      rawStatus.includes("confirmado") ||
      rawStatus.includes("paid") ||
      rawStatus.includes("liquidado");

    if (isApproved) {
      console.log(`[Webhook] Liquidação confirmada para ${txid}. Acionando confirmação resiliente...`);

      const confirmResult = await confirmarPagamentoResiliente({
        txid: String(txid),
        gateway: isMercadoPagoEvent ? "mercadopago" : "pix_webhook",
        payload: effectivePayload
      });

      // Dispara envio do comprovante por e-mail com await estrito para garantir execução em ambiente serverless
      try {
        const emailParams = {
          txid: String(txid),
          nome: confirmResult.record?.nome_pagador || effectivePayload.payer?.first_name || effectivePayload.nome,
          email: confirmResult.record?.email || effectivePayload.payer?.email || effectivePayload.email,
          valor: confirmResult.record?.valor || effectivePayload.transaction_amount || effectivePayload.valor,
          metodo: confirmResult.record?.metodo || "pix",
          sub: confirmResult.record?.metadata?.sub || confirmResult.record?.sub || "Geral",
          order_id: confirmResult.record?.order_id,
          payment_id: confirmResult.record?.payment_id || mpPaymentId,
          executado_por: "webhook"
        };

        if (emailParams.email) {
          console.log(`[Webhook] Enviando comprovante de pagamento para ${emailParams.email}...`);
          const emailRes = await sendPaymentReceiptEmail(emailParams);
          console.log(`[Webhook] Resultado do envio de comprovante: ${emailRes?.success ? "Sucesso" : "Falha/Ignorado"}`);
        } else {
          console.log(`[Webhook] Pagamento ${txid} confirmado, mas sem e-mail do pagador associado para envio imediato.`);
        }
      } catch (emailErr) {
        console.error(`[Webhook] Erro no fluxo de envio de e-mail para ${txid}:`, emailErr);
      }

      return res.status(200).json({
        success: true,
        message: "Pagamento processado e confirmado com sucesso",
        txid: txid,
        status: "aprovado"
      });
    }

    // Se o webhook não for de aprovação (ex: rejected, in_process, pending, cancelled, refunded):
    // Não deixa o banco desatualizado! Atualiza status real e payload no Supabase e no localStore!
    if (txid) {
      console.log(`[Webhook] Evento não-liquidado ('${rawStatus}') para ${txid}. Atualizando registro no banco...`);
      try {
        const { url: sbUrl, key: sbKey } = (typeof settingsStore.getSupabaseCredentials === "function")
          ? settingsStore.getSupabaseCredentials()
          : { url: process.env.NEXT_PUBLIC_SUPABASE_URL || "https://guppedddwnuvluhiaaas.supabase.co", key: process.env.SUPABASE_SERVICE_ROLE_KEY || "sb_publishable_QJV9XI3sN3P_gVtiQ2ObRg_gpSSKc-i" };

        if (sbUrl && sbKey) {
          await fetch(`${sbUrl}/rest/v1/pagamentos?txid=eq.${encodeURIComponent(String(txid))}`, {
            method: "PATCH",
            headers: {
              "apikey": sbKey,
              "Authorization": `Bearer ${sbKey}`,
              "Content-Type": "application/json",
              "Prefer": "return=minimal"
            },
            body: JSON.stringify({
              status: rawStatus,
              gateway_transaction_id: String(mpPaymentId || txid),
              payload_webhook: effectivePayload,
              atualizado_em: new Date().toISOString()
            }),
            signal: AbortSignal.timeout(4000)
          });
        }
      } catch (ePatch) {
        console.warn("[Webhook] Aviso ao atualizar status não-aprovado no Supabase:", ePatch.message);
      }
    }

    return res.status(200).json({
      success: true,
      message: `Webhook recebido para status '${rawStatus}', sem ação de liquidação necessária`,
      txid: txid
    });

  } catch (err) {
    console.error("[Webhook Error] Falha interna ao processar requisição:", err);
    return res.status(500).json({ error: "Erro interno ao processar webhook" });
  }
};
