// ==============================================================================
// VERCEL SERVERLESS FUNCTION: /api/config
// Retorna a configuração pública oficial ativa (Preço atual, Chave PIX, WhatsApp)
// ==============================================================================

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  // Cache curto de 5s para propagar alterações de preço/PIX quase instantaneamente
  res.setHeader("Cache-Control", "public, s-maxage=5, stale-while-revalidate=10");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "https://yggikbshdvnouaoxafcr.supabase.co";
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || "sb_publishable_YiY0CCW6qw4r4G2GXgiD9g_2s7gO-R5";
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || supabaseAnonKey;

  // Valores padrão de fallback
  let pixConfig = {
    chave: process.env.NEXT_PUBLIC_PIX_CHAVE || "leoeuler03@gmail.com",
    tipoChave: process.env.NEXT_PUBLIC_PIX_TIPO_CHAVE || "EMAIL",
    beneficiario: process.env.NEXT_PUBLIC_PIX_BENEFICIARIO || "EJC TRANSITO MONTE SIAO",
    cidade: process.env.NEXT_PUBLIC_PIX_CIDADE || "CAMPINA GRANDE",
    valorTaxaInscricao: Number(process.env.NEXT_PUBLIC_PIX_VALOR_INSCRICAO || 50.00),
    valor_inscricao: Number(process.env.NEXT_PUBLIC_PIX_VALOR_INSCRICAO || 50.00),
    loteAtual: "1º Lote",
    lote_atual: "1º Lote",
    valorPromocional: null,
    tempoExpiracaoMinutos: Number(process.env.NEXT_PUBLIC_PIX_EXPIRACAO_MINUTOS || 15)
  };

  let whatsappConfig = {
    verde: process.env.NEXT_PUBLIC_WHATSAPP_VERDE || "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=verde",
    vermelho: process.env.NEXT_PUBLIC_WHATSAPP_VERMELHO || "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=vermelho",
    amarelo: process.env.NEXT_PUBLIC_WHATSAPP_AMARELO || "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=amarelo",
    azul: process.env.NEXT_PUBLIC_WHATSAPP_AZUL || "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=azul",
    geral: process.env.NEXT_PUBLIC_WHATSAPP_GERAL || "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?s=cl&p=i&mlu=0"
  };

  // Busca configuração financeira ativa no Supabase
  if (supabaseUrl && supabaseServiceKey) {
    try {
      const finRes = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/configuracoes_financeiras?ativo=eq.true&order=versao.desc&limit=1`, {
        headers: { "apikey": supabaseServiceKey, "Authorization": `Bearer ${supabaseServiceKey}` }
      });
      if (finRes.ok) {
        const finData = await finRes.json();
        if (finData && finData.length > 0) {
          const c = finData[0];
          pixConfig.chave = c.pix_chave || pixConfig.chave;
          pixConfig.tipoChave = c.pix_tipo_chave || pixConfig.tipoChave;
          pixConfig.beneficiario = c.pix_beneficiario || pixConfig.beneficiario;
          pixConfig.cidade = c.pix_cidade || pixConfig.cidade;
          pixConfig.valorTaxaInscricao = Number(c.valor_inscricao || pixConfig.valorTaxaInscricao);
          pixConfig.valor_inscricao = pixConfig.valorTaxaInscricao;
          pixConfig.loteAtual = c.lote_atual || pixConfig.loteAtual;
          pixConfig.lote_atual = pixConfig.loteAtual;
          pixConfig.valorPromocional = c.valor_promocional ? Number(c.valor_promocional) : null;
        }
      }

      // Busca links atualizados do WhatsApp
      const wppRes = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/configuracoes_whatsapp?ativo=eq.true`, {
        headers: { "apikey": supabaseServiceKey, "Authorization": `Bearer ${supabaseServiceKey}` }
      });
      if (wppRes.ok) {
        const wppData = await wppRes.json();
        if (wppData && wppData.length > 0) {
          wppData.forEach(w => {
            const subKey = String(w.sub || "").toLowerCase();
            if (whatsappConfig[subKey] !== undefined) {
              whatsappConfig[subKey] = w.link_grupo;
            }
          });
        }
      }
    } catch (err) {
      console.warn("[Config API] Fallback para variáveis de ambiente:", err.message);
    }
  }

  return res.status(200).json({
    supabaseUrl,
    supabaseAnonKey,
    pix: pixConfig,
    whatsapp: whatsappConfig
  });
};
