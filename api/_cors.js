// ==============================================================================
// CORS RESTRITO: só o próprio site (e localhost em ambiente de teste)
// pode chamar as APIs pelo navegador.
// Chamadas do mesmo domínio não precisam de CORS.
// Webhooks de gateway são servidor-para-servidor e não usam CORS do navegador.
// ==============================================================================
function allowedOrigins() {
  const list = new Set([
    "https://www.transitoejc.site",
    "https://transitoejc.site",
    "https://site-ejc-eight.vercel.app"
  ]);
  [process.env.SITE_URL, process.env.NEXT_PUBLIC_SITE_URL, process.env.APP_URL].forEach(u => {
    if (u) list.add(String(u).replace(/\/+$/, ""));
  });
  if (process.env.VERCEL_URL) list.add(`https://${process.env.VERCEL_URL}`);
  
  if (process.env.NODE_ENV !== "production" && process.env.VERCEL_ENV !== "production") {
    list.add("http://localhost:3000");
    list.add("http://127.0.0.1:3000");
    list.add("http://localhost:8080");
    list.add("http://127.0.0.1:8080");
  }
  return list;
}

function applyCors(req, res) {
  const origin = req.headers && (req.headers.origin || req.headers.Origin);
  res.setHeader("Vary", "Origin");
  if (origin && allowedOrigins().has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
}

module.exports = { applyCors, allowedOrigins };
