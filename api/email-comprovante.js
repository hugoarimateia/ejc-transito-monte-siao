// ==============================================================================
// VERCEL SERVERLESS FUNCTION: /api/email-comprovante
// Envio e reenvio de comprovante transacional por e-mail com registro de auditoria
// Integração resiliente com Resend, idempotência e rastreabilidade ponta a ponta
// ==============================================================================

function gerarHtmlComprovante({ txid, nome, email, valor, metodo, sub, dataHora, whatsappLink }) {
  const metodoFormatado = metodo === "credit_card" ? "Cartão de Crédito" : "Pix Instantâneo";
  const valorFormatado = Number(valor || 50).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const dataFormatada = dataHora || new Date().toLocaleString("pt-BR");

  return `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <title>Comprovante de Pagamento - EJC Trânsito Monte Sião</title>
  <style>
    body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #091026; color: #ffffff; margin: 0; padding: 20px; }
    .container { max-width: 580px; margin: 0 auto; background: #111b38; border-radius: 20px; overflow: hidden; border: 1px solid rgba(255,255,255,0.1); }
    .header { background: #023284; padding: 30px 20px; text-align: center; }
    .header h1 { margin: 0; color: #ffffff; font-size: 24px; font-weight: 800; letter-spacing: -0.5px; }
    .header p { margin: 6px 0 0; color: #93c5fd; font-size: 14px; text-transform: uppercase; font-weight: 700; letter-spacing: 1px; }
    .content { padding: 30px; }
    .badge-success { display: inline-block; background: rgba(36,167,100,0.2); color: #34d399; font-weight: 800; font-size: 13px; padding: 6px 14px; border-radius: 999px; margin-bottom: 18px; }
    .receipt-box { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 14px; padding: 20px; margin: 20px 0; }
    .receipt-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.06); font-size: 14px; }
    .receipt-row:last-child { border-bottom: none; }
    .receipt-label { color: #8e9bb8; }
    .receipt-value { font-weight: 700; color: #ffffff; }
    .amount-highlight { font-size: 22px; color: #e9dd3c; font-weight: 800; }
    .btn-whatsapp { display: block; text-align: center; background: #25d366; color: #ffffff; text-decoration: none; font-weight: 800; padding: 15px 24px; border-radius: 12px; margin: 26px 0 16px; font-size: 16px; }
    .footer { text-align: center; padding: 20px 30px; font-size: 12px; color: #8e9bb8; border-top: 1px solid rgba(255,255,255,0.08); }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>EJC Trânsito Monte Sião</h1>
      <p>Comprovante Oficial de Pagamento</p>
    </div>
    <div class="content">
      <div class="badge-success">✓ Transação Aprovada com Sucesso</div>
      <h2 style="margin: 0 0 10px; font-size: 20px;">Olá, ${nome || "Participante"}!</h2>
      <p style="color: #cbd5e1; line-height: 1.5; margin: 0 0 16px;">
        Confirmamos o recebimento do seu pagamento para a <strong>Equipe do Trânsito</strong> do Encontro de Jovens com Cristo da IEAD Monte Sião.
      </p>

      <div class="receipt-box">
        <div class="receipt-row">
          <span class="receipt-label">Identificador (TXID):</span>
          <span class="receipt-value" style="font-family: monospace;">${txid}</span>
        </div>
        <div class="receipt-row">
          <span class="receipt-label">Participante:</span>
          <span class="receipt-value">${nome}</span>
        </div>
        <div class="receipt-row">
          <span class="receipt-label">Sub Grupo:</span>
          <span class="receipt-value">Sub ${sub || "Geral"}</span>
        </div>
        <div class="receipt-row">
          <span class="receipt-label">Forma de Pagamento:</span>
          <span class="receipt-value">${metodoFormatado}</span>
        </div>
        <div class="receipt-row">
          <span class="receipt-label">Data e Hora:</span>
          <span class="receipt-value">${dataFormatada}</span>
        </div>
        <div class="receipt-row" style="align-items: center; padding-top: 12px;">
          <span class="receipt-label" style="font-size: 16px;">Valor Confirmado:</span>
          <span class="amount-highlight">${valorFormatado}</span>
        </div>
      </div>

      ${whatsappLink ? `
      <p style="color: #93c5fd; font-size: 14px; margin-bottom: 8px; font-weight: 600;">
        Não esqueça de entrar no grupo oficial do WhatsApp do seu Sub:
      </p>
      <a href="${whatsappLink}" class="btn-whatsapp" target="_blank">
        Entrar no Grupo do WhatsApp (Sub ${sub || "Equipe"})
      </a>` : ""}

      <p style="color: #8e9bb8; font-size: 13px; line-height: 1.5; margin-top: 20px;">
        Guarde este e-mail como comprovante oficial. Qualquer dúvida, procure a Coordenação da Equipe do Trânsito.
      </p>
    </div>
    <div class="footer">
      <p style="margin: 0 0 6px;">EJC Trânsito Monte Sião — Servindo com excelência e amor ao Reino. ❤️</p>
      <p style="margin: 0;">Campina Grande - PB</p>
    </div>
  </div>
</body>
</html>
  `.trim();
}

/**
 * Função utilitária central de disparo de comprovante por e-mail.
 * Pode ser invocada diretamente em processos serverless (in-process) para garantir execução síncrona com await.
 */
async function sendPaymentReceiptEmail({ txid, nome, email, valor, metodo, sub, executado_por, force_resend = false }) {
  if (!txid || !email) {
    throw new Error("txid e email são campos obrigatórios para disparo de comprovante.");
  }

  const emailLimpo = String(email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLimpo)) {
    throw new Error(`Formato de e-mail inválido: "${emailLimpo}".`);
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // 1. Verificação de idempotência (a menos que force_resend seja verdadeiro)
  if (!force_resend && supabaseUrl && supabaseKey) {
    try {
      const checkRes = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/pagamentos?txid=eq.${encodeURIComponent(txid)}&select=id,status,comprovante_email_enviado`, {
        headers: { "apikey": supabaseKey, "Authorization": `Bearer ${supabaseKey}` }
      });
      if (checkRes.ok) {
        const rows = await checkRes.json();
        if (rows && rows.length > 0 && rows[0].comprovante_email_enviado === true) {
          console.log(`[Email Comprovante] E-mail já enviado anteriormente para transação ${txid}. Ignorando envio duplicado (idempotência).`);
          return {
            success: true,
            already_sent: true,
            txid: txid,
            email: emailLimpo,
            provedor: "idempotente_ja_enviado"
          };
        }
      }
    } catch (checkErr) {
      console.warn("[Email Comprovante] Falha ao verificar idempotência no banco:", checkErr.message);
    }
  }

  // 2. Consulta link do WhatsApp do Sub
  let whatsappLink = "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6";
  if (supabaseUrl && supabaseKey && sub) {
    try {
      const linkRes = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/configuracoes_whatsapp?sub=eq.${encodeURIComponent(sub)}&select=link_grupo,ativo`, {
        headers: { "apikey": supabaseKey, "Authorization": `Bearer ${supabaseKey}` }
      });
      if (linkRes.ok) {
        const links = await linkRes.json();
        if (links && links.length > 0 && links[0].ativo && links[0].link_grupo) {
          whatsappLink = links[0].link_grupo;
        }
      }
    } catch (e) {
      console.warn("[Email Comprovante] Falha ao consultar link do WhatsApp:", e.message);
    }
  }

  // 3. Monta HTML do comprovante
  const htmlContent = gerarHtmlComprovante({
    txid: txid,
    nome: nome || "Participante",
    email: emailLimpo,
    valor: valor || 50,
    metodo: metodo || "pix",
    sub: sub || "Geral",
    dataHora: new Date().toLocaleString("pt-BR"),
    whatsappLink: whatsappLink
  });

  let envioRealizado = false;
  let provedorUsado = "simulado_sem_chave";
  let erroEnvio = null;

  // 4. Disparo via Resend (se RESEND_API_KEY configurado)
  if (process.env.RESEND_API_KEY) {
    const senderOptions = [
      process.env.EMAIL_FROM || "EJC Trânsito <onboarding@resend.dev>",
      "EJC Trânsito <onboarding@resend.dev>"
    ];

    for (const sender of senderOptions) {
      try {
        const resendRes = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            from: sender,
            to: [emailLimpo],
            subject: `Comprovante de Pagamento EJC - TXID ${txid}`,
            html: htmlContent
          })
        });

        if (resendRes.ok) {
          envioRealizado = true;
          provedorUsado = "resend";
          erroEnvio = null;
          break;
        } else {
          const errBody = await resendRes.text();
          erroEnvio = `Resend (${resendRes.status}): ${errBody}`;
          console.warn(`[Email Comprovante] Tentativa com remetente "${sender}" falhou:`, erroEnvio);
          // Se for erro de domínio não verificado, continua para tentar o fallback onboarding@resend.dev
          if (!errBody.toLowerCase().includes("domain") && !errBody.toLowerCase().includes("verify")) {
            break;
          }
        }
      } catch (sendErr) {
        erroEnvio = sendErr.message;
        console.warn("[Email Comprovante] Exceção no envio via Resend:", erroEnvio);
      }
    }
  } else {
    console.log(`[Email Comprovante] RESEND_API_KEY não configurada. Operando em modo de registro local/auditoria para ${emailLimpo}.`);
  }

  // 5. Atualiza status de envio na tabela 'pagamentos'
  const agora = new Date().toISOString();
  if (supabaseUrl && supabaseKey) {
    try {
      await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/pagamentos?txid=eq.${encodeURIComponent(txid)}`, {
        method: "PATCH",
        headers: {
          "apikey": supabaseKey,
          "Authorization": `Bearer ${supabaseKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          comprovante_email_enviado: envioRealizado,
          comprovante_email_em: envioRealizado ? agora : null,
          comprovante_email_erro: erroEnvio ? erroEnvio.slice(0, 255) : null,
          atualizado_em: agora
        })
      });
    } catch (patchErr) {
      console.warn("[Email Comprovante] Falha ao atualizar status de email em pagamentos:", patchErr.message);
    }

    // 6. Registra na tabela de auditoria de transações
    try {
      await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/auditoria_transacoes`, {
        method: "POST",
        headers: {
          "apikey": supabaseKey,
          "Authorization": `Bearer ${supabaseKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          transacao_id: txid,
          acao: envioRealizado ? "comprovante_enviado" : "comprovante_falha",
          status_anterior: null,
          status_novo: envioRealizado ? "comprovante_emitido" : "falha_despacho",
          executado_por: executado_por || "sistema_email",
          detalhes: {
            email: emailLimpo,
            metodo: metodo,
            valor: valor,
            provedor: provedorUsado,
            enviado_com_sucesso: envioRealizado,
            erro: erroEnvio
          }
        })
      });
    } catch (auditErr) {
      console.warn("[Email Comprovante] Falha ao registrar auditoria:", auditErr.message);
    }
  }

  return {
    success: envioRealizado || (!process.env.RESEND_API_KEY && !erroEnvio),
    email_delivered: envioRealizado,
    message: envioRealizado
      ? `Comprovante enviado com sucesso para ${emailLimpo}.`
      : (erroEnvio ? `Falha no envio de e-mail: ${erroEnvio}` : `Comprovante registrado em auditoria para ${emailLimpo} (ambiente sem chave de envio configurada).`),
    txid: txid,
    email: emailLimpo,
    provedor: provedorUsado,
    erro: erroEnvio
  };
}

// Handler HTTP Serverless da Vercel
const handler = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método não permitido" });
  }

  try {
    const { txid, nome, email, valor, metodo, sub, executado_por, force_resend } = req.body || {};

    const result = await sendPaymentReceiptEmail({
      txid,
      nome,
      email,
      valor,
      metodo,
      sub,
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
