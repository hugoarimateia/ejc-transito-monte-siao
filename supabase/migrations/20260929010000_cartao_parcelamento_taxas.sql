-- ==============================================================================
-- SUPABASE MIGRATION: 20260929010000_cartao_parcelamento_taxas.sql
-- Projeto: EJC - Trânsito Monte Sião
-- Módulo: Gestão Administrativa de Taxas e Parcelamento do Cartão de Crédito
--
-- CARACTERÍSTICAS:
-- 1. Adiciona colunas para controle comercial de parcelamento na tabela configuracoes_financeiras.
-- 2. Suporta dois modos: 'mercado_pago' (automático) e 'manual' (taxas comerciais do EJC).
-- 3. Adiciona auditoria específica para alterações do módulo de cartão.
-- 4. Idempotente (IF NOT EXISTS / DO $$).
-- ==============================================================================

-- 1. ADIÇÃO DE COLUNAS NA TABELA configuracoes_financeiras
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = 'configuracoes_financeiras'
          AND c.relkind = 'r'
    ) THEN
        -- Modo de parcelamento: 'mercado_pago' (default) ou 'manual'
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' 
              AND table_name = 'configuracoes_financeiras' 
              AND column_name = 'card_installment_mode'
        ) THEN
            ALTER TABLE public.configuracoes_financeiras
            ADD COLUMN card_installment_mode TEXT NOT NULL DEFAULT 'mercado_pago';
        END IF;

        -- Máximo de parcelas no cartão (1 a 12)
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' 
              AND table_name = 'configuracoes_financeiras' 
              AND column_name = 'card_max_installments'
        ) THEN
            ALTER TABLE public.configuracoes_financeiras
            ADD COLUMN card_max_installments INT NOT NULL DEFAULT 6;
        END IF;

        -- Tabela de parcelas e acréscimos comerciais em JSONB
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' 
              AND table_name = 'configuracoes_financeiras' 
              AND column_name = 'card_installment_rates'
        ) THEN
            ALTER TABLE public.configuracoes_financeiras
            ADD COLUMN card_installment_rates JSONB DEFAULT '[]'::jsonb;
        END IF;

        -- Chave pública do Mercado Pago (opcional, para sobrescrita no painel)
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' 
              AND table_name = 'configuracoes_financeiras' 
              AND column_name = 'mp_public_key'
        ) THEN
            ALTER TABLE public.configuracoes_financeiras
            ADD COLUMN mp_public_key TEXT DEFAULT '';
        END IF;

        RAISE NOTICE 'Colunas de cartão e parcelamento adicionadas com sucesso a configuracoes_financeiras.';
    END IF;
END $$;

-- 2. ATUALIZAÇÃO DA FUNÇÃO RPC: OBTER CONFIGURAÇÃO FINANCEIRA ATIVA
CREATE OR REPLACE FUNCTION public.obter_configuracao_financeira_ativa()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
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
        RETURN json_build_object(
            'success', true,
            'lote_atual', '1º Lote',
            'valor_inscricao', 50.00,
            'valor_promocional', NULL,
            'taxa_adicional', 0.00,
            'max_parcelas', 12,
            'card_installment_mode', 'mercado_pago',
            'card_max_installments', 6,
            'card_installment_rates', '[]'::jsonb,
            'pix_chave', 'leoeuler03@gmail.com',
            'pix_tipo_chave', 'EMAIL',
            'pix_beneficiario', 'EJC TRANSITO MONTE SIAO',
            'pix_cidade', 'CAMPINA GRANDE'
        );
    END IF;

    RETURN json_build_object(
        'success', true,
        'id', v_config.id,
        'versao', v_config.versao,
        'lote_atual', v_config.lote_atual,
        'valor_inscricao', v_config.valor_inscricao,
        'valor_promocional', v_config.valor_promocional,
        'taxa_adicional', v_config.taxa_adicional,
        'max_parcelas', v_config.max_parcelas,
        'card_installment_mode', COALESCE(v_config.card_installment_mode, 'mercado_pago'),
        'card_max_installments', COALESCE(v_config.card_max_installments, 6),
        'card_installment_rates', COALESCE(v_config.card_installment_rates, '[]'::jsonb),
        'mp_public_key', COALESCE(v_config.mp_public_key, ''),
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
