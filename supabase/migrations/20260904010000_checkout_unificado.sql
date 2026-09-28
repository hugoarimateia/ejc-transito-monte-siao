-- ==============================================================================
-- SUPABASE MIGRATION: 20260904010000_checkout_unificado.sql
-- EJC - TRÂNSITO MONTE SIÃO - CHECKOUT UNIFICADO (PIX + CARTÃO DE CRÉDITO)
-- ==============================================================================

-- 1. EVOLUÇÃO DA TABELA DE PAGAMENTOS (UNIFICADA)
-- Se pagamentos_pix existir, renomeia com segurança; se não, cria pagamentos
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'pagamentos_pix') 
       AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'pagamentos') THEN
        ALTER TABLE public.pagamentos_pix RENAME TO pagamentos;
    END IF;
END $$;

-- Cria a tabela pagamentos caso ainda não exista
CREATE TABLE IF NOT EXISTS public.pagamentos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
    txid TEXT UNIQUE NOT NULL,
    inscricao_id UUID REFERENCES public.inscricoes(id) ON DELETE SET NULL,
    nome_pagador TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    whatsapp_pagador TEXT,
    cpf_pagador TEXT,
    valor NUMERIC(10,2) NOT NULL,
    metodo TEXT NOT NULL DEFAULT 'pix', -- 'pix' ou 'credit_card'
    parcelas INT NOT NULL DEFAULT 1,
    cartao_ultimos_digitos VARCHAR(4),
    cartao_bandeira VARCHAR(30),
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'processing', 'approved', 'rejected', 'cancelled', 'expired', 'refunded', 'error'
    tipo TEXT NOT NULL DEFAULT 'inscricao', -- 'inscricao' ou 'contribuicao'
    pix_copia_e_cola TEXT,
    qr_code_base64 TEXT,
    expiracao TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '15 minutes'),
    pago_em TIMESTAMPTZ,
    gateway TEXT NOT NULL DEFAULT 'checkout_transparente',
    gateway_transaction_id TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    payload_webhook JSONB
);

-- Adiciona colunas novas caso a tabela tenha vindo de pagamentos_pix
ALTER TABLE public.pagamentos ADD COLUMN IF NOT EXISTS metodo TEXT NOT NULL DEFAULT 'pix';
ALTER TABLE public.pagamentos ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT '';
ALTER TABLE public.pagamentos ADD COLUMN IF NOT EXISTS parcelas INT NOT NULL DEFAULT 1;
ALTER TABLE public.pagamentos ADD COLUMN IF NOT EXISTS cartao_ultimos_digitos VARCHAR(4);
ALTER TABLE public.pagamentos ADD COLUMN IF NOT EXISTS cartao_bandeira VARCHAR(30);
ALTER TABLE public.pagamentos ADD COLUMN IF NOT EXISTS gateway_transaction_id TEXT;
ALTER TABLE public.pagamentos ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

-- Índices de performance
CREATE INDEX IF NOT EXISTS idx_pagamentos_txid ON public.pagamentos(txid);
CREATE INDEX IF NOT EXISTS idx_pagamentos_status ON public.pagamentos(status);
CREATE INDEX IF NOT EXISTS idx_pagamentos_email ON public.pagamentos(email);
CREATE INDEX IF NOT EXISTS idx_pagamentos_metodo ON public.pagamentos(metodo);

-- View de compatibilidade retroativa para não quebrar queries que referenciam pagamentos_pix
CREATE OR REPLACE VIEW public.pagamentos_pix AS 
SELECT * FROM public.pagamentos WHERE metodo = 'pix';

-- 2. TABELA DE AUDITORIA E HISTÓRICO DE TRANSAÇÕES
CREATE TABLE IF NOT EXISTS public.auditoria_transacoes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transacao_id TEXT NOT NULL,
    acao TEXT NOT NULL, -- 'criado', 'aprovado', 'recusado', 'expirado', 'cancelado', 'comprovante_enviado', 'status_alterado_admin'
    status_anterior TEXT,
    status_novo TEXT,
    executado_por TEXT NOT NULL DEFAULT 'sistema',
    criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
    detalhes JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_auditoria_transacao_id ON public.auditoria_transacoes(transacao_id);

-- 3. TABELA DE CONFIGURAÇÕES DE WHATSAPP ADMINISTRÁVEIS
CREATE TABLE IF NOT EXISTS public.configuracoes_whatsapp (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sub TEXT UNIQUE NOT NULL,
    link_grupo TEXT NOT NULL,
    ativo BOOLEAN NOT NULL DEFAULT true,
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
    atualizado_por TEXT DEFAULT 'coordenacao'
);

-- Popula links padrão administráveis
INSERT INTO public.configuracoes_whatsapp (sub, link_grupo, ativo)
VALUES
    ('Verde', 'https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=verde', true),
    ('Vermelho', 'https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=vermelho', true),
    ('Amarelo', 'https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=amarelo', true),
    ('Laranja', 'https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=laranja', true),
    ('Geral', 'https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?s=cl&p=i&mlu=0', true)
ON CONFLICT (sub) DO NOTHING;

-- 4. ATUALIZAÇÃO DA TABELA DE INSCRIÇÕES (ADICIONA EMAIL)
ALTER TABLE public.inscricoes ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_inscricoes_email ON public.inscricoes(email);

-- 5. FUNÇÃO RPC: CRIAR TRANSAÇÃO NO CHECKOUT UNIFICADO
CREATE OR REPLACE FUNCTION public.criar_transacao_checkout(
    p_txid TEXT,
    p_nome_pagador TEXT,
    p_email TEXT,
    p_whatsapp_pagador TEXT,
    p_cpf_pagador TEXT,
    p_valor NUMERIC,
    p_metodo TEXT, -- 'pix' ou 'credit_card'
    p_parcelas INT DEFAULT 1,
    p_cartao_ultimos_digitos TEXT DEFAULT NULL,
    p_cartao_bandeira TEXT DEFAULT NULL,
    p_status TEXT DEFAULT 'pending',
    p_tipo TEXT DEFAULT 'inscricao',
    p_pix_copia_e_cola TEXT DEFAULT NULL,
    p_qr_code_base64 TEXT DEFAULT NULL,
    p_expiracao TIMESTAMPTZ DEFAULT (now() + interval '15 minutes'),
    p_inscricao_id UUID DEFAULT NULL,
    p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_pagamento_id UUID;
BEGIN
    INSERT INTO public.pagamentos (
        txid, nome_pagador, email, whatsapp_pagador, cpf_pagador, valor,
        metodo, parcelas, cartao_ultimos_digitos, cartao_bandeira,
        status, tipo, pix_copia_e_cola, qr_code_base64, expiracao,
        inscricao_id, metadata, gateway_transaction_id
    ) VALUES (
        p_txid, p_nome_pagador, p_email, p_whatsapp_pagador, p_cpf_pagador, p_valor,
        p_metodo, p_parcelas, p_cartao_ultimos_digitos, p_cartao_bandeira,
        p_status, p_tipo, p_pix_copia_e_cola, p_qr_code_base64, p_expiracao,
        p_inscricao_id, p_metadata, p_txid
    )
    ON CONFLICT (txid) DO UPDATE
    SET valor = EXCLUDED.valor,
        status = EXCLUDED.status,
        atualizado_em = now()
    RETURNING id INTO v_pagamento_id;

    -- Registra auditoria
    INSERT INTO public.auditoria_transacoes (
        transacao_id, acao, status_anterior, status_novo, executado_por, detalhes
    ) VALUES (
        p_txid, 'criado', NULL, p_status, 'checkout',
        json_build_object('metodo', p_metodo, 'valor', p_valor, 'email', p_email)
    );

    RETURN json_build_object(
        'success', true,
        'id', v_pagamento_id,
        'txid', p_txid,
        'status', p_status
    );
END;
$$;

-- 6. FUNÇÃO RPC: CONFIRMAR PAGAMENTO UNIFICADO (PIX OU CARTÃO)
CREATE OR REPLACE FUNCTION public.confirmar_pagamento_unificado(
    p_txid TEXT,
    p_gateway TEXT DEFAULT 'checkout_transparente',
    p_executado_por TEXT DEFAULT 'sistema',
    p_payload JSONB DEFAULT '{}'::jsonb
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_pagamento RECORD;
    v_status_antigo TEXT;
BEGIN
    SELECT * INTO v_pagamento FROM public.pagamentos WHERE txid = p_txid FOR UPDATE;
    IF NOT FOUND THEN
        RETURN json_build_object('success', false, 'message', 'Transação não encontrada.');
    END IF;

    -- Se já estiver aprovado, retorna idempotente
    IF v_pagamento.status = 'approved' OR v_pagamento.status = 'confirmado' THEN
        RETURN json_build_object('success', true, 'status', 'approved', 'txid', p_txid, 'mensagem', 'Já confirmado previamente.');
    END IF;

    v_status_antigo := v_pagamento.status;

    UPDATE public.pagamentos
    SET status = 'approved',
        pago_em = now(),
        gateway = p_gateway,
        payload_webhook = p_payload,
        atualizado_em = now()
    WHERE id = v_pagamento.id;

    -- Se vinculado a uma inscrição, atualiza status
    IF v_pagamento.inscricao_id IS NOT NULL THEN
        UPDATE public.inscricoes
        SET pagamento_status = 'confirmado',
            forma_pagamento = v_pagamento.metodo,
            observacao_pagamento = 'Pagamento aprovado via Checkout Unificado (' || UPPER(v_pagamento.metodo) || ').'
        WHERE id = v_pagamento.inscricao_id;
    END IF;

    -- Registra auditoria
    INSERT INTO public.auditoria_transacoes (
        transacao_id, acao, status_anterior, status_novo, executado_por, detalhes
    ) VALUES (
        p_txid, 'aprovado', v_status_antigo, 'approved', p_executado_por,
        json_build_object('gateway', p_gateway, 'metodo', v_pagamento.metodo, 'valor', v_pagamento.valor)
    );

    RETURN json_build_object('success', true, 'status', 'approved', 'txid', p_txid);
END;
$$;

-- 7. PERMISSÕES RLS
ALTER TABLE public.pagamentos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auditoria_transacoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.configuracoes_whatsapp ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Inserção pública de pagamentos" ON public.pagamentos FOR INSERT WITH CHECK (true);
CREATE POLICY "Leitura pública de pagamentos por txid" ON public.pagamentos FOR SELECT USING (true);
CREATE POLICY "Atualização pública de pagamentos" ON public.pagamentos FOR UPDATE USING (true);

CREATE POLICY "Inserção de auditoria" ON public.auditoria_transacoes FOR INSERT WITH CHECK (true);
CREATE POLICY "Leitura de auditoria" ON public.auditoria_transacoes FOR SELECT USING (true);

CREATE POLICY "Leitura pública de links whatsapp" ON public.configuracoes_whatsapp FOR SELECT USING (true);
CREATE POLICY "Atualização de links whatsapp" ON public.configuracoes_whatsapp FOR UPDATE USING (true);
CREATE POLICY "Inserção de links whatsapp" ON public.configuracoes_whatsapp FOR INSERT WITH CHECK (true);
