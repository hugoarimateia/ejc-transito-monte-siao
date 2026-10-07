// ==============================================================================
// SUPABASE EDGE FUNCTION: r2-presigned-url
// Geração segura de Presigned URLs (S3 PUT com Content-Type e If-None-Match: * assinados),
// validação server-side pós-upload (tamanho <= 5MB, MIME, magic bytes parciais, metadados de ciclo de vida)
// e bloqueio absoluto de cleanup pós-inscrição via verificação direta em public.inscricoes.
// ==============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { AwsClient } from "npm:aws4fetch@1.0.20";

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB exatos: 5.242.880 bytes

const ALLOWED_ORIGINS = new Set([
  "https://transitoejc.site",
  "https://www.transitoejc.site",
  "https://ejc-admin.pages.dev",
  "http://localhost:3000",
  "http://localhost:8080",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:8080"
]);

const ALLOWED_SUBS = new Set(["verde", "vermelho", "amarelo", "laranja"]);
const ALLOWED_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const ALLOWED_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp"]);

function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  const allowOrigin = ALLOWED_ORIGINS.has(origin) ? origin : (origin ? origin : "*");

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
    "Vary": "Origin",
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache"
  };
}

async function generateHmac(message: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

async function verifyHmac(message: string, signature: string, secret: string): Promise<boolean> {
  const expectedSig = await generateHmac(message, secret);
  return expectedSig.toLowerCase() === signature.toLowerCase();
}

async function createOperationToken(
  state: "CREATED" | "VALIDATED" | "COMMITTED" | "REJECTED",
  storageKey: string,
  sub: string,
  mimeType: string,
  secret: string
): Promise<string> {
  const timestamp = Date.now();
  const payload = `v1:${state}:${storageKey}:${sub}:${mimeType}:${timestamp}`;
  const sig = await generateHmac(payload, secret);
  return `${payload}:${sig}`;
}

interface ParsedToken {
  valid: boolean;
  state?: string;
  storageKey?: string;
  sub?: string;
  mimeType?: string;
  timestamp?: number;
  error?: string;
}

async function parseAndVerifyToken(token: string, secret: string): Promise<ParsedToken> {
  if (!token || typeof token !== "string") {
    return { valid: false, error: "Token ausente ou malformado." };
  }

  // Suporte a token estruturado v1
  if (token.startsWith("v1:")) {
    const lastColon = token.lastIndexOf(":");
    if (lastColon === -1) {
      return { valid: false, error: "Token v1 malformado." };
    }
    const payload = token.substring(0, lastColon);
    const sig = token.substring(lastColon + 1);

    const isValidSig = await verifyHmac(payload, sig, secret);
    if (!isValidSig) {
      return { valid: false, error: "Assinatura do token inválida." };
    }

    const parts = payload.split(":");
    if (parts.length < 6) {
      return { valid: false, error: "Carga do token incompleta." };
    }

    const [, state, storageKey, sub, mimeType, tsStr] = parts;
    const timestamp = Number(tsStr);
    const ageMs = Date.now() - timestamp;
    if (isNaN(timestamp) || ageMs < 0 || ageMs > 15 * 60 * 1000) {
      return { valid: false, error: "Token expirado (limite de 15 minutos excedido)." };
    }

    return { valid: true, state, storageKey, sub, mimeType, timestamp };
  }

  // Compatibilidade com tokens legados R2.8: storageKey:timestamp:sig
  const parts = token.split(":");
  if (parts.length >= 3) {
    const sig = parts.pop()!;
    const payload = parts.join(":");
    const timestamp = Number(parts[parts.length - 1]);
    const storageKey = parts.slice(0, parts.length - 1).join(":");

    const ageMs = Date.now() - timestamp;
    if (isNaN(timestamp) || ageMs < 0 || ageMs > 15 * 60 * 1000) {
      return { valid: false, error: "Token legado expirado." };
    }

    const isValid = await verifyHmac(payload, sig, secret);
    if (!isValid) {
      return { valid: false, error: "Assinatura do token legado inválida." };
    }

    return { valid: true, state: "CREATED", storageKey, timestamp };
  }

  return { valid: false, error: "Formato de token não reconhecido." };
}

function validateMagicBytes(bytes: Uint8Array, mimeType: string): boolean {
  if (!bytes || bytes.length < 12) return false;

  if (mimeType === "image/jpeg") {
    return bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
  }

  if (mimeType === "image/png") {
    return (
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4E &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0D &&
      bytes[5] === 0x0A &&
      bytes[6] === 0x1A &&
      bytes[7] === 0x0A
    );
  }

  if (mimeType === "image/webp") {
    return (
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    );
  }

  return false;
}

serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ success: false, error: "Método não permitido." }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "get_upload_url").trim();

    const accountId = Deno.env.get("R2_ACCOUNT_ID") || "0d0228f378b5e4f3f63c67b4210bf3ea";
    const bucketName = Deno.env.get("R2_BUCKET_NAME") || "ejc-fotos";
    const accessKeyId = Deno.env.get("R2_ACCESS_KEY_ID") || "";
    const secretAccessKey = Deno.env.get("R2_SECRET_ACCESS_KEY") || "";
    const hmacSecret = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || secretAccessKey || "ejc_r2_cleanup_secret";

    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "https://guppedddwnuvluhiaaas.supabase.co";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

    if (!accessKeyId || !secretAccessKey) {
      return new Response(JSON.stringify({
        success: false,
        error: "Serviço de upload R2 não configurado (credenciais ausentes)."
      }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const s3Client = new AwsClient({
      accessKeyId,
      secretAccessKey,
      service: "s3",
      region: "auto"
    });

    const keyPattern = /^participantes\/(verde|vermelho|amarelo|laranja)\/[0-9a-fA-F-]{36}\.(jpg|jpeg|png|webp)$/;

    // -------------------------------------------------------------------------
    // AÇÃO 1: GERAÇÃO DA PRESIGNED URL PARA UPLOAD
    // Protegida contra sobrescrita com Content-Type e If-None-Match: * assinados
    // -------------------------------------------------------------------------
    if (action === "get_upload_url") {
      const rawSub = String(body.sub || "").toLowerCase().trim();
      const sub = rawSub === "azul" ? "laranja" : rawSub;

      if (!ALLOWED_SUBS.has(sub)) {
        return new Response(JSON.stringify({
          success: false,
          error: `Subcírculo inválido: '${sub}'. Permitidos: verde, vermelho, amarelo, laranja.`
        }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      const mimeType = String(body.mimeType || "image/jpeg").toLowerCase().trim();
      if (!ALLOWED_MIMES.has(mimeType)) {
        return new Response(JSON.stringify({
          success: false,
          error: `Formato de imagem (MIME) não permitido: '${mimeType}'. Permitidos: JPG, PNG, WebP.`
        }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      let ext = String(body.extension || "").toLowerCase().replace(/[^a-z0-9]/g, "").trim();
      if (!ext || !ALLOWED_EXTENSIONS.has(ext)) {
        ext = mimeType === "image/png" ? "png" : (mimeType === "image/webp" ? "webp" : "jpg");
      }

      const objectUuid = crypto.randomUUID();
      const storageKey = `participantes/${sub}/${objectUuid}.${ext}`;

      const expiresIn = 300; // 5 minutos de validade estrita
      const s3Url = `https://${accountId}.r2.cloudflarestorage.com/${bucketName}/${storageKey}?X-Amz-Expires=${expiresIn}`;

      const signedReq = await s3Client.sign(
        new Request(s3Url, {
          method: "PUT",
          headers: {
            "Content-Type": mimeType,
            "If-None-Match": "*"
          }
        }),
        {
          aws: {
            signQuery: true,
            allHeaders: true
          }
        }
      );

      const uploadUrl = signedReq.url.toString();

      const operationToken = await createOperationToken(
        "CREATED",
        storageKey,
        sub,
        mimeType,
        hmacSecret
      );

      return new Response(JSON.stringify({
        success: true,
        uploadUrl,
        storageKey,
        operationToken,
        cleanupToken: operationToken,
        state: "CREATED",
        expiresIn
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // -------------------------------------------------------------------------
    // AÇÃO 2: VALIDAÇÃO SERVER-SIDE DO OBJETO NO R2 (Pós-upload, Pré-inscrição)
    // -------------------------------------------------------------------------
    if (action === "validate_upload") {
      const storageKey = String(body.storageKey || "").trim();
      const token = String(body.operationToken || body.cleanupToken || "").trim();

      // 1. Validação estrita do padrão de storageKey
      if (!keyPattern.test(storageKey)) {
        return new Response(JSON.stringify({
          success: false,
          state: "REJECTED",
          error: "Chave de armazenamento inválida para validação."
        }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // 2. Validação criptográfica do token
      const tokenData = await parseAndVerifyToken(token, hmacSecret);
      if (!tokenData.valid || tokenData.storageKey !== storageKey) {
        return new Response(JSON.stringify({
          success: false,
          state: "REJECTED",
          error: tokenData.error || "Token de operação inválido ou não corresponde à chave indicada."
        }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // Regra de transição estrita: Apenas tokens no estado 'CREATED' podem ser validados
      if (tokenData.state !== "CREATED") {
        return new Response(JSON.stringify({
          success: false,
          state: "REJECTED",
          error: `Apenas tokens no estado 'CREATED' podem ser validados. Estado recebido: '${tokenData.state}'.`
        }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // Verificação no banco: Se esta chave já estiver vinculada a uma inscrição confirmada, bloqueia
      if (serviceRoleKey) {
        try {
          const dbCheckRes = await fetch(
            `${supabaseUrl}/rest/v1/inscricoes?select=id,pagamento_status,arquivado&foto_caminho=eq.${encodeURIComponent(storageKey)}&limit=1`,
            {
              headers: {
                "apikey": serviceRoleKey,
                "Authorization": `Bearer ${serviceRoleKey}`,
                "Accept": "application/json"
              }
            }
          );
          if (dbCheckRes.ok) {
            const records = await dbCheckRes.json();
            if (Array.isArray(records) && records.length > 0 && !records[0].arquivado && records[0].pagamento_status !== "cancelado") {
              return new Response(JSON.stringify({
                success: false,
                state: "REJECTED",
                error: "Chave já vinculada a uma inscrição concluída no banco de dados."
              }), {
                status: 403,
                headers: { ...corsHeaders, "Content-Type": "application/json" }
              });
            }
          }
        } catch (dbErr) {
          console.warn("[Validation] Erro ao consultar banco de dados:", dbErr);
        }
      }

      const expectedMime = tokenData.mimeType || "image/jpeg";
      const objectUrl = `https://${accountId}.r2.cloudflarestorage.com/${bucketName}/${storageKey}`;

      const deleteInvalidObject = async (reason: string) => {
        try {
          const delReq = await s3Client.sign(new Request(objectUrl, { method: "DELETE" }));
          await fetch(delReq);
          console.warn(`[Validation] Objeto ${storageKey} excluído do R2. Motivo: ${reason}`);
        } catch (delErr) {
          console.error(`[Validation] Falha ao excluir objeto rejeitado ${storageKey}:`, delErr);
        }
      };

      // 3. Consulta de metadados no R2 via HEAD
      const headReq = await s3Client.sign(new Request(objectUrl, { method: "HEAD" }));
      const headRes = await fetch(headReq);

      if (headRes.status === 404) {
        return new Response(JSON.stringify({
          success: false,
          state: "REJECTED",
          error: "Objeto não encontrado no R2 (o upload não foi concluído)."
        }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      if (!headRes.ok) {
        return new Response(JSON.stringify({
          success: false,
          state: "REJECTED",
          error: `Falha ao consultar metadados no R2: HTTP ${headRes.status}`
        }), {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      const currentMetaState = headRes.headers.get("x-amz-meta-state") || "";
      if (currentMetaState === "VALIDATED") {
        return new Response(JSON.stringify({
          success: false,
          state: "REJECTED",
          error: "Objeto já foi validado anteriormente."
        }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      const contentLengthStr = headRes.headers.get("content-length");
      const contentLength = contentLengthStr ? parseInt(contentLengthStr, 10) : 0;
      const contentType = (headRes.headers.get("content-type") || "").toLowerCase().trim();

      // 4. Verificação estrita de tamanho (máximo 5 MB: 5.242.880 bytes)
      if (isNaN(contentLength) || contentLength <= 0 || contentLength > MAX_FILE_SIZE) {
        await deleteInvalidObject(`Tamanho inválido ou excedido (${contentLength} bytes)`);
        return new Response(JSON.stringify({
          success: false,
          state: "REJECTED",
          error: `Arquivo excede o limite máximo permitido de 5 MB (${contentLength} bytes recebidos).`
        }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // 5. Verificação de Content-Type do objeto gravado no R2
      if (!ALLOWED_MIMES.has(contentType) || contentType !== expectedMime) {
        await deleteInvalidObject(`Content-Type incompatível: '${contentType}' (esperado '${expectedMime}')`);
        return new Response(JSON.stringify({
          success: false,
          state: "REJECTED",
          error: `Tipo MIME incompatível ou não permitido: '${contentType}'. Esperado: '${expectedMime}'.`
        }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // 6. Verificação de Magic Bytes via leitura parcial mínima (Range: bytes=0-31)
      const rangeReq = await s3Client.sign(new Request(objectUrl, {
        method: "GET",
        headers: { "Range": "bytes=0-31" }
      }));
      const rangeRes = await fetch(rangeReq);

      if (!rangeRes.ok && rangeRes.status !== 206) {
        await deleteInvalidObject(`Falha na leitura de magic bytes (HTTP ${rangeRes.status})`);
        return new Response(JSON.stringify({
          success: false,
          state: "REJECTED",
          error: `Falha ao inspecionar cabeçalho do arquivo no R2: HTTP ${rangeRes.status}`
        }), {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      const headerBuffer = new Uint8Array(await rangeRes.arrayBuffer());
      const isMagicValid = validateMagicBytes(headerBuffer, expectedMime);

      if (!isMagicValid) {
        await deleteInvalidObject(`Magic bytes incompatíveis com MIME '${expectedMime}'`);
        return new Response(JSON.stringify({
          success: false,
          state: "REJECTED",
          error: `Conteúdo binário incompatível com o formato de imagem declarado (magic bytes inválidos).`
        }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // 7. Marcação atômica do estado VALIDATED no objeto do R2 via CopyObject
      const copyReq = await s3Client.sign(new Request(objectUrl, {
        method: "PUT",
        headers: {
          "x-amz-copy-source": `/${bucketName}/${storageKey}`,
          "x-amz-metadata-directive": "REPLACE",
          "Content-Type": expectedMime,
          "x-amz-meta-state": "VALIDATED"
        }
      }));
      const copyRes = await fetch(copyReq);
      if (!copyRes.ok) {
        console.error(`[Validation] Falha ao registrar metadados VALIDATED em ${storageKey}: HTTP ${copyRes.status}`);
      }

      // 8. Emissão de novo token com estado estrito VALIDATED
      const validatedToken = await createOperationToken(
        "VALIDATED",
        storageKey,
        tokenData.sub || "verde",
        expectedMime,
        hmacSecret
      );

      return new Response(JSON.stringify({
        success: true,
        state: "VALIDATED",
        storageKey,
        operationToken: validatedToken,
        cleanupToken: validatedToken,
        size: contentLength,
        mimeType: contentType
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // -------------------------------------------------------------------------
    // AÇÃO 3: CLEANUP SEGURO DO OBJETO (DELETE autorizado com regras de estado e banco)
    // -------------------------------------------------------------------------
    if (action === "cleanup") {
      const storageKey = String(body.storageKey || "").trim();
      const token = String(body.cleanupToken || body.operationToken || "").trim();

      // 1. Validação estrita de formato da chave
      if (!keyPattern.test(storageKey)) {
        return new Response(JSON.stringify({
          success: false,
          error: "Chave não permitida para operação de cleanup."
        }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // 2. Validação criptográfica do token
      const tokenData = await parseAndVerifyToken(token, hmacSecret);
      if (!tokenData.valid || tokenData.storageKey !== storageKey) {
        return new Response(JSON.stringify({
          success: false,
          error: tokenData.error || "Token de cleanup não corresponde à chave indicada."
        }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // 3. Apenas tokens nos estados CREATED ou VALIDATED podem solicitar cleanup
      if (tokenData.state !== "CREATED" && tokenData.state !== "VALIDATED") {
        return new Response(JSON.stringify({
          success: false,
          error: `Estado de token não autorizado para cleanup: '${tokenData.state}'.`
        }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // 4. REGRA CRÍTICA DE SEGURANÇA: Verificação em public.inscricoes via Service Role Key
      // Bloqueia qualquer cleanup se o objeto já estiver vinculado a uma inscrição confirmada/concluída
      if (serviceRoleKey) {
        try {
          const dbCheckRes = await fetch(
            `${supabaseUrl}/rest/v1/inscricoes?select=id,pagamento_status,arquivado&foto_caminho=eq.${encodeURIComponent(storageKey)}&limit=1`,
            {
              headers: {
                "apikey": serviceRoleKey,
                "Authorization": `Bearer ${serviceRoleKey}`,
                "Accept": "application/json"
              }
            }
          );

          if (dbCheckRes.ok) {
            const records = await dbCheckRes.json();
            if (Array.isArray(records) && records.length > 0) {
              const rec = records[0];
              const isCommitted = !rec.arquivado && rec.pagamento_status !== "cancelado";
              if (isCommitted) {
                console.warn(`[Cleanup Bloqueado] Tentativa de exclusão de foto com inscrição concluída no banco: ${storageKey} (ID: ${rec.id}, Status: ${rec.pagamento_status})`);
                return new Response(JSON.stringify({
                  success: false,
                  error: "Operação não permitida: A foto já está vinculada a uma inscrição confirmada/concluída."
                }), {
                  status: 403,
                  headers: { ...corsHeaders, "Content-Type": "application/json" }
                });
              }
            }
          }
        } catch (dbErr) {
          console.error("[Cleanup] Erro ao consultar banco de dados:", dbErr);
          return new Response(JSON.stringify({
            success: false,
            error: "Falha na verificação de integridade da inscrição. Operação abortada por segurança."
          }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
      }

      const objectUrl = `https://${accountId}.r2.cloudflarestorage.com/${bucketName}/${storageKey}`;

      // 5. Inspeciona o estado real gravado nos metadados do R2
      const headReq = await s3Client.sign(new Request(objectUrl, { method: "HEAD" }));
      const headRes = await fetch(headReq);

      if (headRes.ok) {
        const objectMetaState = headRes.headers.get("x-amz-meta-state") || "";

        // REGRA CRÍTICA 1: Token CREATED NÃO PODE excluir objeto que já alcançou o estado VALIDATED!
        if (tokenData.state === "CREATED" && objectMetaState === "VALIDATED") {
          return new Response(JSON.stringify({
            success: false,
            error: "Objeto já avançou para o estado VALIDATED. Token CREATED não pode executar cleanup de objeto validado."
          }), {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
      }

      // 6. Executa DELETE do objeto no R2
      const deleteReq = await s3Client.sign(new Request(objectUrl, { method: "DELETE" }));
      const deleteRes = await fetch(deleteReq);

      if (!deleteRes.ok && deleteRes.status !== 404) {
        const errText = await deleteRes.text().catch(() => "");
        console.error(`[Cleanup] Falha ao excluir ${storageKey} no R2: ${deleteRes.status} ${errText}`);
        return new Response(JSON.stringify({
          success: false,
          error: `Falha na exclusão do objeto R2: ${deleteRes.status}`
        }), {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      console.log(`[Cleanup] Objeto ${storageKey} excluído com sucesso do Cloudflare R2.`);
      return new Response(JSON.stringify({
        success: true,
        message: `Objeto ${storageKey} excluído com sucesso do Cloudflare R2.`
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    return new Response(JSON.stringify({
      success: false,
      error: `Ação desconhecida: '${action}'.`
    }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });

  } catch (err: any) {
    console.error("[r2-presigned-url] Erro interno:", err.message);
    return new Response(JSON.stringify({
      success: false,
      error: "Erro interno no servidor ao processar requisição R2."
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});
