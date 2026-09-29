-- ==============================================================================
-- MIGRATION: 20260929030000_contagem_estrita_aprovados.sql
-- 1. Regra Oficial de Contagem: Apenas Inscrições com Pagamento Confirmado/Aprovado
-- 2. Resiliência de Leitura e Ativação da Configuração Financeira Ativa
-- ==============================================================================

-- 1. Garante que a última versão em configuracoes_financeiras esteja com ativo = true
UPDATE public.configuracoes_financeiras
SET ativo = true, atualizado_em = now()
WHERE id = (
    SELECT id FROM public.configuracoes_financeiras
    ORDER BY versao DESC
    LIMIT 1
);

-- 2. Atualiza RPC de contagem para contar EXCLUSIVAMENTE inscrições com pagamento confirmado/aprovado
CREATE OR REPLACE FUNCTION public.contagem_inscricoes_por_sub()
RETURNS TABLE(sub TEXT, total BIGINT) 
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT s.nome AS sub, COUNT(i.id)::BIGINT AS total
    FROM public.subs s
    LEFT JOIN public.inscricoes i ON i.sub = s.nome 
        AND i.arquivado = false 
        AND LOWER(TRIM(COALESCE(i.pagamento_status, ''))) IN ('approved', 'confirmado', 'pago')
    GROUP BY s.nome;
$$;

-- Permissões de execução para anon, authenticated e service_role
GRANT EXECUTE ON FUNCTION public.contagem_inscricoes_por_sub() TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.contagem_inscricoes_por_sub() IS 
'Fonte oficial de contagem de inscritos por Sub. Conta unicamente inscricoes com arquivado = false E pagamento confirmado/aprovado.';

-- 3. Atualiza RPC de leitura de configuração financeira ativa com fallback resiliente
CREATE OR REPLACE FUNCTION public.obter_configuracao_financeira_ativa()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_config RECORD;
BEGIN
    -- 1. Tenta buscar a versão explicitamente ativa
    SELECT * INTO v_config 
    FROM public.configuracoes_financeiras 
    WHERE ativo = true 
    ORDER BY versao DESC 
    LIMIT 1;

    -- 2. Se nenhuma estiver marcada como ativo = true, busca a mais recente cadastrada
    IF NOT FOUND THEN
        SELECT * INTO v_config 
        FROM public.configuracoes_financeiras 
        ORDER BY versao DESC 
        LIMIT 1;
    END IF;

    -- 3. Se tabela estiver vazia, retorna estrutura padrão
    IF NOT FOUND THEN
        RETURN json_build_object(
            'success', true,
            'configurado', false,
            'lote_atual', 'Aguardando Coordenação',
            'valor_inscricao', NULL,
            'valor_promocional', NULL,
            'taxa_adicional', 0.00,
            'max_parcelas', 12,
            'card_installment_mode', 'mercado_pago',
            'card_max_installments', 6,
            'card_installment_rates', '[]'::jsonb,
            'mp_public_key', 'APP_USR-39960bc1-2b08-4885-8090-31eaa38ba04b',
            'modalidade_pix', 'api_webhook',
            'pix_chave', NULL,
            'pix_tipo_chave', NULL,
            'pix_beneficiario', NULL,
            'pix_documento', NULL,
            'pix_cidade', NULL
        );
    END IF;

    RETURN json_build_object(
        'success', true,
        'id', v_config.id,
        'versao', v_config.versao,
        'configurado', COALESCE(v_config.configurado, (v_config.valor_inscricao IS NOT NULL AND v_config.valor_inscricao > 0)),
        'lote_atual', v_config.lote_atual,
        'valor_inscricao', v_config.valor_inscricao,
        'valor_promocional', v_config.valor_promocional,
        'taxa_adicional', v_config.taxa_adicional,
        'max_parcelas', v_config.max_parcelas,
        'card_installment_mode', COALESCE(v_config.card_installment_mode, 'mercado_pago'),
        'card_max_installments', COALESCE(v_config.card_max_installments, 6),
        'card_installment_rates', COALESCE(v_config.card_installment_rates, '[]'::jsonb),
        'mp_public_key', COALESCE(v_config.mp_public_key, 'APP_USR-39960bc1-2b08-4885-8090-31eaa38ba04b'),
        'modalidade_pix', COALESCE(v_config.modalidade_pix, 'api_webhook'),
        'pix_chave', v_config.pix_chave,
        'pix_tipo_chave', v_config.pix_tipo_chave,
        'pix_beneficiario', v_config.pix_beneficiario,
        'pix_documento', v_config.pix_documento,
        'pix_cidade', v_config.pix_cidade,
        'atualizado_em', v_config.atualizado_em,
        'atualizado_por', v_config.atualizado_por
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.obter_configuracao_financeira_ativa() TO anon, authenticated, service_role;

-- 4. Permissões de RLS para leitura pública garantida em configuracoes_financeiras
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies 
        WHERE schemaname = 'public' 
          AND tablename = 'configuracoes_financeiras' 
          AND policyname = 'Leitura pública irrestrita de configuracoes financeiras'
    ) THEN
        CREATE POLICY "Leitura pública irrestrita de configuracoes financeiras" 
        ON public.configuracoes_financeiras FOR SELECT TO anon, authenticated, service_role USING (true);
    END IF;
END $$;
