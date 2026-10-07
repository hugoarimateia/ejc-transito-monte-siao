const fs = require('fs');
const path = require('path');

async function generateFullBackup() {
  const url = 'https://guppedddwnuvluhiaaas.supabase.co';
  const key = 'sb_publishable_QJV9XI3sN3P_gVtiQ2ObRg_gpSSKc-i';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.resolve(__dirname, '../data/backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  const backupSqlFile = path.join(backupDir, `BACKUP_LOGICO_COMPLETO_${timestamp}.sql`);
  const backupJsonFile = path.join(backupDir, `BACKUP_LOGICO_COMPLETO_${timestamp}.json`);

  // 1. Fetch tables
  const tables = ['subs', 'configuracoes_financeiras', 'configuracoes_whatsapp', 'lotes_inscricao'];
  const tableData = {};
  for (const t of tables) {
    const res = await fetch(`${url}/rest/v1/${t}?select=*`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` }
    });
    if (res.ok) {
      tableData[t] = await res.json();
    } else {
      tableData[t] = { error: res.status, statusText: res.statusText };
    }
  }

  // 2. Fetch RPC contagem
  let rpcData = null;
  const resRpc = await fetch(`${url}/rest/v1/rpc/contagem_inscricoes_por_sub`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
  });
  if (resRpc.ok) rpcData = await resRpc.json();

  // 3. Storage buckets inventory
  const bucketInventory = [];
  for (const b of ['fotos', 'inscritos-fotos', 'comprovantes']) {
    const bRes = await fetch(`${url}/storage/v1/bucket/${b}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` }
    });
    bucketInventory.push({ name: b, exists: bRes.ok, status: bRes.status });
  }

  // 4. Read schema and migration definitions
  const schemaSql = fs.readFileSync(path.resolve(__dirname, '../supabase-schema.sql'), 'utf-8');
  const migrationSql = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260928000000_seguranca_rls.sql'), 'utf-8');

  // 5. Build full SQL dump
  let fullSql = '-- ==============================================================================\n';
  fullSql += '-- BACKUP LOGICO COMPLETO - EJC TRANSITO MONTE SIAO\n';
  fullSql += '-- Projeto: guppedddwnuvluhiaaas (https://guppedddwnuvluhiaaas.supabase.co)\n';
  fullSql += `-- Gerado em: ${new Date().toISOString()}\n`;
  fullSql += '-- Metodo: Exportacao de Schema DDL + Migrations RLS + DML Snapshot de Tabelas\n';
  fullSql += '-- ==============================================================================\n\n';

  fullSql += '-- ------------------------------------------------------------------------------\n';
  fullSql += '-- PARTE 1: DEFINICOES DDL DE TABELAS, RPCS, VIEWS E TRIGGERS\n';
  fullSql += '-- ------------------------------------------------------------------------------\n';
  fullSql += schemaSql + '\n\n';

  fullSql += '-- ------------------------------------------------------------------------------\n';
  fullSql += '-- PARTE 2: POLITICAS RLS E SEGURANCA\n';
  fullSql += '-- ------------------------------------------------------------------------------\n';
  fullSql += migrationSql + '\n\n';

  fullSql += '-- ------------------------------------------------------------------------------\n';
  fullSql += '-- PARTE 3: DADOS DE TABELAS REAIS (SNAPSHOT DML)\n';
  fullSql += '-- ------------------------------------------------------------------------------\n\n';

  for (const [table, rows] of Object.entries(tableData)) {
    if (Array.isArray(rows) && rows.length > 0) {
      fullSql += `-- Tabela: public.${table} (${rows.length} registros)\n`;
      for (const row of rows) {
        const columns = Object.keys(row);
        const values = columns.map(c => {
          const val = row[c];
          if (val === null || val === undefined) return 'NULL';
          if (typeof val === 'number' || typeof val === 'boolean') return String(val);
          if (typeof val === 'object') return `'${JSON.stringify(val).replace(/'/g, "''")}'::jsonb`;
          return `'${String(val).replace(/'/g, "''")}'`;
        });
        fullSql += `INSERT INTO public.${table} (${columns.join(', ')}) VALUES (${values.join(', ')}) ON CONFLICT DO NOTHING;\n`;
      }
      fullSql += '\n';
    }
  }

  fs.writeFileSync(backupSqlFile, fullSql, 'utf-8');

  // JSON companion
  const backupMeta = {
    nome_backup: path.basename(backupSqlFile),
    caminho: backupSqlFile,
    caminho_meta_json: backupJsonFile,
    data_hora: new Date().toISOString(),
    projeto_origem: 'guppedddwnuvluhiaaas',
    url_origem: url,
    metodo: 'DDL Schema + RLS Migrations + REST Snapshot Data DML',
    status_restauracao: 'BACKUP CRIADO — RESTAURAÇÃO NÃO VALIDADA',
    storage_buckets: bucketInventory,
    tabelas_exportadas: Object.keys(tableData).map(t => ({
      tabela: t,
      total_registros: Array.isArray(tableData[t]) ? tableData[t].length : 0
    })),
    rpc_contagem: rpcData,
    dados_tabelas: tableData
  };
  fs.writeFileSync(backupJsonFile, JSON.stringify(backupMeta, null, 2), 'utf-8');

  const statSql = fs.statSync(backupSqlFile);
  const statJson = fs.statSync(backupJsonFile);

  console.log('Backup SQL gerado:', backupSqlFile, `(${statSql.size} bytes)`);
  console.log('Backup JSON meta gerado:', backupJsonFile, `(${statJson.size} bytes)`);
  console.log('Tabelas exportadas:', JSON.stringify(backupMeta.tabelas_exportadas, null, 2));
}

generateFullBackup().catch(console.error);
