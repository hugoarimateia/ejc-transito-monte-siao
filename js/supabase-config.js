// ==============================================================================
// CONFIGURAÇÃO PÚBLICA DO SISTEMA - EJC TRÂNSITO MONTE SIÃO
// ==============================================================================

// 1. Configuração do Supabase
// Coloque aqui a URL do seu projeto Supabase e a chave pública (anon key).
// O script SQL completo para criação do banco está no arquivo: supabase-schema.sql
window.EJC_SUPABASE_URL = "https://yggikbshdvnouaoxafcr.supabase.co";
window.EJC_SUPABASE_ANON_KEY = "sb_publishable_YiY0CCW6qw4r4G2GXgiD9g_2s7gO-R5";

// 2. Configuração do Pix Dinâmico (Padrão Banco Central / BR Code)
// Dados oficiais da coordenação para recebimento das contribuições e inscrições.
window.EJC_PIX_CONFIG = {
  chave: "leoeuler03@gmail.com",       // Chave Pix da coordenação (e-mail, telefone, CPF ou EVP)
  tipoChave: "EMAIL",                 // EMAIL, TELEFONE, CPF ou EVP
  beneficiario: "EJC TRANSITO MONTE SIAO", // Nome do favorecido (máx 25 chars, sem acentos no EMV)
  cidade: "CAMPINA GRANDE",           // Cidade do recebedor (sem acentos no EMV)
  identificadorPadrao: "EJCTRANSITO", // Identificador padrão da transação
  valorTaxaInscricao: 50.00,          // Valor padrão da taxa de inscrição em R$
  tempoExpiracaoMinutos: 15           // Tempo de expiração do Pix dinâmico (15 minutos)
};

// 3. Configurações dos Grupos de WhatsApp por Sub
window.EJC_WHATSAPP_SUBS = {
  "Verde": "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=verde",
  "Vermelho": "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=vermelho",
  "Amarelo": "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=amarelo",
  "Laranja": "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=laranja",
  "Azul": "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=laranja",
  "Geral": "https://chat.whatsapp.com/DbOLDVcXTal2YJmDuTexqX?mode=gi_t"
};
