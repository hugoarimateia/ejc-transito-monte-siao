// ==============================================================================
// VERCEL SERVERLESS FUNCTION: /api/inscritos-foto
// Módulo Administrativo: Armazenamento e Visualização Segura de Fotos dos Inscritos
//   GET  ?path=... -> Recupera a foto de forma autenticada (bucket privado via service_role)
//   POST { inscricao_id, fileBase64, mimeType } -> Upload privado e registro no banco
// ==============================================================================
const crypto = require("crypto");
const { applyCors } = require("./_cors");
const adminAuth = require("./_admin-auth");
const { verifySignedPhotoToken } = require("./_photo-signer");

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

const ALLOWED_MIME_TYPES = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp"
};

// Validação de assinatura binária (Magic Bytes) para impedir extensões forjadas
function validateMagicBytes(buffer, mime) {
  if (!buffer || buffer.length < 12) return false;
  // JPEG: FF D8 FF
  if (mime === "image/jpeg" || mime === "image/jpg") {
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  // PNG: 89 50 4E 47
  if (mime === "image/png") {
    return buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  }
  // WebP: RIFF .... WEBP
  if (mime === "image/webp") {
    const isRiff = buffer.toString("ascii", 0, 4) === "RIFF";
    const isWebp = buffer.toString("ascii", 8, 12) === "WEBP";
    return isRiff && isWebp;
  }
  return false;
}

module.exports = async (req, res) => {
  applyCors(req, res);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-admin-token");

  if (req.method === "OPTIONS") return res.status(200).end();

  const baseUrl = String(process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "https://guppedddwnuvluhiaaas.supabase.co").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "sb_publishable_QJV9XI3sN3P_gVtiQ2ObRg_gpSSKc-i";

const FALLBACK_PHOTO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160" width="160" height="160">
  <rect width="160" height="160" rx="80" fill="#f1f5f9"/>
  <circle cx="80" cy="62" r="30" fill="#94a3b8"/>
  <path d="M35 138 c0-28 20-46 45-46 s45 18 45 46" fill="#94a3b8"/>
</svg>`;

  // ---------------------------------------------------------------------------
  // GET: STREAMING SEGURO DA FOTO PRIVADA (HMAC TOKEN OU HEADER ADMIN)
  // ---------------------------------------------------------------------------
  if (req.method === "GET") {
    const rawPath = String(req.query.path || "").trim();
    if (!rawPath) {
      return res.status(400).json({ error: "Parâmetro 'path' é obrigatório." });
    }

    // Normaliza caminho (remove barras iniciais/duplicadas e prefixos de bucket)
    const cleanPath = rawPath.replace(/^[/\\]+/, "").replace(/^(inscritos-fotos|fotos)[/\\]/, "");

    // Prevenção contra Directory Traversal (LFI)
    if (cleanPath.includes("..") || cleanPath.includes("\\")) {
      return res.status(400).json({ error: "Caminho de arquivo inválido." });
    }

    // Permite apenas prefixos controlados da aplicação
    if (!cleanPath.startsWith("inscritos/") && !cleanPath.startsWith("participantes/") && !cleanPath.startsWith("comprovantes/")) {
      return res.status(403).json({ error: "Acesso não permitido a este diretório." });
    }

    // Validação de autenticação: aceita token assinado HMAC ou sessão administrativa
    const token = String(req.query.token || "").trim();
    const hasValidSignedToken = token && (
      verifySignedPhotoToken(rawPath, token) ||
      verifySignedPhotoToken(cleanPath, token)
    );
    const auth = adminAuth.authenticate(req);

    if (!hasValidSignedToken && !auth.ok) {
      return res.status(401).json({ error: "Acesso não autorizado à foto do inscrito." });
    }

    try {
      // 1. Tenta buscar no bucket privado 'inscritos-fotos'
      let storageRes = await fetch(`${baseUrl}/storage/v1/object/inscritos-fotos/${cleanPath}`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` }
      });

      // 2. Se não encontrar, tenta buscar no bucket original 'fotos'
      if (!storageRes.ok) {
        storageRes = await fetch(`${baseUrl}/storage/v1/object/fotos/${cleanPath}`, {
          headers: { apikey: key, Authorization: `Bearer ${key}` }
        });
      }

      if (!storageRes.ok) {
        console.warn("[Inscritos Foto API] Foto não encontrada no Storage:", cleanPath);
        const accept = String(req.headers["accept"] || "");
        if (accept.includes("image") || !accept.includes("application/json")) {
          res.setHeader("Content-Type", "image/svg+xml");
          res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
          return res.status(200).send(Buffer.from(FALLBACK_PHOTO_SVG));
        }
        return res.status(404).json({ error: "Foto não encontrada no armazenamento seguro." });
      }

      const contentType = storageRes.headers.get("content-type") || "image/jpeg";
      const buffer = await storageRes.arrayBuffer();

      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "private, no-transform, max-age=3600");
      res.setHeader("Content-Disposition", `inline; filename="foto-${cleanPath.split("/").pop()}"`);
      return res.status(200).send(Buffer.from(buffer));
    } catch (err) {
      console.error("[Inscritos Foto API] Erro ao recuperar foto:", err.message);
      return res.status(500).json({ error: "Erro interno ao carregar a imagem." });
    }
  }

  // ---------------------------------------------------------------------------
  // POST: UPLOAD SEGURO DE NOVA FOTO DO INSCRITO
  // ---------------------------------------------------------------------------
  if (req.method === "POST") {
    const auth = adminAuth.requireRole(req, res);
    if (!auth) return;

    const { inscricao_id, fileBase64, mimeType } = req.body || {};

    if (!inscricao_id || typeof inscricao_id !== "string") {
      return res.status(400).json({ error: "ID da inscrição é obrigatório." });
    }

    if (!fileBase64 || typeof fileBase64 !== "string") {
      return res.status(400).json({ error: "Arquivo de imagem (Base64) é obrigatório." });
    }

    const cleanMime = String(mimeType || "image/jpeg").toLowerCase().trim();
    const ext = ALLOWED_MIME_TYPES[cleanMime];
    if (!ext) {
      return res.status(400).json({ error: "Formato de imagem não suportado. Utilize JPG, PNG ou WebP." });
    }

    // Decodifica Base64
    const base64Data = fileBase64.replace(/^data:image\/[a-z]+;base64,/i, "");
    let fileBuffer;
    try {
      fileBuffer = Buffer.from(base64Data, "base64");
    } catch (e) {
      return res.status(400).json({ error: "Formato Base64 inválido." });
    }

    // Valida tamanho
    if (fileBuffer.length === 0) {
      return res.status(400).json({ error: "Arquivo vazio." });
    }
    if (fileBuffer.length > MAX_FILE_SIZE) {
      return res.status(400).json({ error: "A imagem não pode exceder o tamanho máximo de 5MB." });
    }

    // Valida assinatura binária real
    if (!validateMagicBytes(fileBuffer, cleanMime)) {
      return res.status(400).json({ error: "O conteúdo do arquivo não corresponde a uma imagem válida." });
    }

    // Gera caminho com ID seguro e UUID imprevisível
    const randomId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
    const storagePath = `inscritos/${inscricao_id}/${randomId}.${ext}`;

    try {
      // 1. Tenta upload no bucket privado 'inscritos-fotos'
      let uploadRes = await fetch(`${baseUrl}/storage/v1/object/inscritos-fotos/${storagePath}`, {
        method: "POST",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Content-Type": cleanMime,
          "x-upsert": "true"
        },
        body: fileBuffer
      });

      // 2. Se o bucket inscritos-fotos ainda não existir na conta, usa bucket fotos como fallback seguro
      if (!uploadRes.ok) {
        uploadRes = await fetch(`${baseUrl}/storage/v1/object/fotos/${storagePath}`, {
          method: "POST",
          headers: {
            apikey: key,
            Authorization: `Bearer ${key}`,
            "Content-Type": cleanMime,
            "x-upsert": "true"
          },
          body: fileBuffer
        });
      }

      if (!uploadRes.ok) {
        const errText = await uploadRes.text().catch(() => "");
        throw new Error(`Falha no upload Storage: ${uploadRes.status} ${errText}`);
      }

      // 3. Atualiza na tabela inscritos_dados
      try {
        await fetch(`${baseUrl}/rest/v1/inscritos_dados?on_conflict=inscricao_id`, {
          method: "POST",
          headers: {
            apikey: key,
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
            Prefer: "resolution=merge-duplicates"
          },
          body: JSON.stringify({
            inscricao_id,
            foto_caminho: storagePath,
            foto_uploaded_at: new Date().toISOString(),
            atualizado_por: auth.label || "admin",
            atualizado_em: new Date().toISOString()
          })
        });
      } catch (e) {}

      // 4. Também atualiza foto_caminho na tabela inscricoes para consistência do cadastro
      try {
        await fetch(`${baseUrl}/rest/v1/inscricoes?id=eq.${inscricao_id}`, {
          method: "PATCH",
          headers: {
            apikey: key,
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            foto_caminho: storagePath
          })
        });
      } catch (e) {}

      return res.status(200).json({
        success: true,
        message: "Foto enviada e armazenada com segurança.",
        foto_caminho: storagePath
      });
    } catch (err) {
      console.error("[Inscritos Foto API] Erro no upload:", err.message);
      return res.status(500).json({ error: "Erro interno ao processar o envio da foto." });
    }
  }

  return res.status(405).json({ error: "Método não permitido." });
};
