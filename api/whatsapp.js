// ==============================================================================
// VERCEL SERVERLESS FUNCTION: /api/whatsapp
// Validação de token de inscrição e redirecionamento para o grupo de WhatsApp do Sub
// Fonte Oficial: Supabase (configuracoes_whatsapp) / Settings Store
// Zero Hardcoded Defaults: Se não configurado, redireciona com mensagem informativa
// ==============================================================================

const settingsStore = require("./_settings-store");

module.exports = async (req, res) => {
  const token = req.query.t || req.query.token;

  let activeData = null;
  try {
    activeData = await settingsStore.getActiveSettings();
  } catch (e) {
    activeData = settingsStore.getDefaultStore();
  }

  const wppMap = (activeData && activeData.whatsapp) ? activeData.whatsapp : {};

  // Se não foi fornecido token, tenta redirecionar para o Grupo Geral oficial
  if (!token) {
    const geralLink = wppMap["Geral"] || wppMap["geral"];
    if (geralLink && typeof geralLink === "string" && geralLink.startsWith("http")) {
      return res.redirect(302, geralLink);
    }
    return res.redirect(302, "/?msg=whatsapp_aguardando_configuracao");
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
          let subName = data[0].sub;
          if (subName === "Azul") subName = "Laranja";

          // 1. Tenta tabela configuracoes_whatsapp via Supabase diretamente
          try {
            const confRes = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/configuracoes_whatsapp?sub=ilike.${encodeURIComponent(subName)}&ativo=eq.true&select=link_grupo`, {
              headers: {
                "apikey": supabaseKey,
                "Authorization": `Bearer ${supabaseKey}`
              }
            });
            if (confRes.ok) {
              const confData = await confRes.json();
              if (confData && confData.length > 0 && confData[0].link_grupo && confData[0].link_grupo.startsWith("http")) {
                return res.redirect(302, confData[0].link_grupo);
              }
            }
          } catch(e) {}

          // 2. Tenta store central
          const link = wppMap[subName] || wppMap[subName.toLowerCase()];
          if (link && typeof link === "string" && link.startsWith("http")) {
            return res.redirect(302, link);
          }
        }
      }
    } catch (err) {
      console.error("[WhatsApp Redirect Error]", err);
    }
  }

  // Fallback para Grupo Geral se existir
  const geralLink = wppMap["Geral"] || wppMap["geral"];
  if (geralLink && typeof geralLink === "string" && geralLink.startsWith("http")) {
    return res.redirect(302, geralLink);
  }

  return res.redirect(302, "/?msg=whatsapp_aguardando_configuracao");
};
