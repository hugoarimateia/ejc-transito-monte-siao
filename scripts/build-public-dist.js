const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'cloudflare-public-dist');

console.log("==================================================================");
console.log("GERANDO BUNDLE PÚBLICO: cloudflare-public-dist/");
console.log("==================================================================");

// 1. Limpa diretório de distribuição anterior
if (fs.existsSync(DIST_DIR)) {
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
}
fs.mkdirSync(DIST_DIR, { recursive: true });

// 2. Garante env-config.js atualizado
require('./build-env');

// 3. Arquivos HTML públicos raiz
const htmlFiles = [
  'index.html',
  'checkout.html',
  'confirmacao-pagamento.html',
  'checkout-retorno.html',
  'verificar-inscricao.html'
];

for (const f of htmlFiles) {
  const src = path.join(ROOT_DIR, f);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(DIST_DIR, f));
    console.log(`✓ Copiado: ${f}`);
  }
}

// 4. Diretórios estáticos completos
function copyDirRecursive(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(destDir, { recursive: true });
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

copyDirRecursive(path.join(ROOT_DIR, 'css'), path.join(DIST_DIR, 'css'));
console.log(`✓ Diretório copiado: css/`);

copyDirRecursive(path.join(ROOT_DIR, 'fonts'), path.join(DIST_DIR, 'fonts'));
console.log(`✓ Diretório copiado: fonts/`);

copyDirRecursive(path.join(ROOT_DIR, 'images'), path.join(DIST_DIR, 'images'));
console.log(`✓ Diretório copiado: images/`);

if (fs.existsSync(path.join(ROOT_DIR, 'audio'))) {
  copyDirRecursive(path.join(ROOT_DIR, 'audio'), path.join(DIST_DIR, 'audio'));
  console.log(`✓ Diretório copiado: audio/`);
}

if (fs.existsSync(path.join(ROOT_DIR, 'audios'))) {
  copyDirRecursive(path.join(ROOT_DIR, 'audios'), path.join(DIST_DIR, 'audios'));
  console.log(`✓ Diretório copiado: audios/`);
}

// 5. Scripts públicos específicos (NÃO incluir jszip ou jspdf da área administrativa)
fs.mkdirSync(path.join(DIST_DIR, 'js'), { recursive: true });
const publicJsFiles = [
  'script.js',
  'supabase-config.js',
  'env-config.js',
  'theme.js'
];

for (const jsFile of publicJsFiles) {
  const src = path.join(ROOT_DIR, 'js', jsFile);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(DIST_DIR, 'js', jsFile));
    console.log(`✓ Copiado: js/${jsFile}`);
  }
}

// 6. Arquivo _redirects do Cloudflare Pages
const redirectsContent = `# Cloudflare Pages Redirects - EJC Trânsito Público
# Redirecionamento da área administrativa para o Cloudflare Pages do Admin já publicado
/admin/*  https://ejc-admin.pages.dev/admin/:splat  302
/admin    https://ejc-admin.pages.dev/admin/        302
`;
fs.writeFileSync(path.join(DIST_DIR, '_redirects'), redirectsContent, 'utf8');
console.log(`✓ Gerado: _redirects`);

// 7. Arquivo _headers do Cloudflare Pages
const headersContent = `# Headers de Segurança e Cache Otimizado para Cloudflare Pages
/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: SAMEORIGIN
  Referrer-Policy: strict-origin-when-cross-origin

/fonts/*
  Cache-Control: public, max-age=31536000, immutable

/images/*
  Cache-Control: public, max-age=604800, stale-while-revalidate=86400

/css/*
  Cache-Control: public, max-age=86400, stale-while-revalidate=3600

/js/*
  Cache-Control: public, max-age=86400, stale-while-revalidate=3600

/*.html
  Cache-Control: public, max-age=0, must-revalidate

/
  Cache-Control: public, max-age=0, must-revalidate

/api/*
  Cache-Control: no-cache, no-store, must-revalidate
`;
fs.writeFileSync(path.join(DIST_DIR, '_headers'), headersContent, 'utf8');
console.log(`✓ Gerado: _headers`);

// 8. Arquivo _worker.js (Cloudflare Pages Advanced Worker para Proxy transparente e Cache)
const workerContent = `export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. Redirecionamento da área administrativa para o Cloudflare Pages do Admin já publicado
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
      const adminTarget = new URL(url.pathname.replace(/^\\/admin/, '/admin') + url.search, 'https://ejc-admin.pages.dev');
      return Response.redirect(adminTarget.toString(), 302);
    }

    // 2. Normalização para servir arquivos .html sem 308 (suporta tanto /rota quanto /rota.html com 200)
    if (url.pathname.endsWith('.html') && url.pathname !== '/index.html') {
      const cleanPath = url.pathname.replace(/\\.html$/, '');
      const cleanUrl = new URL(cleanPath + url.search, request.url);
      const cleanRes = await env.ASSETS.fetch(new Request(cleanUrl, request));
      if (cleanRes.status === 200) {
        return cleanRes;
      }
    }

    // 3. /api/checkout-process com suporte a Feature Flag
    // REGRA DE SEGURANÇA (ENV.11.1):
    // - Ambiente de produção (env.FEATURE_FLAG_CHECKOUT_PROCESS_EDGE) é AUTORITATIVO
    // - Cliente não consegue alterar a decisão de roteamento via header quando env estiver definido
    // - DEFAULT SEGURO: 'ON'
    if (url.pathname === '/api/checkout-process' || url.pathname === '/api/checkout-process/') {
      const envFlag = env && env.FEATURE_FLAG_CHECKOUT_PROCESS_EDGE ? String(env.FEATURE_FLAG_CHECKOUT_PROCESS_EDGE).trim().toUpperCase() : null;
      const headerFlag = request.headers.get('x-feature-flag-checkout-process-edge') ? request.headers.get('x-feature-flag-checkout-process-edge').trim().toUpperCase() : null;

      let flagValue = 'ON';
      if (envFlag === 'ON' || envFlag === 'OFF') {
        flagValue = envFlag;
      } else if (headerFlag === 'ON' || headerFlag === 'OFF') {
        flagValue = headerFlag;
      } else {
        flagValue = 'ON';
      }

      const useEdge = flagValue === 'ON';

      const targetUrl = useEdge
        ? new URL('/functions/v1/checkout-process' + url.search, 'https://guppedddwnuvluhiaaas.supabase.co')
        : new URL(url.pathname + url.search, 'https://transitoejc.site');

      const modifiedHeaders = new Headers(request.headers);
      modifiedHeaders.delete('x-feature-flag-checkout-process-edge');

      if (useEdge) {
        modifiedHeaders.set('host', 'guppedddwnuvluhiaaas.supabase.co');
        if (!modifiedHeaders.has('apikey')) {
          modifiedHeaders.set('apikey', 'sb_publishable_QJV9XI3sN3P_gVtiQ2ObRg_gpSSKc-i');
        }
      } else {
        modifiedHeaders.set('host', 'transitoejc.site');
      }

      const reqInit = {
        method: request.method,
        headers: modifiedHeaders,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
        redirect: 'follow'
      };

      try {
        const upstreamRes = await fetch(targetUrl.toString(), reqInit);
        const resHeaders = new Headers(upstreamRes.headers);
        resHeaders.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        resHeaders.set('x-routed-backend', useEdge ? 'supabase-edge' : 'vercel-legacy');
        resHeaders.set('x-feature-flag-status', useEdge ? 'ON' : 'OFF');

        return new Response(upstreamRes.body, {
          status: upstreamRes.status,
          statusText: upstreamRes.statusText,
          headers: resHeaders
        });
      } catch (err) {
        return new Response(JSON.stringify({ 
          success: false, 
          error: \`Falha no proxy para \${useEdge ? 'Supabase Edge' : 'Vercel'}: \${err.message}\` 
        }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // 4. /api/sub-counts (GET contagens e POST inscrições) -> Supabase Edge Function
    if (url.pathname === '/api/sub-counts' || url.pathname === '/api/sub-counts/') {
      const targetUrl = new URL('/functions/v1/sub-counts' + url.search, 'https://guppedddwnuvluhiaaas.supabase.co');
      const modifiedHeaders = new Headers(request.headers);
      modifiedHeaders.set('host', 'guppedddwnuvluhiaaas.supabase.co');
      if (!modifiedHeaders.has('apikey')) {
        modifiedHeaders.set('apikey', 'sb_publishable_QJV9XI3sN3P_gVtiQ2ObRg_gpSSKc-i');
      }
      return fetch(targetUrl.toString(), {
        method: request.method,
        headers: modifiedHeaders,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body
      });
    }

    // 5. /api/config -> Supabase Edge Function public-config
    if (url.pathname === '/api/config' || url.pathname === '/api/config/') {
      const targetUrl = new URL('/functions/v1/public-config' + url.search, 'https://guppedddwnuvluhiaaas.supabase.co');
      const modifiedHeaders = new Headers(request.headers);
      modifiedHeaders.set('host', 'guppedddwnuvluhiaaas.supabase.co');
      if (!modifiedHeaders.has('apikey')) {
        modifiedHeaders.set('apikey', 'sb_publishable_QJV9XI3sN3P_gVtiQ2ObRg_gpSSKc-i');
      }
      return fetch(targetUrl.toString(), {
        method: request.method,
        headers: modifiedHeaders,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body
      });
    }

    // 6. /api/whatsapp -> Supabase Edge Function whatsapp
    if (url.pathname === '/api/whatsapp' || url.pathname === '/api/whatsapp/') {
      const targetUrl = new URL('/functions/v1/whatsapp' + url.search, 'https://guppedddwnuvluhiaaas.supabase.co');
      const modifiedHeaders = new Headers(request.headers);
      modifiedHeaders.set('host', 'guppedddwnuvluhiaaas.supabase.co');
      if (!modifiedHeaders.has('apikey')) {
        modifiedHeaders.set('apikey', 'sb_publishable_QJV9XI3sN3P_gVtiQ2ObRg_gpSSKc-i');
      }
      return fetch(targetUrl.toString(), {
        method: request.method,
        headers: modifiedHeaders,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
        redirect: 'manual'
      });
    }

    // 7. /api/email-comprovante -> Supabase Edge Function checkout-process (action: resend_receipt)
    if (url.pathname === '/api/email-comprovante' || url.pathname === '/api/email-comprovante/') {
      let bodyData = {};
      try {
        bodyData = await request.clone().json();
      } catch (_) {}
      bodyData.action = "resend_receipt";

      const targetUrl = new URL('/functions/v1/checkout-process', 'https://guppedddwnuvluhiaaas.supabase.co');
      const modifiedHeaders = new Headers(request.headers);
      modifiedHeaders.set('host', 'guppedddwnuvluhiaaas.supabase.co');
      modifiedHeaders.set('Content-Type', 'application/json');
      if (!modifiedHeaders.has('apikey')) {
        modifiedHeaders.set('apikey', 'sb_publishable_QJV9XI3sN3P_gVtiQ2ObRg_gpSSKc-i');
      }
      return fetch(targetUrl.toString(), {
        method: 'POST',
        headers: modifiedHeaders,
        body: JSON.stringify(bodyData)
      });
    }

    // 8. /api/pix-webhook -> Supabase Edge Function pix-webhook
    if (url.pathname === '/api/pix-webhook' || url.pathname === '/api/pix-webhook/') {
      const targetUrl = new URL('/functions/v1/pix-webhook' + url.search, 'https://guppedddwnuvluhiaaas.supabase.co');
      const modifiedHeaders = new Headers(request.headers);
      modifiedHeaders.set('host', 'guppedddwnuvluhiaaas.supabase.co');
      return fetch(targetUrl.toString(), {
        method: request.method,
        headers: modifiedHeaders,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body
      });
    }

    // 9. /api/r2-presigned-url -> Supabase Edge Function r2-presigned-url
    if (url.pathname === '/api/r2-presigned-url' || url.pathname === '/api/r2-presigned-url/') {
      const targetUrl = new URL('/functions/v1/r2-presigned-url' + url.search, 'https://guppedddwnuvluhiaaas.supabase.co');
      const modifiedHeaders = new Headers(request.headers);
      modifiedHeaders.set('host', 'guppedddwnuvluhiaaas.supabase.co');
      if (!modifiedHeaders.has('apikey')) {
        modifiedHeaders.set('apikey', 'sb_publishable_QJV9XI3sN3P_gVtiQ2ObRg_gpSSKc-i');
      }
      return fetch(targetUrl.toString(), {
        method: request.method,
        headers: modifiedHeaders,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body
      });
    }

    // 10. /api/verificar-inscricao -> Supabase Edge Function verificar-inscricao
    if (url.pathname === '/api/verificar-inscricao' || url.pathname === '/api/verificar-inscricao/') {
      const targetUrl = new URL('/functions/v1/verificar-inscricao' + url.search, 'https://guppedddwnuvluhiaaas.supabase.co');
      const modifiedHeaders = new Headers(request.headers);
      modifiedHeaders.set('host', 'guppedddwnuvluhiaaas.supabase.co');
      if (!modifiedHeaders.has('apikey')) {
        modifiedHeaders.set('apikey', 'sb_publishable_QJV9XI3sN3P_gVtiQ2ObRg_gpSSKc-i');
      }
      return fetch(targetUrl.toString(), {
        method: request.method,
        headers: modifiedHeaders,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body
      });
    }

    // 10. Endpoints legados residuais /api/* não utilizados pelo frontend público retornam 404 seguro (ZERO Vercel)
    if (url.pathname.startsWith('/api/')) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: \`Endpoint legado descontinuado: \${url.pathname}. Todas as operações ativas foram migradas para Supabase Edge.\` 
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 11. Serve todos os assets estáticos do Cloudflare Pages (HTML, JS, CSS, Fontes, Imagens)
    return env.ASSETS.fetch(request);
  }
};
`;
fs.writeFileSync(path.join(DIST_DIR, '_worker.js'), workerContent, 'utf8');
console.log(`✓ Gerado: _worker.js`);


// 8. Cálculo de tamanho do bundle
function getDirStats(dir) {
  let count = 0;
  let size = 0;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = getDirStats(full);
      count += sub.count;
      size += sub.size;
    } else {
      count++;
      size += fs.statSync(full).size;
    }
  }
  return { count, size };
}

const stats = getDirStats(DIST_DIR);
console.log("\n==================================================================");
console.log(`RESUMO DO BUNDLE (cloudflare-public-dist):`);
console.log(`- Total de arquivos: ${stats.count}`);
console.log(`- Tamanho total: ${(stats.size / (1024 * 1024)).toFixed(2)} MB (${stats.size} bytes)`);
console.log("==================================================================");
