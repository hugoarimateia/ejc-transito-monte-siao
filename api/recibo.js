// ==============================================================================
// VERCEL SERVERLESS FUNCTION: /api/recibo
// Visualizador e Emissor Web do Comprovante/Recibo Oficial Próprio do EJC
// Suporte a Impressão / Salvar como PDF (@media print) e Consulta por TXID
// ==============================================================================

const settingsStore = require("./_settings-store");
const emailService = require("./_email-service");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Content-Type", "text/html; charset=utf-8");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const queryTxid = req.query.txid || req.query.id || req.query.payment_id || req.query.order_id;
  const queryEmail = req.query.email ? String(req.query.email).trim().toLowerCase() : null;

  if (!queryTxid && !queryEmail) {
    return res.status(400).send(`
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head><meta charset="utf-8"><title>Recibo EJC - Não Encontrado</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:#f8fafc;color:#1e293b;}</style></head>
      <body>
        <h2>Identificador não informado</h2>
        <p>Informe o parâmetro <code>txid</code> ou <code>email</code> na URL para consultar o recibo oficial.</p>
        <a href="/" style="display:inline-block;margin-top:16px;background:#023284;color:#fff;padding:10px 20px;text-decoration:none;border-radius:8px;">Voltar ao Início</a>
      </body>
      </html>
    `);
  }

  let paymentRecord = null;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // 1. Consulta no Supabase
  if (supabaseUrl && supabaseKey) {
    try {
      let queryUrl = `${supabaseUrl.replace(/\/$/, "")}/rest/v1/pagamentos?`;
      if (queryTxid) {
        queryUrl += `or=(txid.eq.${encodeURIComponent(queryTxid)},payment_id.eq.${encodeURIComponent(queryTxid)},order_id.eq.${encodeURIComponent(queryTxid)},id.eq.${encodeURIComponent(queryTxid)})&limit=1`;
      } else if (queryEmail) {
        queryUrl += `email=eq.${encodeURIComponent(queryEmail)}&status=eq.approved&order=criado_em.desc&limit=1`;
      }

      const dbRes = await fetch(queryUrl, {
        headers: { "apikey": supabaseKey, "Authorization": `Bearer ${supabaseKey}` },
        signal: AbortSignal.timeout(3000)
      });

      if (dbRes.ok) {
        const rows = await dbRes.json();
        if (rows && rows.length > 0) {
          paymentRecord = rows[0];
        }
      }
    } catch (dbErr) {
      console.warn("[Recibo Web] Erro Supabase:", dbErr.message);
    }
  }

  // 2. Fallback no Store Local
  if (!paymentRecord) {
    try {
      const store = settingsStore.loadLocalStore();
      if (Array.isArray(store.pagamentos)) {
        if (queryTxid) {
          paymentRecord = store.pagamentos.find(p => 
            p.txid === queryTxid || 
            p.payment_id === queryTxid || 
            p.order_id === queryTxid ||
            p.id === queryTxid ||
            p.metadata?.payment_id === queryTxid ||
            p.metadata?.order_id === queryTxid
          );
        } else if (queryEmail) {
          paymentRecord = store.pagamentos.find(p => (p.email || "").toLowerCase() === queryEmail && p.status === "approved");
        }
      }
    } catch (localErr) {}
  }

  // 3. Fallback direto no Mercado Pago (caso o container tenha reiniciado)
  if (!paymentRecord && queryTxid) {
    try {
      const mercadoPago = require("./_mercadopago");
      if (mercadoPago.isConfigured()) {
        const cleanId = String(queryTxid).replace(/^PAY/i, "");
        let mpItem = null;
        if (/^\d+$/.test(cleanId)) {
          mpItem = await mercadoPago.consultarPagamentoPorId(cleanId);
        }
        if (!mpItem) {
          mpItem = await mercadoPago.consultarPagamentoPorExternalReference(queryTxid);
        }
        if (mpItem && mpItem.status === "approved") {
          paymentRecord = {
            txid: mpItem.external_reference || queryTxid,
            payment_id: String(mpItem.id),
            order_id: String(mpItem.order?.id || mpItem.id),
            nome_pagador: `${mpItem.payer?.first_name || ''} ${mpItem.payer?.last_name || ''}`.trim() || "Participante EJC",
            email: mpItem.payer?.email || "",
            valor: Number(mpItem.transaction_amount),
            metodo: "pix",
            status: "approved",
            sub: "Geral",
            pago_em: mpItem.date_approved || new Date().toISOString()
          };
        }
      }
    } catch (eMp) {}
  }

  if (!paymentRecord) {
    return res.status(404).send(`
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head><meta charset="utf-8"><title>Recibo EJC - Não Encontrado</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:#f8fafc;color:#1e293b;} .card{max-width:500px;margin:0 auto;background:#fff;padding:30px;border-radius:12px;border:1px solid #e2e8f0;}</style></head>
      <body>
        <div class="card">
          <h2 style="color:#023284;">Transação Não Encontrada</h2>
          <p style="color:#64748b;">Nenhum pagamento correspondente aos dados informados (<code>${queryTxid || queryEmail}</code>) foi localizado no sistema.</p>
          <a href="/" style="display:inline-block;margin-top:16px;background:#023284;color:#fff;padding:10px 20px;text-decoration:none;border-radius:8px;">Voltar ao Site</a>
        </div>
      </body>
      </html>
    `);
  }

  const subName = paymentRecord.metadata?.sub || paymentRecord.sub || "Geral";
  const whatsappLink = await emailService.getSubWhatsAppLink(subName);

  // Gera o HTML do recibo oficial
  const receiptHtml = emailService.buildEJCReceiptHtml({
    txid: paymentRecord.txid,
    orderId: paymentRecord.order_id || paymentRecord.metadata?.order_id || paymentRecord.txid,
    paymentId: paymentRecord.payment_id || paymentRecord.metadata?.payment_id || paymentRecord.txid,
    nome: paymentRecord.nome_pagador,
    email: paymentRecord.email,
    whatsapp: paymentRecord.whatsapp_pagador,
    valor: paymentRecord.valor,
    valorOriginal: paymentRecord.metadata?.valor_original,
    desconto: paymentRecord.metadata?.desconto,
    metodo: paymentRecord.metodo,
    modalidadePix: paymentRecord.metadata?.modalidade_pix || paymentRecord.modalidade_pix,
    lote: paymentRecord.metadata?.lote,
    sub: subName,
    categoria: paymentRecord.tipo === "inscricao" ? "Inscrição Oficial da Equipe" : "Contribuição da Equipe",
    dataHora: paymentRecord.pago_em ? new Date(paymentRecord.pago_em).toLocaleString("pt-BR", { timeZone: "America/Fortaleza" }) : new Date().toLocaleString("pt-BR"),
    whatsappLink: whatsappLink,
    origemAprovacao: (paymentRecord.metadata?.modalidade_pix === "manual") ? "manual_coordenacao" : "api_gateway"
  });

  // Insere barra de ações no topo para impressão / salvar PDF
  const printBar = `
    <div style="background:#023284; padding:12px; text-align:center; color:#fff; font-family:sans-serif;" class="no-print">
      <div style="max-width:600px; margin:0 auto; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
        <span style="font-size:14px; font-weight:700;"><i class="fa-solid fa-file-invoice"></i> Recibo Oficial EJC</span>
        <div style="display:flex; gap:10px;">
          <button onclick="window.print()" style="background:#fcc002; color:#023284; border:none; padding:8px 16px; border-radius:6px; font-weight:800; cursor:pointer; font-size:13px;">
            🖨️ Imprimir / Salvar em PDF
          </button>
          <a href="/" style="background:rgba(255,255,255,0.15); color:#fff; text-decoration:none; padding:8px 14px; border-radius:6px; font-size:13px; font-weight:600;">
            ← Voltar
          </a>
        </div>
      </div>
    </div>
    <style>
      @media print {
        .no-print { display: none !important; }
        body { background: #fff !important; padding: 0 !important; }
        .email-wrapper { padding: 0 !important; }
        .email-container { box-shadow: none !important; border: 1px solid #ccc !important; }
      }
    </style>
  `;

  const finalHtml = receiptHtml.replace("<body>", `<body>${printBar}`);
  return res.status(200).send(finalHtml);
};
