-- ==============================================================================
-- SUPABASE MIGRATION: 20260929000000_modulo_inscritos_dados.sql
-- Projeto: EJC - Trânsito Monte Sião
-- Módulo: Dados dos Inscritos por Sub (Extensão Complementar de Inscrições)
--
-- CARACTERÍSTICAS:
-- 1. Cria a tabela 'public.inscritos_dados' como extensão 1:1 de 'public.inscricoes'.
-- 2. Não duplica nome, WhatsApp, e-mail ou Sub (que já residem em 'public.inscricoes').
-- 3. Armazena tamanho de camisa ajustado, caminho seguro da foto e observações.
-- 4. Status de cadastro (completo / incompleto) calculado automaticamente.
-- 5. RLS estrito: acesso concedido exclusivamente à service_role (APIs backend protegidas).
-- 6. Bucket de fotos privado ('inscritos-fotos') para armazenamento protegido de fotos.
-- ==============================================================================

-- 1. CRIAÇÃO DA TABELA COMPLEMENTAR inscritos_dados
CREATE TABLE IF NOT EXISTS public.inscritos_dados (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    inscricao_id UUID UNIQUE NOT NULL REFERENCES public.inscricoes(id) ON DELETE CASCADE,
    tamanho_camisa TEXT,
    foto_caminho TEXT,
    status_cadastro TEXT NOT NULL DEFAULT 'incompleto', -- 'completo' | 'incompleto'
    observacoes TEXT,
    atualizado_por TEXT DEFAULT 'admin',
    foto_uploaded_at TIMESTAMPTZ,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. ÍNDICES DE PERFORMANCE E CONSULTA
CREATE INDEX IF NOT EXISTS idx_inscritos_dados_inscricao_id ON public.inscritos_dados(inscricao_id);
CREATE INDEX IF NOT EXISTS idx_inscritos_dados_status ON public.inscritos_dados(status_cadastro);

-- 3. TRIGGER PARA CÁLCULO AUTOMÁTICO DO STATUS DO CADASTRO
CREATE OR REPLACE FUNCTION public.calcular_status_inscrito_dados()
RETURNS TRIGGER AS $$
BEGIN
    -- Se tamanho da camisa e foto estiverem preenchidos, o cadastro é completo
    IF (NEW.tamanho_camisa IS NOT NULL AND trim(NEW.tamanho_camisa) <> '' AND
        NEW.foto_caminho IS NOT NULL AND trim(NEW.foto_caminho) <> '') THEN
        NEW.status_cadastro := 'completo';
    ELSE
        NEW.status_cadastro := 'incompleto';
    END IF;
    NEW.atualizado_em := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_calcular_status_inscrito_dados ON public.inscritos_dados;
CREATE TRIGGER trg_calcular_status_inscrito_dados
BEFORE INSERT OR UPDATE ON public.inscritos_dados
FOR EACH ROW EXECUTE FUNCTION public.calcular_status_inscrito_dados();

-- 4. HABILITAÇÃO ESTRITA DE ROW LEVEL SECURITY (RLS) NA TABELA
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = 'inscritos_dados'
          AND c.relkind = 'r'
    ) THEN
        ALTER TABLE public.inscritos_dados ENABLE ROW LEVEL SECURITY;
        REVOKE ALL ON TABLE public.inscritos_dados FROM PUBLIC, anon, authenticated;
        GRANT ALL ON TABLE public.inscritos_dados TO service_role;
        RAISE NOTICE 'RLS ativado e privilégios de public.inscritos_dados restritos à service_role';
    END IF;
END $$;

-- 5. BUCKET DE ARMAZENAMENTO PRIVADO PARA FOTOS DOS INSCRITOS
--    Garante que as fotos dos inscritos permaneçam estritamente privadas (public = false).
INSERT INTO storage.buckets (id, name, public)
VALUES ('inscritos-fotos', 'inscritos-fotos', false)
ON CONFLICT (id) DO UPDATE SET public = false;
