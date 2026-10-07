// ==============================================================================
// SUPABASE EDGE FUNCTION: pix-webhook
// Recepção assíncrona oficial de webhooks do Mercado Pago / Pix
// Validação obrigatória via assinatura oficial x-signature e x-request-id (HMAC-SHA256)
// Consulta server-side obrigatória ao gateway (Zero trust no payload recebido)
// Confirmação canônica via RPC 'confirmar_pagamento_unificado' e e-mail via send-email
// ==============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ------------------------------------------------------------------------------
// 1. TOKENS DE STATUS CANÔNICOS DE LIQUIDAÇÃO
// ------------------------------------------------------------------------------
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

const MP_API_BASE = "https://api.mercadopago.com/v1";

function getMpAccessToken(): string {
  return (
    Deno.env.get("MERCADOPAGO_ACCESS_TOKEN") ||
    Deno.env.get("GATEWAY_PIX_API_KEY") ||
    ""
  ).trim();
}

function isMpConfigured(): boolean {
  const token = getMpAccessToken();
  return Boolean(token && token.length > 10 && !token.includes("seu_token"));
}

function getSupabaseAdmin() {
  const url = Deno.env.get("SUPABASE_URL") || "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  return createClient(url, key);
}

// ------------------------------------------------------------------------------
// 2. VALIDAÇÃO DA ASSINATURA OFICIAL MERCADO PAGO (HMAC-SHA256)
// ------------------------------------------------------------------------------
// Documentação Oficial Mercado Pago:
// Header x-signature: "ts=...,v1=..."
// Header x-request-id: "<unique-request-id>"
// Manifest: "id:[data.id];request-id:[x-request-id];ts:[ts];"
// Algoritmo: HMAC-SHA256(manifest, secret_key)
// ------------------------------------------------------------------------------
async function verifyMercadoPagoSignature(params: {
  xSignatureHeader: string | null;
  xRequestIdHeader: string | null;
  dataId: string | null;
  secretKey: string;
  maxAgeSeconds?: number;
}): Promise<{ valid: boolean; reason?: string }> {
  const { xSignatureHeader, xRequestIdHeader, dataId, secretKey, maxAgeSeconds = 300 } = params;

  if (!xSignatureHeader) {
    return { valid: false, reason: "Header x-signature ausente" };
  }
  if (!xRequestIdHeader) {
    return { valid: false, reason: "Header x-request-id ausente" };
  }
  if (!dataId) {
    return { valid: false, reason: "Identificador do evento (data.id / id) ausente para validação" };
  }

  // Parse do header x-signature: formato ts=123456789,v1=abcdef...
  const parts = xSignatureHeader.split(",").map(p => p.trim());
  let ts: string | null = null;
  let v1: string | null = null;

  for (const part of parts) {
    const eqIdx = part.indexOf("=");
    if (eqIdx !== -1) {
      const k = part.substring(0, eqIdx).trim();
      const v = part.substring(eqIdx + 1).trim();
      if (k === "ts") ts = v;
      if (k === "v1") v1 = v;
    }
  }

  if (!ts || !v1) {
    return { valid: false, reason: "Formato x-signature inválido (esperado ts=...,v1=...)" };
  }

  // Validação de janela de tolerância de tempo contra ataques de replay
  const tsNum = parseInt(ts, 10);
  if (isNaN(tsNum) || tsNum <= 0) {
    return { valid: false, reason: "Timestamp inválido no header x-signature" };
  }
  const tsMs = tsNum > 1e11 ? tsNum : tsNum * 1000;
  const now = Date.now();
  if (Math.abs(now - tsMs) > maxAgeSeconds * 1000) {
    return { valid: false, reason: `Timestamp fora da janela de tolerância permitida (${maxAgeSeconds}s)` };
  }

  // Reconstrução do manifest canônico oficial do Mercado Pago:
  // "id:{data.id};request-id:{x-request-id};ts:{ts};"
  const manifest = `id:${dataId};request-id:${xRequestIdHeader};ts:${ts};`;

  // Cálculo HMAC-SHA256 nativo via Web Crypto
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(secretKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sigBuffer = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(manifest));
  const calculatedHex = Array.from(new Uint8Array(sigBuffer))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

  // Comparação em tempo constante (evita timing attacks)
  const cleanV1 = v1.toLowerCase().trim();
  if (calculatedHex.length !== cleanV1.length) {
    return { valid: false, reason: "Assinatura digital HMAC divergente" };
  }

  let diff = 0;
  for (let i = 0; i < calculatedHex.length; i++) {
    diff |= calculatedHex.charCodeAt(i) ^ cleanV1.charCodeAt(i);
  }

  if (diff !== 0) {
    return { valid: false, reason: "Assinatura digital HMAC inválida" };
  }

  return { valid: true };
}

// ------------------------------------------------------------------------------
// 3. CONSULTA SERVER-SIDE AO GATEWAY MERCADO PAGO (ZERO TRUST)
// ------------------------------------------------------------------------------
async function getMpPayment(paymentId: string | number): Promise<Record<string, unknown> | null> {
  const token = getMpAccessToken();
  if (!token || !paymentId) return null;

  try {
    const res = await fetch(`${MP_API_BASE}/payments/${encodeURIComponent(String(paymentId))}`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      signal: AbortSignal.timeout(6000)
    });

    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      console.warn(`[Webhook MP] Erro HTTP ${res.status} ao consultar pagamento ${paymentId}`);
      return null;
    }

    return await res.json();
  } catch (err) {
    console.warn(`[Webhook MP] Falha ao consultar detalhes do pagamento ${paymentId}:`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

// ------------------------------------------------------------------------------
// 4. CONFIRMAÇÃO RESILIENTE NO POSTGRESQL (RPC UNIFICADA COM FOR UPDATE)
// ------------------------------------------------------------------------------
async function confirmarPagamentoResiliente(params: {
  txid: string;
  gateway?: string;
  payload?: Record<string, unknown>;
  executado_por?: string;
}) {
  const { txid, gateway = "mercadopago", payload = {}, executado_por = "webhook" } = params;
  const cleanTxid = String(txid).trim();
  const agora = new Date().toISOString();
  const supabase = getSupabaseAdmin();

  let confirmedOnDatabase = false;
  let paymentRecord: Record<string, unknown> | null = null;

  // 1. Atualiza Supabase via RPC unificada 'confirmar_pagamento_unificado' (atômica e idempotente)
  try {
    const { data: rpcResult, error: rpcErr } = await supabase.rpc("confirmar_pagamento_unificado", {
      p_txid: cleanTxid,
      p_gateway: gateway,
      p_executado_por: executado_por,
      p_payload: payload
    });

    if (!rpcErr && rpcResult && rpcResult.success) {
      confirmedOnDatabase = true;
      if (rpcResult.pagamento) {
        paymentRecord = rpcResult.pagamento;
      }
    }
  } catch (dbErr) {
    console.warn("[confirmarPagamentoResiliente Webhook] Erro RPC:", dbErr instanceof Error ? dbErr.message : String(dbErr));
  }

  // 2. Fallback defensivo direto se a RPC reportar erro de rede
  if (!confirmedOnDatabase) {
    try {
      const isCleanUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cleanTxid);
      let query = supabase.from("pagamentos").update({
        status: "approved",
        pago_em: agora,
        atualizado_em: agora
      });

      if (isCleanUuid) {
        query = query.or(`id.eq.${cleanTxid},txid.eq.${cleanTxid}`);
      } else {
        query = query.or(`txid.eq.${cleanTxid},gateway_transaction_id.eq.${cleanTxid}`);
      }

      const { data: patchedRows, error: patchErr } = await query.select();
      if (!patchErr && Array.isArray(patchedRows) && patchedRows.length > 0) {
        confirmedOnDatabase = true;
        paymentRecord = patchedRows[0];
        const linkedInscId = patchedRows[0].inscricao_id;
        const linkedEmail = patchedRows[0].email;
        const linkedWpp = patchedRows[0].whatsapp_pagador;

        if (linkedInscId || linkedEmail || linkedWpp) {
          let inscUpdate = supabase.from("inscricoes").update({
            pagamento_status: "confirmado",
            pagamento_confirmado_em: agora,
            forma_pagamento: patchedRows[0].metodo || "pix",
            arquivado: false
          });

          if (linkedInscId) {
            inscUpdate = inscUpdate.eq("id", linkedInscId);
          } else if (linkedEmail) {
            inscUpdate = inscUpdate.eq("email", linkedEmail);
          } else {
            inscUpdate = inscUpdate.eq("whatsapp", linkedWpp);
          }

          await inscUpdate;
        }
      }
    } catch (directErr) {
      console.warn("[confirmarPagamentoResiliente Webhook] Falha fallback direto:", directErr instanceof Error ? directErr.message : String(directErr));
    }
  }

  // Busca detalhada do registro se ainda não preenchido
  if (!paymentRecord) {
    try {
      const isCleanUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cleanTxid);
      const orFilter = isCleanUuid
        ? `txid.eq.${cleanTxid},gateway_transaction_id.eq.${cleanTxid},id.eq.${cleanTxid}`
        : `txid.eq.${cleanTxid},gateway_transaction_id.eq.${cleanTxid}`;

      const { data: rows } = await supabase
        .from("pagamentos")
        .select("*")
        .or(orFilter)
        .limit(1);

      if (rows && rows.length > 0) {
        paymentRecord = rows[0];
      }
    } catch (_) {}
  }

  return {
    success: true,
    txid: cleanTxid,
    record: paymentRecord,
    confirmedOnDatabase
  };
}

// ------------------------------------------------------------------------------
// 5. DISPATCHER HTTP DA EDGE FUNCTION
// ------------------------------------------------------------------------------
serve(async (req: Request) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-signature, x-request-id"
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Método não permitido" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  try {
    const url = new URL(req.url);
    const webhookSecret = Deno.env.get("PIX_WEBHOOK_SECRET");

    // O segredo deve existir SOMENTE nas Secrets da Edge Function
    if (!webhookSecret) {
      console.error("[Webhook Security] PIX_WEBHOOK_SECRET não configurado na Edge Function.");
      return new Response(JSON.stringify({ error: "Webhook não configurado no servidor." }), {
        status: 503,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // REGRA DE SEGURANÇA (ENV.10):
    // Parâmetro ?secret= é estritamente proibido e desativado.
    // A validação DEVE ocorrer exclusivamente pelo header oficial x-signature e x-request-id.
    const querySecret = url.searchParams.get("secret");
    if (querySecret) {
      console.warn("[Webhook Security] Tentativa de autenticação via ?secret= rejeitada. Apenas x-signature é aceita.");
      return new Response(JSON.stringify({ error: "Autenticação via query param ?secret= descontinuada. Utilize x-signature." }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // Leitura do corpo do webhook
    let payload: Record<string, unknown> = {};
    try {
      payload = await req.json();
    } catch (_) {
      payload = {};
    }

    // Identificação do data.id para reconstrução do manifest
    const queryDataId = url.searchParams.get("data.id") || url.searchParams.get("id");
    const payloadData = payload.data as Record<string, unknown> | undefined;
    const bodyDataId = payloadData?.id ? String(payloadData.id) : (payload.id ? String(payload.id) : null);
    const effectiveDataId = queryDataId || bodyDataId;

    const xSignatureHeader = req.headers.get("x-signature");
    const xRequestIdHeader = req.headers.get("x-request-id");

    // Validação da assinatura digital oficial do Mercado Pago
    const signatureCheck = await verifyMercadoPagoSignature({
      xSignatureHeader,
      xRequestIdHeader,
      dataId: effectiveDataId,
      secretKey: webhookSecret,
      maxAgeSeconds: 300 // 5 minutos de tolerância máxima
    });

    if (!signatureCheck.valid) {
      console.warn(`[Webhook Security] Assinatura recusada: ${signatureCheck.reason}`);
      return new Response(JSON.stringify({ error: "Assinatura não autorizada", details: signatureCheck.reason }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    console.log(`[Webhook Security] Assinatura oficial x-signature validada com sucesso para evento ID: ${effectiveDataId}`);

    // Extração do tipo de evento
    const queryType = url.searchParams.get("type");
    const queryTopic = url.searchParams.get("topic");
    const isPaymentEvent = (
      payload.type === "payment" ||
      (payload.action && String(payload.action).startsWith("payment")) ||
      queryType === "payment" ||
      queryTopic === "payment" ||
      effectiveDataId
    );

    const mpPaymentId = effectiveDataId;

    // CONSULTA SERVER-SIDE OBRIGATÓRIA (ZERO TRUST NO PAYLOAD)
    let mpPayloadFetched: Record<string, unknown> | null = null;
    if (mpPaymentId && isMpConfigured()) {
      console.log(`[Webhook MP Edge] Consultando detalhes do pagamento ${mpPaymentId} na API oficial...`);
      mpPayloadFetched = await getMpPayment(mpPaymentId);
    }

    // Se o pagamento NÃO foi encontrado na API oficial do Mercado Pago:
    // Trata-se de um teste/simulação de webhook ou ID fictício.
    // NUNCA aprova nem altera estado financeiro.
    if (!mpPayloadFetched) {
      console.log(`[Webhook MP Edge] Pagamento ${mpPaymentId} não localizado no Mercado Pago. Possível simulação/teste de conectividade. Nenhuma liquidação realizada.`);
      return new Response(JSON.stringify({
        success: true,
        message: "Evento recebido e verificado. Pagamento inexistente no gateway ou simulação de teste, sem liquidação.",
        liquidado: false
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // Identificação do TXID / External Reference canônico a partir dos dados do Mercado Pago
    let txid = (
      mpPayloadFetched.external_reference ||
      payload.external_reference ||
      payload.txid ||
      payloadData?.external_reference ||
      mpPaymentId
    ) as string;

    // Normalização do status de pagamento
    const rawStatus = String(
      mpPayloadFetched.status ||
      payload.status ||
      ""
    ).toLowerCase().trim();

    console.log(`[Webhook Edge] Evento validado para TXID/Ref: ${txid} | Status no gateway: ${rawStatus}`);

    const isApproved = APPROVED_STATUS_TOKENS.has(rawStatus) ||
      rawStatus.includes("approved") ||
      rawStatus.includes("confirmado") ||
      rawStatus.includes("paid") ||
      rawStatus.includes("liquidado");

    // FLUXO DE APROVAÇÃO E LIQUIDAÇÃO CANÔNICA
    if (isApproved) {
      console.log(`[Webhook Edge] Liquidação confirmada para ${txid}. Acionando confirmação resiliente...`);

      const confirmResult = await confirmarPagamentoResiliente({
        txid: String(txid),
        gateway: "mercadopago",
        payload: mpPayloadFetched
      });

      // Disparo de comprovante por e-mail via send-email Edge Function (atômico e idempotente)
      try {
        const paymentRec = confirmResult.record as Record<string, unknown> | null;
        const payerObj = mpPayloadFetched.payer as Record<string, unknown> | undefined;
        const targetEmail = (paymentRec?.email || payerObj?.email) as string | undefined;

        if (targetEmail && !paymentRec?.comprovante_email_enviado) {
          const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
          const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
          await fetch(`${supabaseUrl.replace(/\/$/, "")}/functions/v1/send-email`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${serviceKey}`
            },
            body: JSON.stringify({
              event_type: "payment_approved",
              txid: String(txid),
              force_resend: false,
              origem_aprovacao: "webhook"
            }),
            signal: AbortSignal.timeout(10000)
          });
          console.log(`[Webhook Edge] Notificação send-email despachada para ${txid}`);
        }
      } catch (emailErr) {
        console.error(`[Webhook Edge] Aviso no envio de e-mail para ${txid}:`, emailErr instanceof Error ? emailErr.message : String(emailErr));
      }

      return new Response(JSON.stringify({
        success: true,
        message: "Pagamento processado e confirmado com sucesso",
        txid: txid,
        status: "aprovado"
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // FLUXO NÃO-LIQUIDADO (ex: pending, in_process, rejected, cancelled, refunded)
    // Atualiza apenas os registros correspondentes sem liquidar vaga nem enviar e-mail
    if (txid) {
      console.log(`[Webhook Edge] Evento não-liquidado ('${rawStatus}') para ${txid}. Atualizando banco...`);
      const agoraIso = new Date().toISOString();
      let statusInscricao = "pendente";
      if (rawStatus === "rejected" || rawStatus.includes("reject") || rawStatus.includes("recusad")) {
        statusInscricao = "recusado";
      } else if (rawStatus === "cancelled" || rawStatus.includes("cancel")) {
        statusInscricao = "cancelado";
      } else if (rawStatus === "refunded" || rawStatus.includes("reembols") || rawStatus.includes("chargeback")) {
        statusInscricao = "reembolsado";
      }

      try {
        const supabase = getSupabaseAdmin();
        const { data: patchedRows } = await supabase
          .from("pagamentos")
          .update({
            status: rawStatus,
            gateway_transaction_id: String(mpPaymentId || txid),
            payload_webhook: mpPayloadFetched,
            atualizado_em: agoraIso
          })
          .eq("txid", String(txid))
          .select();

        if (Array.isArray(patchedRows) && patchedRows.length > 0) {
          let inscIdVinculada = patchedRows[0].inscricao_id;
          const whatsappPagador = patchedRows[0].whatsapp_pagador;

          if (!inscIdVinculada && whatsappPagador) {
            const { data: foundInsc } = await supabase
              .from("inscricoes")
              .select("id")
              .eq("whatsapp", whatsappPagador)
              .order("criado_em", { ascending: false })
              .limit(1)
              .maybeSingle();
            if (foundInsc) {
              inscIdVinculada = foundInsc.id;
            }
          }

          if (inscIdVinculada) {
            const { data: recResult, error: recErr } = await supabase.rpc(
              "reconciliar_status_inscricao_pagamento",
              {
                p_inscricao_id: inscIdVinculada,
                p_status_proposto: statusInscricao,
                p_origem: "webhook"
              }
            );
            if (recErr) {
              console.warn("[Webhook Edge] Aviso ao reconciliar status da inscricao via RPC:", recErr.message);
            } else {
              console.log(`[Webhook Edge] Inscrição ${inscIdVinculada} reconciliada via RPC: status final = ${recResult?.status_final}`);
            }
          }
        }
      } catch (ePatch) {
        console.warn("[Webhook Edge] Aviso ao atualizar status não-aprovado:", ePatch instanceof Error ? ePatch.message : String(ePatch));
      }
    }

    return new Response(JSON.stringify({
      success: true,
      message: `Webhook recebido para status '${rawStatus}', sem ação de liquidação necessária`,
      txid: txid,
      liquidado: false
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });

  } catch (err) {
    console.error("[Webhook Edge Error]", err instanceof Error ? err.message : String(err));
    return new Response(JSON.stringify({ error: "Erro interno ao processar webhook" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});
