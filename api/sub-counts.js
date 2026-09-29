// ==============================================================================
// VERCEL SERVERLESS FUNCTION: /api/sub-counts
// Fonte Única de Verdade Centralizada para Contagem de Inscritos por Sub
// Sincroniza todos os dispositivos (PC, Notebook, Mobile, Tablet)
// Anti-cache estrito e deduplicação garantida (Zero Descompasso)
// ==============================================================================

const settingsStore = require("./_settings-store");

function getSupabaseCredentials() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || null;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || null;
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

// Calcula as contagens oficiais deduplicadas
function calcularContagensOficiais(localStore) {
  const counts = { Verde: 0, Vermelho: 0, Amarelo: 0, Laranja: 0 };
  const capacities = { Verde: 50, Vermelho: 50, Amarelo: 50, Laranja: 50 };
  
  // Mapa de pessoas únicas: identificador único -> sub
  // Identificador prioritário: whatsapp (dígitos) ou email ou ID
  const pessoasUnicas = new Map();

  // 1. Processa inscrições do formulário registradas centralmente (ignora arquivados)
  if (Array.isArray(localStore.inscricoes)) {
    localStore.inscricoes.forEach(insc => {
      if (insc.arquivado) return;
      const sub = normalizarSub(insc.sub);
      if (!sub) return;
      const tel = normalizarTelefone(insc.whatsapp);
      const email = String(insc.email || "").trim().toLowerCase();
      const id = insc.id || "";
      const key = tel || (email && email.includes("@") ? email : id);
      if (key) {
        pessoasUnicas.set(key, { sub, origem: "inscricao" });
      }
    });
  }

  // 2. Processa pagamentos aprovados da base central (se não estiverem já em inscricoes e não forem arquivados)
  if (Array.isArray(localStore.pagamentos)) {
    localStore.pagamentos.forEach(pag => {
      if (pag.status !== "approved" || pag.arquivado) return;
      const sub = normalizarSub(pag.sub || pag.metadata?.sub);
      if (!sub) return;
      const tel = normalizarTelefone(pag.whatsapp_pagador || pag.whatsapp);
      const email = String(pag.email || "").trim().toLowerCase();
      const id = pag.inscricao_id || pag.txid || "";
      const key = tel || (email && email.includes("@") ? email : id);
      if (key && !pessoasUnicas.has(key)) {
        // Não incluir testes automatizados de desenvolvimento
        const isDevTest = email.endsWith("@test.com") || email.startsWith("teste.conf.");
        if (!isDevTest) {
          pessoasUnicas.set(key, { sub, origem: "pagamento" });
        }
      }
    });
  }

  // Agrega totais por Sub
  pessoasUnicas.forEach(({ sub }) => {
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

  // CORS universal para chamadas de qualquer dispositivo
  res.setHeader("Access-Control-Allow-Origin", "*");
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
    const finalCounts = remoteCounts || calculatedCounts;
    const finalTotal = remoteCounts 
      ? Object.values(remoteCounts).reduce((a, b) => a + b, 0)
      : calcTotal;

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
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    body = body || {};

    const nome = String(body.nome_completo || "").trim();
    const whatsapp = normalizarTelefone(body.whatsapp);
    const sub = normalizarSub(body.sub);

    if (!nome) {
      return res.status(400).json({ success: false, error: "Nome completo é obrigatório." });
    }
    if (!whatsapp || whatsapp.length < 10) {
      return res.status(400).json({ success: false, error: "WhatsApp válido é obrigatório." });
    }
    if (!sub) {
      return res.status(400).json({ success: false, error: "Selecione um Sub válido." });
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

    // Verifica se já existe inscrição com este WhatsApp
    const existingIndex = localStore.inscricoes.findIndex(i => normalizarTelefone(i.whatsapp) === whatsapp);
    const id = body.id || (existingIndex >= 0 ? localStore.inscricoes[existingIndex].id : `insc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);

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

    // Tenta gravar também no Supabase se disponível (em background / best-effort)
    const { url, key } = getSupabaseCredentials();
    if (url && key && !url.includes("yggikbshdvnouaoxafcr")) {
      try {
        fetch(`${url}/rest/v1/inscricoes`, {
          method: "POST",
          headers: {
            "apikey": key,
            "Authorization": `Bearer ${key}`,
            "Content-Type": "application/json",
            "Prefer": "return=minimal"
          },
          body: JSON.stringify({
            id: registroInscricao.id,
            nome_completo: registroInscricao.nome_completo,
            whatsapp: registroInscricao.whatsapp,
            email: registroInscricao.email,
            sub: registroInscricao.sub,
            tamanho_camisa: registroInscricao.tamanho_camisa,
            forma_pagamento: registroInscricao.forma_pagamento,
            pagamento_status: registroInscricao.pagamento_status
          }),
          signal: AbortSignal.timeout(3500)
        }).catch(() => {});
      } catch (e) {}
    }

    // Calcula novas contagens consolidadas imediatamente
    const { counts, capacities, total } = calcularContagensOficiais(localStore);

    return res.status(200).json({
      success: true,
      message: "Inscrição sincronizada com sucesso na base central.",
      id,
      counts,
      capacities,
      total,
      timestamp: new Date().toISOString()
    });
  }

  return res.status(405).json({ error: "Método não permitido." });
};
