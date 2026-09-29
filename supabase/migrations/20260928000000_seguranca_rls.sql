-- ==============================================================================
-- ENDURECIMENTO DE SEGURANÇA (RLS, VIEWS E PERMISSÕES)
-- Migração Oficial: 20260928000000_seguranca_rls.sql
--
-- Aplica Princípio do Menor Privilégio (Least Privilege):
-- 1. Protege a view public.pagamentos_pix contra bypass de RLS (security_invoker e revogação de SELECT público).
-- 2. Revoga acesso público direto às tabelas sensíveis (inscricoes, pagamentos, auditoria_transacoes).
-- 3. As APIs serverless (/api/admin, etc.) passam a ser o canal seguro com service_role.
-- 4. O navegador (chave anon) continua podendo realizar inscrições, ler subs, lotes e links públicos de WhatsApp.
-- ==============================================================================

-- 1. PROTEÇÃO CRÍTICA DA VIEW public.pagamentos_pix
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.views WHERE table_schema = 'public' AND table_name = 'pagamentos_pix') THEN
        -- Tenta aplicar security_invoker = true (compatível com PostgreSQL 15+)
        BEGIN
            EXECUTE 'ALTER VIEW public.pagamentos_pix SET (security_invoker = true)';
            RAISE NOTICE 'security_invoker = true aplicado com sucesso em public.pagamentos_pix';
        EXCEPTION WHEN OTHERS THEN
            RAISE NOTICE 'Aviso: security_invoker não suportado ou erro: %', SQLERRM;
        END;

        -- Revoga qualquer leitura pública ou anônima da view
        EXECUTE 'REVOKE ALL ON TABLE public.pagamentos_pix FROM PUBLIC, anon, authenticated';
        EXECUTE 'GRANT ALL ON TABLE public.pagamentos_pix TO service_role';
        RAISE NOTICE 'Privilégios da view public.pagamentos_pix restritos exclusivamente à service_role';
    END IF;
END $$;

-- 2. REMOVE POLÍTICAS PERMISSIVAS (USING/WITH CHECK true) DAS TABELAS SENSÍVEIS
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
      ('pagamentos_pix', 'Criação de pagamentos Pix'),
      ('pagamentos_pix', 'Leitura de pagamentos Pix'),
      ('pagamentos_pix', 'Atualização de pagamentos Pix'),
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
    IF to_regclass('public.' || item.tabela) IS NOT NULL THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', item.politica, item.tabela);
    END IF;
  END LOOP;
END $$;

-- 3. GARANTE RLS HABILITADO EM TODAS AS TABELAS SENSÍVEIS
DO $$
DECLARE
  tabela TEXT;
BEGIN
  FOREACH tabela IN ARRAY ARRAY[
    'inscricoes','pagamentos','auditoria_transacoes',
    'configuracoes_whatsapp','configuracoes_financeiras','lotes_inscricao',
    'historico_configuracoes_financeiras'
  ] LOOP
    IF to_regclass('public.' || tabela) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tabela);
    END IF;
  END LOOP;
END $$;

-- 4. DEFESA EM PROFUNDIDADE: REVOGA PRIVILÉGIOS PÚBLICOS E CONCEDE APENAS À SERVICE_ROLE
DO $$
DECLARE
  tabela TEXT;
BEGIN
  -- Tabelas totalmente privadas (apenas backend / service_role tem acesso)
  FOREACH tabela IN ARRAY ARRAY[
    'inscricoes','pagamentos','auditoria_transacoes',
    'historico_configuracoes_financeiras'
  ] LOOP
    IF to_regclass('public.' || tabela) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', tabela);
      EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', tabela);
    END IF;
  END LOOP;

  -- Tabelas públicas somente para leitura (dados institucionais não sensíveis)
  FOREACH tabela IN ARRAY ARRAY[
    'configuracoes_whatsapp','configuracoes_financeiras','lotes_inscricao'
  ] LOOP
    IF to_regclass('public.' || tabela) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', tabela);
      EXECUTE format('GRANT SELECT ON TABLE public.%I TO anon, authenticated', tabela);
      EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', tabela);
    END IF;
  END LOOP;
END $$;

-- 5. FUNÇÕES E RPCS SENSÍVEIS: APENAS SERVICE_ROLE PODE EXECUTAR
--    (Aprovar pagamentos, criar transações checkout, alterar preços/chaves)
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
  END LOOP;
END $$;

-- 6. STORAGE: O navegador pode enviar fotos e ler arquivos, mas NÃO pode apagar
DROP POLICY IF EXISTS "Remoção controlada de fotos" ON storage.objects;

-- 7. ATUALIZAÇÃO SEGURA DO E-MAIL DA INSCRIÇÃO VIA RPC
--    Permite associar o e-mail do participante utilizando o token secreto retornado na inscrição
CREATE OR REPLACE FUNCTION public.definir_email_inscricao(
    p_id UUID,
    p_token TEXT,
    p_email TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
