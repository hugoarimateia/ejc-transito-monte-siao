// ==============================================================================
// VERCEL SERVERLESS FUNCTION: /api/config
// Retorna a configuração pública oficial ativa (Preço atual, Chave PIX, WhatsApp)
// Sincronizado diretamente com _settings-store.js
// ==============================================================================

const settingsStore = require("./_settings-store");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-client-version");
  // Anti-cache estrito: propagação imediata de preços, lotes e chave PIX
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "https://yggikbshdvnouaoxafcr.supabase.co";
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || "sb_publishable_YiY0CCW6qw4r4G2GXgiD9g_2s7gO-R5";

  let activeData;
  try {
    activeData = await settingsStore.getActiveSettings();
  } catch (err) {
    console.warn("[Config API] Erro ao buscar do settings store:", err.message);
    activeData = settingsStore.getDefaultStore();
  }

  const s = activeData.settings;
  const w = activeData.whatsapp || {};
  const precoEfetivo = settingsStore.getEffectivePrice(s);

  const pixConfig = {
    chave: s.pix_chave,
    tipoChave: s.pix_tipo_chave,
    beneficiario: s.pix_beneficiario,
    cidade: s.pix_cidade,
    valorTaxaInscricao: Number(s.valor_inscricao),
    valor_inscricao: Number(s.valor_inscricao),
    precoEfetivo: Number(precoEfetivo),
    preco_efetivo: Number(precoEfetivo),
    loteAtual: s.lote_atual,
    lote_atual: s.lote_atual,
    valorPromocional: s.valor_promocional ? Number(s.valor_promocional) : null,
    valor_promocional: s.valor_promocional ? Number(s.valor_promocional) : null,
    taxaAdicional: Number(s.taxa_adicional || 0),
    taxa_adicional: Number(s.taxa_adicional || 0),
    maxParcelas: Number(s.max_parcelas || 12),
    max_parcelas: Number(s.max_parcelas || 12),
    versao: s.versao,
    tempoExpiracaoMinutos: Number(process.env.NEXT_PUBLIC_PIX_EXPIRACAO_MINUTOS || 15)
  };

  const whatsappConfig = {
    verde: w.verde || process.env.NEXT_PUBLIC_WHATSAPP_VERDE || "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=verde",
    vermelho: w.vermelho || process.env.NEXT_PUBLIC_WHATSAPP_VERMELHO || "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=vermelho",
    amarelo: w.amarelo || process.env.NEXT_PUBLIC_WHATSAPP_AMARELO || "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=amarelo",
    azul: w.azul || process.env.NEXT_PUBLIC_WHATSAPP_AZUL || "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=azul",
    geral: w.geral || process.env.NEXT_PUBLIC_WHATSAPP_GERAL || "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?s=cl&p=i&mlu=0"
  };

  return res.status(200).json({
    success: true,
    versao: s.versao,
    supabaseUrl,
    supabaseAnonKey,
    preco_efetivo: precoEfetivo,
    precoEfetivo: precoEfetivo,
    valor_inscricao: pixConfig.valor_inscricao,
    valor_promocional: pixConfig.valor_promocional,
    taxa_adicional: pixConfig.taxa_adicional,
    max_parcelas: pixConfig.max_parcelas,
    lote_atual: pixConfig.lote_atual,
    pix_chave: pixConfig.chave,
    pix_beneficiario: pixConfig.beneficiario,
    pix_cidade: pixConfig.cidade,
    pix: pixConfig,
    whatsapp: whatsappConfig
  });
};
