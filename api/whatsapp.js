// ==============================================================================
// VERCEL SERVERLESS FUNCTION: /api/whatsapp
// Validação de token de inscrição e redirecionamento para o grupo de WhatsApp do Sub
// ==============================================================================

const SUB_GROUPS = {
  "Verde": process.env.NEXT_PUBLIC_WHATSAPP_VERDE || "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=verde",
  "Vermelho": process.env.NEXT_PUBLIC_WHATSAPP_VERMELHO || "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=vermelho",
  "Amarelo": process.env.NEXT_PUBLIC_WHATSAPP_AMARELO || "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=amarelo",
  "Azul": process.env.NEXT_PUBLIC_WHATSAPP_AZUL || "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=azul",
  "Geral": process.env.NEXT_PUBLIC_WHATSAPP_GERAL || "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?s=cl&p=i&mlu=0"
};

module.exports = async (req, res) => {
  const token = req.query.t || req.query.token;

  if (!token) {
    return res.redirect(302, SUB_GROUPS["Geral"]);
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (supabaseUrl && supabaseKey) {
    try {
      const response = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/inscricoes?token_acesso=eq.${encodeURIComponent(token)}&select=sub`, {
        headers: {
          "apikey": supabaseKey,
          "Authorization": `Bearer ${supabaseKey}`
        }
      });

      if (response.ok) {
        const data = await response.json();
        if (data && data.length > 0 && data[0].sub) {
          const subName = data[0].sub;
          // Tenta obter o link administrável do Sub
          try {
            const confRes = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/configuracoes_whatsapp?sub=eq.${encodeURIComponent(subName)}&select=link_grupo,ativo`, {
              headers: {
                "apikey": supabaseKey,
                "Authorization": `Bearer ${supabaseKey}`
              }
            });
            if (confRes.ok) {
              const confData = await confRes.json();
              if (confData && confData.length > 0 && confData[0].ativo && confData[0].link_grupo) {
                return res.redirect(302, confData[0].link_grupo);
              }
            }
          } catch(e) {}

          const targetUrl = SUB_GROUPS[subName] || SUB_GROUPS["Geral"];
          return res.redirect(302, targetUrl);
        }
      }
    } catch (err) {
      console.error("[WhatsApp Redirect Error]", err);
    }
  }

  // Fallback para grupo geral se não encontrar token específico
  return res.redirect(302, SUB_GROUPS["Geral"]);
};
