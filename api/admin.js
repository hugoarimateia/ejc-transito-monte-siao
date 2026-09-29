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

  // ------------------------------- LOGIN -------------------------------------
  if (req.method === "POST") {
    const password = String((req.body && (req.body.password || req.body.admin_pass)) || "").trim();
    if (!password) {
      await sleep(300);
      return res.status(401).json({ error: "Informe a senha de acesso." });
    }

    const auth = adminAuth.authenticate({ headers: {}, body: { password } });
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
    whatsapp: {}
  };

  try {
    const jobs = [
      sbSelect(baseUrl, key, "inscricoes?select=*&order=criado_em.desc").then((d) => { result.inscricoes = d; }),
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
        if (!result.inscricoes.length && local.inscricoes) result.inscricoes = local.inscricoes;
        if (!result.pagamentos.length && local.pagamentos) result.pagamentos = local.pagamentos;
        if (!Object.keys(result.whatsapp).length && local.whatsapp) result.whatsapp = local.whatsapp;
      } catch (e) {}
    }
  } catch (err) {
    result.error = err.message;
  }

  return res.status(200).json(result);
};
