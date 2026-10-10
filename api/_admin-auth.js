// ==============================================================================
// AUTENTICAÇÃO ADMINISTRATIVA (SERVER-SIDE)
// As senhas vêm de variáveis de ambiente do servidor com comparação em tempo constante:
//   ADMIN_PASSWORD_COORDENACAO  -> superadmin (Coordenação Geral, acesso total)
//   ADMIN_PASSWORD_FINANCEIRO   -> financeiro (edita valores, chave Pix, aprova)
//   ADMIN_PASSWORD              -> admin (administração geral, links WhatsApp, visualização)
// ==============================================================================
const crypto = require("crypto");

const ROLES = {
  superadmin: {
    label: "Coordenação / Super Admin (Acesso Total)",
    canEdit: true,
    canEditFinance: true,
    canApprovePayments: true,
    canEditWhatsapp: true
  },
  financeiro: {
    label: "Gestor Financeiro",
    canEdit: true,
    canEditFinance: true,
    canApprovePayments: true,
    canEditWhatsapp: false
  },
  admin: {
    label: "Administrador Geral",
    canEdit: false,
    canEditFinance: false,
    canApprovePayments: false,
    canEditWhatsapp: true
  }
};

function sha(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest();
}

// Comparação em tempo constante (evita ataques de temporização)
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  return crypto.timingSafeEqual(sha(a), sha(b));
}

function configuredPasswords() {
  const list = [];

  // 1. Coordenação / Super Admin: senha transitoejc26
  const passCoordenacao = (process.env.ADMIN_PASSWORD_COORDENACAO || process.env.ADMIN_PASS || "").trim();
  if (passCoordenacao) list.push({ pass: passCoordenacao, role: "superadmin" });

  // 2. Financeiro: senha financeirott26
  const passFinanceiro = (process.env.ADMIN_PASSWORD_FINANCEIRO || process.env.FINANCEIRO_PASSWORD || "").trim();
  if (passFinanceiro) list.push({ pass: passFinanceiro, role: "financeiro" });

  // 3. Admin Normal: senha ejc2026adm
  const passAdmin = (process.env.ADMIN_PASSWORD || "").trim();
  if (passAdmin) list.push({ pass: passAdmin, role: "admin" });

  return list;
}

function isConfigured() {
  return configuredPasswords().length > 0;
}

// A senha é aceita por body.admin_pass, x-admin-token ou Authorization: Bearer.
// NUNCA pela URL (query string), pois ficaria registrada em logs e histórico.
function extractPassword(req) {
  const header = req.headers || {};
  const bearer = String(header["authorization"] || header["Authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  const token = String(header["x-admin-token"] || header["X-Admin-Token"] || "").trim();
  const bodyPass = String((req.body && (req.body.admin_pass || req.body.password)) || "").trim();
  return bodyPass || token || bearer;
}

function roleForPassword(password) {
  if (!password || typeof password !== "string") return null;
  const clean = password.trim();
  if (!clean) return null;

  let found = null;
  // Percorre todas as senhas (sem interromper antecipadamente) para manter tempo constante
  for (const item of configuredPasswords()) {
    if (safeEqual(clean, item.pass) && !found) {
      found = item.role;
    }
  }
  return found;
}

// Retorna { ok, role, canEdit, canEditFinance, canApprovePayments, canEditWhatsapp, label } ou { ok: false }
function authenticate(req) {
  const pass = extractPassword(req);
  const role = roleForPassword(pass);
  if (!role || !ROLES[role]) {
    return {
      ok: false,
      role: null,
      canEdit: false,
      canEditFinance: false,
      canApprovePayments: false,
      canEditWhatsapp: false,
      label: null
    };
  }
  const perms = ROLES[role];
  return {
    ok: true,
    role,
    label: perms.label,
    canEdit: perms.canEdit,
    canEditFinance: perms.canEditFinance,
    canApprovePayments: perms.canApprovePayments,
    canEditWhatsapp: perms.canEditWhatsapp
  };
}

// Exige login e papel específico. Responde 401/403/503 e retorna null se negado.
function requireRole(req, res, allowedRoles) {
  if (!isConfigured()) {
    res.status(503).json({ error: "Painel administrativo não configurado no servidor." });
    return null;
  }
  const auth = authenticate(req);
  if (!auth.ok) {
    res.status(401).json({ error: "Acesso não autorizado: credenciais administrativas necessárias." });
    return null;
  }
  if (allowedRoles && Array.isArray(allowedRoles) && !allowedRoles.includes(auth.role)) {
    res.status(403).json({ error: "Seu perfil não possui autorização para esta ação." });
    return null;
  }
  return auth;
}

module.exports = {
  ROLES,
  isConfigured,
  authenticate,
  requireRole,
  extractPassword,
  safeEqual,
  roleForPassword
};
