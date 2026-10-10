// ==============================================================================
// SUPABASE EDGE FUNCTION: send-email
// Envio transacional de e-mails do EJC com idempotência concorrente atômica
// Integração oficial via Brevo API v3 (headers.idempotencyKey UUID)
// Secrets: BREVO_API_KEY_EJC_EDGE, SUPABASE_SERVICE_ROLE_KEY
// ==============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ------------------------------------------------------------------------------
// 1. CONFIGURAÇÕES E ESTILOS VISUAIS OFICIAIS
// ------------------------------------------------------------------------------
const SUB_COLORS: Record<string, { bg: string; border: string; text: string; badge: string }> = {
  "Verde": { bg: "#ecfdf5", border: "#10b981", text: "#065f46", badge: "#10b981" },
  "Vermelho": { bg: "#fef2f2", border: "#ef4444", text: "#991b1b", badge: "#ef4444" },
  "Amarelo": { bg: "#fffbeb", border: "#f59e0b", text: "#92400e", badge: "#f59e0b" },
  "Laranja": { bg: "#fff7ed", border: "#f97316", text: "#9a3412", badge: "#f97316" },
  "Azul": { bg: "#fff7ed", border: "#f97316", text: "#9a3412", badge: "#f97316" },
  "Geral": { bg: "#f8fafc", border: "#64748b", text: "#334155", badge: "#64748b" }
};

function gerarCodigoAutenticidade(txid: string, dataIso?: string): string {
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

// ------------------------------------------------------------------------------
// 2. TEMPLATES OFICIAIS PORTADOS DE API/_EMAIL-SERVICE.JS (100% FIÉIS)
// ------------------------------------------------------------------------------

function buildEJCReceiptHtml(p: {
  txid: string;
  orderId?: string;
  paymentId?: string;
  nome: string;
  email: string;
  whatsapp?: string;
  valor: number;
  valorOriginal?: number;
  desconto?: number;
  metodo?: string;
  modalidadePix?: string;
  lote?: string;
  sub: string;
  categoria?: string;
  dataHora?: string;
  whatsappLink?: string;
  origemAprovacao?: string;
}): string {
  const nomeLimpo = String(p.nome || "Participante").trim();
  const subNome = String(p.sub || "Geral").trim();
  const subStyle = SUB_COLORS[subNome] || SUB_COLORS["Geral"];

  const valorNum = Number(p.valor || 0);
  const valorFormatado = valorNum.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

  const valorOrigNum = Number(p.valorOriginal || valorNum);
  const valorOrigFormatado = valorOrigNum.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

  const descontoNum = Number(p.desconto || (valorOrigNum > valorNum ? valorOrigNum - valorNum : 0));
  const temDesconto = descontoNum > 0;
  const descontoFormatado = descontoNum.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

  const metodoTexto = (p.metodo === "credit_card") ? "Cartão de Crédito" : "Pix Instantâneo";
  const loteTexto = p.lote || "1º Lote Oficial";
  const dataFormatada = p.dataHora || new Date().toLocaleString("pt-BR", { timeZone: "America/Fortaleza" });
  const codigoAutenticidade = gerarCodigoAutenticidade(p.txid, dataFormatada);

  const isPixManual = (p.modalidadePix === "manual" || p.origemAprovacao === "manual_coordenacao");
  const notaModalidade = isPixManual
    ? "Pagamento confirmado pelo EJC após análise e validação do comprovante enviado."
    : "Pagamento confirmado automaticamente através do processamento do gateway oficial.";

  const badgeModalidade = isPixManual
    ? "Pix Direto (Validado pela Coordenação)"
    : "Pix Dinâmico Oficial (Mercado Pago)";

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Comprovante Oficial EJC - ${p.txid}</title>
  <style>
    body { margin: 0; padding: 0; background-color: #f1f5f9; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #0f172a; -webkit-font-smoothing: antialiased; }
    table { border-collapse: collapse; }
    .email-wrapper { width: 100%; background-color: #f1f5f9; padding: 30px 12px; }
    .email-container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 20px; overflow: hidden; box-shadow: 0 12px 36px rgba(2, 50, 132, 0.08); border: 1px solid #e2e8f0; }
    .header-ejc { background: linear-gradient(135deg, #023284 0%, #087df9 100%); padding: 32px 24px; text-align: center; color: #ffffff; }
    .header-ejc h1 { margin: 0; font-size: 22px; font-weight: 800; letter-spacing: -0.5px; color: #ffffff; text-transform: uppercase; }
    .header-ejc .sub-title { margin: 6px 0 0; font-size: 13px; color: #fcc002; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; }
    .badge-status { display: inline-block; background: #ecfdf5; color: #047857; border: 1px solid #a7f3d0; padding: 6px 16px; border-radius: 999px; font-size: 13px; font-weight: 800; letter-spacing: 0.5px; margin-top: 14px; }
    .content { padding: 28px 24px; }
    .salutation { font-size: 18px; font-weight: 700; color: #023284; margin: 0 0 8px; }
    .intro-p { color: #475569; font-size: 14px; line-height: 1.6; margin: 0 0 20px; }
    .receipt-card { background: #ffffff; border: 2px solid #023284; border-radius: 16px; overflow: hidden; box-shadow: 0 8px 24px rgba(2, 50, 132, 0.06); margin-bottom: 24px; }
    .receipt-header { background: #023284; color: #ffffff; padding: 14px 18px; display: flex; justify-content: space-between; align-items: center; }
    .receipt-header .title { font-size: 13px; font-weight: 800; letter-spacing: 1px; text-transform: uppercase; color: #ffffff; }
    .receipt-header .badge-auth { background: #fcc002; color: #023284; font-size: 11px; font-weight: 800; padding: 3px 8px; border-radius: 6px; text-transform: uppercase; }
    .receipt-body { padding: 20px 18px; }
    .receipt-row { display: flex; justify-content: space-between; align-items: center; padding: 9px 0; border-bottom: 1px solid #f1f5f9; font-size: 13px; }
    .receipt-row:last-child { border-bottom: none; }
    .receipt-label { color: #64748b; font-weight: 500; }
    .receipt-value { font-weight: 700; color: #0f172a; text-align: right; }
    .receipt-sub-badge { display: inline-block; padding: 3px 10px; border-radius: 6px; font-size: 12px; font-weight: 800; background: ${subStyle.bg}; color: ${subStyle.text}; border: 1px solid ${subStyle.border}; }
    .total-box { background: #f8fafc; border-radius: 12px; padding: 14px; margin-top: 14px; border: 1px solid #e2e8f0; }
    .total-row { display: flex; justify-content: space-between; align-items: center; }
    .total-amount { font-size: 22px; font-weight: 900; color: #047857; }
    .authenticity-box { background: #f8fafc; border-top: 1px dashed #cbd5e1; padding: 12px 18px; font-size: 11px; color: #64748b; text-align: center; line-height: 1.5; }
    .authenticity-code { font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; font-weight: 700; color: #023284; font-size: 12px; letter-spacing: 1px; }
    .btn-whatsapp { display: block; background: #25d366; color: #ffffff !important; text-decoration: none; font-weight: 800; font-size: 15px; text-align: center; padding: 14px 20px; border-radius: 12px; margin: 20px 0; box-shadow: 0 4px 14px rgba(37, 211, 102, 0.3); }
    .footer { background: #091026; color: #94a3b8; padding: 24px; text-align: center; font-size: 12px; line-height: 1.6; }
    .footer strong { color: #ffffff; }
  </style>
</head>
<body>
  <div class="email-wrapper">
    <div class="email-container">
      <div class="header-ejc">
        <h1>EJC — Equipe do Trânsito</h1>
        <div class="sub-title">IEAD Monte Sião • Campina Grande - PB</div>
        <div><span class="badge-status">✓ Pagamento Confirmado</span></div>
      </div>
      <div class="content">
        <div class="salutation">Olá, ${nomeLimpo}!</div>
        <p class="intro-p">Sua inscrição na <strong>Equipe do Trânsito</strong> do Encontro de Jovens com Cristo foi confirmada e validada com sucesso pelo nosso sistema!</p>
        <div class="receipt-card">
          <div class="receipt-header">
            <span class="title">Recibo Oficial de Pagamento</span>
            <span class="badge-auth">EJC 2026</span>
          </div>
          <div class="receipt-body">
            <div class="receipt-row"><span class="receipt-label">Participante:</span><span class="receipt-value">${nomeLimpo}</span></div>
            <div class="receipt-row"><span class="receipt-label">E-mail:</span><span class="receipt-value" style="color: #087df9;">${p.email || "-"}</span></div>
            ${p.whatsapp ? `<div class="receipt-row"><span class="receipt-label">WhatsApp:</span><span class="receipt-value">${p.whatsapp}</span></div>` : ""}
            <div class="receipt-row"><span class="receipt-label">Sub Grupo:</span><span class="receipt-value"><span class="receipt-sub-badge">Sub ${subNome}</span></span></div>
            <div class="receipt-row"><span class="receipt-label">Lote / Inscrição:</span><span class="receipt-value">${loteTexto}</span></div>
            <div class="receipt-row"><span class="receipt-label">Forma de Pagamento:</span><span class="receipt-value">${metodoTexto}</span></div>
            <div class="receipt-row"><span class="receipt-label">Modalidade:</span><span class="receipt-value" style="font-size: 12px;">${badgeModalidade}</span></div>
            <div class="receipt-row"><span class="receipt-label">Número do Pedido:</span><span class="receipt-value" style="font-family: monospace;">${p.orderId || p.txid}</span></div>
            <div class="receipt-row"><span class="receipt-label">Identificador (TXID):</span><span class="receipt-value" style="font-family: monospace; font-size: 11px;">${p.txid}</span></div>
            <div class="receipt-row"><span class="receipt-label">Data e Hora:</span><span class="receipt-value">${dataFormatada}</span></div>
            <div class="total-box">
              ${temDesconto ? `
              <div class="receipt-row" style="padding: 4px 0;"><span class="receipt-label">Valor Original:</span><span class="receipt-value" style="text-decoration: line-through; color: #94a3b8;">${valorOrigFormatado}</span></div>
              <div class="receipt-row" style="padding: 4px 0;"><span class="receipt-label">Desconto Aplicado:</span><span class="receipt-value" style="color: #047857;">- ${descontoFormatado}</span></div>` : ""}
              <div class="total-row" style="padding-top: 6px;"><span style="font-weight: 800; font-size: 14px; color: #023284;">VALOR LÍQUIDO PAGO:</span><span class="total-amount">${valorFormatado}</span></div>
            </div>
          </div>
          <div class="authenticity-box">
            <div style="margin-bottom: 4px;"><strong>Código de Autenticidade:</strong> <span class="authenticity-code">${codigoAutenticidade}</span></div>
            <div style="font-size: 11px; color: #475569;">${notaModalidade}</div>
          </div>
        </div>
        ${p.whatsappLink ? `
        <div style="text-align: center; margin: 20px 0 10px;">
          <p style="margin: 0 0 10px; font-weight: 700; color: #023284; font-size: 14px;">⚠️ Importante: Entre agora no Grupo Oficial do WhatsApp da sua Sub!</p>
          <a href="${p.whatsappLink}" class="btn-whatsapp" target="_blank">👉 Entrar no Grupo do WhatsApp (Sub ${subNome})</a>
        </div>` : ""}
        <p style="color: #64748b; font-size: 12px; line-height: 1.5; margin: 20px 0 0; text-align: center;">Guarde este e-mail como recibo oficial de inscrição. Em caso de dúvidas, procure os coordenadores da Equipe do Trânsito.</p>
      </div>
      <div class="footer">
        <p style="margin: 0 0 6px;"><strong>EJC Trânsito Monte Sião</strong></p>
        <p style="margin: 0 0 6px;">Igreja Evangélica Assembleia de Deus — Monte Sião</p>
        <p style="margin: 0; color: #64748b;">Campina Grande - PB • Servindo com excelência e amor ao Reino. ❤️</p>
      </div>
    </div>
  </div>
</body>
</html>`.trim();
}

function buildOrderCreatedHtml(p: { txid: string; orderId?: string; nome: string; valor: number; payloadPix?: string; lote?: string; sub?: string }): string {
  const nomeLimpo = String(p.nome || "Participante").trim();
  const valorFormatado = Number(p.valor || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <title>EJC — Inscrição iniciada com sucesso</title>
  <style>
    body { margin: 0; padding: 20px; font-family: 'Inter', sans-serif; background: #f8fafc; color: #1e293b; }
    .card { max-width: 580px; margin: 0 auto; background: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; overflow: hidden; }
    .header { background: #023284; color: #ffffff; padding: 24px; text-align: center; }
    .body { padding: 24px; }
    .code-box { background: #f1f5f9; padding: 14px; border-radius: 8px; font-family: monospace; font-size: 12px; word-break: break-all; border: 1px solid #cbd5e1; margin: 16px 0; }
    .footer { text-align: center; font-size: 12px; color: #64748b; padding: 16px; border-top: 1px solid #f1f5f9; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h1 style="margin: 0; font-size: 20px; text-transform: uppercase;">EJC — Equipe do Trânsito</h1>
      <p style="margin: 4px 0 0; color: #fcc002; font-size: 13px; font-weight: bold;">AGUARDANDO PAGAMENTO PIX</p>
    </div>
    <div class="body">
      <h2 style="font-size: 18px; color: #023284; margin-top: 0;">Olá, ${nomeLimpo}!</h2>
      <p style="font-size: 14px; line-height: 1.5; color: #475569;">Seu pedido de inscrição para a <strong>Equipe do Trânsito (${p.lote || "1º Lote"})</strong> foi gerado com sucesso.</p>
      <div style="background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 10px; padding: 14px; margin: 16px 0;">
        <div style="font-size: 13px; color: #1e40af;"><strong>Identificador do Pedido:</strong> ${p.orderId || p.txid}</div>
        <div style="font-size: 16px; color: #1e3a8a; margin-top: 6px;"><strong>Valor da Inscrição:</strong> ${valorFormatado}</div>
        <div style="font-size: 13px; color: #1e40af; margin-top: 4px;"><strong>Sub Equipe:</strong> Sub ${p.sub || "Geral"}</div>
      </div>
      <p style="font-size: 13px; color: #64748b;">Para concluir e garantir a sua vaga, abra o aplicativo do seu banco e utilize o código Pix Copia e Cola abaixo:</p>
      <div class="code-box">${p.payloadPix || p.txid}</div>
      <p style="font-size: 12px; color: #ef4444; font-weight: 700;">⚠️ Atenção: A sua vaga só estará confirmada após a liquidação do pagamento pelo banco.</p>
    </div>
    <div class="footer">EJC Trânsito Monte Sião — IEAD Monte Sião • Campina Grande - PB</div>
  </div>
</body>
</html>`.trim();
}

function buildManualProofReceivedHtml(p: { txid: string; nome: string; valor: number; sub?: string }): string {
  const nomeLimpo = String(p.nome || "Participante").trim();
  const valorFormatado = Number(p.valor || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

  return `<!DOCTYPE html>
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
      <p style="font-size: 14px; line-height: 1.5; color: #475569;">Recebemos o anexo do seu comprovante de transferência Pix no valor de <strong>${valorFormatado}</strong> para a <strong>Sub ${p.sub || "Equipe"}</strong> (Ref: <code>${p.txid}</code>).</p>
      <div style="background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 8px; padding: 12px; margin: 16px 0; font-size: 13px; color: #065f46;">
        <strong>Status atual:</strong> Aguardando análise pela coordenação financeira do EJC.
      </div>
      <p style="font-size: 13px; color: #64748b; line-height: 1.5;">Nossa equipe fará a conferência dos dados em até 24 horas. Assim que o pagamento for aprovado, você receberá o <strong>Recibo Oficial do EJC</strong> e o link do grupo do WhatsApp neste mesmo e-mail.</p>
    </div>
  </div>
</body>
</html>`.trim();
}

function buildAdminManualProofAlertHtml(p: { txid: string; nome: string; email: string; whatsapp?: string; valor: number; sub?: string; comprovanteUrl?: string }): string {
  const valorFormatado = Number(p.valor || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

  return `<!DOCTYPE html>
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
        <div class="row"><span>Participante:</span><strong>${p.nome}</strong></div>
        <div class="row"><span>E-mail:</span><strong>${p.email}</strong></div>
        ${p.whatsapp ? `<div class="row"><span>WhatsApp:</span><strong>${p.whatsapp}</strong></div>` : ""}
        <div class="row"><span>Sub Equipe:</span><strong>Sub ${p.sub || "Geral"}</strong></div>
        <div class="row"><span>Valor Declarado:</span><strong style="color:#047857; font-size: 15px;">${valorFormatado}</strong></div>
        <div class="row"><span>TXID / Referência:</span><code>${p.txid}</code></div>
      </div>
      ${p.comprovanteUrl ? `
      <div style="margin: 16px 0; text-align: center;">
        <a href="${p.comprovanteUrl}" target="_blank" style="display: inline-block; background: #023284; color: #ffffff; padding: 10px 18px; border-radius: 8px; text-decoration: none; font-weight: 700; font-size: 13px;">🔍 Abrir Imagem do Comprovante</a>
      </div>` : ""}
      <p style="font-size: 12px; color: #64748b; text-align: center; margin-top: 16px;">Acesse o painel administrativo na aba <strong>Financeiro</strong> para aprovar ou rejeitar este comprovante.</p>
    </div>
  </div>
</body>
</html>`.trim();
}

function buildManualProofRejectedHtml(p: { txid: string; nome: string; motivo?: string }): string {
  const nomeLimpo = String(p.nome || "Participante").trim();

  return `<!DOCTYPE html>
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
      <p style="font-size: 14px; line-height: 1.5; color: #475569;">O comprovante enviado para o pedido <code>${p.txid}</code> foi analisado pela coordenação financeira e não pôde ser aprovado.</p>
      <div style="background: #fef2f2; border: 1px solid #fecaca; padding: 14px; border-radius: 8px; color: #991b1b; font-size: 13px; margin: 16px 0;">
        <strong>Justificativa da Coordenação:</strong><br>
        ${p.motivo || "Arquivo ilegível, valor divergente ou comprovante não correspondente à conta oficial do EJC."}
      </div>
      <p style="font-size: 13px; color: #64748b; line-height: 1.5;">Por favor, acesse novamente o site do EJC para anexar o comprovante legível ou entre em contato diretamente com a coordenação da sua Sub.</p>
    </div>
  </div>
</body>
</html>`.trim();
}

// ------------------------------------------------------------------------------
// 3. CONSULTA DE DADOS CANÔNICOS NO SUPABASE
// ------------------------------------------------------------------------------

async function obterLinkWhatsAppSub(supabase: any, subName: string): Promise<string> {
  const subNorm = String(subName || "Geral").trim();
  try {
    const { data, error } = await supabase
      .from("configuracoes_whatsapp")
      .select("link_grupo, ativo")
      .eq("sub", subNorm)
      .eq("ativo", true)
      .limit(1)
      .maybeSingle();

    if (!error && data?.link_grupo) return data.link_grupo;
  } catch (_) {}

  try {
    const { data: subData } = await supabase
      .from("subs")
      .select("link_whatsapp")
      .eq("nome", subNorm)
      .limit(1)
      .maybeSingle();

    if (subData?.link_whatsapp) return subData.link_whatsapp;
  } catch (_) {}

  return "";
}

// ------------------------------------------------------------------------------
// 4. HANDLER PRINCIPAL
// ------------------------------------------------------------------------------

serve(async (req: Request) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-dry-run, apikey, x-client-info",
    "Content-Type": "application/json; charset=utf-8"
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Método não permitido" }), { status: 405, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const brevoApiKey = Deno.env.get("BREVO_API_KEY_EJC_EDGE")?.trim() || "";
    const defaultSenderEmail = Deno.env.get("BREVO_FROM_EMAIL") || "hugogeeta.gamer@gmail.com";
    const defaultSenderName = Deno.env.get("BREVO_FROM_NAME") || "EJC — AD Monte Sião";
    const adminEmail = Deno.env.get("BREVO_ADMIN_EMAIL") || "hugogeeta.gamer@gmail.com";

    // 1. AUTENTICAÇÃO E VALIDAÇÃO DE SEGURANÇA
    const authHeader = req.headers.get("authorization") || "";
    const bearerToken = authHeader.replace(/^Bearer\s+/i, "").trim();
    const adminToken = req.headers.get("x-admin-token")?.trim() || "";

    const passCoordenacao = (Deno.env.get("ADMIN_PASSWORD_COORDENACAO") || Deno.env.get("ADMIN_PASS") || "").trim().replace(/^"|"$/g, "");
    const passFinanceiro = (Deno.env.get("ADMIN_PASSWORD_FINANCEIRO") || Deno.env.get("FINANCEIRO_PASSWORD") || "").trim().replace(/^"|"$/g, "");
    const passAdmin = (Deno.env.get("ADMIN_PASSWORD") || "").trim().replace(/^"|"$/g, "");

    const validServiceKeys = new Set<string>();
    if (serviceRoleKey) validServiceKeys.add(serviceRoleKey.trim());
    const secretKeysRaw = Deno.env.get("SUPABASE_SECRET_KEYS") || "";
    if (secretKeysRaw) {
      try {
        const parsed = JSON.parse(secretKeysRaw);
        if (Array.isArray(parsed)) {
          for (const k of parsed) if (typeof k === "string") validServiceKeys.add(k.trim());
        }
      } catch {
        validServiceKeys.add(secretKeysRaw.trim());
      }
    }

    let callerType = "";
    let callerRole = "";

    // A) SERVER-TO-SERVER: Service role key via Bearer ou apikey
    if (bearerToken && validServiceKeys.has(bearerToken)) {
      callerType = "server-to-server";
      callerRole = "service_role";
    }

    // A.2) SERVER-TO-SERVER: JWT com claim role === "service_role"
    if (!callerType && bearerToken && bearerToken.startsWith("ey")) {
      try {
        const parts = bearerToken.split(".");
        if (parts.length === 3) {
          const payloadJson = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
          if (payloadJson.role === "service_role") {
            callerType = "server-to-server";
            callerRole = "service_role";
          }
        }
      } catch (_jwtParseErr) {
        // Ignora erro de parsing
      }
    }

    // B) ADMIN: Senha administrativa via x-admin-token ou Bearer
    if (
      !callerType &&
      ((adminToken && ((passCoordenacao && adminToken === passCoordenacao) || (passFinanceiro && adminToken === passFinanceiro) || (passAdmin && adminToken === passAdmin))) ||
       (bearerToken && ((passCoordenacao && bearerToken === passCoordenacao) || (passFinanceiro && bearerToken === passFinanceiro) || (passAdmin && bearerToken === passAdmin))))
    ) {
      callerType = "admin";
      const tokenToCheck = adminToken || bearerToken;
      callerRole = (passCoordenacao && tokenToCheck === passCoordenacao) ? "superadmin" : ((passFinanceiro && tokenToCheck === passFinanceiro) ? "financeiro" : "admin");
    }

    // C) ADMIN: Sessão Supabase Auth com role administrativa
    if (!callerType && bearerToken && bearerToken.startsWith("ey")) {
      try {
        const supabaseAuthCheck = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
        const { data: { user }, error: userErr } = await supabaseAuthCheck.auth.getUser(bearerToken);
        if (!userErr && user) {
          const userRole = user.app_metadata?.role || user.user_metadata?.role;
          if (userRole === "admin" || userRole === "superadmin" || userRole === "financeiro" || user.email === adminEmail) {
            callerType = "admin";
            callerRole = userRole || "admin";
          }
        }
      } catch (_authCheckErr) {
        // Falha silenciosa na validação de token de sessão
      }
    }

    // Se o chamador for autenticado como service_role, permite definir escopo administrativo específico via header
    if (callerType === "server-to-server") {
      const explicitRole = req.headers.get("x-admin-role")?.trim().toLowerCase();
      if (explicitRole === "admin" || explicitRole === "financeiro" || explicitRole === "superadmin") {
        callerType = "admin";
        callerRole = explicitRole;
      }
    }

    if (!callerType) {
      return new Response(
        JSON.stringify({ error: "Acesso não autorizado. Credencial de serviço (server-to-server) ou sessão administrativa autorizada é obrigatória." }),
        { status: 401, headers: corsHeaders }
      );
    }

    const payload = await req.json().catch(() => ({}));

    // Regra de segurança: O frontend/cliente NUNCA pode enviar chave de serviço no payload
    if (payload.service_role_key || payload.supabase_service_role_key || payload.service_key) {
      return new Response(
        JSON.stringify({ error: "Envio de chave de serviço pelo cliente rejeitado por política de segurança." }),
        { status: 400, headers: corsHeaders }
      );
    }

    const {
      event_type,
      txid,
      rejection_reason,
      proof_url,
      simulate: bodySimulate,
      recipient_override
    } = payload;

    const isDryRun = Boolean(bodySimulate || req.headers.get("x-dry-run") === "true");

    // Regra de segurança: force_resend restrito exclusivamente a superadmin, financeiro ou service credential
    if (payload.force_resend) {
      if (callerType !== "server-to-server" && callerRole !== "superadmin" && callerRole !== "financeiro") {
        return new Response(
          JSON.stringify({ error: "force_resend é restrito exclusivamente aos perfis 'superadmin', 'financeiro' ou credencial de serviço." }),
          { status: 403, headers: corsHeaders }
        );
      }
    }

    const ALLOWED_EVENTS = new Set([
      "payment_approved",
      "order_created",
      "manual_proof_approved",
      "manual_proof_received",
      "manual_proof_rejected",
      "admin_manual_proof_alert"
    ]);

    if (!event_type || !ALLOWED_EVENTS.has(event_type)) {
      return new Response(
        JSON.stringify({ error: `Evento inválido ou não suportado nesta fase: '${event_type}'` }),
        { status: 400, headers: corsHeaders }
      );
    }

    // Regra de autorização administrativa: admin geral não pode disparar aprovações ou rejeições financeiras
    if (callerType === "admin" && callerRole === "admin") {
      if (event_type === "payment_approved" || event_type === "manual_proof_approved" || event_type === "manual_proof_rejected") {
        return new Response(
          JSON.stringify({ error: "Perfil 'admin' não possui autorização para disparar confirmações ou rejeições financeiras de pagamentos." }),
          { status: 403, headers: corsHeaders }
        );
      }
    }

    if (!txid) {
      return new Response(
        JSON.stringify({ error: "Campo 'txid' é obrigatório para identificação da transação." }),
        { status: 400, headers: corsHeaders }
      );
    }

    const cleanTxid = String(txid).trim();
    if (!/^[a-zA-Z0-9_\-]{3,100}$/.test(cleanTxid)) {
      return new Response(
        JSON.stringify({ error: "Identificador 'txid' malformado ou com formato inválido." }),
        { status: 400, headers: corsHeaders }
      );
    }

    // 2. CLIENTE SUPABASE
    const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

    // 3. BUSCA DOS DADOS CANÔNICOS OFICIAIS NO BANCO
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanTxid);
    const filter = isUuid
      ? `txid.eq.${cleanTxid},id.eq.${cleanTxid},gateway_transaction_id.eq.${cleanTxid}`
      : `txid.eq.${cleanTxid},gateway_transaction_id.eq.${cleanTxid}`;

    const { data: paymentRecord, error: payErr } = await supabase
      .from("pagamentos")
      .select("*")
      .or(filter)
      .limit(1)
      .maybeSingle();

    if (payErr || !paymentRecord) {
      return new Response(
        JSON.stringify({ error: `Transação não localizada no banco de dados para TXID '${cleanTxid}'.` }),
        { status: 404, headers: corsHeaders }
      );
    }

    // REGRA DE INTEGRIDADE CANÔNICA: confirmação de pagamento só pode ser enviada se status for 'approved'
    if (event_type === "payment_approved" || event_type === "manual_proof_approved") {
      if (paymentRecord.status !== "approved") {
        return new Response(
          JSON.stringify({
            error: `Envio de recibo bloqueado: status atual do pagamento é '${paymentRecord.status}', esperado 'approved'.`,
            status: paymentRecord.status
          }),
          { status: 422, headers: corsHeaders }
        );
      }
    }

    // Resolução canônica de sub e comprovante via inscrição se necessário
    let canonicalSub = paymentRecord.metadata?.sub || paymentRecord.sub || null;
    let canonicalComprovante = proof_url || paymentRecord.metadata?.comprovante_url || paymentRecord.metadata?.comprovante_caminho || null;

    if ((!canonicalSub || !canonicalComprovante) && paymentRecord.inscricao_id) {
      const { data: insc } = await supabase
        .from("inscricoes")
        .select("sub, comprovante_caminho")
        .eq("id", paymentRecord.inscricao_id)
        .maybeSingle();

      if (insc) {
        if (!canonicalSub && insc.sub) canonicalSub = insc.sub;
        if (!canonicalComprovante && insc.comprovante_caminho) canonicalComprovante = insc.comprovante_caminho;
      }
    }
    canonicalSub = canonicalSub || "Geral";

    // Define destinatário e nome canônicos
    let recipientEmail = paymentRecord.email;
    let recipientName = paymentRecord.nome_pagador || "Participante";

    // Alerta administrativo vai sempre para o admin
    if (event_type === "admin_manual_proof_alert") {
      recipientEmail = adminEmail;
      recipientName = "Coordenação Financeira EJC";
    }

    // Override seguro exclusivo para testes administrativos controlados
    if (recipient_override && recipient_override === adminEmail) {
      recipientEmail = adminEmail;
    }

    if (!recipientEmail || !recipientEmail.includes("@")) {
      return new Response(
        JSON.stringify({ error: "E-mail do destinatário não configurado ou ausente no registro da transação." }),
        { status: 400, headers: corsHeaders }
      );
    }

    // 4. CHAVE DE IDEMPOTÊNCIA DO EVENTO
    let idempotencyKey = `${event_type}:${cleanTxid}`;
    if (payload.force_resend) {
      idempotencyKey = `${event_type}:${cleanTxid}:force_resend_${Date.now()}`;
    } else if (event_type === "manual_proof_received" || event_type === "admin_manual_proof_alert") {
      const proofRef = String(proof_url || canonicalComprovante || "").slice(-20);
      idempotencyKey = `${event_type}:${cleanTxid}:${proofRef || "v1"}`;
    } else if (event_type === "manual_proof_rejected") {
      idempotencyKey = `${event_type}:${cleanTxid}:${Date.now()}`;
    }

    // 5. CLAIM ATÔMICO COM LEASE
    const workerId = `edge_send_email_${crypto.randomUUID().slice(0, 8)}`;
    const { data: claimResult, error: claimErr } = await supabase.rpc("claim_email_dispatch", {
      p_key: idempotencyKey,
      p_event_type: event_type,
      p_entity_id: String(txid),
      p_recipient: recipientEmail,
      p_worker_id: workerId,
      p_lease_seconds: 300
    });

    if (claimErr) {
      console.error("[send-email] Erro na RPC claim_email_dispatch:", claimErr.message);
      return new Response(
        JSON.stringify({ error: "Falha interna ao registrar claim de concorrência.", detail: claimErr.message }),
        { status: 500, headers: corsHeaders }
      );
    }

    if (!claimResult.claimed) {
      if (claimResult.status === "sent") {
        return new Response(
          JSON.stringify({
            success: true,
            already_sent: true,
            message: "E-mail para este evento já foi enviado anteriormente com sucesso.",
            message_id: claimResult.message_id
          }),
          { status: 200, headers: corsHeaders }
        );
      } else {
        return new Response(
          JSON.stringify({
            success: true,
            in_progress: true,
            message: "Este evento de e-mail já está sendo processado ativamente por outra instância (lease ativo)."
          }),
          { status: 200, headers: corsHeaders }
        );
      }
    }

    const claimToken = claimResult.claim_token;
    const brevoUuid = claimResult.brevo_uuid; // UUID gerado pelo banco para a Brevo

    // 6. RENDERIZAÇÃO DO TEMPLATE ESPECÍFICO
    let subject = "";
    let htmlContent = "";
    const tags = ["ejc", event_type];

    const subName = canonicalSub;
    const whatsappLink = await obterLinkWhatsAppSub(supabase, subName);

    switch (event_type) {
      case "payment_approved":
        subject = "EJC — Pagamento confirmado ✅";
        htmlContent = buildEJCReceiptHtml({
          txid: paymentRecord.txid,
          orderId: paymentRecord.order_id,
          paymentId: paymentRecord.payment_id,
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
          categoria: "Inscrição Oficial da Equipe",
          dataHora: paymentRecord.pago_em ? new Date(paymentRecord.pago_em).toLocaleString("pt-BR", { timeZone: "America/Fortaleza" }) : undefined,
          whatsappLink: whatsappLink,
          origemAprovacao: "api_gateway"
        });
        break;

      case "manual_proof_approved":
        subject = "EJC — Comprovante aprovado e inscrição confirmada! ✅";
        htmlContent = buildEJCReceiptHtml({
          txid: paymentRecord.txid,
          orderId: paymentRecord.order_id,
          paymentId: paymentRecord.payment_id,
          nome: paymentRecord.nome_pagador,
          email: paymentRecord.email,
          whatsapp: paymentRecord.whatsapp_pagador,
          valor: paymentRecord.valor,
          valorOriginal: paymentRecord.metadata?.valor_original,
          desconto: paymentRecord.metadata?.desconto,
          metodo: paymentRecord.metodo,
          modalidadePix: "manual",
          lote: paymentRecord.metadata?.lote,
          sub: subName,
          categoria: "Inscrição Oficial da Equipe",
          dataHora: paymentRecord.pago_em ? new Date(paymentRecord.pago_em).toLocaleString("pt-BR", { timeZone: "America/Fortaleza" }) : undefined,
          whatsappLink: whatsappLink,
          origemAprovacao: "manual_coordenacao"
        });
        break;

      case "order_created":
        subject = "EJC — Seu pagamento foi iniciado ⏳";
        htmlContent = buildOrderCreatedHtml({
          txid: paymentRecord.txid,
          orderId: paymentRecord.order_id,
          nome: paymentRecord.nome_pagador,
          valor: paymentRecord.valor,
          payloadPix: paymentRecord.pix_copia_e_cola,
          lote: paymentRecord.metadata?.lote,
          sub: subName
        });
        break;

      case "manual_proof_received":
        subject = "EJC — Comprovante recebido para análise 📄";
        htmlContent = buildManualProofReceivedHtml({
          txid: paymentRecord.txid,
          nome: paymentRecord.nome_pagador,
          valor: paymentRecord.valor,
          sub: subName
        });
        break;

      case "admin_manual_proof_alert":
        subject = `🔔 EJC Admin — Novo comprovante Pix: ${paymentRecord.nome_pagador || paymentRecord.txid}`;
        htmlContent = buildAdminManualProofAlertHtml({
          txid: paymentRecord.txid,
          nome: paymentRecord.nome_pagador || "Participante",
          email: paymentRecord.email,
          whatsapp: paymentRecord.whatsapp_pagador,
          valor: paymentRecord.valor,
          sub: subName,
          comprovanteUrl: canonicalComprovante
        });
        break;

      case "manual_proof_rejected":
        subject = "EJC — Atualização sobre seu comprovante Pix ⚠️";
        htmlContent = buildManualProofRejectedHtml({
          txid: paymentRecord.txid,
          nome: paymentRecord.nome_pagador,
          motivo: rejection_reason
        });
        break;
    }

    // 7. MODO DE HOMOLOGAÇÃO / SIMULAÇÃO SEGURO (ZERO CHAMADA BREVO)
    if (isDryRun) {
      console.log(`[send-email DRY-RUN] Simulando envio para ${recipientEmail} (${subject}).`);
      const simulatedMessageId = `simulated-brevo-${brevoUuid}`;

      await supabase.rpc("finish_email_dispatch", {
        p_key: idempotencyKey,
        p_claim_token: claimToken,
        p_message_id: simulatedMessageId
      });

      await supabase.from("auditoria_transacoes").insert({
        transacao_id: String(txid),
        acao: `email_${event_type}`,
        status_anterior: null,
        status_novo: "enviado",
        executado_por: "supabase_edge_send_email_dryrun",
        detalhes: {
          idempotency_key: idempotencyKey,
          recipient: recipientEmail,
          message_id: simulatedMessageId,
          simulated: true
        }
      });

      return new Response(
        JSON.stringify({
          success: true,
          simulated: true,
          event_type,
          recipient: recipientEmail,
          subject,
          idempotency_key: idempotencyKey,
          claim_token: claimToken,
          message_id: simulatedMessageId
        }),
        { status: 200, headers: corsHeaders }
      );
    }

    // 8. DISPARO REAL COM IDEMPOTÊNCIA NATIVA BREVO (headers.idempotencyKey)
    if (!brevoApiKey) {
      await supabase.rpc("release_email_dispatch", {
        p_key: idempotencyKey,
        p_claim_token: claimToken,
        p_error: "BREVO_API_KEY_EJC_EDGE ausente no ambiente"
      });
      return new Response(
        JSON.stringify({ error: "Configuração de e-mail ausente no servidor (API Key não definida)." }),
        { status: 500, headers: corsHeaders }
      );
    }

    const brevoPayload = {
      sender: {
        name: defaultSenderName,
        email: defaultSenderEmail
      },
      to: [
        {
          email: recipientEmail.trim().toLowerCase(),
          name: recipientName.trim()
        }
      ],
      headers: {
        idempotencyKey: brevoUuid
      },
      subject: subject,
      htmlContent: htmlContent,
      tags: tags
    };

    let brevoRes: Response;
    try {
      brevoRes = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: {
          "api-key": brevoApiKey,
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify(brevoPayload),
        signal: AbortSignal.timeout(9000)
      });
    } catch (networkErr: any) {
      console.error("[send-email] Falha de rede/timeout na Brevo:", networkErr.message);
      await supabase.rpc("release_email_dispatch", {
        p_key: idempotencyKey,
        p_claim_token: claimToken,
        p_error: `Network error: ${networkErr.message}`
      });
      return new Response(
        JSON.stringify({ error: "Falha de comunicação com o provedor de e-mail.", detail: networkErr.message }),
        { status: 502, headers: corsHeaders }
      );
    }

    const brevoData = await brevoRes.json().catch(() => ({}));

    // SUCESSO BREVO (200 / 201)
    if (brevoRes.ok) {
      const messageId = brevoData.messageId || `brevo-${brevoUuid}`;

      await supabase.rpc("finish_email_dispatch", {
        p_key: idempotencyKey,
        p_claim_token: claimToken,
        p_message_id: messageId
      });

      // Atualiza flag legado na tabela pagamentos para compatibilidade
      if (event_type === "payment_approved" || event_type === "manual_proof_approved") {
        await supabase
          .from("pagamentos")
          .update({
            comprovante_email_enviado: true,
            comprovante_email_em: new Date().toISOString(),
            comprovante_email_erro: null
          })
          .eq("txid", txid);
      }

      await supabase.from("auditoria_transacoes").insert({
        transacao_id: String(txid),
        acao: `email_${event_type}`,
        status_anterior: null,
        status_novo: "enviado",
        executado_por: "supabase_edge_send_email",
        detalhes: {
          idempotency_key: idempotencyKey,
          recipient: recipientEmail,
          message_id: messageId,
          simulated: false
        }
      });

      return new Response(
        JSON.stringify({
          success: true,
          event_type,
          recipient: recipientEmail,
          subject,
          idempotency_key: idempotencyKey,
          message_id: messageId
        }),
        { status: 200, headers: corsHeaders }
      );
    }

    // TRATAMENTO OFICIAL DE IDEMPOTÊNCIA CONFIRMADA PELA BREVO (duplicate_parameter)
    const errCode = String(brevoData.code || "").toLowerCase();
    const errMsg = String(brevoData.message || "");

    if (brevoRes.status === 400 && (errCode === "duplicate_parameter" || errMsg.includes("idempotencyKey"))) {
      console.log(`[send-email] Brevo confirmou idempotência prévia para UUID ${brevoUuid}.`);

      await supabase.rpc("finish_email_dispatch", {
        p_key: idempotencyKey,
        p_claim_token: claimToken,
        p_message_id: `brevo-duplicate-confirmed-${brevoUuid}`
      });

      return new Response(
        JSON.stringify({
          success: true,
          already_sent: true,
          brevo_idempotency: true,
          message: "Mensagem previamente aceita e processada pela Brevo sob esta mesma chave."
        }),
        { status: 200, headers: corsHeaders }
      );
    }

    // TRATAMENTO DE ERROS RECUPERÁVEIS (429 / 5xx) -> RELEASE
    if (brevoRes.status === 429 || brevoRes.status >= 500) {
      console.warn(`[send-email] Erro temporário Brevo ${brevoRes.status}. Liberando claim para retry.`);
      await supabase.rpc("release_email_dispatch", {
        p_key: idempotencyKey,
        p_claim_token: claimToken,
        p_error: `Brevo HTTP ${brevoRes.status}: ${errMsg || "Erro temporário"}`
      });

      return new Response(
        JSON.stringify({ error: `Provedor de e-mail temporariamente indisponível (${brevoRes.status}).`, retryable: true }),
        { status: 502, headers: corsHeaders }
      );
    }

    // ERRO DE VALIDAÇÃO PERMANENTE (Ex: e-mail rejeitado)
    console.error(`[send-email] Erro definitivo Brevo ${brevoRes.status}:`, brevoData);
    await supabase.rpc("release_email_dispatch", {
      p_key: idempotencyKey,
      p_claim_token: claimToken,
      p_error: `Brevo Permanent Error ${brevoRes.status}: ${errMsg}`
    });

    return new Response(
      JSON.stringify({ error: "Rejeição na validação do e-mail pelo provedor.", detail: errMsg }),
      { status: 400, headers: corsHeaders }
    );

  } catch (err: any) {
    console.error("[send-email FATAL]", err);
    return new Response(
      JSON.stringify({ error: "Erro interno no processamento do e-mail.", detail: err.message }),
      { status: 500, headers: corsHeaders }
    );
  }
});
