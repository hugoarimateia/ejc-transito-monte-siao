// ==============================================================================
// VERCEL SERVERLESS FUNCTION: /api/checkout-process
// Processamento centralizado do Checkout Unificado (Pix e Cartão de Crédito)
// ==============================================================================

const settingsStore = require("./_settings-store");


function calcularCRC16(str) {
  let crc = 0xFFFF;
  for (let i = 0; i < str.length; i++) {
    crc ^= (str.charCodeAt(i) << 8);
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
      } else {
        crc = (crc << 1) & 0xFFFF;
      }
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function emvFormat(id, value) {
  const len = String(value.length).padStart(2, "0");
  return `${id}${len}${value}`;
}

function gerarPayloadPixBACEN({ chave, nome, cidade, valor, txid, info }) {
  const cleanChave = chave.trim();
  const cleanNome = nome.normalize("NFD").replace(/[\u0300-\u036f]/g, "").slice(0, 25).toUpperCase();
  const cleanCidade = cidade.normalize("NFD").replace(/[\u0300-\u036f]/g, "").slice(0, 15).toUpperCase();
  const cleanTxid = (txid || "EJCTRANSITO").replace(/[^a-zA-Z0-9]/g, "").slice(0, 25);
  const formattedValor = Number(valor).toFixed(2);

  let merchantInfo = emvFormat("00", "br.gov.bcb.pix");
  merchantInfo += emvFormat("01", cleanChave);
  if (info) merchantInfo += emvFormat("02", info.slice(0, 40));

  const additionalData = emvFormat("05", cleanTxid);

  let payload = "";
  payload += emvFormat("00", "01");
  payload += emvFormat("26", merchantInfo);
  payload += emvFormat("52", "0000");
  payload += emvFormat("53", "986");
  payload += emvFormat("54", formattedValor);
  payload += emvFormat("58", "BR");
  payload += emvFormat("59", cleanNome);
  payload += emvFormat("60", cleanCidade);
  payload += emvFormat("62", additionalData);
  payload += "6304";

  const crc = calcularCRC16(payload);
  return `${payload}${crc}`;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método não permitido" });
  }

  try {
    const {
      metodo, // 'pix' ou 'credit_card'
      valor,
      nome,
      email,
      whatsapp,
      cpf,
      tipo, // 'inscricao' ou 'contribuicao'
      sub,
      inscricao_id,
      // Dados para cartão (PCI-DSS: nunca registrar número completo ou CVV)
      cartao_token,
      cartao_ultimos_digitos,
      cartao_bandeira,
      cartao_titular,
      parcelas
    } = req.body || {};

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) {
      return res.status(400).json({ error: "E-mail válido e obrigatório para envio do comprovante." });
    }

    const txid = (metodo === "credit_card" ? "CARD" : "PIX") +
      Date.now().toString(36).toUpperCase() +
      Math.random().toString(36).substring(2, 6).toUpperCase();

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    // Busca configuração financeira ativa oficial garantida pelo settingsStore
    let officialPrice = Number(process.env.NEXT_PUBLIC_PIX_VALOR_INSCRICAO || 50.00);
    let chavePix = process.env.NEXT_PUBLIC_PIX_CHAVE || "leoeuler03@gmail.com";
    let beneficiario = process.env.NEXT_PUBLIC_PIX_BENEFICIARIO || "EJC TRANSITO MONTE SIAO";
    let cidade = process.env.NEXT_PUBLIC_PIX_CIDADE || "CAMPINA GRANDE";
    let loteAtual = "1º Lote";
    let maxParcelasAllowed = 12;

    try {
      const activeData = await settingsStore.getActiveSettings();
      if (activeData && activeData.settings) {
        const conf = activeData.settings;
        officialPrice = settingsStore.getEffectivePrice(conf);
        chavePix = conf.pix_chave || chavePix;
        beneficiario = conf.pix_beneficiario || beneficiario;
        cidade = conf.pix_cidade || cidade;
        loteAtual = conf.lote_atual || loteAtual;
        maxParcelasAllowed = Number(conf.max_parcelas || 12);
      }
    } catch (err) {
      console.warn("[Checkout Process] Usando configuração de fallback:", err.message);
    }

    // SEGURANÇA: Para inscrições, o valor OFICIAL ativo no backend é obrigatório (não confia no valor enviado pelo navegador)
    let valorNumerico;
    if (tipo === "inscricao") {
      valorNumerico = officialPrice;
    } else {
      valorNumerico = Number(valor || officialPrice);
      if (isNaN(valorNumerico) || valorNumerico <= 0) {
        return res.status(400).json({ error: "Valor da contribuição inválido." });
      }
    }

    // PROCESSAMENTO PIX
    if (metodo === "pix") {
      const tempoExpiracao = Number(process.env.NEXT_PUBLIC_PIX_EXPIRACAO_MINUTOS || 15);
      const expiracao = new Date(Date.now() + tempoExpiracao * 60000).toISOString();

      const payloadPix = gerarPayloadPixBACEN({
        chave: chavePix,
        nome: beneficiario,
        cidade: cidade,
        valor: valorNumerico,
        txid: txid,
        info: tipo === "inscricao" ? `TAXA EJC TRANSITO ${loteAtual}`.toUpperCase() : "CONTRIBUICAO EJC TRANSITO"
      });

      // Persiste no Supabase
      if (supabaseUrl && supabaseKey) {
        try {
          await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/rpc/criar_transacao_checkout`, {
            method: "POST",
            headers: {
              "apikey": supabaseKey,
              "Authorization": `Bearer ${supabaseKey}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              p_txid: txid,
              p_nome_pagador: nome || "Anônimo",
              p_email: email.trim().toLowerCase(),
              p_whatsapp_pagador: whatsapp || null,
              p_cpf_pagador: cpf || null,
              p_valor: valorNumerico,
              p_metodo: "pix",
              p_parcelas: 1,
              p_cartao_ultimos_digitos: null,
              p_cartao_bandeira: null,
              p_status: "pending",
              p_tipo: tipo || "inscricao",
              p_pix_copia_e_cola: payloadPix,
              p_qr_code_base64: null,
              p_expiracao: expiracao,
              p_inscricao_id: inscricao_id || null,
              p_metadata: { sub: sub || null, gerado_via: "api_checkout_process" }
            })
          });
        } catch (dbErr) {
          console.warn("[Checkout Process] Erro ao persistir Pix no Supabase:", dbErr.message);
        }
      }

      return res.status(200).json({
        success: true,
        metodo: "pix",
        txid: txid,
        valor: valorNumerico,
        pixCopiaECola: payloadPix,
        expiracao: expiracao,
        status: "pending"
      });
    }

    // PROCESSAMENTO CARTÃO DE CRÉDITO
    if (metodo === "credit_card") {
      const ultimosDigitos = cartao_ultimos_digitos ? String(cartao_ultimos_digitos).slice(-4) : "0000";
      const bandeira = cartao_bandeira || "Cartão";
      const totalParcelas = Math.min(maxParcelasAllowed, Math.max(1, Number(parcelas || 1)));

      // Simulação de aprovação segura de gateway
      const statusFinal = "approved";

      if (supabaseUrl && supabaseKey) {
        try {
          await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/rpc/criar_transacao_checkout`, {
            method: "POST",
            headers: {
              "apikey": supabaseKey,
              "Authorization": `Bearer ${supabaseKey}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              p_txid: txid,
              p_nome_pagador: nome || cartao_titular || "Titular do Cartão",
              p_email: email.trim().toLowerCase(),
              p_whatsapp_pagador: whatsapp || null,
              p_cpf_pagador: cpf || null,
              p_valor: valorNumerico,
              p_metodo: "credit_card",
              p_parcelas: totalParcelas,
              p_cartao_ultimos_digitos: ultimosDigitos,
              p_cartao_bandeira: bandeira,
              p_status: statusFinal,
              p_tipo: tipo || "inscricao",
              p_pix_copia_e_cola: null,
              p_qr_code_base64: null,
              p_expiracao: new Date(Date.now() + 86400000).toISOString(),
              p_inscricao_id: inscricao_id || null,
              p_metadata: {
                sub: sub || null,
                titular: cartao_titular || null,
                token: cartao_token ? "tokenizado" : "direto"
              }
            })
          });

          // Confirmação imediata caso aprovado
          await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/rpc/confirmar_pagamento_unificado`, {
            method: "POST",
            headers: {
              "apikey": supabaseKey,
              "Authorization": `Bearer ${supabaseKey}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              p_txid: txid,
              p_gateway: "checkout_transparente_card",
              p_executado_por: "checkout_api",
              p_payload: { parcelas: totalParcelas, bandeira: bandeira, ultimos_digitos: ultimosDigitos }
            })
          });
        } catch (dbErr) {
          console.warn("[Checkout Process] Erro ao persistir Cartão no Supabase:", dbErr.message);
        }
      }

      return res.status(200).json({
        success: true,
        metodo: "credit_card",
        txid: txid,
        valor: valorNumerico,
        status: statusFinal,
        parcelas: totalParcelas,
        cartao_bandeira: bandeira,
        cartao_ultimos_digitos: ultimosDigitos
      });
    }

    return res.status(400).json({ error: "Método de pagamento inválido. Use 'pix' ou 'credit_card'." });
  } catch (err) {
    console.error("[Checkout Process Exception]", err);
    return res.status(500).json({ error: "Falha interna no processamento do checkout." });
  }
};
