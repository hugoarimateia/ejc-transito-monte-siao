// ==============================================================================
// VERCEL SERVERLESS FUNCTION: /api/email-comprovante
// Envio transacional de comprovantes de pagamento e auditoria de entrega
// Integração direta com a API REST oficial da Brevo v3 (Transactional Emails)
// ==============================================================================

const brevoProvider = require("./_brevo-provider");
const adminAuth = require("./_admin-auth");
const { applyCors } = require("./_cors");

const PAID_STATUS = new Set(["approved", "confirmado", "paid", "concluido", "liquidado", "pago"]);

// Busca o pagamento oficial (Supabase com service_role; fallback no store local)
async function buscarPagamentoOficial(txid) {
  const baseUrl = String(process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "https://guppedddwnuvluhiaaas.supabase.co").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "sb_publishable_QJV9XI3sN3P_gVtiQ2ObRg_gpSSKc-i";

  if (baseUrl && key) {
    try {
      const r = await fetch(`${baseUrl}/rest/v1/pagamentos?txid=eq.${encodeURIComponent(txid)}&limit=1`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(5000)
      });
      if (r.ok) {
        const rows = await r.json();
        if (rows && rows[0]) return rows[0];
      }
    } catch (e) {}
  }
  try {
    const store = require("./_settings-store").loadLocalStore();
    if (Array.isArray(store.pagamentos)) return store.pagamentos.find(p => p.txid === txid) || null;
  } catch (e) {}
  return null;
}

/**
 * Função utilitária centralizada para envio de comprovante
 */
async function sendPaymentReceiptEmail({
  txid,
  nome,
  email,
  valor,
  metodo,
  sub,
  order_id,
  payment_id,
  executado_por = "sistema",
  existingRecord = null,
  force_resend = false
}) {
  const targetEmail = String(email || existingRecord?.email || "").trim().toLowerCase();
  if (!targetEmail || !targetEmail.includes("@")) {
    return { success: false, skipped: true, reason: "E-mail do pagador não informado ou inválido" };
  }

  // Previne envios duplicados se já enviado anteriormente, a menos que force_resend seja true
  if (existingRecord?.comprovante_email_enviado && !force_resend) {
    return {
      success: true,
      already_sent: true,
      message: "Comprovante já havia sido enviado anteriormente para este pagamento.",
      enviado_em: existingRecord.comprovante_email_em
    };
  }

  const receiptData = {
    txid: txid || existingRecord?.txid,
    order_id: order_id || existingRecord?.order_id || txid,
    payment_id: payment_id || existingRecord?.payment_id || txid,
    nome_pagador: nome || existingRecord?.nome_pagador || "Participante",
    email: targetEmail,
    valor: Number(valor || existingRecord?.valor || 0),
    metodo: metodo || existingRecord?.metodo || "pix",
    sub: sub || existingRecord?.sub || "Geral",
    pago_em: existingRecord?.pago_em || new Date().toISOString(),
    ano: new Date().getFullYear()
  };

  const htmlContent = gerarHtmlComprovante(receiptData);
  const textContent = `Comprovante de Inscrição — EJC Trânsito Monte Sião\n\nOlá, ${receiptData.nome_pagador}!\nSeu pagamento de R$ ${receiptData.valor.toFixed(2)} foi confirmado com sucesso.\nSubgrupo: ${receiptData.sub}\nIdentificador: ${receiptData.txid}`;

  const sendResult = await brevoProvider.sendEmail({
    to: receiptData.email,
    toName: receiptData.nome_pagador,
    subject: `Comprovante de Inscrição — EJC Trânsito Monte Sião (ID: ${receiptData.txid.slice(-6).toUpperCase()})`,
    htmlContent: htmlContent,
    textContent: textContent,
    tags: ["ejc", "comprovante", receiptData.metodo, receiptData.sub]
  });

  return {
    success: sendResult.success,
    messageId: sendResult.messageId,
    destinatario: receiptData.email,
    executado_por: executado_por,
    enviado_em: new Date().toISOString()
  };
}

function formatarMoeda(val) {
  return Number(val || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function gerarHtmlComprovante(params) {
  const { nome_pagador, txid, valor, metodo, sub, pago_em, ano } = params;
  const dataFormatada = new Date(pago_em).toLocaleString("pt-BR", { timeZone: "America/Fortaleza" });

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <title>Comprovante de Pagamento — EJC Trânsito Monte Sião</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f4f6f8; margin: 0; padding: 24px; color: #1a202c;">
  <table width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
    <tr>
      <td style="background-color: #0f172a; padding: 28px 24px; text-align: center; color: #ffffff;">
        <h1 style="margin: 0; font-size: 20px; font-weight: 700; letter-spacing: 0.5px;">EJC TRÂNSITO — MONTE SIÃO</h1>
        <p style="margin: 6px 0 0 0; font-size: 13px; color: #94a3b8;">Comprovante Oficial de Inscrição</p>
      </td>
    </tr>
    <tr>
      <td style="padding: 32px 28px;">
        <div style="background-color: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 16px; margin-bottom: 24px; text-align: center;">
          <p style="margin: 0; color: #166534; font-size: 16px; font-weight: 700;">✓ Pagamento Confirmado</p>
        </div>
        <p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.5;">Olá, <strong>${nome_pagador}</strong>!</p>
        <p style="margin: 0 0 24px 0; font-size: 14px; line-height: 1.5; color: #475569;">
          Confirmamos o recebimento da sua contribuição para o Encontro de Jovens com Cristo (EJC). Sua vaga está garantida!
        </p>
        <table width="100%" border="0" cellspacing="0" cellpadding="8" style="background-color: #f8fafc; border-radius: 8px; font-size: 13px; margin-bottom: 24px;">
          <tr>
            <td style="color: #64748b; border-bottom: 1px solid #e2e8f0;">Valor Pago:</td>
            <td style="font-weight: 700; text-align: right; border-bottom: 1px solid #e2e8f0; color: #0f172a;">${formatarMoeda(valor)}</td>
          </tr>
          <tr>
            <td style="color: #64748b; border-bottom: 1px solid #e2e8f0;">Subgrupo:</td>
            <td style="font-weight: 600; text-align: right; border-bottom: 1px solid #e2e8f0;">Sub ${sub}</td>
          </tr>
          <tr>
            <td style="color: #64748b; border-bottom: 1px solid #e2e8f0;">Forma de Pagamento:</td>
            <td style="font-weight: 600; text-align: right; border-bottom: 1px solid #e2e8f0; text-transform: uppercase;">${metodo}</td>
          </tr>
          <tr>
            <td style="color: #64748b; border-bottom: 1px solid #e2e8f0;">Data / Hora:</td>
            <td style="text-align: right; border-bottom: 1px solid #e2e8f0;">${dataFormatada}</td>
          </tr>
          <tr>
            <td style="color: #64748b;">Identificador (TXID):</td>
            <td style="font-family: monospace; font-size: 11px; text-align: right; color: #64748b;">${txid}</td>
          </tr>
        </table>
        <p style="margin: 0; font-size: 13px; line-height: 1.5; color: #64748b;">
          Apresente este comprovante caso seja solicitado pela coordenação no primeiro dia de reuniões.
        </p>
      </td>
    </tr>
    <tr>
      <td style="background-color: #f8fafc; padding: 18px 24px; text-align: center; border-top: 1px solid #e2e8f0; font-size: 12px; color: #94a3b8;">
        © ${ano} Equipe do Trânsito EJC — IEAD Monte Sião. Todos os direitos reservados.
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// Handler HTTP Serverless da Vercel
const handler = async (req, res) => {
  applyCors(req, res);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-admin-token");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // 1. Auditoria Segura e Teste Controlado via GET (Protegido por senha admin)
  if (req.method === "GET") {
    if (!adminAuth.requireRole(req, res, ["superadmin", "financeiro"])) return;

    // Apenas auditoria de conta e histórico
    if (req.query?.audit === "true") {
      try {
        const audit = await brevoProvider.auditBrevo(req.query?.email);
        return res.status(200).json({ success: true, audit });
      } catch (eAudit) {
        return res.status(500).json({ success: false, error: eAudit.message });
      }
    }

    // Teste de envio mínimo isolado
    if (req.query?.test_send === "true") {
      try {
        const toEmail = req.query?.to;
        if (!toEmail) {
          return res.status(400).json({ error: "Informe ?to=email@dominio para o teste de envio." });
        }
        const senderCustom = req.query?.from ? { email: req.query.from, name: req.query.from_name || "EJC Teste" } : undefined;
        const testResult = await brevoProvider.sendEmail({
          to: toEmail,
          toName: "Administrador EJC",
          subject: "EJC — Teste de integração Brevo",
          htmlContent: "<p>Teste de envio da API Brevo.</p>",
          textContent: "Teste de envio da API Brevo.",
          sender: senderCustom,
          tags: ["ejc", "teste_isolado"]
        });
        return res.status(200).json({ success: Boolean(testResult.success), testResult });
      } catch (eTest) {
        return res.status(500).json({ success: false, error: eTest.message });
      }
    }

    return res.status(200).json({
      success: true,
      service: "EJC Email Service",
      brevo_configured: brevoProvider.isConfigured(),
      default_sender: brevoProvider.getSenderConfig()
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método não permitido" });
  }

  try {
    let { txid, nome, email, valor, metodo, sub, order_id, payment_id, executado_por, force_resend } = req.body || {};

    const auth = adminAuth.authenticate(req);
    const isAdmin = auth.ok && auth.canEdit;

    if (!isAdmin) {
      // Chamada pública: NUNCA confia em nome/e-mail/valor enviados pelo navegador.
      // Exige TXID e verifica pagamento oficial aprovado no banco de dados.
      if (!txid) {
        return res.status(400).json({ success: false, error: "TXID obrigatório para envio de comprovante." });
      }
      const oficial = await buscarPagamentoOficial(String(txid));
      if (!oficial || !PAID_STATUS.has(String(oficial.status || "").toLowerCase())) {
        return res.status(403).json({
          success: false,
          error: "Comprovante disponível apenas para pagamentos aprovados e confirmados no sistema."
        });
      }
      nome = oficial.nome_pagador;
      email = oficial.email;
      valor = oficial.valor;
      metodo = oficial.metodo;
      sub = oficial.metadata?.sub || oficial.sub || sub;
      order_id = oficial.order_id || order_id;
      payment_id = oficial.payment_id || payment_id;
      executado_por = "checkout_publico";
      force_resend = false;
    }

    const result = await sendPaymentReceiptEmail({
      txid,
      nome,
      email,
      valor,
      metodo,
      sub,
      order_id,
      payment_id,
      executado_por: executado_por || (isAdmin ? "admin_manual" : "checkout_publico"),
      force_resend: Boolean(force_resend && isAdmin)
    });

    return res.status(200).json(result);
  } catch (err) {
    console.error("[Email Comprovante Exception]", err);
    return res.status(err.message.includes("obrigatórios") || err.message.includes("inválido") ? 400 : 500).json({
      success: false,
      error: err.message || "Falha interna ao processar comprovante por e-mail."
    });
  }
};

module.exports = handler;
module.exports.sendPaymentReceiptEmail = sendPaymentReceiptEmail;
module.exports.gerarHtmlComprovante = gerarHtmlComprovante;
