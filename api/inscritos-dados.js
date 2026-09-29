// ==============================================================================
// VERCEL SERVERLESS FUNCTION: /api/inscritos-dados
// Módulo Administrativo: Dados dos Inscritos por Sub
//   GET  ?sub=verde|vermelho|amarelo|laranja -> Retorna inscritos e contadores do Sub
//   PATCH { inscricao_id, tamanho_camisa, foto_caminho, observacoes } -> Atualiza cadastro complementar
// ==============================================================================
const { applyCors } = require("./_cors");
const adminAuth = require("./_admin-auth");
const { generateSignedPhotoToken } = require("./_photo-signer");
const settingsStore = require("./_settings-store");

const VALID_SUBS = {
  verde: { nome: "Verde", cor: "#24a764", coordenadores: "Abraão e Sara" },
  vermelho: { nome: "Vermelho", cor: "#e8333e", coordenadores: "Kadmiel e Bia" },
  amarelo: { nome: "Amarelo", cor: "#eab308", coordenadores: "Mateus e Gabriely" },
  laranja: { nome: "Laranja", cor: "#f97316", coordenadores: "Alan e Kallyne" }
};

async function sbFetch(baseUrl, key, path, options = {}) {
  const url = `${baseUrl}/rest/v1/${path}`;
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Prefer: options.prefer || "return=representation",
    ...(options.headers || {})
  };
  const res = await fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    const err = new Error(`Supabase REST ${res.status}: ${errorText}`);
    err.status = res.status;
    throw err;
  }
  return res.json().catch(() => ({}));
}

module.exports = async (req, res) => {
  applyCors(req, res);
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-admin-token");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");

  if (req.method === "OPTIONS") return res.status(200).end();

  // 1. AUTENTICAÇÃO OBRIGATÓRIA (ROLE CHECK)
  const auth = adminAuth.requireRole(req, res);
  if (!auth) return; // requireRole já envia 401 caso não autorizado

  const baseUrl = String(process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "https://guppedddwnuvluhiaaas.supabase.co").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "sb_publishable_QJV9XI3sN3P_gVtiQ2ObRg_gpSSKc-i";

  // ---------------------------------------------------------------------------
  // GET: LISTAR INSCRITOS DE UM SUB COM CONTADORES E DADOS COMPLEMENTARES
  // ---------------------------------------------------------------------------
  if (req.method === "GET") {
    const rawSub = String(req.query.sub || "").trim().toLowerCase();
    if (!rawSub) {
      return res.status(400).json({ error: "Parâmetro 'sub' é obrigatório. Valores aceitos: verde, vermelho, amarelo, laranja." });
    }

    const subConfig = VALID_SUBS[rawSub];
    if (!subConfig) {
      return res.status(400).json({ error: "Sub inválido. Valores aceitos: Verde, Vermelho, Amarelo, Laranja." });
    }

    const officialSubName = subConfig.nome;

    try {
      // 1. Busca inscrições ativas do Sub na tabela principal
      let inscricoes = [];
      try {
        const subQuery = (rawSub === "laranja")
          ? `or=(sub.eq.Laranja,sub.eq.Azul)`
          : `sub=eq.${encodeURIComponent(officialSubName)}`;
        inscricoes = await sbFetch(
          baseUrl,
          key,
          `inscricoes?select=*&${subQuery}&arquivado=is.false&order=nome_completo.asc`
        );
      } catch (err) {
        console.warn("[Inscritos Dados API] Falha na consulta direta ao banco:", err.message);
        try {
          const local = settingsStore.loadLocalStore();
          if (Array.isArray(local.inscricoes)) {
            inscricoes = local.inscricoes.filter(i => {
              const s = String(i.sub || "").toLowerCase();
              return (s === rawSub || (rawSub === "laranja" && s === "azul")) && !i.arquivado;
            });
          }
        } catch (e) {}
      }

      // 2. Busca dados complementares (tabela inscritos_dados se existir)
      let dadosComplementaresMap = {};
      try {
        const dadosComp = await sbFetch(baseUrl, key, `inscritos_dados?select=*`);
        if (Array.isArray(dadosComp)) {
          dadosComp.forEach(item => {
            if (item.inscricao_id) dadosComplementaresMap[item.inscricao_id] = item;
          });
        }
      } catch (e) {
        // Tabela inscritos_dados ainda não criada na migração: continua com fallback resiliente
      }

      // 3. Monta relação consolidada sem duplicar fonte de verdade
      const inscritos = (Array.isArray(inscricoes) ? inscricoes : []).map(i => {
        const comp = dadosComplementaresMap[i.id] || null;

        const tamanhoCamisa = String((comp && comp.tamanho_camisa) || i.tamanho_camisa || "").trim();
        const fotoCaminho = String((comp && comp.foto_caminho) || i.foto_caminho || "").trim();

        const isCompleto = Boolean(tamanhoCamisa && fotoCaminho && i.nome_completo && i.whatsapp);
        const statusCadastro = isCompleto ? "completo" : "incompleto";

        const fotoUrl = fotoCaminho
          ? `/api/admin/inscritos-foto?path=${encodeURIComponent(fotoCaminho)}&token=${generateSignedPhotoToken(fotoCaminho)}`
          : null;

        const visualSub = String(i.sub || "").toLowerCase() === "azul" ? "Laranja" : (i.sub || officialSubName);

        return {
          id: i.id,
          nome_completo: i.nome_completo,
          whatsapp: i.whatsapp,
          email: i.email || "",
          sub: visualSub,
          tamanho_camisa: tamanhoCamisa || null,
          modelo_camisa: i.modelo_camisa || "Tradicional",
          quer_camisa_adicional: Boolean(i.quer_camisa_adicional),
          quantidade_camisas_adicionais: i.quantidade_camisas_adicionais || 0,
          tamanho_camisa_adicional: i.tamanho_camisa_adicional || null,
          foto_caminho: fotoCaminho || null,
          foto_url: fotoUrl,
          has_foto: Boolean(fotoCaminho),
          status_cadastro: statusCadastro,
          observacoes: (comp && comp.observacoes) || null,
          criado_em: i.criado_em,
          atualizado_em: (comp && comp.atualizado_em) || i.criado_em,
          pagamento_status: i.pagamento_status || "pendente"
        };
      });

      // 4. Contadores oficiais do Sub
      const total = inscritos.length;
      const completos = inscritos.filter(i => i.status_cadastro === "completo").length;
      const pendentes = total - completos;

      return res.status(200).json({
        success: true,
        sub: officialSubName,
        coordenadores: subConfig.coordenadores,
        cor: subConfig.cor,
        stats: {
          total,
          completos,
          pendentes
        },
        inscritos
      });
    } catch (err) {
      console.error("[Inscritos Dados API] Erro na consulta:", err.message);
      return res.status(500).json({ error: "Erro interno ao carregar dados dos inscritos." });
    }
  }

  // ---------------------------------------------------------------------------
  // PATCH / POST: ATUALIZAR DADOS COMPLEMENTARES (CAMISA, FOTO, OBSERVAÇÕES)
  // ---------------------------------------------------------------------------
  if (req.method === "PATCH" || req.method === "POST") {
    const { inscricao_id, tamanho_camisa, foto_caminho, observacoes } = req.body || {};

    if (!inscricao_id || typeof inscricao_id !== "string") {
      return res.status(400).json({ error: "ID da inscrição é obrigatório." });
    }

    try {
      // 1. Verifica se a inscrição realmente existe
      const existing = await sbFetch(baseUrl, key, `inscricoes?id=eq.${inscricao_id}&select=id,nome_completo,sub,tamanho_camisa,foto_caminho`);
      if (!Array.isArray(existing) || existing.length === 0) {
        return res.status(404).json({ error: "Inscrição não encontrada." });
      }

      const inscricaoBase = existing[0];
      const novoTamanho = tamanho_camisa !== undefined ? String(tamanho_camisa).trim() : inscricaoBase.tamanho_camisa;
      const novaFoto = foto_caminho !== undefined ? String(foto_caminho).trim() : inscricaoBase.foto_caminho;
      const statusCalculado = (novoTamanho && novaFoto) ? "completo" : "incompleto";

      const payload = {
        inscricao_id,
        tamanho_camisa: novoTamanho || null,
        foto_caminho: novaFoto || null,
        status_cadastro: statusCalculado,
        observacoes: observacoes !== undefined ? String(observacoes).trim() : null,
        atualizado_por: auth.label || "admin",
        atualizado_em: new Date().toISOString()
      };

      // 2. Tenta UPSERT na tabela dedicada public.inscritos_dados
      let upsertOk = false;
      try {
        await sbFetch(baseUrl, key, `inscritos_dados?on_conflict=inscricao_id`, {
          method: "POST",
          prefer: "resolution=merge-duplicates,return=representation",
          body: payload
        });
        upsertOk = true;
      } catch (e) {
        // Se a tabela ainda não existir, prossegue com atualização na tabela inscricoes
      }

      // 3. Sincroniza tamanho_camisa na tabela inscricoes para evitar divergência
      if (tamanho_camisa !== undefined) {
        try {
          await sbFetch(baseUrl, key, `inscricoes?id=eq.${inscricao_id}`, {
            method: "PATCH",
            body: {
              tamanho_camisa: novoTamanho || inscricaoBase.tamanho_camisa
            }
          });
        } catch (e) {}
      }

      return res.status(200).json({
        success: true,
        message: "Dados do inscrito atualizados com sucesso.",
        item: {
          inscricao_id,
          tamanho_camisa: novoTamanho,
          foto_caminho: novaFoto,
          status_cadastro: statusCalculado,
          observacoes: payload.observacoes
        }
      });
    } catch (err) {
      console.error("[Inscritos Dados API] Erro ao salvar dados:", err.message);
      return res.status(500).json({ error: "Erro interno ao atualizar dados do inscrito." });
    }
  }

  return res.status(405).json({ error: "Método não permitido." });
};
