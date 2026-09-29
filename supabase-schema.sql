-- ==============================================================================
-- EJC - TRÂNSITO MONTE SIÃO - ESQUEMA COMPLETO DO SUPABASE
-- Execute este script no SQL Editor do painel Supabase (https://supabase.com/dashboard)
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

-- Migra sub legada 'Azul' para 'Laranja' e remove resquício
UPDATE public.inscricoes SET sub = 'Laranja' WHERE sub = 'Azul';
DELETE FROM public.subs WHERE nome = 'Azul';

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

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_schema = 'public' 
          AND table_name = 'pagamentos_pix' 
          AND table_type = 'BASE TABLE'
    ) THEN
        EXECUTE 'CREATE INDEX IF NOT EXISTS idx_pagamentos_pix_txid ON public.pagamentos_pix(txid)';
        EXECUTE 'CREATE INDEX IF NOT EXISTS idx_pagamentos_pix_status ON public.pagamentos_pix(status)';
    END IF;
END $$;

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
    -- Verifica capacidade do sub
    SELECT s.capacidade INTO v_capacidade FROM public.subs s WHERE s.nome = p_sub;
    IF NOT FOUND THEN
        RETURN json_build_object('allowed', false, 'message', 'Sub Grupo não encontrado.');
    END IF;

    SELECT COUNT(*) INTO v_total_sub FROM public.inscricoes WHERE sub = p_sub;
    IF v_total_sub >= v_capacidade THEN
        RETURN json_build_object('allowed', false, 'message', 'As vagas deste Sub foram encerradas.');
    END IF;

    -- Verifica se o nome já está cadastrado
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
    -- Checa limite de vagas com bloqueio de linha
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

    -- Se pendente e expirado, atualiza
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

    -- Se o pagamento estiver vinculado a uma inscrição, atualiza status da inscrição
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

-- Políticas de leitura pública para subs e contagem
DROP POLICY IF EXISTS "Leitura pública de subs" ON public.subs;
CREATE POLICY "Leitura pública de subs" ON public.subs FOR SELECT USING (true);

-- Inscrições: anônimo pode inserir e consultar sua própria inscrição pelo token
DROP POLICY IF EXISTS "Inserção pública de inscrições" ON public.inscricoes;
CREATE POLICY "Inserção pública de inscrições" ON public.inscricoes FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Leitura de inscrição via token" ON public.inscricoes;
CREATE POLICY "Leitura de inscrição via token" ON public.inscricoes FOR SELECT USING (true);

DROP POLICY IF EXISTS "Atualização controlada de inscrições" ON public.inscricoes;
CREATE POLICY "Atualização controlada de inscrições" ON public.inscricoes FOR UPDATE USING (true);

-- Pagamentos Pix: inserção e leitura pública do status pelo txid
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_schema = 'public' 
          AND table_name = 'pagamentos_pix' 
          AND table_type = 'BASE TABLE'
    ) THEN
        EXECUTE 'ALTER TABLE public.pagamentos_pix ENABLE ROW LEVEL SECURITY';
        EXECUTE 'DROP POLICY IF EXISTS "Criação de pagamentos Pix" ON public.pagamentos_pix';
        EXECUTE 'CREATE POLICY "Criação de pagamentos Pix" ON public.pagamentos_pix FOR INSERT WITH CHECK (true)';
        EXECUTE 'DROP POLICY IF EXISTS "Leitura de pagamentos Pix" ON public.pagamentos_pix';
        EXECUTE 'CREATE POLICY "Leitura de pagamentos Pix" ON public.pagamentos_pix FOR SELECT USING (true)';
        EXECUTE 'DROP POLICY IF EXISTS "Atualização de pagamentos Pix" ON public.pagamentos_pix';
        EXECUTE 'CREATE POLICY "Atualização de pagamentos Pix" ON public.pagamentos_pix FOR UPDATE USING (true)';
    END IF;
END $$;

-- 11. STORAGE (BUCKET 'fotos')
-- Observação: Crie o bucket 'fotos' com visibilidade pública no painel Storage do Supabase.
INSERT INTO storage.buckets (id, name, public)
VALUES ('fotos', 'fotos', true)
ON CONFLICT (id) DO UPDATE SET public = true;

DROP POLICY IF EXISTS "Upload público de fotos" ON storage.objects;
CREATE POLICY "Upload público de fotos"
ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'fotos');

DROP POLICY IF EXISTS "Leitura pública de fotos" ON storage.objects;
CREATE POLICY "Leitura pública de fotos"
ON storage.objects FOR SELECT
USING (bucket_id = 'fotos');

DROP POLICY IF EXISTS "Remoção controlada de fotos" ON storage.objects;
CREATE POLICY "Remoção controlada de fotos"
ON storage.objects FOR DELETE
USING (bucket_id = 'fotos');

-- ==============================================================================
-- 12. CHECKOUT UNIFICADO: PAGAMENTOS, AUDITORIA E WHATSAPP
-- ==============================================================================

-- Se pagamentos_pix for uma tabela base, renomeia com segurança para pagamentos
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'pagamentos_pix' AND table_type = 'BASE TABLE') 
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

-- Garante colunas de checkout unificado caso a tabela tenha sido renomeada
ALTER TABLE public.pagamentos ADD COLUMN IF NOT EXISTS metodo TEXT NOT NULL DEFAULT 'pix';
ALTER TABLE public.pagamentos ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT '';
ALTER TABLE public.pagamentos ADD COLUMN IF NOT EXISTS parcelas INT NOT NULL DEFAULT 1;
ALTER TABLE public.pagamentos ADD COLUMN IF NOT EXISTS cartao_ultimos_digitos VARCHAR(4);
ALTER TABLE public.pagamentos ADD COLUMN IF NOT EXISTS cartao_bandeira VARCHAR(30);
ALTER TABLE public.pagamentos ADD COLUMN IF NOT EXISTS gateway_transaction_id TEXT;
ALTER TABLE public.pagamentos ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;
ALTER TABLE public.pagamentos ADD COLUMN IF NOT EXISTS comprovante_email_enviado BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.pagamentos ADD COLUMN IF NOT EXISTS comprovante_email_em TIMESTAMPTZ;
ALTER TABLE public.pagamentos ADD COLUMN IF NOT EXISTS comprovante_email_erro TEXT;
ALTER TABLE public.inscricoes ADD COLUMN IF NOT EXISTS pagamento_confirmado_em TIMESTAMPTZ;

-- Índices de performance para checkout unificado
CREATE INDEX IF NOT EXISTS idx_pagamentos_txid ON public.pagamentos(txid);
CREATE INDEX IF NOT EXISTS idx_pagamentos_status ON public.pagamentos(status);
CREATE INDEX IF NOT EXISTS idx_pagamentos_email ON public.pagamentos(email);
CREATE INDEX IF NOT EXISTS idx_pagamentos_metodo ON public.pagamentos(metodo);

-- View de compatibilidade retroativa para não quebrar queries legadas
CREATE OR REPLACE VIEW public.pagamentos_pix AS 
SELECT * FROM public.pagamentos WHERE metodo = 'pix';

-- Tabela de auditoria e histórico de transações
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

-- Tabela de configurações de WhatsApp administráveis
CREATE TABLE IF NOT EXISTS public.configuracoes_whatsapp (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sub TEXT UNIQUE NOT NULL,
    link_grupo TEXT NOT NULL,
    ativo BOOLEAN NOT NULL DEFAULT true,
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
    atualizado_por TEXT DEFAULT 'coordenacao'
);

-- Popula links padrão administráveis se não existirem
INSERT INTO public.configuracoes_whatsapp (sub, link_grupo, ativo)
VALUES
    ('Verde', 'https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=verde', true),
    ('Vermelho', 'https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=vermelho', true),
    ('Amarelo', 'https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=amarelo', true),
    ('Laranja', 'https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?sub=laranja', true),
    ('Geral', 'https://chat.whatsapp.com/F0aBlRgma3LDGFFG9WrZF6?s=cl&p=i&mlu=0', true)
ON CONFLICT (sub) DO NOTHING;

-- Adiciona coluna de e-mail na tabela de inscrições se ausente
ALTER TABLE public.inscricoes ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_inscricoes_email ON public.inscricoes(email);

-- Função RPC: Criar transação no Checkout Unificado
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
    v_inscricao_id UUID := p_inscricao_id;
BEGIN
    -- Se inscricao_id não foi passado, tenta inferir automaticamente por whatsapp ou email
    IF v_inscricao_id IS NULL THEN
        SELECT id INTO v_inscricao_id
        FROM public.inscricoes
        WHERE (p_whatsapp_pagador IS NOT NULL AND p_whatsapp_pagador <> '' AND whatsapp = p_whatsapp_pagador)
           OR (p_email IS NOT NULL AND p_email <> '' AND LOWER(email) = LOWER(p_email))
        ORDER BY criado_em DESC
        LIMIT 1;
    END IF;

    INSERT INTO public.pagamentos (
        txid, nome_pagador, email, whatsapp_pagador, cpf_pagador, valor,
        metodo, parcelas, cartao_ultimos_digitos, cartao_bandeira,
        status, tipo, pix_copia_e_cola, qr_code_base64, expiracao,
        inscricao_id, metadata, gateway_transaction_id
    ) VALUES (
        p_txid, p_nome_pagador, COALESCE(p_email, ''), p_whatsapp_pagador, p_cpf_pagador, p_valor,
        p_metodo, p_parcelas, p_cartao_ultimos_digitos, p_cartao_bandeira,
        p_status, p_tipo, p_pix_copia_e_cola, p_qr_code_base64, p_expiracao,
        v_inscricao_id, p_metadata, p_txid
    )
    ON CONFLICT (txid) DO UPDATE
    SET valor = EXCLUDED.valor,
        status = EXCLUDED.status,
        inscricao_id = COALESCE(EXCLUDED.inscricao_id, public.pagamentos.inscricao_id),
        email = CASE WHEN EXCLUDED.email <> '' THEN EXCLUDED.email ELSE public.pagamentos.email END,
        whatsapp_pagador = COALESCE(EXCLUDED.whatsapp_pagador, public.pagamentos.whatsapp_pagador),
        atualizado_em = now()
    RETURNING id INTO v_pagamento_id;

    -- Registra auditoria da transação
    INSERT INTO public.auditoria_transacoes (
        transacao_id, acao, status_anterior, status_novo, executado_por, detalhes
    ) VALUES (
        p_txid, 'criado', NULL, p_status, 'checkout',
        json_build_object('metodo', p_metodo, 'valor', p_valor, 'email', p_email, 'inscricao_id', v_inscricao_id)
    );

    RETURN json_build_object(
        'success', true,
        'id', v_pagamento_id,
        'txid', p_txid,
        'status', p_status,
        'inscricao_id', v_inscricao_id
    );
END;
$$;

-- Função RPC: Confirmar pagamento unificado (Pix ou Cartão)
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
    v_target_inscricao_id UUID;
BEGIN
    SELECT * INTO v_pagamento FROM public.pagamentos WHERE txid = p_txid FOR UPDATE;
    IF NOT FOUND THEN
        RETURN json_build_object('success', false, 'message', 'Transação não encontrada.');
    END IF;

    -- Idempotência: se já aprovado, retorna sucesso sem duplicar efeitos
    IF v_pagamento.status = 'approved' OR v_pagamento.status = 'confirmado' THEN
        RETURN json_build_object(
            'success', true,
            'status', 'approved',
            'txid', p_txid,
            'inscricao_id', v_pagamento.inscricao_id,
            'mensagem', 'Já confirmado previamente.',
            'already_confirmed', true
        );
    END IF;

    v_status_antigo := v_pagamento.status;
    v_target_inscricao_id := v_pagamento.inscricao_id;

    -- Se não tinha inscricao_id vinculado, busca reconciliação por whatsapp ou email
    IF v_target_inscricao_id IS NULL THEN
        SELECT id INTO v_target_inscricao_id
        FROM public.inscricoes
        WHERE (v_pagamento.whatsapp_pagador IS NOT NULL AND v_pagamento.whatsapp_pagador <> '' AND whatsapp = v_pagamento.whatsapp_pagador)
           OR (v_pagamento.email IS NOT NULL AND v_pagamento.email <> '' AND LOWER(email) = LOWER(v_pagamento.email))
        ORDER BY criado_em DESC
        LIMIT 1;
    END IF;

    UPDATE public.pagamentos
    SET status = 'approved',
        pago_em = now(),
        gateway = p_gateway,
        payload_webhook = p_payload,
        inscricao_id = COALESCE(v_target_inscricao_id, v_pagamento.inscricao_id),
        atualizado_em = now()
    WHERE id = v_pagamento.id;

    -- Se vinculado a uma inscrição, atualiza status da inscrição
    IF v_target_inscricao_id IS NOT NULL THEN
        UPDATE public.inscricoes
        SET pagamento_status = 'confirmado',
            pagamento_confirmado_em = now(),
            forma_pagamento = v_pagamento.metodo,
            observacao_pagamento = 'Pagamento aprovado via Checkout Unificado (' || UPPER(v_pagamento.metodo) || ').',
            atualizado_em = now()
        WHERE id = v_target_inscricao_id;
    END IF;

    -- Registra auditoria
    INSERT INTO public.auditoria_transacoes (
        transacao_id, acao, status_anterior, status_novo, executado_por, detalhes
    ) VALUES (
        p_txid, 'aprovado', v_status_antigo, 'approved', p_executado_por,
        json_build_object('gateway', p_gateway, 'metodo', v_pagamento.metodo, 'valor', v_pagamento.valor, 'inscricao_id', v_target_inscricao_id)
    );

    RETURN json_build_object(
        'success', true,
        'status', 'approved',
        'txid', p_txid,
        'inscricao_id', v_target_inscricao_id
    );
END;
$$;

-- RLS para Checkout Unificado
ALTER TABLE public.pagamentos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auditoria_transacoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.configuracoes_whatsapp ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Inserção pública de pagamentos" ON public.pagamentos;
CREATE POLICY "Inserção pública de pagamentos" ON public.pagamentos FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Leitura pública de pagamentos por txid" ON public.pagamentos;
CREATE POLICY "Leitura pública de pagamentos por txid" ON public.pagamentos FOR SELECT USING (true);

DROP POLICY IF EXISTS "Atualização pública de pagamentos" ON public.pagamentos;
CREATE POLICY "Atualização pública de pagamentos" ON public.pagamentos FOR UPDATE USING (true);

DROP POLICY IF EXISTS "Inserção de auditoria" ON public.auditoria_transacoes;
CREATE POLICY "Inserção de auditoria" ON public.auditoria_transacoes FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Leitura de auditoria" ON public.auditoria_transacoes;
CREATE POLICY "Leitura de auditoria" ON public.auditoria_transacoes FOR SELECT USING (true);

DROP POLICY IF EXISTS "Leitura pública de links whatsapp" ON public.configuracoes_whatsapp;
CREATE POLICY "Leitura pública de links whatsapp" ON public.configuracoes_whatsapp FOR SELECT USING (true);

DROP POLICY IF EXISTS "Atualização de links whatsapp" ON public.configuracoes_whatsapp;
CREATE POLICY "Atualização de links whatsapp" ON public.configuracoes_whatsapp FOR UPDATE USING (true);

DROP POLICY IF EXISTS "Inserção de links whatsapp" ON public.configuracoes_whatsapp;
CREATE POLICY "Inserção de links whatsapp" ON public.configuracoes_whatsapp FOR INSERT WITH CHECK (true);

-- ==============================================================================
-- 13. GESTÃO CENTRALIZADA DE PREÇOS E PIX (ADMIN FINANCEIRO)
-- ==============================================================================

-- Tabela de configurações financeiras versionada
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

-- Tabela de lotes de inscrição
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
SELECT '1º Lote', 50.00, true
WHERE NOT EXISTS (
    SELECT 1 FROM public.lotes_inscricao WHERE nome = '1º Lote'
);

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

-- Tabela de histórico e auditoria de alterações financeiras
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

-- Função RPC: Obter configuração financeira ativa
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

-- Função RPC: Atualizar configuração financeira com auditoria e versionamento
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
    IF v_atual.valor_inscricao IS DISTINCT FROM p_valor_inscricao AND p_valor_inscricao IS NOT NULL THEN
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
    IF v_atual.pix_chave IS DISTINCT FROM p_pix_chave AND p_pix_chave IS NOT NULL THEN
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
    IF v_atual.pix_beneficiario IS DISTINCT FROM p_pix_beneficiario AND p_pix_beneficiario IS NOT NULL THEN
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
        'valor_inscricao', COALESCE(p_valor_inscricao, v_atual.valor_inscricao, 50.00),
        'pix_chave', COALESCE(p_pix_chave, v_atual.pix_chave, 'leoeuler03@gmail.com')
    );
END;
$$;

-- RLS para Gestão Financeira
ALTER TABLE public.configuracoes_financeiras ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lotes_inscricao ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.historico_configuracoes_financeiras ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Leitura publica de configuracoes financeiras ativas" ON public.configuracoes_financeiras;
CREATE POLICY "Leitura publica de configuracoes financeiras ativas" 
ON public.configuracoes_financeiras 
FOR SELECT 
USING (ativo = true);

DROP POLICY IF EXISTS "Modificacao administrativa de configuracoes financeiras" ON public.configuracoes_financeiras;
CREATE POLICY "Modificacao administrativa de configuracoes financeiras" 
ON public.configuracoes_financeiras 
FOR ALL 
USING (true) 
WITH CHECK (true);

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

-- ==============================================================================
-- 14. CONCESSÃO EXPLÍCITA DE PRIVILÉGIOS (GRANTS)
-- ==============================================================================
GRANT ALL ON TABLE public.subs TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.inscricoes TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.pagamentos TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.auditoria_transacoes TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.configuracoes_whatsapp TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.configuracoes_financeiras TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.lotes_inscricao TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.historico_configuracoes_financeiras TO anon, authenticated, service_role;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'pagamentos_pix') 
       OR EXISTS (SELECT 1 FROM information_schema.views WHERE table_schema = 'public' AND table_name = 'pagamentos_pix') THEN
        EXECUTE 'GRANT ALL ON TABLE public.pagamentos_pix TO anon, authenticated, service_role';
    END IF;
END $$;

DO $$
BEGIN
    EXECUTE 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role';
END $$;


