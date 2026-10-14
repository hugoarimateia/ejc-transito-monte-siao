-- ==============================================================================
-- MIGRATION: 20261014120000_correcao_capacidade_ocupacao_liquida.sql
-- 1. Regra de Ocupação Líquida na trigger validar_capacidade_inscricao:
--    Edição de inscrição existente no mesmo Sub não consome nova vaga nem bloqueia com HTTP 500.
-- 2. Definição Canônica Unificada de Vagas Ocupadas:
--    Inscrições com pagamento_status = 'cancelado' não ocupam vagas nas Subs.
-- 3. Atualização da RPC obter_vagas_ocupadas_sub e contagem_inscricoes_por_sub.
-- ==============================================================================

-- 1. UNIFICAÇÃO DA RPC obter_vagas_ocupadas_sub COM EXCLUSÃO DE CANCELADOS
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
    AND (arquivado IS NULL OR arquivado = false)
    AND (pagamento_status IS NULL OR pagamento_status <> 'cancelado');
$function$;

GRANT EXECUTE ON FUNCTION public.obter_vagas_ocupadas_sub(text) TO anon, authenticated, service_role;

-- 2. UNIFICAÇÃO DA RPC contagem_inscricoes_por_sub
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
       AND (i.pagamento_status IS NULL OR i.pagamento_status <> 'cancelado')
    GROUP BY s.nome;
$function$;

GRANT EXECUTE ON FUNCTION public.contagem_inscricoes_por_sub() TO anon, authenticated, service_role;

-- 3. TRIGGER FUNCTION validar_capacidade_inscricao COM REGRA DE OCUPAÇÃO LÍQUIDA
CREATE OR REPLACE FUNCTION public.validar_capacidade_inscricao()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
    v_capacidade INT;
    v_total_sub INT;
BEGIN
    -- Se estiver arquivado, não ocupa vaga
    IF NEW.arquivado THEN
        RETURN NEW;
    END IF;

    -- REGRA DE OCUPAÇÃO LÍQUIDA:
    -- Se for um UPDATE e o participante já estiver ativo no mesmo Sub,
    -- a alteração de dados cadastrais não consome uma nova vaga (ocupação líquida = 0).
    IF TG_OP = 'UPDATE' THEN
        IF (OLD.arquivado IS NULL OR OLD.arquivado = false) AND OLD.sub = NEW.sub THEN
            RETURN NEW;
        END IF;
    END IF;

    -- Se for nova inscrição (INSERT), reativação (OLD.arquivado = true) ou troca de Sub:
    SELECT capacidade
    INTO v_capacidade
    FROM public.subs
    WHERE nome = NEW.sub
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Sub Grupo não encontrado.';
    END IF;

    -- Obtém a quantidade oficial de vagas ocupadas
    v_total_sub := public.obter_vagas_ocupadas_sub(NEW.sub);

    IF v_total_sub >= v_capacidade THEN
        RAISE EXCEPTION 'limite de vagas atingido para este Sub (% vagas preenchidas)', v_capacidade;
    END IF;

    RETURN NEW;
END;
$function$;
