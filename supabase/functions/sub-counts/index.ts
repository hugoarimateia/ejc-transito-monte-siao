// ==============================================================================
// SUPABASE EDGE FUNCTION: sub-counts
// Versão da API Pública de Contagem e Sincronização de Inscrições
// Consulta em tempo real exclusivamente o PostgreSQL Supabase (Zero Filesystem / Zero Vercel)
// Suporta GET (contagens de vagas) e POST (registro de inscrição pré-checkout)
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

function normalizarTelefone(tel?: string | null): string {
  return String(tel || "").replace(/\D/g, "");
}

function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  const allowed = new Set([
    "https://www.transitoejc.site",
    "https://transitoejc.site",
    "https://ejc-public.pages.dev",
    "https://ejc-admin.pages.dev",
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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-client-version, apikey, x-client-info, Cache-Control",
    "Vary": "Origin",
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0",
    "Pragma": "no-cache",
    "Expires": "0",
    "Surrogate-Control": "no-store"
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

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "https://guppedddwnuvluhiaaas.supabase.co";
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") || "sb_publishable_QJV9XI3sN3P_gVtiQ2ObRg_gpSSKc-i";
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const clientKey = supabaseServiceKey || supabaseAnonKey;
  const supabase = createClient(supabaseUrl, clientKey);

  // ============================================================================
  // FLUXO GET: Consulta de Contagens Oficiais e Vagas
  // ============================================================================
  if (req.method === "GET") {
    try {
      // 1. Consulta RPC canônica e estritamente somente leitura de contagem
      const counts: Record<string, number> = { Verde: 0, Vermelho: 0, Amarelo: 0, Laranja: 0 };
      const capacities: Record<string, number> = { Verde: 85, Vermelho: 85, Amarelo: 85, Laranja: 85 };

      const { data: rpcData, error: rpcError } = await supabase.rpc("contagem_inscricoes_por_sub");

      if (!rpcError && Array.isArray(rpcData)) {
        rpcData.forEach((item: any) => {
          const s = normalizarSub(item.sub);
          if (s && counts[s] !== undefined) {
            counts[s] = Number(item.total || 0);
          }
        });
      }

      // 2. Consulta capacidades oficiais da tabela public.subs
      try {
        const { data: subsData } = await supabase
          .from("subs")
          .select("nome, capacidade");

        if (Array.isArray(subsData) && subsData.length > 0) {
          subsData.forEach((row: any) => {
            const s = normalizarSub(row.nome);
            if (s && row.capacidade !== undefined && row.capacidade !== null) {
              capacities[s] = Number(row.capacidade);
            }
          });
        }
      } catch (_subsErr) {
        // Mantém capacidades padrão (70)
      }

      const total = Object.values(counts).reduce((a, b) => a + b, 0);

      const responsePayload = {
        success: true,
        source: "supabase",
        counts,
        capacities,
        total,
        timestamp: new Date().toISOString()
      };

      return new Response(JSON.stringify(responsePayload, null, 2), {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json; charset=utf-8"
        }
      });
    } catch (error: any) {
      console.error("[sub-counts GET] Erro:", error.message);
      return new Response(JSON.stringify({
        success: false,
        error: "Falha ao consultar contagens oficiais de inscritos."
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json; charset=utf-8"
        }
      });
    }
  }

  // ============================================================================
  // FLUXO POST: Registro / Sincronização de Inscrição Pré-Checkout
  // ============================================================================
  if (req.method === "POST") {
    try {
      const body = await req.json().catch(() => ({}));
      const nome = String(body.nome_completo || body.nome || body.name || "").trim();
      const whatsapp = normalizarTelefone(body.whatsapp || body.phone || body.telefone || body.celular);
      const sub = normalizarSub(body.sub || body.sub_equipe || body.equipe);

      if (!nome) {
        return new Response(JSON.stringify({ success: false, error: "Nome completo é obrigatório." }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      if (!whatsapp || whatsapp.length < 10) {
        return new Response(JSON.stringify({ success: false, error: "WhatsApp válido é obrigatório (mínimo 10 dígitos com DDD)." }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      if (!sub) {
        return new Response(JSON.stringify({ success: false, error: "Selecione um Sub válido (Verde, Vermelho, Amarelo ou Laranja)." }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // Validação de capacidade (70 vagas por sub)
      const { data: rpcData } = await supabase.rpc("contagem_inscricoes_por_sub");
      let subTotal = 0;
      if (Array.isArray(rpcData)) {
        const found = rpcData.find((r: any) => normalizarSub(r.sub) === sub);
        if (found) subTotal = Number(found.total || 0);
      }

      // Verifica se já existe inscrição por whatsapp para atualização idempotente
      const { data: existingRows } = await supabase
        .from("inscricoes")
        .select("id, criado_em")
        .eq("whatsapp", whatsapp)
        .limit(1);

      const existing = existingRows && existingRows.length > 0 ? existingRows[0] : null;

      if (!existing && subTotal >= 70) {
        return new Response(JSON.stringify({
          success: false,
          error: `Limite máximo de 70 vagas atingido para a Sub ${sub}. Por favor, escolha outra Sub.`
        }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      const isUuid = (str: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(str || ""));
      const assignedId = (body.id && isUuid(body.id)) 
        ? body.id 
        : (existing ? existing.id : crypto.randomUUID());

      const payloadSupabase: Record<string, unknown> = {
        id: assignedId,
        nome_completo: nome,
        whatsapp,
        email: String(body.email || "").trim().toLowerCase(),
        sub,
        tamanho_camisa: body.tamanho_camisa || null,
        forma_pagamento: body.forma_pagamento || "checkout",
        pagamento_status: body.pagamento_status || "pendente",
        arquivado: false,
        token_acesso: body.token_acesso || null,
        atualizado_em: new Date().toISOString()
      };

      if (body.foto_caminho) payloadSupabase.foto_caminho = body.foto_caminho;
      if (body.comprovante_caminho) payloadSupabase.comprovante_caminho = body.comprovante_caminho;
      if (body.talento) payloadSupabase.talento = body.talento;

      let registeredId = assignedId;

      if (existing) {
        const { data: updated, error: updErr } = await supabase
          .from("inscricoes")
          .update(payloadSupabase)
          .eq("id", existing.id)
          .select("id");
        if (!updErr && updated && updated.length > 0) registeredId = updated[0].id;
      } else {
        payloadSupabase.criado_em = new Date().toISOString();
        const { data: inserted, error: insErr } = await supabase
          .from("inscricoes")
          .insert(payloadSupabase)
          .select("id");
        if (!insErr && inserted && inserted.length > 0) registeredId = inserted[0].id;
      }

      return new Response(JSON.stringify({
        success: true,
        id: registeredId,
        message: "Inscrição sincronizada com sucesso na base central."
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    } catch (ePost: any) {
      console.error("[sub-counts POST] Erro:", ePost.message);
      return new Response(JSON.stringify({ success: false, error: ePost.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
  }

  return new Response(JSON.stringify({ error: "Método não permitido." }), {
    status: 405,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
});
