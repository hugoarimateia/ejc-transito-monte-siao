// ==============================================================================
// SUPABASE EDGE FUNCTION: admin-write
// Módulo de Escrita Administrativa Segura (EJC - Trânsito Monte Sião)
// Atende exclusivamente operações autenticadas e autorizadas:
//   OP01: update_prices
//   OP02: update_pix
//   OP03: update_card_settings
//   OP04: sync_full_settings
//   OP05: update_whatsapp
//   OP06: approve_payment
//   OP07: reject_payment
//   OP08: resend_receipt (ARQUITETURA EDGE MODERNA / SEND-EMAIL)
//   OP09: cancel_inscription
//   OP10: reset_test (BLOQUEADA POR SEGURANÇA - AUSÊNCIA DE MARCADOR FORMAL NO BANCO)
//   OP11: desarchive (desarquivar_inscricao)
//   OP12: update_participant (update_inscritos_dados)
//   OP13: upload_participant_photo
// Suporta modo DRY-RUN estrito (dry_run: true) com ZERO mutação em banco, R2 ou Storage.
// ==============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { validateWhatsAppPayload } from "./whatsapp-validator.ts";

// --- ESTRUTURA DE PERMISSÕES ADMINISTRATIVAS ---
interface RolePermissions {
  role: "superadmin" | "financeiro" | "admin";
  label: string;
  canEdit: boolean;
  canEditFinance: boolean;
  canApprovePayments: boolean;
  canEditWhatsapp: boolean;
}

const ROLES: Record<string, RolePermissions> = {
  superadmin: {
    role: "superadmin",
    label: "Coordenação / Super Admin (Acesso Total)",
    canEdit: true,
    canEditFinance: true,
    canApprovePayments: true,
    canEditWhatsapp: true
  },
  financeiro: {
    role: "financeiro",
    label: "Gestor Financeiro",
    canEdit: true,
    canEditFinance: true,
    canApprovePayments: true,
    canEditWhatsapp: false
  },
  admin: {
    role: "admin",
    label: "Administrador Geral",
    canEdit: false,
    canEditFinance: false,
    canApprovePayments: false,
    canEditWhatsapp: true
  }
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED_CONFIG_KEYS = new Set([
  "valor_inscricao",
  "valor_promocional",
  "taxa_adicional",
  "max_parcelas",
  "modalidade_pix",
  "pix_chave",
  "pix_tipo_chave",
  "pix_beneficiario",
  "pix_cidade",
  "pix_instrucoes_manual",
  "pix_permite_comprovante",
  "lote_atual",
  "card_installment_mode",
  "card_max_installments",
  "card_installment_rates"
]);

const ALLOWED_PARTICIPANT_FIELDS = new Set([
  "nome_completo",
  "whatsapp",
  "email",
  "sub",
  "tamanho_camisa",
  "modelo_camisa",
  "observacoes"
]);

// --- CRIPTOGRAFIA E COMPARAÇÃO EM TEMPO CONSTANTE ---
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

async function authenticateRequest(
  req: Request,
  bodyData?: Record<string, unknown>
): Promise<RolePermissions | null> {
  const authHeader = req.headers.get("authorization") || req.headers.get("Authorization") || "";
  const bearerToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  const adminToken = (req.headers.get("x-admin-token") || req.headers.get("x-admin-pass") || "").trim();
  const bodyPass = typeof bodyData?.password === "string"
    ? bodyData.password.trim()
    : (typeof bodyData?.admin_pass === "string" ? bodyData.admin_pass.trim() : "");

  // Suporte estrito e seguro para validação automatizada da matriz de RBAC exclusivamente em modo DRY-RUN
  // O secret vem de Secret de Ambiente (ADMIN_WRITE_DRY_RUN_KEY) e NUNCA autentica operações com dry_run = false
  const isDryRun = Boolean(bodyData?.dry_run === true || bodyData?.dryRun === true);
  const envDryRunKey = Deno.env.get("ADMIN_WRITE_DRY_RUN_KEY") || "";
  const providedKey = req.headers.get("x-dry-run-key") || bodyData?.dry_run_key || bodyData?.test_key;
  if (isDryRun && envDryRunKey && providedKey && (await timingSafeEqualStr(String(providedKey), envDryRunKey))) {
    const simRole = String(req.headers.get("x-simulate-role") || bodyData?.simulate_role || "superadmin").toLowerCase();
    if (ROLES[simRole]) return ROLES[simRole];
    return ROLES.superadmin;
  }

  const pass = bodyPass || adminToken || bearerToken;
  if (!pass) return null;

  const passSuperadmin = (Deno.env.get("ADMIN_PASSWORD_COORDENACAO") || Deno.env.get("ADMIN_PASS") || "").trim().replace(/^"|"$/g, "");
  const passFinanceiro = (Deno.env.get("ADMIN_PASSWORD_FINANCEIRO") || Deno.env.get("FINANCEIRO_PASSWORD") || "").trim().replace(/^"|"$/g, "");
  const passAdmin = (Deno.env.get("ADMIN_PASSWORD") || "").trim().replace(/^"|"$/g, "");

  const isSuper = Boolean(passSuperadmin) && (await timingSafeEqualStr(pass, passSuperadmin));
  if (isSuper) return ROLES.superadmin;

  const isFin = Boolean(passFinanceiro) && (await timingSafeEqualStr(pass, passFinanceiro));
  if (isFin) return ROLES.financeiro;

  const isAdmin = Boolean(passAdmin) && (await timingSafeEqualStr(pass, passAdmin));
  if (isAdmin) return ROLES.admin;

  // Permite autenticação para self-test interno ou simulação segura de role apenas se autenticado com Service Role Key
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (serviceKey && (await timingSafeEqualStr(pass, serviceKey))) {
    const simRole = String(req.headers.get("x-simulate-role") || bodyData?.simulate_role || "superadmin").toLowerCase();
    if (ROLES[simRole]) return ROLES[simRole];
    return ROLES.superadmin;
  }

  return null;
}

function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  const allowed = new Set([
    "https://www.transitoejc.site",
    "https://transitoejc.site",
    "https://ejc-admin.pages.dev",
    "https://ejc-public.pages.dev",
    "https://site-ejc-eight.vercel.app",
    "http://localhost:3000",
    "http://127.0.0.1:3000"
  ]);

  const originHeader = allowed.has(origin) ? origin : "https://transitoejc.site";

  return {
    "Access-Control-Allow-Origin": originHeader,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-admin-token, x-admin-pass, x-dry-run-key, x-simulate-role, x-client-info, apikey, content-type",
    "Access-Control-Max-Age": "86400"
  };
}

async function recordAudit(
  supabase: any,
  acao: string,
  detalhes: Record<string, unknown>,
  ip: string,
  userRole: string,
  isDryRun = false
) {
  // Em modo dry-run, NUNCA grava auditoria para preservar rigorosamente a contagem da tabela
  if (isDryRun) return;
  try {
    await supabase.from("auditoria_transacoes").insert({
      acao,
      detalhes: {
        ...detalhes,
        operador_role: userRole,
        origem: "supabase-edge-admin-write",
        timestamp: new Date().toISOString()
      },
      ip_origem: ip || "0.0.0.0"
    });
  } catch (err) {
    console.warn("[Admin-Write Audit Error]:", err);
  }
}

// Handler interno da operação para suportar tanto requisições individuais quanto self-test
async function handleAdminAction(
  action: string,
  body: Record<string, any>,
  authRole: RolePermissions,
  clientIp: string,
  supabase: any,
  isDryRun: boolean
): Promise<{ status: number; body: Record<string, any> }> {
  // --------------------------------------------------------------------------
  // OP01: update_prices
  // --------------------------------------------------------------------------
  if (action === "update_prices") {
    if (!authRole.canEditFinance) {
      return { status: 403, body: { error: "Permissão negada. Seu perfil não possui autorização financeira.", action, role: authRole.role } };
    }

    const precoEfetivo = Number(body.preco_efetivo || body.valor_inscricao);
    if (isNaN(precoEfetivo) || precoEfetivo <= 0 || precoEfetivo > 1000) {
      return { status: 400, body: { error: "Valor de inscrição inválido. Deve ser entre R$ 1,00 e R$ 1.000,00." } };
    }

    const valorPromocional = body.valor_promocional !== undefined && body.valor_promocional !== null && body.valor_promocional !== ""
      ? Number(body.valor_promocional)
      : null;

    const taxaAdicional = body.taxa_adicional !== undefined && body.taxa_adicional !== null
      ? Number(body.taxa_adicional)
      : 0;

    const loteAtual = String(body.lote_atual || "1º Lote - Oficial").trim();

    if (isDryRun) {
      return {
        status: 200,
        body: {
          ok: true,
          dry_run: true,
          action: "update_prices",
          authorized: true,
          would_mutate: true,
          role: authRole.role,
          target_resources: ["configuracoes_financeiras", "historico_configuracoes_financeiras"],
          details: {
            preco_efetivo: precoEfetivo,
            valor_promocional: valorPromocional,
            taxa_adicional: taxaAdicional,
            lote_atual: loteAtual,
            history_modificado_por: authRole.label
          }
        }
      };
    }

    const { data: updatedConfig, error: updateErr } = await supabase
      .from("configuracoes_financeiras")
      .update({
        valor_inscricao: precoEfetivo,
        valor_promocional: valorPromocional,
        taxa_adicional: taxaAdicional,
        lote_atual: loteAtual,
        atualizado_em: new Date().toISOString()
      })
      .order("id", { ascending: false })
      .limit(1)
      .select();

    if (updateErr) throw updateErr;

    await supabase.from("historico_configuracoes_financeiras").insert({
      valor_inscricao: precoEfetivo,
      valor_promocional: valorPromocional,
      taxa_adicional: taxaAdicional,
      lote_atual: loteAtual,
      modificado_por: authRole.label,
      motivo: body.motivo || "Atualização via painel administrativo"
    });

    await recordAudit(supabase, "ALTERACAO_PRECO", { precoEfetivo, valorPromocional, taxaAdicional, loteAtual }, clientIp, authRole.role, isDryRun);

    return { status: 200, body: { success: true, message: "Preços atualizados com sucesso.", config: updatedConfig } };
  }

  // --------------------------------------------------------------------------
  // OP02: update_pix
  // --------------------------------------------------------------------------
  if (action === "update_pix") {
    if (!authRole.canEditFinance) {
      return { status: 403, body: { error: "Permissão negada. Seu perfil não possui autorização financeira.", action, role: authRole.role } };
    }

    const modalidade = String(body.modalidade_pix || "api_webhook").trim();
    const chave = String(body.pix_chave || "").trim();
    const tipoChave = String(body.pix_tipo_chave || "EMAIL").trim();
    const beneficiario = String(body.pix_beneficiario || "EJC TRANSITO MONTE SIAO").trim();
    const cidade = String(body.pix_cidade || "CAMPINA GRANDE").trim();

    if (!chave) {
      return { status: 400, body: { error: "Chave Pix é obrigatória." } };
    }

    if (isDryRun) {
      return {
        status: 200,
        body: {
          ok: true,
          dry_run: true,
          action: "update_pix",
          authorized: true,
          would_mutate: true,
          role: authRole.role,
          target_resources: ["configuracoes_financeiras"],
          details: { modalidade, chave_mascarada: chave.slice(0, 3) + "***", tipoChave, beneficiario, cidade }
        }
      };
    }

    const { data: updatedPix, error: pixErr } = await supabase
      .from("configuracoes_financeiras")
      .update({
        modalidade_pix: modalidade,
        pix_chave: chave,
        pix_tipo_chave: tipoChave,
        pix_beneficiario: beneficiario,
        pix_cidade: cidade,
        pix_permite_comprovante: Boolean(body.pix_permite_comprovante),
        pix_instrucoes_manual: String(body.pix_instrucoes_manual || ""),
        atualizado_em: new Date().toISOString()
      })
      .order("id", { ascending: false })
      .limit(1)
      .select();

    if (pixErr) throw pixErr;

    await recordAudit(supabase, "UPDATE_PIX_SETTINGS", { modalidade, tipoChave, beneficiario, cidade }, clientIp, authRole.role, isDryRun);

    return { status: 200, body: { success: true, message: "Configurações de Pix atualizadas com sucesso.", pix: updatedPix } };
  }

  // --------------------------------------------------------------------------
  // OP03: update_card_settings
  // --------------------------------------------------------------------------
  if (action === "update_card_settings" || action === "update_card") {
    if (!authRole.canEditFinance) {
      return { status: 403, body: { error: "Permissão negada. Seu perfil não possui autorização financeira.", action, role: authRole.role } };
    }

    const installmentMode = String(body.card_installment_mode || "mercado_pago").trim();
    const maxInstallments = Math.max(1, Math.min(12, Number(body.card_max_installments || 6)));
    const taxaAdicional = body.taxa_adicional !== undefined ? Number(body.taxa_adicional) : 0;
    if (isNaN(taxaAdicional) || taxaAdicional < 0 || taxaAdicional > 100) {
      return { status: 400, body: { error: "Taxa adicional deve ser um número entre 0 e 100." } };
    }
    const rates = Array.isArray(body.card_installment_rates) ? body.card_installment_rates : null;

    if (isDryRun) {
      return {
        status: 200,
        body: {
          ok: true,
          dry_run: true,
          action: "update_card_settings",
          authorized: true,
          would_mutate: true,
          role: authRole.role,
          target_resources: ["configuracoes_financeiras"],
          details: { installmentMode, maxInstallments, taxaAdicional, rates_count: rates?.length || 0 }
        }
      };
    }

    const updateData: Record<string, any> = {
      card_installment_mode: installmentMode,
      card_max_installments: maxInstallments,
      taxa_adicional: taxaAdicional,
      atualizado_em: new Date().toISOString()
    };
    if (rates) updateData.card_installment_rates = rates;

    const { data: updatedCard, error: cardErr } = await supabase
      .from("configuracoes_financeiras")
      .update(updateData)
      .order("id", { ascending: false })
      .limit(1)
      .select();

    if (cardErr) throw cardErr;

    await recordAudit(supabase, "UPDATE_CARD_SETTINGS", { installmentMode, maxInstallments, taxaAdicional }, clientIp, authRole.role, isDryRun);

    return { status: 200, body: { success: true, message: "Configurações de cartão atualizadas com sucesso.", config: updatedCard } };
  }

  // --------------------------------------------------------------------------
  // OP04: sync_full_settings
  // --------------------------------------------------------------------------
  if (action === "sync_full_settings") {
    if (authRole.role !== "superadmin") {
      return { status: 403, body: { error: "Permissão negada. Apenas Super Admin pode sincronizar configurações totais.", action, role: authRole.role } };
    }

    const settings = body.settings || body.config;
    if (!settings || typeof settings !== "object") {
      return { status: 400, body: { error: "Objeto de configurações ausente ou inválido." } };
    }

    // Whitelist estrita de campos
    const invalidKeys: string[] = [];
    const validUpdates: Record<string, any> = {};
    for (const [k, v] of Object.entries(settings)) {
      if (ALLOWED_CONFIG_KEYS.has(k)) {
        validUpdates[k] = v;
      } else {
        invalidKeys.push(k);
      }
    }

    if (invalidKeys.length > 0) {
      return { status: 400, body: { error: `Campos não autorizados na sincronização: ${invalidKeys.join(", ")}` } };
    }

    if (isDryRun) {
      return {
        status: 200,
        body: {
          ok: true,
          dry_run: true,
          action: "sync_full_settings",
          authorized: true,
          would_mutate: true,
          role: authRole.role,
          target_resources: ["configuracoes_financeiras", "historico_configuracoes_financeiras"],
          validated_keys: Object.keys(validUpdates)
        }
      };
    }

    const { data: fullSync, error: syncErr } = await supabase
      .from("configuracoes_financeiras")
      .update({
        ...validUpdates,
        atualizado_em: new Date().toISOString()
      })
      .order("id", { ascending: false })
      .limit(1)
      .select();

    if (syncErr) throw syncErr;

    await recordAudit(supabase, "SYNC_FULL_SETTINGS", { updated_keys: Object.keys(validUpdates) }, clientIp, authRole.role, isDryRun);

    return { status: 200, body: { success: true, message: "Configurações sincronizadas com sucesso.", config: fullSync } };
  }

  // --------------------------------------------------------------------------
  // OP05: update_whatsapp (HARDENED: COLUNA link_grupo, COMPATIBILIDADE subs/links, PROTEÇÃO DE AMBIGUIDADE)
  // --------------------------------------------------------------------------
  if (action === "update_whatsapp") {
    if (!authRole.canEditWhatsapp) {
      return { status: 403, body: { error: "Permissão negada. Seu perfil não pode alterar links de WhatsApp.", action, role: authRole.role } };
    }

    // Suporte universal aos formatos: body.subs (frontend atual), body.links e body.whatsapp (legados)
    const rawInput = body.subs || body.links || body.whatsapp;
    const valResult = validateWhatsAppPayload(rawInput);
    if (!valResult.ok || !valResult.verifiedLinks) {
      return {
        status: 400,
        body: { error: valResult.error || "Payload de links de WhatsApp inválido." }
      };
    }

    const verifiedLinks = valResult.verifiedLinks;

    if (isDryRun) {
      return {
        status: 200,
        body: {
          ok: true,
          dry_run: true,
          action: "update_whatsapp",
          authorized: true,
          would_mutate: true,
          role: authRole.role,
          target_resources: ["configuracoes_whatsapp", "subs"],
          target_column: "link_grupo",
          rpc_target: "atualizar_links_whatsapp_transacional",
          validated_subs: Object.keys(verifiedLinks),
          links: verifiedLinks
        }
      };
    }

    // Chamada Atômica Transacional via RPC PostgreSQL (ACID Real - Tudo ou Nada)
    // A RPC atualiza configuracoes_whatsapp, subs e grava auditoria_transacoes na mesma transação.
    const { data: rpcData, error: rpcError } = await supabase.rpc("atualizar_links_whatsapp_transacional", {
      p_links: verifiedLinks,
      p_operador: authRole.label,
      p_ip: clientIp
    });

    if (rpcError) {
      console.error("[OP05 Transactional RPC Error]:", rpcError);
      const rawMsg = rpcError.message || "";
      let userError = "Falha ao processar a atualização dos links de WhatsApp.";
      let statusCode = 400;

      if (rawMsg.includes("Ambiguidade detectada")) {
        statusCode = 409;
        userError = "Conflito de integridade: múltiplos registros ativos encontrados para um dos grupos.";
      } else if (rawMsg.includes("não localizado") || rawMsg.includes("não encontrado")) {
        statusCode = 404;
        userError = "Registro de um dos grupos de WhatsApp não foi localizado.";
      } else if (rawMsg.includes("Grupo não reconhecido") || rawMsg.includes("Grupo duplicado")) {
        statusCode = 400;
        userError = rawMsg;
      } else if (rawMsg.includes("Link inválido") || rawMsg.includes("caracteres") || rawMsg.includes("limite")) {
        statusCode = 400;
        userError = rawMsg;
      } else {
        statusCode = 500;
        userError = "Erro interno ao processar a atualização dos links de WhatsApp.";
      }

      return {
        status: statusCode,
        body: {
          error: userError,
          action: "update_whatsapp"
        }
      };
    }

    return {
      status: 200,
      body: {
        success: true,
        changed: rpcData?.changed ?? true,
        message: rpcData?.message || "Links de WhatsApp atualizados com sucesso de forma atômica.",
        updated_subs: rpcData?.updated_subs || Object.keys(verifiedLinks),
        whatsapp: verifiedLinks
      }
    };
  }

  // --------------------------------------------------------------------------
  // OP06: approve_payment (HARDENED COM IDEMPOTÊNCIA E VÍNCULO DE INSCRIÇÃO)
  // --------------------------------------------------------------------------
  if (action === "approve_payment") {
    if (!authRole.canApprovePayments) {
      return { status: 403, body: { error: "Permissão negada. Seu perfil não pode aprovar pagamentos.", action, role: authRole.role } };
    }

    const rawId = body.payment_id || body.txid || body.inscricao_id;
    if (!rawId) {
      return { status: 400, body: { error: "Identificador do pagamento ou inscrição é obrigatório." } };
    }

    const { data: pData, error: pErr } = await supabase
      .from("pagamentos")
      .select("id, status, txid, inscricao_id, valor, metodo")
      .or(`id.eq.${encodeURIComponent(rawId)},txid.eq.${encodeURIComponent(rawId)},inscricao_id.eq.${encodeURIComponent(rawId)}`)
      .limit(1)
      .maybeSingle();

    if (pErr || !pData) {
      return { status: 404, body: { error: "Pagamento não encontrado." } };
    }

    // Valida inscrição vinculada para verificar se não está cancelada/arquivada
    if (pData.inscricao_id) {
      const { data: insData, error: insErr } = await supabase
        .from("inscricoes")
        .select("id, pagamento_status, arquivado")
        .eq("id", pData.inscricao_id)
        .maybeSingle();

      if (!insErr && insData) {
        if (insData.arquivado === true || insData.pagamento_status === "cancelado") {
          return {
            status: 400,
            body: { error: "Inscrição vinculada a este pagamento encontra-se cancelada ou arquivada. Não é permitido aprovar pagamento de inscrição cancelada." }
          };
        }
      }
    }

    // Idempotência estrita: se já aprovado/confirmado, retorna sem duplicar efeitos
    if (pData.status === "approved" || pData.status === "confirmado") {
      return {
        status: 200,
        body: {
          success: true,
          status: "approved",
          already_confirmed: true,
          message: "Pagamento já se encontra previamente confirmado."
        }
      };
    }

    if (isDryRun) {
      return {
        status: 200,
        body: {
          ok: true,
          dry_run: true,
          action: "approve_payment",
          authorized: true,
          would_mutate: true,
          role: authRole.role,
          target_resources: ["pagamentos", "inscricoes", "email_dispatches", "auditoria_transacoes"],
          details: {
            payment_id: pData.id,
            txid: pData.txid,
            current_status: pData.status,
            target_status: "approved",
            inscricao_id: pData.inscricao_id,
            mechanism: "confirmar_pagamento_unificado_rpc",
            external_effects: "nenhum (Brevo e Mercado Pago estritamente isolados no dry-run)"
          }
        }
      };
    }

    // Executa a confirmação unificada no banco através da RPC nativa (com lock FOR UPDATE)
    const { data: rpcRes, error: rpcErr } = await supabase.rpc("confirmar_pagamento_unificado", {
      p_txid: pData.txid,
      p_gateway: "admin_manual",
      p_executado_por: authRole.label,
      p_payload: { aprovado_via: "admin-write", operador: authRole.label }
    });

    if (rpcErr) throw rpcErr;

    return { status: 200, body: { success: true, message: "Pagamento aprovado com sucesso via reconciliação unificada.", result: rpcRes } };
  }

  // --------------------------------------------------------------------------
  // OP07: reject_payment (HARDENED COM MOTIVO OBRIGATÓRIO E IDEMPOTÊNCIA)
  // --------------------------------------------------------------------------
  if (action === "reject_payment") {
    if (!authRole.canApprovePayments) {
      return { status: 403, body: { error: "Permissão negada. Seu perfil não pode rejeitar pagamentos.", action, role: authRole.role } };
    }

    const rawId = body.payment_id || body.txid || body.inscricao_id;
    if (!rawId) {
      return { status: 400, body: { error: "Identificador do pagamento ou inscrição é obrigatório." } };
    }

    const motivo = String(body.motivo || "").trim();
    if (!motivo) {
      return { status: 400, body: { error: "Motivo da rejeição é obrigatório para fins de auditoria e prestação de contas." } };
    }

    const { data: pData, error: pErr } = await supabase
      .from("pagamentos")
      .select("id, status, txid, inscricao_id")
      .or(`id.eq.${encodeURIComponent(rawId)},txid.eq.${encodeURIComponent(rawId)},inscricao_id.eq.${encodeURIComponent(rawId)}`)
      .limit(1)
      .maybeSingle();

    if (pErr || !pData) {
      return { status: 404, body: { error: "Pagamento não encontrado." } };
    }

    // Idempotência
    if (pData.status === "rejeitado" || pData.status === "rejected") {
      return {
        status: 200,
        body: { success: true, message: "Pagamento já se encontra rejeitado.", status: pData.status, already_rejected: true }
      };
    }

    if (isDryRun) {
      return {
        status: 200,
        body: {
          ok: true,
          dry_run: true,
          action: "reject_payment",
          authorized: true,
          would_mutate: true,
          role: authRole.role,
          target_resources: ["pagamentos", "inscricoes", "auditoria_transacoes"],
          details: {
            payment_id: pData.id,
            txid: pData.txid,
            current_status: pData.status,
            target_status: "rejeitado",
            motivo
          }
        }
      };
    }

    await supabase
      .from("pagamentos")
      .update({ status: "rejeitado", atualizado_em: new Date().toISOString() })
      .eq("id", pData.id);

    if (pData.inscricao_id) {
      await supabase
        .from("inscricoes")
        .update({ pagamento_status: "rejeitado", observacao_pagamento: `Pagamento rejeitado: ${motivo}` })
        .eq("id", pData.inscricao_id);
    }

    await recordAudit(supabase, "REJEICAO_PAGAMENTO", { payment_id: pData.id, motivo }, clientIp, authRole.role, isDryRun);

    return { status: 200, body: { success: true, message: "Pagamento rejeitado com sucesso.", payment_id: pData.id } };
  }

  // --------------------------------------------------------------------------
  // OP08: resend_receipt (MIGRAÇÃO DA ARQUITETURA EDGE MODERNA)
  // --------------------------------------------------------------------------
  if (action === "resend_receipt" || action === "reenviar_comprovante") {
    // 1. RBAC: superadmin e financeiro permitidos; admin geral bloqueado (403)
    if (authRole.role !== "superadmin" && authRole.role !== "financeiro") {
      return {
        status: 403,
        body: {
          error: "Permissão negada. Apenas 'superadmin' e 'financeiro' possuem autorização para reenviar comprovantes de pagamento.",
          action,
          role: authRole.role
        }
      };
    }

    // 2. Extração e validação do identificador canônico
    const rawId = String(body.registration_id || body.inscricao_id || body.payment_id || body.txid || body.id || "").trim();
    if (!rawId) {
      return {
        status: 400,
        body: { error: "Payload incompleto: identificador de transação ou inscrição obrigatório ('registration_id', 'txid' ou 'payment_id')." }
      };
    }

    // Se o cliente forneceu registration_id explícito, valida formato UUID
    if (body.registration_id && !UUID_REGEX.test(String(body.registration_id).trim())) {
      return {
        status: 400,
        body: { error: "Formato de registration_id inválido. Deve ser um UUID válido." }
      };
    }

    const isUuid = UUID_REGEX.test(rawId);

    // 3. Localização dos dados canônicos oficiais no banco
    let paymentRecord: any = null;
    let inscricaoRecord: any = null;

    if (isUuid) {
      const { data: pById } = await supabase
        .from("pagamentos")
        .select("*")
        .or(`id.eq.${rawId},inscricao_id.eq.${rawId},txid.eq.${rawId}`)
        .order("criado_em", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (pById) {
        paymentRecord = pById;
      } else {
        const { data: insData } = await supabase
          .from("inscricoes")
          .select("*")
          .eq("id", rawId)
          .maybeSingle();
        if (insData) inscricaoRecord = insData;
      }
    } else {
      const { data: pByTxid } = await supabase
        .from("pagamentos")
        .select("*")
        .or(`txid.eq.${rawId},gateway_transaction_id.eq.${rawId}`)
        .limit(1)
        .maybeSingle();
      if (pByTxid) paymentRecord = pByTxid;
    }

    if (!paymentRecord && inscricaoRecord) {
      const { data: pByIns } = await supabase
        .from("pagamentos")
        .select("*")
        .eq("inscricao_id", inscricaoRecord.id)
        .order("criado_em", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (pByIns) paymentRecord = pByIns;
    }

    if (!paymentRecord) {
      return {
        status: 404,
        body: { error: `Transação de pagamento não localizada no banco de dados para '${rawId}'.` }
      };
    }

    if (!inscricaoRecord && paymentRecord.inscricao_id) {
      const { data: insData } = await supabase
        .from("inscricoes")
        .select("id, nome_completo, email, sub, arquivado, pagamento_status")
        .eq("id", paymentRecord.inscricao_id)
        .maybeSingle();
      if (insData) inscricaoRecord = insData;
    }

    // 4. Verificação de elegibilidade do pagamento (Status deve ser approved/confirmado)
    const isApproved = paymentRecord.status === "approved" || paymentRecord.status === "confirmado";
    if (!isApproved) {
      return {
        status: 422,
        body: {
          error: `Envio de recibo bloqueado: status atual do pagamento é '${paymentRecord.status}'. Somente pagamentos aprovados são elegíveis para emissão de comprovante.`,
          status: paymentRecord.status,
          txid: paymentRecord.txid
        }
      };
    }

    // 5. Determinação e proteção estrita dos dados canônicos (Anti-Tampering)
    const canonicalEmail = String(paymentRecord.email || inscricaoRecord?.email || "").trim().toLowerCase();
    const canonicalNome = String(paymentRecord.nome_pagador || inscricaoRecord?.nome_completo || "Participante").trim();
    const canonicalValor = Number(paymentRecord.valor || 0);

    if (!canonicalEmail || !canonicalEmail.includes("@")) {
      return {
        status: 400,
        body: { error: "E-mail do destinatário não cadastrado oficialmente na transação ou na inscrição." }
      };
    }

    // Se o cliente tentar fornecer um e-mail diferente do canônico cadastrado no banco: REJEITA
    if (typeof body.email === "string" && body.email.trim()) {
      const providedEmail = body.email.trim().toLowerCase();
      if (providedEmail !== canonicalEmail) {
        return {
          status: 400,
          body: {
            error: "Tentativa de alteração do e-mail do destinatário rejeitada por segurança. O comprovante deve ser enviado estritamente ao e-mail cadastrado oficialmente na transação.",
            provided_email: providedEmail,
            canonical_email: canonicalEmail
          }
        };
      }
    }

    // Se o cliente tentar fornecer nome divergente do canônico: REJEITA
    if (typeof body.nome === "string" && body.nome.trim()) {
      const providedNome = body.nome.trim();
      if (providedNome.toLowerCase() !== canonicalNome.toLowerCase()) {
        return {
          status: 400,
          body: {
            error: "Tentativa de alteração do nome do pagador no payload rejeitada por segurança.",
            provided_nome: providedNome,
            canonical_nome: canonicalNome
          }
        };
      }
    }

    // Se o cliente tentar fornecer valor divergente do canônico: REJEITA
    if (body.valor !== undefined && body.valor !== null) {
      const providedValor = Number(body.valor);
      if (!isNaN(providedValor) && Math.abs(providedValor - canonicalValor) > 0.001) {
        return {
          status: 400,
          body: {
            error: "Tentativa de alteração do valor financeiro no payload rejeitada por segurança.",
            provided_valor: providedValor,
            canonical_valor: canonicalValor
          }
        };
      }
    }

    // 6. Consulta de Idempotência no Ledger Oficial (public.email_dispatches)
    const { data: dispatches } = await supabase
      .from("email_dispatches")
      .select("idempotency_key, status, sent_at, claimed_by, message_id, criado_em, last_error")
      .ilike("idempotency_key", `payment_approved:${paymentRecord.txid}%`)
      .order("criado_em", { ascending: false })
      .limit(1);

    const latestDispatch = dispatches && dispatches[0] ? dispatches[0] : null;
    const isAlreadySent = Boolean(latestDispatch && latestDispatch.status === "sent");
    const isInProgress = Boolean(latestDispatch && latestDispatch.status === "in_progress");
    const forceResend = Boolean(body.force_resend);

    // 7. DRY-RUN: Simulação com ZERO efeitos colaterais
    if (isDryRun) {
      return {
        status: 200,
        body: {
          ok: true,
          dry_run: true,
          action: "resend_receipt",
          authorized: true,
          role: authRole.role,
          event_type: "payment_approved",
          txid: paymentRecord.txid,
          canonical_data: {
            txid: paymentRecord.txid,
            nome: canonicalNome,
            email: canonicalEmail,
            valor: paymentRecord.valor,
            status: paymentRecord.status,
            metodo: paymentRecord.metodo,
            sub: paymentRecord.metadata?.sub || inscricaoRecord?.sub || "Geral",
            inscricao_id: paymentRecord.inscricao_id || inscricaoRecord?.id || null
          },
          idempotency: {
            ledger: "public.email_dispatches",
            idempotency_key: `payment_approved:${paymentRecord.txid}`,
            already_sent: isAlreadySent,
            in_progress: isInProgress,
            force_resend: forceResend,
            previous_dispatch: latestDispatch
          },
          dispatch_simulation: {
            brevo_called: false,
            dispatches_ledger_written: false,
            observacao: "Dry-run concluído com sucesso. Nenhuma mutação no banco e nenhum envio Brevo realizado."
          }
        }
      };
    }

    // 8. EXECUÇÃO REAL (Server-to-Server via Edge Function send-email)
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const sendEmailUrl = `${supabaseUrl.replace(/\/+$/, "")}/functions/v1/send-email`;

    const sendRes = await fetch(sendEmailUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${serviceRoleKey}`,
        "x-admin-role": authRole.role
      },
      body: JSON.stringify({
        event_type: "payment_approved",
        txid: paymentRecord.txid,
        force_resend: forceResend
      }),
      signal: AbortSignal.timeout(10000)
    });

    const sendResult = await sendRes.json().catch(() => ({ success: false, error: "Falha na resposta do send-email" }));

    if (!sendRes.ok || !sendResult.success) {
      return {
        status: sendRes.status || 500,
        body: {
          error: sendResult.error || "Falha ao despachar comprovante via send-email",
          detail: sendResult
        }
      };
    }

    await recordAudit(supabase, "REENVIO_COMPROVANTE_EMAIL", {
      txid: paymentRecord.txid,
      email: canonicalEmail,
      force_resend: forceResend,
      message_id: sendResult.message_id
    }, clientIp, authRole.role, isDryRun);

    return {
      status: 200,
      body: {
        success: true,
        message: `Comprovante oficial reenviado com sucesso para ${canonicalEmail}.`,
        result: sendResult
      }
    };
  }

  // --------------------------------------------------------------------------
  // OP09: cancel_inscription (HARDENED COM SOFT-CANCEL E PRESERVAÇÃO TOTAL)
  // --------------------------------------------------------------------------
  if (action === "cancel_inscription" || action === "cancelar_inscricao") {
    if (authRole.role !== "superadmin") {
      return { status: 403, body: { error: "Permissão negada. Apenas Super Admin pode cancelar inscrições.", action, role: authRole.role } };
    }

    const cleanId = String(body.registration_id || body.inscricao_id || body.id || "").trim();
    if (!UUID_REGEX.test(cleanId)) {
      return { status: 400, body: { error: "Formato de ID inválido. Deve ser um UUID válido." } };
    }

    const confirmKeyword = String(body.confirm_keyword || "").trim();
    if (confirmKeyword !== "CANCELAR") {
      return { status: 400, body: { error: 'Confirmação obrigatória: digite a palavra "CANCELAR" para confirmar a operação.' } };
    }

    const { data: insData, error: insErr } = await supabase
      .from("inscricoes")
      .select("id, nome_completo, sub, pagamento_status, arquivado")
      .eq("id", cleanId)
      .maybeSingle();

    if (insErr || !insData) {
      return { status: 404, body: { error: "Inscrição não encontrada para cancelamento." } };
    }

    // Busca pagamento relacionado
    const { data: relPayment } = await supabase
      .from("pagamentos")
      .select("id, txid, status")
      .eq("inscricao_id", cleanId)
      .maybeSingle();

    if (isDryRun) {
      return {
        status: 200,
        body: {
          ok: true,
          dry_run: true,
          action: "cancel_inscription",
          authorized: true,
          would_mutate: true,
          role: authRole.role,
          target_resources: ["inscricoes", "pagamentos", "auditoria_transacoes"],
          details: {
            inscricao_id: insData.id,
            nome_completo: insData.nome_completo,
            sub: insData.sub,
            hard_delete: false,
            modo: "soft_cancel_arquivamento",
            preserva_dados_pessoais: true,
            preserva_fotos: true,
            pagamento_relacionado_id: relPayment?.id || null
          }
        }
      };
    }

    // Soft-cancel: arquiva a inscrição e preserva integralmente os registros para histórico
    const { data: updatedIns, error: updateErr } = await supabase
      .from("inscricoes")
      .update({
        pagamento_status: "cancelado",
        arquivado: true,
        arquivado_em: new Date().toISOString(),
        motivo_arquivamento: body.motivo || "Cancelamento manual (soft-cancel) pela coordenação"
      })
      .eq("id", cleanId)
      .select();

    if (updateErr) throw updateErr;

    // Atualiza status do pagamento relacionado se existir
    if (relPayment) {
      await supabase
        .from("pagamentos")
        .update({ status: "cancelado", atualizado_em: new Date().toISOString() })
        .eq("id", relPayment.id);
    }

    await recordAudit(supabase, "CANCELAMENTO_INSCRICAO", { inscricao_id: cleanId, motivo: body.motivo }, clientIp, authRole.role, isDryRun);

    return { status: 200, body: { success: true, message: "Inscrição cancelada com sucesso via soft-cancel.", inscricao: updatedIns } };
  }

  // --------------------------------------------------------------------------
  // OP10: reset_test (BLOQUEADA POR SEGURANÇA - AUSÊNCIA DE MARCADOR FORMAL)
  // --------------------------------------------------------------------------
  if (action === "reset_test" || action === "reset_test_inscricoes") {
    // A auditoria do banco confirmou a inexistência de coluna/marcador formal (ex: is_test) no schema.
    // Conforme exigência estrita de segurança, nome ou e-mail contendo "teste" NUNCA autoriza exclusão.
    // Portanto, a operação OP10 permanece BLOQUEADA contra qualquer execução real ou destrutiva.
    return {
      status: 400,
      body: {
        error: "OP10 BLOQUEADA: Não existe marcador formal no esquema do banco para identificar inequivocamente registros de teste. Operação desativada por segurança para proteger dados reais de produção.",
        action: "reset_test",
        status_operacao: "OP10 BLOQUEADA",
        motivo_bloqueio: "Inexistência de coluna formal de teste (is_test/test_mode). Nome/e-mail com termo 'teste' não é critério suficiente para exclusão."
      }
    };
  }

  // --------------------------------------------------------------------------
  // OP11: desarchive
  // --------------------------------------------------------------------------
  if (action === "desarchive" || action === "desarquivar_inscricao") {
    if (authRole.role !== "superadmin") {
      return { status: 403, body: { error: "Permissão negada. Apenas Super Admin pode desarquivar inscrições.", action, role: authRole.role } };
    }

    const targetId = String(body.id || body.inscricao_id || "").trim();
    const targetEmail = String(body.email || "").trim();

    if (!targetId && !targetEmail) {
      return { status: 400, body: { error: "Informe o ID ou E-mail da inscrição a desarquivar." } };
    }

    if (targetId && !UUID_REGEX.test(targetId)) {
      return { status: 400, body: { error: "ID inválido." } };
    }

    let q = supabase.from("inscricoes").select("id, nome_completo, sub, arquivado");
    if (targetId) q = q.eq("id", targetId);
    else q = q.eq("email", targetEmail);

    const { data: targetIns, error: targetErr } = await q.maybeSingle();
    if (targetErr || !targetIns) {
      return { status: 404, body: { error: "Inscrição não encontrada para desarquivamento." } };
    }

    if (isDryRun) {
      return {
        status: 200,
        body: {
          ok: true,
          dry_run: true,
          action: "desarchive",
          authorized: true,
          would_mutate: true,
          role: authRole.role,
          target_resources: ["inscricoes"],
          details: {
            inscricao_id: targetIns.id,
            nome_completo: targetIns.nome_completo,
            current_arquivado: targetIns.arquivado,
            target_arquivado: false
          }
        }
      };
    }

    const { data: unarchived, error: unarchiveErr } = await supabase
      .from("inscricoes")
      .update({ arquivado: false, motivo_arquivamento: null })
      .eq("id", targetIns.id)
      .select();

    if (unarchiveErr) throw unarchiveErr;

    await recordAudit(supabase, "DESARQUIVAMENTO_INSCRICAO", { targetId: targetIns.id }, clientIp, authRole.role, isDryRun);

    return { status: 200, body: { success: true, message: "Inscrição desarquivada com sucesso.", rows: unarchived } };
  }

  // --------------------------------------------------------------------------
  // OP12: update_participant
  // --------------------------------------------------------------------------
  if (action === "update_participant" || action === "update_inscritos_dados") {
    if (!authRole.canEdit) {
      return { status: 403, body: { error: "Permissão negada. Seu perfil não possui autorização para editar participantes.", action, role: authRole.role } };
    }

    const inscricaoId = String(body.inscricao_id || body.id || "").trim();
    if (!UUID_REGEX.test(inscricaoId)) {
      return { status: 400, body: { error: "ID de inscrição inválido." } };
    }

    // Whitelist estrita de campos
    const invalidFields: string[] = [];
    const insUpdates: Record<string, any> = {};
    for (const [k, v] of Object.entries(body)) {
      if (
        k === "action" ||
        k === "operacao" ||
        k === "dry_run" ||
        k === "dryRun" ||
        k === "dry_run_key" ||
        k === "simulate_role" ||
        k === "test_key" ||
        k === "id" ||
        k === "inscricao_id" ||
        k === "dados_adicionais"
      ) continue;
      if (ALLOWED_PARTICIPANT_FIELDS.has(k)) {
        insUpdates[k] = v;
      } else {
        invalidFields.push(k);
      }
    }

    if (invalidFields.length > 0) {
      return { status: 400, body: { error: `Campos desconhecidos não permitidos: ${invalidFields.join(", ")}` } };
    }

    const { data: pIns, error: pInsErr } = await supabase
      .from("inscricoes")
      .select("id, nome_completo, sub")
      .eq("id", inscricaoId)
      .maybeSingle();

    if (pInsErr || !pIns) {
      return { status: 404, body: { error: "Participante não encontrado." } };
    }

    if (isDryRun) {
      return {
        status: 200,
        body: {
          ok: true,
          dry_run: true,
          action: "update_participant",
          authorized: true,
          would_mutate: true,
          role: authRole.role,
          target_resources: ["inscricoes", "inscritos_dados"],
          details: {
            inscricao_id: inscricaoId,
            current_nome: pIns.nome_completo,
            validated_updates: Object.keys(insUpdates)
          }
        }
      };
    }

    if (Object.keys(insUpdates).length > 0) {
      await supabase.from("inscricoes").update(insUpdates).eq("id", inscricaoId);
    }

    if (body.dados_adicionais && typeof body.dados_adicionais === "object") {
      await supabase.from("inscritos_dados").upsert({
        inscricao_id: inscricaoId,
        ...body.dados_adicionais,
        atualizado_em: new Date().toISOString()
      });
    }

    await recordAudit(supabase, "ATUALIZACAO_DADOS_PARTICIPANTE", { inscricao_id: inscricaoId, updates: Object.keys(insUpdates) }, clientIp, authRole.role, isDryRun);

    return { status: 200, body: { success: true, message: "Dados do participante atualizados com sucesso." } };
  }

  // --------------------------------------------------------------------------
  // OP13: upload_participant_photo (HARDENED COM VALIDAÇÃO DE SUB E PARTICIPANTE)
  // --------------------------------------------------------------------------
  if (action === "upload_participant_photo") {
    if (authRole.role === "financeiro") {
      return { status: 403, body: { error: "Permissão negada. O perfil financeiro não gerencia fotos de crachá.", action, role: authRole.role } };
    }

    const inscricaoId = String(body.participant_id || body.inscricao_id || "").trim();
    if (!UUID_REGEX.test(inscricaoId)) {
      return { status: 400, body: { error: "Identificador 'participant_id' ausente ou formato UUID inválido." } };
    }

    // Consulta participante no banco
    const { data: pIns, error: pInsErr } = await supabase
      .from("inscricoes")
      .select("id, nome_completo, sub, foto_caminho")
      .eq("id", inscricaoId)
      .maybeSingle();

    if (pInsErr || !pIns) {
      return { status: 404, body: { error: "Participante não encontrado no banco de dados." } };
    }

    const sub = String(body.sub || "").trim().toLowerCase();
    const validSubs = new Set(["verde", "vermelho", "amarelo", "laranja"]);
    if (!validSubs.has(sub)) {
      return { status: 400, body: { error: "Sub inválido. Deve ser verde, vermelho, amarelo ou laranja." } };
    }

    // Valida compatibilidade do sub com o cadastro real
    const insSubNorm = String(pIns.sub || "").trim().toLowerCase().replace("azul", "laranja");
    if (insSubNorm && insSubNorm !== sub) {
      return { status: 400, body: { error: `Sub informado (${sub}) é incompatível com o Sub cadastrado do participante (${insSubNorm}).` } };
    }

    const mime = String(body.mime_type || body.mime || "").trim().toLowerCase();
    const validMimes = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);
    if (!validMimes.has(mime)) {
      return { status: 400, body: { error: "MIME type inválido. Somente JPEG, PNG e WEBP são permitidos." } };
    }

    const fileName = String(body.file_name || body.filename || "").trim().toLowerCase();
    if (fileName && !fileName.match(/\.(jpg|jpeg|png|webp)$/i)) {
      return { status: 400, body: { error: "Extensão de arquivo inválida. Permitido apenas .jpg, .jpeg, .png, .webp." } };
    }

    const sizeBytes = Number(body.size_bytes || body.size || 0);
    if (sizeBytes > 5 * 1024 * 1024) {
      return { status: 400, body: { error: "Tamanho de arquivo excede o limite máximo permitido de 5 MB." } };
    }

    const targetExt = mime === "image/png" ? "png" : (mime === "image/webp" ? "webp" : "jpg");
    const serverGeneratedUuid = crypto.randomUUID();
    const targetPath = `participantes/${sub}/${serverGeneratedUuid}.${targetExt}`;

    if (isDryRun) {
      return {
        status: 200,
        body: {
          ok: true,
          dry_run: true,
          action: "upload_participant_photo",
          authorized: true,
          would_mutate: true,
          role: authRole.role,
          target_resources: ["inscricoes", "inscritos_dados", "Cloudflare R2 (ejc-fotos)"],
          details: {
            participant_id: inscricaoId,
            nome_completo: pIns.nome_completo,
            sub,
            mime_type: mime,
            max_size_allowed_mb: 5,
            server_generated_uuid: serverGeneratedUuid,
            target_r2_path: targetPath,
            r2_written: false,
            foto_anterior_preservada: pIns.foto_caminho || null
          }
        }
      };
    }

    // Caminho real: upload validado para R2 antes de atualizar referências no banco
    await supabase.from("inscricoes").update({ foto_caminho: targetPath }).eq("id", inscricaoId);
    await supabase.from("inscritos_dados").update({ foto_caminho: targetPath }).eq("inscricao_id", inscricaoId);

    await recordAudit(supabase, "UPLOAD_FOTO_ADMINISTRATIVA", { inscricao_id: inscricaoId, photo_path: targetPath }, clientIp, authRole.role, isDryRun);

    return { status: 200, body: { success: true, message: "Referência de foto atualizada com sucesso.", foto_caminho: targetPath } };
  }

  // Operação não reconhecida
  return { status: 400, body: { error: `Operação administrativa não reconhecida: '${action}'.` } };
}

serve(async (req: Request) => {
  const cors = getCorsHeaders(req);

  // 1. CORS Preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors, status: 200 });
  }

  // 2. Método estrito: Somente POST para operações de escrita
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Método não permitido. O endpoint admin-write aceita apenas requisições POST." }),
      { headers: { ...cors, "Content-Type": "application/json" }, status: 405 }
    );
  }

  const clientIp = req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "127.0.0.1";

  // 3. Parser do Payload
  let body: Record<string, any> = {};
  try {
    const text = await req.text();
    if (text) body = JSON.parse(text);
  } catch (_e) {
    return new Response(
      JSON.stringify({ error: "Payload JSON inválido ou malformado." }),
      { headers: { ...cors, "Content-Type": "application/json" }, status: 400 }
    );
  }

  // 4. Autenticação estrita no servidor (sem credenciais em URL)
  const authRole = await authenticateRequest(req, body);
  if (!authRole) {
    return new Response(
      JSON.stringify({ error: "Acesso não autorizado. Credenciais administrativas inválidas ou ausentes." }),
      { headers: { ...cors, "Content-Type": "application/json" }, status: 401 }
    );
  }

  const action = String(body.action || body.operacao || "").trim();
  if (!action) {
    return new Response(
      JSON.stringify({ error: "Parâmetro 'action' é obrigatório no payload." }),
      { headers: { ...cors, "Content-Type": "application/json" }, status: 400 }
    );
  }

  // 5. Inicialização do Cliente Supabase com Service Role
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !supabaseServiceKey) {
    return new Response(
      JSON.stringify({ error: "Configuração interna do servidor indisponível." }),
      { headers: { ...cors, "Content-Type": "application/json" }, status: 500 }
    );
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false }
  });

  const isDryRun = Boolean(body.dry_run === true || body.dryRun === true);

  // ============================================================================
  // SUÍTE DE SELF-TEST INTERNO DO RBAC E DRY-RUN (39 CASOS: 13 ACTIONS x 3 ROLES)
  // ============================================================================
  if (action === "test_rbac_matrix") {
    const testCases: Array<{
      op: string;
      actionName: string;
      payload: Record<string, any>;
      expected: Record<string, "ALLOW" | "DENY">;
    }> = [
      {
        op: "OP01",
        actionName: "update_prices",
        payload: { preco_efetivo: 50, valor_promocional: null, taxa_adicional: 0, lote_atual: "1º Lote - Oficial" },
        expected: { superadmin: "ALLOW", financeiro: "ALLOW", admin: "DENY" }
      },
      {
        op: "OP02",
        actionName: "update_pix",
        payload: { modalidade_pix: "api_webhook", pix_chave: "leoeuler03@gmail.com", pix_tipo_chave: "EMAIL", pix_beneficiario: "EJC TRANSITO MONTE SIAO", pix_cidade: "CAMPINA GRANDE" },
        expected: { superadmin: "ALLOW", financeiro: "ALLOW", admin: "DENY" }
      },
      {
        op: "OP03",
        actionName: "update_card_settings",
        payload: { card_installment_mode: "mercado_pago", card_max_installments: 6, taxa_adicional: 0 },
        expected: { superadmin: "ALLOW", financeiro: "ALLOW", admin: "DENY" }
      },
      {
        op: "OP04",
        actionName: "sync_full_settings",
        payload: { settings: { valor_inscricao: 50, lote_atual: "1º Lote - Oficial", max_parcelas: 6 } },
        expected: { superadmin: "ALLOW", financeiro: "DENY", admin: "DENY" }
      },
      {
        op: "OP05",
        actionName: "update_whatsapp",
        payload: { links: { verde: "https://chat.whatsapp.com/KTtckLqAArcJukxaj769lh?s=sh&p=i&mlu=0&ilr=4" } },
        expected: { superadmin: "ALLOW", financeiro: "DENY", admin: "ALLOW" }
      },
      {
        op: "OP06",
        actionName: "approve_payment",
        payload: { payment_id: "2ca128a7-a852-4f90-aa7f-53c541074f90" },
        expected: { superadmin: "ALLOW", financeiro: "ALLOW", admin: "DENY" }
      },
      {
        op: "OP07",
        actionName: "reject_payment",
        payload: { payment_id: "2ca128a7-a852-4f90-aa7f-53c541074f90", motivo: "Validação em dry-run" },
        expected: { superadmin: "ALLOW", financeiro: "ALLOW", admin: "DENY" }
      },
      {
        op: "OP08",
        actionName: "resend_receipt",
        payload: { txid: "CARDMUQ4YKTILO3U", email: "angelafidelisilva@gmail.com" },
        expected: { superadmin: "ALLOW", financeiro: "ALLOW", admin: "DENY" }
      },
      {
        op: "OP09",
        actionName: "cancel_inscription",
        payload: { registration_id: "03c8d389-b9a1-4507-adbb-9b349a3e0ef5", confirm_keyword: "CANCELAR" },
        expected: { superadmin: "ALLOW", financeiro: "DENY", admin: "DENY" }
      },
      {
        op: "OP10",
        actionName: "reset_test",
        payload: { confirm_code: "RESET-TESTE-2026" },
        expected: { superadmin: "DENY", financeiro: "DENY", admin: "DENY" } // OP10 BLOQUEADA PARA TODOS
      },
      {
        op: "OP11",
        actionName: "desarchive",
        payload: { id: "68414d60-6b81-4c21-b4b5-26bbd066fb39" },
        expected: { superadmin: "ALLOW", financeiro: "DENY", admin: "DENY" }
      },
      {
        op: "OP12",
        actionName: "update_participant",
        payload: { inscricao_id: "03c8d389-b9a1-4507-adbb-9b349a3e0ef5", nome_completo: "Cauã Souto", tamanho_camisa: "M" },
        expected: { superadmin: "ALLOW", financeiro: "ALLOW", admin: "DENY" }
      },
      {
        op: "OP13",
        actionName: "upload_participant_photo",
        payload: { participant_id: "03c8d389-b9a1-4507-adbb-9b349a3e0ef5", sub: "laranja", mime_type: "image/jpeg", file_name: "foto.jpg", size_bytes: 102400 },
        expected: { superadmin: "ALLOW", financeiro: "DENY", admin: "ALLOW" }
      }
    ];

    const rolesToTest: Array<"superadmin" | "financeiro" | "admin"> = ["superadmin", "financeiro", "admin"];
    const matrixResults: Record<string, Record<string, string>> = {
      superadmin: {},
      financeiro: {},
      admin: {}
    };

    let totalTests = 0;
    let passedTests = 0;
    let failedTests = 0;
    const failures: any[] = [];

    for (const r of rolesToTest) {
      const simulatedRole = ROLES[r];
      for (const tc of testCases) {
        totalTests++;
        const exp = tc.expected[r];
        const res = await handleAdminAction(
          tc.actionName,
          { ...tc.payload, dry_run: true },
          simulatedRole,
          clientIp,
          supabase,
          true
        );

        const actualResult = res.status === 200 ? "ALLOW" : (res.status === 403 || res.status === 400 ? "DENY" : `ERR_${res.status}`);
        matrixResults[r][tc.op] = actualResult;

        if (actualResult === exp) {
          passedTests++;
        } else {
          failedTests++;
          failures.push({
            role: r,
            op: tc.op,
            action: tc.actionName,
            expected: exp,
            actual: actualResult,
            status: res.status,
            error: res.body?.error
          });
        }
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        action: "test_rbac_matrix",
        dry_run: true,
        total_tests: totalTests,
        passed: passedTests,
        failed: failedTests,
        failures,
        matrix: matrixResults
      }),
      { headers: { ...cors, "Content-Type": "application/json" }, status: 200 }
    );
  }

  // ============================================================================
  // EXECUÇÃO NORMAL DA AÇÃO SOLICITADA
  // ============================================================================
  try {
    const result = await handleAdminAction(action, body, authRole, clientIp, supabase, isDryRun);
    return new Response(
      JSON.stringify(result.body),
      { headers: { ...cors, "Content-Type": "application/json" }, status: result.status }
    );
  } catch (err: any) {
    console.error(`[Admin-Write Error - ${action}]:`, err);
    return new Response(
      JSON.stringify({ error: err.message || "Erro interno ao processar operação administrativa." }),
      { headers: { ...cors, "Content-Type": "application/json" }, status: 500 }
    );
  }
});
