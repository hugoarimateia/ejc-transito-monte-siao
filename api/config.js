// ==============================================================================
// VERCEL SERVERLESS FUNCTION: /api/config
// Retorna a configuração pública do sistema com cabeçalhos de segurança e cache
// ==============================================================================

module.exports = (req, res) => {
  // Configura CORS para permitir chamadas do próprio domínio e de previews da Vercel
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const publicConfig = {
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "https://yggikbshdvnouaoxafcr.supabase.co",
    supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || "sb_publishable_YiY0CCW6qw4r4G2GXgiD9g_2s7gO-R5",
    pix: {
      chave: process.env.NEXT_PUBLIC_PIX_CHAVE || "leoeuler03@gmail.com",
      tipoChave: process.env.NEXT_PUBLIC_PIX_TIPO_CHAVE || "EMAIL",
      beneficiario: process.env.NEXT_PUBLIC_PIX_BENEFICIARIO || "EJC TRANSITO MONTE SIAO",
      cidade: process.env.NEXT_PUBLIC_PIX_CIDADE || "CAMPINA GRANDE",
      valorTaxaInscricao: Number(process.env.NEXT_PUBLIC_PIX_VALOR_INSCRICAO || 50.00),
      tempoExpiracaoMinutos: Number(process.env.NEXT_PUBLIC_PIX_EXPIRACAO_MINUTOS || 15)
    },
    whatsapp: {
      verde: process.env.NEXT_PUBLIC_WHATSAPP_VERDE || "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=verde",
      vermelho: process.env.NEXT_PUBLIC_WHATSAPP_VERMELHO || "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=vermelho",
      amarelo: process.env.NEXT_PUBLIC_WHATSAPP_AMARELO || "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=amarelo",
      azul: process.env.NEXT_PUBLIC_WHATSAPP_AZUL || "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=azul",
      geral: process.env.NEXT_PUBLIC_WHATSAPP_GERAL || "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?s=cl&p=i&mlu=0"
    }
  };

  return res.status(200).json(publicConfig);
};
