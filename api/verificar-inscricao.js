// ==============================================================================
// SERVERLESS FUNCTION: /api/verificar-inscricao
// Proxy e paridade local com a Edge Function Supabase verificar-inscricao
// ==============================================================================
const { applyCors } = require("./_cors");

module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;

  const edgeUrl = "https://guppedddwnuvluhiaaas.supabase.co/functions/v1/verificar-inscricao";
  const apikey = process.env.SUPABASE_ANON_KEY || "sb_publishable_QJV9XI3sN3P_gVtiQ2ObRg_gpSSKc-i";

  try {
    const fetchOptions = {
      method: req.method,
      headers: {
        "Content-Type": "application/json",
        "apikey": apikey
      }
    };

    if (req.headers.authorization) {
      fetchOptions.headers["Authorization"] = req.headers.authorization;
    }
    if (req.headers["x-admin-token"]) {
      fetchOptions.headers["x-admin-token"] = req.headers["x-admin-token"];
    }

    if (["POST", "PUT", "PATCH"].includes(req.method)) {
      fetchOptions.body = JSON.stringify(req.body || {});
    }

    const queryStr = req.url && req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    const upstreamRes = await fetch(`${edgeUrl}${queryStr}`, fetchOptions);
    const data = await upstreamRes.json().catch(() => ({}));

    return res.status(upstreamRes.status).json(data);
  } catch (err) {
    console.error("[/api/verificar-inscricao proxy error]", err);
    return res.status(502).json({
      error: "Falha de comunicação com o serviço de verificação.",
      detail: err.message
    });
  }
};
