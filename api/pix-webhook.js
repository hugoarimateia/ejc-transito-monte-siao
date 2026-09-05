// ==============================================================================
// VERCEL SERVERLESS FUNCTION: /api/pix-webhook
// Recepção assíncrona de webhooks de Gateways de Pagamento (Pix / PSPs)
// Confirmação resiliente, conciliação unificada e envio de comprovante com await
// ==============================================================================

const settingsStore = require("./_settings-store");
const { sendPaymentReceiptEmail } = require("./email-comprovante");

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

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    let confirmedOnDatabase = false;
    let paymentRecord = null;

    if (supabaseUrl && supabaseServiceKey) {
      // 1. Confirma transação e concilia inscrição atomicamente via RPC
      try {
        const dbResponse = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/rpc/confirmar_pagamento_unificado`, {
          method: "POST",
          headers: {
            "apikey": supabaseServiceKey,
            "Authorization": `Bearer ${supabaseServiceKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            p_txid: String(txid),
            p_gateway: "pix_webhook",
            p_executado_por: "gateway_webhook",
            p_payload: payload
          })
        });

        if (dbResponse.ok) {
          confirmedOnDatabase = true;
        } else {
          // Fallback RPC legado caso migração ainda não tenha rodado
          await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/rpc/confirmar_pagamento_pix`, {
            method: "POST",
            headers: {
              "apikey": supabaseServiceKey,
              "Authorization": `Bearer ${supabaseServiceKey}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              p_txid: String(txid),
              p_gateway: "vercel_webhook",
              p_payload: payload
            })
          });
        }
      } catch (dbErr) {
        console.error("[Webhook DB Error]", dbErr.message);
      }

      // 2. Busca registro canônico da transação no Supabase para envio do e-mail
      try {
        const payRes = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/pagamentos?txid=eq.${encodeURIComponent(txid)}&limit=1`, {
          headers: { "apikey": supabaseServiceKey, "Authorization": `Bearer ${supabaseServiceKey}` }
        });
        if (payRes.ok) {
          const payData = await payRes.json();
          if (payData && payData.length > 0) {
            paymentRecord = payData[0];
          }
        }
      } catch (fetchErr) {
        console.warn("[Webhook Fetch Transaction Error]", fetchErr.message);
      }
    }

    // 3. Atualiza store local / servidor para que o polling imediato do checkout.html detecte a confirmação
    try {
      const localStore = settingsStore.loadLocalStore();
      if (!Array.isArray(localStore.pagamentos)) localStore.pagamentos = [];
      const idx = localStore.pagamentos.findIndex(p => p.txid === String(txid));
      const agora = new Date().toISOString();
      if (idx !== -1) {
        localStore.pagamentos[idx].status = "approved";
        localStore.pagamentos[idx].pago_em = agora;
        if (!paymentRecord) paymentRecord = localStore.pagamentos[idx];
      } else {
        localStore.pagamentos.unshift({
          txid: String(txid),
          status: "approved",
          pago_em: agora,
          metodo: "pix",
          criado_em: agora
        });
      }
      settingsStore.saveLocalStore(localStore);
    } catch (localErr) {
      console.warn("[Webhook Local Store Error]", localErr.message);
    }

    // 4. Disparo do comprovante por e-mail COM AWAIT estrito antes de finalizar a requisição
    let emailStatus = { success: false, provedor: "não_iniciado" };
    if (paymentRecord && paymentRecord.email) {
      try {
        emailStatus = await sendPaymentReceiptEmail({
          txid: paymentRecord.txid || txid,
          nome: paymentRecord.nome_pagador || "Participante",
          email: paymentRecord.email,
          valor: paymentRecord.valor || 50,
          metodo: paymentRecord.metodo || "pix",
          sub: paymentRecord.metadata?.sub || paymentRecord.sub,
          executado_por: "webhook_automatico"
        });
      } catch (emailErr) {
        console.warn("[Webhook Email Trigger Error]", emailErr.message);
      }
    } else {
      console.log(`[Webhook] Nenhum e-mail associado localizado para txid ${txid}.`);
    }

    console.log(`[Webhook] Transação ${txid} processada com sucesso. Database: ${confirmedOnDatabase}, Email: ${emailStatus.success}`);
    return res.status(200).json({
      success: true,
      processedTxid: txid,
      confirmed: true,
      database_updated: confirmedOnDatabase,
      email_dispatched: emailStatus.success
    });
  } catch (err) {
    console.error("[Webhook Exception]", err);
    return res.status(500).json({ error: "Falha interna no processamento do webhook" });
  }
};
