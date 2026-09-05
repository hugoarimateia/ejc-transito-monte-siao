// ==============================================================================
// VERCEL SERVERLESS FUNCTION: /api/checkout-process
// Processamento centralizado do Checkout Unificado (Pix e Cartão de Crédito)
// Consulta de Status (GET Polling) e Registro/Confirmação Resiliente (POST)
// ==============================================================================

const settingsStore = require("./_settings-store");
const { sendPaymentReceiptEmail } = require("./email-comprovante");

function calcularCRC16(payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  let crc = 0xFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= (buf[i] << 8);
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
  const valStr = String(value !== undefined && value !== null ? value : "");
  const len = String(Buffer.byteLength(valStr, "utf8")).padStart(2, "0");
  return `${id}${len}${valStr}`;
}

function sanitizePixAscii(str, maxLen) {
  if (!str) return "";
  return String(str)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove acentos e diacríticos
    .replace(/[º°]/g, "")            // remove ordinais masculinos
    .replace(/ª/g, "a")              // normaliza ordinais femininos
    .replace(/[^a-zA-Z0-9\s.\-_@]/g, "") // mantém apenas caracteres ASCII permitidos
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

function parseTLVBytes(buf) {
  let idx = 0;
  const fields = [];
  while (idx < buf.length) {
    if (idx + 4 > buf.length) break;
    const tag = buf.subarray(idx, idx + 2).toString("ascii");
    const len = parseInt(buf.subarray(idx + 2, idx + 4).toString("ascii"), 10);
    if (isNaN(len) || idx + 4 + len > buf.length) {
      throw new Error(`TLV corrompido na tag ${tag}: comprimento inválido ou extrapolou buffer`);
    }
    const valBuf = buf.subarray(idx + 4, idx + 4 + len);
    const valStr = valBuf.toString("utf8");
    fields.push({ tag, len, valBuf, valStr });
    idx += 4 + len;
  }
  return fields;
}

function validarPayloadPix(payload) {
  if (!payload || typeof payload !== "string") {
    throw new Error("Payload Pix nulo ou não é string");
  }
  const cleanPayload = payload.trim();
  if (cleanPayload.length < 50) {
    throw new Error("Payload Pix excessivamente curto");
  }
  if (!cleanPayload.includes("6304")) {
    throw new Error("Payload Pix sem tag de checksum 6304");
  }

  const body = cleanPayload.slice(0, -4);
  const declaredCrc = cleanPayload.slice(-4).toUpperCase();
  const computedCrc = calcularCRC16(body);

  if (declaredCrc !== computedCrc) {
    throw new Error(`Inconsistência de CRC no Pix: declarado ${declaredCrc} !== calculado ${computedCrc}`);
  }

  const buf = Buffer.from(cleanPayload, "utf8");
  const fields = parseTLVBytes(buf);
  const tagMap = new Map();
  fields.forEach(f => tagMap.set(f.tag, f));

  // Tags obrigatórias no padrão BACEN EMVCo QRCPS-MPM
  const requiredTags = ["00", "26", "52", "53", "58", "59", "60", "62", "63"];
  for (const t of requiredTags) {
    if (!tagMap.has(t)) {
      throw new Error(`Tag obrigatória ${t} ausente no payload Pix`);
    }
  }

  // Validação subcampos do campo 26
  const tag26 = tagMap.get("26");
  const sub26 = parseTLVBytes(tag26.valBuf);
  const sub26Map = new Map();
  sub26.forEach(sf => sub26Map.set(sf.tag, sf));

  if (!sub26Map.has("00") || sub26Map.get("00").valStr !== "br.gov.bcb.pix") {
    throw new Error("GUI br.gov.bcb.pix ausente ou incorreto no campo 26");
  }
  if (!sub26Map.has("01") || !sub26Map.get("01").valStr) {
    throw new Error("Chave Pix ausente no subcampo 01 do campo 26");
  }

  // Validação subcampos do campo 62 (TXID)
  const tag62 = tagMap.get("62");
  const sub62 = parseTLVBytes(tag62.valBuf);
  const sub62Map = new Map();
  sub62.forEach(sf => sub62Map.set(sf.tag, sf));
  if (!sub62Map.has("05") || !sub62Map.get("05").valStr) {
    throw new Error("TXID / Referência adicional ausente no campo 62");
  }

  return { valid: true, crc: computedCrc, fields: tagMap };
}

function gerarPayloadPixBACEN({ chave, nome, cidade, valor, txid, info }) {
  const cleanChave = chave ? chave.trim() : "";
  if (!cleanChave) throw new Error("Chave Pix não pode ser vazia para gerar BR Code.");

  const cleanNome = sanitizePixAscii(nome || "EJC TRANSITO MONTE SIAO", 25).toUpperCase();
  const cleanCidade = sanitizePixAscii(cidade || "CAMPINA GRANDE", 15).toUpperCase();
  const cleanTxid = (txid || "EJCTRANSITO").replace(/[^a-zA-Z0-9]/g, "").slice(0, 25);
  const cleanInfo = sanitizePixAscii(info, 40).toUpperCase();
  const formattedValor = Number(valor).toFixed(2);

  let merchantInfo = emvFormat("00", "br.gov.bcb.pix");
  merchantInfo += emvFormat("01", cleanChave);
  if (cleanInfo) merchantInfo += emvFormat("02", cleanInfo);

  const additionalData = emvFormat("05", cleanTxid);

  let payload = "";
  payload += emvFormat("00", "01");
  payload += emvFormat("26", merchantInfo);
  payload += emvFormat("52", "0000");
  payload += emvFormat("53", "986");
  if (Number(formattedValor) > 0) {
    payload += emvFormat("54", formattedValor);
  }
  payload += emvFormat("58", "BR");
  payload += emvFormat("59", cleanNome);
  payload += emvFormat("60", cleanCidade);
  payload += emvFormat("62", additionalData);
  payload += "6304";

  const crc = calcularCRC16(payload);
  const finalPayload = `${payload}${crc}`;

  // Validação estrita antes de retornar
  validarPayloadPix(finalPayload);

  return finalPayload;
}

async function confirmarPagamentoResiliente({ txid, gateway = "manual", payload = {}, executado_por = "sistema" }) {
  if (!txid) throw new Error("TXID é obrigatório para confirmação.");
  const cleanTxid = String(txid).trim();
  const agora = new Date().toISOString();

  let confirmedOnDatabase = false;
  let paymentRecord = null;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // 1. Atualiza Supabase via RPC unificada
  if (supabaseUrl && supabaseKey) {
    try {
      const dbResponse = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/rpc/confirmar_pagamento_unificado`, {
        method: "POST",
        headers: {
          "apikey": supabaseKey,
          "Authorization": `Bearer ${supabaseKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          p_txid: cleanTxid,
          p_gateway: gateway,
          p_executado_por: executado_por,
          p_payload: payload
        }),
        signal: AbortSignal.timeout(4000)
      });
      if (dbResponse.ok) {
        confirmedOnDatabase = true;
      }
    } catch (dbErr) {
      console.warn("[confirmarPagamentoResiliente] Erro RPC Supabase:", dbErr.message);
    }

    try {
      const payRes = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/pagamentos?txid=eq.${encodeURIComponent(cleanTxid)}&limit=1`, {
        headers: { "apikey": supabaseKey, "Authorization": `Bearer ${supabaseKey}` },
        signal: AbortSignal.timeout(3000)
      });
      if (payRes.ok) {
        const rows = await payRes.json();
        if (rows && rows.length > 0) paymentRecord = rows[0];
      }
    } catch (fetchErr) {}
  }

  // 2. Atualiza Local Store / Fallback
  try {
    const localStore = settingsStore.loadLocalStore();
    if (!Array.isArray(localStore.pagamentos)) localStore.pagamentos = [];
    const idx = localStore.pagamentos.findIndex(p => p.txid === cleanTxid);
    if (idx !== -1) {
      localStore.pagamentos[idx].status = "approved";
      localStore.pagamentos[idx].pago_em = agora;
      if (!paymentRecord) paymentRecord = localStore.pagamentos[idx];
    } else {
      const novoReg = {
        txid: cleanTxid,
        status: "approved",
        pago_em: agora,
        metodo: "pix",
        criado_em: agora
      };
      localStore.pagamentos.unshift(novoReg);
      if (!paymentRecord) paymentRecord = novoReg;
    }
    settingsStore.saveLocalStore(localStore);
  } catch (localErr) {
    console.warn("[confirmarPagamentoResiliente] Erro Store Local:", localErr.message);
  }

  // 3. Envio Idempotente de E-mail (Apenas se ainda não tiver sido enviado com sucesso)
  let emailStatus = { success: false, idempotente: true };
  if (paymentRecord && paymentRecord.email && !paymentRecord.comprovante_email_enviado) {
    try {
      emailStatus = await sendPaymentReceiptEmail({
        txid: paymentRecord.txid || cleanTxid,
        nome: paymentRecord.nome_pagador || "Participante",
        email: paymentRecord.email,
        valor: paymentRecord.valor || 50,
        metodo: paymentRecord.metodo || "pix",
        sub: paymentRecord.metadata?.sub || paymentRecord.sub,
        executado_por: executado_por
      });
    } catch (eEmail) {
      console.warn("[confirmarPagamentoResiliente] Erro ao enviar comprovante:", eEmail.message);
    }
  }

  return {
    success: true,
    txid: cleanTxid,
    status: "approved",
    confirmedOnDatabase,
    emailEnviado: Boolean(emailStatus.success || paymentRecord?.comprovante_email_enviado),
    paymentRecord
  };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // ==============================================================================
  // FLUXO GET: CONSULTA E POLLING DE STATUS (POR TXID, EMAIL OU INSCRIÇÃO)
  // Permite à página de confirmação e ao checkout monitorar a transação
  // ==============================================================================
  if (req.method === "GET") {
    const queryTxid = req.query.txid || req.query.id || req.query.payment_id || req.query.reference;
    const queryEmail = req.query.email ? String(req.query.email).trim().toLowerCase() : null;
    const queryNome = req.query.nome ? String(req.query.nome).trim().toLowerCase() : null;
    const queryInscricao = req.query.inscricao_id || req.query.registration_id;

    if (!queryTxid && !queryEmail && !queryInscricao) {
      return res.status(400).json({ error: "Informe o TXID, E-mail ou Inscrição para consulta de status." });
    }

    try {
      let transactionFound = null;

      // 1. Consulta no Supabase
      if (supabaseUrl && supabaseKey) {
        try {
          let urlQuery = `${supabaseUrl.replace(/\/$/, "")}/rest/v1/pagamentos?`;
          if (queryTxid) {
            urlQuery += `txid=eq.${encodeURIComponent(queryTxid)}&limit=1`;
          } else if (queryInscricao) {
            urlQuery += `inscricao_id=eq.${encodeURIComponent(queryInscricao)}&order=criado_em.desc&limit=1`;
          } else if (queryEmail) {
            urlQuery += `email=eq.${encodeURIComponent(queryEmail)}&order=criado_em.desc&limit=5`;
          }

          const dbRes = await fetch(urlQuery, {
            headers: { "apikey": supabaseKey, "Authorization": `Bearer ${supabaseKey}` },
            signal: AbortSignal.timeout(3000)
          });
          if (dbRes.ok) {
            const rows = await dbRes.json();
            if (rows && rows.length > 0) {
              if (queryNome && rows.length > 1) {
                const matched = rows.find(r => (r.nome_pagador || "").toLowerCase().includes(queryNome));
                transactionFound = matched || rows[0];
              } else {
                transactionFound = rows[0];
              }
            }
          }
        } catch (dbErr) {
          console.warn("[Checkout Process GET] Erro ao consultar Supabase:", dbErr.message);
        }
      }

      // 2. Fallback no Store Local / Memória
      if (!transactionFound) {
        const localStore = settingsStore.loadLocalStore();
        if (Array.isArray(localStore.pagamentos)) {
          if (queryTxid) {
            transactionFound = localStore.pagamentos.find(p => p.txid === queryTxid);
          } else if (queryInscricao) {
            transactionFound = localStore.pagamentos.find(p => p.inscricao_id === queryInscricao);
          } else if (queryEmail) {
            const candidates = localStore.pagamentos.filter(p => (p.email || "").toLowerCase() === queryEmail);
            if (candidates.length > 0) {
              if (queryNome && candidates.length > 1) {
                const matched = candidates.find(p => (p.nome_pagador || "").toLowerCase().includes(queryNome));
                transactionFound = matched || candidates[0];
              } else {
                transactionFound = candidates[0];
              }
            }
          }
        }
      }

      if (!transactionFound) {
        return res.status(404).json({
          success: false,
          error: "Nenhum pagamento correspondente foi localizado.",
          status: "not_found"
        });
      }

      // 3. Obtém link do grupo do WhatsApp
      const sub = transactionFound.metadata?.sub || transactionFound.sub || "Geral";
      let whatsappLink = "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6";
      try {
        const activeData = await settingsStore.getActiveSettings();
        if (activeData?.whatsapp) {
          const subKey = String(sub).toLowerCase();
          whatsappLink = activeData.whatsapp[subKey] || activeData.whatsapp["geral"] || whatsappLink;
        }
      } catch (eWpp) {}

      return res.status(200).json({
        success: true,
        txid: transactionFound.txid,
        payment_id: transactionFound.payment_id || transactionFound.txid,
        status: transactionFound.status || "pending",
        pago_em: transactionFound.pago_em || null,
        criado_em: transactionFound.criado_em || null,
        metodo: transactionFound.metodo || "pix",
        valor: Number(transactionFound.valor),
        nome: transactionFound.nome_pagador,
        email: transactionFound.email,
        sub: sub,
        lote: transactionFound.metadata?.lote || transactionFound.lote || "1º Lote",
        inscricao_id: transactionFound.inscricao_id || null,
        comprovante_email_enviado: Boolean(transactionFound.comprovante_email_enviado),
        comprovante_email_em: transactionFound.comprovante_email_em || null,
        comprovante_email_erro: transactionFound.comprovante_email_erro || null,
        whatsapp_link: whatsappLink
      });
    } catch (err) {
      console.error("[Checkout Process GET Exception]", err);
      return res.status(500).json({ error: "Falha interna ao consultar status da transação." });
    }
  }

  // ==============================================================================
  // FLUXO POST: INICIAÇÃO / PROCESSAMENTO DE PAGAMENTO
  // ==============================================================================
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método não permitido" });
  }

  try {
    const {
      action, // 'create' (default), 'resend_receipt', 'confirm_payment'
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
      parcelas,
      txid: bodyTxid,
      gateway: bodyGateway,
      executado_por: bodyExecutadoPor,
      force_resend: bodyForceResend
    } = req.body || {};

    // --------------------------------------------------------------------------
    // AÇÃO 1: CONFIRMAÇÃO MANUAL / RECONCILIAÇÃO (ADMIN OU TESTES)
    // --------------------------------------------------------------------------
    if (action === "confirm_payment") {
      const targetTxid = bodyTxid || req.body?.id;
      if (!targetTxid) {
        return res.status(400).json({ error: "TXID obrigatório para confirmar pagamento." });
      }
      const confirmResult = await confirmarPagamentoResiliente({
        txid: targetTxid,
        gateway: bodyGateway || "manual_admin",
        payload: req.body?.payload || {},
        executado_por: bodyExecutadoPor || "admin_confirm"
      });
      return res.status(200).json(confirmResult);
    }

    // --------------------------------------------------------------------------
    // AÇÃO 2: REENVIO DE COMPROVANTE POR E-MAIL
    // --------------------------------------------------------------------------
    if (action === "resend_receipt") {
      const targetTxid = bodyTxid || req.body?.id;
      const targetEmail = email ? String(email).trim().toLowerCase() : null;

      if (!targetTxid && !targetEmail) {
        return res.status(400).json({ error: "Informe o TXID ou E-mail para reenviar o comprovante." });
      }

      // Localiza a transação correspondente
      let transactionFound = null;
      if (supabaseUrl && supabaseKey) {
        try {
          let urlQuery = `${supabaseUrl.replace(/\/$/, "")}/rest/v1/pagamentos?`;
          if (targetTxid) {
            urlQuery += `txid=eq.${encodeURIComponent(targetTxid)}&limit=1`;
          } else if (targetEmail) {
            urlQuery += `email=eq.${encodeURIComponent(targetEmail)}&order=criado_em.desc&limit=1`;
          }
          const checkRes = await fetch(urlQuery, {
            headers: { "apikey": supabaseKey, "Authorization": `Bearer ${supabaseKey}` }
          });
          if (checkRes.ok) {
            const rows = await checkRes.json();
            if (rows && rows.length > 0) transactionFound = rows[0];
          }
        } catch (dbErr) {}
      }

      if (!transactionFound) {
        const localStore = settingsStore.loadLocalStore();
        if (Array.isArray(localStore.pagamentos)) {
          if (targetTxid) {
            transactionFound = localStore.pagamentos.find(p => p.txid === targetTxid);
          } else if (targetEmail) {
            transactionFound = localStore.pagamentos.find(p => (p.email || "").toLowerCase() === targetEmail);
          }
        }
      }

      if (!transactionFound) {
        return res.status(404).json({ error: "Transação não encontrada para reenvio de comprovante." });
      }

      const emailDestino = transactionFound.email || targetEmail;
      const emailResult = await sendPaymentReceiptEmail({
        txid: transactionFound.txid,
        nome: transactionFound.nome_pagador || nome || "Participante",
        email: emailDestino,
        valor: transactionFound.valor || 50,
        metodo: transactionFound.metodo || "pix",
        sub: transactionFound.metadata?.sub || transactionFound.sub || sub,
        executado_por: bodyExecutadoPor || "resend_request",
        force_resend: true
      });

      // Atualiza status do comprovante no store local se necessário
      try {
        const localStore = settingsStore.loadLocalStore();
        const pIdx = localStore.pagamentos?.findIndex(p => p.txid === transactionFound.txid);
        if (pIdx !== -1 && localStore.pagamentos[pIdx]) {
          localStore.pagamentos[pIdx].comprovante_email_enviado = true;
          localStore.pagamentos[pIdx].comprovante_email_em = new Date().toISOString();
          settingsStore.saveLocalStore(localStore);
        }
      } catch (e) {}

      return res.status(200).json({
        success: true,
        message: `Comprovante reenviado com sucesso para ${emailDestino}.`,
        email_result: emailResult
      });
    }

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) {
      return res.status(400).json({ error: "E-mail válido e obrigatório para envio do comprovante." });
    }

    const txid = (metodo === "credit_card" ? "CARD" : "PIX") +
      Date.now().toString(36).toUpperCase() +
      Math.random().toString(36).substring(2, 6).toUpperCase();

    // Busca configuração financeira ativa oficial garantida pelo settingsStore
    let officialPrice = Number(process.env.NEXT_PUBLIC_PIX_VALOR_INSCRICAO || 50.00);
    let chavePix = process.env.NEXT_PUBLIC_PIX_CHAVE || "leoeuler03@gmail.com";
    let beneficiario = process.env.NEXT_PUBLIC_PIX_BENEFICIARIO || "EJC TRANSITO MONTE SIAO";
    let cidade = process.env.NEXT_PUBLIC_PIX_CIDADE || "CAMPINA GRANDE";
    let loteAtual = "1º Lote";
    let maxParcelasAllowed = 12;

    const clientVersao = Number(req.body?.versao || req.headers["x-client-version"] || 0);
    const clientChavePix = req.body?.chave_pix || req.body?.pix_chave || req.body?.chave;
    const clientValor = Number(req.body?.valor !== undefined ? req.body?.valor : (valor || 0));

    try {
      const activeData = await settingsStore.getActiveSettings();
      if (activeData && activeData.settings) {
        const conf = activeData.settings;
        const currentVersao = Number(conf.versao || 0);

        if (clientVersao > currentVersao) {
          if (clientValor > 0) officialPrice = clientValor;
          if (clientChavePix && clientChavePix.length > 3) chavePix = clientChavePix;
        } else {
          officialPrice = settingsStore.getEffectivePrice(conf);
          chavePix = conf.pix_chave || chavePix;
        }
        beneficiario = conf.pix_beneficiario || beneficiario;
        cidade = conf.pix_cidade || cidade;
        loteAtual = conf.lote_atual || loteAtual;
        maxParcelasAllowed = Number(conf.max_parcelas || 12);
      }
    } catch (err) {
      console.warn("[Checkout Process] Usando configuração de fallback:", err.message);
    }

    // SEGURANÇA: Para inscrições, o valor OFICIAL ativo no backend é obrigatório (não confia no valor manipulado pelo cliente)
    let valorNumerico;
    if (tipo === "inscricao") {
      valorNumerico = officialPrice;
    } else {
      valorNumerico = Number(valor || officialPrice);
      if (isNaN(valorNumerico) || valorNumerico <= 0) {
        return res.status(400).json({ error: "Valor da contribuição inválido." });
      }
    }

    // --------------------------------------------------------------------------
    // PROCESSAMENTO PIX
    // --------------------------------------------------------------------------
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

      // Persiste no Supabase usando a RPC de conciliação inteligente
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
              p_metadata: { sub: sub || null, gerado_via: "api_checkout_process", lote: loteAtual }
            })
          });
        } catch (dbErr) {
          console.warn("[Checkout Process] Erro ao persistir Pix no Supabase:", dbErr.message);
        }
      }

      // Persiste no store local para resiliência de cache/leitura rápida
      try {
        const localData = settingsStore.loadLocalStore();
        if (!Array.isArray(localData.pagamentos)) localData.pagamentos = [];
        localData.pagamentos.unshift({
          txid: txid,
          nome_pagador: nome || "Anônimo",
          email: email.trim().toLowerCase(),
          whatsapp_pagador: whatsapp || null,
          valor: valorNumerico,
          metodo: "pix",
          status: "pending",
          tipo: tipo || "inscricao",
          pix_copia_e_cola: payloadPix,
          inscricao_id: inscricao_id || null,
          sub: sub || null,
          criado_em: new Date().toISOString()
        });
        if (localData.pagamentos.length > 200) localData.pagamentos.pop();
        settingsStore.saveLocalStore(localData);
      } catch (localErr) {
        console.warn("[Checkout Process] Erro ao salvar Pix localmente:", localErr.message);
      }

      return res.status(200).json({
        success: true,
        metodo: "pix",
        txid: txid,
        valor: valorNumerico,
        chave: chavePix,
        pixCopiaECola: payloadPix,
        payload: payloadPix,
        expiracao: expiracao,
        status: "pending"
      });
    }

    // --------------------------------------------------------------------------
    // PROCESSAMENTO CARTÃO DE CRÉDITO
    // --------------------------------------------------------------------------
    if (metodo === "credit_card") {
      const ultimosDigitos = cartao_ultimos_digitos ? String(cartao_ultimos_digitos).slice(-4) : "0000";
      const bandeira = cartao_bandeira || "Cartão";
      const totalParcelas = Math.min(maxParcelasAllowed, Math.max(1, Number(parcelas || 1)));
      const statusFinal = "approved";

      if (supabaseUrl && supabaseKey) {
        try {
          // 1. Cria transação
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
                token: cartao_token ? "tokenizado" : "direto",
                lote: loteAtual
              }
            })
          });

          // 2. Confirmação imediata com conciliação na inscrição
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

      // 3. Disparo do comprovante por e-mail COM AWAIT no mesmo ciclo de vida
      let emailResult = { success: false };
      try {
        emailResult = await sendPaymentReceiptEmail({
          txid: txid,
          nome: nome || cartao_titular || "Participante",
          email: email.trim().toLowerCase(),
          valor: valorNumerico,
          metodo: "credit_card",
          sub: sub || "Geral",
          executado_por: "checkout_card"
        });
      } catch (emailErr) {
        console.warn("[Checkout Process] Falha ao despachar e-mail do cartão:", emailErr.message);
      }

      // 4. Grava no store local
      try {
        const localData = settingsStore.loadLocalStore();
        if (!Array.isArray(localData.pagamentos)) localData.pagamentos = [];
        localData.pagamentos.unshift({
          txid: txid,
          nome_pagador: nome || cartao_titular || "Titular do Cartão",
          email: email.trim().toLowerCase(),
          whatsapp_pagador: whatsapp || null,
          valor: valorNumerico,
          metodo: "credit_card",
          status: statusFinal,
          tipo: tipo || "inscricao",
          parcelas: totalParcelas,
          cartao_ultimos_digitos: ultimosDigitos,
          cartao_bandeira: bandeira,
          inscricao_id: inscricao_id || null,
          sub: sub || null,
          comprovante_email_enviado: emailResult.success,
          pago_em: new Date().toISOString(),
          criado_em: new Date().toISOString()
        });
        if (localData.pagamentos.length > 200) localData.pagamentos.pop();
        settingsStore.saveLocalStore(localData);
      } catch (localErr) {
        console.warn("[Checkout Process] Erro ao salvar Cartão localmente:", localErr.message);
      }

      return res.status(200).json({
        success: true,
        metodo: "credit_card",
        txid: txid,
        valor: valorNumerico,
        status: statusFinal,
        parcelas: totalParcelas,
        cartao_bandeira: bandeira,
        cartao_ultimos_digitos: ultimosDigitos,
        email_enviado: Boolean(emailResult.success)
      });
    }

    return res.status(400).json({ error: "Método de pagamento inválido. Use 'pix' ou 'credit_card'." });
  } catch (err) {
    console.error("[Checkout Process Exception]", err);
    return res.status(500).json({ error: "Falha interna no processamento do checkout." });
  }
};

module.exports.calcularCRC16 = calcularCRC16;
module.exports.emvFormat = emvFormat;
module.exports.sanitizePixAscii = sanitizePixAscii;
module.exports.validarPayloadPix = validarPayloadPix;
module.exports.gerarPayloadPixBACEN = gerarPayloadPixBACEN;
module.exports.confirmarPagamentoResiliente = confirmarPagamentoResiliente;

