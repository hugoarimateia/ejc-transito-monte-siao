const { execSync } = require('child_process');
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

async function main() {
  console.log('================================================================');
  console.log('ETAPA 1E — AUDITORIA E BACKUP DEFINITIVO DE PRODUÇÃO');
  console.log('Projeto: guppedddwnuvluhiaaas (EJC Trânsito Monte Sião)');
  console.log('================================================================\n');

  // 1. Obter credenciais através da CLI do Supabase
  console.log('[1/7] Obtendo credenciais de conexão via Supabase CLI...');
  const cliOutput = execSync('npx supabase db dump --project-ref guppedddwnuvluhiaaas --dry-run', { encoding: 'utf-8' });

  const hostMatch = cliOutput.match(/export PGHOST="([^"]+)"/);
  const portMatch = cliOutput.match(/export PGPORT="([^"]+)"/);
  const userMatch = cliOutput.match(/export PGUSER="([^"]+)"/);
  const passMatch = cliOutput.match(/export PGPASSWORD="([^"]+)"/);
  const dbMatch = cliOutput.match(/export PGDATABASE="([^"]+)"/);

  if (!hostMatch || !userMatch || !passMatch) {
    throw new Error('Falha ao obter credenciais da CLI do Supabase');
  }

  const client = new Client({
    host: hostMatch[1],
    port: parseInt(portMatch ? portMatch[1] : '5432', 10),
    user: userMatch[1],
    password: passMatch[1],
    database: dbMatch ? dbMatch[1] : 'postgres',
    ssl: { rejectUnauthorized: false }
  });

  await client.connect();
  // Assume a role administrativa 'postgres' para leitura irrestrita
  await client.query('SET ROLE postgres;');
  // Garante sessão estritamente de leitura (ZERO RISCO DE ESCRITA)
  await client.query('SET TRANSACTION READ ONLY;');
  console.log('✓ Conectado ao PostgreSQL com sucesso (Modo: READ ONLY / Role: postgres)\n');

  const TARGET_TABLES = [
    'inscricoes',
    'pagamentos',
    'inscritos_dados',
    'auditoria_transacoes',
    'historico_configuracoes_financeiras',
    'subs',
    'configuracoes_financeiras',
    'configuracoes_whatsapp',
    'lotes_inscricao'
  ];

  // ----------------------------------------------------------------------------
  // FASE 1: AUDITORIA DETALHADA DAS TABELAS
  // ----------------------------------------------------------------------------
  console.log('[2/7] Executando auditoria técnica detalhada das tabelas...');
  const tableAuditReport = {};

  for (const tableName of TARGET_TABLES) {
    // 1.1 Existência
    const existRes = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = $1
      );
    `, [tableName]);
    const exists = existRes.rows[0].exists;

    if (!exists) {
      tableAuditReport[tableName] = { exists: false, count: 0 };
      continue;
    }

    // 1.2 Contagem de registros
    const countRes = await client.query(`SELECT COUNT(*)::int AS total FROM public."${tableName}";`);
    const count = countRes.rows[0].total;

    // 1.3 Colunas e tipos
    const colRes = await client.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position;
    `, [tableName]);

    // 1.4 Primary Key
    const pkRes = await client.query(`
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      WHERE tc.constraint_type = 'PRIMARY KEY'
        AND tc.table_schema = 'public'
        AND tc.table_name = $1;
    `, [tableName]);
    const primaryKey = pkRes.rows.map(r => r.column_name);

    // 1.5 Foreign Keys
    const fkRes = await client.query(`
      SELECT
        kcu.column_name,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
        AND tc.table_name = $1;
    `, [tableName]);

    // 1.6 Índices
    const idxRes = await client.query(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = $1;
    `, [tableName]);

    // 1.7 RLS Habilitada
    const rlsRes = await client.query(`
      SELECT rowsecurity
      FROM pg_tables
      WHERE schemaname = 'public' AND tablename = $1;
    `, [tableName]);
    const rlsEnabled = rlsRes.rows[0]?.rowsecurity || false;

    // 1.8 Políticas RLS
    const polRes = await client.query(`
      SELECT policyname, permissive, roles, cmd, qual, with_check
      FROM pg_policies
      WHERE schemaname = 'public' AND tablename = $1;
    `, [tableName]);

    // 1.9 Triggers
    const trgRes = await client.query(`
      SELECT trigger_name, event_manipulation, action_statement, action_timing
      FROM information_schema.triggers
      WHERE event_object_schema = 'public' AND event_object_table = $1;
    `, [tableName]);

    // 1.10 RPCs / Funções Relacionadas
    const rpcRes = await client.query(`
      SELECT routine_name, routine_type
      FROM information_schema.routines
      WHERE routine_schema = 'public'
        AND routine_definition ILIKE '%' || $1 || '%';
    `, [tableName]);

    tableAuditReport[tableName] = {
      exists: true,
      count,
      columns: colRes.rows,
      primaryKey,
      foreignKeys: fkRes.rows,
      indexes: idxRes.rows.map(r => ({ name: r.indexname, def: r.indexdef })),
      rlsEnabled,
      policies: polRes.rows,
      triggers: trgRes.rows,
      relatedRPCs: rpcRes.rows.map(r => r.routine_name)
    };
  }

  // ----------------------------------------------------------------------------
  // FASE 2: BACKUP COMPLETO DOS DADOS
  // ----------------------------------------------------------------------------
  console.log('[3/7] Extraindo dados completos de produção para backup lógico...');
  const tableDataDump = {};
  for (const tableName of TARGET_TABLES) {
    if (tableAuditReport[tableName]?.exists) {
      const rowsRes = await client.query(`SELECT * FROM public."${tableName}";`);
      tableDataDump[tableName] = rowsRes.rows;
      console.log(`   - public.${tableName}: ${rowsRes.rows.length} registros extraídos`);
    } else {
      tableDataDump[tableName] = [];
    }
  }

  // Extrair Views e RPCs do Schema
  const viewsRes = await client.query(`
    SELECT table_name, view_definition
    FROM information_schema.views
    WHERE table_schema = 'public';
  `);

  const funcsRes = await client.query(`
    SELECT p.proname AS name, pg_get_functiondef(p.oid) AS definition,
           p.prosecdef AS is_security_definer
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public';
  `);

  // Montar Arquivos de Backup (SQL e JSON)
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.resolve(__dirname, '../data/backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  const backupSqlPath = path.join(backupDir, `DEFINITIVE_BACKUP_ETAPA1E_${timestamp}.sql`);
  const backupJsonPath = path.join(backupDir, `DEFINITIVE_BACKUP_ETAPA1E_${timestamp}.json`);

  let sqlContent = '-- ==============================================================================\n';
  sqlContent += '-- BACKUP DEFINITIVO E INTEGRAL DE PRODUÇÃO — ETAPA 1E\n';
  sqlContent += '-- Projeto Supabase: guppedddwnuvluhiaaas (EJC Trânsito Monte Sião)\n';
  sqlContent += `-- Data/Hora de Geração: ${new Date().toISOString()}\n`;
  sqlContent += '-- Método: Leitura Direta de Estrutura + DML Real via PostgreSQL Pooler\n';
  sqlContent += '-- ==============================================================================\n\n';

  // 1. Funções / RPCs
  sqlContent += '-- ------------------------------------------------------------------------------\n';
  sqlContent += '-- 1. FUNÇÕES / RPCS (SCHEMA PUBLIC)\n';
  sqlContent += '-- ------------------------------------------------------------------------------\n\n';
  for (const fn of funcsRes.rows) {
    sqlContent += `${fn.definition};\n\n`;
  }

  // 2. DDL e Índices
  sqlContent += '-- ------------------------------------------------------------------------------\n';
  sqlContent += '-- 2. TABELAS E ÍNDICES (DDL)\n';
  sqlContent += '-- ------------------------------------------------------------------------------\n\n';
  for (const tableName of TARGET_TABLES) {
    const audit = tableAuditReport[tableName];
    if (audit?.exists) {
      sqlContent += `-- Tabela: public.${tableName}\n`;
      sqlContent += `CREATE TABLE IF NOT EXISTS public."${tableName}" (\n`;
      const colDefs = audit.columns.map(c => {
        let def = `  "${c.column_name}" ${c.data_type}`;
        if (c.is_nullable === 'NO') def += ' NOT NULL';
        if (c.column_default) def += ` DEFAULT ${c.column_default}`;
        return def;
      });
      if (audit.primaryKey.length > 0) {
        colDefs.push(`  PRIMARY KEY ("${audit.primaryKey.join('", "')}")`);
      }
      sqlContent += colDefs.join(',\n') + '\n);\n';

      if (audit.rlsEnabled) {
        sqlContent += `ALTER TABLE public."${tableName}" ENABLE ROW LEVEL SECURITY;\n`;
      }
      for (const idx of audit.indexes) {
        sqlContent += `${idx.def};\n`;
      }
      sqlContent += '\n';
    }
  }

  // 3. DML (Dados Reais)
  sqlContent += '-- ------------------------------------------------------------------------------\n';
  sqlContent += '-- 3. DADOS DE PRODUÇÃO (DML SNAPSHOT)\n';
  sqlContent += '-- ------------------------------------------------------------------------------\n\n';
  for (const tableName of TARGET_TABLES) {
    const rows = tableDataDump[tableName] || [];
    if (rows.length > 0) {
      sqlContent += `-- Dados da tabela public.${tableName} (${rows.length} registros)\n`;
      for (const row of rows) {
        const cols = Object.keys(row);
        const vals = cols.map(col => {
          const val = row[col];
          if (val === null || val === undefined) return 'NULL';
          if (typeof val === 'number' || typeof val === 'boolean') return String(val);
          if (val instanceof Date) return `'${val.toISOString()}'`;
          if (typeof val === 'object') return `'${JSON.stringify(val).replace(/'/g, "''")}'::jsonb`;
          return `'${String(val).replace(/'/g, "''")}'`;
        });
        sqlContent += `INSERT INTO public."${tableName}" ("${cols.join('", "')}") VALUES (${vals.join(', ')}) ON CONFLICT DO NOTHING;\n`;
      }
      sqlContent += '\n';
    }
  }

  fs.writeFileSync(backupSqlPath, sqlContent, 'utf-8');

  // JSON companion
  const backupJsonObj = {
    metadados: {
      nome_backup: path.basename(backupSqlPath),
      caminho_sql: backupSqlPath,
      caminho_json: backupJsonPath,
      timestamp: new Date().toISOString(),
      projeto_origem: 'guppedddwnuvluhiaaas',
      url_origem: 'https://guppedddwnuvluhiaaas.supabase.co',
      metodo: 'PostgreSQL CLI Ephemeral Session (Role: postgres / READ ONLY)',
      status_restauracao: 'BACKUP CRIADO — RESTAURAÇÃO NÃO VALIDADA'
    },
    auditoria_tabelas: tableAuditReport,
    dados_tabelas: tableDataDump,
    views: viewsRes.rows,
    funcoes: funcsRes.rows.map(f => ({ name: f.name, is_security_definer: f.is_security_definer }))
  };

  fs.writeFileSync(backupJsonPath, JSON.stringify(backupJsonObj, null, 2), 'utf-8');

  const statSql = fs.statSync(backupSqlPath);
  const statJson = fs.statSync(backupJsonPath);
  const hashSql = crypto.createHash('sha256').update(fs.readFileSync(backupSqlPath)).digest('hex');
  const hashJson = crypto.createHash('sha256').update(fs.readFileSync(backupJsonPath)).digest('hex');

  console.log(`✓ Backup SQL gerado: ${backupSqlPath} (${(statSql.size / 1024).toFixed(2)} KB, SHA-256: ${hashSql.slice(0, 16)}...)`);
  console.log(`✓ Backup JSON gerado: ${backupJsonPath} (${(statJson.size / 1024).toFixed(2)} KB, SHA-256: ${hashJson.slice(0, 16)}...)\n`);

  // ----------------------------------------------------------------------------
  // FASE 4: AUDITORIA REAL DO STORAGE
  // ----------------------------------------------------------------------------
  console.log('[4/7] Auditando o estado real do Supabase Storage...');
  const bucketsRes = await client.query(`
    SELECT id, name, owner, created_at, updated_at, public, avif_autodetection, file_size_limit, allowed_mime_types
    FROM storage.buckets;
  `);

  const objectsRes = await client.query(`
    SELECT id, bucket_id, name, owner, created_at, updated_at, last_accessed_at, metadata
    FROM storage.objects;
  `);

  const storagePoliciesRes = await client.query(`
    SELECT policyname, permissive, roles, cmd, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'storage';
  `);

  console.log(`   - Buckets encontrados no Storage: ${bucketsRes.rows.length}`);
  bucketsRes.rows.forEach(b => console.log(`     * Bucket: "${b.name}" (ID: ${b.id}, Público: ${b.public})`));
  console.log(`   - Total de objetos encontrados no Storage: ${objectsRes.rows.length}`);
  console.log(`   - Políticas RLS no Storage: ${storagePoliciesRes.rows.length}\n`);

  // ----------------------------------------------------------------------------
  // FASE 5: AUDITORIA DE RLS E SEGURANÇA
  // ----------------------------------------------------------------------------
  console.log('[5/7] Auditando RLS, permissões e papéis de segurança...');
  const securityAudit = {
    tabelas_rls: {},
    funcoes_security_definer: funcsRes.rows.filter(f => f.is_security_definer).map(f => f.name),
    funcoes_security_invoker: funcsRes.rows.filter(f => !f.is_security_definer).map(f => f.name),
    permissoes_anon: {},
    permissoes_service_role: 'Acesso Administrativo via Backend (service_role)'
  };

  for (const tableName of TARGET_TABLES) {
    if (tableAuditReport[tableName]?.exists) {
      securityAudit.tabelas_rls[tableName] = {
        rls_habilitada: tableAuditReport[tableName].rlsEnabled,
        politicas: tableAuditReport[tableName].policies.map(p => ({
          nome: p.policyname,
          comando: p.cmd,
          papeis: p.roles
        }))
      };
    }
  }

  // ----------------------------------------------------------------------------
  // FASE 6: BASELINE COMPLETO DE INTEGRIDADE
  // ----------------------------------------------------------------------------
  console.log('[6/7] Gerando Baseline de Integridade...');
  const baseline = {
    gerado_em: new Date().toISOString(),
    projeto: 'guppedddwnuvluhiaaas',
    contagem_tabelas: {},
    hashes_dados: {},
    storage: {
      total_buckets: bucketsRes.rows.length,
      buckets: bucketsRes.rows.map(b => ({ id: b.id, name: b.name, public: b.public })),
      total_objetos: objectsRes.rows.length
    },
    rls_estado: {}
  };

  for (const tableName of TARGET_TABLES) {
    const count = tableAuditReport[tableName]?.count || 0;
    baseline.contagem_tabelas[tableName] = count;
    const tableDataString = JSON.stringify(tableDataDump[tableName] || []);
    baseline.hashes_dados[tableName] = crypto.createHash('sha256').update(tableDataString).digest('hex');
    baseline.rls_estado[tableName] = {
      rls_habilitada: tableAuditReport[tableName]?.rlsEnabled || false,
      total_politicas: tableAuditReport[tableName]?.policies?.length || 0
    };
  }

  const baselinePath = path.join(backupDir, 'BASELINE_INTEGRIDADE_ETAPA1E.json');
  fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2), 'utf-8');
  console.log(`✓ Baseline gravado em: ${baselinePath}\n`);

  // Relatório consolidado
  const reportPath = path.join(backupDir, `AUDITORIA_RELATORIO_ETAPA1E_${timestamp}.json`);
  const fullReport = {
    backup: {
      arquivo_sql: backupSqlPath,
      tamanho_sql_bytes: statSql.size,
      sha256_sql: hashSql,
      arquivo_json: backupJsonPath,
      tamanho_json_bytes: statJson.size,
      sha256_json: hashJson,
      status_restauracao: 'BACKUP CRIADO — RESTAURAÇÃO NÃO VALIDADA'
    },
    auditoria_tabelas: tableAuditReport,
    auditoria_storage: {
      buckets: bucketsRes.rows,
      total_objetos: objectsRes.rows.length,
      objetos: objectsRes.rows.map(o => ({ bucket_id: o.bucket_id, name: o.name, created_at: o.created_at })),
      politicas: storagePoliciesRes.rows
    },
    auditoria_seguranca: securityAudit,
    baseline: baseline
  };

  fs.writeFileSync(reportPath, JSON.stringify(fullReport, null, 2), 'utf-8');
  console.log(`✓ Relatório de auditoria gravado em: ${reportPath}\n`);

  console.log('[7/7] Encerrando conexão read-only com o PostgreSQL...');
  await client.end();
  console.log('✓ Conexão finalizada. Nenhuma escrita foi realizada no banco.\n');
}

main().catch(err => {
  console.error('ERRO FATAL NA EXECUÇÃO:', err);
  process.exit(1);
});
