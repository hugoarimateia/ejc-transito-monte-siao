// ==============================================================================
// ASSINATURA CRIPTOGRÁFICA DE URLs DE FOTOS PRIVADAS (HMAC-SHA256)
// Gera e valida tokens temporários de acesso para visualização de fotos privadas.
// ==============================================================================
const crypto = require("crypto");

function getSigningSecret() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.ADMIN_PASSWORD_COORDENACAO || "transitoejc26";
}

function generateSignedPhotoToken(path, ttlSeconds = 7200) {
  if (!path) return "";
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const secret = getSigningSecret();
  const signature = crypto.createHmac("sha256", secret).update(`${path}:${expires}`).digest("hex");
  return `${expires}.${signature}`;
}

function verifySignedPhotoToken(path, tokenString) {
  if (!path || !tokenString || !tokenString.includes(".")) return false;
  const [expiresStr, signature] = tokenString.split(".");
  const expires = parseInt(expiresStr, 10);
  if (!expires || Math.floor(Date.now() / 1000) > expires) return false;

  const secret = getSigningSecret();
  const expected = crypto.createHmac("sha256", secret).update(`${path}:${expires}`).digest("hex");
  
  if (signature.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
}

module.exports = {
  generateSignedPhotoToken,
  verifySignedPhotoToken
};
