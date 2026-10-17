const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "cloudflare-admin-dist");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function copyFile(src, dest) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function copyDir(src, dest) {
  ensureDir(dest);
  fs.cpSync(src, dest, { recursive: true });
}

function exists(file) {
  return fs.existsSync(file);
}

console.log("=".repeat(66));
console.log("GERANDO BUNDLE ADMINISTRATIVO: cloudflare-admin-dist/");
console.log("=".repeat(66));

// 1. Gera env-config.js exatamente pelo mecanismo já usado pelo projeto.
execFileSync(
  process.execPath,
  [path.join(__dirname, "build-env.js")],
  { stdio: "inherit", cwd: ROOT }
);

removeDir(DIST);
ensureDir(DIST);

// 2. Página administrativa.
copyDir(
  path.join(ROOT, "admin"),
  path.join(DIST, "admin")
);

// 3. CSS e fontes usados pelo Admin.
if (exists(path.join(ROOT, "css"))) {
  copyDir(path.join(ROOT, "css"), path.join(DIST, "css"));
}

if (exists(path.join(ROOT, "fonts"))) {
  copyDir(path.join(ROOT, "fonts"), path.join(DIST, "fonts"));
}

// 4. Copia somente as imagens locais referenciadas pelo admin/index.html.
const adminHtmlPath = path.join(ROOT, "admin", "index.html");
const adminHtml = fs.readFileSync(adminHtmlPath, "utf8");

const imageRefs = new Set();

for (const match of adminHtml.matchAll(/\.\.\/images\/([^"'?#)]+)/g)) {
  try {
    imageRefs.add(decodeURIComponent(match[1]));
  } catch {
    imageRefs.add(match[1]);
  }
}

// Recursos conhecidos do Admin.
[
  "favicondefault.png",
  "10 EJC MONTE SIÃO.png",
  "10 EJC MONTE SIÃO2.png"
].forEach((name) => imageRefs.add(name));

for (const relative of imageRefs) {
  const src = path.join(ROOT, "images", relative);
  if (exists(src)) {
    copyFile(src, path.join(DIST, "images", relative));
    console.log(`✓ Imagem: ${relative}`);
  }
}

// 5. JS local referenciado pelo Admin.
const jsRefs = new Set();

for (const match of adminHtml.matchAll(/\.\.\/js\/([^"'?#)]+)/g)) {
  jsRefs.add(match[1]);
}

// Recursos atualmente usados pelo Admin.
[
  "jszip.min.js",
  "jspdf.umd.min.js",
  "theme.js"
].forEach((name) => jsRefs.add(name));

for (const relative of jsRefs) {
  if (relative === "supabase-config.js" || relative === "env-config.js") {
    continue;
  }

  const src = path.join(ROOT, "js", relative);

  if (exists(src)) {
    copyFile(src, path.join(DIST, "js", relative));
    console.log(`✓ JS: ${relative}`);
  }
}

// 6. env-config.js gerado pelo build-env.js.
copyFile(
  path.join(ROOT, "js", "env-config.js"),
  path.join(DIST, "js", "env-config.js")
);

// 7. supabase-config.js:
// preserva a versão atual da fonte e acrescenta o adaptador
// necessário para o Admin estático continuar usando admin-read.
const sourceSupabaseConfig = fs.readFileSync(
  path.join(ROOT, "js", "supabase-config.js"),
  "utf8"
);

const ADMIN_EDGE_ADAPTER = `

// ============================================================================
// STATIC ADMIN EDGE ADAPTER (READ & WRITE)
// Keeps legacy admin read & write requests working on Cloudflare Pages.
// ============================================================================
(function() {
  const ADMIN_READ_URL =
    "https://guppedddwnuvluhiaaas.supabase.co/functions/v1/admin-read";
  const ADMIN_WRITE_URL =
    "https://guppedddwnuvluhiaaas.supabase.co/functions/v1/admin-write";
  const CHECKOUT_PROCESS_URL =
    "https://guppedddwnuvluhiaaas.supabase.co/functions/v1/checkout-process";

  const originalFetch = window.fetch;

  if (typeof window !== "undefined") {
    window.EJC_ENDPOINTS = window.EJC_ENDPOINTS || {};
    if (typeof window.EJC_ENDPOINTS.adminWrite !== "function") {
      window.EJC_ENDPOINTS.adminWrite = function() { return ADMIN_WRITE_URL; };
    }
    if (typeof window.EJC_ENDPOINTS.adminRead !== "function") {
      window.EJC_ENDPOINTS.adminRead = function() { return ADMIN_READ_URL; };
    }
  }

  window.fetch = function(input, init) {
    let rawUrl =
      typeof input === "string"
        ? input
        : (input && input.url ? input.url : "");

    let pathname = "";
    let search = "";
    try {
      const baseOrigin =
        (typeof window !== "undefined" && window.location && window.location.origin)
          ? window.location.origin
          : "https://ejc-admin.pages.dev";
      const parsed = new URL(rawUrl, baseOrigin);
      pathname = parsed.pathname;
      search = parsed.search;
    } catch (_) {
      const qIdx = rawUrl.indexOf("?");
      if (qIdx >= 0) {
        pathname = rawUrl.slice(0, qIdx);
        search = rawUrl.slice(qIdx);
      } else {
        pathname = rawUrl;
        search = "";
      }
    }

    const method =
      (init && init.method ? init.method.toUpperCase() : "GET");

    // Identificação flexível de rotas (suporta "/", sem "/", URLs absolutas e relativas)
    const isPhotoRoute =
      pathname === "/api/admin/inscritos-foto" ||
      pathname === "/api/admin/inscritos-foto/" ||
      pathname === "/api/inscritos-foto" ||
      pathname === "/api/inscritos-foto/" ||
      rawUrl.includes("api/admin/inscritos-foto") ||
      rawUrl.includes("api/inscritos-foto");

    const isDadosRoute =
      pathname === "/api/admin/inscritos-dados" ||
      pathname === "/api/admin/inscritos-dados/" ||
      pathname === "/api/inscritos-dados" ||
      pathname === "/api/inscritos-dados/" ||
      rawUrl.includes("api/admin/inscritos-dados") ||
      rawUrl.includes("api/inscritos-dados");

    const isAdminRoute =
      pathname === "/api/admin" ||
      pathname === "/api/admin/" ||
      rawUrl === "/api/admin" ||
      rawUrl.endsWith("/api/admin");

    const isPaymentSettingsRoute =
      pathname === "/api/payment-settings" ||
      pathname === "/api/payment-settings/" ||
      rawUrl.includes("api/payment-settings");

    const isCheckoutProcessRoute =
      pathname === "/api/checkout-process" ||
      pathname === "/api/checkout-process/" ||
      rawUrl.includes("api/checkout-process");

    const isAdminWriteRoute =
      pathname === "/api/admin-write" ||
      pathname === "/api/admin-write/" ||
      rawUrl.includes("api/admin-write");

    if (isAdminWriteRoute && method === "POST") {
      return originalFetch(ADMIN_WRITE_URL, init);
    }

    // POST /api/admin com action=login -> admin-read
    // Outras ações em POST /api/admin -> admin-write
    if (isAdminRoute && method === "POST") {
      try {
        const bodyObj = init && init.body
          ? JSON.parse(init.body)
          : {};

        if (bodyObj.action === "login" || bodyObj.action === "get_comprovante_url" || bodyObj.action === "get_comprovante") {
          return originalFetch(ADMIN_READ_URL, init);
        } else if (bodyObj.action) {
          return originalFetch(ADMIN_WRITE_URL, init);
        }
      } catch (e) {}
    }

    // GET /api/admin -> admin-read
    if (isAdminRoute && method === "GET") {
      return originalFetch(ADMIN_READ_URL, init);
    }

    // GET /api/payment-settings -> admin-read
    if (isPaymentSettingsRoute && method === "GET") {
      const targetUrl = ADMIN_READ_URL + "?view=payment-settings";
      return originalFetch(targetUrl, init);
    }

    // POST ou PUT /api/payment-settings -> admin-write
    if (isPaymentSettingsRoute && (method === "POST" || method === "PUT")) {
      return originalFetch(ADMIN_WRITE_URL, init);
    }

    // POST /api/checkout-process -> checkout-process Edge Function
    if (isCheckoutProcessRoute && method === "POST") {
      return originalFetch(CHECKOUT_PROCESS_URL, init);
    }

    // POST /api/admin/inscritos-foto -> admin-write (upload de foto)
    if (isPhotoRoute && method === "POST") {
      try {
        let bodyObj = init && init.body ? JSON.parse(init.body) : {};
        if (!bodyObj.action) {
          bodyObj.action = "upload_participant_photo";
        }
        return originalFetch(ADMIN_WRITE_URL, {
          ...init,
          method: "POST",
          body: JSON.stringify(bodyObj)
        });
      } catch (e) {
        return originalFetch(ADMIN_WRITE_URL, init);
      }
    }

    // GET /api/admin/inscritos-foto -> admin-read
    if (isPhotoRoute && method === "GET") {
      return originalFetch(ADMIN_READ_URL + search, init);
    }

    // GET /api/admin/inscritos-dados?sub=... -> admin-read
    if (isDadosRoute && method === "GET") {
      const query = search ? (search.includes("view=") ? search : search + "&view=inscritos-dados") : "?view=inscritos-dados";
      return originalFetch(ADMIN_READ_URL + query, init);
    }

    // PATCH, POST ou PUT /api/admin/inscritos-dados -> admin-write (atualizar dados do participante)
    if (isDadosRoute && (method === "PATCH" || method === "POST" || method === "PUT")) {
      try {
        let bodyObj = init && init.body ? JSON.parse(init.body) : {};
        if (!bodyObj.action) {
          bodyObj.action = "update_participant";
        }
        return originalFetch(ADMIN_WRITE_URL, {
          ...init,
          method: "POST",
          body: JSON.stringify(bodyObj)
        });
      } catch (e) {
        return originalFetch(ADMIN_WRITE_URL, init);
      }
    }

    return originalFetch.apply(this, arguments);
  };
})();
`;

const finalSupabaseConfig =
  sourceSupabaseConfig.includes("ADMIN_EDGE_ADAPTER") || sourceSupabaseConfig.includes("ADMIN_READ_URL")
    ? sourceSupabaseConfig
    : sourceSupabaseConfig + ADMIN_EDGE_ADAPTER;

copyFile(
  path.join(ROOT, "js", "supabase-config.js"),
  path.join(DIST, "js", "__source-supabase-config.js")
);

fs.writeFileSync(
  path.join(DIST, "js", "supabase-config.js"),
  finalSupabaseConfig,
  "utf8"
);

fs.rmSync(
  path.join(DIST, "js", "__source-supabase-config.js"),
  { force: true }
);

// 8. Arquivos auxiliares atuais do bundle Admin.
copyFile(
  path.join(__dirname, "admin-static", "index.html"),
  path.join(DIST, "index.html")
);

copyFile(
  path.join(__dirname, "admin-static", "_redirects"),
  path.join(DIST, "_redirects")
);

// 8b. Gera _worker.js no bundle para roteamento nativo no Cloudflare Pages
// Previne HTTP 405 caso requisições POST/PATCH alcancem diretamente a infraestrutura da Cloudflare.
const adminWorkerContent = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const isPhotoRoute =
      url.pathname.includes('/api/admin/inscritos-foto') ||
      url.pathname.includes('/api/inscritos-foto');

    const isDadosRoute =
      url.pathname.includes('/api/admin/inscritos-dados') ||
      url.pathname.includes('/api/inscritos-dados');

    // 1. Intercepta /api/admin/inscritos-foto e /api/inscritos-foto
    if (isPhotoRoute) {
      if (request.method === 'POST') {
        let bodyData = {};
        try {
          bodyData = await request.clone().json();
        } catch (_) {}
        if (!bodyData.action) {
          bodyData.action = "upload_participant_photo";
        }

        const targetUrl = new URL('/functions/v1/admin-write', 'https://guppedddwnuvluhiaaas.supabase.co');
        const modifiedHeaders = new Headers(request.headers);
        modifiedHeaders.set('host', 'guppedddwnuvluhiaaas.supabase.co');
        modifiedHeaders.set('Content-Type', 'application/json');

        const upstreamRes = await fetch(targetUrl.toString(), {
          method: 'POST',
          headers: modifiedHeaders,
          body: JSON.stringify(bodyData)
        });

        const respHeaders = new Headers(upstreamRes.headers);
        respHeaders.set('Access-Control-Allow-Origin', '*');
        respHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-token');
        return new Response(upstreamRes.body, {
          status: upstreamRes.status,
          statusText: upstreamRes.statusText,
          headers: respHeaders
        });
      }

      if (request.method === 'GET') {
        const targetUrl = new URL('/functions/v1/admin-read' + url.search, 'https://guppedddwnuvluhiaaas.supabase.co');
        const modifiedHeaders = new Headers(request.headers);
        modifiedHeaders.set('host', 'guppedddwnuvluhiaaas.supabase.co');
        const upstreamRes = await fetch(targetUrl.toString(), {
          method: 'GET',
          headers: modifiedHeaders
        });
        const respHeaders = new Headers(upstreamRes.headers);
        respHeaders.set('Access-Control-Allow-Origin', '*');
        return new Response(upstreamRes.body, {
          status: upstreamRes.status,
          statusText: upstreamRes.statusText,
          headers: respHeaders
        });
      }

      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-token'
          }
        });
      }
    }

    // 2. Intercepta /api/admin/inscritos-dados e /api/inscritos-dados
    if (isDadosRoute) {
      if (['PATCH', 'POST', 'PUT'].includes(request.method)) {
        let bodyData = {};
        try {
          bodyData = await request.clone().json();
        } catch (_) {}
        if (!bodyData.action) {
          bodyData.action = "update_participant";
        }

        const targetUrl = new URL('/functions/v1/admin-write', 'https://guppedddwnuvluhiaaas.supabase.co');
        const modifiedHeaders = new Headers(request.headers);
        modifiedHeaders.set('host', 'guppedddwnuvluhiaaas.supabase.co');
        modifiedHeaders.set('Content-Type', 'application/json');

        const upstreamRes = await fetch(targetUrl.toString(), {
          method: 'POST',
          headers: modifiedHeaders,
          body: JSON.stringify(bodyData)
        });

        const respHeaders = new Headers(upstreamRes.headers);
        respHeaders.set('Access-Control-Allow-Origin', '*');
        respHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-token');
        return new Response(upstreamRes.body, {
          status: upstreamRes.status,
          statusText: upstreamRes.statusText,
          headers: respHeaders
        });
      }

      if (request.method === 'GET') {
        const query = url.search ? (url.search.includes('view=') ? url.search : url.search + '&view=inscritos-dados') : '?view=inscritos-dados';
        const targetUrl = new URL('/functions/v1/admin-read' + query, 'https://guppedddwnuvluhiaaas.supabase.co');
        const modifiedHeaders = new Headers(request.headers);
        modifiedHeaders.set('host', 'guppedddwnuvluhiaaas.supabase.co');
        const upstreamRes = await fetch(targetUrl.toString(), {
          method: 'GET',
          headers: modifiedHeaders
        });
        const respHeaders = new Headers(upstreamRes.headers);
        respHeaders.set('Access-Control-Allow-Origin', '*');
        return new Response(upstreamRes.body, {
          status: upstreamRes.status,
          statusText: upstreamRes.statusText,
          headers: respHeaders
        });
      }

      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-token'
          }
        });
      }
    }

    // 3. Intercepta /api/admin-write
    const isAdminWriteRoute = url.pathname.includes('/api/admin-write');
    if (isAdminWriteRoute) {
      if (request.method === 'POST') {
        const targetUrl = new URL('/functions/v1/admin-write', 'https://guppedddwnuvluhiaaas.supabase.co');
        const modifiedHeaders = new Headers(request.headers);
        modifiedHeaders.set('host', 'guppedddwnuvluhiaaas.supabase.co');
        const upstreamRes = await fetch(targetUrl.toString(), {
          method: 'POST',
          headers: modifiedHeaders,
          body: request.body
        });
        const respHeaders = new Headers(upstreamRes.headers);
        respHeaders.set('Access-Control-Allow-Origin', '*');
        respHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-token');
        return new Response(upstreamRes.body, {
          status: upstreamRes.status,
          statusText: upstreamRes.statusText,
          headers: respHeaders
        });
      }
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-token'
          }
        });
      }
    }

    // 4. Demais arquivos estáticos do Cloudflare Pages
    return env.ASSETS.fetch(request);
  }
};
`;

fs.writeFileSync(path.join(DIST, "_worker.js"), adminWorkerContent.trim(), "utf8");

// 9. Resumo.
let totalFiles = 0;
let totalBytes = 0;

function inspect(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      inspect(full);
    } else {
      totalFiles++;
      totalBytes += fs.statSync(full).size;
    }
  }
}

inspect(DIST);

console.log("");
console.log("=".repeat(66));
console.log("RESUMO DO BUNDLE");
console.log(`- Total de arquivos: ${totalFiles}`);
console.log(
  `- Tamanho total: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`
);
console.log("=".repeat(66));