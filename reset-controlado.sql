-- ==============================================================================
-- EJC - TRÂNSITO MONTE SIÃO - RESET CONTROLADO DO ESTADO DE NEGÓCIO
-- Arquivo: reset-controlado.sql
-- Execute este script no SQL Editor do painel Supabase (https://supabase.com/dashboard)
-- ==============================================================================

-- 1. ADICIONA CAMPOS DE ARQUIVAMENTO EM INSCRIÇÕES (PRESERVA INTEGRIDADE REFERENCIAL DE PAGAMENTOS)
ALTER TABLE public.inscricoes ADD COLUMN IF NOT EXISTS arquivado BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.inscricoes ADD COLUMN IF NOT EXISTS arquivado_em TIMESTAMPTZ;
ALTER TABLE public.inscricoes ADD COLUMN IF NOT EXISTS motivo_arquivamento TEXT;

-- 2. ARQUIVA TODAS AS INSCRIÇÕES ATUAIS (INSCRITOS ATIVOS = 0)
-- Preserva os 8 pagamentos existentes e seu histórico financeiro intactos
UPDATE public.inscricoes 
SET arquivado = true,
    arquivado_em = now(),
    motivo_arquivamento = 'Reset controlado de transição para produção'
WHERE arquivado = false;

-- 3. ATUALIZA FUNÇÃO RPC DE CONTAGEM PARA IGNORAR REGISTROS ARQUIVADOS
CREATE OR REPLACE FUNCTION public.contagem_inscricoes_por_sub()
RETURNS TABLE(sub TEXT, total BIGINT) 
LANGUAGE sql
SECURITY DEFINER
AS $$
    SELECT s.nome AS sub, COUNT(i.id)::BIGINT AS total
    FROM public.subs s
    LEFT JOIN public.inscricoes i ON i.sub = s.nome AND i.arquivado = false
    GROUP BY s.nome;
$$;

-- 4. LIMPA SUB LEGADA 'AZUL' (0 INSCRIÇÕES ATIVAS)
DELETE FROM public.subs WHERE nome = 'Azul';

-- 5. RESET DAS CONFIGURAÇÕES FINANCEIRAS (REMOVE PREÇO PADRÃO R$ 50)
-- Altera colunas para permitir NULL (estado NOT_CONFIGURED)
ALTER TABLE public.configuracoes_financeiras ALTER COLUMN valor_inscricao DROP NOT NULL;
ALTER TABLE public.configuracoes_financeiras ALTER COLUMN valor_inscricao DROP DEFAULT;
ALTER TABLE public.configuracoes_financeiras ALTER COLUMN pix_chave DROP NOT NULL;
ALTER TABLE public.configuracoes_financeiras ALTER COLUMN pix_chave DROP DEFAULT;
ALTER TABLE public.configuracoes_financeiras ALTER COLUMN pix_tipo_chave DROP DEFAULT;
ALTER TABLE public.configuracoes_financeiras ALTER COLUMN pix_beneficiario DROP DEFAULT;
ALTER TABLE public.configuracoes_financeiras ALTER COLUMN pix_cidade DROP DEFAULT;
ALTER TABLE public.configuracoes_financeiras ADD COLUMN IF NOT EXISTS configurado BOOLEAN NOT NULL DEFAULT false;

-- Desativa versões anteriores com preço 50
UPDATE public.configuracoes_financeiras SET ativo = false WHERE ativo = true;

-- Insere o registro ativo no estado NOT_CONFIGURED (aguardando definição do Admin)
INSERT INTO public.configuracoes_financeiras (
    versao,
    ativo,
    configurado,
    lote_atual,
    valor_inscricao,
    valor_promocional,
    taxa_adicional,
    max_parcelas,
    pix_chave,
    pix_tipo_chave,
    pix_beneficiario,
    pix_cidade,
    motivo_alteracao,
    atualizado_por
)
SELECT 
    COALESCE(MAX(versao), 0) + 1,
    true,
    false,
    'Aguardando Coordenação',
    NULL,
    NULL,
    0.00,
    12,
    NULL,
    NULL,
    NULL,
    NULL,
    'Reset controlado - Aguardando configuração pelo Administrador',
    'reset_controlado'
FROM public.configuracoes_financeiras;

-- 6. ATUALIZA RPC DE LEITURA FINANCEIRA PARA RETORNAR ESTADO NÃO CONFIGURADO
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
            'configurado', false,
            'lote_atual', 'Aguardando Coordenação',
            'valor_inscricao', NULL,
            'valor_promocional', NULL,
            'taxa_adicional', 0.00,
            'max_parcelas', 12,
            'pix_chave', NULL,
            'pix_tipo_chave', NULL,
            'pix_beneficiario', NULL,
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

-- 7. ATUALIZA RPC DE GRAVAÇÃO FINANCEIRA PARA ATIVAR O ESTADO CONFIGURADO
CREATE OR REPLACE FUNCTION public.atualizar_configuracao_financeira(
    p_usuario TEXT,
    p_lote_atual TEXT DEFAULT NULL,
    p_valor_inscricao NUMERIC DEFAULT NULL,
    p_valor_promocional NUMERIC DEFAULT NULL,
    p_taxa_adicional NUMERIC DEFAULT 0.00,
    p_max_parcelas INT DEFAULT 12,
    p_pix_chave TEXT DEFAULT NULL,
    p_pix_tipo_chave TEXT DEFAULT NULL,
    p_pix_beneficiario TEXT DEFAULT NULL,
    p_pix_documento TEXT DEFAULT NULL,
    p_pix_cidade TEXT DEFAULT NULL,
    p_motivo TEXT DEFAULT NULL,
    p_ip TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_atual RECORD;
    v_nova_versao INT := 1;
    v_novo_id UUID;
    v_novo_valor NUMERIC;
BEGIN
    IF p_valor_inscricao IS NOT NULL AND p_valor_inscricao <= 0 THEN
        RETURN json_build_object('success', false, 'message', 'O valor da inscrição deve ser positivo.');
    END IF;

    SELECT * INTO v_atual 
    FROM public.configuracoes_financeiras 
    WHERE ativo = true 
    ORDER BY versao DESC 
    LIMIT 1;

    IF FOUND THEN
        v_nova_versao := v_atual.versao + 1;
        UPDATE public.configuracoes_financeiras 
        SET ativo = false, atualizado_em = now() 
        WHERE id = v_atual.id;
    END IF;

    v_novo_valor := COALESCE(p_valor_inscricao, v_atual.valor_inscricao);

    INSERT INTO public.configuracoes_financeiras (
        versao, ativo, configurado, lote_atual, valor_inscricao, valor_promocional, taxa_adicional,
        max_parcelas, pix_chave, pix_tipo_chave, pix_beneficiario,
        pix_documento, pix_cidade, motivo_alteracao, atualizado_por
    ) VALUES (
        v_nova_versao,
        true,
        (v_novo_valor IS NOT NULL AND v_novo_valor > 0),
        COALESCE(p_lote_atual, v_atual.lote_atual, '1º Lote'),
        v_novo_valor,
        p_valor_promocional,
        COALESCE(p_taxa_adicional, v_atual.taxa_adicional, 0.00),
        COALESCE(p_max_parcelas, v_atual.max_parcelas, 12),
        COALESCE(p_pix_chave, v_atual.pix_chave),
        COALESCE(p_pix_tipo_chave, v_atual.pix_tipo_chave),
        COALESCE(p_pix_beneficiario, v_atual.pix_beneficiario),
        COALESCE(p_pix_documento, v_atual.pix_documento, ''),
        COALESCE(p_pix_cidade, v_atual.pix_cidade),
        p_motivo,
        COALESCE(p_usuario, 'admin')
    ) RETURNING id INTO v_novo_id;

    RETURN json_build_object(
        'success', true,
        'id', v_novo_id,
        'versao', v_nova_versao,
        'configurado', (v_novo_valor IS NOT NULL AND v_novo_valor > 0),
        'valor_inscricao', v_novo_valor,
        'pix_chave', COALESCE(p_pix_chave, v_atual.pix_chave)
    );
END;
$$;

-- 8. RESET DOS LINKS DE WHATSAPP (ZERAR LINKS ANTIGOS)
DELETE FROM public.configuracoes_whatsapp WHERE sub ILIKE '%azul%' OR sub IN ('verde', 'vermelho', 'amarelo', 'laranja', 'geral');

-- Consolida as 5 entradas padrão com link vazio ('')
INSERT INTO public.configuracoes_whatsapp (sub, link_grupo, ativo, atualizado_por)
VALUES
    ('Verde', '', true, 'reset_controlado'),
    ('Vermelho', '', true, 'reset_controlado'),
    ('Amarelo', '', true, 'reset_controlado'),
    ('Laranja', '', true, 'reset_controlado'),
    ('Geral', '', true, 'reset_controlado')
ON CONFLICT (sub) DO UPDATE 
SET link_grupo = '',
    ativo = true,
    atualizado_em = now(),
    atualizado_por = 'reset_controlado';

-- Limpa link_whatsapp em public.subs
UPDATE public.subs SET link_whatsapp = NULL;

-- 9. PERMISSÕES E GRANTS FINAIS
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.inscricoes TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.subs TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.configuracoes_financeiras TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.configuracoes_whatsapp TO anon, authenticated, service_role;
