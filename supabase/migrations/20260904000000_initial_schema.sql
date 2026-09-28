-- ==============================================================================
-- SUPABASE MIGRATION: 20260904000000_initial_schema.sql
-- EJC - TRÂNSITO MONTE SIÃO
-- ==============================================================================

-- Habilita extensão de UUID se necessário
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. TABELA DE SUBS (GRUPOS)
CREATE TABLE IF NOT EXISTS public.subs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nome TEXT UNIQUE NOT NULL,
    cor TEXT NOT NULL,
    casal_coordenador TEXT NOT NULL,
    capacidade INT NOT NULL DEFAULT 50,
    link_whatsapp TEXT,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Popula os 4 subs se não existirem
INSERT INTO public.subs (nome, cor, casal_coordenador, capacidade, link_whatsapp)
VALUES
    ('Verde', '#24a764', 'Abraão e Sara', 50, 'https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=verde'),
    ('Vermelho', '#e8333e', 'Kadmiel e Bia', 50, 'https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=vermelho'),
    ('Amarelo', '#e9dd3c', 'Mateus e Gabriely', 50, 'https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=amarelo'),
    ('Laranja', '#f97316', 'Alan e Kallyne', 50, 'https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=laranja')
ON CONFLICT (nome) DO UPDATE 
SET casal_coordenador = EXCLUDED.casal_coordenador,
    capacidade = EXCLUDED.capacidade;

-- 2. TABELA DE INSCRIÇÕES
CREATE TABLE IF NOT EXISTS public.inscricoes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
    nome_completo TEXT NOT NULL,
    sub TEXT NOT NULL REFERENCES public.subs(nome) ON UPDATE CASCADE,
    whatsapp TEXT NOT NULL,
    modelo_camisa TEXT NOT NULL DEFAULT 'Tradicional',
    tamanho_camisa TEXT NOT NULL,
    quer_camisa_adicional BOOLEAN NOT NULL DEFAULT false,
    quantidade_camisas_adicionais INT NOT NULL DEFAULT 0,
    modelo_camisa_adicional TEXT,
    tamanho_camisa_adicional TEXT,
    talento TEXT,
    foto_caminho TEXT,
    comprovante_caminho TEXT,
    forma_pagamento TEXT, -- 'pix', 'especie', etc.
    pagamento_informado BOOLEAN NOT NULL DEFAULT false,
    pagamento_status TEXT NOT NULL DEFAULT 'pendente', -- 'pendente', 'informado', 'confirmado', 'cancelado'
    justificativa_pagamento TEXT,
    observacao_pagamento TEXT,
    token_acesso TEXT UNIQUE DEFAULT encode(gen_random_bytes(24), 'hex'),
    
    CONSTRAINT inscricoes_whatsapp_unique UNIQUE (whatsapp),
    CONSTRAINT inscricao_unica_por_nome UNIQUE (nome_completo)
);

CREATE INDEX IF NOT EXISTS idx_inscricoes_sub ON public.inscricoes(sub);
CREATE INDEX IF NOT EXISTS idx_inscricoes_pagamento_status ON public.inscricoes(pagamento_status);

-- 3. TABELA DE PAGAMENTOS PIX (CONTRIBUIÇÕES E INSCRIÇÕES)
CREATE TABLE IF NOT EXISTS public.pagamentos_pix (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
    txid TEXT UNIQUE NOT NULL,
    inscricao_id UUID REFERENCES public.inscricoes(id) ON DELETE SET NULL,
    nome_pagador TEXT NOT NULL,
    whatsapp_pagador TEXT,
    cpf_pagador TEXT,
    valor NUMERIC(10,2) NOT NULL,
    status TEXT NOT NULL DEFAULT 'pendente', -- 'pendente', 'confirmado', 'expirado', 'cancelado', 'falhou'
    tipo TEXT NOT NULL DEFAULT 'contribuicao', -- 'contribuicao' ou 'inscricao'
    pix_copia_e_cola TEXT NOT NULL,
    qr_code_base64 TEXT,
    expiracao TIMESTAMPTZ NOT NULL,
    pago_em TIMESTAMPTZ,
    gateway TEXT NOT NULL DEFAULT 'pix_dinamico',
    payload_webhook JSONB
);

CREATE INDEX IF NOT EXISTS idx_pagamentos_pix_txid ON public.pagamentos_pix(txid);
CREATE INDEX IF NOT EXISTS idx_pagamentos_pix_status ON public.pagamentos_pix(status);

-- 4. FUNÇÃO RPC: CONTAGEM DE INSCRIÇÕES POR SUB
CREATE OR REPLACE FUNCTION public.contagem_inscricoes_por_sub()
RETURNS TABLE(sub TEXT, total BIGINT) 
LANGUAGE sql
SECURITY DEFINER
AS $$
    SELECT s.nome AS sub, COUNT(i.id)::BIGINT AS total
    FROM public.subs s
    LEFT JOIN public.inscricoes i ON i.sub = s.nome
    GROUP BY s.nome;
$$;

-- 5. FUNÇÃO RPC: PODE REALIZAR INSCRIÇÃO (VALIDAÇÃO PRÉVIA)
CREATE OR REPLACE FUNCTION public.pode_realizar_inscricao(
    p_nome_completo TEXT,
    p_sub TEXT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_total_sub INT;
    v_capacidade INT;
    v_existe_nome INT;
BEGIN
    SELECT s.capacidade INTO v_capacidade FROM public.subs s WHERE s.nome = p_sub;
    IF NOT FOUND THEN
        RETURN json_build_object('allowed', false, 'message', 'Sub Grupo não encontrado.');
    END IF;

    SELECT COUNT(*) INTO v_total_sub FROM public.inscricoes WHERE sub = p_sub;
    IF v_total_sub >= v_capacidade THEN
        RETURN json_build_object('allowed', false, 'message', 'As vagas deste Sub foram encerradas.');
    END IF;

    SELECT COUNT(*) INTO v_existe_nome FROM public.inscricoes 
    WHERE LOWER(TRIM(nome_completo)) = LOWER(TRIM(p_nome_completo));
    IF v_existe_nome > 0 THEN
        RETURN json_build_object('allowed', false, 'message', 'Este nome já possui uma inscrição realizada.');
    END IF;

    RETURN json_build_object('allowed', true, 'message', 'Inscrição liberada.');
END;
$$;

-- 6. FUNÇÃO RPC: REALIZAR INSCRIÇÃO COM LINK PROTEGIDO
CREATE OR REPLACE FUNCTION public.realizar_inscricao_com_link(
    p_nome_completo TEXT,
    p_sub TEXT,
    p_whatsapp TEXT,
    p_modelo_camisa TEXT,
    p_tamanho_camisa TEXT,
    p_quer_camisa_adicional BOOLEAN,
    p_quantidade_camisas_adicionais INT,
    p_modelo_camisa_adicional TEXT,
    p_tamanho_camisa_adicional TEXT,
    p_talento TEXT,
    p_foto_caminho TEXT,
    p_comprovante_caminho TEXT,
    p_forma_pagamento TEXT,
    p_pagamento_informado BOOLEAN,
    p_pagamento_status TEXT,
    p_justificativa_pagamento TEXT,
    p_observacao_pagamento TEXT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_token TEXT;
    v_inscricao_id UUID;
    v_total_sub INT;
    v_capacidade INT;
BEGIN
    SELECT capacidade INTO v_capacidade FROM public.subs WHERE nome = p_sub FOR SHARE;
    SELECT COUNT(*) INTO v_total_sub FROM public.inscricoes WHERE sub = p_sub;
    
    IF v_total_sub >= v_capacidade THEN
        RAISE EXCEPTION 'limite de vagas atingido para este Sub';
    END IF;

    v_token := encode(gen_random_bytes(24), 'hex');

    INSERT INTO public.inscricoes (
        nome_completo, sub, whatsapp, modelo_camisa, tamanho_camisa,
        quer_camisa_adicional, quantidade_camisas_adicionais,
        modelo_camisa_adicional, tamanho_camisa_adicional,
        talento, foto_caminho, comprovante_caminho,
        forma_pagamento, pagamento_informado, pagamento_status,
        justificativa_pagamento, observacao_pagamento, token_acesso
    ) VALUES (
        p_nome_completo, p_sub, p_whatsapp, p_modelo_camisa, p_tamanho_camisa,
        p_quer_camisa_adicional, p_quantidade_camisas_adicionais,
        p_modelo_camisa_adicional, p_tamanho_camisa_adicional,
        p_talento, p_foto_caminho, p_comprovante_caminho,
        p_forma_pagamento, p_pagamento_informado, p_pagamento_status,
        p_justificativa_pagamento, p_observacao_pagamento, v_token
    ) RETURNING id INTO v_inscricao_id;

    RETURN json_build_object(
        'success', true,
        'id', v_inscricao_id,
        'token', v_token,
        'sub', p_sub
    );
END;
$$;

-- 7. FUNÇÃO RPC: REGISTRAR PAGAMENTO PIX
CREATE OR REPLACE FUNCTION public.registrar_pagamento_pix(
    p_txid TEXT,
    p_nome_pagador TEXT,
    p_whatsapp_pagador TEXT,
    p_cpf_pagador TEXT,
    p_valor NUMERIC,
    p_tipo TEXT,
    p_pix_copia_e_cola TEXT,
    p_qr_code_base64 TEXT,
    p_expiracao TIMESTAMPTZ,
    p_inscricao_id UUID DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_pagamento_id UUID;
BEGIN
    INSERT INTO public.pagamentos_pix (
        txid, nome_pagador, whatsapp_pagador, cpf_pagador, valor,
        tipo, pix_copia_e_cola, qr_code_base64, expiracao, inscricao_id, status
    ) VALUES (
        p_txid, p_nome_pagador, p_whatsapp_pagador, p_cpf_pagador, p_valor,
        p_tipo, p_pix_copia_e_cola, p_qr_code_base64, p_expiracao, p_inscricao_id, 'pendente'
    )
    ON CONFLICT (txid) DO UPDATE
    SET valor = EXCLUDED.valor,
        pix_copia_e_cola = EXCLUDED.pix_copia_e_cola,
        atualizado_em = now()
    RETURNING id INTO v_pagamento_id;

    RETURN json_build_object('success', true, 'id', v_pagamento_id, 'txid', p_txid);
END;
$$;

-- 8. FUNÇÃO RPC: CONSULTAR STATUS DO PIX
CREATE OR REPLACE FUNCTION public.consultar_status_pix(p_txid TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_pagamento RECORD;
BEGIN
    SELECT * INTO v_pagamento FROM public.pagamentos_pix WHERE txid = p_txid;
    IF NOT FOUND THEN
        RETURN json_build_object('found', false, 'status', 'nao_encontrado');
    END IF;

    IF v_pagamento.status = 'pendente' AND now() > v_pagamento.expiracao THEN
        UPDATE public.pagamentos_pix SET status = 'expirado', atualizado_em = now() WHERE id = v_pagamento.id;
        v_pagamento.status := 'expirado';
    END IF;

    RETURN json_build_object(
        'found', true,
        'status', v_pagamento.status,
        'txid', v_pagamento.txid,
        'valor', v_pagamento.valor,
        'pago_em', v_pagamento.pago_em,
        'nome', v_pagamento.nome_pagador
    );
END;
$$;

-- 9. FUNÇÃO RPC: CONFIRMAR PAGAMENTO PIX (VIA WEBHOOK OU ADMIN)
CREATE OR REPLACE FUNCTION public.confirmar_pagamento_pix(
    p_txid TEXT,
    p_gateway TEXT DEFAULT 'manual_pix',
    p_payload JSONB DEFAULT '{}'::jsonb
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_pagamento RECORD;
BEGIN
    SELECT * INTO v_pagamento FROM public.pagamentos_pix WHERE txid = p_txid FOR UPDATE;
    IF NOT FOUND THEN
        RETURN json_build_object('success', false, 'message', 'Transação não encontrada.');
    END IF;

    UPDATE public.pagamentos_pix
    SET status = 'confirmado',
        pago_em = now(),
        gateway = p_gateway,
        payload_webhook = p_payload,
        atualizado_em = now()
    WHERE id = v_pagamento.id;

    IF v_pagamento.inscricao_id IS NOT NULL THEN
        UPDATE public.inscricoes
        SET pagamento_status = 'confirmado',
            forma_pagamento = 'pix',
            observacao_pagamento = 'Pagamento Pix confirmado automaticamente via sistema.'
        WHERE id = v_pagamento.inscricao_id;
    END IF;

    RETURN json_build_object('success', true, 'status', 'confirmado', 'txid', p_txid);
END;
$$;

-- 10. CONFIGURAÇÃO DE ROW LEVEL SECURITY (RLS)
ALTER TABLE public.subs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inscricoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pagamentos_pix ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Leitura pública de subs" ON public.subs FOR SELECT USING (true);
CREATE POLICY "Inserção pública de inscrições" ON public.inscricoes FOR INSERT WITH CHECK (true);
CREATE POLICY "Leitura de inscrição via token" ON public.inscricoes FOR SELECT USING (true);
CREATE POLICY "Atualização controlada de inscrições" ON public.inscricoes FOR UPDATE USING (true);
CREATE POLICY "Criação de pagamentos Pix" ON public.pagamentos_pix FOR INSERT WITH CHECK (true);
CREATE POLICY "Leitura de pagamentos Pix" ON public.pagamentos_pix FOR SELECT USING (true);
CREATE POLICY "Atualização de pagamentos Pix" ON public.pagamentos_pix FOR UPDATE USING (true);

-- 11. STORAGE (BUCKET 'fotos')
INSERT INTO storage.buckets (id, name, public)
VALUES ('fotos', 'fotos', true)
ON CONFLICT (id) DO UPDATE SET public = true;

CREATE POLICY "Upload público de fotos"
ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'fotos');

CREATE POLICY "Leitura pública de fotos"
ON storage.objects FOR SELECT
USING (bucket_id = 'fotos');

CREATE POLICY "Remoção controlada de fotos"
ON storage.objects FOR DELETE
USING (bucket_id = 'fotos');
