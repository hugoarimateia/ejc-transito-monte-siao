-- ==============================================================================
-- MIGRATION: 20260929020000_sincronizacao_fonte_unica_e_reset.sql
-- Sincronização e Fonte Única de Verdade para Inscrições Ativas
-- ==============================================================================

-- 1. Garante que a coluna 'arquivado' existe na tabela inscricoes com default false
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'inscricoes' 
          AND column_name = 'arquivado'
    ) THEN
        ALTER TABLE public.inscricoes ADD COLUMN arquivado BOOLEAN NOT NULL DEFAULT false;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'inscricoes' 
          AND column_name = 'arquivado_em'
    ) THEN
        ALTER TABLE public.inscricoes ADD COLUMN arquivado_em TIMESTAMPTZ;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'inscricoes' 
          AND column_name = 'motivo_arquivamento'
    ) THEN
        ALTER TABLE public.inscricoes ADD COLUMN motivo_arquivamento TEXT;
    END IF;
END $$;

-- 2. Índice otimizado para contagem rápida e filtro de ativas
CREATE INDEX IF NOT EXISTS idx_inscricoes_sub_arquivado 
ON public.inscricoes (sub, arquivado);

CREATE INDEX IF NOT EXISTS idx_inscricoes_arquivado 
ON public.inscricoes (arquivado);

-- 3. Atualiza RPC de contagem para contar EXCLUSIVAMENTE inscrições ativas (arquivado = false)
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

-- 4. Permissões de execução para anon, authenticated e service_role
GRANT EXECUTE ON FUNCTION public.contagem_inscricoes_por_sub() TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.contagem_inscricoes_por_sub() IS 
'Fonte oficial de contagem de inscritos por Sub. Conta unicamente inscricoes com arquivado = false.';
