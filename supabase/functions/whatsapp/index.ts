// ==============================================================================
// SUPABASE EDGE FUNCTION: whatsapp
// Validação de token de inscrição e redirecionamento dinâmico para o grupo do Sub
// Fonte Oficial Única: Supabase (configuracoes_whatsapp)
// ==============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {
  const url = new URL(req.url);
  const token = url.searchParams.get("t");

  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  );

  let targetSub = "Geral";

  if (token) {
    const { data: inscricao } = await supabaseAdmin
      .from("inscricoes")
      .select("sub")
      .eq("token_acesso", token)
      .maybeSingle();

    if (inscricao && inscricao.sub) {
      targetSub = (inscricao.sub === "Azul") ? "Laranja" : inscricao.sub;
    }
  }

  // Busca o link oficial persistido no banco
  const { data: config } = await supabaseAdmin
    .from("configuracoes_whatsapp")
    .select("link_grupo")
    .ilike("sub", targetSub)
    .eq("ativo", true)
    .maybeSingle();

  if (config && config.link_grupo && config.link_grupo.startsWith("http")) {
    return Response.redirect(config.link_grupo, 302);
  }

  // Fallback para Grupo Geral se sub não configurado
  if (targetSub !== "Geral") {
    const { data: geralConfig } = await supabaseAdmin
      .from("configuracoes_whatsapp")
      .select("link_grupo")
      .ilike("sub", "Geral")
      .eq("ativo", true)
      .maybeSingle();

    if (geralConfig && geralConfig.link_grupo && geralConfig.link_grupo.startsWith("http")) {
      return Response.redirect(geralConfig.link_grupo, 302);
    }
  }

  return new Response("Link do WhatsApp aguardando configuração pela coordenação.", {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
});
