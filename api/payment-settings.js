// ==============================================================================
// VERCEL SERVERLESS FUNCTION: /api/payment-settings
// Gestão administrativa centralizada de configurações financeiras, preços e PIX
// Integração direta com o store unificado multi-camadas (_settings-store.js)
// TOLERÂNCIA ZERO A FALSO SUCESSO (Zero Fake Success)
// ==============================================================================

const settingsStore = require("./_settings-store");
const adminAuth = require("./_admin-auth");
const { applyCors } = require("./_cors");

const VALID_KEY_TYPES = ["EMAIL", "CPF", "CNPJ", "TELEFONE", "ALEATORIA"];

function validarFormatoChavePix(chave, tipo) {
  let c = String(chave || "").trim();
  if (!c) return { valido: false, erro: "A chave PIX não pode ser vazia." };
  if (c.includes("***")) return { valido: true, mascarada: true };

  c = settingsStore.normalizarChavePix ? settingsStore.normalizarChavePix(c, tipo) : c;

  switch (tipo) {
    case "EMAIL":
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c)) {
        return { valido: false, erro: "Formato de e-mail inválido para chave PIX." };
      }
      break;
    case "CPF":
      const cpfDigits = c.replace(/\D/g, "");
      if (cpfDigits.length !== 11) {
        return { valido: false, erro: "Chave CPF deve conter exatamente 11 dígitos numéricos." };
      }
      break;
    case "CNPJ":
      const cnpjDigits = c.replace(/\D/g, "");
      if (cnpjDigits.length !== 14) {
        return { valido: false, erro: "Chave CNPJ deve conter exatamente 14 dígitos numéricos." };
      }
      break;
    case "TELEFONE":
      const phoneDigits = c.replace(/\D/g, "");
      if (phoneDigits.length !== 10 && phoneDigits.length !== 11) {
        return { valido: false, erro: "Telefone deve conter DDD + número (10 ou 11 dígitos, sem +55)." };
      }
      break;
    case "ALEATORIA":
      if (c.length < 16) {
        return { valido: false, erro: "Chave aleatória (EVP) deve conter no mínimo 16 caracteres." };
      }
      break;
    default:
      if (c.length < 3) {
        return { valido: false, erro: "Chave PIX muito curta ou inválida." };
      }
  }
  return { valido: true, chaveNormalizada: c };
}

function mascararChave(chave, tipo) {
  const c = String(chave || "");
  if (!c) return "";
  if (tipo === "EMAIL" && c.includes("@")) {
    const parts = c.split("@");
    const name = parts[0];
    const maskedName = name.length > 3 ? name.slice(0, 3) + "***" : "***";
    return `${maskedName}@${parts[1]}`;
  }
  if (c.length > 8) {
    return c.slice(0, 4) + "****" + c.slice(-4);
  }
  return "****";
}

module.exports = async (req, res) => {
  applyCors(req, res);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-admin-token, x-admin-role");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Normalização de body
  let bodyData = req.body;
  if (typeof bodyData === "string") {
    try {
      bodyData = JSON.parse(bodyData);
    } catch (e) {}
  }
  if (!bodyData || typeof bodyData !== "object") {
    bodyData = {};
  }

  // Verificação de autenticação administrativa server-side
  const auth = adminAuth.authenticate({
    headers: req.headers,
    body: bodyData
  });

  if (!auth.ok && req.method !== "GET") {
    return res.status(401).json({ error: "Acesso não autorizado: credenciais administrativas necessárias." });
  }

  const userRole = auth.ok ? auth.role : "comum";
  const canEditFinance = Boolean(auth.ok && auth.canEditFinance);
  const canEditWhatsapp = Boolean(auth.ok && auth.canEditWhatsapp);
  const canApprove = Boolean(auth.ok && auth.canApprovePayments);

  // ==============================================================================
  // 1. CONSULTA DE CONFIGURAÇÕES (GET)
  // ==============================================================================
  if (req.method === "GET") {
    try {
      const activeData = await settingsStore.getActiveSettings();
      const settings = activeData.settings;
      if (settings && settings.pix_chave && settingsStore.normalizarChavePix) {
        settings.pix_chave = settingsStore.normalizarChavePix(settings.pix_chave, settings.pix_tipo_chave);
      }
      const maskedKey = mascararChave(settings.pix_chave, settings.pix_tipo_chave);

      const modalidadeEfetiva = settings.modalidade_pix || settings.pix_mode || "api_webhook";
      return res.status(200).json({
        success: true,
        settings: {
          ...settings,
          card_installment_mode: settings.card_installment_mode || "mercado_pago",
          card_max_installments: Number(settings.card_max_installments || settings.max_parcelas || 6),
          card_installment_rates: Array.isArray(settings.card_installment_rates) && settings.card_installment_rates.length > 0
            ? settings.card_installment_rates
            : (settingsStore.getDefaultCardRates ? settingsStore.getDefaultCardRates() : []),
          mp_public_key: settings.mp_public_key || process.env.NEXT_PUBLIC_MERCADO_PAGO_PUBLIC_KEY || process.env.MERCADOPAGO_PUBLIC_KEY || "",
          modalidade_pix: modalidadeEfetiva,
          pix_mode: modalidadeEfetiva,
          pix_chave_mascarada: maskedKey,
          // Chave completa só enviada para papéis autorizados financeiramente
          pix_chave: canEditFinance ? settings.pix_chave : maskedKey
        },
        lotes: activeData.lotes || [],
        historico: auth.ok ? (activeData.historico || []) : [],
        whatsapp: activeData.whatsapp || {},
        permissions: {
          canEdit: canEditFinance,
          canEditFinance: canEditFinance,
          canEditWhatsapp: canEditWhatsapp,
          canApprovePayments: canApprove,
          role: userRole,
          allowedActions: canEditFinance
            ? ["finance.view", "finance.edit", "payment.settings.edit", "pix.settings.edit", "card.settings.edit", "whatsapp.edit", "payments.approve"]
            : (canEditWhatsapp ? ["finance.view", "whatsapp.edit"] : ["finance.view"])
        }
      });
    } catch (err) {
      console.error("[Payment Settings GET Error]", err);
      return res.status(500).json({ error: "Erro ao consultar configurações financeiras ativas." });
    }
  }

  // ==============================================================================
  // 2. ATUALIZAÇÃO DE CONFIGURAÇÕES (POST / PUT)
  // ==============================================================================
  if (req.method === "POST" || req.method === "PUT") {
    const {
      action,
      usuario,
      motivo,
      // Dados para preços
      lote_atual,
      valor_inscricao,
      valor_promocional,
      taxa_adicional,
      max_parcelas,
      // Dados para PIX
      modalidade_pix,
      pix_mode,
      pix_chave,
      pix_tipo_chave,
      pix_beneficiario,
      pix_documento,
      pix_cidade,
      pix_instrucoes_manual,
      pix_permite_comprovante,
      // Dados para WhatsApp
      subs,
      // Dados para aprovação de pagamento manual
      txid,
      payment_id,
      identificador
    } = bodyData;

    const adminUser = usuario || userRole || "admin";
    const clientIp = req.headers?.["x-forwarded-for"] || req.socket?.remoteAddress || "127.0.0.1";

    // Validação de permissões para ações financeiras estritas
    if (["update_prices", "update_pix", "update_card_settings", "update_card", "sync_full_settings"].includes(action)) {
      if (!canEditFinance) {
        return res.status(403).json({
          error: "Permissão insuficiente. Apenas administradores financeiros ou a coordenação geral podem alterar dados financeiros."
        });
      }
    }

    // Validação de permissões para aprovação/rejeição de pagamentos
    if (["approve_payment", "reject_payment"].includes(action)) {
      if (!canApprove) {
        return res.status(403).json({
          error: "Permissão insuficiente. Apenas administradores financeiros ou a coordenação geral podem aprovar ou rejeitar pagamentos."
        });
      }
    }

    // Validação de permissões para WhatsApp
    if (action === "update_whatsapp") {
      if (!canEditWhatsapp) {
        return res.status(403).json({
          error: "Permissão insuficiente para alterar links de WhatsApp."
        });
      }
    }

    // Ação A: Atualizar Preços
    if (action === "update_prices") {
      const valorNumerico = Number(valor_inscricao);
      if (isNaN(valorNumerico) || valorNumerico <= 0) {
        return res.status(400).json({ error: "O valor da inscrição deve ser um número positivo e maior que zero." });
      }

      try {
        const result = await settingsStore.updatePriceSettings({
          usuario: adminUser,
          lote_atual: lote_atual || "1º Lote",
          valor_inscricao: valorNumerico,
          valor_promocional: valor_promocional,
          taxa_adicional: taxa_adicional,
          max_parcelas: max_parcelas,
          motivo: motivo,
          ip: String(clientIp)
        });

        return res.status(200).json(result);
      } catch (err) {
        console.error("[Update Prices Error]", err);
        return res.status(500).json({
          success: false,
          error: err.message || "Falha ao persistir alterações de preço no servidor."
        });
      }
    }

    // Ação B: Atualizar Parâmetros PIX
    if (action === "update_pix") {
      const modalidadeEscolhida = modalidade_pix || pix_mode;
      if (modalidadeEscolhida && !["api_webhook", "manual"].includes(modalidadeEscolhida)) {
        return res.status(400).json({
          error: "Modalidade PIX inválida. Escolha 'api_webhook' (Automático) ou 'manual' (Chave Fixa)."
        });
      }

      const tipoChave = pix_tipo_chave ? String(pix_tipo_chave).toUpperCase() : "ALEATORIA";
      if (!VALID_KEY_TYPES.includes(tipoChave)) {
        return res.status(400).json({
          error: `Tipo de chave PIX inválido. Permitidos: ${VALID_KEY_TYPES.join(", ")}`
        });
      }

      if (pix_chave && !pix_chave.includes("***")) {
        const validacao = validarFormatoChavePix(pix_chave, tipoChave);
        if (!validacao.valido) {
          return res.status(400).json({ error: validacao.erro });
        }
      }

      try {
        const result = await settingsStore.updatePixSettings({
          usuario: adminUser,
          modalidade_pix: modalidadeEscolhida,
          pix_chave: pix_chave,
          pix_tipo_chave: tipoChave,
          pix_beneficiario: pix_beneficiario,
          pix_documento: pix_documento,
          pix_cidade: pix_cidade,
          pix_instrucoes_manual: pix_instrucoes_manual,
          pix_permite_comprovante: pix_permite_comprovante !== false,
          motivo: motivo,
          ip: String(clientIp)
        });

        if (result.settings && result.settings.pix_chave) {
          result.settings.pix_chave = mascararChave(result.settings.pix_chave, result.settings.pix_tipo_chave);
        }

        return res.status(200).json(result);
      } catch (err) {
        console.error("[Update PIX Error]", err);
        return res.status(500).json({
          success: false,
          error: err.message || "Falha ao persistir alterações do PIX no servidor."
        });
      }
    }

    // Ação B.2: Atualizar Configurações do Cartão de Crédito e Parcelamento
    if (action === "update_card_settings" || action === "update_card") {
      try {
        const result = await settingsStore.updateCardSettings({
          usuario: adminUser,
          card_installment_mode: bodyData.card_installment_mode,
          card_max_installments: bodyData.card_max_installments,
          card_installment_rates: bodyData.card_installment_rates,
          mp_public_key: bodyData.mp_public_key,
          motivo: motivo,
          ip: String(clientIp)
        });

        return res.status(200).json(result);
      } catch (err) {
        console.error("[Update Card Settings Error]", err);
        return res.status(400).json({
          success: false,
          error: err.message || "Falha ao persistir configurações do cartão."
        });
      }
    }

    // Ação C: Sincronização Integral Anti-Downgrade
    if (action === "sync_full_settings") {
      try {
        const fullSettings = bodyData.settings || {};
        const result = await settingsStore.syncFullSettings({
          settings: fullSettings,
          usuario: adminUser,
          ip: String(clientIp)
        });

        return res.status(200).json({
          success: true,
          persisted: result.persisted,
          message: result.message || "Sincronização integral realizada com sucesso.",
          versao: result.versao,
          settings: result.settings
        });
      } catch (err) {
        console.error("[Sync Full Settings Error]", err);
        return res.status(500).json({
          success: false,
          error: err.message || "Falha ao sincronizar configurações no servidor."
        });
      }
    }

    // Ação D: Atualizar Links de WhatsApp dos Sub Grupos
    if (action === "update_whatsapp") {
      try {
        const result = await settingsStore.updateWhatsAppSettings({
          subsData: subs,
          usuario: adminUser,
          ip: String(clientIp)
        });
        return res.status(200).json(result);
      } catch (err) {
        console.error("[Update WhatsApp Error]", err);
        return res.status(500).json({
          success: false,
          error: err.message || "Falha ao persistir links do WhatsApp no servidor."
        });
      }
    }

    // Ação E: Aprovação Manual de Pagamento
    if (action === "approve_payment") {
      try {
        const result = await settingsStore.approvePayment({
          identificador: identificador,
          usuario: adminUser,
          ip: String(clientIp),
          email: bodyData.email,
          nome: bodyData.nome,
          valor: bodyData.valor,
          sub: bodyData.sub
        });
        return res.status(200).json(result);
      } catch (err) {
        console.error("[Approve Payment Error]", err);
        return res.status(500).json({
          success: false,
          error: err.message || "Falha ao aprovar pagamento no servidor."
        });
      }
    }

    // Ação F: Rejeição Manual de Pagamento / Comprovante
    if (action === "reject_payment") {
      try {
        const result = await settingsStore.rejectPayment({
          identificador: identificador,
          usuario: adminUser,
          motivo: motivo,
          ip: String(clientIp),
          email: bodyData.email,
          nome: bodyData.nome
        });
        return res.status(200).json(result);
      } catch (err) {
        console.error("[Reject Payment Error]", err);
        return res.status(500).json({
          success: false,
          error: err.message || "Falha ao rejeitar pagamento no servidor."
        });
      }
    }

    return res.status(400).json({
      error: "Ação não informada ou inválida. Use 'update_prices', 'update_pix', 'update_whatsapp', 'approve_payment' ou 'reject_payment'."
    });
  }

  return res.status(405).json({ error: "Método HTTP não permitido." });
};
