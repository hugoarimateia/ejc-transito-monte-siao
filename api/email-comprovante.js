// ==============================================================================
// VERCEL SERVERLESS FUNCTION: /api/email-comprovante
// Camada de compatibilidade para envio/reenvio de comprovantes por e-mail
// Delega nativamente para o novo EmailService centralizado e Brevo Provider
// ==============================================================================

const emailService = require("./_email-service");

/**
 * Função utilitária central de disparo de comprovante por e-mail.
 * Mantida para retrocompatibilidade com callers existentes (checkout-process, settings-store).
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
  executado_por,
  force_resend = false,
  origemAprovacao = "api_gateway"
}) {
  if (!txid || !email) {
    throw new Error("txid e email são campos obrigatórios para disparo de comprovante.");
  }

  let existingRecord = null;
  try {
    const settingsStore = require("./_settings-store");
    const store = settingsStore.loadLocalStore();
    if (Array.isArray(store.pagamentos)) {
      existingRecord = store.pagamentos.find(p => p.txid === txid || p.payment_id === txid || p.order_id === txid);
    }
  } catch (eStore) {}

  const paymentRecord = {
    ...(existingRecord || {}),
    txid: txid,
    order_id: order_id || existingRecord?.order_id || txid,
    payment_id: payment_id || existingRecord?.payment_id || txid,
    nome_pagador: nome || existingRecord?.nome_pagador || "Participante",
    email: String(email || existingRecord?.email).trim().toLowerCase(),
    valor: valor || existingRecord?.valor || 50,
    metodo: metodo || existingRecord?.metodo || "pix",
    sub: sub || existingRecord?.sub || "Geral",
    pago_em: existingRecord?.pago_em || new Date().toISOString(),
    comprovante_email_enviado: Boolean(existingRecord?.comprovante_email_enviado),
    metadata: {
      ...(existingRecord?.metadata || {}),
      sub: sub || existingRecord?.sub || "Geral",
      order_id: order_id || existingRecord?.order_id || txid,
      payment_id: payment_id || existingRecord?.payment_id || txid
    }
  };

  const result = await emailService.sendPaymentApprovedEmail({
    paymentRecord,
    forceResend: Boolean(force_resend),
    origemAprovacao
  });

  return {
    success: Boolean(result.success),
    email_delivered: Boolean(result.success && !result.simulated),
    already_sent: Boolean(result.already_sent),
    message: result.message || (result.success ? "Comprovante despachado com sucesso." : result.error),
    txid: txid,
    email: email,
    provedor: result.simulated ? "simulado_sem_chave" : "brevo",
    messageId: result.messageId || null,
    erro: result.error || null
  };
}

/**
 * Retorna o HTML do Recibo Oficial EJC
 */
function gerarHtmlComprovante(params) {
  return emailService.buildEJCReceiptHtml({
    txid: params.txid,
    orderId: params.order_id || params.txid,
    paymentId: params.payment_id || params.txid,
    nome: params.nome,
    email: params.email,
    valor: params.valor,
    metodo: params.metodo,
    sub: params.sub,
    dataHora: params.dataHora,
    whatsappLink: params.whatsappLink
  });
}

const brevoProvider = require("./_brevo-provider");

// Handler HTTP Serverless da Vercel
const handler = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-admin-token");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // 1. Auditoria Segura e Teste Controlado via GET (Protegido por senha admin)
  if (req.method === "GET") {
    const authHeader = req.headers?.["authorization"] || "";
    const tokenHeader = req.headers?.["x-admin-token"] || "";
    const providedPass = req.query?.pass || tokenHeader || authHeader.replace(/^Bearer\s+/i, "").trim();
    const validPasswords = Object.freeze({
      ...(process.env.ADMIN_PASSWORD ? { [process.env.ADMIN_PASSWORD]: "superadmin" } : {}),
      ...(process.env.FINANCEIRO_PASSWORD ? { [process.env.FINANCEIRO_PASSWORD]: "financeiro" } : {})
    });
    const isAuthorized = Boolean(validPasswords[providedPass]);

    if (!isAuthorized) {
      return res.status(401).json({ error: "Acesso não autorizado ao diagnóstico de e-mail." });
    }

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
        const toEmail = req.query?.to || "leoeuler03@gmail.com";
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
    const { txid, nome, email, valor, metodo, sub, order_id, payment_id, executado_por, force_resend } = req.body || {};

    const result = await sendPaymentReceiptEmail({
      txid,
      nome,
      email,
      valor,
      metodo,
      sub,
      order_id,
      payment_id,
      executado_por: executado_por || "api_email_handler",
      force_resend: Boolean(force_resend)
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

handler.sendPaymentReceiptEmail = sendPaymentReceiptEmail;
handler.gerarHtmlComprovante = gerarHtmlComprovante;
module.exports = handler;
