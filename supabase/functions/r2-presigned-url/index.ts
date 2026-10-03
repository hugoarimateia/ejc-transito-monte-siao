// ==============================================================================
// SUPABASE EDGE FUNCTION: r2-presigned-url
// Geração segura de Presigned URLs (S3 PUT) para upload direto ao Cloudflare R2
// e mecanismo seguro de cleanup (DELETE) em caso de falha da RPC de inscrição.
// ==============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { AwsClient } from "npm:aws4fetch@1.0.20";

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

    // -------------------------------------------------------------------------
    // AÇÃO 1: GERAÇÃO DA PRESIGNED URL PARA UPLOAD (PUT)
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

      // UUID imprevisível gerado EXCLUSIVAMENTE pelo backend
      const objectUuid = crypto.randomUUID();
      const storageKey = `participantes/${sub}/${objectUuid}.${ext}`;

      const expiresIn = 300; // 5 minutos de validade estrita
      const s3Url = `https://${accountId}.r2.cloudflarestorage.com/${bucketName}/${storageKey}?X-Amz-Expires=${expiresIn}`;

      const signedReq = await s3Client.sign(
        new Request(s3Url, {
          method: "PUT",
          headers: {
            "Content-Type": mimeType
          }
        }),
        {
          aws: {
            signQuery: true
          }
        }
      );

      const uploadUrl = signedReq.url.toString();

      // Token criptográfico para autorizar cleanup exclusivo desta chave se a RPC falhar
      const timestamp = Date.now();
      const tokenPayload = `${storageKey}:${timestamp}`;
      const tokenSignature = await generateHmac(tokenPayload, hmacSecret);
      const cleanupToken = `${tokenPayload}:${tokenSignature}`;

      return new Response(JSON.stringify({
        success: true,
        uploadUrl,
        storageKey,
        cleanupToken,
        expiresIn
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // -------------------------------------------------------------------------
    // AÇÃO 2: CLEANUP SEGURO DO OBJETO RECÉM-CRIADO EM CASO DE FALHA NA RPC
    // -------------------------------------------------------------------------
    if (action === "cleanup") {
      const storageKey = String(body.storageKey || "").trim();
      const cleanupToken = String(body.cleanupToken || "").trim();

      // Validação estrita de formato: Somente participante com UUID e extensão permitida
      const keyPattern = /^participantes\/(verde|vermelho|amarelo|laranja)\/[0-9a-fA-F-]{36}\.(jpg|jpeg|png|webp)$/;
      if (!keyPattern.test(storageKey)) {
        return new Response(JSON.stringify({
          success: false,
          error: "Chave não permitida para operação de cleanup."
        }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // Validação do token de cleanup
      const parts = cleanupToken.split(":");
      if (parts.length < 3) {
        return new Response(JSON.stringify({
          success: false,
          error: "Token de cleanup malformado."
        }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      const tokenSig = parts.pop()!;
      const tokenPayload = parts.join(":");
      const tokenKey = parts.slice(0, parts.length - 1).join(":");
      const tokenTimestamp = Number(parts[parts.length - 1]);

      if (tokenKey !== storageKey) {
        return new Response(JSON.stringify({
          success: false,
          error: "Token de cleanup não corresponde à chave indicada."
        }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // Validade máxima do cleanup: 15 minutos
      const tokenAgeMs = Date.now() - tokenTimestamp;
      if (isNaN(tokenTimestamp) || tokenAgeMs < 0 || tokenAgeMs > 15 * 60 * 1000) {
        return new Response(JSON.stringify({
          success: false,
          error: "Token de cleanup expirado."
        }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      const isValidSig = await verifyHmac(tokenPayload, tokenSig, hmacSecret);
      if (!isValidSig) {
        return new Response(JSON.stringify({
          success: false,
          error: "Assinatura do token de cleanup inválida."
        }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // Executa DELETE do objeto no R2
      const deleteUrl = `https://${accountId}.r2.cloudflarestorage.com/${bucketName}/${storageKey}`;
      const deleteReq = await s3Client.sign(new Request(deleteUrl, { method: "DELETE" }));
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
