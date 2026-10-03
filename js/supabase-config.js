// ==============================================================================
// CONFIGURAÇÃO PÚBLICA DO SISTEMA - EJC TRÂNSITO MONTE SIÃO
// ==============================================================================

// 1. Configuração do Supabase
window.EJC_SUPABASE_URL = window.EJC_SUPABASE_URL || "https://guppedddwnuvluhiaaas.supabase.co";
window.EJC_SUPABASE_ANON_KEY = window.EJC_SUPABASE_ANON_KEY || "sb_publishable_QJV9XI3sN3P_gVtiQ2ObRg_gpSSKc-i";

// 2. Configuração do Pix Dinâmico (Padrão Banco Central / BR Code)
// Valores oficiais serão carregados dinamicamente em runtime a partir do Supabase
window.EJC_PIX_CONFIG = window.EJC_PIX_CONFIG || {
  chave: null,
  tipoChave: null,
  beneficiario: null,
  cidade: null,
  identificadorPadrao: "EJCTRANSITO",
  valorTaxaInscricao: null,
  tempoExpiracaoMinutos: 15
};

// 3. Configurações dos Grupos de WhatsApp por Sub (carregados do Supabase)
window.EJC_WHATSAPP_SUBS = window.EJC_WHATSAPP_SUBS || {
  "Verde": "",
  "Vermelho": "",
  "Amarelo": "",
  "Laranja": "",
  "Geral": ""
};

// ==============================================================================
// 4. CUTOVER E ESTRATÉGIA DE ROLLBACK CENTRALIZADO (ETAPA 1C)
// Modo "supabase": consome as Supabase Edge Functions homologadas
// Modo "vercel": reverte instantaneamente para as Serverless Functions legadas (/api/*)
// ==============================================================================
window.EJC_BACKEND_MODE = window.EJC_BACKEND_MODE || "supabase";

window.EJC_ENDPOINTS = {
  config: function() {
    return window.EJC_BACKEND_MODE === "supabase"
      ? "https://guppedddwnuvluhiaaas.supabase.co/functions/v1/public-config"
      : "/api/config";
  },
  subCounts: function() {
    return window.EJC_BACKEND_MODE === "supabase"
      ? "https://guppedddwnuvluhiaaas.supabase.co/functions/v1/sub-counts"
      : "/api/sub-counts";
  },
  whatsapp: function(token) {
    const base = window.EJC_BACKEND_MODE === "supabase"
      ? "https://guppedddwnuvluhiaaas.supabase.co/functions/v1/whatsapp"
      : "/api/whatsapp";
    return token ? `${base}?token=${encodeURIComponent(token)}` : base;
  },
  r2PresignedUrl: function() {
    return "https://guppedddwnuvluhiaaas.supabase.co/functions/v1/r2-presigned-url";
  }
};

