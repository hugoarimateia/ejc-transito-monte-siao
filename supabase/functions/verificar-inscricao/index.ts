// ==============================================================================
// SUPABASE EDGE FUNCTION: verificar-inscricao
// Utilidade pública segura para localização, conferência e confirmação de inscrições,
// verificação de posse via OTP de 6 dígitos enviado por e-mail (Brevo API v3),
// saneamento seguro de duplicidades (soft-archive sem perda de histórico),
// upload privado de comprovantes para ejc-comprovantes e registro de divergências.
// ==============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { AwsClient } from "npm:aws4fetch@1.0.20";

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
  const allowOrigin = ALLOWED_ORIGINS.has(origin) ? origin : "https://www.transitoejc.site";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-admin-token, x-admin-pass, apikey, x-client-info",
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
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-admin-token, x-admin-pass, apikey, x-client-info"
    })
  };
  return new Response(JSON.stringify(data), { status, headers });
}

// ------------------------------------------------------------------------------
// 2. FUNÇÕES DE NORMALIZAÇÃO PADRONIZADAS
// ------------------------------------------------------------------------------
export function normalizeName(name: string): string {
  if (!name || typeof name !== "string") return "";
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove acentos
    .replace(/[^a-z0-9\s]/g, " ")   // substitui pontuação por espaço
    .replace(/\s+/g, " ")           // condensa espaços múltiplos
    .trim();
}

export function normalizeEmail(email: string): string {
  if (!email || typeof email !== "string") return "";
  return email.toLowerCase().trim();
}

export function normalizePhone(phone: string): string {
  if (!phone || typeof phone !== "string") return "";
  let digits = phone.replace(/\D/g, "");
  // Se começar com 55 e tiver 12 ou 13 dígitos, remove o DDI 55 para comparar nacionalmente
  if (digits.length >= 12 && digits.startsWith("55")) {
    digits = digits.slice(2);
  }
  return digits;
}

// ------------------------------------------------------------------------------
// 3. CRIPTOGRAFIA E TOKENS HMAC ASSINADOS
// ------------------------------------------------------------------------------
async function generateHmacSha256(message: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

async function verifyHmacSha256(message: string, signature: string, secret: string): Promise<boolean> {
  const expected = await generateHmacSha256(message, secret);
  return expected.toLowerCase() === signature.toLowerCase();
}

async function signSessionPayload(payloadObj: Record<string, unknown>, secret: string): Promise<string> {
  const jsonStr = JSON.stringify(payloadObj);
  const b64 = btoa(unescape(encodeURIComponent(jsonStr)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const sig = await generateHmacSha256(b64, secret);
  return `${b64}.${sig}`;
}

async function verifySessionToken(token: string, secret: string): Promise<{ valid: boolean; payload?: any; error?: string }> {
  if (!token || typeof token !== "string" || !token.includes(".")) {
    return { valid: false, error: "Token ausente ou malformado." };
  }
  const [b64, sig] = token.split(".");
  const isSigValid = await verifyHmacSha256(b64, sig, secret);
  if (!isSigValid) {
    return { valid: false, error: "Assinatura de segurança do token inválida." };
  }
  try {
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    const normalizedB64 = (b64 + pad).replace(/-/g, "+").replace(/_/g, "/");
    const jsonStr = decodeURIComponent(escape(atob(normalizedB64)));
    const payload = JSON.parse(jsonStr);

    if (payload.exp && Date.now() > payload.exp) {
      return { valid: false, error: "Sessão expirada. Por favor, solicite um novo código de verificação." };
    }
    return { valid: true, payload };
  } catch (err) {
    return { valid: false, error: "Falha ao decodificar carga do token." };
  }
}

// ------------------------------------------------------------------------------
// 4. AUTENTICAÇÃO ADMINISTRATIVA
// ------------------------------------------------------------------------------
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

  if (Boolean(passSuperadmin) && pass === passSuperadmin) return { ok: true, role: "superadmin" };
  if (Boolean(passFinanceiro) && pass === passFinanceiro) return { ok: true, role: "financeiro" };
  if (Boolean(passAdmin) && pass === passAdmin) return { ok: true, role: "admin" };

  return { ok: false, role: null };
}

// ------------------------------------------------------------------------------
// 5. TEMPLATE DE E-MAIL DO CÓDIGO DE VERIFICAÇÃO (BREVO API v3)
// ------------------------------------------------------------------------------
function buildOtpEmailHtml(nome: string, code: string): string {
  const nomeDisplay = nome ? nome.split(" ")[0] : "Participante";
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Código de Verificação EJC</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f1f5f9; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #0f172a;">
  <div style="width: 100%; background-color: #f1f5f9; padding: 30px 12px; box-sizing: border-box;">
    <div style="max-width: 560px; margin: 0 auto; background: #ffffff; border-radius: 18px; overflow: hidden; box-shadow: 0 12px 32px rgba(2, 50, 132, 0.08); border: 1px solid #e2e8f0;">
      <div style="background: linear-gradient(135deg, #023284 0%, #087df9 100%); padding: 30px 24px; text-align: center; color: #ffffff;">
        <h1 style="margin: 0; font-size: 20px; font-weight: 800; letter-spacing: -0.5px; text-transform: uppercase;">EJC — Equipe do Trânsito</h1>
        <div style="margin: 6px 0 0; font-size: 13px; color: #fcc002; font-weight: 700; letter-spacing: 1px; text-transform: uppercase;">Verificação de Inscrição Oficial</div>
      </div>
      <div style="padding: 28px 24px;">
        <h2 style="font-size: 18px; color: #023284; margin: 0 0 12px;">Olá, ${nomeDisplay}!</h2>
        <p style="color: #475569; font-size: 14px; line-height: 1.6; margin: 0 0 20px;">
          Recebemos uma solicitação para verificar e confirmar os dados da sua inscrição no <strong>Encontro de Jovens com Cristo (EJC)</strong>.
        </p>
        <p style="color: #475569; font-size: 14px; line-height: 1.6; margin: 0 0 16px;">
          Utilize o código de segurança abaixo na tela de verificação para ter acesso às suas informações:
        </p>
        
        <div style="background: #f8fafc; border: 2px dashed #087df9; border-radius: 14px; padding: 20px; text-align: center; margin: 24px 0;">
          <div style="font-size: 12px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 6px;">Seu Código de Acesso de Uso Único</div>
          <div style="font-size: 36px; font-weight: 900; letter-spacing: 8px; color: #023284; font-family: monospace;">${code}</div>
          <div style="font-size: 12px; color: #94a3b8; margin-top: 8px;">Válido por 15 minutos</div>
        </div>

        <div style="background: #fffbeb; border-left: 4px solid #f59e0b; padding: 12px 16px; border-radius: 6px; margin: 20px 0; font-size: 13px; color: #92400e; line-height: 1.5;">
          <strong>Atenção:</strong> Nunca compartilhe este código com outras pessoas. A confirmação dos dados cadastrais permite revisar sua inscrição principal e sanear duplicidades.
        </div>

        <p style="color: #64748b; font-size: 12px; line-height: 1.5; margin: 24px 0 0;">
          Se você não solicitou esta verificação, ignore este e-mail com segurança. Nenhuma alteração foi realizada em seu cadastro.
        </p>
      </div>
      <div style="background: #091026; color: #94a3b8; padding: 20px; text-align: center; font-size: 12px; line-height: 1.6;">
        <strong style="color: #ffffff;">EJC — IEAD Monte Sião</strong><br>
        Campina Grande - PB • Portal Oficial de Inscrições
      </div>
    </div>
  </div>
</body>
</html>`;
}

// ------------------------------------------------------------------------------
// 6. DISPATCH CENTRAL DA EDGE FUNCTION
// ------------------------------------------------------------------------------
serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: getCorsHeaders(req) });
  }

  const url = new URL(req.url);
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "https://guppedddwnuvluhiaaas.supabase.co";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const brevoApiKey = Deno.env.get("BREVO_API_KEY_EJC_EDGE") || "";
  const hmacSecret = serviceRoleKey || "ejc-transito-secret-token-key-2026";

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  try {
    let body: Record<string, any> = {};
    if (req.method === "POST") {
      try {
        body = await req.json();
      } catch (_) {
        body = {};
      }
    }

    const action = String(body.action || url.searchParams.get("action") || "").trim();

    // ==========================================================================
    // AÇÃO 1: VERIFICAÇÃO DIRETA POR 3 DADOS NORMALIZADOS (SEM OTP / SEM E-MAIL)
    // ==========================================================================
    if (action === "verificar_dados" || action === "solicitar_codigo" || action === "solicitar_verificacao") {
      const rawNome = String(body.nome || "").trim();
      const rawEmail = String(body.email || "").trim();
      const rawWpp = String(body.whatsapp || body.telefone || "").trim();

      const nomeNorm = normalizeName(rawNome);
      const emailNorm = normalizeEmail(rawEmail);
      const wppNorm = normalizePhone(rawWpp);

      const ehEmailValido = /^[^\s@,()%*]+@[^\s@,()%*]+\.[^\s@,()%*]+$/.test(emailNorm);
      const ehWppValido = wppNorm.length >= 10;
      const ehNomeValido = nomeNorm.length >= 3;

      if (!ehNomeValido || !ehEmailValido || !ehWppValido) {
        return jsonResponse(
          {
            success: false,
            error: "Informe o Nome completo, o E-mail cadastrado e o Telefone/WhatsApp (com DDD) para consultar a inscrição."
          },
          400,
          req
        );
      }

      // Busca registros candidatos na base autorizada
      const { data: rows, error: dbErr } = await supabase
        .from("inscricoes")
        .select(`
          id,
          nome_completo,
          email,
          whatsapp,
          sub,
          tamanho_camisa,
          modelo_camisa,
          pagamento_status,
          pagamento_informado,
          comprovante_caminho,
          justificativa_pagamento,
          observacao_pagamento,
          arquivado,
          arquivado_em,
          motivo_arquivamento,
          criado_em
        `)
        .eq("arquivado", false)
        .or(`email.ilike.${emailNorm},whatsapp.ilike.%${wppNorm}%,whatsapp.ilike.%${wppNorm.slice(-8)}%`)
        .order("criado_em", { ascending: false })
        .limit(20);

      if (dbErr) {
        console.error("[verificar_dados] Erro DB:", dbErr.message);
        return jsonResponse({
          success: false,
          message: "Não encontramos uma inscrição compatível com os dados informados. Confira as informações e tente novamente. Se precisar de ajuda, entre em contato com a coordenação."
        }, 200, req);
      }

      // Validação estrita dos 3 campos com normalização robusta
      const candidatosValidados = (rows || []).filter(c => {
        const cEmailNorm = normalizeEmail(c.email);
        const cWppNorm = normalizePhone(c.whatsapp);
        const cNomeNorm = normalizeName(c.nome_completo);

        const bateuEmail = cEmailNorm === emailNorm;
        const bateuWpp = cWppNorm.includes(wppNorm) || wppNorm.includes(cWppNorm);

        // Comparação de nome normalizado (ignora caixa, acentos e espaços)
        const partesInput = nomeNorm.split(" ").filter(p => p.length >= 2);
        const partesCad = cNomeNorm.split(" ").filter(p => p.length >= 2);

        let bateuNome = cNomeNorm === nomeNorm;
        if (!bateuNome && partesInput.length >= 2 && partesCad.length >= 2) {
          const primeiroIgual = partesInput[0] === partesCad[0];
          const ultimoIgual = partesInput[partesInput.length - 1] === partesCad[partesCad.length - 1];
          bateuNome = primeiroIgual && ultimoIgual;
        }

        // Exige correspondência conjunta do nome E de pelo menos um contato (e-mail ou whatsapp)
        // Se houver correspondência dos 3 dados, é alta confiança
        return (bateuEmail || bateuWpp) && bateuNome;
      });

      if (candidatosValidados.length === 0) {
        // Resposta neutra oficial (Anti-enumeração e privacidade)
        return jsonResponse({
          success: false,
          encontrados: 0,
          inscricoes: [],
          message: "Não encontramos uma inscrição compatível com os dados informados. Confira as informações e tente novamente. Se precisar de ajuda, entre em contato com a coordenação."
        }, 200, req);
      }

      // Emite um sessionToken/viewToken assinado autorizando a manipulação restrita destes IDs (30 minutos)
      const candidateIds = candidatosValidados.map(c => c.id);
      const sessionPayload = {
        email: emailNorm,
        verified: true,
        candidateIds,
        exp: Date.now() + 30 * 60 * 1000
      };
      const signedToken = await signSessionPayload(sessionPayload, hmacSecret);

      // Mapeia registros com identificadores parcialmente mascarados para proteção de dados
      const sanitizedRows = candidatosValidados.map(r => {
        const idStr = String(r.id);
        const maskedId = `${idStr.slice(0, 8)}-****-****-****-${idStr.slice(-8)}`;
        return {
          id: r.id,
          masked_id: maskedId,
          nome_completo: r.nome_completo,
          email_mascarado: r.email ? `${r.email.slice(0, 3)}***@${r.email.split("@")[1] || ""}` : null,
          whatsapp_mascarado: r.whatsapp ? `(**) *****-${r.whatsapp.slice(-4)}` : null,
          sub: r.sub,
          tamanho_camisa: r.tamanho_camisa,
          modelo_camisa: r.modelo_camisa,
          pagamento_status: r.pagamento_status || "pendente",
          pagamento_informado: Boolean(r.pagamento_informado),
          tem_comprovante: Boolean(r.comprovante_caminho),
          arquivado: Boolean(r.arquivado),
          motivo_arquivamento: r.motivo_arquivamento || null,
          criado_em: r.criado_em,
          possivel_duplicidade: candidatosValidados.length > 1
        };
      });

      return jsonResponse({
        success: true,
        encontrados: sanitizedRows.length,
        inscricoes: sanitizedRows,
        sessionToken: signedToken,
        viewToken: signedToken,
        message: "Inscrição localizada com sucesso. Confira seus dados abaixo."
      }, 200, req);
    }

    // ==========================================================================
    // AÇÃO 3: SELEÇÃO DA PRINCIPAL E SANEAMENTO SEGURO DE DUPLICIDADES
    // ==========================================================================
    if (action === "confirmar_principal_duplicidades") {
      const viewToken = String(body.viewToken || body.sessionToken || "").trim();
      const principalId = String(body.principalId || "").trim();
      const duplicateIdsToArchive: string[] = Array.isArray(body.duplicateIdsToArchive) ? body.duplicateIdsToArchive : [];
      const confirmacaoTexto = String(body.confirmacaoTexto || "CONFIRMO_SANEAMENTO").trim();

      if (!viewToken || !principalId) {
        return jsonResponse({ error: "Token de visualização e ID da inscrição principal são obrigatórios." }, 400, req);
      }

      const tokenRes = await verifySessionToken(viewToken, hmacSecret);
      if (!tokenRes.valid || !tokenRes.payload || !tokenRes.payload.verified) {
        return jsonResponse({ error: "Sessão expirada ou não autorizada. Refaça a verificação de dados." }, 401, req);
      }

      const authorizedIds: string[] = Array.isArray(tokenRes.payload.candidateIds) ? tokenRes.payload.candidateIds : [];
      if (!authorizedIds.includes(principalId)) {
        return jsonResponse({ error: "A inscrição indicada não pertence ao conjunto verificado desta sessão." }, 403, req);
      }

      for (const dupId of duplicateIdsToArchive) {
        if (!authorizedIds.includes(dupId)) {
          return jsonResponse({ error: `Inscrição duplicada ${dupId} não autorizada nesta sessão.` }, 403, req);
        }
        if (dupId === principalId) {
          return jsonResponse({ error: "A inscrição principal não pode ser marcada para arquivamento." }, 400, req);
        }
      }

      const agora = new Date().toISOString();

      // 1. Confirmação cadastral da inscrição principal
      const { error: errPrincipal } = await supabase
        .from("inscricoes")
        .update({
          observacao_pagamento: `[CONFIRMADO PELO PARTICIPANTE em ${agora}]`
        })
        .eq("id", principalId);

      if (errPrincipal) {
        console.warn("[confirmar_principal] Warning principal update:", errPrincipal.message);
      }

      // 2. Saneamento atômico das duplicidades confirmadas (SOFT-ARCHIVE COM AUDITORIA)
      const arquivadasSucesso: string[] = [];
      for (const dupId of duplicateIdsToArchive) {
        const { error: errArchive } = await supabase
          .from("inscricoes")
          .update({
            arquivado: true,
            arquivado_em: agora,
            motivo_arquivamento: "DUPLICIDADE_CONFIRMADA_PELO_PARTICIPANTE"
          })
          .eq("id", dupId);

        if (!errArchive) {
          arquivadasSucesso.push(dupId);

          // Registra na auditoria_transacoes
          await supabase.from("auditoria_transacoes").insert({
            transacao_id: principalId,
            acao: "saneamento_duplicidade_participante",
            status_anterior: "ativo",
            status_novo: "arquivado",
            executado_por: "participante_verificacao",
            detalhes: {
              principal_id: principalId,
              duplicata_arquivada: dupId,
              email: tokenRes.payload.email,
              motivo: "DUPLICIDADE_CONFIRMADA_PELO_PARTICIPANTE",
              confirmacao_texto: confirmacaoTexto,
              data: agora
            }
          });
        }
      }

      return jsonResponse({
        success: true,
        principalId,
        duplicatasArquivadas: arquivadasSucesso,
        message: "Inscrição principal confirmada com sucesso! As duplicidades foram arquivadas preservando todo o histórico."
      }, 200, req);
    }

    // ==========================================================================
    // AÇÃO 4: PRESIGNED URL PRIVADA PARA UPLOAD DE COMPROVANTE (ejc-comprovantes)
    // ==========================================================================
    if (action === "get_upload_comprovante_url") {
      const viewToken = String(body.viewToken || body.sessionToken || "").trim();
      const inscricaoId = String(body.inscricaoId || "").trim();
      const mimeType = String(body.mimeType || "image/jpeg").toLowerCase().trim();
      let extension = String(body.extension || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "");

      if (!viewToken || !inscricaoId) {
        return jsonResponse({ error: "viewToken e inscricaoId são obrigatórios." }, 400, req);
      }

      const tokenRes = await verifySessionToken(viewToken, hmacSecret);
      if (!tokenRes.valid || !tokenRes.payload || !tokenRes.payload.verified) {
        return jsonResponse({ error: "Sessão não autorizada." }, 401, req);
      }

      const authorizedIds: string[] = Array.isArray(tokenRes.payload.candidateIds) ? tokenRes.payload.candidateIds : [];
      if (!authorizedIds.includes(inscricaoId)) {
        return jsonResponse({ error: "Inscrição não autorizada para esta sessão." }, 403, req);
      }

      const allowedMimes = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
      if (!allowedMimes.has(mimeType)) {
        return jsonResponse({ error: "Formato de arquivo inválido. Formatos permitidos: JPG, PNG, WebP e PDF." }, 400, req);
      }

      if (mimeType === "application/pdf") extension = "pdf";
      else if (mimeType === "image/png") extension = "png";
      else if (mimeType === "image/webp") extension = "webp";
      else extension = "jpg";

      const accountId = Deno.env.get("R2_ACCOUNT_ID") || "0d0228f378b5e4f3f63c67b4210bf3ea";
      const accessKeyId = Deno.env.get("R2_ACCESS_KEY_ID") || "";
      const secretAccessKey = Deno.env.get("R2_SECRET_ACCESS_KEY") || "";
      const bucketName = "ejc-comprovantes";

      if (!accessKeyId || !secretAccessKey) {
        return jsonResponse({ error: "Configuração de upload de comprovantes indisponível no servidor." }, 500, req);
      }

      const s3Client = new AwsClient({
        accessKeyId,
        secretAccessKey,
        service: "s3",
        region: "auto"
      });

      const uniqueId = crypto.randomUUID();
      const storageKey = `comprovantes/verificacao-${inscricaoId.slice(0, 8)}-${uniqueId}.${extension}`;
      const expiresIn = 300; // 5 minutos

      const s3Url = `https://${accountId}.r2.cloudflarestorage.com/${bucketName}/${storageKey}?X-Amz-Expires=${expiresIn}`;
      const signedReq = await s3Client.sign(
        new Request(s3Url, {
          method: "PUT",
          headers: {
            "Content-Type": mimeType
          }
        }),
        { aws: { signQuery: true } }
      );

      return jsonResponse({
        success: true,
        uploadUrl: signedReq.url.toString(),
        storageKey,
        mimeType,
        expiresIn
      }, 200, req);
    }

    // ==========================================================================
    // AÇÃO 5: REPORTAR DIVERGÊNCIA FINANCEIRA / ANEXAR COMPROVANTE
    // ==========================================================================
    if (action === "reportar_divergencia") {
      const viewToken = String(body.viewToken || body.sessionToken || "").trim();
      const inscricaoId = String(body.inscricaoId || "").trim();
      const tipoDivergencia = String(body.tipoDivergencia || "afirma_pago_sem_confirmacao").trim();
      const descricao = String(body.descricao || "").trim();
      const comprovanteKey = String(body.comprovanteKey || "").trim();

      if (!viewToken || !inscricaoId) {
        return jsonResponse({ error: "viewToken e inscricaoId são obrigatórios." }, 400, req);
      }

      const tokenRes = await verifySessionToken(viewToken, hmacSecret);
      if (!tokenRes.valid || !tokenRes.payload || !tokenRes.payload.verified) {
        return jsonResponse({ error: "Sessão não autorizada." }, 401, req);
      }

      const authorizedIds: string[] = Array.isArray(tokenRes.payload.candidateIds) ? tokenRes.payload.candidateIds : [];
      if (!authorizedIds.includes(inscricaoId)) {
        return jsonResponse({ error: "Inscrição não autorizada para esta sessão." }, 403, req);
      }

      const agora = new Date().toISOString();

      const updateData: Record<string, any> = {
        pagamento_informado: true,
        justificativa_pagamento: `[DIVERGÊNCIA REPORTADA]: ${tipoDivergencia} - ${descricao}`.slice(0, 500)
      };

      if (comprovanteKey) {
        updateData.comprovante_caminho = comprovanteKey;
      }

      const { error: updateErr } = await supabase
        .from("inscricoes")
        .update(updateData)
        .eq("id", inscricaoId);

      if (updateErr) {
        return jsonResponse({ error: "Erro ao registrar divergência: " + updateErr.message }, 500, req);
      }

      // Registra evento na tabela de auditoria
      await supabase.from("auditoria_transacoes").insert({
        transacao_id: inscricaoId,
        acao: "divergencia_financeira_reportada",
        executado_por: "participante_verificacao",
        detalhes: {
          inscricao_id: inscricaoId,
          tipo_divergencia: tipoDivergencia,
          descricao,
          comprovante_key: comprovanteKey || null,
          data: agora
        }
      });

      return jsonResponse({
        success: true,
        message: "Divergência registrada com sucesso! A coordenação do EJC analisará as informações enviadas. O pagamento permanecerá em conferência até validação manual."
      }, 200, req);
    }

    // ==========================================================================
    // AÇÃO 6: VISÃO ADMINISTRATIVA (Admin consulta divergências e confirmações)
    // ==========================================================================
    if (action === "admin_listar_verificacoes") {
      const auth = await authenticateAdmin(req, body);
      if (!auth.ok) {
        return jsonResponse({ error: "Acesso administrativo não autorizado." }, 401, req);
      }

      // 1. Busca inscrições que reportaram divergência ou possuem comprovante
      const { data: divergencias, error: errDiv } = await supabase
        .from("inscricoes")
        .select("id, nome_completo, email, whatsapp, sub, pagamento_status, pagamento_informado, comprovante_caminho, justificativa_pagamento, arquivado, motivo_arquivamento, criado_em")
        .or("pagamento_informado.eq.true,motivo_arquivamento.eq.DUPLICIDADE_CONFIRMADA_PELO_PARTICIPANTE")
        .order("criado_em", { ascending: false })
        .limit(100);

      if (errDiv) {
        return jsonResponse({ error: "Erro ao consultar verificações: " + errDiv.message }, 500, req);
      }

      // 2. Busca histórico recente de auditoria de saneamento
      const { data: auditoria } = await supabase
        .from("auditoria_transacoes")
        .select("id, transacao_id, acao, executado_por, criado_em, detalhes")
        .in("acao", ["saneamento_duplicidade_participante", "divergencia_financeira_reportada"])
        .order("criado_em", { ascending: false })
        .limit(50);

      return jsonResponse({
        success: true,
        divergencias: divergencias || [],
        auditoria: auditoria || []
      }, 200, req);
    }

    return jsonResponse({ error: `Ação desconhecida: '${action}'.` }, 400, req);

  } catch (err: any) {
    console.error("[verificar-inscricao FATAL]", err);
    return jsonResponse({ error: "Erro interno no servidor de verificação.", detail: err.message }, 500, req);
  }
});
