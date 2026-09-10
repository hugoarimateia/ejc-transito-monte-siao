// ==============================================================================
// EJC TRANSACTIONAL EMAIL SERVICE: api/_email-service.js
// Camada centralizada de eventos de e-mail, idempotência, auditoria
// e Gerador do Comprovante/Recibo Oficial Próprio do EJC
// Integração oficial via Brevo Provider (api-key: process.env.BREVO_API_KEY)
// ==============================================================================

const brevoProvider = require("./_brevo-provider");
const settingsStore = require("./_settings-store");

// Helper para credenciais Supabase
function getSupabaseCredentials() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return { url: url ? url.replace(/\/$/, "") : null, key };
}

// Cores e estilos oficiais dos Sub Grupos do EJC
const SUB_COLORS = {
  "Verde": { bg: "#ecfdf5", border: "#10b981", text: "#065f46", badge: "#10b981" },
  "Vermelho": { bg: "#fef2f2", border: "#ef4444", text: "#991b1b", badge: "#ef4444" },
  "Amarelo": { bg: "#fffbeb", border: "#f59e0b", text: "#92400e", badge: "#f59e0b" },
  "Azul": { bg: "#eff6ff", border: "#3b82f6", text: "#1e40af", badge: "#3b82f6" },
  "Geral": { bg: "#f8fafc", border: "#64748b", text: "#334155", badge: "#64748b" }
};

/**
 * Consulta o link do grupo de WhatsApp para o Sub selecionado
 */
async function getSubWhatsAppLink(subName) {
  const subNorm = String(subName || "Geral").trim();
  const defaultLink = "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6";

  const { url, key } = getSupabaseCredentials();
  if (url && key && subNorm) {
    try {
      const res = await fetch(`${url}/rest/v1/configuracoes_whatsapp?sub=eq.${encodeURIComponent(subNorm)}&select=link_grupo,ativo&limit=1`, {
        headers: { "apikey": key, "Authorization": `Bearer ${key}` },
        signal: AbortSignal.timeout(2500)
      });
      if (res.ok) {
        const rows = await res.json();
        if (rows && rows.length > 0 && rows[0].ativo && rows[0].link_grupo) {
          return rows[0].link_grupo;
        }
      }
    } catch (e) {}
  }

  // Fallback do store local
  try {
    const store = settingsStore.loadLocalStore();
    if (store.whatsapp && store.whatsapp[subNorm] && store.whatsapp[subNorm].link) {
      return store.whatsapp[subNorm].link;
    }
  } catch (e) {}

  return defaultLink;
}

/**
 * Gera um código de autenticidade/validação único baseado no TXID e data
 */
function gerarCodigoAutenticidade(txid, dataIso) {
  const base = `${txid || "EJC"}-${dataIso || Date.now()}`;
  let hash = 0;
  for (let i = 0; i < base.length; i++) {
    hash = ((hash << 5) - hash) + base.charCodeAt(i);
    hash |= 0;
  }
  const hex = Math.abs(hash).toString(16).toUpperCase().padStart(8, "0");
  const prefix = String(txid || "").replace(/\D/g, "").slice(-4) || "2026";
  return `EJC-${hex.slice(0, 4)}-${hex.slice(4, 8)}-${prefix}`;
}

// ==============================================================================
// 1. GERADOR DO COMPROVANTE / RECIBO OFICIAL PRÓPRIO DO EJC (HTML RESPONSIVO)
// ==============================================================================
function buildEJCReceiptHtml({
  txid,
  orderId,
  paymentId,
  nome,
  email,
  whatsapp,
  valor,
  valorOriginal,
  desconto,
  metodo,
  modalidadePix,
  lote,
  sub,
  categoria,
  dataHora,
  whatsappLink,
  origemAprovacao // 'api_gateway' | 'manual_coordenacao'
}) {
  const nomeLimpo = String(nome || "Participante").trim();
  const subNome = String(sub || "Geral").trim();
  const subStyle = SUB_COLORS[subNome] || SUB_COLORS["Geral"];

  const valorNum = Number(valor || 50);
  const valorFormatado = valorNum.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

  const valorOrigNum = Number(valorOriginal || valorNum);
  const valorOrigFormatado = valorOrigNum.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

  const descontoNum = Number(desconto || (valorOrigNum > valorNum ? valorOrigNum - valorNum : 0));
  const temDesconto = descontoNum > 0;
  const descontoFormatado = descontoNum.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

  const metodoTexto = (metodo === "credit_card") ? "Cartão de Crédito" : "Pix Instantâneo";
  const loteTexto = lote || "1º Lote Oficial";
  const categoriaTexto = categoria || "Inscrição Oficial — Equipe do Trânsito";
  const dataFormatada = dataHora || new Date().toLocaleString("pt-BR", { timeZone: "America/Fortaleza" });
  const codigoAutenticidade = gerarCodigoAutenticidade(txid, dataFormatada);

  // Texto contextual de conformidade para a modalidade
  const isPixManual = (modalidadePix === "manual" || origemAprovacao === "manual_coordenacao");
  const notaModalidade = isPixManual
    ? "Pagamento confirmado pelo EJC após análise e validação do comprovante enviado."
    : "Pagamento confirmado automaticamente através do processamento do gateway oficial.";

  const badgeModalidade = isPixManual
    ? "Pix Direto (Validado pela Coordenação)"
    : "Pix Dinâmico Oficial (Mercado Pago)";

  return `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Comprovante Oficial EJC - ${txid}</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      background-color: #f1f5f9;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      color: #0f172a;
      -webkit-font-smoothing: antialiased;
    }
    table { border-collapse: collapse; }
    .email-wrapper {
      width: 100%;
      background-color: #f1f5f9;
      padding: 30px 12px;
    }
    .email-container {
      max-width: 600px;
      margin: 0 auto;
      background: #ffffff;
      border-radius: 20px;
      overflow: hidden;
      box-shadow: 0 12px 36px rgba(2, 50, 132, 0.08);
      border: 1px solid #e2e8f0;
    }
    .header-ejc {
      background: linear-gradient(135deg, #023284 0%, #087df9 100%);
      padding: 32px 24px;
      text-align: center;
      color: #ffffff;
    }
    .header-ejc h1 {
      margin: 0;
      font-size: 22px;
      font-weight: 800;
      letter-spacing: -0.5px;
      color: #ffffff;
      text-transform: uppercase;
    }
    .header-ejc .sub-title {
      margin: 6px 0 0;
      font-size: 13px;
      color: #fcc002;
      font-weight: 700;
      letter-spacing: 1px;
      text-transform: uppercase;
    }
    .badge-status {
      display: inline-block;
      background: #ecfdf5;
      color: #047857;
      border: 1px solid #a7f3d0;
      padding: 6px 16px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 800;
      letter-spacing: 0.5px;
      margin-top: 14px;
    }
    .content {
      padding: 28px 24px;
    }
    .salutation {
      font-size: 18px;
      font-weight: 700;
      color: #023284;
      margin: 0 0 8px;
    }
    .intro-p {
      color: #475569;
      font-size: 14px;
      line-height: 1.6;
      margin: 0 0 20px;
    }
    /* CARD DO RECIBO CRIATIVO */
    .receipt-card {
      background: #ffffff;
      border: 2px solid #023284;
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 8px 24px rgba(2, 50, 132, 0.06);
      margin-bottom: 24px;
    }
    .receipt-header {
      background: #023284;
      color: #ffffff;
      padding: 14px 18px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .receipt-header .title {
      font-size: 13px;
      font-weight: 800;
      letter-spacing: 1px;
      text-transform: uppercase;
      color: #ffffff;
    }
    .receipt-header .badge-auth {
      background: #fcc002;
      color: #023284;
      font-size: 11px;
      font-weight: 800;
      padding: 3px 8px;
      border-radius: 6px;
      text-transform: uppercase;
    }
    .receipt-body {
      padding: 20px 18px;
    }
    .receipt-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 9px 0;
      border-bottom: 1px solid #f1f5f9;
      font-size: 13px;
    }
    .receipt-row:last-child {
      border-bottom: none;
    }
    .receipt-label {
      color: #64748b;
      font-weight: 500;
    }
    .receipt-value {
      font-weight: 700;
      color: #0f172a;
      text-align: right;
    }
    .receipt-sub-badge {
      display: inline-block;
      padding: 3px 10px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 800;
      background: ${subStyle.bg};
      color: ${subStyle.text};
      border: 1px solid ${subStyle.border};
    }
    .total-box {
      background: #f8fafc;
      border-radius: 12px;
      padding: 14px;
      margin-top: 14px;
      border: 1px solid #e2e8f0;
    }
    .total-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .total-amount {
      font-size: 22px;
      font-weight: 900;
      color: #047857;
    }
    .authenticity-box {
      background: #f8fafc;
      border-top: 1px dashed #cbd5e1;
      padding: 12px 18px;
      font-size: 11px;
      color: #64748b;
      text-align: center;
      line-height: 1.5;
    }
    .authenticity-code {
      font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
      font-weight: 700;
      color: #023284;
      font-size: 12px;
      letter-spacing: 1px;
    }
    .btn-whatsapp {
      display: block;
      background: #25d366;
      color: #ffffff !important;
      text-decoration: none;
      font-weight: 800;
      font-size: 15px;
      text-align: center;
      padding: 14px 20px;
      border-radius: 12px;
      margin: 20px 0;
      box-shadow: 0 4px 14px rgba(37, 211, 102, 0.3);
    }
    .footer {
      background: #091026;
      color: #94a3b8;
      padding: 24px;
      text-align: center;
      font-size: 12px;
      line-height: 1.6;
    }
    .footer strong { color: #ffffff; }
  </style>
</head>
<body>
  <div class="email-wrapper">
    <div class="email-container">
      <!-- CABEÇALHO INSTITUCIONAL -->
      <div class="header-ejc">
        <h1>EJC — Equipe do Trânsito</h1>
        <div class="sub-title">IEAD Monte Sião • Campina Grande - PB</div>
        <div>
          <span class="badge-status">✓ Pagamento Confirmado</span>
        </div>
      </div>

      <!-- CORPO PRINCIPAL -->
      <div class="content">
        <div class="salutation">Olá, ${nomeLimpo}!</div>
        <p class="intro-p">
          Sua inscrição na <strong>Equipe do Trânsito</strong> do Encontro de Jovens com Cristo foi confirmada e validada com sucesso pelo nosso sistema!
        </p>

        <!-- COMPROVANTE / RECIBO CRIATIVO DO EJC -->
        <div class="receipt-card">
          <div class="receipt-header">
            <span class="title">Recibo Oficial de Pagamento</span>
            <span class="badge-auth">EJC 2026</span>
          </div>

          <div class="receipt-body">
            <div class="receipt-row">
              <span class="receipt-label">Participante:</span>
              <span class="receipt-value">${nomeLimpo}</span>
            </div>
            <div class="receipt-row">
              <span class="receipt-label">E-mail:</span>
              <span class="receipt-value" style="color: #087df9;">${email || "-"}</span>
            </div>
            ${whatsapp ? `
            <div class="receipt-row">
              <span class="receipt-label">WhatsApp:</span>
              <span class="receipt-value">${whatsapp}</span>
            </div>` : ""}
            <div class="receipt-row">
              <span class="receipt-label">Sub Grupo:</span>
              <span class="receipt-value">
                <span class="receipt-sub-badge">Sub ${subNome}</span>
              </span>
            </div>
            <div class="receipt-row">
              <span class="receipt-label">Lote / Inscrição:</span>
              <span class="receipt-value">${loteTexto}</span>
            </div>
            <div class="receipt-row">
              <span class="receipt-label">Forma de Pagamento:</span>
              <span class="receipt-value">${metodoTexto}</span>
            </div>
            <div class="receipt-row">
              <span class="receipt-label">Modalidade:</span>
              <span class="receipt-value" style="font-size: 12px;">${badgeModalidade}</span>
            </div>
            <div class="receipt-row">
              <span class="receipt-label">Número do Pedido:</span>
              <span class="receipt-value" style="font-family: monospace;">${orderId || txid}</span>
            </div>
            <div class="receipt-row">
              <span class="receipt-label">Identificador (TXID):</span>
              <span class="receipt-value" style="font-family: monospace; font-size: 11px;">${txid}</span>
            </div>
            <div class="receipt-row">
              <span class="receipt-label">Data e Hora:</span>
              <span class="receipt-value">${dataFormatada}</span>
            </div>

            <!-- RESUMO FINANCEIRO -->
            <div class="total-box">
              ${temDesconto ? `
              <div class="receipt-row" style="padding: 4px 0;">
                <span class="receipt-label">Valor Original:</span>
                <span class="receipt-value" style="text-decoration: line-through; color: #94a3b8;">${valorOrigFormatado}</span>
              </div>
              <div class="receipt-row" style="padding: 4px 0;">
                <span class="receipt-label">Desconto Aplicado:</span>
                <span class="receipt-value" style="color: #047857;">- ${descontoFormatado}</span>
              </div>` : ""}
              <div class="total-row" style="padding-top: 6px;">
                <span style="font-weight: 800; font-size: 14px; color: #023284;">VALOR LÍQUIDO PAGO:</span>
                <span class="total-amount">${valorFormatado}</span>
              </div>
            </div>
          </div>

          <!-- AUTENTICIDADE E NOTA INSTITUCIONAL -->
          <div class="authenticity-box">
            <div style="margin-bottom: 4px;">
              <strong>Código de Autenticidade:</strong> <span class="authenticity-code">${codigoAutenticidade}</span>
            </div>
            <div style="font-size: 11px; color: #475569;">
              ${notaModalidade}
            </div>
          </div>
        </div>

        <!-- GRUPO DO WHATSAPP -->
        ${whatsappLink ? `
        <div style="text-align: center; margin: 20px 0 10px;">
          <p style="margin: 0 0 10px; font-weight: 700; color: #023284; font-size: 14px;">
            ⚠️ Importante: Entre agora no Grupo Oficial do WhatsApp da sua Sub!
          </p>
          <a href="${whatsappLink}" class="btn-whatsapp" target="_blank">
            👉 Entrar no Grupo do WhatsApp (Sub ${subNome})
          </a>
        </div>` : ""}

        <p style="color: #64748b; font-size: 12px; line-height: 1.5; margin: 20px 0 0; text-align: center;">
          Guarde este e-mail como recibo oficial de inscrição. Em caso de dúvidas, procure os coordenadores da Equipe do Trânsito.
        </p>
      </div>

      <!-- RODAPÉ INSTITUCIONAL -->
      <div class="footer">
        <p style="margin: 0 0 6px;"><strong>EJC Trânsito Monte Sião</strong></p>
        <p style="margin: 0 0 6px;">Igreja Evangélica Assembleia de Deus — Monte Sião</p>
        <p style="margin: 0; color: #64748b;">Campina Grande - PB • Servindo com excelência e amor ao Reino. ❤️</p>
      </div>
    </div>
  </div>
</body>
</html>
  `.trim();
}

// ==============================================================================
// 2. TEMPLATES DE E-MAIL TRANSACIONAIS (8 EVENTOS)
// ==============================================================================

/**
 * Evento 1: Pedido Criado / Pix Iniciado (NÃO afirma que está pago)
 */
function buildOrderCreatedHtml({ txid, orderId, nome, valor, payloadPix, lote, sub }) {
  const nomeLimpo = String(nome || "Participante").trim();
  const valorFormatado = Number(valor || 50).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

  return `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <title>EJC — Seu pagamento foi iniciado</title>
  <style>
    body { margin:0; padding:20px; font-family: 'Inter', sans-serif; background: #f8fafc; color: #1e293b; }
    .card { max-width: 580px; margin: 0 auto; background: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; overflow: hidden; }
    .header { background: #023284; color: #ffffff; padding: 24px; text-align: center; }
    .header h1 { margin: 0; font-size: 20px; text-transform: uppercase; }
    .body { padding: 24px; }
    .code-box { background: #f1f5f9; border: 1px solid #cbd5e1; border-radius: 8px; padding: 12px; font-family: monospace; word-break: break-all; font-size: 12px; margin: 16px 0; }
    .footer { background: #0b1120; color: #94a3b8; padding: 16px; text-align: center; font-size: 11px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h1>EJC — Equipe do Trânsito</h1>
      <p style="margin: 4px 0 0; color: #fcc002; font-size: 13px; font-weight: bold;">PAGAMENTO INICIADO • AGUARDANDO PAGAMENTO</p>
    </div>
    <div class="body">
      <h2 style="font-size: 18px; color: #023284; margin-top: 0;">Olá, ${nomeLimpo}!</h2>
      <p style="font-size: 14px; line-height: 1.5; color: #475569;">
        Seu pedido de inscrição para a <strong>Equipe do Trânsito (${lote || "1º Lote"})</strong> foi gerado com sucesso.
      </p>
      <div style="background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 10px; padding: 14px; margin: 16px 0;">
        <div style="font-size: 13px; color: #1e40af;"><strong>Identificador do Pedido:</strong> ${orderId || txid}</div>
        <div style="font-size: 16px; color: #1e3a8a; margin-top: 6px;"><strong>Valor da Inscrição:</strong> ${valorFormatado}</div>
        <div style="font-size: 13px; color: #1e40af; margin-top: 4px;"><strong>Sub Equipe:</strong> Sub ${sub || "Geral"}</div>
      </div>
      <p style="font-size: 13px; color: #64748b;">
        Para concluir e garantir a sua vaga, abra o aplicativo do seu banco e utilize o código Pix Copia e Cola abaixo:
      </p>
      <div class="code-box">${payloadPix || txid}</div>
      <p style="font-size: 12px; color: #ef4444; font-weight: 700;">
        ⚠️ Atenção: A sua vaga só estará confirmada após a liquidação do pagamento pelo banco.
      </p>
    </div>
    <div class="footer">
      EJC Trânsito Monte Sião — IEAD Monte Sião • Campina Grande - PB
    </div>
  </div>
</body>
</html>
  `.trim();
}

/**
 * Evento 3: Pagamento Rejeitado ou Cancelado pelo Gateway
 */
function buildPaymentRejectedHtml({ txid, nome, valor, motivo }) {
  const nomeLimpo = String(nome || "Participante").trim();
  const valorFormatado = Number(valor || 50).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

  return `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <title>EJC — Atualização sobre seu pagamento</title>
  <style>
    body { margin:0; padding:20px; font-family: 'Inter', sans-serif; background: #f8fafc; color: #1e293b; }
    .card { max-width: 580px; margin: 0 auto; background: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; overflow: hidden; }
    .header { background: #991b1b; color: #ffffff; padding: 24px; text-align: center; }
    .body { padding: 24px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h1 style="margin:0; font-size: 20px; text-transform: uppercase;">EJC — Equipe do Trânsito</h1>
      <p style="margin:4px 0 0; color: #fecaca; font-size: 13px; font-weight: bold;">PAGAMENTO NÃO CONFIRMADO</p>
    </div>
    <div class="body">
      <h2 style="font-size: 18px; color: #991b1b; margin-top:0;">Olá, ${nomeLimpo}!</h2>
      <p style="font-size: 14px; line-height: 1.5; color: #475569;">
        Informamos que a tentativa de pagamento no valor de <strong>${valorFormatado}</strong> (Ref: <code>${txid}</code>) não pôde ser confirmada pelo sistema bancário.
      </p>
      ${motivo ? `<div style="background: #fef2f2; border: 1px solid #fecaca; padding: 12px; border-radius: 8px; color: #991b1b; font-size: 13px; margin: 14px 0;"><strong>Motivo:</strong> ${motivo}</div>` : ""}
      <p style="font-size: 13px; color: #64748b;">
        Você pode acessar o site do EJC e gerar uma nova tentativa de pagamento a qualquer momento.
      </p>
    </div>
  </div>
</body>
</html>
  `.trim();
}

/**
 * Evento 4: Comprovante Manual Recebido (Aguardando Análise)
 */
function buildManualProofReceivedHtml({ txid, nome, valor, sub }) {
  const nomeLimpo = String(nome || "Participante").trim();
  const valorFormatado = Number(valor || 50).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

  return `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <title>EJC — Comprovante recebido para análise</title>
  <style>
    body { margin:0; padding:20px; font-family: 'Inter', sans-serif; background: #f8fafc; color: #1e293b; }
    .card { max-width: 580px; margin: 0 auto; background: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; overflow: hidden; }
    .header { background: #023284; color: #ffffff; padding: 24px; text-align: center; }
    .body { padding: 24px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h1 style="margin:0; font-size: 20px; text-transform: uppercase;">EJC — Equipe do Trânsito</h1>
      <p style="margin:4px 0 0; color: #fcc002; font-size: 13px; font-weight: bold;">COMPROVANTE EM ANÁLISE</p>
    </div>
    <div class="body">
      <h2 style="font-size: 18px; color: #023284; margin-top:0;">Olá, ${nomeLimpo}!</h2>
      <p style="font-size: 14px; line-height: 1.5; color: #475569;">
        Recebemos o anexo do seu comprovante de transferência Pix no valor de <strong>${valorFormatado}</strong> para a <strong>Sub ${sub || "Equipe"}</strong> (Ref: <code>${txid}</code>).
      </p>
      <div style="background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 8px; padding: 12px; margin: 16px 0; font-size: 13px; color: #065f46;">
        <i class="fa-solid fa-clock"></i> <strong>Status atual:</strong> Aguardando análise pela coordenação financeira do EJC.
      </div>
      <p style="font-size: 13px; color: #64748b; line-height: 1.5;">
        Nossa equipe fará a conferência dos dados em até 24 horas. Assim que o pagamento for aprovado, você receberá o <strong>Recibo Oficial do EJC</strong> e o link do grupo do WhatsApp neste mesmo e-mail.
      </p>
    </div>
  </div>
</body>
</html>
  `.trim();
}

/**
 * Evento 5: Alerta Administrativo de Novo Comprovante Manual para Análise
 */
function buildAdminManualProofAlertHtml({ txid, nome, email, whatsapp, valor, sub, comprovanteUrl }) {
  const valorFormatado = Number(valor || 50).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

  return `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <title>EJC Admin — Novo comprovante aguardando análise</title>
  <style>
    body { margin:0; padding:20px; font-family: 'Inter', sans-serif; background: #f8fafc; color: #1e293b; }
    .card { max-width: 580px; margin: 0 auto; background: #ffffff; border-radius: 16px; border: 2px solid #023284; overflow: hidden; }
    .header { background: #023284; color: #ffffff; padding: 20px; text-align: center; }
    .body { padding: 24px; }
    .row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f1f5f9; font-size: 13px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h2 style="margin:0; font-size: 18px; color: #fcc002;">PAINEL FINANCEIRO EJC</h2>
      <p style="margin:4px 0 0; color: #ffffff; font-size: 13px;">Novo Comprovante Pix Manual Recebido</p>
    </div>
    <div class="body">
      <p style="font-size: 14px; color: #334155;">Um participante enviou um comprovante de transferência que requer conferência:</p>
      <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 14px; margin: 16px 0;">
        <div class="row"><span>Participante:</span><strong>${nome}</strong></div>
        <div class="row"><span>E-mail:</span><strong>${email}</strong></div>
        ${whatsapp ? `<div class="row"><span>WhatsApp:</span><strong>${whatsapp}</strong></div>` : ""}
        <div class="row"><span>Sub Equipe:</span><strong>Sub ${sub || "Geral"}</strong></div>
        <div class="row"><span>Valor Declarado:</span><strong style="color:#047857; font-size: 15px;">${valorFormatado}</strong></div>
        <div class="row"><span>TXID / Referência:</span><code>${txid}</code></div>
      </div>
      ${comprovanteUrl ? `
      <div style="margin: 16px 0; text-align: center;">
        <a href="${comprovanteUrl}" target="_blank" style="display: inline-block; background: #023284; color: #ffffff; padding: 10px 18px; border-radius: 8px; text-decoration: none; font-weight: 700; font-size: 13px;">
          🔍 Abrir Imagem do Comprovante
        </a>
      </div>` : ""}
      <p style="font-size: 12px; color: #64748b; text-align: center; margin-top: 16px;">
        Acesse o painel administrativo na aba <strong>Financeiro</strong> para aprovar ou rejeitar este comprovante.
      </p>
    </div>
  </div>
</body>
</html>
  `.trim();
}

/**
 * Evento 7: Comprovante Manual Rejeitado pelo Administrador
 */
function buildManualProofRejectedHtml({ txid, nome, motivo }) {
  const nomeLimpo = String(nome || "Participante").trim();

  return `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <title>EJC — Atualização sobre seu comprovante</title>
  <style>
    body { margin:0; padding:20px; font-family: 'Inter', sans-serif; background: #f8fafc; color: #1e293b; }
    .card { max-width: 580px; margin: 0 auto; background: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; overflow: hidden; }
    .header { background: #991b1b; color: #ffffff; padding: 24px; text-align: center; }
    .body { padding: 24px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h1 style="margin:0; font-size: 20px; text-transform: uppercase;">EJC — Equipe do Trânsito</h1>
      <p style="margin:4px 0 0; color: #fecaca; font-size: 13px; font-weight: bold;">COMPROVANTE NÃO APROVADO</p>
    </div>
    <div class="body">
      <h2 style="font-size: 18px; color: #991b1b; margin-top:0;">Olá, ${nomeLimpo}!</h2>
      <p style="font-size: 14px; line-height: 1.5; color: #475569;">
        O comprovante enviado para o pedido <code>${txid}</code> foi analisado pela coordenação financeira e não pôde ser aprovado.
      </p>
      <div style="background: #fef2f2; border: 1px solid #fecaca; padding: 14px; border-radius: 8px; color: #991b1b; font-size: 13px; margin: 16px 0;">
        <strong>Justificativa da Coordenação:</strong><br>
        ${motivo || "Arquivo ilegível, valor divergente ou comprovante não correspondente à conta oficial do EJC."}
      </div>
      <p style="font-size: 13px; color: #64748b; line-height: 1.5;">
        Por favor, acesse novamente o site do EJC para anexar o comprovante legível ou entre em contato diretamente com a coordenação da sua Sub.
      </p>
    </div>
  </div>
</body>
</html>
  `.trim();
}

// ==============================================================================
// 3. IDEMPOTÊNCIA E AUDITORIA
// ==============================================================================

/**
 * Verifica se um evento de e-mail já foi despachado para a transação
 */
function isEventAlreadySent(paymentRecord, eventType) {
  if (!paymentRecord) return false;

  // 1. Verificação em comprovante_email_enviado para aprovação geral
  if (eventType === "payment_approved" || eventType === "manual_proof_approved") {
    if (paymentRecord.comprovante_email_enviado === true) {
      return true;
    }
  }

  // 2. Verificação no array metadata.emails_enviados
  const emailsEnviados = paymentRecord.metadata?.emails_enviados;
  if (Array.isArray(emailsEnviados)) {
    return emailsEnviados.some(e => e.evento === eventType && e.sucesso === true);
  }

  return false;
}

/**
 * Registra o disparo de e-mail no registro da transação (Supabase + Local Store)
 */
async function recordEmailDispatch({ txid, eventType, result, recipientEmail }) {
  const agora = new Date().toISOString();
  const emailLogItem = {
    evento: eventType,
    destinatario: recipientEmail,
    sucesso: Boolean(result.success),
    messageId: result.messageId || null,
    erro: result.error || null,
    data: agora
  };

  const { url, key } = getSupabaseCredentials();

  // 1. Atualiza no Supabase
  if (url && key && txid) {
    try {
      const isApprovedEvent = (eventType === "payment_approved" || eventType === "manual_proof_approved");
      const patchPayload = {
        atualizado_em: agora
      };

      if (isApprovedEvent && result.success) {
        patchPayload.comprovante_email_enviado = true;
        patchPayload.comprovante_email_em = agora;
        patchPayload.comprovante_email_erro = null;
      } else if (isApprovedEvent && !result.success) {
        patchPayload.comprovante_email_erro = String(result.error || "Falha no envio").slice(0, 255);
      }

      await fetch(`${url}/rest/v1/pagamentos?txid=eq.${encodeURIComponent(txid)}`, {
        method: "PATCH",
        headers: { "apikey": key, "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(patchPayload)
      });

      // Registra na tabela de auditoria
      await fetch(`${url}/rest/v1/auditoria_transacoes`, {
        method: "POST",
        headers: { "apikey": key, "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          transacao_id: txid,
          acao: `email_${eventType}`,
          status_anterior: null,
          status_novo: result.success ? "enviado" : "falha",
          executado_por: "brevo_email_service",
          detalhes: emailLogItem
        })
      }).catch(() => {});
    } catch (dbErr) {
      console.warn("[EmailService recordEmailDispatch] Supabase sync erro:", dbErr.message);
    }
  }

  // 2. Atualiza no Store Local
  try {
    const localStore = settingsStore.loadLocalStore();
    if (Array.isArray(localStore.pagamentos)) {
      const idx = localStore.pagamentos.findIndex(p => p.txid === txid);
      if (idx !== -1) {
        if (!localStore.pagamentos[idx].metadata) localStore.pagamentos[idx].metadata = {};
        if (!Array.isArray(localStore.pagamentos[idx].metadata.emails_enviados)) {
          localStore.pagamentos[idx].metadata.emails_enviados = [];
        }
        localStore.pagamentos[idx].metadata.emails_enviados.push(emailLogItem);

        if (eventType === "payment_approved" || eventType === "manual_proof_approved") {
          if (result.success) {
            localStore.pagamentos[idx].comprovante_email_enviado = true;
            localStore.pagamentos[idx].comprovante_email_em = agora;
            localStore.pagamentos[idx].comprovante_email_erro = null;
          } else {
            localStore.pagamentos[idx].comprovante_email_erro = String(result.error || "Falha").slice(0, 255);
          }
        }
        settingsStore.saveLocalStore(localStore);
      }
    }
  } catch (localErr) {
    console.warn("[EmailService recordEmailDispatch] Local store erro:", localErr.message);
  }
}

// ==============================================================================
// 4. MÉTODOS DE DISPARO TRANSACIONAIS
// ==============================================================================

/**
 * Dispara e-mail de Pedido Criado / Pix Iniciado
 */
async function sendOrderCreatedEmail({ paymentRecord, payloadPix }) {
  if (!paymentRecord || !paymentRecord.email) return { success: false, error: "E-mail ou registro ausente." };

  if (isEventAlreadySent(paymentRecord, "order_created")) {
    return { success: true, already_sent: true, message: "E-mail de pedido criado já disparado." };
  }

  const html = buildOrderCreatedHtml({
    txid: paymentRecord.txid,
    orderId: paymentRecord.order_id || paymentRecord.metadata?.order_id || paymentRecord.txid,
    nome: paymentRecord.nome_pagador,
    valor: paymentRecord.valor,
    payloadPix: payloadPix || paymentRecord.pix_copia_e_cola,
    lote: paymentRecord.metadata?.lote || "1º Lote",
    sub: paymentRecord.metadata?.sub || paymentRecord.sub
  });

  const res = await brevoProvider.sendEmail({
    to: paymentRecord.email,
    toName: paymentRecord.nome_pagador,
    subject: "EJC — Seu pagamento foi iniciado ⏳",
    htmlContent: html,
    tags: ["ejc", "pix_iniciado", "order_created"]
  });

  await recordEmailDispatch({
    txid: paymentRecord.txid,
    eventType: "order_created",
    result: res,
    recipientEmail: paymentRecord.email
  });

  return res;
}

/**
 * Dispara e-mail de Pagamento Aprovado com o COMPROVANTE/RECIBO OFICIAL EJC
 */
async function sendPaymentApprovedEmail({ paymentRecord, forceResend = false, origemAprovacao = "api_gateway" }) {
  if (!paymentRecord || !paymentRecord.email) return { success: false, error: "E-mail ou registro ausente." };

  const eventKey = (origemAprovacao === "manual_coordenacao") ? "manual_proof_approved" : "payment_approved";

  if (!forceResend && isEventAlreadySent(paymentRecord, eventKey)) {
    console.log(`[EmailService] Recibo já enviado anteriormente para ${paymentRecord.txid} (idempotência).`);
    return { success: true, already_sent: true, message: "Recibo já enviado anteriormente." };
  }

  const subName = paymentRecord.metadata?.sub || paymentRecord.sub || "Geral";
  const whatsappLink = await getSubWhatsAppLink(subName);

  const receiptHtml = buildEJCReceiptHtml({
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
    origemAprovacao: origemAprovacao
  });

  const subject = (origemAprovacao === "manual_coordenacao")
    ? "EJC — Comprovante aprovado e inscrição confirmada! ✅"
    : "EJC — Pagamento confirmado ✅";

  const res = await brevoProvider.sendEmail({
    to: paymentRecord.email,
    toName: paymentRecord.nome_pagador,
    subject: subject,
    htmlContent: receiptHtml,
    tags: ["ejc", "recibo_oficial", eventKey]
  });

  await recordEmailDispatch({
    txid: paymentRecord.txid,
    eventType: eventKey,
    result: res,
    recipientEmail: paymentRecord.email
  });

  return res;
}

/**
 * Dispara e-mail quando o cliente anexa comprovante no Pix Manual
 */
async function sendManualProofReceivedEmail({ paymentRecord }) {
  if (!paymentRecord || !paymentRecord.email) return { success: false, error: "E-mail ou registro ausente." };

  if (isEventAlreadySent(paymentRecord, "manual_proof_received")) {
    return { success: true, already_sent: true };
  }

  const html = buildManualProofReceivedHtml({
    txid: paymentRecord.txid,
    nome: paymentRecord.nome_pagador,
    valor: paymentRecord.valor,
    sub: paymentRecord.metadata?.sub || paymentRecord.sub
  });

  const res = await brevoProvider.sendEmail({
    to: paymentRecord.email,
    toName: paymentRecord.nome_pagador,
    subject: "EJC — Comprovante recebido para análise 📄",
    htmlContent: html,
    tags: ["ejc", "manual_proof_received"]
  });

  await recordEmailDispatch({
    txid: paymentRecord.txid,
    eventType: "manual_proof_received",
    result: res,
    recipientEmail: paymentRecord.email
  });

  return res;
}

/**
 * Dispara e-mail de alerta para o Admin/Coordenação sobre novo comprovante manual
 */
async function sendAdminManualProofAlertEmail({ paymentRecord, comprovanteUrl }) {
  if (!paymentRecord) return { success: false, error: "Registro ausente." };

  const adminEmail = brevoProvider.getAdminEmail();
  if (!adminEmail) return { success: false, error: "E-mail do administrador não configurado." };

  const html = buildAdminManualProofAlertHtml({
    txid: paymentRecord.txid,
    nome: paymentRecord.nome_pagador || "Participante",
    email: paymentRecord.email,
    whatsapp: paymentRecord.whatsapp_pagador,
    valor: paymentRecord.valor,
    sub: paymentRecord.metadata?.sub || paymentRecord.sub,
    comprovanteUrl: comprovanteUrl || paymentRecord.comprovante_caminho || paymentRecord.metadata?.comprovante_url
  });

  const res = await brevoProvider.sendEmail({
    to: adminEmail,
    toName: "Coordenação Financeira EJC",
    subject: `🔔 EJC Admin — Novo comprovante Pix: ${paymentRecord.nome_pagador || paymentRecord.txid}`,
    htmlContent: html,
    tags: ["ejc", "admin_alert"]
  });

  await recordEmailDispatch({
    txid: paymentRecord.txid,
    eventType: "admin_manual_proof_alert",
    result: res,
    recipientEmail: adminEmail
  });

  return res;
}

/**
 * Dispara e-mail de Comprovante Manual Rejeitado pelo Administrador
 */
async function sendManualProofRejectedEmail({ paymentRecord, motivo }) {
  if (!paymentRecord || !paymentRecord.email) return { success: false, error: "E-mail ou registro ausente." };

  const html = buildManualProofRejectedHtml({
    txid: paymentRecord.txid,
    nome: paymentRecord.nome_pagador,
    motivo: motivo
  });

  const res = await brevoProvider.sendEmail({
    to: paymentRecord.email,
    toName: paymentRecord.nome_pagador,
    subject: "EJC — Atualização sobre seu comprovante Pix ⚠️",
    htmlContent: html,
    tags: ["ejc", "manual_proof_rejected"]
  });

  await recordEmailDispatch({
    txid: paymentRecord.txid,
    eventType: "manual_proof_rejected",
    result: res,
    recipientEmail: paymentRecord.email
  });

  return res;
}

/**
 * Dispara e-mail de Pagamento Rejeitado no Gateway
 */
async function sendPaymentRejectedEmail({ paymentRecord, motivo }) {
  if (!paymentRecord || !paymentRecord.email) return { success: false, error: "E-mail ou registro ausente." };

  const html = buildPaymentRejectedHtml({
    txid: paymentRecord.txid,
    nome: paymentRecord.nome_pagador,
    valor: paymentRecord.valor,
    motivo: motivo
  });

  const res = await brevoProvider.sendEmail({
    to: paymentRecord.email,
    toName: paymentRecord.nome_pagador,
    subject: "EJC — Atualização sobre seu pagamento ⚠️",
    htmlContent: html,
    tags: ["ejc", "payment_rejected"]
  });

  await recordEmailDispatch({
    txid: paymentRecord.txid,
    eventType: "payment_rejected",
    result: res,
    recipientEmail: paymentRecord.email
  });

  return res;
}

module.exports = {
  buildEJCReceiptHtml,
  sendOrderCreatedEmail,
  sendPaymentApprovedEmail,
  sendPaymentRejectedEmail,
  sendManualProofReceivedEmail,
  sendAdminManualProofAlertEmail,
  sendManualProofRejectedEmail,
  isEventAlreadySent,
  recordEmailDispatch,
  getSubWhatsAppLink
};
