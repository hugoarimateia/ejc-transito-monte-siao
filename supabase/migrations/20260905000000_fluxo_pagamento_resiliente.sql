-- ==============================================================================
-- EJC - MIGRAÇÃO: FLUXO DE PAGAMENTO RESILIENTE, OBSERVABILIDADE E RECONCILIAÇÃO
-- 20260905000000_fluxo_pagamento_resiliente.sql
-- ==============================================================================

-- 1. Colunas de observabilidade de comprovante em pagamentos
ALTER TABLE public.pagamentos ADD COLUMN IF NOT EXISTS comprovante_email_enviado BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.pagamentos ADD COLUMN IF NOT EXISTS comprovante_email_em TIMESTAMPTZ;
ALTER TABLE public.pagamentos ADD COLUMN IF NOT EXISTS comprovante_email_erro TEXT;

-- 2. Coluna de confirmação em inscricoes se não existir
ALTER TABLE public.inscricoes ADD COLUMN IF NOT EXISTS pagamento_confirmado_em TIMESTAMPTZ;

-- 3. Função RPC: Criar transação no Checkout Unificado com auto-inferência de inscrição
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
        v_inscricao_id, p_metadata, COALESCE(p_metadata->>'payment_id', p_metadata->>'gateway_id', p_txid)
    )
    ON CONFLICT (txid) DO UPDATE
    SET valor = EXCLUDED.valor,
        status = EXCLUDED.status,
        inscricao_id = COALESCE(EXCLUDED.inscricao_id, public.pagamentos.inscricao_id),
        email = CASE WHEN EXCLUDED.email <> '' THEN EXCLUDED.email ELSE public.pagamentos.email END,
        whatsapp_pagador = COALESCE(EXCLUDED.whatsapp_pagador, public.pagamentos.whatsapp_pagador),
        metadata = COALESCE(EXCLUDED.metadata, public.pagamentos.metadata),
        gateway_transaction_id = COALESCE(EXCLUDED.gateway_transaction_id, public.pagamentos.gateway_transaction_id),
        atualizado_em = now()
    RETURNING id INTO v_pagamento_id;

    -- Registra auditoria da transação
    INSERT INTO public.auditoria_transacoes (
        transacao_id, acao, status_anterior, status_novo, executado_por, detalhes
    ) VALUES (
        p_txid, 'criado', NULL, p_status, 'checkout',
        json_build_object('metodo', p_metodo, 'valor', p_valor, 'email', p_email, 'inscricao_id', v_inscricao_id, 'order_id', p_metadata->>'order_id', 'payment_id', p_metadata->>'payment_id')
    );

    RETURN json_build_object(
        'success', true,
        'id', v_pagamento_id,
        'txid', p_txid,
        'status', p_status,
        'inscricao_id', v_inscricao_id,
        'order_id', p_metadata->>'order_id',
        'payment_id', p_metadata->>'payment_id'
    );
END;
$$;

-- 4. Função RPC: Confirmar pagamento unificado com reconciliação inteligente multicamadas
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
    v_clean_id TEXT := TRIM(p_txid);
BEGIN
    -- Busca multicamadas: aceita txid, payment_id, order_id, external_reference, gateway_transaction_id ou id primário
    SELECT * INTO v_pagamento 
    FROM public.pagamentos 
    WHERE txid = v_clean_id 
       OR gateway_transaction_id = v_clean_id 
       OR id::text = v_clean_id 
       OR metadata->>'payment_id' = v_clean_id 
       OR metadata->>'external_reference' = v_clean_id 
       OR metadata->>'order_id' = v_clean_id
    ORDER BY criado_em DESC
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN json_build_object('success', false, 'message', 'Transação não encontrada para o identificador fornecido: ' || v_clean_id);
    END IF;

    -- Idempotência: se já aprovado, retorna sucesso sem duplicar efeitos
    IF v_pagamento.status = 'approved' OR v_pagamento.status = 'confirmado' THEN
        RETURN json_build_object(
            'success', true,
            'status', 'approved',
            'txid', v_pagamento.txid,
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

    -- Se vinculado a uma inscrição, atualiza status da inscrição para confirmado
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
        v_pagamento.txid, 'aprovado', v_status_antigo, 'approved', p_executado_por,
        json_build_object(
            'gateway', p_gateway,
            'metodo', v_pagamento.metodo,
            'valor', v_pagamento.valor,
            'inscricao_id', v_target_inscricao_id,
            'payment_id', v_pagamento.metadata->>'payment_id',
            'order_id', v_pagamento.metadata->>'order_id'
        )
    );

    RETURN json_build_object(
        'success', true,
        'status', 'approved',
        'txid', v_pagamento.txid,
        'payment_id', v_pagamento.metadata->>'payment_id',
        'order_id', v_pagamento.metadata->>'order_id',
        'inscricao_id', v_target_inscricao_id
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.criar_transacao_checkout(TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, INT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, UUID, JSONB) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.confirmar_pagamento_unificado(TEXT, TEXT, TEXT, JSONB) TO anon, authenticated, service_role;
