-- ==============================================================================
-- MIGRATION: 20260929040000_capacidade_70_e_correcoes.sql
-- EJC - Equipe do Trânsito / IEAD Monte Sião
-- 1. Atualização da Capacidade das Subs para 70 Pessoas
-- 2. Correção da RPC realizar_inscricao_com_link (gen_random_bytes e busca de vagas)
-- 3. Resiliência de colunas em configuracoes_financeiras e obter_configuracao_financeira_ativa
-- ==============================================================================

-- 1. CAPACIDADE DAS SUBS = 70 PESSOAS
UPDATE public.subs 
SET capacidade = 70 
WHERE nome IN ('Verde', 'Vermelho', 'Amarelo', 'Laranja');

ALTER TABLE public.subs 
ALTER COLUMN capacidade SET DEFAULT 70;

-- 2. ADIÇÃO DE COLUNAS RESILIENTES NA TABELA configuracoes_financeiras
ALTER TABLE public.configuracoes_financeiras 
ADD COLUMN IF NOT EXISTS modalidade_pix VARCHAR(50) DEFAULT 'api_webhook';

ALTER TABLE public.configuracoes_financeiras 
ADD COLUMN IF NOT EXISTS pix_instrucoes_manual TEXT DEFAULT 'Faça o Pix para a chave oficial cadastrada pela coordenação.';

ALTER TABLE public.configuracoes_financeiras 
ADD COLUMN IF NOT EXISTS pix_permite_comprovante BOOLEAN DEFAULT true;

-- 3. ATUALIZAÇÃO DA RPC realizar_inscricao_com_link COM EXTENSIONS SEARCH_PATH E CONTAGEM ESTRITA
CREATE OR REPLACE FUNCTION public.realizar_inscricao_com_link(
    p_nome_completo TEXT,
    p_sub TEXT,
    p_whatsapp TEXT,
    p_modelo_camisa TEXT,
    p_tamanho_camisa TEXT,
    p_quer_camisa_adicional BOOLEAN,
    p_quantidade_camisas_adicionais INT,
    p_modelo_camisa_adicional TEXT,
    p_tamanho_camisa_adicional TEXT,
    p_talento TEXT,
    p_foto_caminho TEXT,
    p_comprovante_caminho TEXT,
    p_forma_pagamento TEXT,
    p_pagamento_informado BOOLEAN,
    p_pagamento_status TEXT,
    p_justificativa_pagamento TEXT,
    p_observacao_pagamento TEXT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_token TEXT;
    v_inscricao_id UUID;
    v_total_sub INT;
    v_capacidade INT;
BEGIN
    -- 1. Checa limite de vagas com bloqueio de linha: conta APENAS inscrições com pagamento confirmado
    SELECT capacidade INTO v_capacidade FROM public.subs WHERE nome = p_sub FOR SHARE;
    IF v_capacidade IS NULL THEN
        v_capacidade := 70;
    END IF;

    SELECT COUNT(*) INTO v_total_sub 
    FROM public.inscricoes 
    WHERE sub = p_sub 
      AND arquivado = false 
      AND LOWER(TRIM(COALESCE(pagamento_status, ''))) IN ('approved', 'confirmado', 'pago');
    
    IF v_total_sub >= v_capacidade THEN
        RAISE EXCEPTION 'limite de vagas atingido para este Sub (70 vagas preenchidas)';
    END IF;

    -- 2. Geração de token criptográfico com fallback resiliente
    BEGIN
        v_token := encode(extensions.gen_random_bytes(24), 'hex');
    EXCEPTION WHEN OTHERS THEN
        v_token := md5(random()::text || clock_timestamp()::text) || md5(random()::text);
    END;

    -- 3. Insere a inscrição
    INSERT INTO public.inscricoes (
        nome_completo, sub, whatsapp, modelo_camisa, tamanho_camisa,
        quer_camisa_adicional, quantidade_camisas_adicionais,
        modelo_camisa_adicional, tamanho_camisa_adicional,
        talento, foto_caminho, comprovante_caminho,
        forma_pagamento, pagamento_informado, pagamento_status,
        justificativa_pagamento, observacao_pagamento, token_acesso
    ) VALUES (
        p_nome_completo, p_sub, p_whatsapp, p_modelo_camisa, p_tamanho_camisa,
        p_quer_camisa_adicional, p_quantidade_camisas_adicionais,
        p_modelo_camisa_adicional, p_tamanho_camisa_adicional,
        p_talento, p_foto_caminho, p_comprovante_caminho,
        p_forma_pagamento, p_pagamento_informado, p_pagamento_status,
        p_justificativa_pagamento, p_observacao_pagamento, v_token
    ) RETURNING id INTO v_inscricao_id;

    RETURN json_build_object(
        'success', true,
        'id', v_inscricao_id,
        'token', v_token,
        'sub', p_sub
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.realizar_inscricao_com_link(TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, INT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, TEXT, TEXT) TO anon, authenticated, service_role;

-- 4. ATUALIZAÇÃO DA RPC obter_configuracao_financeira_ativa
CREATE OR REPLACE FUNCTION public.obter_configuracao_financeira_ativa()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_config RECORD;
BEGIN
    SELECT * INTO v_config 
    FROM public.configuracoes_financeiras 
    WHERE ativo = true 
    ORDER BY versao DESC 
    LIMIT 1;

    IF NOT FOUND THEN
        SELECT * INTO v_config 
        FROM public.configuracoes_financeiras 
        ORDER BY versao DESC 
        LIMIT 1;
    END IF;

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
        'modalidade_pix', 'api_webhook',
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

-- 5. ATIVAÇÃO DA VERSÃO MAIS RECENTE DE CONFIGURAÇÕES FINANCEIRAS
UPDATE public.configuracoes_financeiras
SET ativo = true, atualizado_em = now()
WHERE id = (
    SELECT id FROM public.configuracoes_financeiras
    ORDER BY versao DESC
    LIMIT 1
);
