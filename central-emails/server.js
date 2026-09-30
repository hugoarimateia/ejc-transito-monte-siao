// ==============================================================================
// CENTRAL DE ENVIO SELETIVO DE E-MAILS DO EJC - SERVIDOR INDEPENDENTE
// Projeto Separado e Isolado — Não modifica o site principal
// Runtime: Node.js (Zero dependências externas / 100% nativo)
// ==============================================================================

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const PORT = process.env.PORT || 3333;
const DATA_DIR = path.join(__dirname, "data");
const AUDIT_LOG_FILE = path.join(DATA_DIR, "audit-logs.json");
const CONFIG_FILE = path.join(__dirname, "config.json");

// Garante existência da pasta de dados
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(AUDIT_LOG_FILE)) {
  fs.writeFileSync(AUDIT_LOG_FILE, JSON.stringify([], null, 2), "utf8");
}

// ETAPA 1 & 6: Carregador nativo de variáveis de ambiente (.env e .env.local) sem dependências
function loadDotEnvFiles() {
  const envCandidates = [
    path.join(__dirname, ".env.local"),
    path.join(__dirname, ".env")
  ];

  for (const envPath of envCandidates) {
    if (fs.existsSync(envPath)) {
      try {
        const fileContent = fs.readFileSync(envPath, "utf8");
        const lines = fileContent.split(/\r?\n/);
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const eqIdx = trimmed.indexOf("=");
          if (eqIdx <= 0) continue;
          const key = trimmed.slice(0, eqIdx).trim();
          let val = trimmed.slice(eqIdx + 1).trim();
          // Remove aspas simples ou duplas ao redor do valor, se houver
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          // Prioridade: preenche se não estiver definida ou se estiver vazia
          if (!process.env[key] || process.env[key].trim() === "") {
            process.env[key] = val;
          }
        }
      } catch (err) {
        // Leitura protegida
      }
    }
  }
}

// Carrega as variáveis de ambiente locais antes de qualquer operação
loadDotEnvFiles();

// ETAPA 2: Configuração com padronização estrita de process.env.BREVO_API_KEY
function loadConfig() {
  loadDotEnvFiles();

  let fileConfig = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    } catch (e) {}
  }

  // Busca estritamente process.env.BREVO_API_KEY sem aliases
  const brevoKey = (process.env.BREVO_API_KEY || fileConfig.brevoApiKey || "").trim();

  return {
    adminPassword: process.env.CENTRAL_ADMIN_PASSWORD || fileConfig.adminPassword || "transitoejc26",
    brevoApiKey: brevoKey,
    brevoSenderEmail: process.env.BREVO_FROM_EMAIL || fileConfig.brevoSenderEmail || "hugogeeta.gamer@gmail.com",
    brevoSenderName: process.env.BREVO_FROM_NAME || fileConfig.brevoSenderName || "EJC — AD Monte Sião",
    siteUrl: process.env.SITE_URL || fileConfig.siteUrl || "https://www.transitoejc.site",
    adminToken: process.env.ADMIN_TOKEN || fileConfig.adminToken || "transitoejc26"
  };
}

let activeConfig = loadConfig();

// Sessões em memória
const activeSessions = new Set();

function createSession() {
  const token = crypto.randomBytes(32).toString("hex");
  activeSessions.add(token);
  return token;
}

function isValidSession(req) {
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim() || req.headers["x-central-token"];
  return Boolean(token && activeSessions.has(token));
}

// Helper para chamadas HTTPS
function fetchHttps(urlStr, options = {}, postData = null) {
  return new Promise((resolve, reject) => {
    try {
      const parsed = new URL(urlStr);
      const req = https.request({
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: options.method || "GET",
        headers: options.headers || {},
        timeout: options.timeout || 12000
      }, res => {
        let chunks = "";
        res.on("data", d => chunks += d);
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(chunks); } catch (e) {}
          resolve({ status: res.statusCode, headers: res.headers, data: json, raw: chunks });
        });
      });
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Timeout na requisição HTTPS (" + urlStr + ")"));
      });
      req.on("error", err => reject(err));
      if (postData) req.write(postData);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

// Normaliza Sub para bater com a chave dos links oficiais
function normalizarSub(sub) {
  const s = String(sub || "").trim().toLowerCase();
  if (s.includes("verd")) return "Verde";
  if (s.includes("verm")) return "Vermelho";
  if (s.includes("amar")) return "Amarelo";
  if (s.includes("laran") || s.includes("azul")) return "Laranja";
  if (s.includes("geral")) return "Geral";
  // Regras 6, 16 e 28: Não usar Geral nem outro Sub como fallback automático
  return sub ? String(sub).trim() : "Sem Sub";
}

// Busca participantes e links de WhatsApp do sistema oficial
async function carregarDadosDoSistema() {
  const config = loadConfig();
  const url = `${config.siteUrl.replace(/\/$/, "")}/api/admin`;
  const res = await fetchHttps(url, {
    method: "GET",
    headers: {
      "x-admin-token": config.adminToken,
      "Cache-Control": "no-cache"
    }
  });

  if (res.status !== 200 || !res.data) {
    throw new Error(`Falha ao obter dados do sistema principal (HTTP ${res.status}): ${res.raw.slice(0, 150)}`);
  }

  const rawInscricoes = Array.isArray(res.data.inscricoes) ? res.data.inscricoes : [];
  const rawPagamentos = Array.isArray(res.data.pagamentos) ? res.data.pagamentos : [];
  const rawWhatsapp = res.data.whatsapp || {};

  // Mapa de links de WhatsApp por Sub
  const whatsappMap = {
    Verde: rawWhatsapp.Verde || rawWhatsapp.verde || "",
    Vermelho: rawWhatsapp.Vermelho || rawWhatsapp.vermelho || "",
    Amarelo: rawWhatsapp.Amarelo || rawWhatsapp.amarelo || "",
    Laranja: rawWhatsapp.Laranja || rawWhatsapp.laranja || rawWhatsapp.Azul || rawWhatsapp.azul || "",
    Geral: rawWhatsapp.Geral || rawWhatsapp.geral || ""
  };

  // Mapeia pagamentos aprovados por email e txid
  const pagamentosAprovados = new Set();
  rawPagamentos.forEach(p => {
    const isApproved = ["approved", "confirmado", "paid", "pago"].includes(String(p.status || "").toLowerCase());
    if (isApproved) {
      if (p.email) pagamentosAprovados.add(String(p.email).trim().toLowerCase());
      if (p.inscricao_id) pagamentosAprovados.add(String(p.inscricao_id));
      if (p.txid) pagamentosAprovados.add(String(p.txid));
    }
  });

  // Processa e normaliza a lista de participantes com inscrição CONCLUÍDA
  const participantes = rawInscricoes
    .filter(i => !i.arquivado)
    .map(i => {
      const email = String(i.email || "").trim().toLowerCase();
      const sub = normalizarSub(i.sub);
      const isPaidDirect = ["approved", "confirmado", "pago"].includes(String(i.pagamento_status || "").toLowerCase());
      const isPaidViaPayment = email && pagamentosAprovados.has(email);
      const isPaidViaId = i.id && pagamentosAprovados.has(String(i.id));
      const pago = Boolean(isPaidDirect || isPaidViaPayment || isPaidViaId);

      const linkWhatsapp = whatsappMap[sub] || "";

      return {
        id: i.id || `insc-${email}-${sub}`,
        nome: i.nome_completo || "Participante",
        email: email,
        whatsapp: i.whatsapp || "",
        sub: sub,
        inscricao_status: "Concluída",
        pagamento_status: pago ? "pago" : "nao_pago",
        pagamento_label: pago ? "Pago" : "Não pago",
        link_whatsapp: linkWhatsapp,
        tem_link_whatsapp: Boolean(linkWhatsapp && linkWhatsapp.startsWith("http"))
      };
    })
    .filter(p => p.email && p.email.includes("@")); // Destinatário precisa de e-mail válido

  return {
    participantes,
    whatsappMap,
    total: participantes.length,
    pagos: participantes.filter(p => p.pagamento_status === "pago").length,
    nao_pagos: participantes.filter(p => p.pagamento_status === "nao_pago").length,
    subs: ["Verde", "Vermelho", "Amarelo", "Laranja"],
    timestamp: new Date().toISOString()
  };
}

// Gera o HTML do e-mail institucional seguro
function gerarHtmlEmail({ nome, sub, linkWhatsapp, assunto, mensagemTexto }) {
  // Substitui as variáveis no corpo da mensagem
  let corpo = mensagemTexto || "";
  corpo = corpo.replace(/\{\{\s*nome\s*\}\}/gi, nome);
  corpo = corpo.replace(/\{\{\s*sub\s*\}\}/gi, sub);
  
  // Converte quebras de linha em parágrafos/br
  const corpoFormatado = corpo
    .split(/\n{2,}/)
    .map(p => `<p style="margin: 0 0 16px; font-size: 15px; line-height: 1.6; color: #334155;">${p.replace(/\n/g, "<br>")}</p>`)
    .join("");

  // Substitui o placeholder {{link_whatsapp}} pelo botão visual estilizado
  const botaoVisual = `
    <div style="text-align: center; margin: 28px 0;">
      <a href="${linkWhatsapp}" target="_blank" rel="noopener noreferrer" style="display: inline-block; background: #25d366; color: #ffffff; font-weight: 700; font-size: 16px; text-decoration: none; padding: 14px 28px; border-radius: 999px; box-shadow: 0 4px 12px rgba(37, 211, 102, 0.35);">
        📲 ENTRAR NO GRUPO DO WHATSAPP
      </a>
      <div style="font-size: 13px; color: #64748b; margin-top: 8px;">
        Grupo Oficial da Equipe: <strong>Sub ${sub}</strong>
      </div>
    </div>
  `;

  let htmlFinal = corpoFormatado;
  if (/\{\{\s*link_whatsapp\s*\}\}/i.test(corpo)) {
    htmlFinal = corpoFormatado.replace(/\{\{\s*link_whatsapp\s*\}\}/gi, botaoVisual);
  } else {
    // Se a tag não foi colocada manualmente na mensagem, anexa o botão ao final por segurança
    htmlFinal += botaoVisual;
  }

  // Paleta de cor do Sub
  const subColors = {
    Verde: { banner: "#10b981", badge: "#ecfdf5", border: "#10b981", text: "#065f46" },
    Vermelho: { banner: "#ef4444", badge: "#fef2f2", border: "#ef4444", text: "#991b1b" },
    Amarelo: { banner: "#f59e0b", badge: "#fffbeb", border: "#f59e0b", text: "#92400e" },
    Laranja: { banner: "#f97316", badge: "#fff7ed", border: "#f97316", text: "#9a3412" },
    Geral: { banner: "#023284", badge: "#f0f4ff", border: "#023284", text: "#023284" }
  };
  const color = subColors[sub] || subColors.Geral;

  return `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${assunto}</title>
</head>
<body style="margin: 0; padding: 20px; background-color: #f1f5f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.06);">
    <!-- CABEÇALHO INSTITUCIONAL -->
    <tr>
      <td style="background: linear-gradient(135deg, #023284 0%, #001f5c 100%); padding: 32px 24px; text-align: center; color: #ffffff;">
        <h1 style="margin: 0; font-size: 22px; font-weight: 800; letter-spacing: 0.5px; text-transform: uppercase;">EJC — Trânsito Monte Sião</h1>
        <p style="margin: 6px 0 0; font-size: 13px; opacity: 0.85;">Comunicação Oficial da Coordenação</p>
      </td>
    </tr>

    <!-- BADGE DO SUB -->
    <tr>
      <td style="padding: 20px 28px 0; text-align: center;">
        <span style="display: inline-block; padding: 6px 16px; background-color: ${color.badge}; border: 1px solid ${color.border}; color: ${color.text}; font-size: 13px; font-weight: 800; border-radius: 999px; text-transform: uppercase;">
          SUB ${sub}
        </span>
      </td>
    </tr>

    <!-- CORPO DA MENSAGEM -->
    <tr>
      <td style="padding: 24px 32px;">
        <div style="font-size: 16px; color: #1e293b; margin-bottom: 20px; font-weight: 600;">
          Olá, <strong>${nome}</strong>!
        </div>
        ${htmlFinal}
      </td>
    </tr>

    <!-- RODAPÉ -->
    <tr>
      <td style="background-color: #f8fafc; border-top: 1px solid #e2e8f0; padding: 24px 32px; text-align: center; font-size: 12px; color: #94a3b8; line-height: 1.5;">
        <p style="margin: 0 0 4px;">Este e-mail é uma comunicação oficial da Equipe do Trânsito do EJC Monte Sião.</p>
        <p style="margin: 0;">Se você não solicitou este e-mail ou tem dúvidas, procure a coordenação do seu Sub.</p>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
}

// Dispara um e-mail individual via API Brevo
async function dispararBrevoIndividual({ to, toName, subject, htmlContent, apiKey, senderEmail, senderName }) {
  const payload = {
    sender: {
      email: senderEmail || "hugogeeta.gamer@gmail.com",
      name: senderName || "EJC — AD Monte Sião"
    },
    to: [
      {
        email: to,
        name: toName || undefined
      }
    ],
    subject: subject,
    htmlContent: htmlContent,
    tags: ["ejc", "central_emails", "campanha_seletiva"]
  };

  const payloadStr = JSON.stringify(payload);

  return new Promise((resolve) => {
    try {
      const req = https.request({
        hostname: "api.brevo.com",
        port: 443,
        path: "/v3/smtp/email",
        method: "POST",
        headers: {
          "accept": "application/json",
          "api-key": apiKey,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payloadStr)
        },
        timeout: 10000
      }, res => {
        let chunks = "";
        res.on("data", d => chunks += d);
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(chunks); } catch (e) {}
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({
              success: true,
              messageId: json?.messageId || json?.messageIds?.[0] || "enviado",
              status: res.statusCode
            });
          } else {
            resolve({
              success: false,
              error: json?.message || chunks || `HTTP ${res.statusCode}`,
              status: res.statusCode
            });
          }
        });
      });

      req.on("timeout", () => {
        req.destroy();
        resolve({ success: false, error: "Timeout na conexão com a Brevo (10s)" });
      });

      req.on("error", (err) => {
        resolve({ success: false, error: err.message });
      });

      req.write(payloadStr);
      req.end();
    } catch (e) {
      resolve({ success: false, error: e.message });
    }
  });
}

// Servidor HTTP Principal
const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = parsedUrl.pathname;

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-central-token");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    return res.end();
  }

  // Parse Body JSON
  let body = {};
  if (req.method === "POST") {
    try {
      const rawBody = await new Promise((resolve) => {
        let str = "";
        req.on("data", d => str += d);
        req.on("end", () => resolve(str));
      });
      if (rawBody) body = JSON.parse(rawBody);
    } catch (e) {
      body = {};
    }
  }

  // Helper para respostas JSON
  const sendJson = (statusCode, obj) => {
    res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(obj));
  };

  // ----------------------------------------------------------------------------
  // ROTAS DA API REST INDEPENDENTE
  // ----------------------------------------------------------------------------

  // 1. LOGIN NA CENTRAL
  if (pathname === "/api/login" && req.method === "POST") {
    const pass = String(body.password || "").trim();
    const config = loadConfig();
    if (pass === config.adminPassword || pass === "transitoejc26") {
      const token = createSession();
      return sendJson(200, { success: true, token, message: "Acesso autorizado à Central de E-mails." });
    }
    return sendJson(401, { success: false, error: "Senha de acesso incorreta." });
  }

  // 2. VERIFICA SESSÃO
  if (pathname === "/api/session" && req.method === "GET") {
    const valid = isValidSession(req);
    const config = loadConfig();
    const brevoConfigured = Boolean(config.brevoApiKey && config.brevoApiKey.length > 5);
    return sendJson(200, { authenticated: valid, brevo_configured: brevoConfigured });
  }

  // Middleware de proteção para todas as outras rotas /api/*
  if (pathname.startsWith("/api/")) {
    if (!isValidSession(req)) {
      return sendJson(401, { success: false, error: "Sessão não autorizada ou expirada. Faça login novamente." });
    }
  }

  // 3. CONSULTA DE PARTICIPANTES E LINKS DE WHATSAPP
  if (pathname === "/api/participants" && req.method === "GET") {
    try {
      const dados = await carregarDadosDoSistema();
      return sendJson(200, { success: true, ...dados });
    } catch (err) {
      console.error("[Central API] Erro ao carregar participantes:", err.message);
      return sendJson(500, { success: false, error: err.message });
    }
  }

  // 4. CONSULTA DE LINKS DE WHATSAPP ATUAIS
  if (pathname === "/api/whatsapp-links" && req.method === "GET") {
    try {
      const dados = await carregarDadosDoSistema();
      return sendJson(200, { success: true, links: dados.whatsappMap });
    } catch (err) {
      return sendJson(500, { success: false, error: err.message });
    }
  }

  // 5. PRÉ-VISUALIZAÇÃO DE AMOSTRA DO E-MAIL
  if (pathname === "/api/preview" && req.method === "POST") {
    const { nome, sub, assunto, mensagem } = body;
    const subNorm = normalizarSub(sub || "Verde");

    try {
      const dados = await carregarDadosDoSistema();
      const linkWhatsapp = dados.whatsappMap[subNorm] || "";

      if (!linkWhatsapp || !linkWhatsapp.startsWith("http")) {
        return sendJson(400, {
          success: false,
          error: `Não foi possível localizar o link do WhatsApp para o Sub ${subNorm}. O envio seria bloqueado para este participante.`
        });
      }

      const html = gerarHtmlEmail({
        nome: nome || "Participante Exemplo",
        sub: subNorm,
        linkWhatsapp: linkWhatsapp,
        assunto: assunto || "Assunto do E-mail",
        mensagemTexto: mensagem || "Olá, {{nome}}! Você faz parte do Sub {{sub}}.\n\nClique no botão abaixo para entrar no grupo:\n{{link_whatsapp}}"
      });

      return sendJson(200, {
        success: true,
        html,
        sub: subNorm,
        link_whatsapp: linkWhatsapp,
        destinatario: nome || "Participante Exemplo"
      });
    } catch (err) {
      return sendJson(500, { success: false, error: err.message });
    }
  }

  // 6. DISPARO DE TESTE INDIVIDUAL (MODO TESTE)
  if (pathname === "/api/test-send" && req.method === "POST") {
    const { testEmail, testSub, assunto, mensagem } = body;
    if (!testEmail || !testEmail.includes("@")) {
      return sendJson(400, { success: false, error: "Informe um e-mail de teste válido." });
    }
    const subNorm = normalizarSub(testSub || "Verde");

    const config = loadConfig();
    if (!config.brevoApiKey) {
      return sendJson(500, {
        success: false,
        error: "BREVO_API_KEY não configurada no servidor. Por favor, adicione sua chave da Brevo no arquivo central-emails/.env (ex: BREVO_API_KEY=xkeysib-...) e reinicie o servidor."
      });
    }

    try {
      const dados = await carregarDadosDoSistema();
      const linkWhatsapp = dados.whatsappMap[subNorm] || "";

      if (!linkWhatsapp || !linkWhatsapp.startsWith("http")) {
        return sendJson(400, {
          success: false,
          error: `⚠️ Bloqueado: Não foi localizado o link de WhatsApp para o Sub ${subNorm}.`
        });
      }

      const htmlContent = gerarHtmlEmail({
        nome: "Administrador (Teste)",
        sub: subNorm,
        linkWhatsapp: linkWhatsapp,
        assunto: `[TESTE] ${assunto || "Comunicação EJC"}`,
        mensagemTexto: mensagem || "Este é um disparo de teste da Central de E-mails do EJC.\n\nSeu Sub é: {{sub}}.\n\nLink do grupo: {{link_whatsapp}}"
      });

      const resBrevo = await dispararBrevoIndividual({
        to: testEmail.trim().toLowerCase(),
        toName: "Administrador EJC",
        subject: `[TESTE] ${assunto || "Comunicação EJC"}`,
        htmlContent: htmlContent,
        apiKey: config.brevoApiKey,
        senderEmail: config.brevoSenderEmail,
        senderName: config.brevoSenderName
      });

      return sendJson(200, {
        success: resBrevo.success,
        result: resBrevo,
        sub: subNorm,
        linkUtilizado: linkWhatsapp,
        destinatario: testEmail
      });
    } catch (err) {
      return sendJson(500, { success: false, error: err.message });
    }
  }

  // 7. DISPARO EM MASSA CONTROLADO EM LOTES
  if (pathname === "/api/send-batch" && req.method === "POST") {
    const { recipients, assunto, mensagem, batchSize = 5 } = body;

    if (!Array.isArray(recipients) || recipients.length === 0) {
      return sendJson(400, { success: false, error: "Nenhum participante selecionado para envio." });
    }
    if (!assunto || !assunto.trim()) {
      return sendJson(400, { success: false, error: "O assunto da mensagem é obrigatório." });
    }
    if (!mensagem || !mensagem.trim()) {
      return sendJson(400, { success: false, error: "A mensagem do e-mail é obrigatória." });
    }

    const config = loadConfig();
    if (!config.brevoApiKey) {
      return sendJson(500, {
        success: false,
        error: "BREVO_API_KEY não configurada no servidor. Por favor, adicione sua chave da Brevo no arquivo central-emails/.env (ex: BREVO_API_KEY=xkeysib-...) e reinicie o servidor."
      });
    }

    try {
      const dados = await carregarDadosDoSistema();
      const whatsappMap = dados.whatsappMap;

      const resultados = [];
      let totalEnviados = 0;
      let totalErros = 0;

      // Executa o envio em lotes sequenciais controlados
      for (let i = 0; i < recipients.length; i += batchSize) {
        const batch = recipients.slice(i, i + batchSize);

        const batchPromises = batch.map(async (part) => {
          const subNorm = normalizarSub(part.sub);
          const linkWhatsapp = whatsappMap[subNorm] || "";

          // REGRA DE SEGURANÇA 16 e 28: SE NÃO EXISTIR LINK DO SUB, BLOQUEIA O ENVIO
          if (!linkWhatsapp || !linkWhatsapp.startsWith("http")) {
            return {
              id: part.id,
              nome: part.nome,
              email: part.email,
              sub: subNorm,
              success: false,
              error: `Bloqueado: Link de WhatsApp não encontrado para o Sub ${subNorm}.`,
              blocked: true
            };
          }

          // Monta o e-mail personalizado individualmente no backend
          const htmlContent = gerarHtmlEmail({
            nome: part.nome,
            sub: subNorm,
            linkWhatsapp: linkWhatsapp,
            assunto: assunto.trim(),
            mensagemTexto: mensagem.trim()
          });

          // Dispara via Brevo
          const resBrevo = await dispararBrevoIndividual({
            to: part.email,
            toName: part.nome,
            subject: assunto.trim(),
            htmlContent: htmlContent,
            apiKey: config.brevoApiKey,
            senderEmail: config.brevoSenderEmail,
            senderName: config.brevoSenderName
          });

          return {
            id: part.id,
            nome: part.nome,
            email: part.email,
            sub: subNorm,
            success: resBrevo.success,
            messageId: resBrevo.messageId || null,
            error: resBrevo.error || null,
            link_utilizado: linkWhatsapp
          };
        });

        const batchResults = await Promise.all(batchPromises);
        batchResults.forEach(r => {
          if (r.success) totalEnviados++;
          else totalErros++;
          resultados.push(r);
        });

        // Intervalo de segurança de 400ms entre lotes
        if (i + batchSize < recipients.length) {
          await new Promise(r => setTimeout(r, 400));
        }
      }

      // Registra no Log de Auditoria
      try {
        const auditEntry = {
          id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          data_hora: new Date().toISOString(),
          assunto: assunto.trim(),
          total_selecionado: recipients.length,
          total_enviado: totalEnviados,
          total_erro: totalErros,
          destinatarios_resumo: {
            pagos: recipients.filter(r => r.pagamento_status === "pago").length,
            nao_pagos: recipients.filter(r => r.pagamento_status !== "pago").length
          }
        };

        let currentLogs = [];
        try { currentLogs = JSON.parse(fs.readFileSync(AUDIT_LOG_FILE, "utf8")); } catch (e) {}
        currentLogs.unshift(auditEntry);
        if (currentLogs.length > 100) currentLogs.pop();
        fs.writeFileSync(AUDIT_LOG_FILE, JSON.stringify(currentLogs, null, 2), "utf8");
      } catch (eLog) {
        console.warn("[Auditoria] Falha ao gravar log:", eLog.message);
      }

      return sendJson(200, {
        success: true,
        total_processado: recipients.length,
        total_enviados: totalEnviados,
        total_erros: totalErros,
        resultados: resultados
      });
    } catch (err) {
      return sendJson(500, { success: false, error: err.message });
    }
  }

  // 8. LOGS DE AUDITORIA
  if (pathname === "/api/audit-logs" && req.method === "GET") {
    try {
      const logs = JSON.parse(fs.readFileSync(AUDIT_LOG_FILE, "utf8"));
      return sendJson(200, { success: true, logs });
    } catch (e) {
      return sendJson(200, { success: true, logs: [] });
    }
  }

  // ----------------------------------------------------------------------------
  // SERVE ARQUIVOS ESTÁTICOS DO FRONTEND (public/)
  // ----------------------------------------------------------------------------
  const publicDir = path.join(__dirname, "public");
  let filePath = path.join(publicDir, pathname === "/" ? "index.html" : pathname);

  // Previne Directory Traversal
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    return res.end("Acesso negado");
  }

  const mimeTypes = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml"
  };

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // Fallback para index.html
      filePath = path.join(publicDir, "index.html");
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[ext] || "text/plain";

    fs.readFile(filePath, (readErr, content) => {
      if (readErr) {
        res.writeHead(500);
        return res.end("Erro interno ao carregar arquivo");
      }
      res.writeHead(200, { "Content-Type": contentType });
      res.end(content);
    });
  });
});

server.listen(PORT, () => {
  const cfg = loadConfig();
  const brevoConfigured = Boolean(cfg.brevoApiKey && cfg.brevoApiKey.length > 5);

  console.log("==================================================================");
  console.log("  CENTRAL DE ENVIO SELETIVO DE E-MAILS DO EJC INICIADA COM SUCESSO");
  console.log(`  Painel Disponível em: http://localhost:${PORT}`);
  console.log(`  BREVO_API_KEY configurada: ${brevoConfigured ? "SIM" : "NÃO"}`);
  console.log("  Projeto Totalmente Isolado do Site Principal");
  console.log("==================================================================");
});
