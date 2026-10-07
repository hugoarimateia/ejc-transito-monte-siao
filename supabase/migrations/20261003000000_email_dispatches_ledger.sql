-- ==============================================================================
-- MIGRATION: 20261003000000_email_dispatches_ledger.sql
-- ETAPA ENV.7.4: Ledger de E-mail e Idempotencia Concorrente Atomica
-- ==============================================================================

-- 1. TABELA PRINCIPAL DE DISPAROS E IDEMPOTENCIA
CREATE TABLE IF NOT EXISTS public.email_dispatches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    recipient_email TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed', 'sent', 'failed')),
    claim_token UUID NOT NULL DEFAULT gen_random_uuid(),
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    claimed_by TEXT NOT NULL DEFAULT 'worker',
    sent_at TIMESTAMPTZ,
    message_id TEXT,
    attempts INTEGER NOT NULL DEFAULT 1,
    last_error TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_dispatches_key ON public.email_dispatches(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_email_dispatches_active_claim ON public.email_dispatches(status, claimed_at) WHERE status = 'claimed';
CREATE INDEX IF NOT EXISTS idx_email_dispatches_entity ON public.email_dispatches(entity_id, criado_em);
CREATE INDEX IF NOT EXISTS idx_email_dispatches_recipient ON public.email_dispatches(recipient_email, criado_em);

-- 2. TABELA DE RATE LIMIT POR IP
CREATE TABLE IF NOT EXISTS public.rate_limit_ip (
    ip INET NOT NULL,
    window_start TIMESTAMPTZ NOT NULL,
    hits INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (ip, window_start)
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_ip_cleanup ON public.rate_limit_ip(window_start);

-- 3. RLS EM AMBAS AS TABELAS
ALTER TABLE public.email_dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rate_limit_ip ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.email_dispatches OWNER TO postgres;
ALTER TABLE public.rate_limit_ip OWNER TO postgres;

-- 4. RPC: CLAIM ATOMICO COM LEASE E RETORNO SEGURO
CREATE OR REPLACE FUNCTION public.claim_email_dispatch(
    p_key TEXT,
    p_event_type TEXT,
    p_entity_id TEXT,
    p_recipient TEXT,
    p_worker_id TEXT DEFAULT 'edge_worker',
    p_lease_seconds INTEGER DEFAULT 300
) RETURNS JSONB AS $$
DECLARE
    v_new_claim_token UUID := gen_random_uuid();
    v_record public.email_dispatches;
    v_status TEXT;
    v_msg_id TEXT;
BEGIN
    INSERT INTO public.email_dispatches (
        idempotency_key,
        event_type,
        entity_id,
        recipient_email,
        status,
        claimed_at,
        claimed_by,
        claim_token,
        attempts
    ) VALUES (
        p_key,
        p_event_type,
        p_entity_id,
        p_recipient,
        'claimed',
        now(),
        p_worker_id,
        v_new_claim_token,
        1
    )
    ON CONFLICT (idempotency_key) DO UPDATE
    SET status = 'claimed',
        claimed_at = now(),
        claimed_by = p_worker_id,
        claim_token = v_new_claim_token,
        attempts = public.email_dispatches.attempts + 1,
        atualizado_em = now()
    WHERE (
        public.email_dispatches.status = 'failed'
        OR (
            public.email_dispatches.status = 'claimed'
            AND public.email_dispatches.claimed_at < now() - (p_lease_seconds || ' seconds')::interval
        )
    )
    RETURNING * INTO v_record;

    IF v_record.id IS NOT NULL THEN
        RETURN jsonb_build_object(
            'claimed', true,
            'claim_token', v_record.claim_token,
            'brevo_uuid', v_record.id,
            'status', v_record.status,
            'attempts', v_record.attempts
        );
    END IF;

    SELECT status, message_id INTO v_status, v_msg_id
    FROM public.email_dispatches
    WHERE idempotency_key = p_key;

    IF v_status = 'claimed' THEN
        v_status := 'in_progress';
    END IF;

    RETURN jsonb_build_object(
        'claimed', false,
        'status', COALESCE(v_status, 'in_progress'),
        'message_id', v_msg_id
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- 5. RPC: FINISH ATOMICO
CREATE OR REPLACE FUNCTION public.finish_email_dispatch(
    p_key TEXT,
    p_claim_token UUID,
    p_message_id TEXT
) RETURNS BOOLEAN AS $$
BEGIN
    UPDATE public.email_dispatches
    SET status = 'sent',
        sent_at = now(),
        message_id = p_message_id,
        atualizado_em = now()
    WHERE idempotency_key = p_key
      AND claim_token = p_claim_token
      AND status = 'claimed';

    RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- 6. RPC: RELEASE ATOMICO
CREATE OR REPLACE FUNCTION public.release_email_dispatch(
    p_key TEXT,
    p_claim_token UUID,
    p_error TEXT
) RETURNS BOOLEAN AS $$
BEGIN
    UPDATE public.email_dispatches
    SET status = 'failed',
        last_error = p_error,
        atualizado_em = now()
    WHERE idempotency_key = p_key
      AND claim_token = p_claim_token
      AND status = 'claimed';

    RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- 7. SECURITY: OWNERSHIP E REVOGACAO/CONCESSAO DE EXECUTE
ALTER FUNCTION public.claim_email_dispatch(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER) OWNER TO postgres;
ALTER FUNCTION public.finish_email_dispatch(TEXT, UUID, TEXT) OWNER TO postgres;
ALTER FUNCTION public.release_email_dispatch(TEXT, UUID, TEXT) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.claim_email_dispatch(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_email_dispatch(TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_email_dispatch(TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_email_dispatch(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_email_dispatch(TEXT, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_email_dispatch(TEXT, UUID, TEXT) TO service_role;
