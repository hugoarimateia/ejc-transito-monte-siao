// ==============================================================================
// SCRIPT DE BUILD DE VARIÁVEIS DE AMBIENTE - VERCEL DEPLOY
// ==============================================================================
const fs = require("fs");
const path = require("path");

console.log("[Build] Gerando js/env-config.js a partir das variáveis de ambiente...");

// Lê variáveis da Vercel / process.env com fallbacks seguros
const config = {
  SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "https://yggikbshdvnouaoxafcr.supabase.co",
  SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || "sb_publishable_YiY0CCW6qw4r4G2GXgiD9g_2s7gO-R5",
  PIX_CHAVE: process.env.NEXT_PUBLIC_PIX_CHAVE || "leoeuler03@gmail.com",
  PIX_TIPO_CHAVE: process.env.NEXT_PUBLIC_PIX_TIPO_CHAVE || "EMAIL",
  PIX_BENEFICIARIO: process.env.NEXT_PUBLIC_PIX_BENEFICIARIO || "EJC TRANSITO MONTE SIAO",
  PIX_CIDADE: process.env.NEXT_PUBLIC_PIX_CIDADE || "CAMPINA GRANDE",
  PIX_VALOR_INSCRICAO: Number(process.env.NEXT_PUBLIC_PIX_VALOR_INSCRICAO || 50.00),
  PIX_EXPIRACAO_MINUTOS: Number(process.env.NEXT_PUBLIC_PIX_EXPIRACAO_MINUTOS || 15),
  WHATSAPP_VERDE: process.env.NEXT_PUBLIC_WHATSAPP_VERDE || "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=verde",
  WHATSAPP_VERMELHO: process.env.NEXT_PUBLIC_WHATSAPP_VERMELHO || "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=vermelho",
  WHATSAPP_AMARELO: process.env.NEXT_PUBLIC_WHATSAPP_AMARELO || "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=amarelo",
  WHATSAPP_AZUL: process.env.NEXT_PUBLIC_WHATSAPP_AZUL || "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=azul",
  WHATSAPP_GERAL: process.env.NEXT_PUBLIC_WHATSAPP_GERAL || "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?s=cl&p=i&mlu=0"
};

const outputContent = `// Arquivo gerado automaticamente durante o build da Vercel
// Não edite este arquivo manualmente.
window.EJC_ENV = ${JSON.stringify(config, null, 2)};

// Injeta nas variáveis globais do sistema
if (window.EJC_ENV.SUPABASE_URL) window.EJC_SUPABASE_URL = window.EJC_ENV.SUPABASE_URL;
if (window.EJC_ENV.SUPABASE_ANON_KEY) window.EJC_SUPABASE_ANON_KEY = window.EJC_ENV.SUPABASE_ANON_KEY;

window.EJC_PIX_CONFIG = {
  chave: window.EJC_ENV.PIX_CHAVE,
  tipoChave: window.EJC_ENV.PIX_TIPO_CHAVE,
  beneficiario: window.EJC_ENV.PIX_BENEFICIARIO,
  cidade: window.EJC_ENV.PIX_CIDADE,
  identificadorPadrao: "EJCTRANSITO",
  valorTaxaInscricao: window.EJC_ENV.PIX_VALOR_INSCRICAO,
  tempoExpiracaoMinutos: window.EJC_ENV.PIX_EXPIRACAO_MINUTOS
};

window.EJC_WHATSAPP_SUBS = {
  "Verde": window.EJC_ENV.WHATSAPP_VERDE,
  "Vermelho": window.EJC_ENV.WHATSAPP_VERMELHO,
  "Amarelo": window.EJC_ENV.WHATSAPP_AMARELO,
  "Azul": window.EJC_ENV.WHATSAPP_AZUL,
  "Geral": window.EJC_ENV.WHATSAPP_GERAL
};
`;

const outputPath = path.join(__dirname, "..", "js", "env-config.js");
fs.writeFileSync(outputPath, outputContent, "utf8");
console.log(`[Build] Arquivo gravado com sucesso em: ${outputPath}`);
