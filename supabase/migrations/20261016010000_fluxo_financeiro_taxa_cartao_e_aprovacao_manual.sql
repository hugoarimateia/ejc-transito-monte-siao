-- ==============================================================================
-- MIGRAÇÃO: 20261016010000_fluxo_financeiro_taxa_cartao_e_aprovacao_manual.sql
-- Adiciona taxa_cartao_1x na tabela configuracoes_financeiras
-- E garante rastreabilidade e integridade para aprovacoes manuais
-- ==============================================================================

-- 1. Adiciona coluna taxa_cartao_1x em public.configuracoes_financeiras
ALTER TABLE public.configuracoes_financeiras 
ADD COLUMN IF NOT EXISTS taxa_cartao_1x NUMERIC(10,2) DEFAULT 1.50;

-- 2. Atualiza registros ativos ou existentes para o padrão de R$ 1,50
UPDATE public.configuracoes_financeiras 
SET taxa_cartao_1x = 1.50 
WHERE taxa_cartao_1x IS NULL;

-- 3. Assegura permissão de service_role na RPC confirmar_pagamento_unificado
GRANT EXECUTE ON FUNCTION public.confirmar_pagamento_unificado(TEXT, TEXT, TEXT, JSONB) TO service_role;

-- 4. Comentário descritivo da migração
COMMENT ON COLUMN public.configuracoes_financeiras.taxa_cartao_1x IS 
'Taxa adicional padrão (em R$) cobrada do participante para pagamentos em cartão de crédito à vista (1x). Padrão: R$ 1,50.';
