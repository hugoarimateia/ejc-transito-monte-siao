// ==============================================================================
// SUPABASE EDGE FUNCTION: public-config
// Versão de Homologação da API Pública de Configuração do EJC Trânsito Monte Sião
// Consulta em tempo real exclusivamente o PostgreSQL Supabase (Zero Local Filesystem)
// ==============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CANONICAL_MP_PUBLIC_KEY = "APP_USR-39960bc1-2b08-4885-8090-31eaa38ba04b";

function getDefaultCardRates() {
  return [
    { installment: 1, rate: 0.0, rate_type: "percentage", enabled: true },
    { installment: 2, rate: 4.5, rate_type: "percentage", enabled: true },
    { installment: 3, rate: 5.5, rate_type: "percentage", enabled: true },
    { installment: 4, rate: 7.0, rate_type: "percentage", enabled: true },
    { installment: 5, rate: 8.5, rate_type: "percentage", enabled: true },
    { installment: 6, rate: 10.0, rate_type: "percentage", enabled: true },
    { installment: 7, rate: 11.5, rate_type: "percentage", enabled: false },
    { installment: 8, rate: 13.0, rate_type: "percentage", enabled: false },
    { installment: 9, rate: 14.5, rate_type: "percentage", enabled: false },
    { installment: 10, rate: 16.0, rate_type: "percentage", enabled: false },
    { installment: 11, rate: 17.5, rate_type: "percentage", enabled: false },
    { installment: 12, rate: 19.0, rate_type: "percentage", enabled: false }
  ];
}

function normalizarChavePix(chave?: string | null, tipo?: string | null): string | null {
  let c = String(chave || "").trim();
  if (!c || c.includes("***")) return chave || null;

  const tipoUpper = String(tipo || "").toUpperCase();
  const digitsOnly = c.replace(/\D/g, "");

  const isTelefone = tipoUpper === "TELEFONE" ||
    c.startsWith("+55") ||
    (!c.includes("@") && !c.includes("-") && (digitsOnly.length === 12 || digitsOnly.length === 13) && digitsOnly.startsWith("55"));

  if (isTelefone) {
    if ((digitsOnly.length === 13 || digitsOnly.length === 12) && digitsOnly.startsWith("55")) {
      return digitsOnly.substring(2);
    }
    if (digitsOnly.length === 10 || digitsOnly.length === 11) {
      return digitsOnly;
    }
    if (c.startsWith("+55")) {
      const stripped = digitsOnly.startsWith("55") ? digitsOnly.substring(2) : digitsOnly;
      if (stripped.length === 10 || stripped.length === 11) {
        return stripped;
      }
    }
  }

  return c;
}

function getEffectivePrice(valorInscricao: number | null, valorPromocional: number | null): number | null {
  if (valorInscricao === null || valorInscricao === undefined || isNaN(valorInscricao) || valorInscricao <= 0) {
    return null;
  }
  if (valorPromocional !== null && valorPromocional !== undefined && !isNaN(valorPromocional) && valorPromocional > 0 && valorPromocional < valorInscricao) {
    return valorPromocional;
  }
  return valorInscricao;
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
    "Vary": "Origin",
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0",
    "Pragma": "no-cache",
    "Expires": "0",
    "Surrogate-Control": "no-store"
  };
}

serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);

  // 1. Trata pre-flight CORS
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }

  // 2. Apenas aceita método GET
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Método não permitido." }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" }
    });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "https://guppedddwnuvluhiaaas.supabase.co";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") || "sb_publishable_QJV9XI3sN3P_gVtiQ2ObRg_gpSSKc-i";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    // Usa service_role se disponível no runtime, com fallback para anon key
    const clientKey = supabaseServiceKey || supabaseAnonKey;
    const supabase = createClient(supabaseUrl, clientKey);

    const urlObj = new URL(req.url);
    const clientVersion = Number(req.headers.get("x-client-version") || urlObj.searchParams.get("v") || 0);

    // 1. Consulta configuração financeira ativa via RPC oficial ou tabela com fallback
    let remoteSettings: any = null;
    try {
      const { data: rpcData, error: rpcError } = await supabase.rpc("obter_configuracao_financeira_ativa");
      if (!rpcError && rpcData && rpcData.success && rpcData.valor_inscricao !== undefined) {
        remoteSettings = rpcData;
      }
    } catch (_e) {
      // Fallback para query direta
    }

    if (!remoteSettings) {
      const { data: rowsAtivo } = await supabase
        .from("configuracoes_financeiras")
        .select("*")
        .eq("ativo", true)
        .order("versao", { ascending: false })
        .limit(1);

      if (rowsAtivo && rowsAtivo.length > 0) {
        remoteSettings = rowsAtivo[0];
      } else {
        const { data: rowsLatest } = await supabase
          .from("configuracoes_financeiras")
          .select("*")
          .order("versao", { ascending: false })
          .limit(1);
        if (rowsLatest && rowsLatest.length > 0) {
          remoteSettings = rowsLatest[0];
        }
      }
    }

    // 2. Consulta links oficiais de WhatsApp na tabela configuracoes_whatsapp
    const whatsappMap: Record<string, string> = {
      verde: "",
      vermelho: "",
      amarelo: "",
      laranja: "",
      geral: "",
      Verde: "",
      Vermelho: "",
      Amarelo: "",
      Laranja: "",
      Geral: ""
    };

    try {
      const { data: wppRows } = await supabase
        .from("configuracoes_whatsapp")
        .select("*")
        .eq("ativo", true);

      if (Array.isArray(wppRows) && wppRows.length > 0) {
        const CANONICAL_SUBS = ["Verde", "Vermelho", "Amarelo", "Laranja", "Geral"];
        wppRows.forEach((r: any) => {
          if (r.sub) {
            const subCap = r.sub.charAt(0).toUpperCase() + r.sub.slice(1).toLowerCase();
            if (CANONICAL_SUBS.includes(subCap)) {
              const link = r.link_grupo ? String(r.link_grupo).trim() : "";
              whatsappMap[subCap] = link;
              whatsappMap[subCap.toLowerCase()] = link;
            }
          }
        });
      }
    } catch (_wppErr) {
      // Fallback na tabela subs se necessário
      try {
        const { data: subsRows } = await supabase
          .from("subs")
          .select("nome, link_whatsapp");
        if (Array.isArray(subsRows)) {
          subsRows.forEach((s: any) => {
            if (s.nome && s.link_whatsapp) {
              const subCap = s.nome.charAt(0).toUpperCase() + s.nome.slice(1).toLowerCase();
              if (subCap !== "Azul") {
                whatsappMap[subCap] = s.link_whatsapp.trim();
                whatsappMap[subCap.toLowerCase()] = s.link_whatsapp.trim();
              }
            }
          });
        }
      } catch (_subsErr) {}
    }

    // 3. Montagem normalizada dos dados de configuração financeira
    const s = remoteSettings || {};
    const versao = Number(s.versao || 1);
    const isStaleReplica = clientVersion > 0 && versao < clientVersion;

    const valorInscricaoNum = (s.valor_inscricao !== null && s.valor_inscricao !== undefined && s.valor_inscricao !== "")
      ? Number(s.valor_inscricao)
      : null;

    const valorPromocionalNum = (s.valor_promocional !== null && s.valor_promocional !== undefined && s.valor_promocional !== "")
      ? Number(s.valor_promocional)
      : null;

    const precoEfetivoNum = getEffectivePrice(valorInscricaoNum, valorPromocionalNum);
    const isConfigured = Boolean(valorInscricaoNum !== null && valorInscricaoNum > 0);

    const pixChaveNormalizada = normalizarChavePix(s.pix_chave, s.pix_tipo_chave);
    const currentMod = s.modalidade_pix || s.pix_mode || "api_webhook";

    const cardRates = (Array.isArray(s.card_installment_rates) && s.card_installment_rates.length > 0)
      ? s.card_installment_rates
      : getDefaultCardRates();

    const effectiveMpPublicKey = (s.mp_public_key || s.mercado_pago_public_key || CANONICAL_MP_PUBLIC_KEY).trim();

    const pixConfig = {
      configurado: isConfigured,
      modalidade: currentMod,
      modalidade_pix: currentMod,
      pix_mode: currentMod,
      chave: pixChaveNormalizada,
      tipoChave: s.pix_tipo_chave || null,
      beneficiario: s.pix_beneficiario || null,
      cidade: s.pix_cidade || null,
      instrucoesManual: s.pix_instrucoes_manual || "Faça o Pix para a chave oficial cadastrada pela coordenação.",
      pix_instrucoes_manual: s.pix_instrucoes_manual || "Faça o Pix para a chave oficial cadastrada pela coordenação.",
      permiteComprovante: s.pix_permite_comprovante !== false,
      pix_permite_comprovante: s.pix_permite_comprovante !== false,
      valorTaxaInscricao: valorInscricaoNum,
      valor_inscricao: valorInscricaoNum,
      precoEfetivo: precoEfetivoNum,
      preco_efetivo: precoEfetivoNum,
      loteAtual: s.lote_atual || "1º Lote",
      lote_atual: s.lote_atual || "1º Lote",
      valorPromocional: valorPromocionalNum,
      valor_promocional: valorPromocionalNum,
      taxaAdicional: Number(s.taxa_adicional || 0),
      taxa_adicional: Number(s.taxa_adicional || 0),
      maxParcelas: Number(s.max_parcelas || 12),
      max_parcelas: Number(s.max_parcelas || 12),
      versao: versao,
      tempoExpiracaoMinutos: Number(Deno.env.get("NEXT_PUBLIC_PIX_EXPIRACAO_MINUTOS") || 15)
    };

    const responsePayload = {
      success: true,
      configurado: isConfigured,
      versao: versao,
      is_stale_replica: isStaleReplica,
      supabaseUrl: supabaseUrl,
      supabaseAnonKey: supabaseAnonKey,
      preco_efetivo: precoEfetivoNum,
      precoEfetivo: precoEfetivoNum,
      valor_inscricao: valorInscricaoNum,
      valor_promocional: valorPromocionalNum,
      taxa_adicional: pixConfig.taxa_adicional,
      max_parcelas: pixConfig.max_parcelas,
      card_installment_mode: s.card_installment_mode || "mercado_pago",
      card_max_installments: Number(s.card_max_installments || s.max_parcelas || 6),
      card_installment_rates: cardRates,
      mp_public_key: effectiveMpPublicKey,
      mercado_pago_public_key: effectiveMpPublicKey,
      lote_atual: pixConfig.lote_atual,
      modalidade_pix: currentMod,
      pix_chave: pixChaveNormalizada,
      pix_beneficiario: pixConfig.beneficiario,
      pix_cidade: pixConfig.cidade,
      pix_instrucoes_manual: pixConfig.pix_instrucoes_manual,
      pix_permite_comprovante: pixConfig.pix_permite_comprovante,
      pix: pixConfig,
      whatsapp: whatsappMap
    };

    return new Response(JSON.stringify(responsePayload, null, 2), {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json; charset=utf-8"
      }
    });

  } catch (error: any) {
    console.error("[public-config] Erro interno:", error.message);
    return new Response(JSON.stringify({
      success: false,
      error: "Falha ao consultar configurações públicas ativas."
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json; charset=utf-8"
      }
    });
  }
});
