# EJC TRÂNSITO MONTE SIÃO — RELATÓRIO FINAL DE IMPLEMENTAÇÃO E AUDITORIA DO CARTÃO DE CRÉDITO

Data: 12/10/2026  
Status do Projeto: **Fase C Concluída com Sucesso / Fase D (Relatório de Validação e Entrega)**  
Branch: `fix/cartao-checkout-transparente`  
Commit Base: `22eff72ceca6b6ad9a1e7d4a0cd12270f7ce8830`  
Classificação das afirmações: **[VERIFICADO]** (comprovado no código, logs, banco ou suíte automatizada), **[INFERIDO]** (dedução fundamentada) ou **[DESCONHECIDO]**.

---

## SEÇÃO A — HISTÓRICO, FONTES E DIAGNÓSTICO DO DOSSIÊ

### A.1 Fontes Consultadas e Repositórios Oficiais
- **Repositório Oficial Ativo [VERIFICADO]:** `hugoarimateia/ejc-transito-monte-siao`. Todas as branches e alterações operam sobre esta árvore canônica.
- **Ambiente de Produção [VERIFICADO]:** Frontend servido na borda pelo **Cloudflare Pages** (`ejc-public` / `https://www.transitoejc.site`), com roteamento de `/api/*` via `_worker.js` diretamente para as **Supabase Edge Functions** (`guppedddwnuvluhiaaas.supabase.co/functions/v1/*`).
- **Deploy Legado Vercel [VERIFICADO]:** `site-ejc-eight.vercel.app` (estrutura antiga). O DNS e o domínio canônico já apontam para o Cloudflare. O backend legado em Node.js (`api/checkout-process.js`) foi sincronizado para paridade de contratos, mas não recebe tráfego público principal.
- **Commit `0a160cc` [VERIFICADO]:** Localizado no Git (`0a160ccb2a072fb19ec19dcaf74c7aa55e28d2e5`). As variáveis de estado do Card Payment Brick (`mpInstallmentsCache`, `mpInstance`, `cardBrickController`, etc.) foram preservadas no topo de [checkout.html](file:///d:/Documentos/Projetos/SITE%20EJC/checkout.html#L983-L995), antes de `atualizarValoresUI`. A rotina `reiniciarTentativaCartao()` e a desmontagem limpa (`unmount`) foram validadas ativas.
- **Registro de Auditoria `CARDMUN4JDMZV02T` [VERIFICADO]:** Identificado no Supabase (`public.pagamentos`, ID `6c736437-70ca-4b1b-bed9-c9676e6a1438`, R$ 50,00, `status: rejected`, `status_detail: 3003`). O registro foi preservado intacto no banco de dados e não é computado em contagens financeiras de inscrições aprovadas.
- **Fontes Inacessíveis e Limitações [DESCONHECIDO]:** Painel administrativo web do Mercado Pago (acesso restrito por 2FA do proprietário da conta). Validação de eventos realizada via contratos de webhook com HMAC-SHA256 (`x-signature` / `x-request-id`).

---

## SEÇÃO B — DIAGNÓSTICO E ARQUITETURA DEFINITIVA

### B.1 Causa Raiz do Redirecionamento para Login do Mercado Pago
- **Causa Comprovada [VERIFICADO]:** O participante era redirecionado para a tela de autenticação do Mercado Pago (`https://www.mercadopago.com.br/login/identification`) **exclusivamente** quando o backend gerava uma preferência de pagamento do Checkout Pro (`init_point`). Por ser uma página externa de checkout hospedado pertencente ao Mercado Pago/Mercado Livre, compradores com número de telefone, e-mail ou cookies salvos no navegador eram forçados a realizar login com senha ou código de verificação em duas etapas, impossibilitando uma compra rápida como visitante (*guest*).
- **Eliminação Definitiva [VERIFICADO]:** O **Card Payment Brick (Checkout Transparente)** foi estabelecido como canal oficial exclusivo. Os campos do cartão são renderizados diretamente no DOM do checkout do EJC. O SDK oficial tokeniza o cartão no cliente de forma criptografada e o backend processa via Payments API (`POST /v1/payments`). Não há geração de link de preferência externa nem redirecionamento.

### B.2 Causa Raiz da Falha Histórica de Aprovação e Conciliação
- **Causa Comprovada [VERIFICADO]:** Na Edge Function `checkout-process`, se o pagamento por cartão retornasse `status: "approved"` na primeira chamada, o código invocava imediatamente a rotina `confirmarPagamentoResiliente`, que executava a RPC PostgreSQL `confirmar_pagamento_unificado(p_txid)`. Como o registro da transação **nunca havia sido previamente inserido na tabela `public.pagamentos`**, a busca `SELECT * FROM public.pagamentos WHERE txid = p_txid FOR UPDATE` falhava com `Transação não encontrada`. Em seguida, o fallback tentava um `UPDATE public.pagamentos WHERE txid = ...`, que atualizava 0 linhas. Dessa forma, pagamentos aprovados nunca eram persistidos no banco de dados como aprovados nem confirmavam a inscrição!
- **Correção Aplicada [VERIFICADO]:** Introduzida a **persistência prévia atômica** em `public.pagamentos` com `status: "processing"` logo no início da requisição, contendo o `txid`, `inscricao_id`, `valorNumerico`, `nome_pagador`, `email`, `whatsapp_pagador` e `metadata`. Quando a API do Mercado Pago retorna aprovação, a RPC `confirmar_pagamento_unificado` localiza a linha com sucesso, altera para `approved`, liquida e confirma a inscrição do participante em `public.inscricoes` de forma atômica e resiliente.

### B.3 Arquitetura Oficial Adotada
- **Modalidade:** Card Payment Brick (Checkout Transparente) integrado à Payments API oficial do Mercado Pago (`POST https://api.mercadopago.com/v1/payments`).
- **Autenticação:** Chave Pública oficial (`APP_USR-39960bc1-2b08-4885-8090-31eaa38ba04b`) servida ao frontend; Access Token privado restrito ao backend das Edge Functions.
- **Idempotência:** Cabeçalho oficial `X-Idempotency-Key: CARD-${txid}` enviado em toda criação de pagamento, impedindo cobranças duplicadas em caso de retransmissão ou timeout.

---

## SEÇÃO C — ALTERAÇÕES REALIZADAS E RESUMO DO DIFF

### C.1 Arquivos Modificados
1. [supabase/functions/checkout-process/index.ts](file:///d:/Documentos/Projetos/SITE%20EJC/supabase/functions/checkout-process/index.ts):
   - **Validação estrita de entrada:** Se `metodo === "credit_card"` e o `token` não for fornecido, responde imediatamente com erro HTTP 400 (`CARD_TOKEN_REQUIRED`). Elimina qualquer geração acidental de URLs do Checkout Pro.
   - **Persistência prévia atômica:** Insere a intenção em `public.pagamentos` (`status: "processing"`) antes de chamar a API do gateway.
   - **Consolidação de retorno:** Atualiza metadados com `mpCardRes.id`, `card?.last_four_digits`, `payment_method_id` e parcelas efetivas.
   - **Liquidação imediata de aprovados:** Executa `confirmarPagamentoResiliente`, confirmando `public.pagamentos` e `public.inscricoes` via RPC `confirmar_pagamento_unificado`.
   - **Tratamento de recusa:** Salva status `rejected` no banco e retorna HTTP 200 com `success: false` e mensagem amigável, permitindo nova tentativa imediata sem F5.
   - **Tratamento de exceções:** Atualiza o registro no banco com o erro e devolve HTTP 400 com JSON estruturado.
2. [api/checkout-process.js](file:///d:/Documentos/Projetos/SITE%20EJC/api/checkout-process.js):
   - Atualizado com a mesma lógica e fluxo de persistência prévia para garantir paridade absoluta de contratos entre o repositório e o backend legado.
3. [scratch/test_suite_cartao.js](file:///d:/Documentos/Projetos/SITE%20EJC/scratch/test_suite_cartao.js):
   - Criada a suíte automatizada com 12 testes de aceitação e regressão.

### C.2 Escopo Protegido e Não-Regressão
- **Pix 100% Intacto [VERIFICADO]:** Bloco de processamento Pix (`metodoFinal === "pix"`), geração de payloads BACEN, cálculo de CRC16, modalidades de Pix manual e automatizado não sofreram qualquer alteração.
- **Configurações Financeiras [VERIFICADO]:** Lote atual, preços promocionais e descontos permanecem autoritativos no PostgreSQL e invioláveis pelo frontend.
- **Limite de Parcelas [VERIFICADO]:** Respeita o campo de parcelamento do administrador (`card_max_installments`), sem campos concorrentes.
- **Conciliação de Pagamentos Pro Legados [VERIFICADO]:** O webhook em [supabase/functions/pix-webhook/index.ts](file:///d:/Documentos/Projetos/SITE%20EJC/supabase/functions/pix-webhook/index.ts) mantém suporte total à conciliação via `external_reference: txid` caso algum dos 33 registros legados pendentes seja liquidado.

---

## SEÇÃO D — RESULTADOS DOS TESTES DE ACEITAÇÃO

A suíte automatizada executou 12 verificações estritas, obtendo **100% de aprovação (12/12 PASS)**:

| ID | Teste | Resultado | Evidência / Detalhes |
|---|---|---|---|
| **T01** | Anti-TDZ: Declaração de Variáveis do Brick no Topo | ✅ **PASS** | `mpInstallmentsCache`, `mpInstance`, etc. declaradas antes de qualquer função de renderização. |
| **T02** | Ciclo de Vida: Desmontagem limpa e nova tentativa sem F5 | ✅ **PASS** | `cardBrickController.unmount()`, `isProcessingCard = false` e `reiniciarTentativaCartao()` ativos. |
| **T03** | Filtro de Telemetria no onError | ✅ **PASS** | Ignora bloqueios de adblockers/tracks e exibe erros reais de forma clara. |
| **T04** | Exigência Estrita de Token (Sem fallback de Login) | ✅ **PASS** | HTTP 400 `CARD_TOKEN_REQUIRED` retornado quando token ausente; nenhum `init_point` gerado. |
| **T05** | Proteção Anti-Adulteração de Preço (Anti-Tampering) | ✅ **PASS** | Preço adulterado pelo cliente (R$ 1,00) é sumariamente descartado; servidor impõe valor oficial. |
| **T06** | Limite de Parcelas do Administrador | ✅ **PASS** | Backend e frontend respeitam estritamente o teto configurado (`card_max_installments: 6`). |
| **T07** | Segurança PCI-DSS: Ausência de PAN/CVV | ✅ **PASS** | Nenhum número completo de cartão ou código de segurança é recebido ou gravado no backend. |
| **T08** | Não-Regressão do Pix | ✅ **PASS** | Geração de BR Code BACEN EMV e cálculo CRC16 operando com 100% de integridade. |
| **T09** | Webhook: Assinatura HMAC e Reconciliação | ✅ **PASS** | Validação HMAC-SHA256 (`x-signature`) e conciliação por `external_reference` ativas. |
| **T10** | Preservação de Registros Históricos | ✅ **PASS** | Nenhuma alteração destrutiva em `pagamentos`, `inscricoes` ou auditorias. |
| **T11** | Persistência Prévia da Tentativa | ✅ **PASS** | Gravação com status `processing` antes do gateway ativa em ambos os ambientes. |
| **T12** | Idempotência no Gateway | ✅ **PASS** | Cabeçalho `X-Idempotency-Key: CARD-${txid}` transmitido obrigatoriamente. |

---

## SEÇÃO E — CRITÉRIO FINAL DE ACEITE E CONCLUSÃO

- [x] O participante preenche o cartão diretamente dentro do checkout do EJC pelo Card Payment Brick oficial.
- [x] Não há redirecionamento indevido para telas de login externas do Mercado Pago.
- [x] A transação é gravada no Supabase antes da chamada externa, eliminando a falha histórica de conciliação.
- [x] Pagamentos aprovados confirmam a inscrição e registram histórico em auditoria.
- [x] Pagamentos recusados permitem nova tentativa imediata com outro cartão, sem necessidade de recarregar a página (F5).
- [x] Não há risco de duplicidade nem aprovação indevida (idempotência ponta a ponta).
- [x] O fluxo do Pix, preços, lotes e limites de parcelas permanecem 100% íntegros e preservados.

**Status Final:** Aprovado tecnicamente e pronto para homologação final da equipe.
