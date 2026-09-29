// ==============================================================================
// CONFIGURAÇÃO PÚBLICA DO SISTEMA - EJC TRÂNSITO MONTE SIÃO
// ==============================================================================

// 1. Configuração do Supabase
// Os valores reais precisam ser configurados via variáveis de ambiente do servidor.
window.EJC_SUPABASE_URL = "";
window.EJC_SUPABASE_ANON_KEY = "";

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
