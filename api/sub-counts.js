// ==============================================================================
// VERCEL SERVERLESS FUNCTION: /api/sub-counts
// Fonte Única de Verdade Centralizada para Contagem de Inscritos por Sub
// Sincroniza todos os dispositivos (PC, Notebook, Mobile, Tablet)
// Anti-cache estrito e deduplicação garantida (Zero Descompasso)
// ==============================================================================

const crypto = require("crypto");
const settingsStore = require("./_settings-store");
const { applyCors } = require("./_cors");

function getSupabaseCredentials() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "https://guppedddwnuvluhiaaas.supabase.co";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || "sb_publishable_QJV9XI3sN3P_gVtiQ2ObRg_gpSSKc-i";
  return { url: url ? url.replace(/\/$/, "") : null, key };
}

// Helper para normalizar telefone (somente dígitos)
function normalizarTelefone(tel) {
  return String(tel || "").replace(/\D/g, "");
}

// Helper para normalizar subgrupo (Verde, Vermelho, Amarelo, Laranja)
function normalizarSub(sub) {
  const s = String(sub || "").trim().toLowerCase();
  if (s.includes("verd")) return "Verde";
  if (s.includes("verm")) return "Vermelho";
  if (s.includes("amar")) return "Amarelo";
  if (s.includes("laran") || s.includes("azul")) return "Laranja";
  return null;
}

// Helper centralizado: valida se o status de pagamento é efetivamente confirmado/aprovado
function isPagamentoConfirmado(status) {
  const s = String(status || "").trim().toLowerCase();
  return ["approved", "confirmado", "pago"].includes(s);
}

// Calcula as contagens oficiais deduplicadas exclusivamente a partir de inscrições ativas e PAGAS
function calcularContagensOficiais(localStore) {
  const counts = { Verde: 0, Vermelho: 0, Amarelo: 0, Laranja: 0 };
  const capacities = { Verde: 70, Vermelho: 70, Amarelo: 70, Laranja: 70 };
  
  // Mapa de pessoas únicas: identificador único -> sub
  // Fonte Única: apenas inscrições não arquivadas (arquivado = false) e com pagamento confirmado
  const pessoasUnicas = new Map();

  if (Array.isArray(localStore.inscricoes)) {
    localStore.inscricoes.forEach(insc => {
      if (insc.arquivado) return;
      // REGRA OFICIAL EJC: inscrições pendentes, rejeitadas, canceladas ou estornadas NÃO são contabilizadas!
      if (!isPagamentoConfirmado(insc.pagamento_status)) return;

      const sub = normalizarSub(insc.sub);
      if (!sub) return;
      const tel = normalizarTelefone(insc.whatsapp);
      const email = String(insc.email || "").trim().toLowerCase();
      const id = insc.id || "";
      const key = tel || (email && email.includes("@") ? email : id);
      if (key) {
        pessoasUnicas.set(key, sub);
      }
    });
  }

  // Agrega totais por Sub
  pessoasUnicas.forEach((sub) => {
    if (counts[sub] !== undefined) {
      counts[sub]++;
    }
  });

  const total = Object.values(counts).reduce((acc, v) => acc + v, 0);

  return { counts, capacities, total };
}


module.exports = async (req, res) => {
  // Suporte universal para ambientes Vercel Serverless e Node HTTP puro
  if (!res.status) {
    res.status = function(code) { this.statusCode = code; return this; };
  }
  if (!res.json) {
    res.json = function(data) {
      if (!this.getHeader || !this.getHeader("Content-Type")) {
        this.setHeader("Content-Type", "application/json; charset=utf-8");
      }
      return this.end(JSON.stringify(data));
    };
  }

  // CORS universal restrito ao domínio autorizado
  applyCors(req, res);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-client-version, Cache-Control");
  
  // Anti-cache ESTRITO: impede armazenamento intermediário por navegadores ou CDNs
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // ----------------------------------------------------------------------------
  // GET: Retorna as contagens oficiais consolidadas
  // ----------------------------------------------------------------------------
  if (req.method === "GET") {
    let remoteCounts = null;

    // Tenta consulta remota ao Supabase se credenciais estiverem disponíveis e ativas
    const { url, key } = getSupabaseCredentials();
    if (url && key) {
      try {
        const sbRes = await fetch(`${url}/rest/v1/rpc/contagem_inscricoes_por_sub`, {
          method: "POST",
          headers: {
            "apikey": key,
            "Authorization": `Bearer ${key}`,
            "Content-Type": "application/json"
          },
          signal: AbortSignal.timeout(3000)
        });
        if (sbRes.ok) {
          const data = await sbRes.json();
          if (Array.isArray(data)) {
            remoteCounts = { Verde: 0, Vermelho: 0, Amarelo: 0, Laranja: 0 };
            data.forEach(item => {
              const s = normalizarSub(item.sub);
              if (s && remoteCounts[s] !== undefined) {
                remoteCounts[s] = Number(item.total || 0);
              }
            });
          }
        }
      } catch (errDb) {
        console.warn("[SubCounts API] Supabase RPC offline, usando persistência central local:", errDb.message);
      }
    }

    // Se Supabase retornou dados válidos, usa-o; caso contrário, calcula da base persistente central
    let localStore;
    try {
      localStore = settingsStore.loadLocalStore();
    } catch (e) {
      localStore = settingsStore.getDefaultStore();
    }

    const { counts: calculatedCounts, capacities, total: calcTotal } = calcularContagensOficiais(localStore);
    let finalCounts = calculatedCounts;
    let finalTotal = calcTotal;

    if (remoteCounts) {
      finalCounts = remoteCounts;
      finalTotal = Object.values(remoteCounts).reduce((a, b) => a + b, 0);
    }

    return res.status(200).json({
      success: true,
      source: remoteCounts ? "supabase" : "central_store",
      counts: finalCounts,
      capacities,
      total: finalTotal,
      timestamp: new Date().toISOString()
    });

  }

  // ----------------------------------------------------------------------------
  // POST: Registra uma nova inscrição na base central persistente
  // ----------------------------------------------------------------------------
  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") {
      try { 
        body = JSON.parse(body); 
      } catch (e) {
        try {
          body = Object.fromEntries(new URLSearchParams(body));
        } catch (e2) {
          body = {};
        }
      }
    }
    body = body || {};

    const nome = String(body.nome_completo || body.nome || body.name || "").trim();
    const whatsapp = normalizarTelefone(body.whatsapp || body.phone || body.telefone || body.celular);
    const sub = normalizarSub(body.sub || body.sub_equipe || body.equipe);

    if (!nome) {
      return res.status(400).json({ success: false, error: "Nome completo é obrigatório." });
    }
    if (!whatsapp || whatsapp.length < 10) {
      return res.status(400).json({ success: false, error: "WhatsApp válido é obrigatório (mínimo 10 dígitos com DDD)." });
    }
    if (!sub) {
      return res.status(400).json({ success: false, error: "Selecione um Sub válido (Verde, Vermelho, Amarelo ou Laranja)." });
    }

    // Carrega a store central
    let localStore;
    try {
      localStore = settingsStore.loadLocalStore();
    } catch (e) {
      localStore = settingsStore.getDefaultStore();
    }
    if (!Array.isArray(localStore.inscricoes)) {
      localStore.inscricoes = [];
    }

    // Valida capacidade máxima de 70 vagas confirmadas para a Sub
    const { counts: currentCounts } = calcularContagensOficiais(localStore);
    const existingIndex = localStore.inscricoes.findIndex(i => normalizarTelefone(i.whatsapp) === whatsapp);
    if ((currentCounts[sub] || 0) >= 70 && existingIndex < 0) {
      return res.status(400).json({
        success: false,
        error: `Limite máximo de 70 vagas atingido para a Sub ${sub}. Por favor, escolha outra Sub.`
      });
    }

    // Gera UUID válido para conformidade com a coluna id (type UUID) do PostgreSQL no Supabase
    const isUuid = (str) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(str || ""));
    const id = (body.id && isUuid(body.id)) 
      ? body.id 
      : ((existingIndex >= 0 && isUuid(localStore.inscricoes[existingIndex].id)) 
          ? localStore.inscricoes[existingIndex].id 
          : crypto.randomUUID());

    const registroInscricao = {
      id,
      nome_completo: nome,
      whatsapp,
      email: String(body.email || "").trim().toLowerCase(),
      sub,
      tamanho_camisa: body.tamanho_camisa || null,
      quer_camisa_adicional: Boolean(body.quer_camisa_adicional),
      quantidade_camisas_adicionais: Number(body.quantidade_camisas_adicionais || 0),
      modelo_camisa_adicional: body.modelo_camisa_adicional || null,
      tamanho_camisa_adicional: body.tamanho_camisa_adicional || null,
      talento: body.talento || null,
      forma_pagamento: body.forma_pagamento || "checkout",
      pagamento_informado: Boolean(body.pagamento_informado),
      pagamento_status: body.pagamento_status || "pendente",
      justificativa_pagamento: body.justificativa_pagamento || null,
      token_acesso: body.token_acesso || null,
      criado_em: existingIndex >= 0 ? localStore.inscricoes[existingIndex].criado_em : new Date().toISOString(),
      atualizado_em: new Date().toISOString()
    };

    if (existingIndex >= 0) {
      // Atualiza inscrição existente sem duplicar contagem
      localStore.inscricoes[existingIndex] = registroInscricao;
    } else {
      localStore.inscricoes.push(registroInscricao);
    }

    // Salva centralmente de forma atômica
    try {
      settingsStore.saveLocalStore(localStore);
    } catch (errSave) {
      console.error("[SubCounts API] Erro ao salvar registro na store central:", errSave);
    }

    // Grava também no Supabase com await obrigatório para persistência serverless
    let remoteCounts = null;
    const { url, key } = getSupabaseCredentials();
    if (url && key) {
      try {
        const payloadSupabase = {
          nome_completo: registroInscricao.nome_completo,
          whatsapp: registroInscricao.whatsapp,
          email: registroInscricao.email,
          sub: registroInscricao.sub,
          tamanho_camisa: registroInscricao.tamanho_camisa,
          forma_pagamento: registroInscricao.forma_pagamento,
          pagamento_status: registroInscricao.pagamento_status,
          arquivado: false
        };
        if (isUuid(registroInscricao.id)) {
          payloadSupabase.id = registroInscricao.id;
        }

        const sbInsertRes = await fetch(`${url}/rest/v1/inscricoes`, {
          method: "POST",
          headers: {
            "apikey": key,
            "Authorization": `Bearer ${key}`,
            "Content-Type": "application/json",
            "Prefer": "return=representation"
          },
          body: JSON.stringify(payloadSupabase),
          signal: AbortSignal.timeout(5000)
        });

        if (sbInsertRes.ok) {
          const insertedRows = await sbInsertRes.json().catch(() => []);
          if (Array.isArray(insertedRows) && insertedRows[0] && insertedRows[0].id) {
            registroInscricao.id = insertedRows[0].id;
          }
          // Atualiza contagens oficiais imediatamente via RPC
          const sbCountRes = await fetch(`${url}/rest/v1/rpc/contagem_inscricoes_por_sub`, {
            method: "POST",
            headers: {
              "apikey": key,
              "Authorization": `Bearer ${key}`,
              "Content-Type": "application/json"
            },
            signal: AbortSignal.timeout(3000)
          });
          if (sbCountRes.ok) {
            const dataRpc = await sbCountRes.json();
            if (Array.isArray(dataRpc)) {
              remoteCounts = { Verde: 0, Vermelho: 0, Amarelo: 0, Laranja: 0 };
              dataRpc.forEach(item => {
                const s = normalizarSub(item.sub);
                if (s && remoteCounts[s] !== undefined) {
                  remoteCounts[s] = Number(item.total || 0);
                }
              });
            }
          }
        }
      } catch (errDb) {
        console.warn("[SubCounts API] Erro ao gravar inscrição no Supabase:", errDb.message);
      }
    }

    // Calcula novas contagens consolidadas imediatamente
    const { counts: calculatedCounts, capacities, total: calcTotal } = calcularContagensOficiais(localStore);
    let finalCounts = calculatedCounts;
    let finalTotal = calcTotal;
    if (remoteCounts) {
      const remoteTotal = Object.values(remoteCounts).reduce((a, b) => a + b, 0);
      if (calcTotal === 0 && Array.isArray(localStore.inscricoes) && localStore.inscricoes.length > 0 && remoteTotal > 0) {
        finalCounts = calculatedCounts;
        finalTotal = calcTotal;
      } else {
        finalCounts = remoteCounts;
        finalTotal = remoteTotal;
      }
    }


    return res.status(200).json({
      success: true,
      message: "Inscrição sincronizada com sucesso na base central.",
      id,
      counts: finalCounts,
      capacities,
      total: finalTotal,
      timestamp: new Date().toISOString()
    });
  }

  return res.status(405).json({ error: "Método não permitido." });
};

module.exports.isPagamentoConfirmado = isPagamentoConfirmado;

