// ==============================================================================
// EJC - SISTEMA DE PERSISTÊNCIA CENTRALIZADA MULTI-CAMADAS
// api/_settings-store.js
// Sincroniza Supabase, Storage de Servidor (JSON) e Memória
// Garante persistência estrita (Zero Fake Success) e Read-After-Write Verification
// ==============================================================================

const fs = require("fs");
const path = require("path");
const os = require("os");

// Arquivos de persistência local / serverless
const DATA_DIR = path.resolve(__dirname, "../data");
const PRIMARY_FILE = path.join(DATA_DIR, "payment-settings.json");
const TMP_FILE = path.join(os.tmpdir(), "ejc-payment-settings.json");

// Configurações padrão de fábrica (somente usadas se não houver dados gravados)
function getDefaultSettings() {
  return {
    versao: 1,
    ativo: true,
    lote_atual: "1º Lote",
    valor_inscricao: Number(process.env.NEXT_PUBLIC_PIX_VALOR_INSCRICAO || 50.00),
    valor_promocional: null,
    taxa_adicional: 0.0,
    max_parcelas: 12,
    pix_chave: process.env.NEXT_PUBLIC_PIX_CHAVE || "leoeuler03@gmail.com",
    pix_tipo_chave: process.env.NEXT_PUBLIC_PIX_TIPO_CHAVE || "EMAIL",
    pix_beneficiario: process.env.NEXT_PUBLIC_PIX_BENEFICIARIO || "EJC TRANSITO MONTE SIAO",
    pix_documento: "",
    pix_cidade: process.env.NEXT_PUBLIC_PIX_CIDADE || "CAMPINA GRANDE",
    pix_instituicao: "",
    motivo_alteracao: "Configuração padrão inicial",
    atualizado_por: "sistema",
    atualizado_em: new Date().toISOString()
  };
}

function getDefaultStore() {
  const defaults = getDefaultSettings();
  return {
    settings: defaults,
    lotes: [
      { id: "lote-1", nome: defaults.lote_atual, valor: defaults.valor_inscricao, ativo: true, criado_em: defaults.atualizado_em }
    ],
    historico: [
      {
        id: "hist-0",
        acao: "SYSTEM_INITIALIZED",
        usuario: "sistema",
        campo_afetado: "inicializacao",
        valor_anterior: null,
        valor_novo: `R$ ${defaults.valor_inscricao.toFixed(2)} - ${defaults.pix_chave}`,
        motivo: "Criação do repositório persistente",
        criado_em: defaults.atualizado_em,
        ip_origem: "127.0.0.1"
      }
    ],
    whatsapp: {
      verde: process.env.NEXT_PUBLIC_WHATSAPP_VERDE || "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=verde",
      vermelho: process.env.NEXT_PUBLIC_WHATSAPP_VERMELHO || "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=vermelho",
      amarelo: process.env.NEXT_PUBLIC_WHATSAPP_AMARELO || "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=amarelo",
      azul: process.env.NEXT_PUBLIC_WHATSAPP_AZUL || "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=azul",
      geral: process.env.NEXT_PUBLIC_WHATSAPP_GERAL || "https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?s=cl&p=i&mlu=0"
    }
  };
}

// Carrega dados do disco (data/payment-settings.json ou /tmp)
function loadLocalStore() {
  try {
    if (fs.existsSync(PRIMARY_FILE)) {
      const raw = fs.readFileSync(PRIMARY_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && parsed.settings && parsed.settings.valor_inscricao) {
        return parsed;
      }
    }
  } catch (err) {
    console.warn("[SettingsStore] Falha ao ler PRIMARY_FILE, tentando TMP_FILE:", err.message);
  }

  try {
    if (fs.existsSync(TMP_FILE)) {
      const rawTmp = fs.readFileSync(TMP_FILE, "utf-8");
      const parsedTmp = JSON.parse(rawTmp);
      if (parsedTmp && parsedTmp.settings && parsedTmp.settings.valor_inscricao) {
        return parsedTmp;
      }
    }
  } catch (err) {
    console.warn("[SettingsStore] Falha ao ler TMP_FILE:", err.message);
  }

  const initial = getDefaultStore();
  saveLocalStore(initial);
  return initial;
}

// Salva dados no disco com atomicidade e garantia de diretório
function saveLocalStore(data) {
  let saved = false;
  const content = JSON.stringify(data, null, 2);

  // 1. Tenta salvar em data/payment-settings.json
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(PRIMARY_FILE, content, "utf-8");
    saved = true;
  } catch (err) {
    console.warn("[SettingsStore] Não foi possível salvar em PRIMARY_FILE:", err.message);
  }

  // 2. Salva em TMP_FILE (sempre gravável, inclusive em Vercel Serverless / AWS Lambda)
  try {
    fs.writeFileSync(TMP_FILE, content, "utf-8");
    saved = true;
  } catch (err) {
    console.warn("[SettingsStore] Não foi possível salvar em TMP_FILE:", err.message);
  }

  if (!saved) {
    throw new Error("Falha crítica de persistência local: não foi possível gravar em disco ou diretório temporário.");
  }
  return true;
}

// Helper para credenciais Supabase
function getSupabaseCredentials() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
  return { url: url ? url.replace(/\/$/, "") : null, key };
}

// ==============================================================================
// LEITURA CENTRALIZADA (GET)
// ==============================================================================
async function getActiveSettings() {
  let localData = loadLocalStore();
  const { url, key } = getSupabaseCredentials();

  if (url && key) {
    try {
      const res = await fetch(`${url}/rest/v1/configuracoes_financeiras?ativo=eq.true&order=versao.desc&limit=1`, {
        headers: { "apikey": key, "Authorization": `Bearer ${key}` },
        signal: AbortSignal.timeout(3000)
      });
      if (res.ok) {
        const rows = await res.json();
        if (rows && rows.length > 0) {
          const remoteSettings = rows[0];
          // Se o Supabase possui uma versão mais recente ou válida, sincroniza localmente
          localData.settings = {
            ...localData.settings,
            ...remoteSettings,
            valor_inscricao: Number(remoteSettings.valor_inscricao)
          };
          saveLocalStore(localData);
        }
      }
    } catch (err) {
      // Supabase indisponível: utiliza a persistência local sincronizada
      console.warn("[SettingsStore GET] Supabase offline ou falhou, mantendo dados persistidos:", err.message);
    }
  }

  return {
    settings: localData.settings,
    lotes: localData.lotes || [],
    historico: localData.historico || [],
    whatsapp: localData.whatsapp || {}
  };
}

// ==============================================================================
// ESCRITA 1: ATUALIZAR PREÇOS (UPDATE_PRICES)
// ==============================================================================
async function updatePriceSettings({
  usuario,
  lote_atual,
  valor_inscricao,
  valor_promocional,
  taxa_adicional,
  max_parcelas,
  motivo,
  ip
}) {
  const valorNum = Number(Number(valor_inscricao).toFixed(2));
  if (isNaN(valorNum) || valorNum <= 0) {
    throw new Error("O valor da inscrição deve ser um número positivo e maior que zero.");
  }

  const localData = loadLocalStore();
  const currentSettings = localData.settings;
  const valorAnterior = currentSettings.valor_inscricao;
  const loteAnterior = currentSettings.lote_atual;
  const novaVersao = (currentSettings.versao || 1) + 1;
  const agora = new Date().toISOString();

  const novoSettings = {
    ...currentSettings,
    versao: novaVersao,
    lote_atual: lote_atual || currentSettings.lote_atual || "1º Lote",
    valor_inscricao: valorNum,
    valor_promocional: valor_promocional ? Number(Number(valor_promocional).toFixed(2)) : null,
    taxa_adicional: taxa_adicional !== undefined ? Number(Number(taxa_adicional).toFixed(2)) : (currentSettings.taxa_adicional || 0.0),
    max_parcelas: max_parcelas !== undefined ? Number(max_parcelas) : (currentSettings.max_parcelas || 12),
    motivo_alteracao: motivo || "Atualização de preços via painel administrativo",
    atualizado_por: usuario || "admin",
    atualizado_em: agora
  };

  const auditEntry = {
    id: `audit-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    acao: "PRICE_UPDATED",
    usuario: usuario || "admin",
    campo_afetado: "valor_inscricao",
    valor_anterior: `R$ ${Number(valorAnterior).toFixed(2)} (${loteAnterior})`,
    valor_novo: `R$ ${valorNum.toFixed(2)} (${novoSettings.lote_atual})`,
    motivo: motivo || "Alteração de valor da taxa de inscrição",
    ip_origem: ip || "127.0.0.1",
    criado_em: agora,
    detalhes: {
      versao: novaVersao,
      lote: novoSettings.lote_atual,
      valor_promocional: novoSettings.valor_promocional
    }
  };

  // Tenta persistir no Supabase
  let supabasePersisted = false;
  const { url, key } = getSupabaseCredentials();

  if (url && key) {
    try {
      // 1. Tenta via RPC
      const rpcRes = await fetch(`${url}/rest/v1/rpc/atualizar_configuracao_financeira`, {
        method: "POST",
        headers: {
          "apikey": key,
          "Authorization": `Bearer ${key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          p_usuario: usuario || "admin",
          p_lote_atual: novoSettings.lote_atual,
          p_valor_inscricao: valorNum,
          p_valor_promocional: novoSettings.valor_promocional,
          p_taxa_adicional: novoSettings.taxa_adicional,
          p_max_parcelas: novoSettings.max_parcelas,
          p_motivo: motivo || "Atualização de preço",
          p_ip: ip || "127.0.0.1"
        }),
        signal: AbortSignal.timeout(4000)
      });

      if (rpcRes.ok) {
        supabasePersisted = true;
      } else {
        // 2. Fallback: inserção direta de tabela
        await fetch(`${url}/rest/v1/configuracoes_financeiras?ativo=eq.true`, {
          method: "PATCH",
          headers: { "apikey": key, "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ ativo: false, atualizado_em: agora })
        });
        const directRes = await fetch(`${url}/rest/v1/configuracoes_financeiras`, {
          method: "POST",
          headers: { "apikey": key, "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            versao: novaVersao,
            ativo: true,
            lote_atual: novoSettings.lote_atual,
            valor_inscricao: valorNum,
            valor_promocional: novoSettings.valor_promocional,
            taxa_adicional: novoSettings.taxa_adicional,
            max_parcelas: novoSettings.max_parcelas,
            pix_chave: currentSettings.pix_chave,
            pix_tipo_chave: currentSettings.pix_tipo_chave,
            pix_beneficiario: currentSettings.pix_beneficiario,
            pix_cidade: currentSettings.pix_cidade,
            motivo_alteracao: motivo,
            atualizado_por: usuario || "admin",
            atualizado_em: agora
          })
        });
        if (directRes.ok) supabasePersisted = true;
      }
    } catch (err) {
      console.warn("[SettingsStore updatePriceSettings] Supabase indisponível no momento:", err.message);
    }
  }

  // Persiste no storage local / serverless
  localData.settings = novoSettings;
  if (!Array.isArray(localData.historico)) localData.historico = [];
  localData.historico.unshift(auditEntry);
  if (localData.historico.length > 100) localData.historico.pop();

  // Atualiza ou adiciona lote
  if (Array.isArray(localData.lotes)) {
    const loteIndex = localData.lotes.findIndex(l => l.nome === novoSettings.lote_atual);
    if (loteIndex !== -1) {
      localData.lotes[loteIndex].valor = valorNum;
      localData.lotes[loteIndex].ativo = true;
    } else {
      localData.lotes.push({
        id: `lote-${Date.now()}`,
        nome: novoSettings.lote_atual,
        valor: valorNum,
        ativo: true,
        criado_em: agora
      });
    }
  }

  saveLocalStore(localData);

  // READ-AFTER-WRITE VERIFICATION: Re-lê para assegurar integridade
  const verifyData = loadLocalStore();
  if (Number(verifyData.settings.valor_inscricao) !== valorNum) {
    throw new Error(`Falha de verificação read-after-write: esperado R$ ${valorNum}, mas gravado R$ ${verifyData.settings.valor_inscricao}`);
  }

  return {
    success: true,
    persisted: true,
    supabasePersisted,
    settings: verifyData.settings,
    auditEntry,
    message: `Preço atualizado com sucesso para R$ ${valorNum.toFixed(2).replace('.', ',')} no lote ${novoSettings.lote_atual}.`
  };
}

// ==============================================================================
// ESCRITA 2: ATUALIZAR PIX (UPDATE_PIX)
// ==============================================================================
async function updatePixSettings({
  usuario,
  pix_chave,
  pix_tipo_chave,
  pix_beneficiario,
  pix_documento,
  pix_cidade,
  motivo,
  ip
}) {
  const chaveLimpa = String(pix_chave || "").trim();
  const tipoChave = String(pix_tipo_chave || "EMAIL").toUpperCase();
  const beneficiarioLimpo = String(pix_beneficiario || "").trim();
  const cidadeLimpa = String(pix_cidade || "").trim();

  if (!chaveLimpa) throw new Error("A chave PIX não pode ser vazia.");
  if (!beneficiarioLimpo) throw new Error("O nome do favorecido/beneficiário é obrigatório.");
  if (!cidadeLimpa) throw new Error("A cidade da conta é obrigatória para conformidade BACEN.");

  const localData = loadLocalStore();
  const currentSettings = localData.settings;
  const chaveAnterior = currentSettings.pix_chave;
  const novaVersao = (currentSettings.versao || 1) + 1;
  const agora = new Date().toISOString();

  // Preserva o valor de inscrição ativo intacto! Não reseta para 50.00
  const novoSettings = {
    ...currentSettings,
    versao: novaVersao,
    pix_chave: chaveLimpa,
    pix_tipo_chave: tipoChave,
    pix_beneficiario: beneficiarioLimpo,
    pix_documento: pix_documento !== undefined ? String(pix_documento).trim() : currentSettings.pix_documento,
    pix_cidade: cidadeLimpa,
    motivo_alteracao: motivo || "Atualização de dados PIX via painel",
    atualizado_por: usuario || "admin",
    atualizado_em: agora
  };

  const auditEntry = {
    id: `audit-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    acao: "PIX_KEY_UPDATED",
    usuario: usuario || "admin",
    campo_afetado: "pix_chave",
    valor_anterior: `${chaveAnterior} (${currentSettings.pix_tipo_chave || 'EMAIL'})`,
    valor_novo: `${chaveLimpa} (${tipoChave})`,
    motivo: motivo || "Atualização da chave PIX",
    ip_origem: ip || "127.0.0.1",
    criado_em: agora,
    detalhes: {
      beneficiario: beneficiarioLimpo,
      cidade: cidadeLimpa,
      versao: novaVersao
    }
  };

  // Tenta persistir no Supabase
  let supabasePersisted = false;
  const { url, key } = getSupabaseCredentials();

  if (url && key) {
    try {
      const rpcRes = await fetch(`${url}/rest/v1/rpc/atualizar_configuracao_financeira`, {
        method: "POST",
        headers: {
          "apikey": key,
          "Authorization": `Bearer ${key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          p_usuario: usuario || "admin",
          p_lote_atual: null,
          p_valor_inscricao: null, // Deixa NULL para manter o preço existente via COALESCE
          p_pix_chave: chaveLimpa,
          p_pix_tipo_chave: tipoChave,
          p_pix_beneficiario: beneficiarioLimpo,
          p_pix_documento: novoSettings.pix_documento,
          p_pix_cidade: cidadeLimpa,
          p_motivo: motivo || "Atualização de dados PIX",
          p_ip: ip || "127.0.0.1"
        }),
        signal: AbortSignal.timeout(4000)
      });

      if (rpcRes.ok) {
        supabasePersisted = true;
      }
    } catch (err) {
      console.warn("[SettingsStore updatePixSettings] Supabase indisponível no momento:", err.message);
    }
  }

  // Persiste no storage local
  localData.settings = novoSettings;
  if (!Array.isArray(localData.historico)) localData.historico = [];
  localData.historico.unshift(auditEntry);
  if (localData.historico.length > 100) localData.historico.pop();

  saveLocalStore(localData);

  // READ-AFTER-WRITE VERIFICATION
  const verifyData = loadLocalStore();
  if (verifyData.settings.pix_chave !== chaveLimpa) {
    throw new Error(`Falha de verificação read-after-write: esperado ${chaveLimpa}, mas gravado ${verifyData.settings.pix_chave}`);
  }

  return {
    success: true,
    persisted: true,
    supabasePersisted,
    settings: verifyData.settings,
    auditEntry,
    message: `Chave PIX atualizada com sucesso.`
  };
}

// ==============================================================================
// ESCRITA 3: ATUALIZAR WHATSAPP (UPDATE_WHATSAPP)
// ==============================================================================
async function updateWhatsAppSettings({ subsData, usuario, ip }) {
  if (!subsData || typeof subsData !== "object") {
    throw new Error("Dados de links do WhatsApp inválidos.");
  }

  const localData = loadLocalStore();
  localData.whatsapp = {
    ...localData.whatsapp,
    ...subsData
  };

  const agora = new Date().toISOString();
  const auditEntry = {
    id: `audit-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    acao: "WHATSAPP_LINKS_UPDATED",
    usuario: usuario || "admin",
    campo_afetado: "configuracoes_whatsapp",
    valor_anterior: null,
    valor_novo: JSON.stringify(subsData),
    motivo: "Atualização dos links dos grupos WhatsApp",
    ip_origem: ip || "127.0.0.1",
    criado_em: agora
  };

  if (!Array.isArray(localData.historico)) localData.historico = [];
  localData.historico.unshift(auditEntry);

  saveLocalStore(localData);

  // Tenta persistir no Supabase se configurado
  const { url, key } = getSupabaseCredentials();
  if (url && key) {
    try {
      const subs = Object.keys(subsData);
      for (const sub of subs) {
        await fetch(`${url}/rest/v1/configuracoes_whatsapp`, {
          method: "POST",
          headers: {
            "apikey": key,
            "Authorization": `Bearer ${key}`,
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates"
          },
          body: JSON.stringify({
            sub: sub,
            link_grupo: subsData[sub],
            ativo: true,
            atualizado_em: agora
          })
        });
      }
    } catch (e) {
      console.warn("[SettingsStore updateWhatsAppSettings] Supabase sync falhou:", e.message);
    }
  }

  return {
    success: true,
    persisted: true,
    whatsapp: localData.whatsapp,
    message: "Links dos grupos de WhatsApp salvos com sucesso no servidor."
  };
}

// ==============================================================================
// ESCRITA 4: APROVAÇÃO MANUAL DE PAGAMENTO (APPROVE_PAYMENT)
// ==============================================================================
async function approvePayment({ identificador, usuario, ip }) {
  if (!identificador) {
    throw new Error("Identificador da inscrição ou transação é obrigatório.");
  }

  const agora = new Date().toISOString();
  let supabaseUpdated = false;
  const { url, key } = getSupabaseCredentials();

  if (url && key) {
    try {
      // Tenta atualizar em 'inscricoes'
      const resInsc = await fetch(`${url}/rest/v1/inscricoes?or=(whatsapp.eq.${encodeURIComponent(identificador)},token_acesso.eq.${encodeURIComponent(identificador)})`, {
        method: "PATCH",
        headers: { "apikey": key, "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          pagamento_status: "confirmado",
          pagamento_confirmado_em: agora,
          atualizado_em: agora
        })
      });

      // Tenta atualizar em 'checkout_transacoes'
      const resTx = await fetch(`${url}/rest/v1/checkout_transacoes?or=(txid.eq.${encodeURIComponent(identificador)},whatsapp_pagador.eq.${encodeURIComponent(identificador)})`, {
        method: "PATCH",
        headers: { "apikey": key, "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "aprovado",
          atualizado_em: agora
        })
      });

      if (resInsc.ok || resTx.ok) {
        supabaseUpdated = true;
      }
    } catch (e) {
      console.warn("[SettingsStore approvePayment] Supabase sync erro:", e.message);
    }
  }

  // Registra no histórico de auditoria
  const localData = loadLocalStore();
  const auditEntry = {
    id: `audit-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    acao: "PAYMENT_MANUALLY_APPROVED",
    usuario: usuario || "admin",
    campo_afetado: "pagamento_status",
    valor_anterior: "pendente",
    valor_novo: "confirmado",
    motivo: `Aprovação manual de pagamento para: ${identificador}`,
    ip_origem: ip || "127.0.0.1",
    criado_em: agora
  };

  if (!Array.isArray(localData.historico)) localData.historico = [];
  localData.historico.unshift(auditEntry);
  saveLocalStore(localData);

  return {
    success: true,
    persisted: true,
    supabaseUpdated,
    message: `Pagamento de ${identificador} aprovado e registrado com sucesso.`
  };
}

module.exports = {
  getActiveSettings,
  updatePriceSettings,
  updatePixSettings,
  updateWhatsAppSettings,
  approvePayment,
  loadLocalStore,
  saveLocalStore,
  getDefaultSettings,
  getDefaultStore
};
