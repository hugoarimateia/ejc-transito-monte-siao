// ==============================================================================
// VERCEL SERVERLESS FUNCTION: /api/payment-settings
// Gestão administrativa centralizada de configurações financeiras, preços e PIX
// ==============================================================================

const VALID_KEY_TYPES = ["EMAIL", "CPF", "CNPJ", "TELEFONE", "ALEATORIA"];

function validarFormatoChavePix(chave, tipo) {
  const c = String(chave || "").trim();
  if (!c) return { valido: false, erro: "A chave PIX não pode ser vazia." };

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
      if (phoneDigits.length < 10 || phoneDigits.length > 13) {
        return { valido: false, erro: "Telefone deve conter entre 10 e 13 dígitos numéricos (com DDD)." };
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
  return { valido: true };
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
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");

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

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // 1. CONSULTA DE CONFIGURAÇÕES (GET)
  if (req.method === "GET") {
    let settings = {
      lote_atual: "1º Lote",
      valor_inscricao: Number(process.env.NEXT_PUBLIC_PIX_VALOR_INSCRICAO || 50.00),
      valor_promocional: null,
      taxa_adicional: 0.0,
      max_parcelas: 12,
      pix_chave: process.env.NEXT_PUBLIC_PIX_CHAVE || "leoeuler03@gmail.com",
      pix_tipo_chave: process.env.NEXT_PUBLIC_PIX_TIPO_CHAVE || "EMAIL",
      pix_beneficiario: process.env.NEXT_PUBLIC_PIX_BENEFICIARIO || "EJC TRANSITO MONTE SIAO",
      pix_documento: "",
      pix_cidade: process.env.NEXT_PUBLIC_PIX_CIDADE || "CAMPINA GRANDE",
      atualizado_em: new Date().toISOString(),
      atualizado_por: "sistema"
    };

    let historico = [];
    let lotes = [{ nome: "1º Lote", valor: settings.valor_inscricao, ativo: true }];

    if (supabaseUrl && supabaseKey) {
      try {
        // Busca configuração ativa
        const configRes = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/configuracoes_financeiras?ativo=eq.true&order=versao.desc&limit=1`, {
          headers: { "apikey": supabaseKey, "Authorization": `Bearer ${supabaseKey}` }
        });
        if (configRes.ok) {
          const configData = await configRes.json();
          if (configData && configData.length > 0) {
            settings = configData[0];
          }
        }

        // Busca lotes
        const lotesRes = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/lotes_inscricao?order=criado_em.asc`, {
          headers: { "apikey": supabaseKey, "Authorization": `Bearer ${supabaseKey}` }
        });
        if (lotesRes.ok) {
          const lotesData = await lotesRes.json();
          if (lotesData && lotesData.length > 0) lotes = lotesData;
        }

        // Busca histórico de auditoria
        const histRes = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/historico_configuracoes_financeiras?order=criado_em.desc&limit=50`, {
          headers: { "apikey": supabaseKey, "Authorization": `Bearer ${supabaseKey}` }
        });
        if (histRes.ok) {
          const histData = await histRes.json();
          if (histData) historico = histData;
        }
      } catch (err) {
        console.warn("[Payment Settings GET] Supabase indisponível, retornando fallback:", err.message);
      }
    }

    const canEdit = ["superadmin", "financeiro"].includes(userRole);
    const maskedKey = mascararChave(settings.pix_chave, settings.pix_tipo_chave);

    return res.status(200).json({
      success: true,
      settings: {
        ...settings,
        pix_chave_mascarada: maskedKey,
        // Chave completa só enviada para papéis autorizados
        pix_chave: canEdit ? settings.pix_chave : maskedKey
      },
      lotes: lotes,
      historico: historico,
      permissions: {
        canEdit: canEdit,
        role: userRole,
        allowedActions: canEdit
          ? ["finance.view", "finance.edit", "payment.settings.edit", "pix.settings.edit"]
          : ["finance.view"]
      }
    });
  }

  // 2. ATUALIZAÇÃO DE CONFIGURAÇÕES (POST / PUT)
  if (req.method === "POST" || req.method === "PUT") {
    // Validação estrita de permissões de escrita
    if (!["superadmin", "financeiro"].includes(userRole)) {
      return res.status(403).json({
        error: "Permissão insuficiente. Apenas administradores financeiros ou coordenadores gerais podem editar dados financeiros."
      });
    }

    const {
      action, // 'update_prices' ou 'update_pix'
      usuario,
      motivo,
      // Dados para preços
      lote_atual,
      valor_inscricao,
      valor_promocional,
      taxa_adicional,
      max_parcelas,
      // Dados para PIX
      pix_chave,
      pix_tipo_chave,
      pix_beneficiario,
      pix_documento,
      pix_cidade
    } = req.body || {};

    const clientIp = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "127.0.0.1";
    const adminUser = usuario || userRole || "admin";

    // Ação A: Atualizar Preços
    if (action === "update_prices") {
      const valorNumerico = Number(valor_inscricao);
      if (isNaN(valorNumerico) || valorNumerico <= 0) {
        return res.status(400).json({ error: "O valor da inscrição deve ser um número positivo e maior que zero." });
      }

      const valorFinal = Number(valorNumerico.toFixed(2));
      const promoFinal = valor_promocional ? Number(Number(valor_promocional).toFixed(2)) : null;

      if (supabaseUrl && supabaseKey) {
        try {
          const rpcRes = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/rpc/atualizar_configuracao_financeira`, {
            method: "POST",
            headers: {
              "apikey": supabaseKey,
              "Authorization": `Bearer ${supabaseKey}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              p_usuario: adminUser,
              p_lote_atual: lote_atual || "1º Lote",
              p_valor_inscricao: valorFinal,
              p_valor_promocional: promoFinal,
              p_taxa_adicional: Number(taxa_adicional || 0),
              p_max_parcelas: Number(max_parcelas || 12),
              p_motivo: motivo || "Atualização de preço pelo painel administrativo",
              p_ip: String(clientIp)
            })
          });

          if (!rpcRes.ok) {
            const errText = await rpcRes.text();
            console.error("[RPC Error update_prices]", errText);
            return res.status(500).json({ error: "Falha ao gravar alteração de preço no banco remoto." });
          }

          const rpcData = await rpcRes.json();
          return res.status(200).json({
            success: true,
            message: `Valor da inscrição atualizado para R$ ${valorFinal.toFixed(2).replace('.', ',')} com sucesso.`,
            data: rpcData
          });
        } catch (dbErr) {
          console.error("[DB Error update_prices]", dbErr);
          return res.status(500).json({ error: "Erro interno de comunicação com o banco de dados." });
        }
      }

      return res.status(200).json({
        success: true,
        message: `Valor simulado para R$ ${valorFinal.toFixed(2).replace('.', ',')}.`,
        novo_valor: valorFinal
      });
    }

    // Ação B: Atualizar Dados do Recebedor PIX
    if (action === "update_pix") {
      const tipoChave = String(pix_tipo_chave || "EMAIL").toUpperCase();
      if (!VALID_KEY_TYPES.includes(tipoChave)) {
        return res.status(400).json({ error: `Tipo de chave PIX inválido. Tipos aceitos: ${VALID_KEY_TYPES.join(", ")}.` });
      }

      const validacaoChave = validarFormatoChavePix(pix_chave, tipoChave);
      if (!validacaoChave.valido) {
        return res.status(400).json({ error: validacaoChave.erro });
      }

      const chaveLimpa = String(pix_chave).trim();
      const beneficiarioLimpo = String(pix_beneficiario || "").trim();
      const cidadeLimpa = String(pix_cidade || "").trim();

      if (!beneficiarioLimpo) {
        return res.status(400).json({ error: "O nome do favorecido/beneficiário é obrigatório." });
      }
      if (!cidadeLimpa) {
        return res.status(400).json({ error: "A cidade da conta é obrigatória para conformidade BACEN EMV." });
      }

      if (supabaseUrl && supabaseKey) {
        try {
          const rpcRes = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/rpc/atualizar_configuracao_financeira`, {
            method: "POST",
            headers: {
              "apikey": supabaseKey,
              "Authorization": `Bearer ${supabaseKey}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              p_usuario: adminUser,
              p_lote_atual: lote_atual || null,
              p_valor_inscricao: valor_inscricao ? Number(valor_inscricao) : 50.00,
              p_pix_chave: chaveLimpa,
              p_pix_tipo_chave: tipoChave,
              p_pix_beneficiario: beneficiarioLimpo,
              p_pix_documento: pix_documento || null,
              p_pix_cidade: cidadeLimpa,
              p_motivo: motivo || "Atualização dos dados do recebedor PIX",
              p_ip: String(clientIp)
            })
          });

          if (!rpcRes.ok) {
            const errText = await rpcRes.text();
            console.error("[RPC Error update_pix]", errText);
            return res.status(500).json({ error: "Falha ao gravar alteração de PIX no banco remoto." });
          }

          const rpcData = await rpcRes.json();
          return res.status(200).json({
            success: true,
            message: `Chave PIX atualizada para ${mascararChave(chaveLimpa, tipoChave)} com sucesso.`,
            data: rpcData
          });
        } catch (dbErr) {
          console.error("[DB Error update_pix]", dbErr);
          return res.status(500).json({ error: "Erro interno de comunicação com o banco de dados." });
        }
      }

      return res.status(200).json({
        success: true,
        message: `Chave PIX atualizada localmente para ${mascararChave(chaveLimpa, tipoChave)}.`,
        nova_chave_mascarada: mascararChave(chaveLimpa, tipoChave)
      });
    }

    return res.status(400).json({ error: "Ação não informada ou inválida. Use 'update_prices' ou 'update_pix'." });
  }

  return res.status(405).json({ error: "Método HTTP não permitido." });
};
