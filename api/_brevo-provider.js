// ==============================================================================
// BREVO API v3 PROVIDER: api/_brevo-provider.js
// Responsável pela comunicação segura com a API da Brevo (Sendinblue)
// Endpoint: POST https://api.brevo.com/v3/smtp/email
// Autenticação: Header 'api-key: process.env.BREVO_API_KEY'
// Zero exposição de credenciais, tratamento robusto de erros e retries
// ==============================================================================

const BREVO_API_URL = "https://api.brevo.com/v3/smtp/email";

// Configurações padrão do remetente institucional
function getSenderConfig() {
  const email = process.env.BREVO_FROM_EMAIL || "financeiro@ejctransito.com.br";
  const name = process.env.BREVO_FROM_NAME || "EJC — Equipe do Trânsito";
  return { email, name };
}

function getAdminEmail() {
  return process.env.BREVO_ADMIN_EMAIL || "leoeuler03@gmail.com";
}

function isConfigured() {
  return Boolean(process.env.BREVO_API_KEY && process.env.BREVO_API_KEY.trim().length > 10);
}

/**
 * Envia um e-mail transacional via API v3 da Brevo
 * @param {Object} params
 * @param {string} params.to - E-mail do destinatário
 * @param {string} [params.toName] - Nome do destinatário
 * @param {string} params.subject - Assunto do e-mail
 * @param {string} params.htmlContent - Conteúdo HTML do e-mail
 * @param {string} [params.textContent] - Conteúdo em texto puro (opcional)
 * @param {Object} [params.sender] - Remetente customizado (opcional)
 * @param {Array} [params.attachments] - Anexos base64 (opcional)
 * @param {string} [params.replyTo] - E-mail de resposta (opcional)
 * @param {Object} [params.tags] - Tags para monitoramento na Brevo (opcional)
 * @returns {Promise<{ success: boolean, messageId?: string, error?: string, simulated?: boolean }>}
 */
async function sendEmail({
  to,
  toName,
  subject,
  htmlContent,
  textContent,
  sender,
  attachments,
  replyTo,
  tags
}) {
  if (!to || !to.includes("@")) {
    return { success: false, error: "Destinatário de e-mail inválido ou ausente." };
  }
  if (!subject) {
    return { success: false, error: "Assunto do e-mail é obrigatório." };
  }
  if (!htmlContent) {
    return { success: false, error: "Conteúdo HTML do e-mail é obrigatório." };
  }

  const apiKey = process.env.BREVO_API_KEY ? process.env.BREVO_API_KEY.trim() : "";

  // Se a chave não estiver configurada no ambiente atual (ex.: desenvolvimento local sem .env),
  // opera em modo simulado seguro sem falhar a operação transacional
  if (!apiKey) {
    console.warn(`[BrevoProvider] BREVO_API_KEY não configurada no ambiente. Modo simulado para: ${to} (Assunto: "${subject}")`);
    return {
      success: true,
      simulated: true,
      messageId: `simulated-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
      destinatario: to,
      assunto: subject
    };
  }

  const defaultSender = getSenderConfig();
  const senderFinal = {
    name: (sender && sender.name) || defaultSender.name,
    email: (sender && sender.email) || defaultSender.email
  };

  const payload = {
    sender: senderFinal,
    to: [
      {
        email: String(to).trim().toLowerCase(),
        name: toName ? String(toName).trim() : undefined
      }
    ],
    subject: String(subject).trim(),
    htmlContent: htmlContent
  };

  if (textContent) {
    payload.textContent = textContent;
  }

  if (replyTo) {
    payload.replyTo = { email: replyTo };
  }

  if (Array.isArray(tags) && tags.length > 0) {
    payload.tags = tags.map(t => String(t).slice(0, 50));
  }

  if (Array.isArray(attachments) && attachments.length > 0) {
    payload.attachment = attachments;
  }

  // Tentativa com retry controlado (máximo 2 tentativas em caso de erro 5xx ou timeout de rede)
  const maxAttempts = 2;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(BREVO_API_URL, {
        method: "POST",
        headers: {
          "accept": "application/json",
          "api-key": apiKey,
          "content-type": "application/json"
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8000) // 8 segundos de timeout seguro
      });

      const responseText = await response.text();
      let responseJson = null;
      try {
        responseJson = JSON.parse(responseText);
      } catch (eJson) {}

      if (response.ok) {
        const messageId = responseJson?.messageId || responseJson?.messageIds?.[0] || `brevo-${Date.now()}`;
        console.log(`[BrevoProvider] E-mail enviado com sucesso para ${to}. MessageId: ${messageId}`);
        return {
          success: true,
          messageId: messageId,
          destinatario: to,
          tentativas: attempt
        };
      }

      // Erro na resposta da Brevo
      const sanitizedError = responseJson?.message || responseText || `HTTP ${response.status}`;
      lastError = `Brevo API (${response.status}): ${sanitizedError}`;
      console.warn(`[BrevoProvider] Falha no envio (tentativa ${attempt}/${maxAttempts}): ${lastError}`);

      // Se for erro 4xx do cliente (ex.: e-mail rejeitado ou formato inválido), não adianta retentar
      if (response.status >= 400 && response.status < 500) {
        break;
      }
    } catch (netErr) {
      lastError = `Erro de rede/timeout Brevo: ${netErr.message}`;
      console.warn(`[BrevoProvider] Exceção na tentativa ${attempt}/${maxAttempts}: ${lastError}`);
    }

    // Intervalo de backoff curto antes da próxima tentativa
    if (attempt < maxAttempts) {
      await new Promise(r => setTimeout(r, 600));
    }
  }

  return {
    success: false,
    error: lastError || "Falha desconhecida no envio através da API Brevo.",
    destinatario: to
  };
}

module.exports = {
  sendEmail,
  isConfigured,
  getSenderConfig,
  getAdminEmail
};
