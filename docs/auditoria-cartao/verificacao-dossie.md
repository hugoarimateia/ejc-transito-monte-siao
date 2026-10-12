# EJC TRÂNSITO MONTE SIÃO — AUDITORIA E VERIFICAÇÃO DO DOSSIÊ DO CARTÃO DE CRÉDITO

Data de elaboração: 12/10/2026  
Ambiente: Cloudflare Pages (`transito-ejc` / `ejc-public`), Supabase PostgreSQL & Edge Functions (`guppedddwnuvluhiaaas`), Mercado Pago API v1  
Branch de trabalho: `fix/cartao-checkout-transparente`  
Commit base de auditoria: `22eff72ceca6b6ad9a1e7d4a0cd12270f7ce8830`

---

## 1. INVENTÁRIO DE FONTES DE INFORMAÇÃO (A1)

| Fonte | Caminho / Referência | Acessada? | Relevância |
|---|---|---|---|
| **Artefatos Antigravity (Sessão 9830c12d)** | `C:\Users\hugoa\.gemini\antigravity-ide\brain\9830c12d-1e45-433d-ba98-e9d89af3d0f2` (`relatorio_correcao_checkout.md`, `relatorio_final_frentes_ejc.md`) | Sim [VERIFICADO] | **Crítica**: Contém os relatórios da Fase 1 a 4 sobre `mpInstallmentsCache`, ciclo de vida do Brick e erro 3003. |
| **Artefatos Antigravity (Sessão c1136f96)** | `C:\Users\hugoa\.gemini\antigravity-ide\brain\c1136f96-7bc5-478d-a467-3b2695f660d2` (`op08_relatorio_auditoria_funcional.md`) | Sim [VERIFICADO] | **Alta**: Contém a auditoria da migração Vercel → Cloudflare/Supabase e reconciliação financeira. |
| **Commit `0a160cc` (Git)** | Commit SHA `0a160ccb2a072fb19ec19dcaf74c7aa55e28d2e5` | Sim [VERIFICADO] | **Crítica**: Commit do reparo anti-TDZ e desmontagem do Card Brick em `checkout.html`. |
| **Commit `ef492eb` (Git)** | Commit SHA `ef492eb...` ("feat(checkout): implementacao Mercado Pago Checkout Pro...") | Sim [VERIFICADO] | **Alta**: Implementação inicial da tentativa de desvio para Checkout Pro via preference. |
| **Commit `241f0ad` (Git)** | Commit SHA `241f0ad798c3a61a07fe9c4f770e8a17607539ab` | Sim [VERIFICADO] | **Alta**: Tentativa de contornar o login do Mercado Pago removendo e-mail/telefone do `payer` no Checkout Pro. |
| **Commit `92dfe3f` (Git)** | Commit SHA `92dfe3fd8c283e545d81519cd7e30680cc5b6d3f` | Sim [VERIFICADO] | **Crítica**: Reativação do Card Payment Brick (Checkout Transparente) no checkout oficial. |
| **Commit `5e347e5` (Git)** | Commit SHA `5e347e5c2fba8af7c800dfe2cd5091a22c8024cd` | Sim [VERIFICADO] | **Alta**: Ajuste para retornar HTTP 400 em vez de 502 nas Edge Functions para evitar interceptação Cloudflare. |
| **Frontend Checkout** | `checkout.html` | Sim [VERIFICADO] | **Crítica**: Interface oficial do checkout, carregamento do SDK MP v2 e ciclo de vida do Brick. |
| **Worker / Proxy Cloudflare** | `scripts/build-public-dist.js` (`_worker.js`) | Sim [VERIFICADO] | **Crítica**: Mapeamento e roteamento reverso de `/api/checkout-process` para Supabase Edge Function. |
| **Supabase Edge: Checkout** | `supabase/functions/checkout-process/index.ts` | Sim [VERIFICADO] | **Crítica**: Processamento de cartão, criação de pagamentos no MP e persistência no banco. |
| **Supabase Edge: Webhook** | `supabase/functions/pix-webhook/index.ts` | Sim [VERIFICADO] | **Crítica**: Webhook único oficial de notificações do Mercado Pago (Pix e Cartão), com HMAC-SHA256. |
| **Supabase Edge: Config** | `supabase/functions/public-config/index.ts` | Sim [VERIFICADO] | **Alta**: Fornecimento da Public Key do MP, taxas de parcelamento e regras ativas. |
| **Backend Legado Node/Vercel** | `api/checkout-process.js`, `api/_mercadopago.js`, `api/config.js` | Sim [VERIFICADO] | **Alta**: Código legado mantido para fallback ou paridade antes da migração para Edge Functions. |
| **Banco PostgreSQL Supabase** | `guppedddwnuvluhiaaas.supabase.co` (`public.pagamentos`, `public.inscricoes`) | Sim [VERIFICADO] | **Crítica**: Estado real dos registros de pagamento em produção. |
| **Documentação Oficial MP** | APIs `/v1/payments`, `/v1/payment_methods/installments`, Card Brick SDK JS v2 | Sim [VERIFICADO] | **Crítica**: Contratos oficiais da API do Mercado Pago. |
| **Painel Webhook Mercado Pago** | Configurações no Dashboard do Mercado Pago do organizador | Não acessível diretamente [INFERIDO / LACUNA] | **Média**: URL configurada no dashboard MP deve apontar para `/functions/v1/pix-webhook`. |

---

## 2. VERIFICAÇÃO DETALHADA DOS ITENS DO DOSSIÊ (SEÇÃO 3.3 E 3.5) (A4)

### 2.1 Commit `0a160cc`
- **Status:** **CONFIRMADO [VERIFICADO]**
- **Evidência no Git:**  
  Commit `0a160ccb2a072fb19ec19dcaf74c7aa55e28d2e5`, datado de 29/09/2026, com a mensagem:  
  `fix: inicializacao de mpInstallmentsCache e ciclo de vida do Card Payment Brick`.  
  Modificou apenas `checkout.html` (+60 linhas, -34 linhas).
- **Conteúdo do Diff:**  
  1. Declarou `const mpInstallmentsCache = {};`, `let mpInstance = null;`, `let cardBrickController = null;`, `let isInitializingBrick = false;`, `let isProcessingCard = false;`, `let cardPollingInterval = null;`, `let configLoadingState = "LOADING";` no início do script (linha 983 em diante), antes de qualquer função de renderização ou cálculo (`atualizarValoresUI`).  
  2. Implementou desmontagem limpa com `await cardBrickController.unmount()` em `montarCardPaymentBrick(forceRemount)`.  
  3. Adicionou filtro no callback `onError` para ignorar falhas com `type === "non_critical"` ou termos como `tracks`, `blocked_by_client` e `telemetry`.  
  4. Adicionou a rotina `reiniciarTentativaCartao()` que redefine `isProcessingCard = false` e remonta o Brick sem F5.
- **Sobrevivência na migração:** **CONFIRMADO [VERIFICADO]**  
  Todas essas correções estão presentes de forma idêntica no arquivo `checkout.html` atual (linhas 983–995, 2182–2214, 2509–2518, 2580–2587, 2737–2743).

---

### 2.2 Repositório Oficial Atual vs. Repositório Legado
- **Status:** **CONFIRMADO [VERIFICADO]**
- **Evidência:**  
  - Remotes Git configurados:
    - `origin`: `https://github.com/hugoarimateia/ejc-transito-monte-siao.git`
    - `backup`: `https://github.com/hugoarimateia/ejc-transito-monte-siao.git`
  - O repositório legado citado no dossiê (`hugoarimateia/site-ejc`) não é remoto ativo no workspace.
  - Workflows de CI/CD em `.github/workflows/deploy-public.yml` e `deploy-admin.yml` compilam o bundle e publicam diretamente no **Cloudflare Pages** (`ejc-public` / `transito-ejc` e `ejc-admin`).
  - As Edge Functions do backend rodam na infraestrutura oficial do Supabase (`guppedddwnuvluhiaaas.supabase.co`).

---

### 2.3 Modalidade Ativa em Produção
- **Status:** **CONFIRMADO [VERIFICADO]**
- **Evidência:**  
  - No HTML servido em produção (`https://www.transitoejc.site/checkout` e no arquivo `checkout.html` linhas 811 e 2426–2600):
    - O container do cartão é `<div id="cardPaymentBrick_container">`.
    - O JavaScript carrega o SDK v2 (`https://sdk.mercadopago.com/js/v2`).
    - Executa `montarCardPaymentBrick()` utilizando `bricksBuilder.create("cardPayment", ...)`.
    - Ao submeter o formulário (`onSubmit`), tokeniza os dados do cartão e envia via `POST /api/checkout-process` com o payload `{ metodo: "credit_card", token, installments, issuer_id, payment_method_id, ... }`.
  - **Conclusão:** A modalidade ativa no frontend em produção é o **Card Payment Brick (Checkout Transparente)**.  
  - O fluxo de Checkout Pro por redirecionamento foi desativado no frontend no commit `92dfe3f`, permanecendo no backend apenas como fallback residual quando nenhum token de cartão é fornecido.

---

### 2.4 Endpoints `/api/checkout-process` e `/api/config`
- **Status:** **CONFIRMADO [VERIFICADO]**
- **Evidência:**  
  - Em produção (Cloudflare Pages), o arquivo `_worker.js` (gerado por `scripts/build-public-dist.js`) atua como reverse proxy:
    - `/api/checkout-process` → Redireciona via proxy para `https://guppedddwnuvluhiaaas.supabase.co/functions/v1/checkout-process` (controlado pela feature flag `FEATURE_FLAG_CHECKOUT_PROCESS_EDGE`, default `ON`).
    - `/api/config` → Redireciona via proxy para `https://guppedddwnuvluhiaaas.supabase.co/functions/v1/public-config`.
  - Em `supabase/functions/checkout-process/index.ts`:
    - Quando recebe `token`, invoca a função `mpCriarPagamentoCartao(...)` chamando `POST https://api.mercadopago.com/v1/payments` com cabeçalho de idempotência `X-Idempotency-Key: CARD-${txid}`.
    - Quando NÃO recebe token, executa `mpCriarPreferenciaCheckoutPro(...)` gerando `init_point`.

---

### 2.5 Registro de Teste `CARDMUN4JDMZV02T`
- **Status:** **CONFIRMADO [VERIFICADO]**
- **Dados Reais Inspecionados no Supabase (`public.pagamentos`):**  
  - `id`: `6c736437-70ca-4b1b-bed9-ccfce1a00300`
  - `txid`: `CARDMUN4JDMZV02T`
  - `criado_em`: `2026-09-29T20:23:45.715Z`
  - `nome_pagador`: `Participante Teste Mestre`
  - `email`: `mestre@ejc.site`
  - `whatsapp_pagador`: `83999995555`
  - `valor`: `50.00`
  - `status`: `rejected`
  - `inscricao_id`: `null`
  - `metadata`: `{ "sub": "Geral", "lote": "1º Lote - Oficial", "token": "tokenizado_brick", "payment_id": null, "status_detail": 3003, "modo_parcelamento": "mercado_pago", "external_reference": "CARDMUN4JDMZV02T" }`
- **Natureza do Código 3003:**  
  - Conforme a documentação oficial da API do Mercado Pago, `3003` é um código de causa de erro de validação (HTTP 400 Bad Request): `Invalid card_token_id` (o token enviado era sintético/inválido).
  - O campo `payment_id` é `null`, comprovando que **nenhum pagamento foi criado nos servidores do Mercado Pago**.
  - O backend do EJC capturou a rejeição e gravou a tentativa como registro local com status `rejected`.
- **Impacto Financeiro:**  
  - Não afeta contagens operacionais de inscritos nem totais financeiros aprovados, pois queries administrativas filtram estritamente `status IN ('approved', 'confirmado', 'pago')` e `tipo = 'inscricao'`.
  - **Preservação:** O registro está intacto e NÃO será apagado ou alterado.

---

### 2.6 O Que Ficou Comprovado vs. Não Comprovado (Seção 3.5)
- **1. Pagamento de cartão aprovado de ponta a ponta:** **NUNCA OCORREU [VERIFICADO]**  
  Dos 34 registros de cartão existentes no Supabase em produção:
  - 1 registro é `rejected` (`CARDMUN4JDMZV02T`).
  - 33 registros são `pending` (preferências antigas do Checkout Pro).
  - **ZERO registros estão como `approved`**.
- **2. Causa da falha estrutural de aprovação no código:** **LOCALIZADA [VERIFICADO]**  
  No código de `supabase/functions/checkout-process/index.ts` (linhas 1933–1964):
  ```typescript
  const isCardApproved = mpCardRes.status === "approved";
  if (isCardApproved) {
    await confirmarPagamentoResiliente({
      txid: txid,
      gateway: "mercadopago_credit_card",
      payload: mpCardRes.raw as Record<string, unknown>,
      executado_por: "card_brick"
    });
  } else {
    await persistirTransacaoSupabase({ ... });
  }
  ```
  **Falha Crítica:** Se o pagamento for aprovado pelo Mercado Pago, o backend chama `confirmarPagamentoResiliente` SEM antes ter chamado `persistirTransacaoSupabase`!
  A função `confirmarPagamentoResiliente` executa a RPC `confirmar_pagamento_unificado` que faz:
  `SELECT * FROM public.pagamentos WHERE txid = p_txid FOR UPDATE;`
  Como a linha NUNCA foi inserida em `pagamentos`, a RPC retorna `Transação não encontrada`! O fallback de update atualiza 0 linhas! Consequentemente, o pagamento nunca seria gravado como aprovado no banco e a inscrição nunca seria confirmada!
- **3. Causa comprovada do redirecionamento para login:** **LOCALIZADA [VERIFICADO]**  
  O redirecionamento para login do Mercado Pago ocorria exclusivamente quando o sistema utilizava **Checkout Pro** (`init_point`), pois o fluxo hospedado do Mercado Pago intercepta visitantes e tenta autenticá-los se houver conta associada ou cookies prévios. No **Card Payment Brick (Checkout Transparente)**, os campos de cartão são incorporados via iframes protegidos diretamente na página do EJC, eliminando qualquer redirecionamento para o login do Mercado Pago.
- **4. Webhook para Cartão:** **PARCIALMENTE IMPLEMENTADO [VERIFICADO]**  
  A Edge Function `pix-webhook` atua como dispatcher unificado do Mercado Pago. Ela consulta `GET /v1/payments/{id}` e chama `confirmarPagamentoResiliente` para qualquer pagamento aprovado. Porém, devido ao mesmo defeito citado no item 2, se a transação do cartão não tiver sido persistida previamente em `public.pagamentos`, o webhook também falharia ao reconciliar por não encontrar o `txid`.

---

## 3. INVESTIGAÇÃO DOS 19 PROBLEMAS HISTÓRICOS (A2)

1. **Redirecionamento para login do Mercado Pago ao escolher cartão:**
   - *Ocorrência:* Usuários eram enviados para login ao clicar em pagar no Checkout Pro.
   - *Causa comprovada:* O Checkout Pro (`init_point`) é hospedado pelo Mercado Pago e força identificação/login.
   - *Solução efetiva:* Checkout Transparente via Card Payment Brick oficial diretamente em `checkout.html`.
2. **Falta de fluxo claro como visitante, sem exigir conta Mercado Pago:**
   - *Ocorrência:* Compradores não conseguiam pagar como convidados no Checkout Pro.
   - *Solução efetiva:* Card Payment Brick não exige conta nem login do Mercado Pago; o participante apenas digita o cartão no site do EJC.
3. **Falha de tokenização ou uso incorreto do SDK:**
   - *Ocorrência:* Chave pública inválida ou versão errada do SDK.
   - *Estado atual:* SDK v2 (`https://sdk.mercadopago.com/js/v2`) carregado com `APP_USR-39960bc1-2b08-4885-8090-31eaa38ba04b`.
4. **Erros na criação/processamento do pagamento no backend:**
   - *Ocorrência:* Exceções HTTP 502 da Cloudflare ao processar cartão.
   - *Estado atual:* Corrigido no commit `5e347e5` para retornar HTTP 400 com payload estruturado em caso de recusa.
5. **Parcelas, juros e valor final pouco confiáveis:**
   - *Ocorrência:* Divergência entre valor exibido e cobrado.
   - *Estado atual:* `carregarCondicoesParcelamentoMP` consulta `GET /v1/payment_methods/installments` em tempo real para exibir parcelas oficiais com timeout de 4,5s e cache local.
6. **Divergência entre taxas da API e as configuradas pelo administrador:**
   - *Ocorrência:* Suporte a modo comercial (manual) vs oficial (Mercado Pago).
   - *Estado atual:* O admin pode escolher `card_installment_mode`: `"mercado_pago"` ou `"manual"`. No modo oficial, as condições vêm direto da API.
7. **Botão que funciona só uma vez ou impede nova tentativa legítima:**
   - *Ocorrência:* Cartão recusado travava com spinner permanente, exigindo F5.
   - *Estado atual:* `reiniciarTentativaCartao()` e `onSubmit` rejeitando Promise permitem nova tentativa imediata sem recarregar a página.
8. **Pagamentos presos em "análise" ou "pendente":**
   - *Ocorrência:* Status `in_process` ou `pending` não realizava polling.
   - *Estado atual:* `checkout.html` possui `iniciarPollingCartao(txid)` que consulta `/api/checkout-process?txid=...` a cada 5 segundos por até 2 minutos.
9. **Transações criadas no Mercado Pago e não reconhecidas pela aplicação:**
   - *Ocorrência:* Pagamento aprovado no gateway mas não atualizado no Supabase.
   - *Causa comprovada:* Falta de persistência prévia da tentativa antes de chamar `confirmar_pagamento_unificado`.
10. **Associação incorreta entre pagamento e inscrição:**
    - *Ocorrência:* Pagamentos criados sem `inscricao_id` ou perdendo referência.
    - *Solução técnica:* Envio explícito de `inscricao_id` e amarração rígida via `external_reference: txid`.
11. **Webhooks ausentes, duplicados, fora de ordem ou sem atualizar o registro certo:**
    - *Ocorrência:* Falha na validação de webhooks.
    - *Estado atual:* `pix-webhook` valida HMAC-SHA256 (`x-signature`) e consulta a API oficial antes de liquidar.
12. **Risco de cobrança duplicada (clique repetido, timeout, reenvio):**
    - *Estado atual:* Protegido por flag `isProcessingCard` no frontend e `X-Idempotency-Key: CARD-${txid}` no backend.
13. **Fluxo que parecia funcionar no frontend, mas falhava no backend ou na persistência:**
    - *Estado atual:* Falha estrutural identificada no item 2.6 deste relatório (falta de gravação prévia de transação).
14. **Alterações no cartão que afetaram outras funções financeiras:**
    - *Prevenção:* O fluxo do Pix permanece 100% isolado; `metodoFinal === "pix"` e `metodoFinal === "credit_card"` possuem ramos estritamente independentes.
15. **Aviso "Pagamento com Cartão em Configuração" / Public Key não reconhecida:**
    - *Causa comprovada:* Ocorre quando `/api/config` não retorna a chave ou devolve valor placeholder (`sua_public_key_aqui`). No código atual, `public-config` retorna a chave canônica válida.
16. **`ReferenceError` por acesso a `mpInstallmentsCache` antes da inicialização (TDZ):**
    - *Causa comprovada:* Variável declarada abaixo das funções que a acessavam.
    - *Estado atual:* Resolvido no commit `0a160cc` movendo todas as variáveis para o topo.
17. **Filtro de telemetria (`/tracks`) em `onError` que pode ocultar erros reais:**
    - *Análise de risco:* O filtro verifica estritamente `error.type === "non_critical"` ou termos específicos de telemetria (`tracks`, `telemetry`, `blocked_by_client`). Erros de validação e formulário não são engolidos.
18. **Divergência entre o código corrigido na estrutura antiga (Vercel) e o código publicado na estrutura atual (Cloudflare/Supabase):**
    - *Verificação:* O código de `checkout.html` na branch atual contém todas as correções de `0a160cc`. O proxy do Cloudflare já encaminha para o Supabase Edge.
19. **Ambiguidade sobre a modalidade ativa (Brick, Checkout Pro ou mistura):**
    - *Esclarecimento definitivo:* O frontend está ativo em **Card Payment Brick**. O backend ainda aceita Checkout Pro apenas se não receber token, mas esse fallback deve ser saneado para evitar comportamentos híbridos imprevistos.

---

## 4. BACKEND SEPARADO E DEPLOYS LEGADOS (A3)

- **Backend em Execução Ativa:**
  - `https://guppedddwnuvluhiaaas.supabase.co/functions/v1/checkout-process` (Edge Function Supabase).
  - Proxy em Cloudflare Pages: `_worker.js` roteia `/api/checkout-process` para a URL acima.
- **Backend Legado (`api/checkout-process.js`):**
  - Era executado na Vercel (`site-ejc-eight.vercel.app` / `hugoarimateia/site-ejc`).
  - O código de `api/checkout-process.js` no repositório reflete uma versão Node.js espelho das Edge Functions.
  - O deploy legado na Vercel não deve mais receber tráfego de produção do domínio oficial `transitoejc.site`.
- **URL de Notificação no Mercado Pago:**
  - O endpoint de webhook canônico é: `https://guppedddwnuvluhiaaas.supabase.co/functions/v1/pix-webhook`.
  - É validado por assinatura digital `x-signature` com segredo `PIX_WEBHOOK_SECRET`.
  - **Recomendação ao responsável:** Confirmar no painel do Mercado Pago se a URL de notificação cadastrada nas credenciais de produção aponta exatamente para `https://guppedddwnuvluhiaaas.supabase.co/functions/v1/pix-webhook` com os tópicos `payment` habilitados.
