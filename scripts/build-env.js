// ==============================================================================
// SCRIPT DE BUILD DE VARIÁVEIS DE AMBIENTE - VERCEL DEPLOY
// ==============================================================================
const fs = require("fs");
const path = require("path");

console.log("[Build] Gerando js/env-config.js a partir das variáveis de ambiente...");

function normalizarChavePix(chave, tipo) {
  let c = String(chave || "").trim();
  if (!c || c.includes("***")) return c;
  const tipoUpper = String(tipo || "").toUpperCase();
  const digitsOnly = c.replace(/\D/g, "");
  const isTelefone = tipoUpper === "TELEFONE" ||
    c.startsWith("+55") ||
    (!c.includes("@") && !c.includes("-") && (digitsOnly.length === 12 || digitsOnly.length === 13) && digitsOnly.startsWith("55"));

  if (isTelefone) {
    if ((digitsOnly.length === 13 || digitsOnly.length === 12) && digitsOnly.startsWith("55")) {
      return digitsOnly.substring(2);
    }
    if (digitsOnly.length === 10 || digitsOnly.length === 11) {
      return digitsOnly;
    }
    if (c.startsWith("+55")) {
      const stripped = digitsOnly.startsWith("55") ? digitsOnly.substring(2) : digitsOnly;
      if (stripped.length === 10 || stripped.length === 11) {
        return stripped;
      }
    }
  }
  return c;
}

const rawPixTipo = process.env.NEXT_PUBLIC_PIX_TIPO_CHAVE || "";
const rawPixChave = process.env.NEXT_PUBLIC_PIX_CHAVE || "";
const normPixChave = rawPixChave ? normalizarChavePix(rawPixChave, rawPixTipo) : null;

// Lê variáveis da Vercel / process.env com fallbacks seguros do projeto
const config = {
  SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "https://guppedddwnuvluhiaaas.supabase.co",
  SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || "sb_publishable_QJV9XI3sN3P_gVtiQ2ObRg_gpSSKc-i",
  PIX_CHAVE: normPixChave,
  PIX_TIPO_CHAVE: rawPixTipo || null,
  PIX_BENEFICIARIO: process.env.NEXT_PUBLIC_PIX_BENEFICIARIO || null,
  PIX_CIDADE: process.env.NEXT_PUBLIC_PIX_CIDADE || null,
  PIX_VALOR_INSCRICAO: process.env.NEXT_PUBLIC_PIX_VALOR_INSCRICAO ? Number(process.env.NEXT_PUBLIC_PIX_VALOR_INSCRICAO) : null,
  PIX_EXPIRACAO_MINUTOS: Number(process.env.NEXT_PUBLIC_PIX_EXPIRACAO_MINUTOS || 15),
  WHATSAPP_VERDE: process.env.NEXT_PUBLIC_WHATSAPP_VERDE || "",
  WHATSAPP_VERMELHO: process.env.NEXT_PUBLIC_WHATSAPP_VERMELHO || "",
  WHATSAPP_AMARELO: process.env.NEXT_PUBLIC_WHATSAPP_AMARELO || "",
  WHATSAPP_LARANJA: process.env.NEXT_PUBLIC_WHATSAPP_LARANJA || "",
  WHATSAPP_GERAL: process.env.NEXT_PUBLIC_WHATSAPP_GERAL || "",
  MERCADO_PAGO_PUBLIC_KEY: (
    process.env.NEXT_PUBLIC_MERCADO_PAGO_PUBLIC_KEY ||
    process.env.MERCADO_PAGO_PUBLIC_KEY ||
    process.env.NEXT_PUBLIC_MERCADOPAGO_PUBLIC_KEY ||
    process.env.MERCADOPAGO_PUBLIC_KEY ||
    process.env.NEXT_PUBLIC_MP_PUBLIC_KEY ||
    process.env.MP_PUBLIC_KEY ||
    process.env.MP_KEY ||
    process.env.PUBLIC_KEY ||
    ""
  ).trim()
};

const outputContent = `// Arquivo gerado automaticamente durante o build da Vercel
// Não edite este arquivo manualmente.
window.EJC_ENV = ${JSON.stringify(config, null, 2)};

// Injeta nas variáveis globais do sistema
if (window.EJC_ENV.SUPABASE_URL) window.EJC_SUPABASE_URL = window.EJC_ENV.SUPABASE_URL;
if (window.EJC_ENV.SUPABASE_ANON_KEY) window.EJC_SUPABASE_ANON_KEY = window.EJC_ENV.SUPABASE_ANON_KEY;

// Inicializa estruturas runtime limpas (dados de negócio oficiais virão do Supabase)
window.EJC_PIX_CONFIG = window.EJC_PIX_CONFIG || {
  chave: window.EJC_ENV.PIX_CHAVE || null,
  tipoChave: window.EJC_ENV.PIX_TIPO_CHAVE || null,
  beneficiario: window.EJC_ENV.PIX_BENEFICIARIO || null,
  cidade: window.EJC_ENV.PIX_CIDADE || null,
  identificadorPadrao: "EJCTRANSITO",
  valorTaxaInscricao: window.EJC_ENV.PIX_VALOR_INSCRICAO || null,
  tempoExpiracaoMinutos: window.EJC_ENV.PIX_EXPIRACAO_MINUTOS || 15
};

window.EJC_WHATSAPP_SUBS = window.EJC_WHATSAPP_SUBS || {
  "Verde": window.EJC_ENV.WHATSAPP_VERDE || "",
  "Vermelho": window.EJC_ENV.WHATSAPP_VERMELHO || "",
  "Amarelo": window.EJC_ENV.WHATSAPP_AMARELO || "",
  "Laranja": window.EJC_ENV.WHATSAPP_LARANJA || "",
  "Geral": window.EJC_ENV.WHATSAPP_GERAL || ""
};
`;

const outputPath = path.join(__dirname, "..", "js", "env-config.js");
fs.writeFileSync(outputPath, outputContent, "utf8");
console.log(`[Build] Arquivo gravado com sucesso em: ${outputPath}`);
