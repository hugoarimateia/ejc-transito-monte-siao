-- ==============================================================================
-- MIGRATION: 20261010220000_validacao_whatsapp_e_prevencao_409.sql
-- 1. Validação prévia de WhatsApp na RPC pode_realizar_inscricao (evita upload desnecessário no R2)
-- 2. Tratamento resiliente de duplicidade e concorrência na RPC realizar_inscricao_com_link
-- Preserva estritamente a constraint inscricoes_whatsapp_unique, os dados existentes e o R2.
-- ==============================================================================

-- 1. ATUALIZAÇÃO DA RPC pode_realizar_inscricao COM SUPORTE A VALIDACAO DE WHATSAPP
CREATE OR REPLACE FUNCTION public.pode_realizar_inscricao(
    p_nome_completo text,
    p_sub text,
    p_whatsapp text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
    v_total_sub INT;
    v_capacidade INT;
    v_existe_nome INT;
    v_existe_whatsapp INT;
BEGIN
    SELECT s.capacidade
    INTO v_capacidade
    FROM public.subs s
    WHERE s.nome = p_sub;

    IF NOT FOUND THEN
        RETURN json_build_object('allowed', false, 'message', 'Sub Grupo não encontrado.');
    END IF;

    -- Conta apenas inscrições com pagamento confirmado e não arquivadas
    v_total_sub := public.obter_vagas_ocupadas_sub(p_sub);

    IF v_total_sub >= v_capacidade THEN
        RETURN json_build_object('allowed', false, 'message', 'As vagas deste Sub foram encerradas.');
    END IF;

    -- Validação de unicidade por nome completo
    SELECT COUNT(*)
    INTO v_existe_nome
    FROM public.inscricoes
    WHERE LOWER(TRIM(nome_completo)) = LOWER(TRIM(p_nome_completo))
      AND (arquivado IS NULL OR arquivado = false);

    IF v_existe_nome > 0 THEN
        RETURN json_build_object(
            'allowed', false,
            'conflict', 'nome',
            'message', 'Este nome já possui uma inscrição realizada.'
        );
    END IF;

    -- Validação de unicidade por WhatsApp (compara formato textual exato e dígitos limpos)
    IF p_whatsapp IS NOT NULL AND TRIM(p_whatsapp) <> '' THEN
        SELECT COUNT(*)
        INTO v_existe_whatsapp
        FROM public.inscricoes
        WHERE whatsapp = TRIM(p_whatsapp)
           OR (
               length(regexp_replace(p_whatsapp, '\D', '', 'g')) >= 10
               AND regexp_replace(whatsapp, '\D', '', 'g') = regexp_replace(p_whatsapp, '\D', '', 'g')
           );

        IF v_existe_whatsapp > 0 THEN
            RETURN json_build_object(
                'allowed', false,
                'conflict', 'whatsapp',
                'message', 'Já existe uma inscrição realizada com este número de WhatsApp.'
            );
        END IF;
    END IF;

    RETURN json_build_object('allowed', true, 'message', 'Inscrição liberada.');
END;
$function$;

GRANT EXECUTE ON FUNCTION public.pode_realizar_inscricao(text, text, text) TO anon, authenticated, service_role;


-- 2. ATUALIZAÇÃO DA RPC realizar_inscricao_com_link COM TRATAMENTO DE CONCORRÊNCIA E UNIQUE VIOLATION
CREATE OR REPLACE FUNCTION public.realizar_inscricao_com_link(
    p_nome_completo text,
    p_sub text,
    p_whatsapp text,
    p_modelo_camisa text,
    p_tamanho_camisa text,
    p_quer_camisa_adicional boolean,
    p_quantidade_camisas_adicionais integer,
    p_modelo_camisa_adicional text,
    p_tamanho_camisa_adicional text,
    p_talento text,
    p_foto_caminho text,
    p_comprovante_caminho text,
    p_forma_pagamento text,
    p_pagamento_informado boolean,
    p_pagamento_status text,
    p_justificativa_pagamento text,
    p_observacao_pagamento text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'extensions'
AS $function$
DECLARE
    v_token TEXT;
    v_inscricao_id UUID;
    v_total_sub INT;
    v_capacidade INT;
BEGIN
    SELECT capacidade
    INTO v_capacidade
    FROM public.subs
    WHERE nome = p_sub
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Sub Grupo não encontrado.';
    END IF;

    -- Conta apenas inscrições com pagamento confirmado e não arquivadas
    v_total_sub := public.obter_vagas_ocupadas_sub(p_sub);

    IF v_total_sub >= v_capacidade THEN
        RAISE EXCEPTION 'limite de vagas atingido para este Sub (% vagas preenchidas)', v_capacidade;
    END IF;

    -- Verificação prévia de nome
    IF EXISTS (
        SELECT 1
        FROM public.inscricoes
        WHERE LOWER(TRIM(nome_completo)) = LOWER(TRIM(p_nome_completo))
          AND (arquivado IS NULL OR arquivado = false)
    ) THEN
        RETURN json_build_object(
            'success', false,
            'conflict', 'nome',
            'message', 'Este nome já possui uma inscrição realizada.'
        );
    END IF;

    -- Verificação prévia de whatsapp
    IF EXISTS (
        SELECT 1
        FROM public.inscricoes
        WHERE whatsapp = TRIM(p_whatsapp)
           OR (
               length(regexp_replace(p_whatsapp, '\D', '', 'g')) >= 10
               AND regexp_replace(whatsapp, '\D', '', 'g') = regexp_replace(p_whatsapp, '\D', '', 'g')
           )
    ) THEN
        RETURN json_build_object(
            'success', false,
            'conflict', 'whatsapp',
            'message', 'Já existe uma inscrição realizada com este número de WhatsApp.'
        );
    END IF;

    v_token := encode(gen_random_bytes(24), 'hex');

    -- Tentativa atômica de inserção protegida contra concorrência
    BEGIN
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
            p_forma_pagamento, p_pagamento_informado,
            CASE WHEN COALESCE(p_pagamento_informado, false) THEN 'informado' ELSE 'pendente' END,
            p_justificativa_pagamento, p_observacao_pagamento, v_token
        )
        RETURNING id INTO v_inscricao_id;
    EXCEPTION
        WHEN unique_violation THEN
            IF SQLERRM ILIKE '%inscricoes_whatsapp_unique%' THEN
                RETURN json_build_object(
                    'success', false,
                    'conflict', 'whatsapp',
                    'message', 'Já existe uma inscrição realizada com este número de WhatsApp.'
                );
            ELSIF SQLERRM ILIKE '%inscricao_unica_por_nome%' THEN
                RETURN json_build_object(
                    'success', false,
                    'conflict', 'nome',
                    'message', 'Este nome já possui uma inscrição realizada.'
                );
            ELSE
                RETURN json_build_object(
                    'success', false,
                    'conflict', 'unique',
                    'message', 'Já existe um cadastro com estes dados identificadores.'
                );
            END IF;
    END;

    RETURN json_build_object(
        'success', true,
        'id', v_inscricao_id,
        'token', v_token,
        'sub', p_sub
    );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.realizar_inscricao_com_link(text, text, text, text, text, boolean, integer, text, text, text, text, text, text, boolean, text, text, text) TO anon, authenticated, service_role;
