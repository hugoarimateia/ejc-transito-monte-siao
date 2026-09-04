// ==============================================================================
// VERCEL SERVERLESS FUNCTION: /api/pix-webhook
// Recepção assíncrona de webhooks do Gateway Pix com validação de segurança
// ==============================================================================

module.exports = async (req, res) => {
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

    // Identifica o txid conforme o gateway
    // Ex.: Mercado Pago (payload.data.id), Efí Pay (payload.pix[0].txid), Asaas (payload.payment.id)
    const txid = payload.txid || payload.data?.id || payload.pix?.[0]?.txid || payload.id;

    if (!txid) {
      return res.status(400).json({ error: "Identificador da transação ausente no payload" });
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (supabaseUrl && supabaseServiceKey) {
      let confirmed = false;
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
          confirmed = true;
        } else {
          // Fallback para RPC legado caso migração ainda não tenha rodado
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

      // Se confirmado, busca dados do pagamento para disparar comprovante por e-mail
      try {
        const payRes = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/pagamentos?txid=eq.${encodeURIComponent(txid)}&select=txid,nome_pagador,email,valor,metodo`, {
          headers: { "apikey": supabaseServiceKey, "Authorization": `Bearer ${supabaseServiceKey}` }
        });
        if (payRes.ok) {
          const payData = await payRes.json();
          if (payData && payData.length > 0 && payData[0].email) {
            const p = payData[0];
            const baseUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000";
            fetch(`${baseUrl}/api/email-comprovante`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                txid: p.txid,
                nome: p.nome_pagador,
                email: p.email,
                valor: p.valor,
                metodo: p.metodo,
                executado_por: "webhook_automatico"
              })
            }).catch(() => {});
          }
        }
      } catch (emailTriggerErr) {
        console.warn("[Webhook Email Trigger]", emailTriggerErr.message);
      }
    }

    console.log(`[Webhook] Transação ${txid} processada com sucesso`);
    return res.status(200).json({ success: true, processedTxid: txid });
  } catch (err) {
    console.error("[Webhook Exception]", err);
    return res.status(500).json({ error: "Falha interna no processamento do webhook" });
  }
};
