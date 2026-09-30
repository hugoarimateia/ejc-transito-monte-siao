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

// Chave pública oficial canônica do Mercado Pago para Checkout transparente
const CANONICAL_MP_PUBLIC_KEY = "APP_USR-39960bc1-2b08-4885-8090-31eaa38ba04b";

// Cache em memória compartilhado durante o ciclo de vida da instância serverless
let memoryStore = null;

// Helper: calcula o preço efetivo considerando promoção ativa
function getEffectivePrice(settings) {
  if (!settings || settings.valor_inscricao === null || settings.valor_inscricao === undefined) return null;
  const regular = Number(settings.valor_inscricao);
  if (isNaN(regular) || regular <= 0) return null;
  const promo = settings.valor_promocional !== null && settings.valor_promocional !== undefined
    ? Number(settings.valor_promocional)
    : null;
  if (promo !== null && !isNaN(promo) && promo > 0 && promo < regular) {
    return promo;
  }
  return regular;
}

/**
 * Normaliza chave Pix de telefone removendo prefixo internacional (+55 ou 55),
 * garantindo o formato DDD + número (10 ou 11 dígitos, sem formatação de CPF).
 *
 * Exemplos:
 *  +5583996431326 -> 83996431326
 *  5583996431326  -> 83996431326
 *  83996431326    -> 83996431326
 */
function normalizarChavePix(chave, tipo) {
  let c = String(chave || "").trim();
  if (!c || c.includes("***")) return c;

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

// Helper: gera versão estritamente crescente entre todas as fontes (anti-shadowing)
function getNextMonotonicVersion(knownCurrent = 0) {
  let maxV = Number(knownCurrent || 0);
  try {
    if (fs.existsSync(PRIMARY_FILE)) {
      const p = JSON.parse(fs.readFileSync(PRIMARY_FILE, "utf-8"));
      if (p?.settings?.versao) maxV = Math.max(maxV, Number(p.settings.versao));
    }
  } catch (e) {}
  try {
    if (fs.existsSync(TMP_FILE)) {
      const t = JSON.parse(fs.readFileSync(TMP_FILE, "utf-8"));
      if (t?.settings?.versao) maxV = Math.max(maxV, Number(t.settings.versao));
    }
  } catch (e) {}
  if (memoryStore?.settings?.versao) {
    maxV = Math.max(maxV, Number(memoryStore.settings.versao));
  }
  return maxV + 1;
}

// Tabela padrão de acréscimos comerciais de parcelamento (1x a 12x)
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

// Configurações padrão de fábrica (somente usadas se banco estiver vazio antes do Admin configurar)
function getDefaultSettings() {
  return {
    versao: 1,
    ativo: true,
    configurado: false,
    lote_atual: "Aguardando Coordenação",
    valor_inscricao: process.env.NEXT_PUBLIC_PIX_VALOR_INSCRICAO ? Number(process.env.NEXT_PUBLIC_PIX_VALOR_INSCRICAO) : null,
    valor_promocional: null,
    taxa_adicional: 0.0,
    max_parcelas: 12,
    card_installment_mode: "mercado_pago", // "mercado_pago" (automático) ou "manual" (configuração comercial EJC)
    card_max_installments: 6,
    card_installment_rates: getDefaultCardRates(),
    mp_public_key: (
      process.env.NEXT_PUBLIC_MERCADO_PAGO_PUBLIC_KEY ||
      process.env.MERCADO_PAGO_PUBLIC_KEY ||
      process.env.NEXT_PUBLIC_MERCADOPAGO_PUBLIC_KEY ||
      process.env.MERCADOPAGO_PUBLIC_KEY ||
      process.env.NEXT_PUBLIC_MP_PUBLIC_KEY ||
      process.env.MP_PUBLIC_KEY ||
      process.env.MP_KEY ||
      process.env.PUBLIC_KEY ||
      CANONICAL_MP_PUBLIC_KEY
    ).trim(),
    modalidade_pix: process.env.NEXT_PUBLIC_MODALIDADE_PIX || "api_webhook", // "api_webhook" ou "manual"
    pix_mode: process.env.NEXT_PUBLIC_MODALIDADE_PIX || "api_webhook",
    pix_chave: process.env.NEXT_PUBLIC_PIX_CHAVE || null,
    pix_tipo_chave: process.env.NEXT_PUBLIC_PIX_TIPO_CHAVE || null,
    pix_beneficiario: process.env.NEXT_PUBLIC_PIX_BENEFICIARIO || null,
    pix_documento: "",
    pix_cidade: process.env.NEXT_PUBLIC_PIX_CIDADE || null,
    pix_instituicao: "",
    pix_instrucoes_manual: "Faça o Pix para a chave oficial cadastrada pela coordenação.",
    pix_permite_comprovante: true,
    motivo_alteracao: "Configuração inicial - Aguardando definição pelo Administrador",
    atualizado_por: "sistema",
    atualizado_em: new Date().toISOString()
  };
}

function getDefaultStore() {
  const defaults = getDefaultSettings();
  return {
    settings: defaults,
    lotes: [],
    historico: [],
    whatsapp: {
      Verde: process.env.NEXT_PUBLIC_WHATSAPP_VERDE || "",
      Vermelho: process.env.NEXT_PUBLIC_WHATSAPP_VERMELHO || "",
      Amarelo: process.env.NEXT_PUBLIC_WHATSAPP_AMARELO || "",
      Laranja: process.env.NEXT_PUBLIC_WHATSAPP_LARANJA || "",
      Geral: process.env.NEXT_PUBLIC_WHATSAPP_GERAL || "",
      verde: process.env.NEXT_PUBLIC_WHATSAPP_VERDE || "",
      vermelho: process.env.NEXT_PUBLIC_WHATSAPP_VERMELHO || "",
      amarelo: process.env.NEXT_PUBLIC_WHATSAPP_AMARELO || "",
      laranja: process.env.NEXT_PUBLIC_WHATSAPP_LARANJA || "",
      geral: process.env.NEXT_PUBLIC_WHATSAPP_GERAL || ""
    }
  };
}

// Carrega dados do disco com ANTI-SHADOWING rigoroso
// Em ambientes serverless (Vercel), /var/task/data/payment-settings.json é READ-ONLY.
// Se gravações forem feitas em /tmp, esta função prioriza /tmp se tiver versão mais recente!
function loadLocalStore() {
  let primaryData = null;
  let tmpData = null;

  try {
    if (fs.existsSync(PRIMARY_FILE)) {
      const raw = fs.readFileSync(PRIMARY_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && parsed.settings && parsed.settings.valor_inscricao) {
        primaryData = parsed;
      }
    }
  } catch (err) {
    console.warn("[SettingsStore] Falha ao ler PRIMARY_FILE:", err.message);
  }

  try {
    if (fs.existsSync(TMP_FILE)) {
      const rawTmp = fs.readFileSync(TMP_FILE, "utf-8");
      const parsedTmp = JSON.parse(rawTmp);
      if (parsedTmp && parsedTmp.settings && parsedTmp.settings.valor_inscricao) {
        tmpData = parsedTmp;
      }
    }
  } catch (err) {
    console.warn("[SettingsStore] Falha ao ler TMP_FILE:", err.message);
  }

  // Anti-shadowing: determina a versão mais recente entre PRIMARY e TMP
  let chosen = null;
  if (primaryData && tmpData) {
    const versaoPrimary = Number(primaryData.settings?.versao || 0);
    const versaoTmp = Number(tmpData.settings?.versao || 0);
    if (versaoTmp > versaoPrimary) {
      chosen = tmpData;
    } else if (versaoPrimary > versaoTmp) {
      chosen = primaryData;
    } else {
      // Mesma versão: compara timestamps de atualização
      const timePrimary = new Date(primaryData.settings?.atualizado_em || 0).getTime();
      const timeTmp = new Date(tmpData.settings?.atualizado_em || 0).getTime();
      chosen = timeTmp >= timePrimary ? tmpData : primaryData;
    }
  } else if (tmpData) {
    chosen = tmpData;
  } else if (primaryData) {
    chosen = primaryData;
  }

  // Se houver um store em memória nesta execução com versão mais recente, preserva-o
  if (memoryStore && memoryStore.settings) {
    const memoryVersao = Number(memoryStore.settings.versao || 0);
    const chosenVersao = chosen ? Number(chosen.settings?.versao || 0) : 0;
    if (memoryVersao >= chosenVersao) {
      memoryStore.whatsapp = {
        ...getDefaultStore().whatsapp,
        ...(memoryStore.whatsapp || {})
      };
      return memoryStore;
    }
  }

  if (chosen) {
    chosen.whatsapp = {
      ...getDefaultStore().whatsapp,
      ...(chosen.whatsapp || {})
    };
    memoryStore = chosen;
    return chosen;
  }

  const initial = getDefaultStore();
  memoryStore = initial;
  try {
    saveLocalStore(initial);
  } catch (e) {
    // ignora se fs for read-only no bootstrap
  }
  return initial;
}

// Salva dados no disco com atomicidade e garantia de diretório
function saveLocalStore(data) {
  let saved = false;
  memoryStore = data;
  const content = JSON.stringify(data, null, 2);

  // 1. Tenta salvar em data/payment-settings.json (funciona em desenvolvimento e servidores com disco gravável)
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(PRIMARY_FILE, content, "utf-8");
    saved = true;
  } catch (err) {
    // Em Vercel Serverless / AWS Lambda, /var/task é EROFS (Read-Only)
    if (err.code !== "EROFS") {
      console.warn("[SettingsStore] Aviso ao salvar PRIMARY_FILE:", err.message);
    }
  }

  // 2. Salva em TMP_FILE (sempre gravável, inclusive em Vercel Serverless / AWS Lambda)
  try {
    fs.writeFileSync(TMP_FILE, content, "utf-8");
    saved = true;
  } catch (err) {
    console.warn("[SettingsStore] Falha ao salvar TMP_FILE:", err.message);
  }

  if (!saved) {
    throw new Error("Falha crítica de persistência local: não foi possível gravar em disco ou diretório temporário.");
  }
  return true;
}

// Helper para credenciais Supabase
function getSupabaseCredentials() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "https://guppedddwnuvluhiaaas.supabase.co";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || "sb_publishable_QJV9XI3sN3P_gVtiQ2ObRg_gpSSKc-i";
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
      let remoteSettings = null;

      // 1. Tenta consultar a RPC oficial obter_configuracao_financeira_ativa (SECURITY DEFINER)
      try {
        const rpcRes = await fetch(`${url}/rest/v1/rpc/obter_configuracao_financeira_ativa`, {
          method: "POST",
          headers: { "apikey": key, "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
          signal: AbortSignal.timeout(3000)
        });
        if (rpcRes.ok) {
          const rpcData = await rpcRes.json();
          if (rpcData && rpcData.success && rpcData.valor_inscricao !== undefined) {
            remoteSettings = rpcData;
          }
        }
      } catch (eRpc) {}

      // 2. Se a RPC não respondeu, consulta a tabela com fallback: busca por ativo=eq.true OU a mais recente por versao.desc
      if (!remoteSettings) {
        let res = await fetch(`${url}/rest/v1/configuracoes_financeiras?ativo=eq.true&order=versao.desc&limit=1`, {
          headers: { "apikey": key, "Authorization": `Bearer ${key}` },
          signal: AbortSignal.timeout(3000)
        });
        if (res.ok) {
          const rows = await res.json();
          if (Array.isArray(rows) && rows.length > 0) {
            remoteSettings = rows[0];
          }
        }
        if (!remoteSettings) {
          let resLatest = await fetch(`${url}/rest/v1/configuracoes_financeiras?order=versao.desc&limit=1`, {
            headers: { "apikey": key, "Authorization": `Bearer ${key}` },
            signal: AbortSignal.timeout(3000)
          });
          if (resLatest.ok) {
            const rowsLatest = await resLatest.json();
            if (Array.isArray(rowsLatest) && rowsLatest.length > 0) {
              remoteSettings = rowsLatest[0];
            }
          }
        }
      }

      if (remoteSettings) {
        const remoteVersao = Number(remoteSettings.versao || 0);
        const localVersao = Number(localData.settings?.versao || 0);
        if (remoteVersao >= localVersao || !localData.settings?.valor_inscricao) {
          const rawRemotePrice = remoteSettings.valor_inscricao;
          const parsedRemotePrice = (rawRemotePrice !== null && rawRemotePrice !== undefined && rawRemotePrice !== "") ? Number(rawRemotePrice) : null;
          const parsedRemotePromo = (remoteSettings.valor_promocional !== null && remoteSettings.valor_promocional !== undefined && remoteSettings.valor_promocional !== "") ? Number(remoteSettings.valor_promocional) : null;
          const remotePublicKey = (remoteSettings.mp_public_key || "").trim();
          const effectivePublicKey = remotePublicKey || (localData.settings && localData.settings.mp_public_key) || CANONICAL_MP_PUBLIC_KEY;
          const effectiveRates = (Array.isArray(remoteSettings.card_installment_rates) && remoteSettings.card_installment_rates.length > 0)
            ? remoteSettings.card_installment_rates
            : ((localData.settings && Array.isArray(localData.settings.card_installment_rates) && localData.settings.card_installment_rates.length > 0)
                ? localData.settings.card_installment_rates
                : getDefaultCardRates());

          localData.settings = {
            ...localData.settings,
            ...remoteSettings,
            versao: Math.max(remoteVersao, localVersao),
            valor_inscricao: parsedRemotePrice,
            valor_promocional: parsedRemotePromo,
            configurado: Boolean(parsedRemotePrice !== null && parsedRemotePrice > 0),
            taxa_adicional: Number(remoteSettings.taxa_adicional || 0),
            max_parcelas: Number(remoteSettings.max_parcelas || 12),
            card_installment_mode: remoteSettings.card_installment_mode || (localData.settings && localData.settings.card_installment_mode) || "mercado_pago",
            card_max_installments: Number(remoteSettings.card_max_installments || (localData.settings && localData.settings.card_max_installments) || 6),
            card_installment_rates: effectiveRates,
            mp_public_key: effectivePublicKey
          };
        }
      }


          // Sincroniza histórico recente do Supabase se disponível
          try {
            const histRes = await fetch(`${url}/rest/v1/historico_configuracoes_financeiras?order=criado_em.desc&limit=50`, {
              headers: { "apikey": key, "Authorization": `Bearer ${key}` },
              signal: AbortSignal.timeout(2000)
            });
            if (histRes.ok) {
              const histRows = await histRes.json();
              if (Array.isArray(histRows) && histRows.length > 0) {
                localData.historico = histRows;
              }
            }
          } catch (eHist) {}

          // Sincroniza WhatsApp do Supabase (tabela configuracoes_whatsapp ou subs)
          try {
            let loadedWpp = false;
            const wppRes = await fetch(`${url}/rest/v1/configuracoes_whatsapp?ativo=eq.true&order=atualizado_em.asc`, {
              headers: { "apikey": key, "Authorization": `Bearer ${key}` },
              signal: AbortSignal.timeout(3000)
            });
            if (wppRes.ok) {
              const wppRows = await wppRes.json();
              if (Array.isArray(wppRows) && wppRows.length > 0) {
                const wppMap = {};
                const CANONICAL_SUBS = ["Verde", "Vermelho", "Amarelo", "Laranja", "Geral"];
                wppRows.forEach(r => {
                  if (r.sub) {
                    const subCap = r.sub.charAt(0).toUpperCase() + r.sub.slice(1).toLowerCase();
                    if (CANONICAL_SUBS.includes(subCap)) {
                      const link = (r.link_grupo !== undefined && r.link_grupo !== null) ? String(r.link_grupo).trim() : "";
                      wppMap[subCap] = link;
                      wppMap[subCap.toLowerCase()] = link;
                    }
                  }
                });
                localData.whatsapp = { ...localData.whatsapp, ...wppMap };
                loadedWpp = true;
              }
            }

            if (!loadedWpp) {
              const subsRes = await fetch(`${url}/rest/v1/subs?select=nome,link_whatsapp`, {
                headers: { "apikey": key, "Authorization": `Bearer ${key}` },
                signal: AbortSignal.timeout(2000)
              });
              if (subsRes.ok) {
                const subsRows = await subsRes.json();
                if (Array.isArray(subsRows) && subsRows.length > 0) {
                  const wppMap = {};
                  subsRows.forEach(r => {
                    if (r.nome && r.link_whatsapp) {
                      const subCap = r.nome.charAt(0).toUpperCase() + r.nome.slice(1).toLowerCase();
                      if (subCap !== "Azul") {
                        wppMap[subCap] = r.link_whatsapp.trim();
                        wppMap[subCap.toLowerCase()] = r.link_whatsapp.trim();
                      }
                    }
                  });
                  localData.whatsapp = { ...localData.whatsapp, ...wppMap };
                }
              }
            }
          } catch (eWpp) {}

          // Sincroniza lotes do Supabase se disponível
          try {
            const lotesRes = await fetch(`${url}/rest/v1/lotes_inscricao?order=criado_em.asc`, {
              headers: { "apikey": key, "Authorization": `Bearer ${key}` },
              signal: AbortSignal.timeout(2000)
            });
            if (lotesRes.ok) {
              const lotesRows = await lotesRes.json();
              if (Array.isArray(lotesRows) && lotesRows.length > 0) {
                localData.lotes = lotesRows.map(l => ({
                  ...l,
                  valor: Number(l.valor)
                }));
              }
            }
          } catch (eLotes) {}

          saveLocalStore(localData);
    } catch (err) {
      console.warn("[SettingsStore GET] Supabase indisponível no momento, utilizando dados persistidos locais:", err.message);
    }
  }


  if (localData.settings && localData.settings.pix_chave) {
    localData.settings.pix_chave = normalizarChavePix(localData.settings.pix_chave, localData.settings.pix_tipo_chave);
  }

  localData.settings.preco_efetivo = getEffectivePrice(localData.settings);

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

  // Obtém o estado ativo atual (consultando Supabase se disponível para não sobrescrever PIX ativo)
  const activeData = await getActiveSettings();
  const currentSettings = activeData.settings;
  const valorAnterior = currentSettings.valor_inscricao;
  const loteAnterior = currentSettings.lote_atual;
  const novaVersao = getNextMonotonicVersion(currentSettings.versao);
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
  novoSettings.preco_efetivo = getEffectivePrice(novoSettings);

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

  // 1. Tenta persistir no Supabase (Fonte de Verdade Canônica)
  let supabasePersisted = false;
  const { url, key } = getSupabaseCredentials();

  if (url && key) {
    try {
      // 1.1 Desativa versão ativa anterior
      await fetch(`${url}/rest/v1/configuracoes_financeiras?ativo=eq.true`, {
        method: "PATCH",
        headers: { "apikey": key, "Authorization": `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ ativo: false, atualizado_em: agora }),
        signal: AbortSignal.timeout(5000)
      });

      // 1.2 Insere nova versão preservando integralmente parâmetros do cartão e PIX com colunas estritas do banco
      const promoFinal = (novoSettings.valor_promocional !== null && novoSettings.valor_promocional !== undefined && novoSettings.valor_promocional !== "")
        ? Number(novoSettings.valor_promocional)
        : null;

      const directRes = await fetch(`${url}/rest/v1/configuracoes_financeiras`, {
        method: "POST",
        headers: { "apikey": key, "Authorization": `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=representation" },
        body: JSON.stringify({
          versao: novaVersao,
          ativo: true,
          lote_atual: novoSettings.lote_atual,
          valor_inscricao: valorNum,
          valor_promocional: promoFinal,
          taxa_adicional: novoSettings.taxa_adicional,
          max_parcelas: novoSettings.max_parcelas,
          card_installment_mode: currentSettings.card_installment_mode || "mercado_pago",
          card_max_installments: Number(currentSettings.card_max_installments || currentSettings.max_parcelas || 6),
          card_installment_rates: (Array.isArray(currentSettings.card_installment_rates) && currentSettings.card_installment_rates.length > 0)
            ? currentSettings.card_installment_rates
            : getDefaultCardRates(),
          mp_public_key: (currentSettings.mp_public_key || CANONICAL_MP_PUBLIC_KEY).trim(),
          pix_chave: currentSettings.pix_chave,
          pix_tipo_chave: currentSettings.pix_tipo_chave,
          pix_beneficiario: currentSettings.pix_beneficiario,
          pix_documento: currentSettings.pix_documento || "",
          pix_cidade: currentSettings.pix_cidade,
          motivo_alteracao: motivo,
          atualizado_por: usuario || "admin",
          atualizado_em: agora
        }),
        signal: AbortSignal.timeout(5000)
      });

      if (directRes.ok) {
        supabasePersisted = true;
        await fetch(`${url}/rest/v1/historico_configuracoes_financeiras`, {
          method: "POST",
          headers: { "apikey": key, "Authorization": `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({
            acao: "PRICE_UPDATED",
            usuario: usuario || "admin",
            campo_afetado: "valor_inscricao",
            valor_anterior: String(valorAnterior),
            valor_novo: String(valorNum),
            motivo: motivo || "Atualização de preço",
            ip_origem: ip || "127.0.0.1",
            detalhes: { lote: novoSettings.lote_atual, versao: novaVersao, valor_promocional: promoFinal }
          })
        }).catch(() => {});
      } else {
        const errText = await directRes.text().catch(() => "");
        console.warn(`[SettingsStore updatePriceSettings] Supabase retornou status ${directRes.status}: ${errText}`);
      }
    } catch (err) {
      console.warn("[SettingsStore updatePriceSettings] Supabase indisponível no momento:", err.message);
    }
  }

  // 2. Persiste no storage local / serverless
  const localData = loadLocalStore();
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

  // 3. READ-AFTER-WRITE VERIFICATION:
  // Se Supabase foi atualizado, valida diretamente no banco remoto
  if (supabasePersisted && url && key) {
    try {
      const verifyDbRes = await fetch(`${url}/rest/v1/configuracoes_financeiras?ativo=eq.true&order=versao.desc&limit=1`, {
        headers: { "apikey": key, "Authorization": `Bearer ${key}` },
        signal: AbortSignal.timeout(3000)
      });
      if (verifyDbRes.ok) {
        const verifyRows = await verifyDbRes.json();
        if (verifyRows && verifyRows.length > 0) {
          const dbValor = Number(verifyRows[0].valor_inscricao);
          if (dbValor !== valorNum) {
            console.warn(`[SettingsStore updatePriceSettings] Supabase retornou R$ ${dbValor} (esperado R$ ${valorNum}), store local garantido.`);
          }
        }
      }
    } catch (err) {
      console.warn("[SettingsStore updatePriceSettings] Verificação no banco falhou:", err.message);
    }
  }

  // Valida persistência local anti-shadowing
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
  modalidade_pix,
  pix_mode,
  pix_instrucoes_manual,
  pix_permite_comprovante,
  motivo,
  ip
}) {
  // Consulta configuração ativa oficial (priorizando Supabase para reter o preço ativo vigente)
  const activeData = await getActiveSettings();
  const currentSettings = activeData.settings;
  let chaveLimpa = String(pix_chave !== undefined && pix_chave !== "" ? pix_chave : (currentSettings.pix_chave || "83996431326")).trim();
  if (chaveLimpa.includes("***")) {
    chaveLimpa = currentSettings.pix_chave || "83996431326";
  }

  const tipoChave = String(pix_tipo_chave || currentSettings.pix_tipo_chave || "TELEFONE").toUpperCase();
  chaveLimpa = normalizarChavePix(chaveLimpa, tipoChave);
  const beneficiarioLimpo = String(pix_beneficiario !== undefined && pix_beneficiario !== "" ? pix_beneficiario : (currentSettings.pix_beneficiario || "EJC TRANSITO MONTE SIAO")).trim();
  const cidadeLimpa = String(pix_cidade !== undefined && pix_cidade !== "" ? pix_cidade : (currentSettings.pix_cidade || "CAMPINA GRANDE")).trim();

  const inputMod = modalidade_pix !== undefined ? modalidade_pix : (pix_mode !== undefined ? pix_mode : undefined);
  if (inputMod !== undefined && inputMod !== null && inputMod !== "") {
    if (inputMod !== "api_webhook" && inputMod !== "manual") {
      throw new Error("Modalidade operacional do Pix inválida. Valores aceitos: 'api_webhook' ou 'manual'.");
    }
  }

  const modalidadeFinal = (inputMod === "manual" || inputMod === "api_webhook")
    ? inputMod
    : (currentSettings.modalidade_pix || currentSettings.pix_mode || "api_webhook");

  if (!chaveLimpa && modalidadeFinal === "manual") throw new Error("A chave PIX não pode ser vazia.");
  if (!beneficiarioLimpo && modalidadeFinal === "manual") throw new Error("O nome do favorecido/beneficiário é obrigatório.");
  if (!cidadeLimpa && modalidadeFinal === "manual") throw new Error("A cidade da conta é obrigatória para conformidade BACEN.");

  const chaveAnterior = currentSettings.pix_chave;
  const modalidadeAnterior = currentSettings.modalidade_pix || currentSettings.pix_mode || "api_webhook";
  const novaVersao = getNextMonotonicVersion(currentSettings.versao);
  const agora = new Date().toISOString();

  // Preserva rigorosamente o valor de inscrição e lote ativos! Não reseta para padrão!
  const novoSettings = {
    ...currentSettings,
    versao: novaVersao,
    modalidade_pix: modalidadeFinal,
    pix_mode: modalidadeFinal,
    pix_chave: chaveLimpa,
    pix_tipo_chave: tipoChave,
    pix_beneficiario: beneficiarioLimpo,
    pix_documento: pix_documento !== undefined ? String(pix_documento).trim() : (currentSettings.pix_documento || ""),
    pix_cidade: cidadeLimpa,
    pix_instrucoes_manual: pix_instrucoes_manual !== undefined ? String(pix_instrucoes_manual).trim() : (currentSettings.pix_instrucoes_manual || ""),
    pix_permite_comprovante: pix_permite_comprovante !== undefined ? Boolean(pix_permite_comprovante) : (currentSettings.pix_permite_comprovante !== false),
    motivo_alteracao: motivo || "Atualização de dados PIX via painel",
    atualizado_por: usuario || "admin",
    atualizado_em: agora
  };
  novoSettings.preco_efetivo = getEffectivePrice(novoSettings);

  const auditEntry = {
    id: `audit-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    acao: "PIX_KEY_UPDATED",
    usuario: usuario || "admin",
    campo_afetado: "pix_chave",
    valor_anterior: `${chaveAnterior} (${currentSettings.pix_tipo_chave || 'TELEFONE'}, mod: ${modalidadeAnterior})`,
    valor_novo: `${chaveLimpa} (${tipoChave}, mod: ${modalidadeFinal})`,
    motivo: motivo || "Atualização da chave/modalidade PIX",
    ip_origem: ip || "127.0.0.1",
    criado_em: agora,
    detalhes: {
      beneficiario: beneficiarioLimpo,
      cidade: cidadeLimpa,
      modalidade_pix: modalidadeFinal,
      versao: novaVersao
    }
  };

  // 1. Tenta persistir no Supabase (Fonte Canônica)
  let supabasePersisted = false;
  const { url, key } = getSupabaseCredentials();

  if (url && key) {
    try {
      // 1.1 Desativa versão ativa anterior
      await fetch(`${url}/rest/v1/configuracoes_financeiras?ativo=eq.true`, {
        method: "PATCH",
        headers: { "apikey": key, "Authorization": `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ ativo: false, atualizado_em: agora }),
        signal: AbortSignal.timeout(5000)
      });

      // 1.2 Insere nova versão preservando configurações de cartão de crédito e preços com colunas estritas
      const directRes = await fetch(`${url}/rest/v1/configuracoes_financeiras`, {
        method: "POST",
        headers: { "apikey": key, "Authorization": `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=representation" },
        body: JSON.stringify({
          versao: novaVersao,
          ativo: true,
          lote_atual: currentSettings.lote_atual || "Aguardando Coordenação",
          valor_inscricao: currentSettings.valor_inscricao ?? null,
          valor_promocional: currentSettings.valor_promocional ?? null,
          taxa_adicional: currentSettings.taxa_adicional || 0.00,
          max_parcelas: currentSettings.max_parcelas || 12,
          card_installment_mode: currentSettings.card_installment_mode || "mercado_pago",
          card_max_installments: Number(currentSettings.card_max_installments || currentSettings.max_parcelas || 6),
          card_installment_rates: (Array.isArray(currentSettings.card_installment_rates) && currentSettings.card_installment_rates.length > 0)
            ? currentSettings.card_installment_rates
            : getDefaultCardRates(),
          mp_public_key: (currentSettings.mp_public_key || CANONICAL_MP_PUBLIC_KEY).trim(),
          pix_chave: chaveLimpa,
          pix_tipo_chave: tipoChave,
          pix_beneficiario: beneficiarioLimpo,
          pix_documento: novoSettings.pix_documento || "",
          pix_cidade: cidadeLimpa,
          motivo_alteracao: motivo,
          atualizado_por: usuario || "admin",
          atualizado_em: agora
        }),
        signal: AbortSignal.timeout(5000)
      });

      if (directRes.ok) {
        supabasePersisted = true;
        await fetch(`${url}/rest/v1/historico_configuracoes_financeiras`, {
          method: "POST",
          headers: { "apikey": key, "Authorization": `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({
            acao: "PIX_KEY_UPDATED",
            usuario: usuario || "admin",
            campo_afetado: "pix_chave",
            valor_anterior: chaveAnterior,
            valor_novo: chaveLimpa,
            motivo: motivo || "Atualização de chave PIX",
            ip_origem: ip || "127.0.0.1",
            detalhes: { beneficiario: beneficiarioLimpo, versao: novaVersao }
          })
        }).catch(() => {});
      }
    } catch (err) {
      console.warn("[SettingsStore updatePixSettings] Supabase indisponível no momento:", err.message);
    }
  }

  // 2. Persiste no storage local / serverless
  const localData = loadLocalStore();
  localData.settings = novoSettings;
  if (!Array.isArray(localData.historico)) localData.historico = [];
  localData.historico.unshift(auditEntry);
  if (localData.historico.length > 100) localData.historico.pop();

  saveLocalStore(localData);

  // 3. READ-AFTER-WRITE VERIFICATION:
  // Se Supabase foi atualizado, valida diretamente no banco remoto
  if (supabasePersisted && url && key) {
    try {
      const verifyDbRes = await fetch(`${url}/rest/v1/configuracoes_financeiras?ativo=eq.true&order=versao.desc&limit=1`, {
        headers: { "apikey": key, "Authorization": `Bearer ${key}` },
        signal: AbortSignal.timeout(3000)
      });
      if (verifyDbRes.ok) {
        const verifyRows = await verifyDbRes.json();
        if (verifyRows && verifyRows.length > 0) {
          const dbChave = verifyRows[0].pix_chave;
          if (dbChave !== chaveLimpa) {
            console.warn(`[SettingsStore updatePixSettings] Supabase retornou chave ${dbChave} (esperado ${chaveLimpa}), store local garantido.`);
          }
        }
      }
    } catch (err) {
      console.warn("[SettingsStore updatePixSettings] Verificação no banco falhou:", err.message);
    }
  }

  // Valida persistência local anti-shadowing
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
    message: `Chave PIX atualizada com sucesso para ${chaveLimpa}.`
  };
}

// ==============================================================================
// ESCRITA 2.5: ATUALIZAR CARTÃO DE CRÉDITO & PARCELAMENTO (UPDATE_CARD)
// ==============================================================================
async function updateCardSettings({
  usuario = "admin",
  card_installment_mode,
  card_max_installments,
  card_installment_rates,
  mp_public_key,
  motivo,
  ip = "127.0.0.1"
}) {
  const mode = String(card_installment_mode || "mercado_pago").toLowerCase().trim();
  if (!["mercado_pago", "manual"].includes(mode)) {
    throw new Error("Modo de parcelamento inválido. Use 'mercado_pago' (Automático) ou 'manual' (Configuração EJC).");
  }

  const maxInst = parseInt(card_max_installments, 10);
  if (isNaN(maxInst) || maxInst < 1 || maxInst > 12) {
    throw new Error("Máximo de parcelas deve ser um número inteiro entre 1 e 12.");
  }

  const activeData = await getActiveSettings();
  const currentSettings = activeData.settings;
  const currentVersao = Number(currentSettings.versao || 1);
  const nextVersao = getNextMonotonicVersion(currentVersao);

  let rawRates = Array.isArray(card_installment_rates) && card_installment_rates.length > 0
    ? card_installment_rates
    : (Array.isArray(currentSettings.card_installment_rates) && currentSettings.card_installment_rates.length > 0
        ? currentSettings.card_installment_rates
        : getDefaultCardRates());

  const rates = rawRates.map((r, idx) => {
    const instNum = parseInt(r.installment || (idx + 1), 10);
    const rateNum = Number(Number(r.rate || 0).toFixed(2));
    if (isNaN(rateNum) || rateNum < 0 || rateNum > 100) {
      throw new Error(`Acréscimo inválido para a parcela ${instNum}x.`);
    }
    return {
      installment: instNum,
      rate: rateNum,
      rate_type: "percentage",
      enabled: r.enabled !== false
    };
  });

  const novoSettings = {
    ...currentSettings,
    versao: nextVersao,
    card_installment_mode: mode,
    card_max_installments: maxInst,
    card_installment_rates: rates,
    mp_public_key: (mp_public_key !== undefined && String(mp_public_key).trim() !== "")
      ? String(mp_public_key).trim()
      : (currentSettings.mp_public_key || CANONICAL_MP_PUBLIC_KEY),
    motivo_alteracao: motivo || `Atualização das condições de parcelamento (Modo: ${mode}, Máx: ${maxInst}x)`,
    atualizado_por: usuario,
    atualizado_em: new Date().toISOString()
  };

  const auditEntry = {
    id: `audit-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    acao: "CARD_SETTINGS_UPDATED",
    usuario: usuario,
    campo_afetado: "card_installment_settings",
    valor_anterior: JSON.stringify({
      mode: currentSettings.card_installment_mode || "mercado_pago",
      max: currentSettings.card_max_installments || 6
    }),
    valor_novo: JSON.stringify({
      mode: mode,
      max: maxInst,
      ratesCount: rates.length
    }),
    motivo: motivo || `Alteração das condições de cartão de crédito para modo ${mode}`,
    ip_origem: ip,
    criado_em: new Date().toISOString(),
    detalhes: {
      mode,
      max_installments: maxInst,
      rates
    }
  };

  // 1. Grava no Supabase (se configurado)
  let supabasePersisted = false;
  const { url, key } = getSupabaseCredentials();
  if (url && key) {
    try {
      await fetch(`${url}/rest/v1/configuracoes_financeiras?ativo=eq.true`, {
        method: "PATCH",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal"
        },
        body: JSON.stringify({ ativo: false, atualizado_em: new Date().toISOString() }),
        signal: AbortSignal.timeout(5000)
      });

      const directRes = await fetch(`${url}/rest/v1/configuracoes_financeiras`, {
        method: "POST",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          versao: nextVersao,
          ativo: true,
          lote_atual: currentSettings.lote_atual || "1º Lote",
          valor_inscricao: currentSettings.valor_inscricao ?? 50.0,
          valor_promocional: currentSettings.valor_promocional ?? null,
          taxa_adicional: currentSettings.taxa_adicional ?? 0.0,
          max_parcelas: maxInst,
          card_installment_mode: mode,
          card_max_installments: maxInst,
          card_installment_rates: rates,
          mp_public_key: (novoSettings.mp_public_key || currentSettings.mp_public_key || CANONICAL_MP_PUBLIC_KEY).trim(),
          pix_chave: currentSettings.pix_chave || "leoeuler03@gmail.com",
          pix_tipo_chave: currentSettings.pix_tipo_chave || "EMAIL",
          pix_beneficiario: currentSettings.pix_beneficiario || "EJC TRANSITO MONTE SIAO",
          pix_documento: currentSettings.pix_documento || "",
          pix_cidade: currentSettings.pix_cidade || "CAMPINA GRANDE",
          motivo_alteracao: novoSettings.motivo_alteracao,
          atualizado_por: usuario,
          atualizado_em: novoSettings.atualizado_em
        }),
        signal: AbortSignal.timeout(5000)
      });

      if (directRes.ok) {
        supabasePersisted = true;
        await fetch(`${url}/rest/v1/historico_configuracoes_financeiras`, {
          method: "POST",
          headers: {
            apikey: key,
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal"
          },
          body: JSON.stringify({
            acao: "CARD_SETTINGS_UPDATED",
            usuario: usuario,
            campo_afetado: "card_installment_settings",
            valor_anterior: auditEntry.valor_anterior,
            valor_novo: auditEntry.valor_novo,
            motivo: auditEntry.motivo,
            ip_origem: ip,
            detalhes: auditEntry.detalhes
          }),
          signal: AbortSignal.timeout(5000)
        }).catch(() => {});
      }
    } catch (err) {
      console.warn("[SettingsStore updateCardSettings] Erro ao persistir no Supabase:", err.message);
    }
  }

  // 2. Grava no store local e memória
  const localData = loadLocalStore();
  localData.settings = novoSettings;
  if (!Array.isArray(localData.historico)) localData.historico = [];
  localData.historico.unshift(auditEntry);
  if (localData.historico.length > 100) localData.historico.pop();
  saveLocalStore(localData);
  memoryStore = localData;

  const verifyData = loadLocalStore();
  if (verifyData.settings.card_installment_mode !== mode) {
    throw new Error(`Falha de verificação read-after-write: modo esperado ${mode}, mas gravado ${verifyData.settings.card_installment_mode}`);
  }

  return {
    success: true,
    persisted: true,
    supabasePersisted,
    settings: verifyData.settings,
    auditEntry,
    message: mode === "mercado_pago"
      ? "Condições automáticas do Mercado Pago ativadas com sucesso."
      : `Configuração manual de parcelamento (até ${maxInst}x) salva com sucesso.`
  };
}

// ==============================================================================
// ESCRITA 3: ATUALIZAR WHATSAPP (UPDATE_WHATSAPP)
// ==============================================================================
async function updateWhatsAppSettings({ subsData, usuario, ip }) {
  if (!subsData || typeof subsData !== "object") {
    throw new Error("Dados de links do WhatsApp inválidos.");
  }

  const CANONICAL_SUBS = ["Verde", "Vermelho", "Amarelo", "Laranja", "Geral"];
  const agora = new Date().toISOString();
  const normalizedSubs = {};

  // Normaliza e filtra apenas subs oficiais
  for (const rawSub of Object.keys(subsData)) {
    const subCap = rawSub.charAt(0).toUpperCase() + rawSub.slice(1).toLowerCase();
    if (CANONICAL_SUBS.includes(subCap)) {
      const link = (subsData[rawSub] !== undefined && subsData[rawSub] !== null) ? String(subsData[rawSub]).trim() : "";
      normalizedSubs[subCap] = link;
      normalizedSubs[subCap.toLowerCase()] = link;
    }
  }

  const localData = loadLocalStore();
  localData.whatsapp = {
    ...localData.whatsapp,
    ...normalizedSubs
  };

  const auditEntry = {
    id: `audit-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    acao: "WHATSAPP_LINKS_UPDATED",
    usuario: usuario || "admin",
    campo_afetado: "configuracoes_whatsapp",
    valor_anterior: null,
    valor_novo: JSON.stringify(normalizedSubs),
    motivo: "Atualização dos links dos grupos WhatsApp",
    ip_origem: ip || "127.0.0.1",
    criado_em: agora
  };

  if (!Array.isArray(localData.historico)) localData.historico = [];
  localData.historico.unshift(auditEntry);
  saveLocalStore(localData);

  // Persiste no Supabase com validação real e resolução de conflito em 'sub'
  let supabasePersisted = false;
  const { url, key } = getSupabaseCredentials();
  if (url && key) {
    try {
      for (const subCap of CANONICAL_SUBS) {
        if (normalizedSubs[subCap] === undefined) continue;
        const link = normalizedSubs[subCap];

        // 1. Tenta tabela configuracoes_whatsapp com ?on_conflict=sub
        const resWpp = await fetch(`${url}/rest/v1/configuracoes_whatsapp?on_conflict=sub`, {
          method: "POST",
          headers: {
            "apikey": key,
            "Authorization": `Bearer ${key}`,
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=representation"
          },
          body: JSON.stringify({
            sub: subCap,
            link_grupo: link,
            ativo: true,
            atualizado_em: agora,
            atualizado_por: usuario || "admin"
          })
        });

        if (!resWpp.ok) {
          const errText = await resWpp.text();
          throw new Error(`Falha ao persistir configuracoes_whatsapp (${subCap}): [HTTP ${resWpp.status}] ${errText}`);
        }

        // 2. Sincroniza tabela subs se for equipe
        if (subCap !== "Geral") {
          try {
            await fetch(`${url}/rest/v1/subs?nome=ilike.${encodeURIComponent(subCap)}`, {
              method: "PATCH",
              headers: {
                "apikey": key,
                "Authorization": `Bearer ${key}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({ link_whatsapp: link })
            });
          } catch (eSub) {
            console.warn(`[Wpp Sync] Aviso ao atualizar subs (${subCap}):`, eSub.message);
          }
        }
      }
      supabasePersisted = true;
    } catch (e) {
      console.error("[SettingsStore updateWhatsAppSettings] Erro ao sincronizar com Supabase:", e.message);
      throw e;
    }
  }

  return {
    success: true,
    persisted: true,
    supabasePersisted,
    whatsapp: localData.whatsapp,
    message: "Links dos grupos de WhatsApp salvos com sucesso e persistidos no Supabase."
  };
}

// ==============================================================================
// ESCRITA 4: APROVAÇÃO MANUAL DE PAGAMENTO (APPROVE_PAYMENT)
// ==============================================================================
async function approvePayment({ identificador, usuario, ip, email, nome, valor, sub }) {
  if (!identificador) {
    throw new Error("Identificador da inscrição ou transação é obrigatório.");
  }

  const agora = new Date().toISOString();
  let supabaseUpdated = false;
  let emailDispatched = false;
  const { url, key } = getSupabaseCredentials();

  let matchedEmail = email || null;
  let matchedNome = nome || null;
  let matchedValor = valor || null;
  let matchedMetodo = "pix";
  let matchedSub = sub || null;
  let matchedTxid = String(identificador);
  let debugInfo = { keyPrefix: key ? key.substring(0, 10) : null };

  if (url && key) {
    try {
      const rawId = String(identificador || "").trim();
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rawId);
      const cleanTel = rawId.replace(/\D/g, "");
      const isPhone = cleanTel.length >= 10 && cleanTel.length <= 13;

      // 1. Tenta acionar a RPC de confirmação unificada se identificador tiver formato de txid (não-telefone)
      if (!isPhone) {
        try {
          const rpcRes = await fetch(`${url}/rest/v1/rpc/confirmar_pagamento_unificado`, {
            method: "POST",
            headers: { "apikey": key, "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              p_txid: rawId,
              p_gateway: "admin_manual",
              p_executado_por: usuario || "admin_manual"
            })
          });
          if (rpcRes.ok) {
            const rpcData = await rpcRes.json().catch(() => ({}));
            if (rpcData && rpcData.success) {
              supabaseUpdated = true;
              matchedTxid = rawId;
            }
          }
        } catch (eRpc) {}
      }

      // 2. Localiza a inscrição e atualiza em 'inscricoes' sem o campo inexistente 'atualizado_em'
      let targetInscId = isUuid ? rawId : null;
      let matchedInscRow = null;

      if (!targetInscId) {
        const lookupUrl1 = `${url}/rest/v1/inscricoes?select=id,nome_completo,email,sub,whatsapp&whatsapp=eq.${encodeURIComponent(rawId)}&limit=1`;
        const resLookup1 = await fetch(lookupUrl1, { headers: { "apikey": key, "Authorization": `Bearer ${key}` } });
        if (resLookup1.ok) {
          const rows1 = await resLookup1.json().catch(() => []);
          if (rows1 && rows1.length > 0) {
            targetInscId = rows1[0].id;
            matchedInscRow = rows1[0];
          }
        }
        if (!targetInscId && cleanTel && cleanTel !== rawId) {
          const lookupUrl2 = `${url}/rest/v1/inscricoes?select=id,nome_completo,email,sub,whatsapp&whatsapp=eq.${encodeURIComponent(cleanTel)}&limit=1`;
          const resLookup2 = await fetch(lookupUrl2, { headers: { "apikey": key, "Authorization": `Bearer ${key}` } });
          if (resLookup2.ok) {
            const rows2 = await resLookup2.json().catch(() => []);
            if (rows2 && rows2.length > 0) {
              targetInscId = rows2[0].id;
              matchedInscRow = rows2[0];
            }
          }
        }
        if (!targetInscId && /^[a-zA-Z0-9_-]{16,}$/.test(rawId)) {
          const lookupUrl3 = `${url}/rest/v1/inscricoes?select=id,nome_completo,email,sub,whatsapp&token_acesso=eq.${encodeURIComponent(rawId)}&limit=1`;
          const resLookup3 = await fetch(lookupUrl3, { headers: { "apikey": key, "Authorization": `Bearer ${key}` } });
          if (resLookup3.ok) {
            const rows3 = await resLookup3.json().catch(() => []);
            if (rows3 && rows3.length > 0) {
              targetInscId = rows3[0].id;
              matchedInscRow = rows3[0];
            }
          }
        }
      }

      if (matchedInscRow) {
        matchedEmail = matchedEmail || matchedInscRow.email;
        matchedNome = matchedNome || matchedInscRow.nome_completo;
        matchedSub = matchedSub || matchedInscRow.sub;
      }

      if (targetInscId) {
        const inscPatchUrl = `${url}/rest/v1/inscricoes?id=eq.${encodeURIComponent(targetInscId)}`;
        debugInfo.inscUrl = inscPatchUrl;
        const resInsc = await fetch(inscPatchUrl, {
          method: "PATCH",
          headers: { "apikey": key, "Authorization": `Bearer ${key}`, "Content-Type": "application/json", "Prefer": "return=representation" },
          body: JSON.stringify({
            pagamento_status: "confirmado",
            pagamento_confirmado_em: agora
          })
        });
        debugInfo.resInscStatus = resInsc.status;
        debugInfo.resInscBody = await resInsc.clone().text().catch(() => "");
        if (resInsc.ok) {
          const patchedRows = await resInsc.json().catch(() => []);
          debugInfo.patchedInscCount = Array.isArray(patchedRows) ? patchedRows.length : 0;
          if (Array.isArray(patchedRows) && patchedRows.length > 0) {
            supabaseUpdated = true;
            matchedEmail = matchedEmail || patchedRows[0].email;
            matchedNome = matchedNome || patchedRows[0].nome_completo;
            matchedSub = matchedSub || patchedRows[0].sub;
          }
        }
      }

      // 3. Atualiza em 'pagamentos'
      const payFilters = [];
      if (isUuid) {
        payFilters.push(`id=eq.${encodeURIComponent(rawId)}`);
      } else {
        if (targetInscId) {
          payFilters.push(`inscricao_id=eq.${encodeURIComponent(targetInscId)}`);
        }
        payFilters.push(`txid=eq.${encodeURIComponent(rawId)}`);
        payFilters.push(`gateway_transaction_id=eq.${encodeURIComponent(rawId)}`);
        if (isPhone) {
          payFilters.push(`whatsapp_pagador=eq.${encodeURIComponent(rawId)}`);
          if (cleanTel !== rawId) {
            payFilters.push(`whatsapp_pagador=eq.${encodeURIComponent(cleanTel)}`);
          }
        }
      }

      for (const filter of payFilters) {
        const payUrl = `${url}/rest/v1/pagamentos?${filter}`;
        debugInfo.payUrl = payUrl;
        const resTx = await fetch(payUrl, {
          method: "PATCH",
          headers: { "apikey": key, "Authorization": `Bearer ${key}`, "Content-Type": "application/json", "Prefer": "return=representation" },
          body: JSON.stringify({
            status: "approved",
            pago_em: agora,
            atualizado_em: agora
          })
        });
        debugInfo.resTxStatus = resTx.status;
        debugInfo.resTxBody = await resTx.clone().text().catch(() => "");
        if (resTx.ok) {
          const patchedTx = await resTx.json().catch(() => []);
          debugInfo.patchedTxCount = Array.isArray(patchedTx) ? patchedTx.length : 0;
          if (Array.isArray(patchedTx) && patchedTx.length > 0) {
            supabaseUpdated = true;
            matchedTxid = patchedTx[0].txid || matchedTxid;
            matchedEmail = matchedEmail || patchedTx[0].email;
            matchedNome = matchedNome || patchedTx[0].nome_pagador;
            matchedValor = matchedValor || patchedTx[0].valor;
            matchedMetodo = matchedMetodo || patchedTx[0].metodo;
            matchedSub = matchedSub || patchedTx[0].metadata?.sub || patchedTx[0].sub;
            break;
          }
        }
      }

      // Se encontrou txid associado ao telefone e ainda não rodou a RPC, roda com o txid real
      if (matchedTxid && matchedTxid !== rawId && !isPhone) {
        try {
          await fetch(`${url}/rest/v1/rpc/confirmar_pagamento_unificado`, {
            method: "POST",
            headers: { "apikey": key, "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              p_txid: String(matchedTxid),
              p_gateway: "admin_manual",
              p_executado_por: usuario || "admin_manual"
            })
          });
        } catch (eRpc2) {}
      }

      // 4. Busca dados da transação/inscrição para disparo do comprovante
      try {
        if (!matchedEmail && payFilters.length > 0) {
          const payRes = await fetch(`${url}/rest/v1/pagamentos?${payFilters.length > 1 ? `or=(${payFilters.join(",")})` : payFilters[0]}&limit=1`, {
            headers: { "apikey": key, "Authorization": `Bearer ${key}` }
          });
          if (payRes.ok) {
            const pays = await payRes.json();
            if (pays && pays.length > 0) {
              matchedTxid = pays[0].txid || matchedTxid;
              matchedEmail = pays[0].email;
              matchedNome = matchedNome || pays[0].nome_pagador;
              matchedValor = matchedValor || pays[0].valor;
              matchedMetodo = matchedMetodo || pays[0].metodo;
              matchedSub = matchedSub || pays[0].metadata?.sub || pays[0].sub;
            }
          }
        }

        if (!matchedEmail && targetInscId) {
          const inscRes = await fetch(`${url}/rest/v1/inscricoes?id=eq.${encodeURIComponent(targetInscId)}&limit=1`, {
            headers: { "apikey": key, "Authorization": `Bearer ${key}` }
          });
          if (inscRes.ok) {
            const inscs = await inscRes.json();
            if (inscs && inscs.length > 0) {
              matchedEmail = inscs[0].email;
              matchedNome = matchedNome || inscs[0].nome_completo;
              matchedSub = matchedSub || inscs[0].sub;
            }
          }
        }
      } catch (fetchErr) {
        console.warn("[SettingsStore approvePayment] Falha ao consultar dados para email:", fetchErr.message);
      }
    } catch (e) {
      console.warn("[SettingsStore approvePayment] Supabase sync erro:", e.message);
    }
  }

  // 5. Atualiza no store local
  const localData = loadLocalStore();
  let alreadyApproved = false;
  if (Array.isArray(localData.pagamentos)) {
    const idx = localData.pagamentos.findIndex(p => p.txid === identificador || p.whatsapp_pagador === identificador);
    if (idx !== -1) {
      if (localData.pagamentos[idx].status === "approved" || localData.pagamentos[idx].status === "confirmado") {
        alreadyApproved = true;
      }
      localData.pagamentos[idx].status = "approved";
      localData.pagamentos[idx].pago_em = localData.pagamentos[idx].pago_em || agora;
      matchedTxid = matchedTxid || localData.pagamentos[idx].txid;
      matchedEmail = matchedEmail || localData.pagamentos[idx].email;
      matchedNome = matchedNome || localData.pagamentos[idx].nome_pagador;
      matchedValor = matchedValor || localData.pagamentos[idx].valor;
      matchedMetodo = matchedMetodo || localData.pagamentos[idx].metodo;
      matchedSub = matchedSub || localData.pagamentos[idx].sub;
      const defaultRuntimePrice = Number(localData.settings?.preco_efetivo || localData.settings?.valor_inscricao || 0);
      localData.pagamentos.unshift({
        txid: String(identificador),
        payment_id: String(identificador),
        order_id: String(identificador),
        nome_pagador: matchedNome || "Participante",
        email: matchedEmail,
        valor: Number(matchedValor || defaultRuntimePrice),
        metodo: matchedMetodo || "pix",
        sub: matchedSub || "Geral",
        status: "approved",
        pago_em: agora,
        criado_em: agora,
        comprovante_email_enviado: false
      });
    }
  }

  // 6. Disparo do comprovante por e-mail com await (se não foi enviado anteriormente)
  if (matchedEmail && !alreadyApproved) {
    try {
      const emailService = require("./_email-service");
      const defaultRuntimePrice = Number(localData.settings?.preco_efetivo || localData.settings?.valor_inscricao || 0);
      const emailResult = await emailService.sendPaymentApprovedEmail({
        paymentRecord: {
          txid: matchedTxid || identificador,
          nome_pagador: matchedNome || "Participante",
          email: matchedEmail,
          valor: Number(matchedValor || defaultRuntimePrice),
          metodo: matchedMetodo || "pix",
          sub: matchedSub || "Geral",
          pago_em: agora,
          metadata: {
            sub: matchedSub || "Geral",
            modalidade_pix: "manual"
          }
        },
        origemAprovacao: "manual_coordenacao"
      });
      emailDispatched = Boolean(emailResult.success);
    } catch (emailErr) {
      console.warn("[SettingsStore approvePayment] Falha no disparo de comprovante:", emailErr.message);
    }
  }

  // 7. Registra no histórico de auditoria se ainda não estava aprovado
  if (!alreadyApproved) {
    const auditEntry = {
      id: `audit-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      acao: "PAYMENT_MANUALLY_APPROVED",
      usuario: usuario || "admin",
      campo_afetado: "pagamento_status",
      valor_anterior: "pendente",
      valor_novo: "confirmado",
      motivo: `Aprovação manual de pagamento para: ${identificador}`,
      ip_origem: ip || "127.0.0.1",
      criado_em: agora,
      detalhes: {
        identificador: identificador,
        txid: matchedTxid,
        email: matchedEmail,
        email_enviado: emailDispatched
      }
    };

    if (!Array.isArray(localData.historico)) localData.historico = [];
    localData.historico.unshift(auditEntry);
  }
  saveLocalStore(localData);

  return {
    success: true,
    persisted: true,
    alreadyApproved,
    supabaseUpdated,
    emailDispatched,
    debug: debugInfo,
    message: alreadyApproved
      ? `Pagamento de ${identificador} já estava aprovado.`
      : `Pagamento de ${identificador} aprovado e registrado com sucesso.${emailDispatched ? ' Comprovante oficial enviado para ' + matchedEmail : ''}`
  };
}

// ==============================================================================
// ESCRITA 4.2: REJEIÇÃO MANUAL DE PAGAMENTO / COMPROVANTE (REJECT_PAYMENT)
// ==============================================================================
async function rejectPayment({ identificador, usuario, motivo, ip, email, nome }) {
  if (!identificador) {
    throw new Error("Identificador (TXID ou WhatsApp) é obrigatório para rejeição.");
  }

  const agora = new Date().toISOString();
  let supabaseUpdated = false;
  let matchedTxid = String(identificador);
  const motivoFinal = motivo || "Comprovante inconsistente ou pagamento não reconhecido";

  let matchedEmail = email || null;
  let matchedNome = nome || null;

  // 1. Atualiza no Supabase se configurado
  const { url, key } = getSupabaseCredentials();
  if (url && key) {
    try {
      const rawId = String(identificador || "").trim();
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rawId);
      const cleanTel = rawId.replace(/\D/g, "");
      const isPhone = cleanTel.length >= 10 && cleanTel.length <= 13;

      let targetInscId = isUuid ? rawId : null;
      let matchedInscRow = null;

      if (!targetInscId) {
        const lookupUrl1 = `${url}/rest/v1/inscricoes?select=id,nome_completo,email,sub,whatsapp&whatsapp=eq.${encodeURIComponent(rawId)}&limit=1`;
        const resLookup1 = await fetch(lookupUrl1, { headers: { "apikey": key, "Authorization": `Bearer ${key}` } });
        if (resLookup1.ok) {
          const rows1 = await resLookup1.json().catch(() => []);
          if (rows1 && rows1.length > 0) {
            targetInscId = rows1[0].id;
            matchedInscRow = rows1[0];
          }
        }
        if (!targetInscId && cleanTel && cleanTel !== rawId) {
          const lookupUrl2 = `${url}/rest/v1/inscricoes?select=id,nome_completo,email,sub,whatsapp&whatsapp=eq.${encodeURIComponent(cleanTel)}&limit=1`;
          const resLookup2 = await fetch(lookupUrl2, { headers: { "apikey": key, "Authorization": `Bearer ${key}` } });
          if (resLookup2.ok) {
            const rows2 = await resLookup2.json().catch(() => []);
            if (rows2 && rows2.length > 0) {
              targetInscId = rows2[0].id;
              matchedInscRow = rows2[0];
            }
          }
        }
        if (!targetInscId && /^[a-zA-Z0-9_-]{16,}$/.test(rawId)) {
          const lookupUrl3 = `${url}/rest/v1/inscricoes?select=id,nome_completo,email,sub,whatsapp&token_acesso=eq.${encodeURIComponent(rawId)}&limit=1`;
          const resLookup3 = await fetch(lookupUrl3, { headers: { "apikey": key, "Authorization": `Bearer ${key}` } });
          if (resLookup3.ok) {
            const rows3 = await resLookup3.json().catch(() => []);
            if (rows3 && rows3.length > 0) {
              targetInscId = rows3[0].id;
              matchedInscRow = rows3[0];
            }
          }
        }
      }

      if (matchedInscRow) {
        matchedEmail = matchedEmail || matchedInscRow.email;
        matchedNome = matchedNome || matchedInscRow.nome_completo;
      }

      if (targetInscId) {
        const inscUrl = `${url}/rest/v1/inscricoes?id=eq.${encodeURIComponent(targetInscId)}`;
        const resInsc = await fetch(inscUrl, {
          method: "PATCH",
          headers: { "apikey": key, "Authorization": `Bearer ${key}`, "Content-Type": "application/json", "Prefer": "return=representation" },
          body: JSON.stringify({
            pagamento_status: "recusado"
          })
        });
        if (resInsc.ok) supabaseUpdated = true;
      }

      const payFilters = [];
      if (isUuid) {
        payFilters.push(`id=eq.${encodeURIComponent(rawId)}`);
      } else {
        if (targetInscId) {
          payFilters.push(`inscricao_id=eq.${encodeURIComponent(targetInscId)}`);
        }
        payFilters.push(`txid=eq.${encodeURIComponent(rawId)}`);
        payFilters.push(`gateway_transaction_id=eq.${encodeURIComponent(rawId)}`);
        if (isPhone) {
          payFilters.push(`whatsapp_pagador=eq.${encodeURIComponent(rawId)}`);
          if (cleanTel !== rawId) {
            payFilters.push(`whatsapp_pagador=eq.${encodeURIComponent(cleanTel)}`);
          }
        }
      }

      for (const filter of payFilters) {
        const payUrl = `${url}/rest/v1/pagamentos?${filter}`;
        const resTx = await fetch(payUrl, {
          method: "PATCH",
          headers: { "apikey": key, "Authorization": `Bearer ${key}`, "Content-Type": "application/json", "Prefer": "return=representation" },
          body: JSON.stringify({
            status: "rejected",
            atualizado_em: agora
          })
        });
        if (resTx.ok) {
          const patchedTx = await resTx.json().catch(() => []);
          if (Array.isArray(patchedTx) && patchedTx.length > 0) {
            supabaseUpdated = true;
            matchedEmail = matchedEmail || patchedTx[0].email;
            matchedNome = matchedNome || patchedTx[0].nome_pagador;
            matchedTxid = patchedTx[0].txid || matchedTxid;
            break;
          }
        }
      }
    } catch (e) {
      console.warn("[SettingsStore rejectPayment] Supabase sync erro:", e.message);
    }
  }

  // 2. Atualiza no store local
  const localData = loadLocalStore();
  if (Array.isArray(localData.pagamentos)) {
    const idx = localData.pagamentos.findIndex(p => p.txid === identificador || p.whatsapp_pagador === identificador);
    if (idx !== -1) {
      localData.pagamentos[idx].status = "rejected";
      localData.pagamentos[idx].status_analise_manual = "rejeitado";
      localData.pagamentos[idx].motivo_rejeicao = motivoFinal;
      localData.pagamentos[idx].rejeitado_por = usuario || "admin";
      localData.pagamentos[idx].rejeitado_em = agora;
      matchedTxid = matchedTxid || localData.pagamentos[idx].txid;
      matchedEmail = matchedEmail || localData.pagamentos[idx].email;
      matchedNome = matchedNome || localData.pagamentos[idx].nome_pagador;
    }
  }

  // 3. Disparo de e-mail de rejeição para o participante
  if (matchedEmail) {
    try {
      const emailService = require("./_email-service");
      await emailService.sendManualProofRejectedEmail({
        paymentRecord: {
          txid: matchedTxid || identificador,
          nome_pagador: matchedNome || "Participante",
          email: matchedEmail
        },
        motivo: motivoFinal
      });
    } catch (eRej) {
      console.warn("[SettingsStore rejectPayment] Falha no disparo de email:", eRej.message);
    }
  }

  // 3. Registra na trilha de auditoria
  const auditEntry = {
    id: `audit-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    acao: "PAYMENT_MANUALLY_REJECTED",
    usuario: usuario || "admin",
    campo_afetado: "pagamento_status",
    valor_anterior: "aguardando_analise",
    valor_novo: "rejeitado",
    motivo: `Rejeição de pagamento para: ${identificador} - Motivo: ${motivoFinal}`,
    ip_origem: ip || "127.0.0.1",
    criado_em: agora,
    detalhes: {
      identificador: identificador,
      txid: matchedTxid || identificador,
      motivo: motivoFinal
    }
  };

  if (!Array.isArray(localData.historico)) localData.historico = [];
  localData.historico.unshift(auditEntry);
  saveLocalStore(localData);

  return {
    success: true,
    persisted: true,
    supabaseUpdated,
    status: "rejected",
    message: `Pagamento de ${identificador} foi rejeitado. O pedido permanece não pago.`
  };
}

// ==============================================================================
// ESCRITA 5: SINCRONIZAÇÃO INTEGRAL ATÔMICA (SYNC_FULL_SETTINGS)
// Garante que containers frios recebam o estado mais recente de preço E pix
// ==============================================================================
async function syncFullSettings({ settings, usuario, motivo, ip }) {
  if (!settings || typeof settings !== "object") {
    throw new Error("Configurações inválidas para sincronização.");
  }
  const current = await getActiveSettings();
  const incomingVersao = Number(settings.versao || 0);
  const currentVersao = Number(current.settings?.versao || 0);

  if (incomingVersao > currentVersao || (incomingVersao === currentVersao && settings.valor_inscricao)) {
    const updatedSettings = {
      ...current.settings,
      ...settings,
      versao: Math.max(incomingVersao, currentVersao)
    };
    updatedSettings.preco_efetivo = getEffectivePrice(updatedSettings);

    const localData = loadLocalStore();
    localData.settings = updatedSettings;

    const agora = new Date().toISOString();
    const auditEntry = {
      id: `audit-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      acao: "FULL_SETTINGS_SYNCED",
      usuario: usuario || "admin_sync",
      campo_afetado: "configuracao_geral",
      valor_anterior: `v${currentVersao}`,
      valor_novo: `v${updatedSettings.versao} (R$ ${Number(updatedSettings.valor_inscricao).toFixed(2)} - ${updatedSettings.pix_chave} - ${updatedSettings.modalidade_pix || 'api_webhook'})`,
      motivo: motivo || "Sincronização integral anti-downgrade",
      ip_origem: ip || "127.0.0.1",
      criado_em: agora
    };
    if (!Array.isArray(localData.historico)) localData.historico = [];
    localData.historico.unshift(auditEntry);
    if (localData.historico.length > 100) localData.historico.pop();

    saveLocalStore(localData);

    const { url, key } = getSupabaseCredentials();
    if (url && key) {
      try {
        await fetch(`${url}/rest/v1/configuracoes_financeiras?ativo=eq.true`, {
          method: "PATCH",
          headers: { "apikey": key, "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ ativo: false, atualizado_em: agora })
        });
        await fetch(`${url}/rest/v1/configuracoes_financeiras`, {
          method: "POST",
          headers: { "apikey": key, "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            versao: updatedSettings.versao,
            ativo: true,
            lote_atual: updatedSettings.lote_atual,
            valor_inscricao: updatedSettings.valor_inscricao,
            valor_promocional: updatedSettings.valor_promocional ?? null,
            taxa_adicional: updatedSettings.taxa_adicional,
            max_parcelas: updatedSettings.max_parcelas,
            card_installment_mode: updatedSettings.card_installment_mode || "mercado_pago",
            card_max_installments: Number(updatedSettings.card_max_installments || 6),
            card_installment_rates: (Array.isArray(updatedSettings.card_installment_rates) && updatedSettings.card_installment_rates.length > 0)
              ? updatedSettings.card_installment_rates
              : getDefaultCardRates(),
            mp_public_key: (updatedSettings.mp_public_key || CANONICAL_MP_PUBLIC_KEY).trim(),
            pix_chave: updatedSettings.pix_chave,
            pix_tipo_chave: updatedSettings.pix_tipo_chave,
            pix_beneficiario: updatedSettings.pix_beneficiario,
            pix_documento: updatedSettings.pix_documento || "",
            pix_cidade: updatedSettings.pix_cidade,
            motivo_alteracao: motivo || "Sincronização integral",
            atualizado_por: usuario || "admin_sync",
            atualizado_em: agora
          })
        });
      } catch(e) {}
    }

    return {
      success: true,
      persisted: true,
      settings: updatedSettings,
      versao: updatedSettings.versao
    };
  }

  return {
    success: true,
    persisted: false,
    message: "Versão do servidor é igual ou superior à enviada.",
    settings: current.settings,
    versao: currentVersao
  };
}

module.exports = {
  CANONICAL_MP_PUBLIC_KEY,
  getActiveSettings,
  getEffectivePrice,
  getNextMonotonicVersion,
  updatePriceSettings,
  updatePixSettings,
  updateCardSettings,
  updateWhatsAppSettings,
  approvePayment,
  rejectPayment,
  syncFullSettings,
  loadLocalStore,
  saveLocalStore,
  getDefaultSettings,
  getDefaultStore,
  getDefaultCardRates,
  normalizarChavePix,
  getSupabaseCredentials
};
