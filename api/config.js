// ==============================================================================
// VERCEL SERVERLESS FUNCTION: /api/config
// Retorna a configuração pública oficial ativa (Preço atual, Chave PIX, WhatsApp)
// Sincronizado diretamente com _settings-store.js
// ==============================================================================

const settingsStore = require("./_settings-store");
const { applyCors } = require("./_cors");

module.exports = async (req, res) => {
  applyCors(req, res);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-client-version");
  // Anti-cache estrito: propagação imediata de preços, lotes e chave PIX
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "https://guppedddwnuvluhiaaas.supabase.co";
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || "sb_publishable_QJV9XI3sN3P_gVtiQ2ObRg_gpSSKc-i";
  const clientVersion = Number(req.headers["x-client-version"] || req.query?.v || 0);

  let activeData;
  try {
    activeData = await settingsStore.getActiveSettings();
  } catch (err) {
    console.warn("[Config API] Erro ao buscar do settings store:", err.message);
    activeData = settingsStore.getDefaultStore();
  }

  const s = activeData.settings;
  const isStaleReplica = clientVersion > 0 && Number(s.versao || 0) < clientVersion;
  const w = activeData.whatsapp || {};
  const precoEfetivo = settingsStore.getEffectivePrice(s);

  const isConfigured = Boolean(s.configurado || (s.valor_inscricao !== null && s.valor_inscricao !== undefined && Number(s.valor_inscricao) > 0));
  const valorInscricaoNum = (s.valor_inscricao !== null && s.valor_inscricao !== undefined) ? Number(s.valor_inscricao) : null;
  const precoEfetivoNum = precoEfetivo !== null ? Number(precoEfetivo) : null;

  const currentMod = s.modalidade_pix || s.pix_mode || "api_webhook";
  const pixConfig = {
    configurado: isConfigured,
    modalidade: currentMod,
    modalidade_pix: currentMod,
    pix_mode: currentMod,
    chave: s.pix_chave || null,
    tipoChave: s.pix_tipo_chave || null,
    beneficiario: s.pix_beneficiario || null,
    cidade: s.pix_cidade || null,
    instrucoesManual: s.pix_instrucoes_manual || "",
    pix_instrucoes_manual: s.pix_instrucoes_manual || "",
    permiteComprovante: s.pix_permite_comprovante !== false,
    pix_permite_comprovante: s.pix_permite_comprovante !== false,
    valorTaxaInscricao: valorInscricaoNum,
    valor_inscricao: valorInscricaoNum,
    precoEfetivo: precoEfetivoNum,
    preco_efetivo: precoEfetivoNum,
    loteAtual: s.lote_atual || "Aguardando Coordenação",
    lote_atual: s.lote_atual || "Aguardando Coordenação",
    valorPromocional: s.valor_promocional ? Number(s.valor_promocional) : null,
    valor_promocional: s.valor_promocional ? Number(s.valor_promocional) : null,
    taxaAdicional: Number(s.taxa_adicional || 0),
    taxa_adicional: Number(s.taxa_adicional || 0),
    maxParcelas: Number(s.max_parcelas || 12),
    max_parcelas: Number(s.max_parcelas || 12),
    versao: s.versao,
    tempoExpiracaoMinutos: Number(process.env.NEXT_PUBLIC_PIX_EXPIRACAO_MINUTOS || 15)
  };

  const verde = (w.Verde || w.verde || process.env.NEXT_PUBLIC_WHATSAPP_VERDE || "").trim();
  const vermelho = (w.Vermelho || w.vermelho || process.env.NEXT_PUBLIC_WHATSAPP_VERMELHO || "").trim();
  const amarelo = (w.Amarelo || w.amarelo || process.env.NEXT_PUBLIC_WHATSAPP_AMARELO || "").trim();
  const laranja = (w.Laranja || w.laranja || process.env.NEXT_PUBLIC_WHATSAPP_LARANJA || "").trim();
  const geral = (w.Geral || w.geral || process.env.NEXT_PUBLIC_WHATSAPP_GERAL || "").trim();

  const whatsappConfig = {
    verde,
    vermelho,
    amarelo,
    laranja,
    geral,
    Verde: verde,
    Vermelho: vermelho,
    Amarelo: amarelo,
    Laranja: laranja,
    Geral: geral
  };

  return res.status(200).json({
    success: true,
    configurado: isConfigured,
    versao: s.versao,
    is_stale_replica: isStaleReplica,
    supabaseUrl,
    supabaseAnonKey,
    preco_efetivo: precoEfetivoNum,
    precoEfetivo: precoEfetivoNum,
    valor_inscricao: valorInscricaoNum,
    valor_promocional: pixConfig.valor_promocional,
    taxa_adicional: pixConfig.taxa_adicional,
    max_parcelas: pixConfig.max_parcelas,
    card_installment_mode: s.card_installment_mode || "mercado_pago",
    card_max_installments: Number(s.card_max_installments || s.max_parcelas || 6),
    card_installment_rates: Array.isArray(s.card_installment_rates) && s.card_installment_rates.length > 0
      ? s.card_installment_rates
      : (settingsStore.getDefaultCardRates ? settingsStore.getDefaultCardRates() : []),
    mp_public_key: (
      s.mp_public_key ||
      s.mercado_pago_public_key ||
      process.env.NEXT_PUBLIC_MERCADO_PAGO_PUBLIC_KEY ||
      process.env.MERCADO_PAGO_PUBLIC_KEY ||
      process.env.NEXT_PUBLIC_MERCADOPAGO_PUBLIC_KEY ||
      process.env.MERCADOPAGO_PUBLIC_KEY ||
      process.env.NEXT_PUBLIC_MP_PUBLIC_KEY ||
      process.env.MP_PUBLIC_KEY ||
      process.env.MP_KEY ||
      process.env.PUBLIC_KEY ||
      settingsStore.CANONICAL_MP_PUBLIC_KEY ||
      "APP_USR-39960bc1-2b08-4885-8090-31eaa38ba04b"
    ).trim(),
    mercado_pago_public_key: (
      s.mp_public_key ||
      s.mercado_pago_public_key ||
      process.env.NEXT_PUBLIC_MERCADO_PAGO_PUBLIC_KEY ||
      process.env.MERCADO_PAGO_PUBLIC_KEY ||
      process.env.NEXT_PUBLIC_MERCADOPAGO_PUBLIC_KEY ||
      process.env.MERCADOPAGO_PUBLIC_KEY ||
      process.env.NEXT_PUBLIC_MP_PUBLIC_KEY ||
      process.env.MP_PUBLIC_KEY ||
      process.env.MP_KEY ||
      process.env.PUBLIC_KEY ||
      settingsStore.CANONICAL_MP_PUBLIC_KEY ||
      "APP_USR-39960bc1-2b08-4885-8090-31eaa38ba04b"
    ).trim(),
    lote_atual: pixConfig.lote_atual,
    modalidade_pix: s.modalidade_pix || "api_webhook",
    pix_chave: pixConfig.chave,
    pix_beneficiario: pixConfig.beneficiario,
    pix_cidade: pixConfig.cidade,
    pix_instrucoes_manual: pixConfig.pix_instrucoes_manual,
    pix_permite_comprovante: pixConfig.pix_permite_comprovante,
    pix: pixConfig,
    whatsapp: whatsappConfig
  });
};
