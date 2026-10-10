// ==============================================================================
// SUPABASE EDGE FUNCTION: admin-read
// Módulo Administrativo Oficial (ESTRITAMENTE SOMENTE LEITURA / ZERO ESCRITA)
// Atende:
//   - Login / Validação de Papel Administrativo (POST { action: "login" } ou GET)
//   - Dashboard Geral (inscricoes, pagamentos, auditoria, whatsapp, contagens)
//   - Dados dos Inscritos por Sub (inscricoes + inscritos_dados + estatisticas)
//   - Configurações Financeiras (configuracoes_financeiras, lotes)
// ==============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { AwsClient } from "npm:aws4fetch@1.0.20";

// --- ESTRUTURA DE PERMISSÕES ADMINISTRATIVAS ---
interface RolePermissions {
  role: "superadmin" | "financeiro" | "admin";
  label: string;
  canEdit: boolean;
  canEditFinance: boolean;
  canApprovePayments: boolean;
  canEditWhatsapp: boolean;
}

const ROLES: Record<string, RolePermissions> = {
  superadmin: {
    role: "superadmin",
    label: "Coordenação / Super Admin (Acesso Total)",
    canEdit: true,
    canEditFinance: true,
    canApprovePayments: true,
    canEditWhatsapp: true
  },
  financeiro: {
    role: "financeiro",
    label: "Gestor Financeiro",
    canEdit: true,
    canEditFinance: true,
    canApprovePayments: true,
    canEditWhatsapp: false
  },
  admin: {
    role: "admin",
    label: "Administrador Geral",
    canEdit: false,
    canEditFinance: false,
    canApprovePayments: false,
    canEditWhatsapp: true
  }
};

const VALID_SUBS: Record<string, { nome: string; cor: string; coordenadores: string }> = {
  verde: { nome: "Verde", cor: "#24a764", coordenadores: "Abraão e Sara" },
  vermelho: { nome: "Vermelho", cor: "#e8333e", coordenadores: "Kadmiel e Bia" },
  amarelo: { nome: "Amarelo", cor: "#eab308", coordenadores: "Mateus e Gabriely" },
  laranja: { nome: "Laranja", cor: "#f97316", coordenadores: "Alan e Kallyne" }
};

// --- CRIPTOGRAFIA E COMPARAÇÃO EM TEMPO CONSTANTE ---
async function sha256Bytes(str: string): Promise<Uint8Array> {
  const enc = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest("SHA-256", enc);
  return new Uint8Array(hash);
}

async function timingSafeEqualStr(a: string, b: string): Promise<boolean> {
  if (!a || !b) return false;
  const hashA = await sha256Bytes(a);
  const hashB = await sha256Bytes(b);
  let diff = 0;
  for (let i = 0; i < hashA.length; i++) {
    diff |= hashA[i] ^ hashB[i];
  }
  return diff === 0;
}

async function authenticateRequest(
  req: Request,
  bodyData?: Record<string, unknown>
): Promise<RolePermissions | null> {
  // A senha é aceita via Headers (Authorization: Bearer ou x-admin-token) ou Body (POST login)
  // NUNCA via URL (query string) para não vazar em logs de acesso
  const authHeader = req.headers.get("authorization") || req.headers.get("Authorization") || "";
  const bearerToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  const adminToken = (req.headers.get("x-admin-token") || req.headers.get("x-admin-pass") || "").trim();
  const bodyPass = typeof bodyData?.password === "string"
    ? bodyData.password.trim()
    : (typeof bodyData?.admin_pass === "string" ? bodyData.admin_pass.trim() : "");

  const pass = bodyPass || adminToken || bearerToken;
  if (!pass) return null;

  const passSuperadmin = (Deno.env.get("ADMIN_PASSWORD_COORDENACAO") || Deno.env.get("ADMIN_PASS") || "").trim().replace(/^"|"$/g, "");
  const passFinanceiro = (Deno.env.get("ADMIN_PASSWORD_FINANCEIRO") || Deno.env.get("FINANCEIRO_PASSWORD") || "").trim().replace(/^"|"$/g, "");
  const passAdmin = (Deno.env.get("ADMIN_PASSWORD") || "").trim().replace(/^"|"$/g, "");

  const isSuper = Boolean(passSuperadmin) && (await timingSafeEqualStr(pass, passSuperadmin));
  if (isSuper) return ROLES.superadmin;

  const isFin = Boolean(passFinanceiro) && (await timingSafeEqualStr(pass, passFinanceiro));
  if (isFin) return ROLES.financeiro;

  const isAdmin = Boolean(passAdmin) && (await timingSafeEqualStr(pass, passAdmin));
  if (isAdmin) return ROLES.admin;

  return null;
}

async function generateSignedPhotoToken(path: string, secret: string, ttlSeconds = 7200): Promise<string> {
  if (!path) return "";
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const data = new TextEncoder().encode(`${path}:${expires}`);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, data);
  const signature = Array.from(new Uint8Array(sigBuf))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
  return `${expires}.${signature}`;
}

function normalizarSub(sub?: string | null): string | null {
  const s = String(sub || "").trim().toLowerCase();
  if (s.includes("verd")) return "Verde";
  if (s.includes("verm")) return "Vermelho";
  if (s.includes("amar")) return "Amarelo";
  if (s.includes("laran") || s.includes("azul")) return "Laranja";
  return null;
}

function mascararChavePix(chave: string, tipo?: string): string {
  const c = String(chave || "");
  if (!c) return "";
  if (tipo === "EMAIL" && c.includes("@")) {
    const parts = c.split("@");
    const name = parts[0];
    const maskedName = name.length > 3 ? name.slice(0, 3) + "***" : "***";
    return `${maskedName}@${parts[1]}`;
  }
  if (c.length > 8) {
    return c.slice(0, 4) + "****" + c.slice(-4);
  }
  return "****";
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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-admin-token, x-admin-pass, apikey, x-client-info",
    "Vary": "Origin",
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0",
    "Pragma": "no-cache",
    "Expires": "0",
    "Surrogate-Control": "no-store"
  };
}

// --- SERVIÇO PRINCIPAL DA EDGE FUNCTION ---
serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);

  // 1. CORS Preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // 2. Bloqueio Estrito de Métodos de Escrita (PUT, PATCH, DELETE)
  if (req.method !== "GET" && req.method !== "POST") {
    return new Response(JSON.stringify({
      success: false,
      error: "Método não permitido. admin-read opera exclusivamente em modo somente leitura."
    }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" }
    });
  }

  // Parse seguro de body caso venha via POST
  let bodyData: Record<string, unknown> = {};
  if (req.method === "POST") {
    try {
      bodyData = await req.json();
    } catch {
      bodyData = {};
    }

    // Se vier um POST que não seja action "login", "get_comprovante_url" ou "get_comprovante", rejeita com 405
    const action = String(bodyData.action || "").trim();
    if (action !== "login" && action !== "get_comprovante_url" && action !== "get_comprovante") {
      return new Response(JSON.stringify({
        success: false,
        error: "Operação não permitida. Apenas leitura e autenticação são autorizadas nesta função."
      }), {
        status: 405,
        headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" }
      });
    }
  }

  // 3. Autenticação Administrativa
  const auth = await authenticateRequest(req, bodyData);
  if (!auth) {
    // Retarda resposta para mitigar força bruta
    await new Promise(r => setTimeout(r, 400));
    return new Response(JSON.stringify({
      success: false,
      error: "Acesso não autorizado: credenciais administrativas necessárias."
    }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" }
    });
  }

  // Se a requisição for explicitamente para login / validação de sessão:
  const url = new URL(req.url);
  const actionParam = url.searchParams.get("action") || (bodyData.action as string) || "";
  if (actionParam === "login" || actionParam === "auth") {
    return new Response(JSON.stringify({
      success: true,
      role: auth.role,
      label: auth.label,
      canEdit: auth.canEdit,
      canEditFinance: auth.canEditFinance,
      canApprovePayments: auth.canApprovePayments,
      canEditWhatsapp: auth.canEditWhatsapp
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" }
    });
  }

  // Se a requisição for para obtenção segura de comprovante de pagamento (OP07):
  if (actionParam === "get_comprovante_url" || actionParam === "get_comprovante") {
    const rawPath = String(url.searchParams.get("path") || bodyData.path || "").trim();

    // 1. Validação de presença do path
    if (!rawPath) {
      return new Response(JSON.stringify({
        success: false,
        error: "Parâmetro 'path' é obrigatório."
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" }
      });
    }

    // 2. Bloqueio estrito de path traversal e caracteres perigosos
    if (
      rawPath.includes("..") ||
      rawPath.includes("\\") ||
      rawPath.includes("//") ||
      rawPath.includes("\0") ||
      rawPath.toLowerCase().includes("%2e") ||
      rawPath.startsWith("/")
    ) {
      return new Response(JSON.stringify({
        success: false,
        error: "Tentativa de path traversal detectada e bloqueada."
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" }
      });
    }

    // 3. Validação de prefixo e extensão estritos (apenas comprovantes/<sub-ou-pasta>/<arquivo>.(jpg|jpeg|png|webp|pdf))
    const comprovantePattern = /^comprovantes\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\.(jpg|jpeg|png|webp|pdf)$/i;
    if (!comprovantePattern.test(rawPath)) {
      return new Response(JSON.stringify({
        success: false,
        error: "Formato de caminho inválido ou fora do prefixo permitido."
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" }
      });
    }

    // 4. Geração segura de Presigned URL no bucket privado R2 (Alternative B) com fallback garantido
    const accountId = Deno.env.get("R2_ACCOUNT_ID") || "0d0228f378b5e4f3f63c67b4210bf3ea";
    const accessKeyId = Deno.env.get("R2_ACCESS_KEY_ID") || "";
    const secretAccessKey = Deno.env.get("R2_SECRET_ACCESS_KEY") || "";
    const privateBucket = "ejc-comprovantes";
    const expiresIn = 300; // 5 minutos de validade estrita

    let presignedUrl = "";
    let resolutionSource = "";

    // Tentativa 1: Presigned GET S3 URL para o bucket privado ejc-comprovantes
    if (accessKeyId && secretAccessKey) {
      try {
        const s3Client = new AwsClient({
          accessKeyId,
          secretAccessKey,
          service: "s3",
          region: "auto"
        });

        // Modo streaming binário direto autenticado (Alternative A)
        if (actionParam === "get_comprovante" || url.searchParams.get("mode") === "binary") {
          const fetchSigned = await s3Client.sign(
            new Request(`https://${accountId}.r2.cloudflarestorage.com/${privateBucket}/${rawPath}`, { method: "GET" })
          );
          const s3Res = await fetch(fetchSigned);
          if (s3Res.ok) {
            const blob = await s3Res.arrayBuffer();
            const ct = s3Res.headers.get("content-type") || (rawPath.endsWith(".pdf") ? "application/pdf" : "image/jpeg");
            return new Response(blob, {
              status: 200,
              headers: {
                ...corsHeaders,
                "Content-Type": ct,
                "Content-Disposition": `inline; filename="${rawPath.split("/").pop()}"`,
                "Cache-Control": "private, no-cache, no-store, max-age=0, must-revalidate"
              }
            });
          }
        }

        // Modo Presigned GET URL (Alternative B)
        const s3Url = `https://${accountId}.r2.cloudflarestorage.com/${privateBucket}/${rawPath}?X-Amz-Expires=${expiresIn}`;
        const signedReq = await s3Client.sign(
          new Request(s3Url, { method: "GET" }),
          { aws: { signQuery: true } }
        );
        const candidateUrl = signedReq.url.toString();

        // Define a URL pré-assinada do R2 privado como resolução primária (Alternative B)
        presignedUrl = candidateUrl;
        resolutionSource = "r2_private_presigned";
      } catch (err) {
        console.error("Erro ao gerar URL R2 presigned:", err);
      }
    }

    // Fallback garantido: Supabase Storage bucket 'fotos' com URL assinada temporária
    if (!presignedUrl) {
      try {
        const supabaseUrl = Deno.env.get("SUPABASE_URL") || "https://guppedddwnuvluhiaaas.supabase.co";
        const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY") || "";
        const supabaseClient = createClient(supabaseUrl, supabaseServiceKey);

        const { data: signedData, error: signedErr } = await supabaseClient.storage
          .from("fotos")
          .createSignedUrl(rawPath, expiresIn);

        if (signedData?.signedUrl) {
          presignedUrl = signedData.signedUrl;
          resolutionSource = "supabase_storage_signed_fallback";
        } else if (signedErr) {
          console.error("Erro no fallback Supabase Storage:", signedErr.message);
        }
      } catch (err) {
        console.error("Exceção no fallback Supabase Storage:", err);
      }
    }

    if (!presignedUrl) {
      return new Response(JSON.stringify({
        success: false,
        error: "Não foi possível obter URL segura para o comprovante solicitado."
      }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" }
      });
    }

    return new Response(JSON.stringify({
      success: true,
      url: presignedUrl,
      source: resolutionSource,
      expiresIn,
      path: rawPath
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" }
    });
  }

  // 4. Inicializa Conexão Supabase com service_role (Somente dentro da Edge Function)
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "https://guppedddwnuvluhiaaas.supabase.co";
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY") || "";
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const view = (url.searchParams.get("view") || url.searchParams.get("route") || "").toLowerCase();
  const subParam = (url.searchParams.get("sub") || "").toLowerCase().trim();

  try {
    // ---------------------------------------------------------------------------
    // ROTA A: DADOS DOS INSCRITOS POR SUB / GERAL (Substitui /api/admin/inscritos-dados)
    // ---------------------------------------------------------------------------
    if (view === "inscritos-dados" || subParam) {
      const isAll = (subParam === "all" || subParam === "todos" || subParam === "*" || !subParam);
      const subConfig = !isAll ? VALID_SUBS[subParam] : null;

      if (!isAll && !subConfig) {
        return new Response(JSON.stringify({
          success: false,
          error: "Sub inválido. Valores aceitos: verde, vermelho, amarelo, laranja ou todos."
        }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" }
        });
      }

      const officialSubName = subConfig ? subConfig.nome : "Todos";

      // 1. Consulta estritamente somente leitura de inscrições ativas
      let query = supabase
        .from("inscricoes")
        .select("*")
        .eq("arquivado", false)
        .order("sub", { ascending: true })
        .order("nome_completo", { ascending: true });

      if (!isAll) {
        if (subParam === "laranja") {
          query = query.or("sub.eq.Laranja,sub.eq.Azul");
        } else {
          query = query.eq("sub", officialSubName);
        }
      }

      const { data: inscricoesRows, error: inscError } = await query;
      if (inscError) throw new Error("Erro ao consultar inscricoes: " + inscError.message);

      // 2. Consulta tabela complementar public.inscritos_dados
      const { data: complementaresRows, error: compError } = await supabase
        .from("inscritos_dados")
        .select("*");

      if (compError) console.warn("[admin-read] Aviso ao ler inscritos_dados:", compError.message);

      const dadosCompMap: Record<string, any> = {};
      if (Array.isArray(complementaresRows)) {
        complementaresRows.forEach((item: any) => {
          if (item.inscricao_id) dadosCompMap[item.inscricao_id] = item;
        });
      }

      // 3. Monta relação consolidada com dados complementares e URLs assinadas de fotos
      const photoSecret = supabaseServiceKey || Deno.env.get("ADMIN_PASSWORD_COORDENACAO") || "";

      const inscritos = await Promise.all((inscricoesRows || []).map(async (i: any) => {
        const comp = dadosCompMap[i.id] || null;

        const tamanhoCamisa = String((comp && comp.tamanho_camisa) || i.tamanho_camisa || "").trim();
        const fotoCaminho = String((comp && comp.foto_caminho) || i.foto_caminho || "").trim();

        const isCompleto = Boolean(tamanhoCamisa && fotoCaminho && i.nome_completo && i.whatsapp);
        const statusCadastro = isCompleto ? "completo" : "incompleto";

        let fotoUrl: string | null = null;
        if (fotoCaminho) {
          const token = await generateSignedPhotoToken(fotoCaminho, photoSecret);
          fotoUrl = `/api/admin/inscritos-foto?path=${encodeURIComponent(fotoCaminho)}&token=${token}`;
        }

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
          modelo_camisa_adicional: i.modelo_camisa_adicional || null,
          talento: i.talento || "",
          foto_caminho: fotoCaminho || null,
          foto_url: fotoUrl,
          has_foto: Boolean(fotoCaminho),
          status_cadastro: statusCadastro,
          observacoes: (comp && comp.observacoes) || null,
          criado_em: i.criado_em,
          atualizado_em: (comp && comp.atualizado_em) || i.criado_em,
          pagamento_status: i.pagamento_status || "pendente"
        };
      }));

      const total = inscritos.length;
      const completos = inscritos.filter((i: any) => i.status_cadastro === "completo").length;
      const pendentes = total - completos;

      return new Response(JSON.stringify({
        success: true,
        sub: isAll ? "Todos" : officialSubName,
        all: isAll,
        coordenadores: subConfig ? subConfig.coordenadores : "Todos os Coordenadores",
        cor: subConfig ? subConfig.cor : "#087df9",
        stats: {
          total,
          completos,
          pendentes
        },
        inscritos
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" }
      });
    }

    // ---------------------------------------------------------------------------
    // ROTA B: CONFIGURAÇÕES FINANCEIRAS (Substitui GET /api/payment-settings)
    // ---------------------------------------------------------------------------
    if (view === "payment-settings" || view === "finance") {
      const [confRes, lotesRes, wppRes] = await Promise.all([
        supabase.from("configuracoes_financeiras").select("*").order("versao", { ascending: false }).limit(1),
        supabase.from("lotes_inscricao").select("*").order("criado_em", { ascending: true }),
        supabase.from("configuracoes_whatsapp").select("*")
      ]);

      const confRow = (confRes.data && confRes.data[0]) || {};
      const lotesRows = lotesRes.data || [];
      const wppRows = wppRes.data || [];

      const whatsapp: Record<string, string> = {};
      wppRows.forEach((r: any) => {
        if (r.sub) whatsapp[r.sub] = r.link_grupo || "";
      });

      const rawPixKey = String(confRow.pix_chave || "");
      const tipoChave = String(confRow.pix_tipo_chave || "EMAIL");
      const maskedKey = mascararChavePix(rawPixKey, tipoChave);

      const modalidadeEfetiva = confRow.modalidade_pix || "api_webhook";
      const effectiveSettings = {
        ...confRow,
        modalidade_pix: modalidadeEfetiva,
        pix_mode: modalidadeEfetiva,
        pix_chave_mascarada: maskedKey,
        pix_chave: auth.canEditFinance ? rawPixKey : maskedKey,
        mp_public_key: String(confRow.mp_public_key || "APP_USR-39960bc1-2b08-4885-8090-31eaa38ba04b").trim()
      };

      return new Response(JSON.stringify({
        success: true,
        settings: effectiveSettings,
        lotes: lotesRows,
        whatsapp,
        permissions: {
          role: auth.role,
          canEdit: auth.canEdit,
          canEditFinance: auth.canEditFinance,
          canApprovePayments: auth.canApprovePayments,
          canEditWhatsapp: auth.canEditWhatsapp
        }
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" }
      });
    }

    // ---------------------------------------------------------------------------
    // ROTA C: DASHBOARD GERAL (Substitui GET /api/admin)
    // ---------------------------------------------------------------------------
    const [inscRes, pagRes, audRes, wppRes, arqRes, subsRes] = await Promise.all([
      supabase.from("inscricoes").select("*").eq("arquivado", false).order("criado_em", { ascending: false }),
      supabase.from("pagamentos").select("*").order("criado_em", { ascending: false }),
      supabase.from("auditoria_transacoes").select("*").order("criado_em", { ascending: false }).limit(500),
      supabase.from("configuracoes_whatsapp").select("*"),
      supabase.from("inscricoes").select("*").eq("arquivado", true).order("criado_em", { ascending: false }),
      supabase.from("subs").select("nome, capacidade")
    ]);

    const inscricoes = inscRes.data || [];
    const inscricoes_arquivadas = arqRes.data || [];
    const pagamentos = pagRes.data || [];
    const auditoria = audRes.data || [];
    const wppRows = wppRes.data || [];
    const subsRows = subsRes.data || [];

    const capacities: Record<string, number> = { Verde: 95, Vermelho: 95, Amarelo: 95, Laranja: 95 };
    if (Array.isArray(subsRows)) {
      subsRows.forEach((row: any) => {
        const s = normalizarSub(row.nome);
        if (s && row.capacidade !== undefined && row.capacidade !== null) {
          capacities[s] = Number(row.capacidade);
        }
      });
    }

    const whatsapp: Record<string, string> = {};
    wppRows.forEach((r: any) => {
      if (r.sub) whatsapp[r.sub] = r.link_grupo || "";
    });

    // Conjunto de IDs de inscrições ativas com pagamento aprovado no gateway
    const pagamentosAprovadosInscricoes = new Set<string>();
    pagamentos.forEach((p: any) => {
      const pStatus = String(p.status || "").trim().toLowerCase();
      if ((pStatus === "approved" || pStatus === "confirmado" || pStatus === "pago") && p.inscricao_id) {
        pagamentosAprovadosInscricoes.add(String(p.inscricao_id));
      }
    });

    // Contadores de participantes com pagamento efetivamente confirmado por sub (Dashboard Principal)
    const countsConfirmados: Record<string, number> = { Verde: 0, Vermelho: 0, Amarelo: 0, Laranja: 0 };
    inscricoes.forEach((item: any) => {
      if (item.arquivado) return;
      const iStatus = String(item.pagamento_status || "").trim().toLowerCase();
      const isPago = (iStatus === "approved" || iStatus === "confirmado" || iStatus === "pago") ||
                     pagamentosAprovadosInscricoes.has(String(item.id));
      if (!isPago) return;

      const s = normalizarSub(item.sub);
      if (s && countsConfirmados[s] !== undefined) countsConfirmados[s]++;
    });

    const totalConfirmados = Object.values(countsConfirmados).reduce((a, b) => a + b, 0);

    // Contadores operacionais por sub (todas as inscrições ativas válidas)
    const countsOperacionais: Record<string, number> = { Verde: 0, Vermelho: 0, Amarelo: 0, Laranja: 0 };
    inscricoes.forEach((item: any) => {
      if (item.arquivado) return;
      const s = normalizarSub(item.sub);
      if (s && countsOperacionais[s] !== undefined) countsOperacionais[s]++;
    });

    const totalOperacional = Object.values(countsOperacionais).reduce((a, b) => a + b, 0);

    return new Response(JSON.stringify({
      success: true,
      role: auth.role,
      label: auth.label,
      canEdit: auth.canEdit,
      canEditFinance: auth.canEditFinance,
      canApprovePayments: auth.canApprovePayments,
      canEditWhatsapp: auth.canEditWhatsapp,
      inscricoes,
      inscricoes_arquivadas,
      capacities,
      pagamentos,
      auditoria,
      whatsapp,
      counts: countsConfirmados,
      total: totalConfirmados,
      counts_confirmados: countsConfirmados,
      total_confirmados: totalConfirmados,
      counts_operacionais: countsOperacionais,
      total_operacional: totalOperacional,
      timestamp: new Date().toISOString()
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" }
    });

  } catch (error: any) {
    console.error("[admin-read] Erro interno:", error.message);
    return new Response(JSON.stringify({
      success: false,
      error: "Falha interna ao processar consulta administrativa somente leitura."
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" }
    });
  }
});
