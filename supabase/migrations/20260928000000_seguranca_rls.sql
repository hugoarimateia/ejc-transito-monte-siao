-- ==============================================================================
-- ENDURECIMENTO DE SEGURANÇA DEFINITIVO (RLS, VIEWS E PERMISSÕES)
-- Migração Oficial: 20260928000000_seguranca_rls.sql
-- Projeto: EJC - Trânsito Monte Sião
--
-- AUDITORIA DE OBJETOS:
-- 1. public.pagamentos_pix é uma VIEW (relkind = 'v') criada como camada de compatibilidade
--    retroativa sobre a tabela subjacente public.pagamentos (relkind = 'r').
-- 2. No PostgreSQL, VIEWs NÃO possuem armazenamento físico e NÃO suportam
--    ALTER TABLE ... ENABLE ROW LEVEL SECURITY nem comandos CREATE/DROP POLICY.
--    Tentar executar RLS em uma VIEW gera o erro 42809.
-- 3. A proteção da VIEW é feita via 'security_invoker = true' (PostgreSQL 15+)
--    e revogação estrita de privilégios de acesso de 'PUBLIC', 'anon' e 'authenticated'.
-- 4. O RLS é aplicado ESTRITAMENTE nas tabelas físicas base (relkind = 'r').
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. PROTEÇÃO CIRÚRGICA DA VIEW public.pagamentos_pix (relkind = 'v')
-- ------------------------------------------------------------------------------
DO $$
BEGIN
  -- Verifica se o objeto existe E é comprovadamente uma VIEW
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'pagamentos_pix'
      AND c.relkind = 'v'
  ) THEN
    -- No PostgreSQL 15+, security_invoker = true força a view a respeitar
    -- as permissões e RLS da tabela subjacente (public.pagamentos)
    BEGIN
      EXECUTE 'ALTER VIEW public.pagamentos_pix SET (security_invoker = true)';
      RAISE NOTICE 'security_invoker = true configurado na view public.pagamentos_pix';
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Aviso ao aplicar security_invoker em public.pagamentos_pix: %', SQLERRM;
    END;

    -- Revoga privilégios públicos e anônimos da VIEW
    EXECUTE 'REVOKE ALL ON TABLE public.pagamentos_pix FROM PUBLIC, anon, authenticated';
    EXECUTE 'GRANT ALL ON TABLE public.pagamentos_pix TO service_role';
    RAISE NOTICE 'Privilégios da view public.pagamentos_pix restritos exclusivamente à service_role';
  END IF;
END $$;

-- ------------------------------------------------------------------------------
-- 2. REMOÇÃO IDEMPOTENTE DE POLÍTICAS PERMISSIVAS EM TABELAS
--    (Consulta estritamente pg_policies, impedindo comandos inválidos em VIEWs)
-- ------------------------------------------------------------------------------
DO $$
DECLARE
  item RECORD;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      ('inscricoes', 'Inserção pública de inscrições'),
      ('inscricoes', 'Leitura de inscrição via token'),
      ('inscricoes', 'Atualização controlada de inscrições'),
      ('inscricoes', 'Inscrições são públicas para leitura'),
      ('inscricoes', 'Inserção de inscrições'),
      ('inscricoes', 'Atualização de inscrições'),
      ('pagamentos', 'Inserção pública de pagamentos'),
      ('pagamentos', 'Leitura pública de pagamentos por txid'),
      ('pagamentos', 'Atualização pública de pagamentos'),
      ('pagamentos', 'Pagamentos são públicos para leitura'),
      ('pagamentos', 'Inserção de pagamentos'),
      ('pagamentos', 'Atualização de pagamentos'),
      ('auditoria_transacoes', 'Inserção de auditoria'),
      ('auditoria_transacoes', 'Leitura de auditoria'),
      ('auditoria_transacoes', 'Auditoria é pública para leitura'),
      ('configuracoes_whatsapp', 'Atualização de links whatsapp'),
      ('configuracoes_whatsapp', 'Inserção de links whatsapp'),
      ('configuracoes_financeiras', 'Modificacao administrativa de configuracoes financeiras'),
      ('lotes_inscricao', 'Modificacao de lotes'),
      ('historico_configuracoes_financeiras', 'Insercao de historico de auditoria financeira'),
      ('historico_configuracoes_financeiras', 'Leitura de historico de auditoria financeira')
    ) AS t(tabela, politica)
  LOOP
    -- Dropar apenas se a política realmente existir em uma TABELA no catálogo pg_policies
    IF EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = item.tabela
        AND policyname = item.politica
    ) THEN
      EXECUTE format('DROP POLICY %I ON public.%I', item.politica, item.tabela);
      RAISE NOTICE 'Política % removida da tabela public.%', item.politica, item.tabela;
    END IF;
  END LOOP;
END $$;

-- ------------------------------------------------------------------------------
-- 3. HABILITAÇÃO DE RLS ESTRITAMENTE EM TABELAS FÍSICAS (c.relkind = 'r')
--    NUNCA executa ALTER TABLE ... ENABLE ROW LEVEL SECURITY em VIEWs (relkind = 'v')
-- ------------------------------------------------------------------------------
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.relname AS tabela
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r' -- Estritamente tabela física comum (exclui views 'v', materialized views 'm', foreign 'f')
      AND c.relname IN (
        'inscricoes', 'pagamentos', 'auditoria_transacoes',
        'configuracoes_whatsapp', 'configuracoes_financeiras', 'lotes_inscricao',
        'historico_configuracoes_financeiras', 'subs'
      )
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.tabela);
    RAISE NOTICE 'Row Level Security (RLS) habilitado com sucesso na tabela física: public.%', r.tabela;
  END LOOP;
END $$;

-- ------------------------------------------------------------------------------
-- 4. PRINCÍPIO DO MENOR PRIVILÉGIO (LEAST PRIVILEGE) NAS TABELAS
-- ------------------------------------------------------------------------------
DO $$
DECLARE
  tabela TEXT;
BEGIN
  -- A. Tabelas Privadas (Dados Pessoais e Transações Financeiras)
  -- Somente o backend (service_role) tem acesso direto a essas tabelas.
  FOREACH tabela IN ARRAY ARRAY[
    'inscricoes', 'pagamentos', 'auditoria_transacoes',
    'historico_configuracoes_financeiras'
  ] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = tabela AND c.relkind = 'r'
    ) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', tabela);
      EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', tabela);
      RAISE NOTICE 'Tabela privada restrita à service_role: public.%', tabela;
    END IF;
  END LOOP;

  -- B. Tabelas Institucionais / Públicas (Apenas Leitura para anon e authenticated)
  FOREACH tabela IN ARRAY ARRAY[
    'configuracoes_whatsapp', 'configuracoes_financeiras', 'lotes_inscricao', 'subs'
  ] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = tabela AND c.relkind = 'r'
    ) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', tabela);
      EXECUTE format('GRANT SELECT ON TABLE public.%I TO anon, authenticated', tabela);
      EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', tabela);

      -- Política de SELECT idempotente para navegação pública
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = tabela AND policyname = 'Leitura pública permitida'
      ) THEN
        EXECUTE format('CREATE POLICY "Leitura pública permitida" ON public.%I FOR SELECT USING (true)', tabela);
      END IF;
      RAISE NOTICE 'Tabela pública configurada para leitura controlada: public.%', tabela;
    END IF;
  END LOOP;
END $$;

-- ------------------------------------------------------------------------------
-- 5. FUNÇÕES E RPCS SENSÍVEIS: APENAS SERVICE_ROLE PODE EXECUTAR
--    (Aprovar pagamentos, registrar Pix, criar transações, alterar configurações financeiras)
-- ------------------------------------------------------------------------------
DO $$
DECLARE
  fn RECORD;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS assinatura
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'confirmar_pagamento_unificado', 'confirmar_pagamento_pix',
        'criar_transacao_checkout', 'registrar_pagamento_pix',
        'consultar_status_pix', 'atualizar_configuracao_financeira'
      )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn.assinatura);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn.assinatura);
    RAISE NOTICE 'Função sensível restrita à service_role: %', fn.assinatura;
  END LOOP;
END $$;

-- ------------------------------------------------------------------------------
-- 6. CORREÇÃO DE SEGURANÇA: SEARCH_PATH IMUTÁVEL EM TODAS AS FUNÇÕES SECURITY DEFINER
--    (Elimina o alerta "Function Search Path Mutable" no Supabase Advisor)
-- ------------------------------------------------------------------------------
DO $$
DECLARE
  fn RECORD;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS assinatura
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef = true
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', fn.assinatura);
    RAISE NOTICE 'search_path imutável fixado na função: %', fn.assinatura;
  END LOOP;
END $$;

-- ------------------------------------------------------------------------------
-- 7. STORAGE: NAVEGADOR ENVIA E LÊ FOTOS, MAS NÃO PODE DELETAR
-- ------------------------------------------------------------------------------
DROP POLICY IF EXISTS "Remoção controlada de fotos" ON storage.objects;

-- ------------------------------------------------------------------------------
-- 8. ATUALIZAÇÃO SEGURA DO E-MAIL DA INSCRIÇÃO VIA RPC
--    Permite associar o e-mail do participante utilizando o token secreto retornado na inscrição
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.definir_email_inscricao(
    p_id UUID,
    p_token TEXT,
    p_email TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_linhas INT;
BEGIN
    IF p_email IS NULL OR p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
        RETURN FALSE;
    END IF;

    UPDATE public.inscricoes
       SET email = lower(trim(p_email))
     WHERE id = p_id
       AND token_acesso = p_token;

    GET DIAGNOSTICS v_linhas = ROW_COUNT;
    RETURN v_linhas > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.definir_email_inscricao(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.definir_email_inscricao(UUID, TEXT, TEXT) TO anon, authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 9. AUDITORIA E SANEAMENTO DE ÍNDICES DUPLICADOS EM public.pagamentos
--    Causa raiz: quando a tabela pagamentos_pix foi renomeada para pagamentos em migrações anteriores,
--    os índices antigos idx_pagamentos_pix_txid e idx_pagamentos_pix_status permaneceram vinculados.
--    Posteriormente, foram criados idx_pagamentos_txid e idx_pagamentos_status, gerando alertas no Supabase.
--    Aqui removemos os índices legados redundantes APENAS se os índices modernos já existirem.
-- ------------------------------------------------------------------------------
DO $$
BEGIN
  -- Se ambos os índices existirem para txid, remove com segurança o índice legado redundante
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'pagamentos' AND indexname = 'idx_pagamentos_pix_txid')
     AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'pagamentos' AND indexname = 'idx_pagamentos_txid') THEN
    DROP INDEX IF EXISTS public.idx_pagamentos_pix_txid;
    RAISE NOTICE 'Índice legado duplicado idx_pagamentos_pix_txid removido com sucesso (mantido idx_pagamentos_txid)';
  END IF;

  -- Se ambos os índices existirem para status, remove com segurança o índice legado redundante
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'pagamentos' AND indexname = 'idx_pagamentos_pix_status')
     AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'pagamentos' AND indexname = 'idx_pagamentos_status') THEN
    DROP INDEX IF EXISTS public.idx_pagamentos_pix_status;
    RAISE NOTICE 'Índice legado duplicado idx_pagamentos_pix_status removido com sucesso (mantido idx_pagamentos_status)';
  END IF;
END $$;
