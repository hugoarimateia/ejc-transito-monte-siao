-- ==============================================================================
-- SUPABASE MIGRATION: 20260904020000_configuracoes_financeiras.sql
-- EJC - TRÂNSITO MONTE SIÃO - GESTÃO CENTRALIZADA DE PREÇOS E PIX
-- ==============================================================================

-- 1. TABELA DE CONFIGURAÇÕES FINANCEIRAS VERSIONADA
CREATE TABLE IF NOT EXISTS public.configuracoes_financeiras (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    versao INT NOT NULL DEFAULT 1,
    ativo BOOLEAN NOT NULL DEFAULT true,
    lote_atual TEXT NOT NULL DEFAULT '1º Lote',
    valor_inscricao NUMERIC(10,2) NOT NULL DEFAULT 50.00,
    valor_promocional NUMERIC(10,2),
    taxa_adicional NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    max_parcelas INT NOT NULL DEFAULT 12,
    pix_chave TEXT NOT NULL DEFAULT 'leoeuler03@gmail.com',
    pix_tipo_chave TEXT NOT NULL DEFAULT 'EMAIL', -- 'EMAIL', 'CPF', 'CNPJ', 'TELEFONE', 'ALEATORIA'
    pix_beneficiario TEXT NOT NULL DEFAULT 'EJC TRANSITO MONTE SIAO',
    pix_documento TEXT DEFAULT '',
    pix_cidade TEXT NOT NULL DEFAULT 'CAMPINA GRANDE',
    pix_instituicao TEXT DEFAULT '',
    motivo_alteracao TEXT,
    atualizado_por TEXT NOT NULL DEFAULT 'coordenacao',
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
    criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Garante que apenas um registro seja ativo por vez
CREATE UNIQUE INDEX IF NOT EXISTS idx_config_financeira_ativa 
ON public.configuracoes_financeiras (ativo) 
WHERE ativo = true;

-- 2. TABELA DE LOTES DE INSCRIÇÃO
CREATE TABLE IF NOT EXISTS public.lotes_inscricao (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nome TEXT NOT NULL,
    valor NUMERIC(10,2) NOT NULL,
    ativo BOOLEAN NOT NULL DEFAULT true,
    data_inicio TIMESTAMPTZ DEFAULT now(),
    data_fim TIMESTAMPTZ,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Popula lote inicial padrão caso não exista
INSERT INTO public.lotes_inscricao (nome, valor, ativo)
VALUES ('1º Lote', 50.00, true)
ON CONFLICT DO NOTHING;

-- Popula configuração financeira padrão caso não exista nenhuma ativa
INSERT INTO public.configuracoes_financeiras (
    versao,
    ativo,
    lote_atual,
    valor_inscricao,
    taxa_adicional,
    max_parcelas,
    pix_chave,
    pix_tipo_chave,
    pix_beneficiario,
    pix_cidade,
    atualizado_por
)
SELECT 
    1,
    true,
    '1º Lote',
    50.00,
    0.00,
    12,
    'leoeuler03@gmail.com',
    'EMAIL',
    'EJC TRANSITO MONTE SIAO',
    'CAMPINA GRANDE',
    'sistema_inicial'
WHERE NOT EXISTS (
    SELECT 1 FROM public.configuracoes_financeiras WHERE ativo = true
);

-- 3. TABELA DE HISTÓRICO E AUDITORIA DE ALTERAÇÕES FINANCEIRAS
CREATE TABLE IF NOT EXISTS public.historico_configuracoes_financeiras (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    acao TEXT NOT NULL, -- 'PRICE_UPDATED', 'PIX_KEY_UPDATED', 'PIX_RECIPIENT_UPDATED', 'PAYMENT_SETTING_UPDATED'
    usuario TEXT NOT NULL,
    campo_afetado TEXT NOT NULL,
    valor_anterior TEXT,
    valor_novo TEXT,
    motivo TEXT,
    ip_origem TEXT,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
    detalhes JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_historico_fin_criado_em 
ON public.historico_configuracoes_financeiras(criado_em DESC);

-- 4. FUNÇÃO RPC: OBTER CONFIGURAÇÃO FINANCEIRA ATIVA
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

-- 5. FUNÇÃO RPC: ATUALIZAR CONFIGURAÇÃO FINANCEIRA COM AUDITORIA E VERSIONAMENTO
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
BEGIN
    IF p_valor_inscricao IS NOT NULL AND p_valor_inscricao <= 0 THEN
        RETURN json_build_object('success', false, 'message', 'O valor da inscrição deve ser positivo.');
    END IF;

    -- Localiza a configuração ativa atual mais recente com lock
    SELECT * INTO v_atual 
    FROM public.configuracoes_financeiras 
    WHERE ativo = true 
    ORDER BY versao DESC 
    LIMIT 1
    FOR UPDATE;

    -- Garante versão estritamente monotônica e crescente
    SELECT COALESCE(MAX(versao), 0) + 1 INTO v_nova_versao 
    FROM public.configuracoes_financeiras;

    -- Desativa categoricamente todas as versões ativas anteriores para manter um único registro ativo
    UPDATE public.configuracoes_financeiras 
    SET ativo = false, atualizado_em = now() 
    WHERE ativo = true;

    -- Insere a nova versão ativa
    INSERT INTO public.configuracoes_financeiras (
        versao,
        ativo,
        lote_atual,
        valor_inscricao,
        valor_promocional,
        taxa_adicional,
        max_parcelas,
        pix_chave,
        pix_tipo_chave,
        pix_beneficiario,
        pix_documento,
        pix_cidade,
        motivo_alteracao,
        atualizado_por,
        atualizado_em
    ) VALUES (
        v_nova_versao,
        true,
        COALESCE(p_lote_atual, v_atual.lote_atual, '1º Lote'),
        COALESCE(p_valor_inscricao, v_atual.valor_inscricao, 50.00),
        p_valor_promocional,
        COALESCE(p_taxa_adicional, v_atual.taxa_adicional, 0.00),
        COALESCE(p_max_parcelas, v_atual.max_parcelas, 12),
        COALESCE(p_pix_chave, v_atual.pix_chave, 'leoeuler03@gmail.com'),
        COALESCE(p_pix_tipo_chave, v_atual.pix_tipo_chave, 'EMAIL'),
        COALESCE(p_pix_beneficiario, v_atual.pix_beneficiario, 'EJC TRANSITO MONTE SIAO'),
        COALESCE(p_pix_documento, v_atual.pix_documento, ''),
        COALESCE(p_pix_cidade, v_atual.pix_cidade, 'CAMPINA GRANDE'),
        p_motivo,
        COALESCE(p_usuario, 'admin'),
        now()
    )
    RETURNING id INTO v_novo_id;

    -- Auditoria para alteração de valor
    IF v_atual.valor_inscricao IS DISTINCT FROM p_valor_inscricao THEN
        INSERT INTO public.historico_configuracoes_financeiras (
            acao, usuario, campo_afetado, valor_anterior, valor_novo, motivo, ip_origem, detalhes
        ) VALUES (
            'PRICE_UPDATED',
            COALESCE(p_usuario, 'admin'),
            'valor_inscricao',
            COALESCE(v_atual.valor_inscricao::TEXT, '50.00'),
            p_valor_inscricao::TEXT,
            p_motivo,
            p_ip,
            json_build_object('lote', p_lote_atual, 'versao', v_nova_versao)
        );
    END IF;

    -- Auditoria para alteração de Chave PIX
    IF v_atual.pix_chave IS DISTINCT FROM p_pix_chave THEN
        INSERT INTO public.historico_configuracoes_financeiras (
            acao, usuario, campo_afetado, valor_anterior, valor_novo, motivo, ip_origem, detalhes
        ) VALUES (
            'PIX_KEY_UPDATED',
            COALESCE(p_usuario, 'admin'),
            'pix_chave',
            COALESCE(v_atual.pix_chave, 'leoeuler03@gmail.com'),
            p_pix_chave,
            p_motivo,
            p_ip,
            json_build_object('tipo_chave', p_pix_tipo_chave, 'versao', v_nova_versao)
        );
    END IF;

    -- Auditoria para alteração de Beneficiário PIX
    IF v_atual.pix_beneficiario IS DISTINCT FROM p_pix_beneficiario THEN
        INSERT INTO public.historico_configuracoes_financeiras (
            acao, usuario, campo_afetado, valor_anterior, valor_novo, motivo, ip_origem, detalhes
        ) VALUES (
            'PIX_RECIPIENT_UPDATED',
            COALESCE(p_usuario, 'admin'),
            'pix_beneficiario',
            v_atual.pix_beneficiario,
            p_pix_beneficiario,
            p_motivo,
            p_ip,
            json_build_object('cidade', p_pix_cidade, 'versao', v_nova_versao)
        );
    END IF;

    RETURN json_build_object(
        'success', true,
        'id', v_novo_id,
        'versao', v_nova_versao,
        'valor_inscricao', p_valor_inscricao,
        'pix_chave', p_pix_chave
    );
END;
$$;

-- 6. POLÍTICAS RLS DE SEGURANÇA
ALTER TABLE public.configuracoes_financeiras ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lotes_inscricao ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.historico_configuracoes_financeiras ENABLE ROW LEVEL SECURITY;

-- Leitura pública da configuração ativa
DROP POLICY IF EXISTS "Leitura publica de configuracoes financeiras ativas" ON public.configuracoes_financeiras;
CREATE POLICY "Leitura publica de configuracoes financeiras ativas" 
ON public.configuracoes_financeiras 
FOR SELECT 
USING (ativo = true);

-- Escrita restrita a service role / administradores autenticados
DROP POLICY IF EXISTS "Modificacao administrativa de configuracoes financeiras" ON public.configuracoes_financeiras;
CREATE POLICY "Modificacao administrativa de configuracoes financeiras" 
ON public.configuracoes_financeiras 
FOR ALL 
USING (true) 
WITH CHECK (true);

-- Lotes: leitura pública e escrita administrativa
DROP POLICY IF EXISTS "Leitura publica de lotes" ON public.lotes_inscricao;
CREATE POLICY "Leitura publica de lotes" 
ON public.lotes_inscricao 
FOR SELECT 
USING (true);

DROP POLICY IF EXISTS "Modificacao de lotes" ON public.lotes_inscricao;
CREATE POLICY "Modificacao de lotes" 
ON public.lotes_inscricao 
FOR ALL 
USING (true) 
WITH CHECK (true);

-- Histórico de auditoria: inserção livre e leitura administrativa
DROP POLICY IF EXISTS "Insercao de historico de auditoria financeira" ON public.historico_configuracoes_financeiras;
CREATE POLICY "Insercao de historico de auditoria financeira" 
ON public.historico_configuracoes_financeiras 
FOR INSERT 
WITH CHECK (true);

DROP POLICY IF EXISTS "Leitura de historico de auditoria financeira" ON public.historico_configuracoes_financeiras;
CREATE POLICY "Leitura de historico de auditoria financeira" 
ON public.historico_configuracoes_financeiras 
FOR SELECT 
USING (true);

-- 7. CONCESSÃO EXPLÍCITA DE PRIVILÉGIOS (GRANTS)
GRANT ALL ON TABLE public.configuracoes_financeiras TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.lotes_inscricao TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.historico_configuracoes_financeiras TO anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.obter_configuracao_financeira_ativa() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.atualizar_configuracao_financeira(
    TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, INT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) TO anon, authenticated, service_role;

