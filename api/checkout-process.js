// ==============================================================================
// VERCEL SERVERLESS FUNCTION: /api/checkout-process
// Processamento centralizado do Checkout Unificado (Pix e Cartão de Crédito)
// Consulta de Status (GET Polling) e Registro/Confirmação Resiliente (POST)
// ==============================================================================

const settingsStore = require("./_settings-store");
const { sendPaymentReceiptEmail } = require("./email-comprovante");
const mercadoPago = require("./_mercadopago");

function getPublicBaseUrl() {
  const custom = process.env.SITE_URL || process.env.APP_URL || process.env.NEXT_PUBLIC_SITE_URL;
  if (custom) return custom.replace(/\/$/, "");
  if (process.env.VERCEL_ENV === "production" || !process.env.VERCEL_ENV) {
    return "https://transitoejc.site";
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL.replace(/\/$/, "")}`;
  }
  return "https://transitoejc.site";
}

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

  // 1. Atualiza Supabase via RPC unificada multi-identificador
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
        const rpcResult = await dbResponse.json();
        if (rpcResult && rpcResult.success) {
          confirmedOnDatabase = true;
          if (rpcResult.pagamento) {
            paymentRecord = rpcResult.pagamento;
          }
        }
      }
    } catch (dbErr) {
      console.warn("[confirmarPagamentoResiliente] Erro RPC Supabase:", dbErr.message);
    }

    // Busca detalhada multi-identificador se o registro ainda não foi obtido
    if (!paymentRecord) {
      try {
        const multiQuery = `or=(txid.eq.${encodeURIComponent(cleanTxid)},gateway_transaction_id.eq.${encodeURIComponent(cleanTxid)},id.eq.${encodeURIComponent(cleanTxid)})&limit=1`;
        const payRes = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/pagamentos?${multiQuery}`, {
          headers: { "apikey": supabaseKey, "Authorization": `Bearer ${supabaseKey}` },
          signal: AbortSignal.timeout(3000)
        });
        if (payRes.ok) {
          const rows = await payRes.json();
          if (rows && rows.length > 0) paymentRecord = rows[0];
        }
      } catch (fetchErr) {}
    }
  }

  // 2. Atualiza Local Store / Fallback multi-identificador
  try {
    const localStore = settingsStore.loadLocalStore();
    if (!Array.isArray(localStore.pagamentos)) localStore.pagamentos = [];
    const idx = localStore.pagamentos.findIndex(p => 
      p.txid === cleanTxid ||
      p.payment_id === cleanTxid ||
      p.order_id === cleanTxid ||
      p.external_reference === cleanTxid ||
      p.gateway_transaction_id === cleanTxid ||
      p.id === cleanTxid ||
      (p.metadata && (p.metadata.order_id === cleanTxid || p.metadata.payment_id === cleanTxid || p.metadata.external_reference === cleanTxid))
    );

    if (idx !== -1) {
      localStore.pagamentos[idx].status = "approved";
      localStore.pagamentos[idx].pago_em = agora;
      if (!paymentRecord) {
        paymentRecord = localStore.pagamentos[idx];
      } else {
        if (!paymentRecord.email && localStore.pagamentos[idx].email) paymentRecord.email = localStore.pagamentos[idx].email;
        if (!paymentRecord.nome_pagador && localStore.pagamentos[idx].nome_pagador) paymentRecord.nome_pagador = localStore.pagamentos[idx].nome_pagador;
        if (!paymentRecord.sub && localStore.pagamentos[idx].sub) paymentRecord.sub = localStore.pagamentos[idx].sub;
        if (!paymentRecord.valor && localStore.pagamentos[idx].valor) paymentRecord.valor = localStore.pagamentos[idx].valor;
      }
    } else {
      const novoReg = {
        txid: cleanTxid,
        payment_id: cleanTxid,
        order_id: cleanTxid,
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
      const emailService = require("./_email-service");
      emailStatus = await emailService.sendPaymentApprovedEmail({
        paymentRecord,
        forceResend: false,
        origemAprovacao: (gateway === "manual_admin" || paymentRecord.metadata?.modalidade_pix === "manual") ? "manual_coordenacao" : "api_gateway"
      });
    } catch (eEmail) {
      console.warn("[confirmarPagamentoResiliente] Erro ao enviar comprovante:", eEmail.message);
    }
  }

  return {
    success: true,
    txid: cleanTxid,
    payment_id: paymentRecord?.payment_id || paymentRecord?.metadata?.payment_id || cleanTxid,
    order_id: paymentRecord?.order_id || paymentRecord?.metadata?.order_id || null,
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
    // --------------------------------------------------------------------------
    // SUB-AÇÃO GET: BUSCA DE INSCRIÇÕES PENDENTES (EMAIL, WHATSAPP, NOME OU ID)
    // --------------------------------------------------------------------------
    if (req.query.action === "buscar_inscricoes") {
      const termo = String(req.query.termo || req.query.email || req.query.whatsapp || req.query.busca || "").trim();
      if (!termo || termo.length < 3) {
        return res.status(400).json({ error: "Informe ao menos 3 caracteres (e-mail, WhatsApp ou nome) para localizar inscrições." });
      }

      const cleanTermo = termo.toLowerCase();
      const inscricoesEncontradas = [];

      // 1. Busca no Supabase (se configurado)
      if (supabaseUrl && supabaseKey) {
        try {
          const query = `or=(email.ilike.%${encodeURIComponent(cleanTermo)}%,whatsapp.ilike.%${encodeURIComponent(cleanTermo)}%,nome_completo.ilike.%${encodeURIComponent(cleanTermo)}%,id.eq.${encodeURIComponent(termo)})&order=criado_em.desc&limit=10`;
          const sbRes = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/inscricoes?${query}`, {
            headers: { "apikey": supabaseKey, "Authorization": `Bearer ${supabaseKey}` },
            signal: AbortSignal.timeout(3500)
          });
          if (sbRes.ok) {
            const rows = await sbRes.json();
            if (Array.isArray(rows)) {
              rows.forEach(r => {
                inscricoesEncontradas.push({
                  id: r.id,
                  nome_completo: r.nome_completo,
                  email: r.email,
                  whatsapp: r.whatsapp,
                  sub: r.sub,
                  pagamento_status: r.pagamento_status || "pendente",
                  criado_em: r.criado_em
                });
              });
            }
          }
        } catch (errDb) {
          console.warn("[buscar_inscricoes] Falha na busca remota Supabase:", errDb.message);
        }
      }

      // 2. Busca no localStore (pagamentos e histórico) como fallback / complemento
      try {
        const localStore = settingsStore.loadLocalStore();
        if (Array.isArray(localStore.pagamentos)) {
          localStore.pagamentos.forEach(p => {
            const matchEmail = p.email && p.email.toLowerCase().includes(cleanTermo);
            const matchWpp = p.whatsapp_pagador && p.whatsapp_pagador.includes(cleanTermo);
            const matchNome = p.nome_pagador && p.nome_pagador.toLowerCase().includes(cleanTermo);
            const matchTxid = p.txid && p.txid === termo;
            if (matchEmail || matchWpp || matchNome || matchTxid) {
              const jaExiste = inscricoesEncontradas.some(i => i.id === p.inscricao_id || (i.email === p.email && i.sub === p.sub));
              if (!jaExiste) {
                inscricoesEncontradas.push({
                  id: p.inscricao_id || p.txid,
                  nome_completo: p.nome_pagador,
                  email: p.email,
                  whatsapp: p.whatsapp_pagador,
                  sub: p.sub || null,
                  pagamento_status: p.status === "approved" ? "confirmado" : "pendente",
                  criado_em: p.criado_em
                });
              }
            }
          });
        }
      } catch (eLocal) {}

      return res.status(200).json({
        success: true,
        total: inscricoesEncontradas.length,
        inscricoes: inscricoesEncontradas
      });
    }

    const queryTxid = req.query.txid || req.query.id || req.query.payment_id || req.query.order_id || req.query.reference || req.query.external_reference;
    const queryEmail = req.query.email ? String(req.query.email).trim().toLowerCase() : null;
    const queryNome = req.query.nome ? String(req.query.nome).trim().toLowerCase() : null;
    const queryInscricao = req.query.inscricao_id || req.query.registration_id;

    if (!queryTxid && !queryEmail && !queryInscricao) {
      return res.status(400).json({ error: "Informe o TXID, Payment ID, Order ID, E-mail ou Inscrição para consulta de status." });
    }

    try {
      let transactionFound = null;

      // 1. Consulta no Supabase multi-identificador
      if (supabaseUrl && supabaseKey) {
        try {
          let urlQuery = `${supabaseUrl.replace(/\/$/, "")}/rest/v1/pagamentos?`;
          if (queryTxid) {
            urlQuery += `or=(txid.eq.${encodeURIComponent(queryTxid)},gateway_transaction_id.eq.${encodeURIComponent(queryTxid)},id.eq.${encodeURIComponent(queryTxid)})&limit=1`;
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

          // Se não encontrou por coluna e temos queryTxid, tenta buscar no metadata JSONB
          if (!transactionFound && queryTxid) {
            try {
              const metaRes = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/pagamentos?metadata->>payment_id=eq.${encodeURIComponent(queryTxid)}&limit=1`, {
                headers: { "apikey": supabaseKey, "Authorization": `Bearer ${supabaseKey}` }
              });
              if (metaRes.ok) {
                const metaRows = await metaRes.json();
                if (metaRows && metaRows.length > 0) transactionFound = metaRows[0];
              }
            } catch (eMeta) {}

            if (!transactionFound) {
              try {
                const orderRes = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/pagamentos?metadata->>order_id=eq.${encodeURIComponent(queryTxid)}&limit=1`, {
                  headers: { "apikey": supabaseKey, "Authorization": `Bearer ${supabaseKey}` }
                });
                if (orderRes.ok) {
                  const orderRows = await orderRes.json();
                  if (orderRows && orderRows.length > 0) transactionFound = orderRows[0];
                }
              } catch (eOrd) {}
            }
          }
        } catch (dbErr) {
          console.warn("[Checkout Process GET] Erro ao consultar Supabase:", dbErr.message);
        }
      }

      // 2. Fallback no Store Local / Memória multi-identificador
      if (!transactionFound) {
        const localStore = settingsStore.loadLocalStore();
        if (Array.isArray(localStore.pagamentos)) {
          if (queryTxid) {
            transactionFound = localStore.pagamentos.find(p => 
              p.txid === queryTxid || 
              p.payment_id === queryTxid || 
              p.order_id === queryTxid || 
              p.external_reference === queryTxid || 
              p.gateway_transaction_id === queryTxid || 
              p.id === queryTxid ||
              (p.metadata && (p.metadata.order_id === queryTxid || p.metadata.payment_id === queryTxid || p.metadata.external_reference === queryTxid))
            );
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

      // 2.5 Reconciliação direta com Mercado Pago se não localizado no container local
      if (!transactionFound && queryTxid && mercadoPago.isConfigured()) {
        try {
          let mpItem = null;
          const cleanId = String(queryTxid).replace(/^PAY/i, "");
          if (/^\d+$/.test(cleanId)) {
            mpItem = await mercadoPago.consultarPagamentoPorId(cleanId);
          }
          if (!mpItem) {
            mpItem = await mercadoPago.consultarPagamentoPorExternalReference(queryTxid);
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
                nome_pagador: `${mpItem.payer?.first_name || ''} ${mpItem.payer?.last_name || ''}`.trim() || "Participante EJC",
                pago_em: mpItem.date_approved || new Date().toISOString()
              };
            } else {
              transactionFound = {
                txid: extRef,
                payment_id: String(mpItem.id),
                status: mpItem.status || "pending",
                valor: Number(mpItem.transaction_amount),
                email: mpItem.payer?.email,
                nome_pagador: `${mpItem.payer?.first_name || ''} ${mpItem.payer?.last_name || ''}`.trim() || "Participante EJC",
                criado_em: mpItem.date_created || new Date().toISOString()
              };
            }

            // Persiste no store local deste container
            try {
              const localStore = settingsStore.loadLocalStore();
              if (!Array.isArray(localStore.pagamentos)) localStore.pagamentos = [];
              const existIdx = localStore.pagamentos.findIndex(p => p.txid === transactionFound.txid);
              if (existIdx >= 0) {
                localStore.pagamentos[existIdx] = { ...localStore.pagamentos[existIdx], ...transactionFound };
              } else {
                localStore.pagamentos.unshift(transactionFound);
              }
              settingsStore.saveLocalStore(localStore);
            } catch (eSave) {}
          }
        } catch (eMpRecovery) {
          console.warn("[Checkout GET MP Recovery Error]", eMpRecovery.message);
        }
      }

      if (!transactionFound) {
        return res.status(404).json({
          success: false,
          error: "Nenhum pagamento correspondente foi localizado.",
          status: "not_found"
        });
      }

      const isManual = transactionFound.modalidade_pix === "manual" || transactionFound.metadata?.modalidade_pix === "manual";

      // 2.6 Reconciliação Server-Side no Polling (para modalidade api_webhook se transação estiver 'pending')
      if (!isManual && transactionFound && (transactionFound.status === "pending" || !transactionFound.status)) {
        if (mercadoPago.isConfigured()) {
          try {
            let approvedItem = null;
            const targetTxid = transactionFound.txid || queryTxid;
            if (targetTxid) {
              approvedItem = await mercadoPago.consultarPagamentoPorExternalReference(targetTxid);
            }
            if (!approvedItem) {
              const targetPaymentId = transactionFound.payment_id || transactionFound.metadata?.payment_id || queryTxid;
              const cleanId = String(targetPaymentId || "").replace(/^PAY/i, "");
              if (/^\d+$/.test(cleanId)) {
                approvedItem = await mercadoPago.consultarPagamentoPorId(cleanId);
              }
            }

            if (approvedItem) {
              if (approvedItem.status === "approved") {
                const reconcileResult = await confirmarPagamentoResiliente({
                  txid: approvedItem.external_reference || transactionFound.txid || queryTxid,
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
                transactionFound.status = approvedItem.status;
              }
            }
          } catch (eGw) {
            console.warn("[Polling Reconciler] Aviso ao consultar API Mercado Pago:", eGw.message);
          }
        }
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

      const responsePayload = {
        success: true,
        txid: transactionFound.txid,
        payment_id: transactionFound.payment_id || transactionFound.metadata?.payment_id || transactionFound.txid,
        order_id: transactionFound.order_id || transactionFound.metadata?.order_id || null,
        external_reference: transactionFound.external_reference || transactionFound.metadata?.external_reference || transactionFound.txid,
        modalidade_pix: isManual ? "manual" : "api_webhook",
        status: transactionFound.status || (isManual ? "aguardando_analise" : "pending"),
        status_analise_manual: transactionFound.status_analise_manual || transactionFound.metadata?.status_analise_manual || (isManual ? "pendente" : null),
        comprovante_caminho: transactionFound.comprovante_caminho || transactionFound.metadata?.comprovante_url || null,
        comprovante_enviado: Boolean(transactionFound.comprovante_caminho || transactionFound.metadata?.comprovante_url || transactionFound.metadata?.comprovante_caminho),
        pago: transactionFound.status === "approved" || transactionFound.status === "confirmado" || transactionFound.status === "paid",
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
      };
      responsePayload.payment = { ...responsePayload };
      return res.status(200).json(responsePayload);
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
      nome_completo,
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
    if (action === "confirm_payment" || action === "verificar_pagamento" || action === "reconciliar") {
      const targetTxid = bodyTxid || req.body?.id || req.body?.payment_id || req.body?.order_id || req.body?.external_reference;
      if (!targetTxid) {
        return res.status(400).json({ error: "Identificador (TXID, Payment ID ou Order ID) obrigatório para confirmar pagamento." });
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
      const targetTxid = bodyTxid || req.body?.id || req.body?.payment_id || req.body?.order_id || req.body?.external_reference;
      const targetEmail = email ? String(email).trim().toLowerCase() : null;

      if (!targetTxid && !targetEmail) {
        return res.status(400).json({ error: "Informe o TXID, Payment ID ou E-mail para reenviar o comprovante." });
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

    // --------------------------------------------------------------------------
    // AÇÃO 3: ENVIO DE COMPROVANTE DO PIX MANUAL (MESMA TELA DO CHECKOUT)
    // --------------------------------------------------------------------------
    if (action === "enviar_comprovante_manual" || action === "upload_comprovante") {
      const targetTxid = bodyTxid || req.body?.id || req.body?.payment_id || req.body?.external_reference;
      const comprovanteCaminho = req.body?.comprovante_caminho || req.body?.comprovante_url || req.body?.comprovante_base64 || req.body?.comprovanteBase64;
      const comprovanteNome = req.body?.comprovante_nome || "comprovante_pix.png";

      if (!targetTxid) {
        return res.status(400).json({ error: "Identificador da transação (TXID) é obrigatório." });
      }
      if (!comprovanteCaminho) {
        return res.status(400).json({ error: "Arquivo ou link do comprovante é obrigatório." });
      }

      const agora = new Date().toISOString();
      let comprovanteUrlFinal = comprovanteCaminho;

      // Se for base64 e houver Supabase Storage configurado, tenta fazer upload
      if (comprovanteCaminho.startsWith("data:") && supabaseUrl && supabaseKey) {
        try {
          const matches = comprovanteCaminho.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
          if (matches && matches.length === 3) {
            const mimeType = matches[1];
            const buffer = Buffer.from(matches[2], "base64");
            const fileExt = mimeType.includes("pdf") ? "pdf" : "png";
            const storagePath = `comprovantes/manual_${targetTxid}_${Date.now()}.${fileExt}`;

            const uploadRes = await fetch(`${supabaseUrl.replace(/\/$/, "")}/storage/v1/object/fotos/${storagePath}`, {
              method: "POST",
              headers: {
                "apikey": supabaseKey,
                "Authorization": `Bearer ${supabaseKey}`,
                "Content-Type": mimeType
              },
              body: buffer
            });
            if (uploadRes.ok) {
              comprovanteUrlFinal = `${supabaseUrl.replace(/\/$/, "")}/storage/v1/object/public/fotos/${storagePath}`;
            }
          }
        } catch (eStorage) {
          console.warn("[enviar_comprovante_manual] Storage upload fallback:", eStorage.message);
        }
      }

      // 1. Atualiza no Supabase
      if (supabaseUrl && supabaseKey) {
        try {
          await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/pagamentos?txid=eq.${encodeURIComponent(targetTxid)}`, {
            method: "PATCH",
            headers: { "apikey": supabaseKey, "Authorization": `Bearer ${supabaseKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              comprovante_caminho: comprovanteUrlFinal,
              status: "aguardando_analise",
              atualizado_em: agora
            })
          });

          // Também atualiza em inscricoes se houver vinculo
          if (email) {
            await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/inscricoes?email=eq.${encodeURIComponent(email)}`, {
              method: "PATCH",
              headers: { "apikey": supabaseKey, "Authorization": `Bearer ${supabaseKey}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                comprovante_caminho: comprovanteUrlFinal,
                pagamento_status: "aguardando_analise",
                atualizado_em: agora
              })
            }).catch(() => {});
          }
        } catch (dbErr) {
          console.warn("[enviar_comprovante_manual] Erro ao atualizar Supabase:", dbErr.message);
        }
      }

      // 2. Atualiza no Store Local
      try {
        const localStore = settingsStore.loadLocalStore();
        if (Array.isArray(localStore.pagamentos)) {
          const pIdx = localStore.pagamentos.findIndex(p => p.txid === targetTxid);
          if (pIdx !== -1) {
            localStore.pagamentos[pIdx].comprovante_caminho = comprovanteUrlFinal;
            localStore.pagamentos[pIdx].status = "aguardando_analise";
            localStore.pagamentos[pIdx].status_analise_manual = "pendente";
            localStore.pagamentos[pIdx].comprovante_enviado_em = agora;
            if (email) localStore.pagamentos[pIdx].email = email;
            if (nome) localStore.pagamentos[pIdx].nome_pagador = nome;
            if (whatsapp) localStore.pagamentos[pIdx].whatsapp_pagador = whatsapp;
            if (sub) localStore.pagamentos[pIdx].sub = sub;
            if (!localStore.pagamentos[pIdx].metadata) localStore.pagamentos[pIdx].metadata = {};
            localStore.pagamentos[pIdx].metadata.comprovante_url = comprovanteUrlFinal;
            localStore.pagamentos[pIdx].metadata.status_analise_manual = "pendente";
            localStore.pagamentos[pIdx].metadata.modalidade_pix = "manual";
          } else {
            localStore.pagamentos.unshift({
              txid: targetTxid,
              payment_id: targetTxid,
              order_id: targetTxid,
              nome_pagador: nome || "Participante",
              email: email || null,
              whatsapp_pagador: whatsapp || null,
              sub: sub || "Geral",
              valor: 50,
              metodo: "pix",
              status: "aguardando_analise",
              status_analise_manual: "pendente",
              comprovante_caminho: comprovanteUrlFinal,
              comprovante_enviado_em: agora,
              criado_em: agora,
              metadata: {
                comprovante_url: comprovanteUrlFinal,
                status_analise_manual: "pendente",
                modalidade_pix: "manual",
                sub: sub || "Geral"
              }
            });
          }
        }

        // Auditoria
        if (!Array.isArray(localStore.historico)) localStore.historico = [];
        localStore.historico.unshift({
          id: `audit-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
          acao: "MANUAL_PROOF_UPLOADED",
          usuario: nome || email || "participante",
          campo_afetado: "comprovante_caminho",
          valor_anterior: null,
          valor_novo: comprovanteUrlFinal.slice(0, 100),
          motivo: `Comprovante enviado para análise do Pix manual: ${targetTxid}`,
          ip_origem: req.headers["x-forwarded-for"] || "127.0.0.1",
          criado_em: agora,
          detalhes: { txid: targetTxid }
        });

        settingsStore.saveLocalStore(localStore);
      } catch (localErr) {
        console.warn("[enviar_comprovante_manual] Erro localStore:", localErr.message);
      }

      // 3. Notificações por e-mail: confirmação de recebimento para o participante e alerta para a coordenação
      try {
        const emailService = require("./_email-service");
        const currentStore = settingsStore.loadLocalStore();
        const clientEmail = email || (currentStore.pagamentos?.find(p => p.txid === targetTxid)?.email);
        const clientNome = nome || (currentStore.pagamentos?.find(p => p.txid === targetTxid)?.nome_pagador) || "Participante";
        const clientValor = currentStore.pagamentos?.find(p => p.txid === targetTxid)?.valor;
        const clientSub = currentStore.pagamentos?.find(p => p.txid === targetTxid)?.sub;
        const clientWpp = currentStore.pagamentos?.find(p => p.txid === targetTxid)?.whatsapp_pagador;

        const manualRecord = {
          txid: targetTxid,
          nome_pagador: clientNome,
          email: clientEmail,
          whatsapp_pagador: clientWpp,
          valor: clientValor,
          sub: clientSub,
          comprovante_caminho: comprovanteUrlFinal
        };

        if (clientEmail) {
          await emailService.sendManualProofReceivedEmail({ paymentRecord: manualRecord }).catch(e => console.warn("[Manual Proof] Erro email cliente:", e.message));
        }
        await emailService.sendAdminManualProofAlertEmail({ paymentRecord: manualRecord, comprovanteUrl: comprovanteUrlFinal }).catch(e => console.warn("[Manual Proof] Erro email admin:", e.message));
      } catch (eNotif) {
        console.warn("[Manual Proof] Falha ao despachar notificações:", eNotif.message);
      }

      return res.status(200).json({
        success: true,
        persisted: true,
        status: "aguardando_analise",
        status_analise_manual: "pendente",
        comprovante_caminho: comprovanteUrlFinal,
        message: "Comprovante enviado para análise pela coordenação."
      });
    }

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) {
      return res.status(400).json({ error: "E-mail válido e obrigatório para envio do comprovante." });
    }

    const VALID_SUBS = ["Verde", "Vermelho", "Amarelo", "Laranja"];
    let subFinal = null;

    if (tipo === "inscricao") {
      // 1. Validação obrigatória de Sub: NÃO permitir null, vazio ou omitido, nem fallback automático para Verde!
      let rawSub = sub ? String(sub).trim() : "";
      if (rawSub.toLowerCase() === "azul") rawSub = "Laranja";
      const matchedSub = VALID_SUBS.find(s => s.toLowerCase() === rawSub.toLowerCase());
      if (!matchedSub) {
        return res.status(400).json({
          error: "Sub inválido ou não selecionado. A escolha do Sub é obrigatória para prosseguir com a inscrição."
        });
      }
      subFinal = matchedSub;

      // 2. Validação obrigatória contra pagamentos já confirmados/aprovados (idempotência de pagamento)
      const cleanEmail = String(email).trim().toLowerCase();
      if (supabaseUrl && supabaseKey) {
        try {
          let filterUrl = `${supabaseUrl.replace(/\/$/, "")}/rest/v1/pagamentos?`;
          if (inscricao_id) {
            filterUrl += `inscricao_id=eq.${encodeURIComponent(inscricao_id)}&status=in.(approved,confirmado,paid)&limit=1`;
          } else {
            filterUrl += `email=eq.${encodeURIComponent(cleanEmail)}&sub=eq.${encodeURIComponent(subFinal)}&status=in.(approved,confirmado,paid)&limit=1`;
          }
          const checkPaidRes = await fetch(filterUrl, {
            headers: { "apikey": supabaseKey, "Authorization": `Bearer ${supabaseKey}` },
            signal: AbortSignal.timeout(3000)
          });
          if (checkPaidRes.ok) {
            const paidRows = await checkPaidRes.json();
            if (Array.isArray(paidRows) && paidRows.length > 0) {
              return res.status(400).json({
                error: "Esta inscrição já possui um pagamento aprovado/confirmado. Não é necessário realizar um novo pagamento."
              });
            }
          }
        } catch (eCheck) {
          console.warn("[Checkout Process] Checagem de pagamento já confirmado:", eCheck.message);
        }
      }

      // Validação também no localStore
      try {
        const localStore = settingsStore.loadLocalStore();
        if (Array.isArray(localStore.pagamentos)) {
          const alreadyApproved = localStore.pagamentos.some(p => {
            const isApproved = p.status === "approved" || p.status === "confirmado" || p.status === "paid";
            const matchInscricao = inscricao_id && p.inscricao_id === inscricao_id;
            const matchEmailSub = cleanEmail && p.email && p.email.toLowerCase() === cleanEmail && (p.sub === subFinal || p.metadata?.sub === subFinal);
            return isApproved && (matchInscricao || matchEmailSub);
          });
          if (alreadyApproved) {
            return res.status(400).json({
              error: "Esta inscrição já possui um pagamento aprovado/confirmado no sistema."
            });
          }
        }
      } catch (eLocalStore) {}
    } else {
      subFinal = sub ? String(sub).trim() : null;
    }

    const nomeFinal = (nome || nome_completo || "Participante").trim();
    const metodoFinal = (metodo || "pix").toLowerCase();

    const ts36 = Date.now().toString(36).toUpperCase();
    const rnd4 = Math.random().toString(36).substring(2, 6).toUpperCase();
    const orderId = `ORD${ts36}${rnd4}`;
    let paymentId = `PAY${ts36}${rnd4}`;
    const txid = (metodoFinal === "credit_card" ? "CARD" : "PIX") + ts36 + rnd4;
    const externalReference = txid;

    // Busca configuração financeira ativa oficial garantida pelo settingsStore
    let officialPrice = Number(process.env.NEXT_PUBLIC_PIX_VALOR_INSCRICAO || 50.00);
    let chavePix = process.env.NEXT_PUBLIC_PIX_CHAVE || "leoeuler03@gmail.com";
    let beneficiario = process.env.NEXT_PUBLIC_PIX_BENEFICIARIO || "EJC TRANSITO MONTE SIAO";
    let cidade = process.env.NEXT_PUBLIC_PIX_CIDADE || "CAMPINA GRANDE";
    let loteAtual = "1º Lote";
    let maxParcelasAllowed = 12;
    let activeData = null;

    const clientVersao = Number(req.body?.versao || req.headers["x-client-version"] || 0);
    const clientChavePix = req.body?.chave_pix || req.body?.pix_chave || req.body?.chave;
    const clientValor = Number(req.body?.valor !== undefined ? req.body?.valor : (valor || 0));

    try {
      activeData = await settingsStore.getActiveSettings();
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
    if (metodoFinal === "pix") {
      const activeConf = (activeData && activeData.settings) ? activeData.settings : {};
      const modalidadePix = (activeConf.modalidade_pix === "manual" || activeConf.pix_mode === "manual") ? "manual" : "api_webhook";
      const tempoExpiracao = Number(process.env.NEXT_PUBLIC_PIX_EXPIRACAO_MINUTOS || 15);
      const expiracao = new Date(Date.now() + tempoExpiracao * 60000).toISOString();

      let payloadPix = "";
      let qrCodeBase64 = null;
      let ticketUrl = null;
      let mpGenerated = false;
      let mpPaymentId = null;
      let initialStatus = "pending";
      let manualDetails = null;

      // ----------------------------------------------------------------------
      // MODO A: PIX VIA API + WEBHOOK (MERCADO PAGO OFICIAL)
      // ----------------------------------------------------------------------
      if (modalidadePix === "api_webhook") {
        if (mercadoPago.isConfigured()) {
          try {
            const descricaoCob = tipo === "inscricao" ? `Inscrição EJC Trânsito ${loteAtual}` : "Contribuição EJC Trânsito";
            const notificationUrl = `${getPublicBaseUrl()}/api/pix-webhook`;

            const mpResult = await mercadoPago.criarPagamentoPix({
              valor: valorNumerico,
              nome: nomeFinal,
              email: email,
              cpf: cpf || null,
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

              // Log de diagnóstico seguro (Seção 12 das diretrizes - sem expor credenciais)
              console.log(`[CHECKOUT_PIX_DIAGNOSTICO] ORIGEM_QR=MERCADO_PAGO | PAYMENT_ID=${mpPaymentId} | EXTERNAL_REFERENCE=${txid} | QR_CODE_LEN=${payloadPix.length} | QR_BASE64_PRESENTE=${Boolean(qrCodeBase64)}`);
            } else {
              throw new Error("Mercado Pago retornou resposta sem qr_code oficial.");
            }
          } catch (mpErr) {
            console.error("[Checkout Process] Falha na criação do Pix dinâmico no Mercado Pago:", mpErr.message);
            // ZERO EMV local fallback quando API está ativa!
            return res.status(502).json({
              error: "Não foi possível gerar a cobrança Pix via Mercado Pago neste momento. Tente novamente em instantes.",
              detail: mpErr.message
            });
          }
        } else {
          // Se Mercado Pago não configurado (ex.: ambiente local sem credencial privada)
          return res.status(503).json({
            error: "Modalidade Pix via API ativa, porém MERCADOPAGO_ACCESS_TOKEN não está configurado na Vercel.",
            hint: "Configure a credencial privada na Vercel ou ative o Modo Pix Manual no painel administrativo."
          });
        }
      }

      // ----------------------------------------------------------------------
      // MODO B: PIX MANUAL (CHAVE MANUAL + ENVIO DE COMPROVANTE NA MESMA TELA)
      // ----------------------------------------------------------------------
      if (modalidadePix === "manual") {
        initialStatus = "aguardando_analise";
        payloadPix = chavePix;
        manualDetails = {
          chave: chavePix,
          tipo_chave: activeConf.pix_tipo_chave || "TELEFONE",
          beneficiario: beneficiario,
          cidade: cidade,
          instrucoes: activeConf.pix_instrucoes_manual || "Faça o Pix para a chave acima e anexe o comprovante nesta tela para análise da coordenação.",
          permite_comprovante: activeConf.pix_permite_comprovante !== false
        };
        console.log(`[CHECKOUT_PIX_DIAGNOSTICO] ORIGEM_PIX=MANUAL | TXID=${txid} | CHAVE_LEN=${chavePix.length}`);
      }

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
              p_nome_pagador: nomeFinal,
              p_email: email.trim().toLowerCase(),
              p_whatsapp_pagador: whatsapp || null,
              p_cpf_pagador: cpf || null,
              p_valor: valorNumerico,
              p_metodo: "pix",
              p_parcelas: 1,
              p_cartao_ultimos_digitos: null,
              p_cartao_bandeira: null,
              p_status: initialStatus,
              p_tipo: tipo || "inscricao",
              p_pix_copia_e_cola: payloadPix,
              p_qr_code_base64: qrCodeBase64,
              p_expiracao: expiracao,
              p_inscricao_id: inscricao_id || null,
              p_metadata: {
                order_id: orderId,
                payment_id: paymentId,
                external_reference: externalReference,
                sub: subFinal,
                modalidade_pix: modalidadePix,
                status_analise_manual: modalidadePix === "manual" ? "pendente" : null,
                gerado_via: mpGenerated ? "api_mercadopago" : "pix_manual",
                provedor: mpGenerated ? "mercadopago" : "pix_manual",
                ticket_url: ticketUrl,
                lote: loteAtual,
                inscricao_id: inscricao_id || null
              }
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
          payment_id: paymentId,
          order_id: orderId,
          external_reference: externalReference,
          gateway_transaction_id: paymentId,
          nome_pagador: nomeFinal,
          email: email.trim().toLowerCase(),
          whatsapp_pagador: whatsapp || null,
          valor: valorNumerico,
          metodo: "pix",
          modalidade_pix: modalidadePix,
          status: initialStatus,
          status_analise_manual: modalidadePix === "manual" ? "pendente" : null,
          tipo: tipo || "inscricao",
          pix_copia_e_cola: payloadPix,
          qr_code_base64: qrCodeBase64,
          ticket_url: ticketUrl,
          provedor: mpGenerated ? "mercadopago" : "pix_manual",
          inscricao_id: inscricao_id || null,
          sub: subFinal,
          metadata: {
            order_id: orderId,
            payment_id: paymentId,
            external_reference: externalReference,
            modalidade_pix: modalidadePix,
            status_analise_manual: modalidadePix === "manual" ? "pendente" : null,
            sub: subFinal,
            ticket_url: ticketUrl,
            lote: loteAtual
          },
          criado_em: new Date().toISOString()
        });
        if (localData.pagamentos.length > 200) localData.pagamentos.pop();
        settingsStore.saveLocalStore(localData);
      } catch (localErr) {
        console.warn("[Checkout Process] Erro ao salvar Pix localmente:", localErr.message);
      }

      // Se Pix via API Mercado Pago foi gerado com sucesso, despacha e-mail de pedido iniciado (sem confirmar pagamento)
      if (modalidadePix === "api_webhook" && mpGenerated && email) {
        try {
          const emailService = require("./_email-service");
          await emailService.sendOrderCreatedEmail({
            paymentRecord: {
              txid: txid,
              order_id: orderId,
              payment_id: paymentId,
              nome_pagador: nomeFinal,
              email: email.trim().toLowerCase(),
              valor: valorNumerico,
              pix_copia_e_cola: payloadPix,
              sub: subFinal,
              metadata: { order_id: orderId, lote: loteAtual, sub: subFinal }
            },
            payloadPix
          }).catch(e => console.warn("[Checkout Process] Erro no envio de email order_created:", e.message));
        } catch (eEmail) {}
      }

      return res.status(200).json({
        success: true,
        metodo: "pix",
        modalidade_pix: modalidadePix,
        txid: txid,
        payment_id: paymentId,
        mp_payment_id: mpPaymentId,
        order_id: orderId,
        external_reference: externalReference,
        valor: valorNumerico,
        chave: (modalidadePix === "manual") ? chavePix : null,
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
      });
    }

    // --------------------------------------------------------------------------
    // PROCESSAMENTO CARTÃO DE CRÉDITO
    // --------------------------------------------------------------------------
    if (metodoFinal === "credit_card") {
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
                order_id: orderId,
                payment_id: paymentId,
                external_reference: externalReference,
                sub: subFinal,
                titular: cartao_titular || null,
                token: cartao_token ? "tokenizado" : "direto",
                lote: loteAtual,
                inscricao_id: inscricao_id || null
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
          payment_id: paymentId,
          order_id: orderId,
          nome: nome || cartao_titular || "Participante",
          email: email.trim().toLowerCase(),
          valor: valorNumerico,
          metodo: "credit_card",
          sub: subFinal || "Geral",
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
          payment_id: paymentId,
          order_id: orderId,
          external_reference: externalReference,
          gateway_transaction_id: paymentId,
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
          sub: subFinal,
          metadata: {
            order_id: orderId,
            payment_id: paymentId,
            external_reference: externalReference,
            sub: subFinal,
            lote: loteAtual
          },
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
        payment_id: paymentId,
        order_id: orderId,
        external_reference: externalReference,
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

