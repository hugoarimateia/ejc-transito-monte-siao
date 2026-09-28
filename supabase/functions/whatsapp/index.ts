// ==============================================================================
// SUPABASE EDGE FUNCTION: whatsapp
// Validação de token de inscrição e redirecionamento seguro para o grupo do Sub
// ==============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUB_GROUPS: Record<string, string> = {
  "Verde": "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=verde",
  "Vermelho": "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=vermelho",
  "Amarelo": "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=amarelo",
  "Laranja": "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=laranja",
  "Azul": "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=laranja",
};

serve(async (req) => {
  const url = new URL(req.url);
  const token = url.searchParams.get("t");

  if (!token) {
    return new Response("Token de inscrição ausente.", { status: 400 });
  }

  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  );

  const { data: inscricao, error } = await supabaseAdmin
    .from("inscricoes")
    .select("sub")
    .eq("token_acesso", token)
    .single();

  if (error || !inscricao) {
    return new Response("Inscrição não encontrada ou token inválido.", { status: 404 });
  }

  const subNormalized = (inscricao.sub === "Azul") ? "Laranja" : inscricao.sub;
  const targetGroup = SUB_GROUPS[subNormalized] || "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6";

  // Redirecionamento HTTP 302 direto para o WhatsApp
  return Response.redirect(targetGroup, 302);
});
