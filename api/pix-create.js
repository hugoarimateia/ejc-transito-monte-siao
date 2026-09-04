// ==============================================================================
// VERCEL SERVERLESS FUNCTION: /api/pix-create
// Geração server-side segura de cobrança Pix Dinâmica no padrão Banco Central
// Sincronizado diretamente com _settings-store.js
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
    let activeSettings = settingsStore.getDefaultSettings();
    try {
      const activeData = await settingsStore.getActiveSettings();
      if (activeData && activeData.settings) {
        activeSettings = activeData.settings;
      }
    } catch (e) {
      console.warn("[pix-create] Fallback para default settings:", e.message);
    }

    const { valor, nome_pagador, whatsapp_pagador, tipo, inscricao_id } = req.body || {};

    let valorNumerico;
    if (tipo === "inscricao") {
      valorNumerico = Number(activeSettings.valor_inscricao || 50);
    } else {
      valorNumerico = Number(valor || 50);
      if (isNaN(valorNumerico) || valorNumerico <= 0) {
        return res.status(400).json({ error: "Valor da cobrança inválido" });
      }
    }

    const chavePix = activeSettings.pix_chave || process.env.NEXT_PUBLIC_PIX_CHAVE || "leoeuler03@gmail.com";
    const beneficiario = activeSettings.pix_beneficiario || process.env.NEXT_PUBLIC_PIX_BENEFICIARIO || "EJC TRANSITO MONTE SIAO";
    const cidade = activeSettings.pix_cidade || process.env.NEXT_PUBLIC_PIX_CIDADE || "CAMPINA GRANDE";
    const tempoExpiracao = Number(process.env.NEXT_PUBLIC_PIX_EXPIRACAO_MINUTOS || 15);
    const loteAtual = activeSettings.lote_atual || "1º Lote";

    const txid = "EJC" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
    const expiracao = new Date(Date.now() + tempoExpiracao * 60000).toISOString();

    const payloadPix = gerarPayloadPixBACEN({
      chave: chavePix,
      nome: beneficiario,
      cidade: cidade,
      valor: valorNumerico,
      txid: txid,
      info: tipo === "inscricao" ? `TAXA EJC TRANSITO ${loteAtual}`.toUpperCase() : "CONTRIBUICAO EJC TRANSITO"
    });

    // Registra no Supabase via REST API se credenciais de servidor estiverem configuradas
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (supabaseUrl && supabaseKey) {
      try {
        await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/rpc/registrar_pagamento_pix`, {
          method: "POST",
          headers: {
            "apikey": supabaseKey,
            "Authorization": `Bearer ${supabaseKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            p_txid: txid,
            p_nome_pagador: nome_pagador || "Anônimo",
            p_whatsapp_pagador: whatsapp_pagador || null,
            p_cpf_pagador: null,
            p_valor: valorNumerico,
            p_tipo: tipo || "contribuicao",
            p_pix_copia_e_cola: payloadPix,
            p_qr_code_base64: null,
            p_expiracao: expiracao,
            p_inscricao_id: inscricao_id || null
          })
        });
      } catch (dbErr) {
        console.warn("[Serverless] Não foi possível persistir no banco remoto:", dbErr.message);
      }
    }

    return res.status(200).json({
      success: true,
      txid: txid,
      valor: valorNumerico,
      pixCopiaECola: payloadPix,
      expiracao: expiracao
    });
  } catch (err) {
    console.error("[Serverless Error]", err);
    return res.status(500).json({ error: "Falha interna ao gerar Pix" });
  }
};
