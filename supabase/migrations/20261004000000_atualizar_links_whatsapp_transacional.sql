-- Migration: 20261004000000_atualizar_links_whatsapp_transacional.sql
-- Objetivo: Operação transacional atômica e idempotente para atualização de links de WhatsApp (OP05)
-- Versão: ENV.14.0 (Corrigida: Idempotência de auditoria/metadados, SELECT STRICT, pg_advisory_xact_lock, regex case-insensitive e limite 500 chars)
-- ATENÇÃO: NÃO APLICAR EM PRODUÇÃO NESTA ETAPA (ENV.14.0). ARQUIVO VERSIONADO LOCALMENTE.

CREATE OR REPLACE FUNCTION public.atualizar_links_whatsapp_transacional(
  p_links JSONB,
  p_operador TEXT,
  p_ip TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item RECORD;
  v_canonical TEXT;
  v_active_id UUID;
  v_sub_id UUID;
  v_current_link_wpp TEXT;
  v_current_link_subs TEXT;
  v_link_clean TEXT;
  v_rows_wpp INT;
  v_rows_subs INT;
  v_updated_subs TEXT[] := ARRAY[]::TEXT[];
  v_processed_subs TEXT[] := ARRAY[]::TEXT[];
  v_any_change BOOLEAN := false;
  v_agora TIMESTAMPTZ := clock_timestamp();
  v_operador_safe TEXT := coalesce(nullif(trim(p_operador), ''), 'admin');
  v_ip_safe TEXT := coalesce(nullif(trim(p_ip), ''), '0.0.0.0');
BEGIN
  -- 1. Validação estrutural do JSON de entrada
  IF p_links IS NULL OR jsonb_typeof(p_links) <> 'object' OR p_links = '{}'::jsonb THEN
    RAISE EXCEPTION 'Payload de links inválido ou vazio.';
  END IF;

  -- 2. Serialização Concorrente Determinística via Lock Consultivo Transacional
  -- Garante que chamadas simultâneas não entrem em conflito de deadlock nem produzam escritas redundantes
  PERFORM pg_advisory_xact_lock(hashtext('atualizar_links_whatsapp_transacional'));

  -- 3. Itera em ORDEM ALFABÉTICA DETERMINÍSTICA para prevenção total contra deadlocks
  FOR v_item IN
    SELECT key AS sub_key, value#>>'{}' AS raw_val
    FROM jsonb_each(p_links)
    ORDER BY lower(trim(key)) ASC
  LOOP
    -- 3.1 Mapeamento e Whitelist Canônica estrita
    CASE lower(trim(v_item.sub_key))
      WHEN 'verde' THEN v_canonical := 'Verde';
      WHEN 'vermelho' THEN v_canonical := 'Vermelho';
      WHEN 'amarelo' THEN v_canonical := 'Amarelo';
      WHEN 'laranja' THEN v_canonical := 'Laranja';
      WHEN 'geral' THEN v_canonical := 'Geral';
      ELSE
        RAISE EXCEPTION 'Grupo não reconhecido no payload: %', v_item.sub_key;
    END CASE;

    -- 3.2 Prevenção contra chaves duplicadas/ambíguas no mesmo payload (ex: 'verde' e 'Verde')
    IF v_canonical = ANY(v_processed_subs) THEN
      RAISE EXCEPTION 'Grupo duplicado no payload: %', v_canonical;
    END IF;
    v_processed_subs := array_append(v_processed_subs, v_canonical);

    -- 3.3 Validação de URL Rigorosa: Comprimento, HTTPS, Hostnames Oficiais e Sem Caracteres Proibidos
    IF v_item.raw_val IS NULL OR length(trim(v_item.raw_val)) = 0 THEN
      RAISE EXCEPTION 'Link para o grupo % não pode ser vazio.', v_canonical;
    END IF;

    IF length(v_item.raw_val) > 500 THEN
      RAISE EXCEPTION 'Link para o grupo % excede o limite máximo de 500 caracteres.', v_canonical;
    END IF;

    -- Rejeição de espaços ou caracteres de controle (inclusive internos)
    IF v_item.raw_val ~ '[\s\r\n\t]' THEN
      RAISE EXCEPTION 'Link para o grupo % não pode conter espaços ou quebras de linha.', v_canonical;
    END IF;

    v_link_clean := trim(v_item.raw_val);

    -- Verificação estrita da autoridade: rejeita credenciais (@) e qualquer porta explícita (:porta, inclusive :443)
    -- Examina exclusivamente a autoridade entre https:// e o primeiro separador (/, ? ou #)
    IF v_link_clean ~* '^https:\/\/[^\/\?#]*[@:]' THEN
      RAISE EXCEPTION 'Link para o grupo % não pode conter portas explícitas ou credenciais de usuário.', v_canonical;
    END IF;

    -- Validação de estrutura completa: chat.whatsapp.com (com código de grupo) ou wa.me (com número de telefone)
    -- Permite query strings legítimas com parâmetros, vírgulas, exclamações e pontuações oficiais
    IF NOT (
      v_link_clean ~* '^https:\/\/chat\.whatsapp\.com\/(invite\/[A-Za-z0-9_\-]{5,64}|(?!invite(\/|\?|#|$))[A-Za-z0-9_\-]{5,64})\/?(\?[A-Za-z0-9_\-\.\?=&%#+\/,\!:]+)?(#.*)?$'
      OR
      v_link_clean ~* '^https:\/\/wa\.me\/(\+)?[0-9]{8,16}\/?(\?[A-Za-z0-9_\-\.\?=&%#+\/,\!:]+)?(#.*)?$'
    ) THEN
      RAISE EXCEPTION 'Link inválido para o grupo %: formato incompatível com os padrões oficiais de chat.whatsapp.com ou wa.me.', v_canonical;
    END IF;

    -- 3.4 Resolução Estrita com Bloqueio de Linha (SELECT INTO STRICT com FOR UPDATE)
    -- Dispara nativamente NO_DATA_FOUND se ausente e TOO_MANY_ROWS se houver duplicidade ativa
    BEGIN
      SELECT id, link_grupo INTO STRICT v_active_id, v_current_link_wpp
      FROM public.configuracoes_whatsapp
      WHERE lower(sub) = lower(v_canonical) AND ativo = true
      FOR UPDATE;
    EXCEPTION
      WHEN NO_DATA_FOUND THEN
        RAISE EXCEPTION 'Registro ativo para o grupo % não localizado.', v_canonical;
      WHEN TOO_MANY_ROWS THEN
        RAISE EXCEPTION 'Ambiguidade detectada: múltiplos registros ativos para o grupo %.', v_canonical;
    END;

    -- 3.5 Resolução Estrita na Tabela subs para Grupos de Equipe
    v_current_link_subs := NULL;
    IF v_canonical <> 'Geral' THEN
      BEGIN
        SELECT id, link_whatsapp INTO STRICT v_sub_id, v_current_link_subs
        FROM public.subs
        WHERE lower(nome) = lower(v_canonical)
        FOR UPDATE;
      EXCEPTION
        WHEN NO_DATA_FOUND THEN
          RAISE EXCEPTION 'Registro correspondente na tabela subs para a equipe % não encontrado.', v_canonical;
        WHEN TOO_MANY_ROWS THEN
          RAISE EXCEPTION 'Ambiguidade detectada: múltiplos registros na tabela subs para a equipe %.', v_canonical;
      END;
    END IF;

    -- 3.6 Comparação de Estado e Idempotência Real (Detecção de Mudança Efetiva)
    -- Se os dados já forem exatamente iguais no configuracoes_whatsapp E no subs, não altera timestamps nem metadata
    IF (v_current_link_wpp IS DISTINCT FROM v_link_clean) THEN
      UPDATE public.configuracoes_whatsapp
      SET link_grupo = v_link_clean,
          atualizado_em = v_agora,
          atualizado_por = v_operador_safe
      WHERE id = v_active_id;

      GET DIAGNOSTICS v_rows_wpp = ROW_COUNT;
      IF v_rows_wpp <> 1 THEN
        RAISE EXCEPTION 'Falha ao atualizar registro de % (linhas afetadas: %).', v_canonical, v_rows_wpp;
      END IF;

      v_any_change := true;
    END IF;

    -- Atualiza subs se houver divergência (mesmo que configuracoes_whatsapp já estivesse sincronizado)
    IF v_canonical <> 'Geral' AND (v_current_link_subs IS DISTINCT FROM v_link_clean) THEN
      UPDATE public.subs
      SET link_whatsapp = v_link_clean
      WHERE id = v_sub_id;

      GET DIAGNOSTICS v_rows_subs = ROW_COUNT;
      IF v_rows_subs <> 1 THEN
        RAISE EXCEPTION 'Falha ao sincronizar registro na tabela subs para a equipe % (linhas afetadas: %).', v_canonical, v_rows_subs;
      END IF;

      v_any_change := true;
    END IF;

    IF (v_current_link_wpp IS DISTINCT FROM v_link_clean) OR (v_canonical <> 'Geral' AND v_current_link_subs IS DISTINCT FROM v_link_clean) THEN
      v_updated_subs := array_append(v_updated_subs, v_canonical);
    END IF;
  END LOOP;

  -- 4. Gravação de Auditoria Apenas se Houver Mudança Efetiva (Idempotência de Log)
  IF v_any_change THEN
    INSERT INTO public.auditoria_transacoes (transacao_id, acao, executado_por, detalhes)
    VALUES (
      'OP05_' || to_char(v_agora, 'YYYYMMDD_HH24MISS'),
      'UPDATE_WHATSAPP_LINKS',
      v_operador_safe,
      jsonb_build_object(
        'links_updated', v_updated_subs,
        'operador', v_operador_safe,
        'ip_origem', v_ip_safe,
        'origem', 'postgres-rpc-transacional',
        'timestamp', v_agora
      )
    );

    RETURN jsonb_build_object(
      'success', true,
      'changed', true,
      'message', 'Links de WhatsApp atualizados com sucesso de forma atômica.',
      'updated_subs', v_updated_subs
    );
  ELSE
    -- Retorno com sucesso, mas sem poluir a tabela de auditoria nem alterar timestamps
    RETURN jsonb_build_object(
      'success', true,
      'changed', false,
      'message', 'Links de WhatsApp já estavam atualizados. Nenhuma alteração necessária.',
      'updated_subs', ARRAY[]::TEXT[]
    );
  END IF;
END;
$$;

-- Privilégios Mínimos (NÃO EXECUTAR EM PRODUÇÃO NESTA ETAPA)
REVOKE ALL ON FUNCTION public.atualizar_links_whatsapp_transacional(JSONB, TEXT, TEXT) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.atualizar_links_whatsapp_transacional(JSONB, TEXT, TEXT) FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.atualizar_links_whatsapp_transacional(JSONB, TEXT, TEXT) FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.atualizar_links_whatsapp_transacional(JSONB, TEXT, TEXT) TO service_role';
  END IF;
END $$;
