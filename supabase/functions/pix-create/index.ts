// ==============================================================================
// SUPABASE EDGE FUNCTION: pix-create
// Criação de cobrança Pix dinâmica com integração a gateway (Mercado Pago / Efí / Asaas)
// ==============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { valor, nome_pagador, whatsapp_pagador, tipo, inscricao_id } = await req.json();

    if (!valor || Number(valor) <= 0) {
      return new Response(JSON.stringify({ error: "Valor inválido" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const txid = "EJC" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
    const expiracao = new Date(Date.now() + 15 * 60000).toISOString();

    // Aqui você pode plugar a chamada oficial à API do Mercado Pago / Efí Pay / Asaas:
    // Ex: const mpResponse = await fetch("https://api.mercadopago.com/v1/payments", { ... });

    // Registra a cobrança Pix no banco
    const { data, error } = await supabaseAdmin.rpc("registrar_pagamento_pix", {
      p_txid: txid,
      p_nome_pagador: nome_pagador || "Anônimo",
      p_whatsapp_pagador: whatsapp_pagador || null,
      p_cpf_pagador: null,
      p_valor: Number(valor),
      p_tipo: tipo || "contribuicao",
      p_pix_copia_e_cola: "PIX_COPIA_E_COLA_GERADO",
      p_qr_code_base64: null,
      p_expiracao: expiracao,
      p_inscricao_id: inscricao_id || null,
    });

    if (error) throw error;

    return new Response(
      JSON.stringify({
        success: true,
        txid,
        valor,
        expiracao,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
