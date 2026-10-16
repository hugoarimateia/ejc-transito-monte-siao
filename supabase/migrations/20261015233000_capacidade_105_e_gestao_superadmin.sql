-- ==============================================================================
-- MIGRATION: 20261015233000_capacidade_105_e_gestao_superadmin.sql
-- 1. Aumento da capacidade oficial de todas as 4 Subs de 95 para 105 (Total nominal: 420 vagas).
-- 2. Atualização do valor DEFAULT da coluna capacidade na tabela public.subs para 105.
-- 3. Criação da RPC segura public.alterar_capacidade_sub para gestão manual pelo Superadmin.
-- 4. Preserva integralmente a trigger validar_capacidade_inscricao, obter_vagas_ocupadas_sub,
--    contagem_inscricoes_por_sub e contagem_inscricoes_pagas_por_sub.
-- ==============================================================================

-- 1. ATUALIZAÇÃO DA CAPACIDADE INICIAL DAS 4 SUBS PARA 105
UPDATE public.subs 
SET capacidade = 105 
WHERE nome IN ('Verde', 'Vermelho', 'Amarelo', 'Laranja');

-- 2. ATUALIZAÇÃO DO DEFAULT DA TABELA
ALTER TABLE public.subs 
ALTER COLUMN capacidade SET DEFAULT 105;

-- 3. RPC CANÔNICA PARA ALTERAÇÃO MANUAL DA CAPACIDADE PELO SUPERADMIN
CREATE OR REPLACE FUNCTION public.alterar_capacidade_sub(
    p_sub text,
    p_nova_capacidade int
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_sub_oficial text;
    v_capacidade_anterior int;
    v_ocupacao_atual int;
    v_capacidades jsonb;
BEGIN
    -- Normalização do nome do Sub
    IF p_sub ILIKE '%verd%' THEN
        v_sub_oficial := 'Verde';
    ELSIF p_sub ILIKE '%verm%' THEN
        v_sub_oficial := 'Vermelho';
    ELSIF p_sub ILIKE '%amar%' THEN
        v_sub_oficial := 'Amarelo';
    ELSIF p_sub ILIKE '%laran%' OR p_sub ILIKE '%azul%' THEN
        v_sub_oficial := 'Laranja';
    ELSE
        RAISE EXCEPTION 'Subgrupo inválido: %', p_sub;
    END IF;

    -- Validação do valor da capacidade
    IF p_nova_capacidade IS NULL OR p_nova_capacidade < 1 OR p_nova_capacidade > 500 THEN
        RAISE EXCEPTION 'Capacidade inválida: %. Deve ser um número inteiro entre 1 e 500.', p_nova_capacidade;
    END IF;

    -- Obter capacidade anterior
    SELECT capacidade INTO v_capacidade_anterior
    FROM public.subs
    WHERE nome = v_sub_oficial
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Subgrupo % não encontrado na base de dados.', v_sub_oficial;
    END IF;

    -- Obter ocupação operacional atual pela regra canônica
    v_ocupacao_atual := public.obter_vagas_ocupadas_sub(v_sub_oficial);

    -- Atualizar a capacidade na tabela public.subs
    UPDATE public.subs
    SET capacidade = p_nova_capacidade
    WHERE nome = v_sub_oficial;

    -- Obter mapa atualizado de capacidades
    SELECT jsonb_object_agg(nome, capacidade)
    INTO v_capacidades
    FROM public.subs;

    -- Retorna resultado estruturado
    RETURN jsonb_build_object(
        'success', true,
        'sub', v_sub_oficial,
        'capacidade_anterior', v_capacidade_anterior,
        'nova_capacidade', p_nova_capacidade,
        'ocupacao_atual', v_ocupacao_atual,
        'capacidades', v_capacidades,
        'excedida', (v_ocupacao_atual > p_nova_capacidade)
    );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.alterar_capacidade_sub(text, int) TO anon, authenticated, service_role;
COMMENT ON FUNCTION public.alterar_capacidade_sub(text, int) IS 
'Altera manualmente a capacidade de um Subgrupo e retorna o mapa atualizado de capacidades e ocupação.';
