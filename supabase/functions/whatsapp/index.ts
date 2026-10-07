// ==============================================================================
// SUPABASE EDGE FUNCTION: whatsapp
// Validação de token de inscrição e redirecionamento para o grupo de WhatsApp oficial
// Consulta em tempo real exclusivamente o PostgreSQL Supabase (Zero Filesystem / Zero Escrita)
// ==============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function normalizarSub(sub?: string | null): string | null {
  const s = String(sub || "").trim().toLowerCase();
  if (s.includes("verd")) return "Verde";
  if (s.includes("verm")) return "Vermelho";
  if (s.includes("amar")) return "Amarelo";
  if (s.includes("laran") || s.includes("azul")) return "Laranja";
  return null;
}

function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  const allowed = new Set([
    "https://www.transitoejc.site",
    "https://transitoejc.site",
    "https://site-ejc-eight.vercel.app",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:8080",
    "http://127.0.0.1:8080"
  ]);

  const siteUrl = Deno.env.get("SITE_URL") || Deno.env.get("NEXT_PUBLIC_SITE_URL");
  if (siteUrl) allowed.add(siteUrl.replace(/\/+$/, ""));

  const allowOrigin = allowed.has(origin) ? origin : (origin ? origin : "*");

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-client-version, apikey, x-client-info",
    "Vary": "Origin"
  };
}

serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);

  // 1. Pre-flight CORS
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }

  // 2. Apenas aceita método GET (Estritamente Read-Only)
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response(JSON.stringify({ error: "Método não permitido." }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" }
    });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "https://guppedddwnuvluhiaaas.supabase.co";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") || "sb_publishable_QJV9XI3sN3P_gVtiQ2ObRg_gpSSKc-i";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    // Usa service_role para consultar tabela inscricoes protegida por RLS
    const clientKey = supabaseServiceKey || supabaseAnonKey;
    const supabase = createClient(supabaseUrl, clientKey);

    const urlObj = new URL(req.url);
    const token = String(urlObj.searchParams.get("t") || urlObj.searchParams.get("token") || "").trim();

    // 1. Busca link do Grupo Geral para fallback oficial
    let geralLink = "";
    try {
      const { data: geralRow } = await supabase
        .from("configuracoes_whatsapp")
        .select("link_grupo")
        .ilike("sub", "geral")
        .eq("ativo", true)
        .limit(1)
        .maybeSingle();

      if (geralRow && geralRow.link_grupo && String(geralRow.link_grupo).trim().startsWith("http")) {
        geralLink = String(geralRow.link_grupo).trim();
      }
    } catch (_gErr) {}

    // Se nenhum token foi fornecido, redireciona diretamente para o Grupo Geral oficial
    if (!token) {
      const target = geralLink || "https://www.transitoejc.site/?msg=whatsapp_aguardando_configuracao";
      return new Response(null, {
        status: 302,
        headers: {
          ...corsHeaders,
          "Location": target
        }
      });
    }

    // 2. Valida token contra tabela public.inscricoes
    const { data: inscricaoData, error: inscricaoError } = await supabase
      .from("inscricoes")
      .select("sub")
      .eq("token_acesso", token)
      .limit(1)
      .maybeSingle();

    if (!inscricaoError && inscricaoData && inscricaoData.sub) {
      const canonicalSub = normalizarSub(inscricaoData.sub);

      if (canonicalSub) {
        // Consulta o link oficial do subgrupo na tabela configuracoes_whatsapp
        const { data: wppRow } = await supabase
          .from("configuracoes_whatsapp")
          .select("link_grupo")
          .ilike("sub", canonicalSub)
          .eq("ativo", true)
          .limit(1)
          .maybeSingle();

        if (wppRow && wppRow.link_grupo && String(wppRow.link_grupo).trim().startsWith("http")) {
          const subLink = String(wppRow.link_grupo).trim();
          return new Response(null, {
            status: 302,
            headers: {
              ...corsHeaders,
              "Location": subLink
            }
          });
        }
      }
    }

    // Fallback seguro para o Grupo Geral se token não encontrado ou sub sem link configurado
    const fallbackTarget = geralLink || "https://www.transitoejc.site/?msg=whatsapp_aguardando_configuracao";
    return new Response(null, {
      status: 302,
      headers: {
        ...corsHeaders,
        "Location": fallbackTarget
      }
    });

  } catch (error: any) {
    console.error("[whatsapp] Erro interno:", error.message);
    return new Response(null, {
      status: 302,
      headers: {
        ...corsHeaders,
        "Location": "https://www.transitoejc.site/?msg=whatsapp_aguardando_configuracao"
      }
    });
  }
});
