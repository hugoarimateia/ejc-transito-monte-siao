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

const ADMIN_READ_ADAPTER = `

// ============================================================================
// STATIC ADMIN READ ADAPTER
// Keeps legacy admin read requests working on Cloudflare Pages.
// ============================================================================
(function() {
  const ADMIN_READ_URL =
    "https://guppedddwnuvluhiaaas.supabase.co/functions/v1/admin-read";

  const originalFetch = window.fetch;

  window.fetch = function(input, init) {
    let url =
      typeof input === "string"
        ? input
        : (input && input.url ? input.url : "");

    const method =
      (init && init.method ? init.method.toUpperCase() : "GET");

    // POST /api/admin com action=login -> admin-read
    if (url === "/api/admin" && method === "POST") {
      try {
        const bodyObj = init && init.body
          ? JSON.parse(init.body)
          : {};

        if (bodyObj.action === "login") {
          return originalFetch(ADMIN_READ_URL, init);
        }
      } catch (e) {}
    }

    // GET /api/admin -> admin-read
    if (url === "/api/admin" && method === "GET") {
      return originalFetch(ADMIN_READ_URL, init);
    }

    // GET /api/payment-settings -> admin-read
    if (url.startsWith("/api/payment-settings") && method === "GET") {
      const targetUrl =
        ADMIN_READ_URL + "?view=payment-settings";

      return originalFetch(targetUrl, init);
    }

    // GET /api/admin/inscritos-dados?sub=... -> admin-read
    if (
      url.startsWith("/api/admin/inscritos-dados") &&
      method === "GET"
    ) {
      const qIdx = url.indexOf("?");
      const query =
        qIdx >= 0
          ? url.slice(qIdx)
          : "?sub=todos";

      const targetUrl =
        ADMIN_READ_URL +
        "?view=inscritos-dados&" +
        query.replace(/^\?/, "");

      return originalFetch(targetUrl, init);
    }

    return originalFetch.apply(this, arguments);
  };
})();
`;

const finalSupabaseConfig =
  sourceSupabaseConfig.includes("ADMIN_READ_URL")
    ? sourceSupabaseConfig
    : sourceSupabaseConfig + ADMIN_READ_ADAPTER;

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