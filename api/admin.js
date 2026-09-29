// ==============================================================================
// VERCEL SERVERLESS FUNCTION: /api/admin
//   POST { action: "login", password }  -> valida a senha NO SERVIDOR e devolve o perfil
//   GET                                 -> devolve inscrições, pagamentos, auditoria e links
//                                          de WhatsApp com service_role (o navegador
//                                          não lê mais essas tabelas diretamente).
// ==============================================================================
const { applyCors } = require("./_cors");
const adminAuth = require("./_admin-auth");
const settingsStore = require("./_settings-store");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sbSelect(baseUrl, key, path) {
  const res = await fetch(`${baseUrl}/rest/v1/${path}`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`
    },
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error(`${path.split("?")[0]}: HTTP ${res.status}`);
  return res.json();
}

module.exports = async (req, res) => {
  applyCors(req, res);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-admin-token");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");

  if (req.method === "OPTIONS") return res.status(200).end();

  // ------------------------------- POST ACTIONS -------------------------------
  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    body = body || {};
    const action = body.action || "login";

    // 1. AÇÃO: LOGIN ADMINISTRATIVO
    if (action === "login") {
      const password = String(body.password || body.admin_pass || "").trim();
      if (!password) {
        await sleep(300);
        return res.status(401).json({ error: "Informe a senha de acesso." });
      }

      const auth = adminAuth.authenticate({ headers: req.headers, body: { password } });
      if (!auth.ok) {
        await sleep(600); // desacelera tentativas de força bruta
        return res.status(401).json({ error: "Senha inválida ou acesso não autorizado." });
      }

      return res.status(200).json({
        success: true,
        role: auth.role,
        label: auth.label,
        canEdit: auth.canEdit,
        canEditFinance: auth.canEditFinance,
        canApprovePayments: auth.canApprovePayments,
        canEditWhatsapp: auth.canEditWhatsapp
      });
    }

    // DIAGNÓSTICO SEGURO DE VARIÁVEIS DE AMBIENTE (SOMENTE SUPERADMIN)
    if (action === "diag_env") {
      const auth = adminAuth.requireRole(req, res, ["superadmin"]);
      if (!auth) return;
      const allKeys = Object.keys(process.env);
      const matches = allKeys.filter(k => /mercado|mp|key|token/i.test(k));
      const summary = {};
      matches.forEach(k => {
        const val = String(process.env[k] || "");
        summary[k] = { exists: Boolean(val), length: val.length, prefix: val.slice(0, 10) };
      });
      return res.status(200).json({ success: true, summary });
    }

    // 2. AÇÃO: RESET CONTROLADO DAS INSCRIÇÕES DE TESTE (SOMENTE SUPERADMIN)
    if (action === "reset_test_inscricoes") {
      const auth = adminAuth.requireRole(req, res, ["superadmin"]);
      if (!auth) return;

      const baseUrl = String(process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "https://guppedddwnuvluhiaaas.supabase.co").replace(/\/$/, "");
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "sb_publishable_QJV9XI3sN3P_gVtiQ2ObRg_gpSSKc-i";

      let affected = 0;
      try {
        // Arquiva todas as inscrições não arquivadas no Supabase (não destrutivo, preserva FKs e pagamentos)
        const patchRes = await fetch(`${baseUrl}/rest/v1/inscricoes?arquivado=not.is.true`, {
          method: "PATCH",
          headers: {
            apikey: key,
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
            "Prefer": "return=representation"
          },
          body: JSON.stringify({
            arquivado: true,
            arquivado_em: new Date().toISOString(),
            motivo_arquivamento: body.motivo || "Reset controlado de transição para produção"
          }),
          signal: AbortSignal.timeout(10000)
        });

        if (patchRes.ok) {
          const patched = await patchRes.json().catch(() => []);
          affected = Array.isArray(patched) ? patched.length : 0;
        }

        // Se houver store local, arquiva também para consistência offline
        try {
          const local = settingsStore.loadLocalStore();
          if (Array.isArray(local.inscricoes)) {
            let localChanged = false;
            local.inscricoes.forEach(i => {
              if (!i.arquivado) {
                i.arquivado = true;
                i.arquivado_em = new Date().toISOString();
                localChanged = true;
              }
            });
            if (localChanged) settingsStore.saveLocalStore(local);
          }
        } catch (e) {}

        // Registra log detalhado na tabela de auditoria
        try {
          await fetch(`${baseUrl}/rest/v1/auditoria_transacoes`, {
            method: "POST",
            headers: {
              apikey: key,
              Authorization: `Bearer ${key}`,
              "Content-Type": "application/json",
              "Prefer": "return=minimal"
            },
            body: JSON.stringify({
              acao: "RESET_TEST_INSCRICOES",
              usuario: auth.role,
              campo_afetado: "inscricoes",
              valor_anterior: `${affected} inscrições de teste ativas`,
              valor_novo: "0 inscrições ativas",
              motivo: body.motivo || "Reset controlado pós-auditoria de transição para produção",
              ip_origem: String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "127.0.0.1")
            }),
            signal: AbortSignal.timeout(5000)
          });
        } catch (e) {}

        return res.status(200).json({
          success: true,
          message: `Reset executado com sucesso. ${affected} inscrições de teste foram arquivadas.`,
          affected,
          counts: { Verde: 0, Vermelho: 0, Amarelo: 0, Laranja: 0 },
          total: 0
        });
      } catch (err) {
        console.error("[Reset API Error]", err);
        return res.status(500).json({ success: false, error: err.message || "Falha ao resetar inscrições de teste" });
      }
    }

    return res.status(400).json({ error: "Ação não reconhecida." });
  }

  if (req.method !== "GET") return res.status(405).json({ error: "Método não permitido" });

  // ------------------------------- DADOS -------------------------------------
  const auth = adminAuth.requireRole(req, res);
  if (!auth) return;

  const baseUrl = String(process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "https://guppedddwnuvluhiaaas.supabase.co").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "sb_publishable_QJV9XI3sN3P_gVtiQ2ObRg_gpSSKc-i";

  const result = {
    success: true,
    role: auth.role,
    label: auth.label,
    canEdit: auth.canEdit,
    canEditFinance: auth.canEditFinance,
    canApprovePayments: auth.canApprovePayments,
    canEditWhatsapp: auth.canEditWhatsapp,
    inscricoes: [],
    pagamentos: [],
    auditoria: [],
    whatsapp: {},
    counts: { Verde: 0, Vermelho: 0, Amarelo: 0, Laranja: 0 },
    total: 0
  };

  try {
    const jobs = [
      sbSelect(baseUrl, key, "inscricoes?select=*&arquivado=is.false&order=criado_em.desc").then((d) => { result.inscricoes = d; }),
      sbSelect(baseUrl, key, "pagamentos?select=*&order=criado_em.desc").then((d) => { result.pagamentos = d; }),
      sbSelect(baseUrl, key, "auditoria_transacoes?select=*&order=criado_em.desc&limit=500").then((d) => { result.auditoria = d; }),
      sbSelect(baseUrl, key, "configuracoes_whatsapp?select=*").then((rows) => {
        rows.forEach((r) => { if (r.sub) result.whatsapp[r.sub] = r.link_grupo || ""; });
      })
    ];
    const settled = await Promise.allSettled(jobs);
    const errors = settled.filter((s) => s.status === "rejected").map((s) => s.reason.message);
    if (errors.length) {
      result.warnings = errors;
      // Fallback no store local se o banco falhar
      try {
        const local = settingsStore.loadLocalStore();
        if (!result.inscricoes.length && local.inscricoes) {
          result.inscricoes = local.inscricoes.filter(i => !i.arquivado);
        }
        if (!result.pagamentos.length && local.pagamentos) result.pagamentos = local.pagamentos;
        if (!Object.keys(result.whatsapp).length && local.whatsapp) result.whatsapp = local.whatsapp;
      } catch (e) {}
    }

    // Calcula a contagem oficial sincronizada
    const helperSub = (s) => {
      const str = String(s || "").trim().toLowerCase();
      if (str.includes("verd")) return "Verde";
      if (str.includes("verm")) return "Vermelho";
      if (str.includes("amar")) return "Amarelo";
      if (str.includes("laran") || str.includes("azul")) return "Laranja";
      return null;
    };

    const counts = { Verde: 0, Vermelho: 0, Amarelo: 0, Laranja: 0 };
    (result.inscricoes || []).forEach((item) => {
      const s = helperSub(item.sub);
      if (s && counts[s] !== undefined) counts[s]++;
    });
    result.counts = counts;
    result.total = Object.values(counts).reduce((a, b) => a + b, 0);

  } catch (err) {
    result.error = err.message;
  }

  return res.status(200).json(result);
};
