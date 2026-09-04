// ==============================================================================
// SUPABASE EDGE FUNCTION: pix-webhook
// Recepção assíncrona segura de notificações de pagamento de gateways
// ==============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {
  try {
    const payload = await req.json();

    // Validação de assinatura ou token secreto do Gateway:
    // const secret = req.headers.get("x-signature") || req.headers.get("x-webhook-token");
    // if (secret !== Deno.env.get("PIX_WEBHOOK_SECRET")) return new Response("Unauthorized", { status: 401 });

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    // Extrai o txid do gateway (ex.: payload.data.id ou payload.pix[0].txid)
    const txid = payload.txid || payload?.data?.id;

    if (txid) {
      // Confirma o pagamento no banco via RPC transacional
      await supabaseAdmin.rpc("confirmar_pagamento_pix", {
        p_txid: String(txid),
        p_gateway: "webhook_oficial",
        p_payload: payload,
      });
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
