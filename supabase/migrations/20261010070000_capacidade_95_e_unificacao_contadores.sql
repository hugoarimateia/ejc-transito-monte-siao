-- ==============================================================================
-- MIGRATION: 20261010070000_capacidade_95_e_unificacao_contadores.sql
-- 1. Aumento da capacidade oficial de todas as 4 Subs de 85 para 95 (Total: 380 vagas)
-- 2. Unificação da regra operacional de contagem entre Landing Page e Painel Admin
-- Conta inscrições reais, concluídas e ativas (arquivado = false), independentemente do status de pagamento
-- ==============================================================================

-- 1. ATUALIZAÇÃO DA CAPACIDADE DAS 4 SUBS PARA 95
UPDATE public.subs
SET capacidade = 95
WHERE nome IN ('Verde', 'Vermelho', 'Amarelo', 'Laranja');

ALTER TABLE public.subs ALTER COLUMN capacidade SET DEFAULT 95;

-- 2. UNIFICAÇÃO DA RPC contagem_inscricoes_por_sub COM A REGRA OPERACIONAL DO ADMIN
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

-- 3. UNIFICAÇÃO DA RPC obter_vagas_ocupadas_sub
CREATE OR REPLACE FUNCTION public.obter_vagas_ocupadas_sub(p_sub text)
RETURNS integer
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT COUNT(*)::INTEGER
    FROM public.inscricoes
    WHERE (
        (p_sub = 'Laranja' AND (sub = 'Laranja' OR sub = 'Azul'))
        OR sub = p_sub
    )
    AND (arquivado IS NULL OR arquivado = false);
$function$;
