-- ==============================================================================
-- MIGRATION: 20261014230000_desacoplamento_dashboard_e_espelhamento_landing.sql
-- 1. Landing Page espelha a aba "Dados dos Participantes":
--    A RPC contagem_inscricoes_por_sub contabiliza todas as inscrições ativas elegíveis
--    (arquivado IS NULL OR arquivado = false), sem filtro de status de pagamento.
-- 2. Preserva a RPC obter_vagas_ocupadas_sub e o trigger validar_capacidade_inscricao.
-- 3. Adiciona a RPC canônica contagem_inscricoes_pagas_por_sub para métricas financeiras.
-- ==============================================================================

-- 1. RPC contagem_inscricoes_por_sub ESPELHANDO A ABA DADOS DOS PARTICIPANTES
CREATE OR REPLACE FUNCTION public.contagem_inscricoes_por_sub()
RETURNS TABLE(sub text, total bigint)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT 
        s.nome AS sub, 
        COUNT(i.id)::BIGINT AS total
    FROM public.subs s
    LEFT JOIN public.inscricoes i
        ON (
            (s.nome = 'Laranja' AND (i.sub = 'Laranja' OR i.sub = 'Azul'))
            OR i.sub = s.nome
        )
       AND (i.arquivado IS NULL OR i.arquivado = false)
    GROUP BY s.nome;
$function$;

GRANT EXECUTE ON FUNCTION public.contagem_inscricoes_por_sub() TO anon, authenticated, service_role;

-- 2. RPC CANÔNICA contagem_inscricoes_pagas_por_sub PARA O DASHBOARD ADMINISTRATIVO FINANCEIRO
CREATE OR REPLACE FUNCTION public.contagem_inscricoes_pagas_por_sub()
RETURNS TABLE(sub text, total bigint)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT 
        s.nome AS sub, 
        COUNT(DISTINCT i.id)::BIGINT AS total
    FROM public.subs s
    LEFT JOIN public.inscricoes i
        ON (
            (s.nome = 'Laranja' AND (i.sub = 'Laranja' OR i.sub = 'Azul'))
            OR i.sub = s.nome
        )
       AND (i.arquivado IS NULL OR i.arquivado = false)
       AND (i.pagamento_status = 'confirmado' OR i.pagamento_status = 'approved')
    GROUP BY s.nome;
$function$;

GRANT EXECUTE ON FUNCTION public.contagem_inscricoes_pagas_por_sub() TO anon, authenticated, service_role;
