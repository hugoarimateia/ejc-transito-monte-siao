// ==============================================================================
// SUPABASE EDGE FUNCTION: checkout-process
// Processamento centralizado do Checkout Unificado (Pix e Cartão de Crédito)
// Consulta de Status (GET Polling) e Registro/Confirmação Resiliente (POST)
// 100% equivalente a /api/checkout-process.js (Vercel) com execução no Supabase Edge
// ==============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ------------------------------------------------------------------------------
// 1. CORS E ORIGENS AUTORIZADAS
// ------------------------------------------------------------------------------
const ALLOWED_ORIGINS = new Set([
  "https://www.transitoejc.site",
  "https://transitoejc.site",
  "https://ejc-public.pages.dev",
  "https://ejc-admin.pages.dev",
  "https://site-ejc-eight.vercel.app",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:8080",
  "http://127.0.0.1:8080"
]);

function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || req.headers.get("Origin") || "";
  const customSite = Deno.env.get("SITE_URL") || Deno.env.get("NEXT_PUBLIC_SITE_URL") || Deno.env.get("APP_URL");
  if (customSite) {
    ALLOWED_ORIGINS.add(customSite.replace(/\/+$/, ""));
  }

  const allowOrigin = ALLOWED_ORIGINS.has(origin) ? origin : "https://www.transitoejc.site";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-admin-token, x-signature, x-client-version",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
    "Cache-Control": "no-store, no-cache, must-revalidate"
  };
}

function jsonResponse(data: unknown, status = 200, req?: Request): Response {
  const headers = {
    "Content-Type": "application/json",
    ...(req ? getCorsHeaders(req) : {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-admin-token, x-signature, x-client-version"
    })
  };
  return new Response(JSON.stringify(data), { status, headers });
}

// ------------------------------------------------------------------------------
// 2. HELPERS DE AMBIENTE E SEGURANÇA
// ------------------------------------------------------------------------------
function getPublicBaseUrl(): string {
  const custom = Deno.env.get("SITE_URL") || Deno.env.get("APP_URL") || Deno.env.get("NEXT_PUBLIC_SITE_URL");
  if (custom) {
    const clean = custom.replace(/\/$/, "");
    return clean.startsWith("http") ? clean : `https://${clean}`;
  }
  return "https://www.transitoejc.site";
}

function getWebhookNotificationUrl(): string {
  // REGRA DE SEGURANÇA (ENV.11.2):
  // Retorna estritamente o endpoint canônico da Edge Function pix-webhook SEM query string nem segredos.
  // A autenticação oficial é realizada exclusivamente via headers x-signature e x-request-id (HMAC-SHA256).
  const supabaseUrl = (Deno.env.get("SUPABASE_URL") || "https://guppedddwnuvluhiaaas.supabase.co").replace(/\/$/, "");
  return `${supabaseUrl}/functions/v1/pix-webhook`;
}

function safeUuidOrNull(val: unknown): string | null {
  if (!val || typeof val !== "string") return null;
  const clean = val.trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clean) ? clean : null;
}

function normalizeName(name: string): string {
  if (!name || typeof name !== "string") return "";
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeEmail(email: string): string {
  if (!email || typeof email !== "string") return "";
  return email.toLowerCase().trim();
}

function normalizePhone(phone: string): string {
  if (!phone || typeof phone !== "string") return "";
  let digits = phone.replace(/\D/g, "");
  if (digits.length >= 12 && digits.startsWith("55")) {
    digits = digits.slice(2);
  }
  return digits;
}

async function sha256Bytes(str: string): Promise<Uint8Array> {
  const enc = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest("SHA-256", enc);
  return new Uint8Array(hash);
}

async function timingSafeEqualStr(a: string, b: string): Promise<boolean> {
  if (!a || !b) return false;
  const hashA = await sha256Bytes(a);
  const hashB = await sha256Bytes(b);
  let diff = 0;
  for (let i = 0; i < hashA.length; i++) {
    diff |= hashA[i] ^ hashB[i];
  }
  return diff === 0;
}

async function authenticateAdmin(req: Request, bodyData?: Record<string, unknown>): Promise<{ ok: boolean; role: string | null }> {
  const authHeader = req.headers.get("authorization") || req.headers.get("Authorization") || "";
  const bearerToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  const adminToken = (req.headers.get("x-admin-token") || req.headers.get("x-admin-pass") || "").trim();
  const bodyPass = typeof bodyData?.password === "string"
    ? bodyData.password.trim()
    : (typeof bodyData?.admin_pass === "string" ? bodyData.admin_pass.trim() : "");

  const pass = bodyPass || adminToken || bearerToken;
  if (!pass) return { ok: false, role: null };

  const passSuperadmin = (Deno.env.get("ADMIN_PASSWORD_COORDENACAO") || Deno.env.get("ADMIN_PASS") || "").trim().replace(/^"|"$/g, "");
  const passFinanceiro = (Deno.env.get("ADMIN_PASSWORD_FINANCEIRO") || Deno.env.get("FINANCEIRO_PASSWORD") || "").trim().replace(/^"|"$/g, "");
  const passAdmin = (Deno.env.get("ADMIN_PASSWORD") || "").trim().replace(/^"|"$/g, "");

  if (Boolean(passSuperadmin) && (await timingSafeEqualStr(pass, passSuperadmin))) return { ok: true, role: "superadmin" };
  if (Boolean(passFinanceiro) && (await timingSafeEqualStr(pass, passFinanceiro))) return { ok: true, role: "financeiro" };
  if (Boolean(passAdmin) && (await timingSafeEqualStr(pass, passAdmin))) return { ok: true, role: "admin" };

  return { ok: false, role: null };
}

// ------------------------------------------------------------------------------
// 3. MERCADO PAGO REST API CLIENT (SERVER-SIDE ONLY)
// ------------------------------------------------------------------------------
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

async function mpCriarPagamentoPix(params: {
  valor: number;
  nome: string;
  email: string;
  cpf?: string | null;
  txid: string;
  descricao?: string;
  notificationUrl?: string;
}) {
  const token = getMpAccessToken();
  if (!token) return null;

  const nomePartes = String(params.nome || "Participante EJC").trim().split(/\s+/);
  const firstName = nomePartes[0] || "Participante";
  const lastName = nomePartes.slice(1).join(" ") || "EJC";

  const payerObj: Record<string, unknown> = {
    email: String(params.email).trim().toLowerCase(),
    first_name: firstName,
    last_name: lastName
  };

  const cleanCpf = params.cpf ? String(params.cpf).replace(/\D/g, "") : "";
  if (cleanCpf && cleanCpf.length === 11) {
    payerObj.identification = { type: "CPF", number: cleanCpf };
  }

  const bodyPayload: Record<string, unknown> = {
    transaction_amount: Number(params.valor),
    description: String(params.descricao || "Inscrição EJC Trânsito Monte Sião").substring(0, 60),
    payment_method_id: "pix",
    payer: payerObj,
    external_reference: String(params.txid)
  };

  if (params.notificationUrl) {
    bodyPayload.notification_url = params.notificationUrl;
  }

  const response = await fetch(`${MP_API_BASE}/payments`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Idempotency-Key": `PIX-${params.txid}`
    },
    body: JSON.stringify(bodyPayload),
    signal: AbortSignal.timeout(12000)
  });

  const responseData = await response.json();
  if (!response.ok) {
    const errorMsg = responseData?.message || responseData?.error || `Erro MP (HTTP ${response.status})`;
    let detailMsg = "";
    if (Array.isArray(responseData?.cause)) {
      detailMsg = responseData.cause.map((c: { description?: string; code?: string }) => c.description || c.code || JSON.stringify(c)).join("; ");
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
    external_reference: responseData.external_reference || params.txid,
    qr_code: qrCode,
    qr_code_base64: qrCodeBase64 || null,
    ticket_url: transactionData.ticket_url || null,
    date_of_expiration: responseData.date_of_expiration || null,
    raw: responseData
  };
}

async function mpConsultarPagamentoPorId(paymentId: string | number) {
  const token = getMpAccessToken();
  if (!token || !paymentId) return null;

  try {
    const response = await fetch(`${MP_API_BASE}/payments/${encodeURIComponent(String(paymentId))}`, {
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
    console.warn("[MP consultarPagamentoPorId] Erro:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function mpConsultarPagamentoPorExternalReference(externalReference: string) {
  const token = getMpAccessToken();
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
      const approved = data.results.find((p: { status: string }) => p.status === "approved");
      return approved || data.results[0];
    }
    return null;
  } catch (err) {
    console.warn("[MP search] Erro por external_reference:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function mpCriarPreferenciaCheckoutPro(params: {
  txid: string;
  valor: number;
  nome: string;
  email: string;
  telefone?: string | null;
  descricao?: string;
  maxParcelas?: number;
  notificationUrl?: string;
  backUrls?: { success?: string; pending?: string; failure?: string };
}) {
  const token = getMpAccessToken();
  if (!token) throw new Error("MERCADOPAGO_ACCESS_TOKEN não configurado no servidor.");

  const nomePartes = String(params.nome || "Participante EJC").trim().split(/\s+/);
  const firstName = nomePartes[0] || "Participante";
  const lastName = nomePartes.slice(1).join(" ") || "EJC";
  const cleanPhone = params.telefone ? String(params.telefone).replace(/\D/g, "") : "";

  const payerObj: Record<string, unknown> = {
    name: firstName,
    surname: lastName,
    email: String(params.email).trim().toLowerCase()
  };

  if (cleanPhone && cleanPhone.length >= 10) {
    payerObj.phone = {
      area_code: cleanPhone.substring(0, 2),
      number: cleanPhone.substring(2)
    };
  }

  const preferencePayload: Record<string, unknown> = {
    items: [
      {
        id: String(params.txid),
        title: "Inscrição EJC Trânsito Monte Sião",
        description: String(params.descricao || "Inscrição EJC Trânsito Monte Sião").substring(0, 60),
        quantity: 1,
        currency_id: "BRL",
        unit_price: Number(Number(params.valor).toFixed(2))
      }
    ],
    payer: payerObj,
    payment_methods: {
      excluded_payment_types: [
        { id: "ticket" },
        { id: "bank_transfer" }
      ],
      installments: Math.max(1, Math.min(12, Number(params.maxParcelas || 6))),
      default_installments: 1
    },
    back_urls: {
      success: params.backUrls?.success || `https://www.transitoejc.site/checkout.html?retorno_mp=success&txid=${encodeURIComponent(params.txid)}`,
      pending: params.backUrls?.pending || `https://www.transitoejc.site/checkout.html?retorno_mp=pending&txid=${encodeURIComponent(params.txid)}`,
      failure: params.backUrls?.failure || `https://www.transitoejc.site/checkout.html?retorno_mp=failure&txid=${encodeURIComponent(params.txid)}`
    },
    auto_return: "approved",
    external_reference: String(params.txid),
    statement_descriptor: "EJC TRANSITO",
    binary_mode: false
  };

  if (params.notificationUrl) {
    preferencePayload.notification_url = params.notificationUrl;
  }

  const response = await fetch("https://api.mercadopago.com/checkout/preferences", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Idempotency-Key": `PREF-${params.txid}`
    },
    body: JSON.stringify(preferencePayload),
    signal: AbortSignal.timeout(12000)
  });

  const responseData = await response.json();
  if (!response.ok) {
    const errorMsg = responseData?.message || responseData?.error || `Erro Checkout Pro (HTTP ${response.status})`;
    let detailMsg = "";
    if (Array.isArray(responseData?.cause)) {
      detailMsg = responseData.cause.map((c: { description?: string; code?: string }) => c.description || c.code || JSON.stringify(c)).join("; ");
    }
    throw new Error(`${errorMsg}${detailMsg ? ` - ${detailMsg}` : ""}`);
  }

  return {
    success: true,
    id: responseData.id,
    init_point: responseData.init_point,
    sandbox_init_point: responseData.sandbox_init_point,
    external_reference: responseData.external_reference || params.txid,
    raw: responseData
  };
}

async function mpCriarPagamentoCartao(params: {
  token: string;
  transaction_amount: number;
  installments: number;
  payment_method_id?: string;
  issuer_id?: string | number;
  payer?: { email?: string; first_name?: string; last_name?: string; identification?: { type?: string; number?: string } };
  txid: string;
  description?: string;
  notification_url?: string;
}) {
  const token = getMpAccessToken();
  if (!token) throw new Error("MERCADOPAGO_ACCESS_TOKEN ausente.");

  const payload: Record<string, unknown> = {
    token: String(params.token).trim(),
    transaction_amount: Number(Number(params.transaction_amount).toFixed(2)),
    installments: Math.max(1, parseInt(String(params.installments), 10) || 1),
    payment_method_id: String(params.payment_method_id || "visa").toLowerCase(),
    description: String(params.description || "Inscrição EJC Trânsito Monte Sião").substring(0, 60),
    external_reference: String(params.txid),
    payer: {
      email: String(params.payer?.email || "").trim().toLowerCase()
    }
  };

  if (params.issuer_id) {
    payload.issuer_id = String(params.issuer_id);
  }

  if (params.payer?.identification?.number) {
    payload.payer = {
      ...(payload.payer as Record<string, unknown>),
      identification: {
        type: params.payer.identification.type || "CPF",
        number: String(params.payer.identification.number).replace(/\D/g, "")
      }
    };
  }

  if (params.payer?.first_name) {
    payload.payer = {
      ...(payload.payer as Record<string, unknown>),
      first_name: String(params.payer.first_name).trim(),
      last_name: String(params.payer?.last_name || "").trim()
    };
  }

  if (params.notification_url) {
    payload.notification_url = params.notification_url;
  }

  const response = await fetch(`${MP_API_BASE}/payments`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Idempotency-Key": `CARD-${params.txid}`
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000)
  });

  const responseData = await response.json();
  if (!response.ok) {
    const errorMsg = responseData?.message || responseData?.error || `Erro Cartão MP (HTTP ${response.status})`;
    let detailMsg = "";
    if (Array.isArray(responseData?.cause)) {
      detailMsg = responseData.cause.map((c: { description?: string; code?: string }) => c.description || c.code || JSON.stringify(c)).join("; ");
    }
    const err = new Error(`${errorMsg}${detailMsg ? ` - ${detailMsg}` : ""}`);
    (err as unknown as { status: number; mpData: unknown }).status = response.status;
    (err as unknown as { status: number; mpData: unknown }).mpData = responseData;
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
    external_reference: responseData.external_reference || params.txid,
    raw: responseData
  };
}

// ------------------------------------------------------------------------------
// 4. MENSAGENS AMIGÁVEIS DE ERRO DE CARTÃO
// ------------------------------------------------------------------------------
function getFriendlyCardErrorMessage(statusDetail?: string | null, status: string | null = null): string | null {
  const map: Record<string, string> = {
    accredited: "Pagamento aprovado com sucesso!",
    pending_review_manual: "Seu pagamento foi recebido pelo Mercado Pago e está passando por uma análise. A confirmação será atualizada assim que o Mercado Pago concluir o processamento.",
    pending_contingency: "Estamos processando seu pagamento. Não se preocupe, em breve você receberá a confirmação.",
    pending_waiting_transfer: "Aguardando transferência para confirmação do pagamento.",
    pending_waiting_payment: "Aguardando confirmação do pagamento junto à operadora.",
    cc_rejected_bad_filled_card_number: "Número do cartão inválido. Verifique os dígitos digitados.",
    cc_rejected_bad_filled_security_code: "Código de segurança (CVV) inválido. Verifique os 3 ou 4 dígitos no verso do cartão.",
    cc_rejected_bad_filled_date: "Data de validade do cartão incorreta ou expirada.",
    cc_rejected_bad_filled_other: "Dados do cartão incorretos. Por favor, revise as informações preenchidas.",
    cc_rejected_insufficient_amount: "Limite ou saldo insuficiente no cartão de crédito.",
    cc_rejected_call_for_authorize: "Pagamento não autorizado pelo banco emissor. Por favor, entre em contato com a operadora do seu cartão para autorizar compras online.",
    cc_rejected_card_disabled: "Cartão desabilitado ou bloqueado para compras na internet. Entre em contato com seu banco.",
    cc_rejected_duplicated_payment: "Pagamento duplicado detectado. Aguarde alguns minutos antes de tentar novamente.",
    cc_rejected_high_risk: "Transação não autorizada pelas políticas de segurança da operadora. Recomendamos tentar outro cartão ou efetuar o pagamento via Pix Instantâneo.",
    cc_rejected_max_attempts: "Limite de tentativas excedido para este cartão. Tente novamente mais tarde ou use outro cartão.",
    cc_rejected_invalid_installments: "A quantidade de parcelas selecionada não é permitida para este cartão.",
    cc_rejected_card_type_not_allowed: "Este tipo de cartão não é aceito. Por favor, utilize um cartão de crédito válido.",
    cc_rejected_blacklist: "Cartão não autorizado pela operadora. Utilize outro cartão ou a opção Pix.",
    cc_rejected_other_reason: "O pagamento não foi aprovado pela operadora do cartão. Verifique os dados, tente outro cartão ou pague via Pix Instantâneo.",
    "3003": "Token de segurança do cartão expirado ou inválido. Por favor, preencha novamente os dados do cartão.",
    transaction_not_created: "A transação não pôde ser gerada no Mercado Pago. Por favor, tente novamente ou utilize o Pix Instantâneo."
  };

  if (statusDetail && map[statusDetail]) return map[statusDetail];
  if (status === "in_process" || status === "pending" || String(statusDetail).startsWith("pending_")) {
    return "Seu pagamento foi recebido e está em processamento pelo Mercado Pago. A confirmação será atualizada em instantes.";
  }
  return (statusDetail && statusDetail !== "card_rejected")
    ? `Pagamento recusado (${statusDetail}). Verifique os dados ou utilize outra forma de pagamento.`
    : "O pagamento não foi aprovado pela operadora do cartão. Verifique os dados ou tente outro cartão.";
}

// ------------------------------------------------------------------------------
// 5. BANCO DE DADOS: CLIENTE ADMIN SUPABASE & OPERAÇÕES CANÔNICAS
// ------------------------------------------------------------------------------
function getSupabaseAdmin() {
  const url = Deno.env.get("SUPABASE_URL") || "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  return createClient(url, key);
}

async function persistirTransacaoSupabase(p: {
  txid: string;
  nome_pagador: string;
  email: string;
  whatsapp_pagador?: string | null;
  cpf_pagador?: string | null;
  valor: number;
  metodo?: string;
  parcelas?: number;
  cartao_ultimos_digitos?: string | null;
  cartao_bandeira?: string | null;
  status?: string;
  tipo?: string;
  pix_copia_e_cola?: string | null;
  qr_code_base64?: string | null;
  expiracao?: string | null;
  inscricao_id?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const supabase = getSupabaseAdmin();
  const safeInscId = safeUuidOrNull(p.inscricao_id);
  const cleanExp = p.expiracao || new Date(Date.now() + 86400000).toISOString();
  const cleanValor = (p.valor !== null && p.valor !== undefined && !isNaN(Number(p.valor))) ? Number(Number(p.valor).toFixed(2)) : 0;
  const cleanMetodo = String(p.metodo || "pix").toLowerCase();
  const rawStatus = String(p.status || "pending").toLowerCase();
  const cleanStatus = (rawStatus === "400" || rawStatus === "500" || /^\d+$/.test(rawStatus)) ? "rejected" : rawStatus;
  const cleanPixCopiaECola = p.pix_copia_e_cola || (cleanMetodo === "credit_card" ? "N/A - CARTAO" : "");

  // 1. Tenta RPC unificada 'criar_transacao_checkout'
  try {
    const { data, error } = await supabase.rpc("criar_transacao_checkout", {
      p_txid: String(p.txid),
      p_nome_pagador: String(p.nome_pagador || "Participante EJC"),
      p_email: String(p.email || "").trim().toLowerCase(),
      p_whatsapp_pagador: p.whatsapp_pagador || null,
      p_cpf_pagador: p.cpf_pagador || null,
      p_valor: cleanValor,
      p_metodo: cleanMetodo,
      p_parcelas: Math.max(1, parseInt(String(p.parcelas || 1), 10) || 1),
      p_cartao_ultimos_digitos: p.cartao_ultimos_digitos ? String(p.cartao_ultimos_digitos).slice(-4) : null,
      p_cartao_bandeira: p.cartao_bandeira ? String(p.cartao_bandeira).slice(0, 30) : null,
      p_status: cleanStatus,
      p_tipo: String(p.tipo || "inscricao"),
      p_pix_copia_e_cola: cleanPixCopiaECola,
      p_qr_code_base64: p.qr_code_base64 || null,
      p_expiracao: cleanExp,
      p_inscricao_id: safeInscId,
      p_metadata: p.metadata || {}
    });

    if (!error && data) {
      return { success: true, via: "rpc", data };
    }
  } catch (rpcErr) {
    console.warn("[persistirTransacaoSupabase] Exceção na RPC:", rpcErr instanceof Error ? rpcErr.message : String(rpcErr));
  }

  // 2. Fallback direto: UPSERT na tabela 'public.pagamentos'
  try {
    const rowPayload = {
      txid: String(p.txid),
      nome_pagador: String(p.nome_pagador || "Participante EJC"),
      email: String(p.email || "").trim().toLowerCase(),
      whatsapp_pagador: p.whatsapp_pagador || null,
      cpf_pagador: p.cpf_pagador || null,
      valor: cleanValor,
      metodo: cleanMetodo,
      parcelas: Math.max(1, parseInt(String(p.parcelas || 1), 10) || 1),
      cartao_ultimos_digitos: p.cartao_ultimos_digitos ? String(p.cartao_ultimos_digitos).slice(-4) : null,
      cartao_bandeira: p.cartao_bandeira ? String(p.cartao_bandeira).slice(0, 30) : null,
      status: cleanStatus,
      tipo: String(p.tipo || "inscricao"),
      pix_copia_e_cola: cleanPixCopiaECola,
      qr_code_base64: p.qr_code_base64 || null,
      expiracao: cleanExp,
      inscricao_id: safeInscId,
      gateway: cleanMetodo === "credit_card" ? "mercadopago_credit_card" : "mercadopago_pix",
      gateway_transaction_id: p.metadata?.payment_id ? String(p.metadata.payment_id) : String(p.txid),
      metadata: p.metadata || {},
      atualizado_em: new Date().toISOString()
    };

    const { data: upsertData, error: upsertErr } = await supabase
      .from("pagamentos")
      .upsert(rowPayload, { onConflict: "txid" })
      .select();

    if (!upsertErr) {
      return { success: true, via: "direct_table", data: upsertData };
    }
    console.error("[persistirTransacaoSupabase] Falha no fallback direto:", upsertErr.message);
  } catch (directErr) {
    console.error("[persistirTransacaoSupabase] Exceção no fallback direto:", directErr instanceof Error ? directErr.message : String(directErr));
  }

  return { success: false };
}

async function confirmarPagamentoResiliente(params: {
  txid: string;
  gateway?: string;
  payload?: Record<string, unknown>;
  executado_por?: string;
}) {
  const { txid, gateway = "manual", payload = {}, executado_por = "sistema" } = params;
  if (!txid) throw new Error("TXID é obrigatório para confirmação.");
  const cleanTxid = String(txid).trim();
  const agora = new Date().toISOString();
  const supabase = getSupabaseAdmin();

  let confirmedOnDatabase = false;
  let paymentRecord: Record<string, unknown> | null = null;

  // 1. Atualiza Supabase via RPC unificada 'confirmar_pagamento_unificado'
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
    console.warn("[confirmarPagamentoResiliente] Erro RPC:", dbErr instanceof Error ? dbErr.message : String(dbErr));
  }

  // 2. Fallback direto se a RPC falhou ou não confirmou
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
      console.warn("[confirmarPagamentoResiliente] Falha fallback direto:", directErr instanceof Error ? directErr.message : String(directErr));
    }
  }

  // Busca detalhada se paymentRecord ainda for nulo
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

  // 3. Envio idempotente de e-mail (usando send-email Edge Function se configurado)
  let emailEnviado = Boolean(paymentRecord?.comprovante_email_enviado);
  if (paymentRecord && paymentRecord.email && !paymentRecord.comprovante_email_enviado) {
    try {
      const flag = (Deno.env.get("EMAIL_SEND_EMAIL_PAYMENT_APPROVED") || "ON").trim().toUpperCase();
      if (flag === "ON") {
        const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
        const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
        const emailRes = await fetch(`${supabaseUrl.replace(/\/$/, "")}/functions/v1/send-email`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${serviceKey}`
          },
          body: JSON.stringify({
            event_type: "payment_approved",
            txid: cleanTxid,
            force_resend: false,
            origem_aprovacao: (gateway === "manual_admin" || (paymentRecord.metadata as Record<string, unknown>)?.modalidade_pix === "manual") ? "manual_coordenacao" : "api_gateway"
          }),
          signal: AbortSignal.timeout(10000)
        });
        if (emailRes.ok) {
          const emailData = await emailRes.json().catch(() => ({}));
          emailEnviado = Boolean(emailData.success);
        }
      }
    } catch (eEmail) {
      console.warn("[confirmarPagamentoResiliente] Erro ao enviar comprovante:", eEmail instanceof Error ? eEmail.message : String(eEmail));
    }
  }

  return {
    success: true,
    txid: cleanTxid,
    payment_id: (paymentRecord as Record<string, unknown>)?.payment_id || (paymentRecord as Record<string, unknown>)?.metadata?.payment_id || cleanTxid,
    order_id: (paymentRecord as Record<string, unknown>)?.order_id || (paymentRecord as Record<string, unknown>)?.metadata?.order_id || null,
    status: "approved",
    confirmedOnDatabase,
    emailEnviado,
    paymentRecord
  };
}

// ------------------------------------------------------------------------------
// 6. RESOLUÇÃO DE CONFIGURAÇÃO FINANCEIRA ATIVA
// ------------------------------------------------------------------------------
interface ActiveFinancialConfig {
  valor_inscricao: number | null;
  valor_promocional: number | null;
  preco_efetivo: number | null;
  lote_atual: string;
  modalidade_pix: string;
  pix_chave: string;
  pix_beneficiario: string;
  pix_cidade: string;
  pix_tipo_chave: string;
  pix_instrucoes_manual: string;
  pix_permite_comprovante: boolean;
  max_parcelas: number;
  card_max_installments: number;
  versao: number;
}

function getEffectivePrice(regular: number | null, promo: number | null): number | null {
  if (regular === null || regular === undefined || isNaN(regular) || regular <= 0) return null;
  if (promo !== null && promo !== undefined && !isNaN(promo) && promo > 0 && promo < regular) {
    return promo;
  }
  return regular;
}

async function getActiveFinancialSettings(): Promise<ActiveFinancialConfig> {
  const supabase = getSupabaseAdmin();
  let remote: Record<string, unknown> | null = null;

  try {
    const { data: rpcData } = await supabase.rpc("obter_configuracao_financeira_ativa");
    if (rpcData && rpcData.success && rpcData.valor_inscricao !== undefined) {
      remote = rpcData;
    }
  } catch (_) {}

  if (!remote) {
    const { data: rows } = await supabase
      .from("configuracoes_financeiras")
      .select("*")
      .eq("ativo", true)
      .order("versao", { ascending: false })
      .limit(1);

    if (rows && rows.length > 0) {
      remote = rows[0];
    } else {
      const { data: latestRows } = await supabase
        .from("configuracoes_financeiras")
        .select("*")
        .order("versao", { ascending: false })
        .limit(1);
      if (latestRows && latestRows.length > 0) remote = latestRows[0];
    }
  }

  const rawRegular = remote?.valor_inscricao !== null && remote?.valor_inscricao !== undefined ? Number(remote.valor_inscricao) : null;
  const rawPromo = remote?.valor_promocional !== null && remote?.valor_promocional !== undefined ? Number(remote.valor_promocional) : null;
  const effectivePrice = getEffectivePrice(rawRegular, rawPromo);

  return {
    valor_inscricao: rawRegular,
    valor_promocional: rawPromo,
    preco_efetivo: effectivePrice,
    lote_atual: String(remote?.lote_atual || "1º Lote Oficial"),
    modalidade_pix: String(remote?.modalidade_pix || "api_webhook"),
    pix_chave: String(remote?.pix_chave || Deno.env.get("NEXT_PUBLIC_PIX_CHAVE") || ""),
    pix_beneficiario: String(remote?.pix_beneficiario || Deno.env.get("NEXT_PUBLIC_PIX_BENEFICIARIO") || "EJC TRANSITO MONTE SIAO"),
    pix_cidade: String(remote?.pix_cidade || Deno.env.get("NEXT_PUBLIC_PIX_CIDADE") || "CAMPINA GRANDE"),
    pix_tipo_chave: String(remote?.pix_tipo_chave || "EMAIL"),
    pix_instrucoes_manual: String(remote?.pix_instrucoes_manual || "Faça o Pix para a chave oficial cadastrada pela coordenação."),
    pix_permite_comprovante: remote?.pix_permite_comprovante !== false,
    max_parcelas: Number(remote?.max_parcelas || 6),
    card_max_installments: Number(remote?.card_max_installments || remote?.max_parcelas || 6),
    versao: Number(remote?.versao || 1)
  };
}

// ------------------------------------------------------------------------------
// 7. SERVIDOR HTTP PRINCIPAL DA EDGE FUNCTION
// ------------------------------------------------------------------------------
serve(async (req: Request) => {
  const cors = getCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: cors });
  }

  const supabase = getSupabaseAdmin();
  const url = new URL(req.url);

  // ============================================================================
  // FLUXO GET: CONSULTA E POLLING DE STATUS
  // ============================================================================
  if (req.method === "GET") {
    const action = url.searchParams.get("action");

    // --------------------------------------------------------------------------
    // SUB-AÇÃO GET: BUSCA DE INSCRIÇÕES PENDENTES (NORMALIZAÇÃO COMPLETA)
    // --------------------------------------------------------------------------
    if (action === "buscar_inscricoes") {
      const termo = String(
        url.searchParams.get("termo") ||
        url.searchParams.get("email") ||
        url.searchParams.get("whatsapp") ||
        url.searchParams.get("nome") ||
        url.searchParams.get("busca") ||
        ""
      ).trim();

      const emailNorm = normalizeEmail(termo);
      const wppNorm = normalizePhone(termo);
      const nomeNorm = normalizeName(termo);

      const ehEmail = /^[^\s@,()%*]+@[^\s@,()%*]+\.[^\s@,()%*]+$/.test(emailNorm);
      const ehWhatsapp = !ehEmail && wppNorm.length >= 10;
      const ehUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(termo);
      const ehNome = !ehEmail && !ehWhatsapp && !ehUuid && nomeNorm.length >= 3;

      if (!ehEmail && !ehWhatsapp && !ehUuid && !ehNome) {
        return jsonResponse(
          { error: "Informe o nome completo, o e-mail completo, o WhatsApp (com DDD) ou o código da inscrição." },
          400,
          req
        );
      }

      try {
        // Busca inscrições não arquivadas com status 'pendente' ou 'cancelado' (Pix expirado)
        let query = supabase
          .from("inscricoes")
          .select("id, nome_completo, email, whatsapp, sub, pagamento_status, motivo_arquivamento, arquivado, criado_em")
          .eq("arquivado", false)
          .is("motivo_arquivamento", null)
          .in("pagamento_status", ["pendente", "cancelado"])
          .order("criado_em", { ascending: false })
          .limit(10);

        if (ehUuid) {
          query = query.eq("id", termo.toLowerCase().trim());
        } else if (ehEmail) {
          query = query.ilike("email", emailNorm);
        } else if (ehWhatsapp) {
          query = query.ilike("whatsapp", `%${wppNorm}%`);
        } else {
          // Busca combinada por termos do nome
          const partes = nomeNorm.split(" ").filter(p => p.length >= 2);
          if (partes.length >= 2) {
            query = query.ilike("nome_completo", `%${partes[0]}%${partes[partes.length - 1]}%`);
          } else {
            query = query.ilike("nome_completo", `%${nomeNorm}%`);
          }
        }

        const { data: rows, error } = await query;
        if (error) throw error;

        // Se houver registros, verificar se algum já possui pagamento aprovado no gateway
        const candidateIds = (rows || []).map(r => r.id);
        let approvedSet = new Set<string>();
        if (candidateIds.length > 0) {
          const { data: approvedRows } = await supabase
            .from("pagamentos")
            .select("inscricao_id")
            .in("inscricao_id", candidateIds)
            .in("status", ["approved", "confirmado", "pago"]);

          if (Array.isArray(approvedRows)) {
            approvedRows.forEach(a => {
              if (a.inscricao_id) approvedSet.add(String(a.inscricao_id));
            });
          }
        }

        const inscricoesEncontradas = (rows || [])
          .filter(r => !approvedSet.has(String(r.id))) // Exclui inscrições já pagas/aprovadas
          .map((r) => {
            const isPixExpirado = r.pagamento_status === "cancelado";
            return {
              id: r.id,
              nome_completo: r.nome_completo,
              email: r.email,
              whatsapp: r.whatsapp,
              sub: r.sub,
              pagamento_status: isPixExpirado ? "pix_expirado" : "pendente",
              pix_expirado: isPixExpirado,
              elegivel_novo_pix: true,
              criado_em: r.criado_em
            };
          });

        return jsonResponse(
          {
            success: true,
            total: inscricoesEncontradas.length,
            inscricoes: inscricoesEncontradas
          },
          200,
          req
        );
      } catch (errDb) {
        console.warn("[buscar_inscricoes] Falha na busca Supabase:", errDb instanceof Error ? errDb.message : String(errDb));
        return jsonResponse({ success: false, total: 0, inscricoes: [] }, 500, req);
      }
    }

    // --------------------------------------------------------------------------
    // POLLING / CONSULTA DE TRANSAÇÃO POR TXID, EMAIL OU INSCRIÇÃO
    // --------------------------------------------------------------------------
    const queryTxid = (
      url.searchParams.get("txid") ||
      url.searchParams.get("id") ||
      url.searchParams.get("payment_id") ||
      url.searchParams.get("collection_id") ||
      url.searchParams.get("order_id") ||
      url.searchParams.get("reference") ||
      url.searchParams.get("external_reference") ||
      url.searchParams.get("preference_id") ||
      ""
    ).trim();

    const queryPaymentId = url.searchParams.get("payment_id") || url.searchParams.get("collection_id") || "";
    const isRetornoMp = Boolean(url.searchParams.get("retorno_mp") || url.searchParams.get("collection_id") || url.searchParams.get("preference_id"));
    if (isRetornoMp) {
      console.log(`[CHECKOUT_PRO_RETURN] Retorno detectado: TXID=${queryTxid}, PaymentId=${queryPaymentId}`);
    }

    const queryEmail = url.searchParams.get("email") ? url.searchParams.get("email")!.trim().toLowerCase() : null;
    const queryNome = url.searchParams.get("nome") ? url.searchParams.get("nome")!.trim().toLowerCase() : null;
    const queryInscricao = url.searchParams.get("inscricao_id") || url.searchParams.get("registration_id");

    if (!queryTxid && !queryEmail && !queryInscricao) {
      return jsonResponse(
        { error: "Informe o TXID, Payment ID, Order ID, E-mail ou Inscrição para consulta de status." },
        400,
        req
      );
    }

    try {
      let transactionFound: Record<string, unknown> | null = null;

      // 1. Consulta no Supabase
      if (queryTxid) {
        const isQueryUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(queryTxid);
        const orFilter = isQueryUuid
          ? `txid.eq.${queryTxid},gateway_transaction_id.eq.${queryTxid},id.eq.${queryTxid}`
          : `txid.eq.${queryTxid},gateway_transaction_id.eq.${queryTxid}`;

        const { data: rows } = await supabase
          .from("pagamentos")
          .select("*")
          .or(orFilter)
          .limit(1);

        if (rows && rows.length > 0) {
          transactionFound = rows[0];
        }

        // Se não localizou por coluna, busca em metadata JSONB
        if (!transactionFound) {
          const { data: metaRows } = await supabase
            .from("pagamentos")
            .select("*")
            .filter("metadata->>payment_id", "eq", queryTxid)
            .limit(1);
          if (metaRows && metaRows.length > 0) transactionFound = metaRows[0];
        }
        if (!transactionFound) {
          const { data: orderRows } = await supabase
            .from("pagamentos")
            .select("*")
            .filter("metadata->>order_id", "eq", queryTxid)
            .limit(1);
          if (orderRows && orderRows.length > 0) transactionFound = orderRows[0];
        }
      } else if (queryInscricao) {
        const { data: rows } = await supabase
          .from("pagamentos")
          .select("*")
          .eq("inscricao_id", queryInscricao)
          .order("criado_em", { ascending: false })
          .limit(1);
        if (rows && rows.length > 0) transactionFound = rows[0];
      } else if (queryEmail) {
        const { data: rows } = await supabase
          .from("pagamentos")
          .select("*")
          .eq("email", queryEmail)
          .order("criado_em", { ascending: false })
          .limit(5);
        if (rows && rows.length > 0) {
          if (queryNome && rows.length > 1) {
            const matched = rows.find((r: { nome_pagador?: string }) => (r.nome_pagador || "").toLowerCase().includes(queryNome));
            transactionFound = matched || rows[0];
          } else {
            transactionFound = rows[0];
          }
        }
      }

      // 2. Reconciliação direta com Mercado Pago se não localizado no banco
      if (!transactionFound && (queryTxid || queryPaymentId) && isMpConfigured()) {
        try {
          let mpItem = null;
          const targetId = queryPaymentId || queryTxid;
          const cleanId = String(targetId).replace(/^PAY/i, "");
          if (/^\d+$/.test(cleanId)) {
            mpItem = await mpConsultarPagamentoPorId(cleanId);
          }
          if (!mpItem && queryTxid) {
            mpItem = await mpConsultarPagamentoPorExternalReference(queryTxid);
          }

          if (mpItem) {
            const isApproved = mpItem.status === "approved";
            const extRef = mpItem.external_reference || queryTxid;

            if (isApproved) {
              const reconcileResult = await confirmarPagamentoResiliente({
                txid: extRef,
                gateway: "mercadopago_reconcile_recovery",
                payload: mpItem,
                executado_por: "recovery_reconciler"
              });
              transactionFound = reconcileResult.paymentRecord || {
                txid: extRef,
                payment_id: String(mpItem.id),
                status: "approved",
                valor: Number(mpItem.transaction_amount),
                email: mpItem.payer?.email,
                nome_pagador: `${mpItem.payer?.first_name || ""} ${mpItem.payer?.last_name || ""}`.trim() || "Participante EJC",
                pago_em: mpItem.date_approved || new Date().toISOString()
              };
            } else {
              const detectedMethod = (mpItem.payment_type_id === "credit_card" || String(extRef).startsWith("CARD"))
                ? "credit_card"
                : (mpItem.payment_type_id || "pix");

              transactionFound = {
                txid: extRef,
                payment_id: String(mpItem.id),
                status: mpItem.status || "pending",
                status_detail: mpItem.status_detail || "",
                metodo: detectedMethod,
                valor: Number(mpItem.transaction_amount),
                email: mpItem.payer?.email || null,
                nome_pagador: `${mpItem.payer?.first_name || ""} ${mpItem.payer?.last_name || ""}`.trim() || "Participante EJC",
                criado_em: mpItem.date_created || new Date().toISOString(),
                pago_em: mpItem.date_approved || null,
                cartao_ultimos_digitos: mpItem.card?.last_four_digits || null,
                cartao_bandeira: mpItem.payment_method_id || null,
                parcelas: mpItem.installments || 1,
                metadata: {
                  payment_id: String(mpItem.id),
                  external_reference: extRef,
                  status_detail: mpItem.status_detail,
                  order_id: mpItem.order?.id || null,
                  gateway: "mercadopago"
                }
              };

              await persistirTransacaoSupabase({
                txid: extRef,
                nome_pagador: String(transactionFound.nome_pagador),
                email: String(transactionFound.email || ""),
                valor: Number(transactionFound.valor),
                metodo: detectedMethod,
                parcelas: Number(transactionFound.parcelas || 1),
                cartao_ultimos_digitos: transactionFound.cartao_ultimos_digitos as string | null,
                cartao_bandeira: transactionFound.cartao_bandeira as string | null,
                status: String(transactionFound.status),
                metadata: transactionFound.metadata as Record<string, unknown>
              }).catch((e) => console.warn("[Reconcile Recovery] Sync Supabase error:", e instanceof Error ? e.message : String(e)));
            }
          }
        } catch (eMpRecovery) {
          console.warn("[Checkout GET MP Recovery Error]", eMpRecovery instanceof Error ? eMpRecovery.message : String(eMpRecovery));
        }
      }

      if (!transactionFound) {
        return jsonResponse(
          {
            success: false,
            error: "Nenhum pagamento correspondente foi localizado.",
            status: "not_found"
          },
          404,
          req
        );
      }

      const isManual = transactionFound.modalidade_pix === "manual" || (transactionFound.metadata as Record<string, unknown>)?.modalidade_pix === "manual";

      // 3. Reconciliação Server-Side no Polling se transação estiver pending/in_process
      if (!isManual && (transactionFound.status === "pending" || transactionFound.status === "in_process" || !transactionFound.status)) {
        if (isMpConfigured()) {
          try {
            let approvedItem = null;
            const targetTxid = String(transactionFound.txid || queryTxid);
            if (targetTxid) {
              approvedItem = await mpConsultarPagamentoPorExternalReference(targetTxid);
            }
            if (!approvedItem) {
              const targetPaymentId = queryPaymentId || transactionFound.payment_id || (transactionFound.metadata as Record<string, unknown>)?.payment_id || queryTxid;
              const cleanId = String(targetPaymentId || "").replace(/^PAY/i, "");
              if (/^\d+$/.test(cleanId)) {
                approvedItem = await mpConsultarPagamentoPorId(cleanId);
              }
            }

            if (approvedItem) {
              if (approvedItem.status === "approved") {
                console.log(`[CHECKOUT_PRO_APPROVED] TXID=${approvedItem.external_reference || transactionFound.txid || queryTxid}, PaymentId=${approvedItem.id}`);
                const reconcileResult = await confirmarPagamentoResiliente({
                  txid: approvedItem.external_reference || String(transactionFound.txid || queryTxid),
                  gateway: "mercadopago_polling_reconciler",
                  payload: approvedItem,
                  executado_por: "polling_server_reconciler"
                });
                if (reconcileResult.paymentRecord) {
                  transactionFound = reconcileResult.paymentRecord;
                } else {
                  transactionFound.status = "approved";
                  transactionFound.pago_em = approvedItem.date_approved || new Date().toISOString();
                }
              } else if (approvedItem.status && approvedItem.status !== transactionFound.status) {
                const isCurrentlyApproved = transactionFound.status === "approved" || transactionFound.status === "confirmado" || transactionFound.status === "paid";
                if (!isCurrentlyApproved) {
                  transactionFound.status = approvedItem.status;
                  transactionFound.status_detail = approvedItem.status_detail;
                  if (approvedItem.status === "rejected" || approvedItem.status === "cancelled") {
                    const targetTx = approvedItem.external_reference || transactionFound.txid || queryTxid;
                    const statusInsc = (approvedItem.status === "rejected") ? "recusado" : "cancelado";
                    const agoraIso = new Date().toISOString();
                    await Promise.all([
                      supabase.from("pagamentos").update({ status: approvedItem.status, atualizado_em: agoraIso }).eq("txid", String(targetTx)),
                      supabase.from("inscricoes").update({ pagamento_status: statusInsc }).eq("id", String(transactionFound.inscricao_id || targetTx))
                    ]).catch(() => {});
                  }
                }
              }
            }
          } catch (eGw) {
            console.warn("[Polling Reconciler] Aviso MP:", eGw instanceof Error ? eGw.message : String(eGw));
          }
        }
      }

      // 4. Obtém link oficial do WhatsApp exclusivo da Sub (REGRA OP10 FASE 11: Sem fallback indevido para Geral)
      const sub = (transactionFound.metadata as Record<string, unknown>)?.sub || transactionFound.sub || "Geral";
      let whatsappLink = "";
      try {
        const subKey = String(sub).trim().toLowerCase();
        
        // 1. Busca link exclusivo da Sub em configuracoes_whatsapp
        const { data: wppRows } = await supabase
          .from("configuracoes_whatsapp")
          .select("sub, link_grupo")
          .eq("ativo", true);

        if (Array.isArray(wppRows) && wppRows.length > 0) {
          const matchSub = wppRows.find((w: { sub: string }) => String(w.sub).trim().toLowerCase() === subKey);
          if (matchSub && matchSub.link_grupo && String(matchSub.link_grupo).trim().startsWith("http")) {
            whatsappLink = String(matchSub.link_grupo).trim();
          }
        }

        // 2. Se não encontrou e é uma Sub oficial, busca diretamente na tabela subs
        if (!whatsappLink && ["verde", "vermelho", "amarelo", "laranja"].includes(subKey)) {
          const { data: subData } = await supabase
            .from("subs")
            .select("link_whatsapp")
            .ilike("nome", subKey)
            .maybeSingle();

          if (subData && subData.link_whatsapp && String(subData.link_whatsapp).trim().startsWith("http")) {
            whatsappLink = String(subData.link_whatsapp).trim();
          }
        }

        // 3. Fallback para 'Geral' SOMENTE se a transação for explicitamente Geral/sem sub definida
        if (!whatsappLink && (!sub || subKey === "geral" || !["verde", "vermelho", "amarelo", "laranja"].includes(subKey))) {
          const generalMatch = (wppRows || []).find((w: { sub: string }) => String(w.sub).trim().toLowerCase() === "geral");
          if (generalMatch && generalMatch.link_grupo && String(generalMatch.link_grupo).trim().startsWith("http")) {
            whatsappLink = String(generalMatch.link_grupo).trim();
          }
        }
      } catch (eWpp) {
        console.warn("[Checkout Process GET] Erro ao resolver WhatsApp:", eWpp instanceof Error ? eWpp.message : String(eWpp));
      }

      const realStatusDetail = (transactionFound.status_detail || (transactionFound.metadata as Record<string, unknown>)?.status_detail || null) as string | null;
      const detectedMetodo = transactionFound.metodo || (String(transactionFound.txid || "").startsWith("CARD") ? "credit_card" : "pix");
      const realPaymentId = transactionFound.payment_id || (transactionFound.metadata as Record<string, unknown>)?.payment_id || transactionFound.gateway_transaction_id || (detectedMetodo === "credit_card" ? null : transactionFound.txid);

      const responsePayload = {
        success: true,
        txid: transactionFound.txid,
        payment_id: realPaymentId,
        order_id: transactionFound.order_id || (transactionFound.metadata as Record<string, unknown>)?.order_id || null,
        external_reference: transactionFound.external_reference || (transactionFound.metadata as Record<string, unknown>)?.external_reference || transactionFound.txid,
        modalidade_pix: isManual ? "manual" : "api_webhook",
        status: transactionFound.status || (isManual ? "aguardando_analise" : "pending"),
        status_detail: realStatusDetail,
        mensagem_usuario: getFriendlyCardErrorMessage(realStatusDetail, transactionFound.status as string) || null,
        status_analise_manual: transactionFound.status_analise_manual || (transactionFound.metadata as Record<string, unknown>)?.status_analise_manual || (isManual ? "pendente" : null),
        comprovante_caminho: transactionFound.comprovante_caminho || (transactionFound.metadata as Record<string, unknown>)?.comprovante_url || null,
        comprovante_enviado: Boolean(transactionFound.comprovante_caminho || (transactionFound.metadata as Record<string, unknown>)?.comprovante_url || (transactionFound.metadata as Record<string, unknown>)?.comprovante_caminho),
        pago: transactionFound.status === "approved" || transactionFound.status === "confirmado" || transactionFound.status === "paid",
        pago_em: transactionFound.pago_em || null,
        criado_em: transactionFound.criado_em || null,
        metodo: detectedMetodo,
        valor: Number(transactionFound.valor),
        nome: transactionFound.nome_pagador,
        email: transactionFound.email,
        sub: sub,
        lote: (transactionFound.metadata as Record<string, unknown>)?.lote || transactionFound.lote || "1º Lote",
        parcelas: transactionFound.parcelas || (transactionFound.metadata as Record<string, unknown>)?.parcelas || 1,
        cartao_bandeira: transactionFound.cartao_bandeira || (transactionFound.metadata as Record<string, unknown>)?.bandeira || null,
        cartao_ultimos_digitos: transactionFound.cartao_ultimos_digitos || (transactionFound.metadata as Record<string, unknown>)?.ultimos_digitos || null,
        inscricao_id: transactionFound.inscricao_id || null,
        comprovante_email_enviado: Boolean(transactionFound.comprovante_email_enviado),
        comprovante_email_em: transactionFound.comprovante_email_em || null,
        comprovante_email_erro: transactionFound.comprovante_email_erro || null,
        whatsapp_link: whatsappLink,
        whatsapp_sub_url: whatsappLink,
        payment: {}
      };
      responsePayload.payment = { ...responsePayload };

      return jsonResponse(responsePayload, 200, req);
    } catch (err) {
      console.error("[Checkout Process GET Exception]", err);
      return jsonResponse({ error: "Falha interna ao consultar status da transação." }, 500, req);
    }
  }

  // ============================================================================
  // FLUXO POST: INICIAÇÃO / PROCESSAMENTO DE PAGAMENTO
  // ============================================================================
  if (req.method !== "POST") {
    return jsonResponse({ error: "Método não permitido" }, 405, req);
  }

  try {
    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch (_) {
      return jsonResponse({ error: "Payload JSON inválido" }, 400, req);
    }

    const {
      action,
      metodo,
      valor,
      nome,
      nome_completo,
      email,
      whatsapp,
      cpf,
      tipo,
      sub,
      inscricao_id,
      token,
      cartao_token,
      issuer_id,
      payment_method_id,
      installments,
      cartao_ultimos_digitos,
      cartao_bandeira,
      parcelas,
      txid: bodyTxid,
      gateway: bodyGateway,
      executado_por: bodyExecutadoPor
    } = body;

    // --------------------------------------------------------------------------
    // AÇÃO 1: CONFIRMAÇÃO MANUAL / RECONCILIAÇÃO (EXIGE SUPERADMIN OU FINANCEIRO)
    // --------------------------------------------------------------------------
    if (action === "confirm_payment" || action === "verificar_pagamento" || action === "reconciliar") {
      const auth = await authenticateAdmin(req, body);
      if (!auth.ok) {
        return jsonResponse({ error: "Acesso não autorizado: credenciais administrativas necessárias." }, 401, req);
      }
      if (auth.role !== "superadmin" && auth.role !== "financeiro") {
        return jsonResponse({ error: "Seu perfil não possui autorização para esta ação." }, 403, req);
      }

      const targetTxid = bodyTxid || body.id || body.payment_id || body.order_id || body.external_reference;
      if (!targetTxid) {
        return jsonResponse({ error: "Identificador (TXID, Payment ID ou Order ID) obrigatório para confirmar pagamento." }, 400, req);
      }

      const confirmResult = await confirmarPagamentoResiliente({
        txid: String(targetTxid),
        gateway: (bodyGateway as string) || "manual_admin",
        payload: (body.payload as Record<string, unknown>) || {},
        executado_por: (bodyExecutadoPor as string) || "admin_confirm"
      });
      return jsonResponse(confirmResult, 200, req);
    }

    // --------------------------------------------------------------------------
    // AÇÃO 2: REENVIO DE COMPROVANTE POR E-MAIL / EMAIL-COMPROVANTE
    // --------------------------------------------------------------------------
    if (action === "resend_receipt" || action === "email_comprovante" || action === "enviar_email_comprovante") {
      const targetTxid = bodyTxid || body.id || body.payment_id || body.order_id || body.external_reference;
      const targetEmail = email ? String(email).trim().toLowerCase() : null;

      if (!targetTxid && !targetEmail) {
        return jsonResponse({ error: "Informe o TXID, Payment ID ou E-mail para reenviar o comprovante." }, 400, req);
      }

      let transactionFound: Record<string, unknown> | null = null;
      if (targetTxid) {
        const { data: rows } = await supabase.from("pagamentos").select("*").eq("txid", String(targetTxid)).limit(1);
        if (rows && rows.length > 0) transactionFound = rows[0];
      } else if (targetEmail) {
        const { data: rows } = await supabase.from("pagamentos").select("*").eq("email", targetEmail).order("criado_em", { ascending: false }).limit(1);
        if (rows && rows.length > 0) transactionFound = rows[0];
      }

      if (!transactionFound) {
        return jsonResponse({ error: "Transação não encontrada para envio de comprovante." }, 404, req);
      }

      const emailDestino = transactionFound.email || targetEmail;
      let emailResult = { success: false };

      try {
        const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
        const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
        const shouldForce = Boolean(body.force_resend);
        const resEmail = await fetch(`${supabaseUrl.replace(/\/$/, "")}/functions/v1/send-email`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${serviceKey}` },
          body: JSON.stringify({
            event_type: "payment_approved",
            txid: transactionFound.txid,
            force_resend: shouldForce,
            origem_aprovacao: "receipt_request"
          }),
          signal: AbortSignal.timeout(10000)
        });
        emailResult = await resEmail.json().catch(() => ({ success: false }));
      } catch (_) {}

      return jsonResponse({
        success: true,
        message: `Comprovante processado com sucesso para ${emailDestino}.`,
        email_result: emailResult
      }, 200, req);
    }

    // --------------------------------------------------------------------------
    // AÇÃO 3: ENVIO DE COMPROVANTE DO PIX MANUAL (MESMA TELA DO CHECKOUT)
    // --------------------------------------------------------------------------
    if (action === "enviar_comprovante_manual" || action === "upload_comprovante") {
      try {
        const targetTxid = bodyTxid || body.id || body.payment_id || body.external_reference;
        const comprovanteCaminho = body.comprovante_caminho || body.comprovante_url || body.comprovante_base64 || body.comprovanteBase64;

        if (!targetTxid) {
          return jsonResponse({ error: "Identificador da transação (TXID) é obrigatório." }, 400, req);
        }
        if (!comprovanteCaminho || typeof comprovanteCaminho !== "string") {
          return jsonResponse({ error: "Arquivo ou link do comprovante é obrigatório." }, 400, req);
        }

        const agora = new Date().toISOString();
        let comprovanteUrlFinal = comprovanteCaminho;

        // Upload para Supabase Storage se for base64
        if (comprovanteCaminho.startsWith("data:")) {
          try {
            const matches = comprovanteCaminho.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
            if (matches && matches.length === 3) {
              const mimeType = matches[1];
              const base64Data = matches[2];
              const binaryString = atob(base64Data);
              const bytes = new Uint8Array(binaryString.length);
              for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
              }

              const fileExt = mimeType.includes("pdf") ? "pdf" : "png";
              const storagePath = `comprovantes/manual_${targetTxid}_${Date.now()}.${fileExt}`;

              const { data: uploadData, error: uploadErr } = await supabase.storage
                .from("fotos")
                .upload(storagePath, bytes, { contentType: mimeType, upsert: true });

              if (!uploadErr && uploadData) {
                const { data: publicUrlData } = supabase.storage.from("fotos").getPublicUrl(storagePath);
                comprovanteUrlFinal = publicUrlData.publicUrl;
              }
            }
          } catch (eStorage) {
            console.warn("[enviar_comprovante_manual] Storage upload fallback:", eStorage instanceof Error ? eStorage.message : String(eStorage));
          }
        }

        // Atualiza pagamentos com comprovante no metadata
        try {
          const { data: existingPag } = await supabase
            .from("pagamentos")
            .select("metadata")
            .eq("txid", String(targetTxid))
            .limit(1);

          const currentMeta = (existingPag && existingPag.length > 0 && existingPag[0].metadata)
            ? existingPag[0].metadata
            : {};

          await supabase.from("pagamentos").update({
            status: "aguardando_analise",
            atualizado_em: agora,
            metadata: {
              ...currentMeta,
              comprovante_url: comprovanteUrlFinal,
              status_analise_manual: "pendente"
            }
          }).eq("txid", String(targetTxid));
        } catch (ePagUpdate) {
          console.warn("[enviar_comprovante_manual] Aviso pagamentos update:", ePagUpdate instanceof Error ? ePagUpdate.message : String(ePagUpdate));
        }

        // Atualiza inscricoes se vinculado por email
        if (email) {
          try {
            await supabase.from("inscricoes").update({
              comprovante_caminho: comprovanteUrlFinal,
              pagamento_status: "aguardando_analise"
            }).eq("email", String(email).trim().toLowerCase());
          } catch (_) {}
        }

        // Dispara alerta administrativo idempotente via send-email Edge Function
        try {
          const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
          const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
          await fetch(`${supabaseUrl.replace(/\/$/, "")}/functions/v1/send-email`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${serviceKey}` },
            body: JSON.stringify({
              event_type: "admin_manual_proof_alert",
              txid: String(targetTxid),
              proof_url: comprovanteUrlFinal
            }),
            signal: AbortSignal.timeout(10000)
          }).catch(() => {});
        } catch (_) {}

        // Registra auditoria
        try {
          await supabase.from("auditoria_transacoes").insert({
            transacao_id: String(targetTxid),
            acao: "MANUAL_PROOF_UPLOADED",
            status_anterior: null,
            status_novo: "aguardando_analise",
            executado_por: String(nome || email || "participante"),
            detalhes: { txid: targetTxid, comprovante_url: comprovanteUrlFinal }
          });
        } catch (_) {}

        return jsonResponse({
          success: true,
          persisted: true,
          status: "aguardando_analise",
          status_analise_manual: "pendente",
          comprovante_caminho: comprovanteUrlFinal,
          message: "Comprovante enviado para análise pela coordenação."
        }, 200, req);
      } catch (errManual) {
        console.error("[enviar_comprovante_manual] Erro:", errManual);
        return jsonResponse({
          success: false,
          error: "Falha ao processar comprovante manual",
          detail: errManual instanceof Error ? errManual.message : String(errManual)
        }, 500, req);
      }
    }

    // --------------------------------------------------------------------------
    // AÇÃO 4: CRIAÇÃO DE PAGAMENTO (PIX OU CARTÃO DE CRÉDITO)
    // --------------------------------------------------------------------------
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) {
      return jsonResponse({ error: "E-mail válido e obrigatório para envio do comprovante." }, 400, req);
    }

    const VALID_SUBS = ["Verde", "Vermelho", "Amarelo", "Laranja"];
    let subFinal: string | null = null;

    if (tipo === "inscricao") {
      let rawSub = sub ? String(sub).trim() : "";
      if (rawSub.toLowerCase() === "azul") rawSub = "Laranja";

      // Validação autoritativa da inscrição no banco contra adulteração de Sub (Anti-Tampering)
      const validUuid = safeUuidOrNull(inscricao_id);
      if (validUuid) {
        const { data: inscRows, error: inscErr } = await supabase
          .from("inscricoes")
          .select("id, sub, nome_completo, email, pagamento_status, arquivado")
          .eq("id", validUuid)
          .limit(1);

        if (inscErr || !inscRows || inscRows.length === 0) {
          return jsonResponse({
            error: "Inscrição não localizada no sistema. Verifique o identificador ou realize uma nova inscrição."
          }, 404, req);
        }

        const inscRecord = inscRows[0];
        if (inscRecord.arquivado) {
          return jsonResponse({
            error: "Esta inscrição está arquivada e não pode receber pagamentos."
          }, 400, req);
        }

        const inscStatus = String(inscRecord.pagamento_status || "").toLowerCase().trim();
        if (inscStatus === "approved" || inscStatus === "confirmado" || inscStatus === "pago") {
          return jsonResponse({
            error: "Esta inscrição já possui um pagamento aprovado/confirmado. Não é necessário realizar um novo pagamento."
          }, 400, req);
        }

        // Se está marcada como 'cancelado', verificar se é Pix expirado elegível ou cancelamento definitivo
        if (inscStatus === "cancelado") {
          const isCancelamentoManual = !!inscRecord.motivo_arquivamento;
          if (isCancelamentoManual) {
            return jsonResponse({
              error: "Esta inscrição possui cancelamento administrativo e não pode receber pagamentos."
            }, 400, req);
          }

          // Verificar se não há nenhum pagamento aprovado anterior
          const { data: approvedCheck } = await supabase
            .from("pagamentos")
            .select("id")
            .eq("inscricao_id", validUuid)
            .in("status", ["approved", "confirmado", "pago"])
            .limit(1);

          if (approvedCheck && approvedCheck.length > 0) {
            return jsonResponse({
              error: "Esta inscrição já possui um pagamento aprovado no sistema."
            }, 400, req);
          }

          // Revalidar se a vaga da Sub ainda está dentro do limite oficial de 85
          const { data: subCountData } = await supabase.rpc("contagem_inscricoes_por_sub");
          if (Array.isArray(subCountData)) {
            const subRow = subCountData.find((s: any) => String(s.sub || "").toLowerCase() === String(inscRecord.sub || "").toLowerCase());
            const currentTotal = subRow ? Number(subRow.total || 0) : 0;
            if (currentTotal >= 85) {
              return jsonResponse({
                error: `As vagas para o Sub ${inscRecord.sub} estão atualmente esgotadas (85/85). Entre em contato com a coordenação.`
              }, 400, req);
            }
          }

          console.log(`[RECUPERACAO_PIX_EXPIRADO] Inscrição ${validUuid} (${inscRecord.nome_completo}, Sub ${inscRecord.sub}) autorizada para nova tentativa de pagamento.`);
        }

        // Se o cliente forneceu Sub, deve coincidir estritamente com o Sub registrado
        if (rawSub && rawSub.toLowerCase() !== String(inscRecord.sub || "").toLowerCase()) {
          return jsonResponse({
            error: `O Sub informado (${rawSub}) diverge do Sub registrado na inscrição (${inscRecord.sub}). Alteração não permitida no checkout.`
          }, 400, req);
        }

        // Sub autoritativo vem da inscrição
        rawSub = inscRecord.sub;
      }

      const matchedSub = VALID_SUBS.find((s) => s.toLowerCase() === rawSub.toLowerCase());
      if (!matchedSub) {
        return jsonResponse({
          error: "Sub inválido ou não selecionado. A escolha do Sub é obrigatória para prosseguir com a inscrição."
        }, 400, req);
      }
      subFinal = matchedSub;

      // Idempotência: impede nova cobrança se inscrição já aprovada
      const cleanEmail = String(email).trim().toLowerCase();
      let checkQuery = supabase.from("pagamentos").select("id, status").in("status", ["approved", "confirmado", "paid"]).limit(1);
      if (inscricao_id) {
        checkQuery = checkQuery.eq("inscricao_id", String(inscricao_id));
      } else {
        checkQuery = checkQuery.eq("email", cleanEmail).eq("metadata->>sub", subFinal);
      }

      const { data: paidRows } = await checkQuery;
      if (paidRows && paidRows.length > 0) {
        return jsonResponse({
          error: "Esta inscrição já possui um pagamento aprovado/confirmado. Não é necessário realizar um novo pagamento."
        }, 400, req);
      }
    } else {
      subFinal = sub ? String(sub).trim() : null;
    }

    const nomeFinal = String(nome || nome_completo || "Participante").trim();
    const metodoFinal = (action === "processar_cartao_mp" || token || cartao_token)
      ? "credit_card"
      : String(metodo || "pix").toLowerCase();

    const ts36 = Date.now().toString(36).toUpperCase();
    const rnd4 = Math.random().toString(36).substring(2, 6).toUpperCase();
    const orderId = `ORD${ts36}${rnd4}`;
    let paymentId = `PAY${ts36}${rnd4}`;
    const txid = (metodoFinal === "credit_card" ? "CARD" : "PIX") + ts36 + rnd4;
    const externalReference = txid;

    // Resolução da configuração financeira ativa (PostgreSQL é autoridade única)
    const financialConfig = await getActiveFinancialSettings();
    let valorNumerico: number;

    if (tipo === "inscricao") {
      if (!financialConfig.preco_efetivo || isNaN(financialConfig.preco_efetivo) || financialConfig.preco_efetivo <= 0) {
        return jsonResponse({
          error: "A taxa de inscrição ainda não foi configurada pela coordenação. Aguarde a abertura do lote para realizar o pagamento.",
          configurado: false
        }, 400, req);
      }
      valorNumerico = Number(financialConfig.preco_efetivo.toFixed(2));
    } else {
      const reqValorNum = (valor !== undefined && valor !== null && !isNaN(Number(valor)) && Number(valor) > 0)
        ? Number(Number(valor).toFixed(2))
        : null;
      valorNumerico = reqValorNum || Number(financialConfig.preco_efetivo || 0);
      if (isNaN(valorNumerico) || valorNumerico <= 0) {
        return jsonResponse({ error: "Valor da contribuição inválido." }, 400, req);
      }
    }

    // --------------------------------------------------------------------------
    // PROCESSAMENTO PIX
    // --------------------------------------------------------------------------
    if (metodoFinal === "pix") {
      const modalidadePix = financialConfig.modalidade_pix === "manual" ? "manual" : "api_webhook";
      const tempoExpiracao = 15;
      const expiracao = new Date(Date.now() + tempoExpiracao * 60000).toISOString();

      let payloadPix = "";
      let qrCodeBase64: string | null = null;
      let ticketUrl: string | null = null;
      let mpGenerated = false;
      let mpPaymentId: string | null = null;
      let initialStatus = "pending";
      let manualDetails: Record<string, unknown> | null = null;

      if (modalidadePix === "api_webhook") {
        if (isMpConfigured()) {
          try {
            const descricaoCob = tipo === "inscricao" ? `Inscrição EJC Trânsito ${financialConfig.lote_atual}` : "Contribuição EJC Trânsito";
            const notificationUrl = getWebhookNotificationUrl();

            const mpResult = await mpCriarPagamentoPix({
              valor: valorNumerico,
              nome: nomeFinal,
              email: String(email).trim().toLowerCase(),
              cpf: cpf ? String(cpf) : null,
              txid: txid,
              descricao: descricaoCob,
              notificationUrl
            });

            if (mpResult && mpResult.qr_code) {
              payloadPix = mpResult.qr_code;
              qrCodeBase64 = mpResult.qr_code_base64 || null;
              ticketUrl = mpResult.ticket_url || null;
              paymentId = `PAY${mpResult.id}`;
              mpPaymentId = mpResult.id ? String(mpResult.id) : null;
              mpGenerated = true;
              initialStatus = "pending";
              console.log(`[CHECKOUT_PIX_DIAGNOSTICO] ORIGEM_QR=MERCADO_PAGO | PAYMENT_ID=${mpPaymentId} | EXTERNAL_REFERENCE=${txid}`);
            } else {
              throw new Error("Mercado Pago retornou resposta sem qr_code oficial.");
            }
          } catch (mpErr) {
            console.error("[Checkout Process Edge] Falha MP:", mpErr instanceof Error ? mpErr.message : String(mpErr));
            return jsonResponse({
              error: "Não foi possível gerar a cobrança Pix via Mercado Pago neste momento. Tente novamente em instantes.",
              detail: mpErr instanceof Error ? mpErr.message : String(mpErr)
            }, 400, req);
          }
        } else {
          return jsonResponse({
            error: "Modalidade Pix via API ativa, porém MERCADOPAGO_ACCESS_TOKEN não está configurado na Edge Function.",
            hint: "Configure o segredo MERCADOPAGO_ACCESS_TOKEN no Supabase."
          }, 400, req);
        }
      }

      if (modalidadePix === "manual") {
        if (!financialConfig.pix_chave) {
          return jsonResponse({ error: "A chave Pix ainda não foi configurada pela coordenação.", configurado: false }, 400, req);
        }
        initialStatus = "aguardando_analise";
        payloadPix = financialConfig.pix_chave;
        manualDetails = {
          chave: financialConfig.pix_chave,
          tipo_chave: financialConfig.pix_tipo_chave,
          beneficiario: financialConfig.pix_beneficiario,
          cidade: financialConfig.pix_cidade,
          instrucoes: financialConfig.pix_instrucoes_manual,
          permite_comprovante: financialConfig.pix_permite_comprovante
        };
        console.log(`[CHECKOUT_PIX_DIAGNOSTICO] ORIGEM_PIX=MANUAL | TXID=${txid}`);
      }

      // Persiste no Supabase
      await persistirTransacaoSupabase({
        txid: txid,
        nome_pagador: nomeFinal,
        email: String(email).trim().toLowerCase(),
        whatsapp_pagador: whatsapp ? String(whatsapp) : null,
        cpf_pagador: cpf ? String(cpf) : null,
        valor: valorNumerico,
        metodo: "pix",
        parcelas: 1,
        cartao_ultimos_digitos: null,
        cartao_bandeira: null,
        status: initialStatus,
        tipo: tipo ? String(tipo) : "inscricao",
        pix_copia_e_cola: payloadPix,
        qr_code_base64: qrCodeBase64,
        expiracao: expiracao,
        inscricao_id: safeUuidOrNull(inscricao_id),
        metadata: {
          order_id: orderId,
          payment_id: paymentId,
          external_reference: externalReference,
          sub: subFinal,
          modalidade_pix: modalidadePix,
          status_analise_manual: modalidadePix === "manual" ? "pendente" : null,
          gerado_via: mpGenerated ? "api_mercadopago" : "pix_manual",
          provedor: mpGenerated ? "mercadopago" : "pix_manual",
          ticket_url: ticketUrl,
          lote: financialConfig.lote_atual,
          inscricao_id: inscricao_id || null
        }
      });

      // Se era uma inscrição existente (recuperação de Pix expirado), reativar para 'pendente'
      if (validUuid) {
        try {
          await supabase
            .from("inscricoes")
            .update({
              pagamento_status: "pendente",
              forma_pagamento: "pix",
              observacao_pagamento: `Nova tentativa de Pix gerada (${txid}) em ${new Date().toISOString()}`
            })
            .eq("id", validUuid);

          await supabase.from("auditoria_transacoes").insert({
            transacao_id: txid,
            acao: "RECUPERACAO_PIX_EXPIRADO",
            status_anterior: "cancelado",
            status_novo: "pendente",
            executado_por: "checkout_participante",
            detalhes: {
              inscricao_id: validUuid,
              nome: nomeFinal,
              sub: subFinal,
              metodo: "pix"
            }
          });
        } catch (auditErr) {
          console.warn("[checkout-process] Falha não impeditiva no registro de auditoria:", auditErr);
        }
      }

      return jsonResponse({
        success: true,
        metodo: "pix",
        modalidade_pix: modalidadePix,
        txid: txid,
        payment_id: paymentId,
        mp_payment_id: mpPaymentId,
        order_id: orderId,
        external_reference: externalReference,
        valor: valorNumerico,
        chave: (modalidadePix === "manual") ? financialConfig.pix_chave : null,
        pixCopiaECola: payloadPix,
        pix_copia_cola: payloadPix,
        payload: payloadPix,
        qr_code_base64: qrCodeBase64,
        ticket_url: ticketUrl,
        provedor: mpGenerated ? "mercadopago" : "pix_manual",
        expiracao: expiracao,
        status: initialStatus,
        status_analise_manual: modalidadePix === "manual" ? "pendente" : null,
        manual_details: manualDetails
      }, 200, req);
    }

    // --------------------------------------------------------------------------
    // PROCESSAMENTO CARTÃO DE CRÉDITO
    // --------------------------------------------------------------------------
    if (metodoFinal === "credit_card" || metodoFinal === "credit_card_pro") {
      const cardMaxInst = financialConfig.card_max_installments || 6;
      const valorFinalCobranca = valorNumerico;

      console.log(`[CHECKOUT_PRO_CREATE_START] TXID: ${txid}, Valor: R$ ${valorFinalCobranca.toFixed(2)}, Sub: ${subFinal || "Geral"}`);

      if (isMpConfigured()) {
        try {
          // Se recebemos token direto de cartão (Card Brick / processar_cartao_mp):
          const cardToken = (token || cartao_token) as string | undefined;
          if (cardToken) {
            console.log(`[PROCESSAR_CARTAO_MP] Processando cobrança direta com token para TXID ${txid}...`);
            const mpCardRes = await mpCriarPagamentoCartao({
              token: cardToken,
              transaction_amount: valorFinalCobranca,
              installments: Math.max(1, parseInt(String(installments || parcelas || 1), 10) || 1),
              payment_method_id: payment_method_id ? String(payment_method_id) : undefined,
              issuer_id: issuer_id ? String(issuer_id) : undefined,
              payer: {
                email: String(email).trim().toLowerCase(),
                identification: cpf ? { type: "CPF", number: String(cpf) } : undefined
              },
              txid: txid,
              description: `Inscrição EJC Trânsito ${financialConfig.lote_atual}`,
              notification_url: getWebhookNotificationUrl()
            });

            const isCardApproved = mpCardRes.status === "approved";
            if (isCardApproved) {
              await confirmarPagamentoResiliente({
                txid: txid,
                gateway: "mercadopago_credit_card",
                payload: mpCardRes.raw as Record<string, unknown>,
                executado_por: "card_brick"
              });
            } else {
              await persistirTransacaoSupabase({
                txid: txid,
                nome_pagador: nomeFinal,
                email: String(email).trim().toLowerCase(),
                whatsapp_pagador: whatsapp ? String(whatsapp) : null,
                cpf_pagador: cpf ? String(cpf) : null,
                valor: valorFinalCobranca,
                metodo: "credit_card",
                parcelas: mpCardRes.installments || 1,
                cartao_ultimos_digitos: mpCardRes.card?.last_four_digits || null,
                cartao_bandeira: mpCardRes.payment_method_id || null,
                status: mpCardRes.status,
                tipo: tipo ? String(tipo) : "inscricao",
                inscricao_id: safeUuidOrNull(inscricao_id),
                metadata: {
                  payment_id: mpCardRes.id,
                  external_reference: txid,
                  status_detail: mpCardRes.status_detail,
                  sub: subFinal,
                  lote: financialConfig.lote_atual
                }
              });
            }

            return jsonResponse({
              success: true,
              metodo: "credit_card",
              provedor: "mercadopago_direct_card",
              txid: txid,
              payment_id: mpCardRes.id,
              status: mpCardRes.status,
              status_detail: mpCardRes.status_detail,
              mensagem_usuario: getFriendlyCardErrorMessage(mpCardRes.status_detail, mpCardRes.status),
              valor: valorFinalCobranca
            }, 200, req);
          }

          // Fluxo padrão: Checkout Pro Preferência Hospedada
          const publicBase = getPublicBaseUrl();
          const prefResult = await mpCriarPreferenciaCheckoutPro({
            txid: txid,
            valor: valorFinalCobranca,
            nome: nomeFinal,
            email: String(email).trim().toLowerCase(),
            telefone: whatsapp ? String(whatsapp) : null,
            descricao: tipo === "inscricao" ? `Inscrição EJC Trânsito ${financialConfig.lote_atual} (${subFinal || "Geral"})` : "Contribuição EJC Trânsito",
            maxParcelas: cardMaxInst,
            notificationUrl: getWebhookNotificationUrl(),
            backUrls: {
              success: `${publicBase}/checkout.html?retorno_mp=success&txid=${encodeURIComponent(txid)}`,
              pending: `${publicBase}/checkout.html?retorno_mp=pending&txid=${encodeURIComponent(txid)}`,
              failure: `${publicBase}/checkout.html?retorno_mp=failure&txid=${encodeURIComponent(txid)}`
            }
          });

          console.log(`[CHECKOUT_PRO_CREATE_SUCCESS] TXID: ${txid}, Preference ID: ${prefResult.id}`);

          const dbPersistRes = await persistirTransacaoSupabase({
            txid: txid,
            nome_pagador: nomeFinal,
            email: String(email).trim().toLowerCase(),
            whatsapp_pagador: whatsapp ? String(whatsapp) : null,
            cpf_pagador: cpf ? String(cpf) : null,
            valor: valorFinalCobranca,
            metodo: "credit_card",
            parcelas: 1,
            cartao_ultimos_digitos: null,
            cartao_bandeira: "Cartão",
            status: "pending",
            tipo: tipo ? String(tipo) : "inscricao",
            expiracao: new Date(Date.now() + 86400000).toISOString(),
            inscricao_id: safeUuidOrNull(inscricao_id),
            metadata: {
              order_id: orderId,
              preference_id: prefResult.id,
              init_point: prefResult.init_point,
              checkout_url: prefResult.init_point,
              external_reference: txid,
              sub: subFinal,
              lote: financialConfig.lote_atual,
              provedor: "mercadopago_checkout_pro",
              inscricao_id: safeUuidOrNull(inscricao_id)
            }
          });

          return jsonResponse({
            success: true,
            metodo: "credit_card",
            provedor: "mercadopago_checkout_pro",
            txid: txid,
            order_id: orderId,
            external_reference: txid,
            preference_id: prefResult.id,
            init_point: prefResult.init_point,
            checkout_url: prefResult.init_point,
            sandbox_init_point: prefResult.sandbox_init_point,
            valor: valorFinalCobranca,
            status: "pending",
            db_persist: dbPersistRes
          }, 200, req);
        } catch (mpErr) {
          console.error(`[CHECKOUT_PRO_CREATE_ERROR] TXID: ${txid}, Erro:`, mpErr instanceof Error ? mpErr.message : String(mpErr));
          return jsonResponse({
            success: false,
            error: "Não foi possível iniciar o ambiente seguro do Mercado Pago neste momento. Por favor, tente novamente ou utilize o Pix Instantâneo.",
            detail: mpErr instanceof Error ? mpErr.message : String(mpErr)
          }, 502, req);
        }
      } else {
        return jsonResponse({
          success: false,
          error: "MERCADOPAGO_ACCESS_TOKEN não está configurado na Edge Function."
        }, 503, req);
      }
    }

    return jsonResponse({ error: "Método de pagamento inválido. Use 'pix' ou 'credit_card'." }, 400, req);
  } catch (err) {
    console.error("[Checkout Process Exception]", err);
    return jsonResponse({ error: "Falha interna no processamento do checkout." }, 500, req);
  }
});
