// ==============================================================================
// VERCEL SERVERLESS FUNCTION: /api/payment-settings
// Gestão administrativa centralizada de configurações financeiras, preços e PIX
// Integração direta com o store unificado multi-camadas (_settings-store.js)
// TOLERÂNCIA ZERO A FALSO SUCESSO (Zero Fake Success)
// ==============================================================================

const settingsStore = require("./_settings-store");

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
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-admin-token, x-admin-role");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Verificação de autenticação administrativa
  const authHeader = req.headers?.["authorization"] || "";
  const tokenHeader = req.headers?.["x-admin-token"] || "";
  const roleHeader = req.headers?.["x-admin-role"] || req.query?.role || "superadmin";
  const providedPass = req.body?.admin_pass || tokenHeader || authHeader.replace(/^Bearer\s+/i, "").trim();

  const validPasswords = {
    "ejc2026": "superadmin",
    "financeiro2026": "financeiro",
    "coordenacao2026": "comum"
  };

  const envAdminPass = process.env.ADMIN_PASSWORD || "ejc2026";
  const isAuthorized = providedPass === envAdminPass || Boolean(validPasswords[providedPass]);

  if (!isAuthorized && req.method !== "GET") {
    return res.status(401).json({ error: "Acesso não autorizado: credenciais administrativas necessárias." });
  }

  const userRole = validPasswords[providedPass] || (providedPass === envAdminPass ? "superadmin" : "comum");

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
      const canEdit = ["superadmin", "financeiro"].includes(userRole);
      const maskedKey = mascararChave(settings.pix_chave, settings.pix_tipo_chave);

      const modalidadeEfetiva = settings.modalidade_pix || settings.pix_mode || "api_webhook";
      return res.status(200).json({
        success: true,
        settings: {
          ...settings,
          modalidade_pix: modalidadeEfetiva,
          pix_mode: modalidadeEfetiva,
          pix_chave_mascarada: maskedKey,
          // Chave completa só enviada para papéis autorizados
          pix_chave: canEdit ? settings.pix_chave : maskedKey
        },
        lotes: activeData.lotes || [],
        historico: activeData.historico || [],
        whatsapp: activeData.whatsapp || {},
        permissions: {
          canEdit: canEdit,
          role: userRole,
          allowedActions: canEdit
            ? ["finance.view", "finance.edit", "payment.settings.edit", "pix.settings.edit", "whatsapp.edit", "payments.approve"]
            : ["finance.view"]
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
      action, // 'update_prices', 'update_pix', 'update_whatsapp', 'approve_payment'
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
    } = req.body || {};

    const adminUser = usuario || userRole || "admin";
    const clientIp = req.headers?.["x-forwarded-for"] || req.socket?.remoteAddress || "127.0.0.1";

    // Validação de permissões para ações financeiras estritas
    if (["update_prices", "update_pix", "sync_full_settings"].includes(action)) {
      if (!["superadmin", "financeiro"].includes(userRole)) {
        return res.status(403).json({
          error: "Permissão insuficiente. Apenas administradores financeiros ou coordenadores gerais podem editar dados financeiros."
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

        return res.status(200).json({
          success: true,
          persisted: true,
          message: result.message,
          novo_valor: result.settings.valor_inscricao,
          lote_atual: result.settings.lote_atual,
          versao: result.settings.versao,
          settings: result.settings
        });
      } catch (err) {
        console.error("[Update Prices Error]", err);
        return res.status(500).json({
          success: false,
          error: err.message || "Falha ao persistir novos preços no servidor."
        });
      }
    }

    // Ação B: Atualizar Dados do Recebedor PIX
    if (action === "update_pix") {
      const rawModalidade = modalidade_pix !== undefined ? modalidade_pix : (pix_mode !== undefined ? pix_mode : undefined);
      if (rawModalidade !== undefined && rawModalidade !== null && rawModalidade !== "") {
        if (rawModalidade !== "api_webhook" && rawModalidade !== "manual") {
          return res.status(400).json({ error: "Modalidade operacional do Pix inválida. Valores aceitos: 'api_webhook' ou 'manual'." });
        }
      }

      const activeData = await settingsStore.getActiveSettings();
      const currentSettings = activeData?.settings || {};
      const modalidadeFinal = rawModalidade || currentSettings.modalidade_pix || currentSettings.pix_mode || "api_webhook";

      const tipoChave = String(pix_tipo_chave || currentSettings.pix_tipo_chave || "EMAIL").toUpperCase();
      if (!VALID_KEY_TYPES.includes(tipoChave)) {
        return res.status(400).json({ error: `Tipo de chave PIX inválido. Tipos aceitos: ${VALID_KEY_TYPES.join(", ")}.` });
      }

      const chaveInformada = pix_chave !== undefined ? String(pix_chave).trim() : (currentSettings.pix_chave || "");
      const validacaoChave = validarFormatoChavePix(chaveInformada, tipoChave);
      if (!validacaoChave.valido && modalidadeFinal === "manual") {
        return res.status(400).json({ error: validacaoChave.erro });
      }

      const beneficiarioLimpo = pix_beneficiario !== undefined ? String(pix_beneficiario).trim() : (currentSettings.pix_beneficiario || "");
      const cidadeLimpa = pix_cidade !== undefined ? String(pix_cidade).trim() : (currentSettings.pix_cidade || "");

      if (modalidadeFinal === "manual") {
        if (!beneficiarioLimpo) {
          return res.status(400).json({ error: "O nome do favorecido/beneficiário é obrigatório no modo manual." });
        }
        if (!cidadeLimpa) {
          return res.status(400).json({ error: "A cidade da conta é obrigatória para conformidade BACEN EMV no modo manual." });
        }
      }

      try {
        const chaveParaSalvar = validacaoChave.chaveNormalizada || (settingsStore.normalizarChavePix ? settingsStore.normalizarChavePix(chaveInformada, tipoChave) : chaveInformada);
        const result = await settingsStore.updatePixSettings({
          usuario: adminUser,
          modalidade_pix: modalidadeFinal,
          pix_mode: modalidadeFinal,
          pix_chave: chaveParaSalvar || currentSettings.pix_chave || "83996431326",
          pix_tipo_chave: tipoChave,
          pix_beneficiario: beneficiarioLimpo || currentSettings.pix_beneficiario || "EJC TRANSITO MONTE SIAO",
          pix_documento: pix_documento !== undefined ? pix_documento : currentSettings.pix_documento,
          pix_cidade: cidadeLimpa || currentSettings.pix_cidade || "CAMPINA GRANDE",
          pix_instrucoes_manual: pix_instrucoes_manual !== undefined ? pix_instrucoes_manual : currentSettings.pix_instrucoes_manual,
          pix_permite_comprovante: pix_permite_comprovante !== undefined ? pix_permite_comprovante : currentSettings.pix_permite_comprovante,
          motivo: motivo,
          ip: String(clientIp)
        });

        return res.status(200).json({
          success: true,
          persisted: true,
          message: result.message,
          nova_chave_mascarada: mascararChave(result.settings.pix_chave, tipoChave),
          versao: result.settings.versao,
          modalidade_pix: result.settings.modalidade_pix,
          pix_mode: result.settings.pix_mode,
          settings: result.settings
        });
      } catch (err) {
        console.error("[Update Pix Error]", err);
        return res.status(500).json({
          success: false,
          error: err.message || "Falha ao persistir novos dados PIX no servidor."
        });
      }
    }

    // Ação C: Sincronização Integral Anti-Downgrade
    if (action === "sync_full_settings") {
      try {
        const fullSettings = req.body.settings || {};
        const result = await settingsStore.syncFullSettings({
          settings: fullSettings,
          usuario: adminUser,
          motivo: motivo || "Re-hidratação integral anti-downgrade",
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

    // Ação D: Aprovação Manual de Pagamento
    if (action === "approve_payment") {
      try {
        const result = await settingsStore.approvePayment({
          identificador: identificador,
          usuario: adminUser,
          ip: String(clientIp),
          email: req.body?.email,
          nome: req.body?.nome,
          valor: req.body?.valor,
          sub: req.body?.sub
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

    // Ação E: Rejeição Manual de Pagamento / Comprovante
    if (action === "reject_payment") {
      try {
        const result = await settingsStore.rejectPayment({
          identificador: identificador,
          usuario: adminUser,
          motivo: motivo,
          ip: String(clientIp),
          email: req.body?.email,
          nome: req.body?.nome
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
