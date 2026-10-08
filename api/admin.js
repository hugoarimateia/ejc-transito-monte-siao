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
const mercadoPago = require("./_mercadopago");

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

    // 2.1 AÇÃO: DESARQUIVAR INSCRIÇÃO
    if (action === "desarquivar_inscricao") {
      const auth = adminAuth.requireRole(req, res, ["superadmin", "financeiro", "admin"]);
      if (!auth) return;

      const targetId = body.id || body.inscricao_id;
      const targetEmail = body.email;
      if (!targetId && !targetEmail) {
        return res.status(400).json({ error: "Informe o ID ou E-mail da inscrição a desarquivar." });
      }

      const baseUrl = String(process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "https://guppedddwnuvluhiaaas.supabase.co").replace(/\/$/, "");
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "sb_publishable_QJV9XI3sN3P_gVtiQ2ObRg_gpSSKc-i";

      const query = targetId ? `id=eq.${encodeURIComponent(targetId)}` : `email=eq.${encodeURIComponent(targetEmail)}`;
      const patchRes = await fetch(`${baseUrl}/rest/v1/inscricoes?${query}`, {
        method: "PATCH",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "Prefer": "return=representation"
        },
        body: JSON.stringify({
          arquivado: false,
          motivo_arquivamento: null
        })
      });

      if (patchRes.ok) {
        const rows = await patchRes.json().catch(() => []);
        return res.status(200).json({ success: true, message: "Inscrição desarquivada com sucesso.", rows });
      }
      return res.status(500).json({ error: "Falha ao desarquivar inscrição no Supabase." });
    }

    // 2.2 AÇÃO: CANCELAMENTO INDIVIDUAL DE INSCRIÇÃO (OPERAÇÃO SEGURA E ISOLADA)
    if (action === "cancel_inscription") {
      const auth = adminAuth.requireRole(req, res, ["superadmin", "financeiro", "admin"]);
      if (!auth) return;

      const rawId = body.registration_id || body.inscricao_id || body.id;
      if (!rawId || typeof rawId !== "string") {
        return res.status(400).json({ error: "Identificador único da inscrição é obrigatório." });
      }

      const cleanId = rawId.trim();
      const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!UUID_REGEX.test(cleanId)) {
        return res.status(400).json({ error: "Formato de ID inválido. Deve ser um UUID válido." });
      }

      const confirmKeyword = String(body.confirm_keyword || "").trim();
      if (confirmKeyword !== "CANCELAR") {
        return res.status(400).json({ error: 'Confirmação obrigatória: digite a palavra "CANCELAR" para confirmar.' });
      }

      const baseUrl = String(process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "https://guppedddwnuvluhiaaas.supabase.co").replace(/\/$/, "");
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "sb_publishable_QJV9XI3sN3P_gVtiQ2ObRg_gpSSKc-i";

      try {
        // 1. Localiza EXATAMENTE e SOMENTE a inscrição especificada
        let participant = null;
        try {
          const checkRes = await fetch(`${baseUrl}/rest/v1/inscricoes?id=eq.${encodeURIComponent(cleanId)}&select=id,nome_completo,sub,email,whatsapp,pagamento_status,foto_caminho,comprovante_caminho`, {
            headers: {
              apikey: key,
              Authorization: `Bearer ${key}`
            },
            signal: AbortSignal.timeout(6000)
          });
          if (checkRes.ok) {
            const foundRows = await checkRes.json().catch(() => []);
            if (Array.isArray(foundRows) && foundRows.length > 0) {
              participant = foundRows[0];
            }
          }
        } catch (eDb) {
          console.warn("[Cancel Inscription API] Consulta Supabase:", eDb.message);
        }

        // Fallback no store local caso a consulta direta ao banco esteja offline/restrita
        if (!participant) {
          try {
            const local = settingsStore.loadLocalStore();
            const found = (local.inscricoes || []).find(i => i.id === cleanId);
            if (found) participant = found;
          } catch (eLoc) {}
        }

        if (!participant) {
          return res.status(404).json({ error: "Inscrição não encontrada ou já cancelada anteriormente." });
        }

        // 2. Se houver registro complementar em public.inscritos_dados, remove de forma segura
        try {
          await fetch(`${baseUrl}/rest/v1/inscritos_dados?inscricao_id=eq.${encodeURIComponent(cleanId)}`, {
            method: "DELETE",
            headers: {
              apikey: key,
              Authorization: `Bearer ${key}`
            },
            signal: AbortSignal.timeout(4000)
          });
        } catch (eDados) {
          // Ignora se tabela não existir
        }

        // 3. Se houver foto pessoal no Storage, remove EXCLUSIVAMENTE aquele arquivo específico
        if (participant.foto_caminho) {
          try {
            const rawPath = String(participant.foto_caminho).replace(/^[/\\]+/, "").replace(/^(inscritos-fotos|fotos)[/\\]/, "");
            if (rawPath.startsWith("inscritos/") && !rawPath.includes("..")) {
              await fetch(`${baseUrl}/storage/v1/object/inscritos-fotos/${rawPath}`, {
                method: "DELETE",
                headers: { apikey: key, Authorization: `Bearer ${key}` },
                signal: AbortSignal.timeout(4000)
              });
              await fetch(`${baseUrl}/storage/v1/object/fotos/${rawPath}`, {
                method: "DELETE",
                headers: { apikey: key, Authorization: `Bearer ${key}` },
                signal: AbortSignal.timeout(4000)
              });
            }
          } catch (eStorage) {
            console.warn("[Cancel Inscription] Aviso ao remover foto do Storage:", eStorage.message);
          }
        }

        // 4. Executa a exclusão definitiva do participante na tabela inscricoes
        // Nota: A FK em pagamentos_pix e pagamentos possui ON DELETE SET NULL, preservando o histórico financeiro intacto.
        try {
          await fetch(`${baseUrl}/rest/v1/inscricoes?id=eq.${encodeURIComponent(cleanId)}`, {
            method: "DELETE",
            headers: {
              apikey: key,
              Authorization: `Bearer ${key}`,
              "Prefer": "return=representation"
            },
            signal: AbortSignal.timeout(8000)
          });
        } catch (eDel) {
          console.warn("[Cancel Inscription API] Exclusão Supabase:", eDel.message);
        }

        // 5. Se houver cópia em cache/localStore, remove com segurança
        try {
          const local = settingsStore.loadLocalStore();
          let localChanged = false;
          if (Array.isArray(local.inscricoes)) {
            const initialLen = local.inscricoes.length;
            local.inscricoes = local.inscricoes.filter(i => i.id !== cleanId);
            if (local.inscricoes.length !== initialLen) localChanged = true;
          }
          if (Array.isArray(local.inscritos_dados)) {
            const initialLen = local.inscritos_dados.length;
            local.inscritos_dados = local.inscritos_dados.filter(i => i.inscricao_id !== cleanId);
            if (local.inscritos_dados.length !== initialLen) localChanged = true;
          }
          if (localChanged) settingsStore.saveLocalStore(local);
        } catch (eStore) {}

        // 6. Registra auditoria administrativa da operação
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
              acao: "CANCELAR_INSCRICAO",
              usuario: auth.label || auth.role,
              campo_afetado: "inscricoes",
              valor_anterior: `${participant.nome_completo} (${participant.sub || 'Sem Sub'}) - Tel: ${participant.whatsapp || 'N/A'} - ID: ${cleanId}`,
              valor_novo: "Cancelada e removida definitivamente",
              motivo: body.motivo || "Cancelamento individual solicitado no painel administrativo",
              ip_origem: String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "127.0.0.1")
            }),
            signal: AbortSignal.timeout(5000)
          });
        } catch (eAud) {}

        return res.status(200).json({
          success: true,
          message: "Inscrição cancelada com sucesso.",
          removed: {
            id: cleanId,
            nome_completo: participant.nome_completo,
            sub: participant.sub,
            email: participant.email,
            whatsapp: participant.whatsapp
          }
        });
      } catch (err) {
        console.error("[Cancel Inscription API Error]", err);
        return res.status(500).json({ success: false, error: err.message || "Falha interna ao cancelar inscrição." });
      }
    }

    // 3. AÇÃO: AUDITORIA MERCADO PAGO (SUPERADMIN E FINANCEIRO)
    if (action === "audit_mercadopago") {
      const auth = adminAuth.requireRole(req, res, ["superadmin", "financeiro"]);
      if (!auth) return;

      const token = mercadoPago.getAccessToken();
      const pubKey = mercadoPago.getPublicKey();
      const tokenPresent = Boolean(token && token.length > 10);
      const pubKeyPresent = Boolean(pubKey && pubKey.length > 10);

      const tokenEnv = token.startsWith("APP_USR-") ? "production" : (token.startsWith("TEST-") ? "test" : "unknown");
      const pubKeyEnv = pubKey.startsWith("APP_USR-") ? "production" : (pubKey.startsWith("TEST-") ? "test" : "unknown");

      let appId = null;
      const appMatch = pubKey.match(/APP_USR-([a-f0-9-]+)/i) || token.match(/APP_USR-([0-9]+)-/i);
      if (appMatch) appId = appMatch[1];

      const auditData = {
        success: true,
        token_present: tokenPresent,
        token_environment: tokenEnv,
        public_key_present: pubKeyPresent,
        public_key_environment: pubKeyEnv,
        public_key_prefix: pubKey ? pubKey.slice(0, 15) : null,
        application_id: appId,
        auth_status: null,
        user_profile: null,
        recent_payments: [],
        target_payment: null,
        errors: []
      };

      if (tokenPresent) {
        // 1. Testa autenticação no endpoint /users/me
        try {
          const userRes = await fetch("https://api.mercadopago.com/users/me", {
            headers: { "Authorization": `Bearer ${token}` },
            signal: AbortSignal.timeout(6000)
          });
          auditData.auth_status = userRes.status;
          if (userRes.ok) {
            const u = await userRes.json();
            auditData.user_profile = {
              id: u.id,
              nickname: u.nickname,
              site_id: u.site_id,
              country_id: u.country_id,
              user_type: u.user_type,
              points: u.points,
              tags: u.tags || []
            };
          } else {
            const errTxt = await userRes.text();
            auditData.errors.push(`users/me falhou: HTTP ${userRes.status} - ${errTxt.slice(0, 200)}`);
          }
        } catch (eUser) {
          auditData.errors.push(`Exceção users/me: ${eUser.message}`);
        }

        // 2. Busca pagamentos recentes na API do Mercado Pago
        try {
          const payRes = await fetch("https://api.mercadopago.com/v1/payments/search?limit=30&sort=date_created&criteria=desc", {
            headers: { "Authorization": `Bearer ${token}` },
            signal: AbortSignal.timeout(8000)
          });
          if (payRes.ok) {
            const searchData = await payRes.json();
            if (Array.isArray(searchData.results)) {
              auditData.recent_payments = searchData.results.map(p => ({
                id: String(p.id),
                status: p.status,
                status_detail: p.status_detail,
                transaction_amount: p.transaction_amount,
                currency_id: p.currency_id,
                installments: p.installments,
                payment_method_id: p.payment_method_id,
                payment_type_id: p.payment_type_id,
                date_created: p.date_created,
                date_approved: p.date_approved,
                external_reference: p.external_reference,
                payer_email: p.payer?.email || null,
                statement_descriptor: p.statement_descriptor || null
              }));
            }
          } else {
            const errPay = await payRes.text();
            auditData.errors.push(`payments/search falhou: HTTP ${payRes.status} - ${errPay.slice(0, 200)}`);
          }
        } catch (ePay) {
          auditData.errors.push(`Exceção payments/search: ${ePay.message}`);
        }

        // 3. Se um payment_id específico foi solicitado ou se algum possui pending_review_manual ou in_process
        const targetId = body.payment_id || auditData.recent_payments.find(p => p.status_detail === "pending_review_manual" || p.status === "in_process")?.id;
        if (targetId) {
          try {
            const singleRes = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(targetId)}`, {
              headers: { "Authorization": `Bearer ${token}` },
              signal: AbortSignal.timeout(6000)
            });
            if (singleRes.ok) {
              const p = await singleRes.json();
              auditData.target_payment = {
                id: String(p.id),
                status: p.status,
                status_detail: p.status_detail,
                transaction_amount: p.transaction_amount,
                currency_id: p.currency_id,
                installments: p.installments,
                payment_method_id: p.payment_method_id,
                payment_type_id: p.payment_type_id,
                date_created: p.date_created,
                date_approved: p.date_approved,
                external_reference: p.external_reference,
                statement_descriptor: p.statement_descriptor || null,
                payer_email: p.payer?.email || null,
                card_last_four: p.card?.last_four_digits || null,
                card_first_six: p.card?.first_six_digits || null
              };
            }
          } catch (eSingle) {
            auditData.errors.push(`Exceção get payment ${targetId}: ${eSingle.message}`);
          }
        }
      }

      return res.status(200).json(auditData);
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
    inscricoes_arquivadas: [],
    capacities: { Verde: 85, Vermelho: 85, Amarelo: 85, Laranja: 85 },
    pagamentos: [],
    auditoria: [],
    whatsapp: {},
    counts: { Verde: 0, Vermelho: 0, Amarelo: 0, Laranja: 0 },
    total: 0
  };

  try {
    const jobs = [
      sbSelect(baseUrl, key, "inscricoes?select=*&arquivado=is.false&order=criado_em.desc").then((d) => { result.inscricoes = d; }),
      sbSelect(baseUrl, key, "inscricoes?select=*&arquivado=is.true&order=criado_em.desc").then((d) => { result.inscricoes_arquivadas = d; }).catch(() => { result.inscricoes_arquivadas = []; }),
      sbSelect(baseUrl, key, "subs?select=nome,capacidade").then((rows) => {
        if (Array.isArray(rows)) {
          rows.forEach((r) => {
            const str = String(r.nome || "").trim().toLowerCase();
            let s = null;
            if (str.includes("verd")) s = "Verde";
            else if (str.includes("verm")) s = "Vermelho";
            else if (str.includes("amar")) s = "Amarelo";
            else if (str.includes("laran") || str.includes("azul")) s = "Laranja";
            if (s && r.capacidade !== undefined && r.capacidade !== null) result.capacities[s] = Number(r.capacidade);
          });
        }
      }).catch(() => {}),
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
          result.inscricoes_arquivadas = local.inscricoes.filter(i => Boolean(i.arquivado));
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
      if (item.arquivado) return;
      const statusPag = String(item.pagamento_status || "").trim().toLowerCase();
      if (!["approved", "confirmado", "pago"].includes(statusPag)) return;
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
