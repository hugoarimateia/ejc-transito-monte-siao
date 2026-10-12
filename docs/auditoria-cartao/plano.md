# DIAGNÓSTICO E PLANO DE IMPLEMENTAÇÃO — CARTÃO DE CRÉDITO EJC

Data: 12/10/2026  
Status da Fase: Fase B (Diagnóstico e Decisão de Arquitetura — Somente Leitura)  
Branch: `fix/cartao-checkout-transparente`  
Commit de referência: `22eff72ceca6b6ad9a1e7d4a0cd12270f7ce8830`

---

## 1. RECONSTRUÇÃO DO FLUXO ATUAL PONTA A PONTA (B1)

### 1.1 Modalidade Ativa: Card Payment Brick (Checkout Transparente)
1. **Seleção do método:**  
   No `checkout.html`, o participante seleciona a aba "Cartão de Crédito" (`#btnTabCard`).  
   A função `alternarMetodo("credit_card")` oculta o container do Pix e exibe `#panelCard`.
2. **Carregamento do SDK do Mercado Pago:**  
   O cabeçalho do `checkout.html` importa `<script src="https://sdk.mercadopago.com/js/v2"></script>`.  
   Ao carregar a configuração ativa (`carregarConfiguracaoAtiva()`), a rota `/api/config` (proxied para a Edge Function `public-config`) fornece a chave pública canônica (`APP_USR-39960bc1-2b08-4885-8090-31eaa38ba04b`).
3. **Renderização do formulário seguro (Card Brick):**  
   A função `montarCardPaymentBrick()` inicializa `new window.MercadoPago(pubKey, { locale: "pt-BR" })`.  
   O método `bricksBuilder.create("cardPayment", "cardPaymentBrick_container", brickSettings)` monta os iframes seguros oficiais para número do cartão, data de expiração, CVV, titular e documento (CPF).
4. **Consulta e exibição de parcelas:**  
   `carregarCondicoesParcelamentoMP()` consulta `https://api.mercadopago.com/v1/payment_methods/installments` em tempo real para exibir na interface as parcelas disponíveis de acordo com o teto configurado (`card_max_installments`).
5. **Tokenização no frontend:**  
   Ao clicar no botão "Pagar" do Brick, o SDK do Mercado Pago tokeniza os dados do cartão diretamente nos servidores do Mercado Pago, gerando um token de uso único (`cardFormData.token`). Nenhum número de cartão ou CVV passa pelos scripts do EJC.
6. **Envio ao backend:**  
   O callback `onSubmit` invoca `processarPagamentoCartao()`, que faz uma requisição `POST /api/checkout-process` contendo:
   - `metodo: "credit_card"`
   - `token: cardFormData.token`
   - `installments: parcelasFinal`
   - `issuer_id: cardFormData.issuer_id`
   - `payment_method_id: cardFormData.payment_method_id`
   - `inscricao_id: inscricaoIdParam || null`
   - `payer: cardFormData.payer`
7. **Roteamento pelo Cloudflare Pages:**  
   O `_worker.js` do Cloudflare Pages intercepta `/api/checkout-process` e encaminha a requisição via proxy para a Edge Function `https://guppedddwnuvluhiaaas.supabase.co/functions/v1/checkout-process`.
8. **Validação no backend e chamada à API do Mercado Pago:**  
   Na Edge Function `checkout-process`:
   - Valida inscrição ativa e impede nova cobrança se já houver pagamento aprovado (`idempotência`).
   - Obtém o preço efetivo oficial do banco (`financialConfig.preco_efetivo`). Nunca confia no valor enviado pelo frontend.
   - Gera o identificador determinístico da transação: `txid = CARD...` e `orderId = ORD...`.
   - Executa `mpCriarPagamentoCartao(...)` chamando `POST https://api.mercadopago.com/v1/payments` com:
     - `Authorization: Bearer ${MERCADOPAGO_ACCESS_TOKEN}`
     - `X-Idempotency-Key: CARD-${txid}`
     - `notification_url: https://guppedddwnuvluhiaaas.supabase.co/functions/v1/pix-webhook`
     - `external_reference: txid`
9. **Persistência e reconciliação no Supabase (Gargalo Identificado):**  
   - **CENÁRIO A (Aprovado):** Se `mpCardRes.status === "approved"`, o código atual chama diretamente `confirmarPagamentoResiliente`, que dispara a RPC `confirmar_pagamento_unificado`. Como a linha da transação NUNCA foi inserida previamente na tabela `pagamentos`, a RPC retorna `Transação não encontrada`, o fallback atualiza zero linhas e **a transação nunca é salva como aprovada no banco de dados!**
   - **CENÁRIO B (Rejeitado com resposta não-erro):** Salva em `public.pagamentos` com `status: "rejected"` (como ocorreu no caso `CARDMUN4JDMZV02T`).
   - **CENÁRIO C (Exceção/Erro HTTP do MP):** O bloco `catch` devolve HTTP 400 sem gravar a tentativa no banco.
10. **Reconciliação por Webhook:**  
    O Mercado Pago envia notificação assíncrona para `https://guppedddwnuvluhiaaas.supabase.co/functions/v1/pix-webhook`.  
    A Edge Function valida os cabeçalhos `x-signature` e `x-request-id` (HMAC-SHA256) com `PIX_WEBHOOK_SECRET`.  
    Consulta `GET /v1/payments/{id}` e, se aprovado, tenta executar `confirmarPagamentoResiliente(txid)`. Sem a linha pré-existente no banco, a conciliação também falhava.

---

### 1.2 Resíduo da Modalidade Checkout Pro
- No backend (`supabase/functions/checkout-process/index.ts` linhas 1980–2041), se a requisição chegar com `metodo === "credit_card"` mas **sem** `token`, o backend gera uma preferência do Checkout Pro (`mpCriarPreferenciaCheckoutPro`) e grava em `public.pagamentos` com `status: "pending"` e `init_point`.
- O webhook trata pagamentos do Checkout Pro se eles chegarem, buscando pelo `external_reference: txid`.
- Existem 33 registros legados com status `pending` dessa modalidade em `public.pagamentos`.

---

## 2. CAUSA DO REDIRECIONAMENTO PARA LOGIN (B2)

- **Causa Comprovada [VERIFICADO]:**  
  O redirecionamento para a tela de login do Mercado Pago (`https://www.mercadopago.com.br/login/identification`) ocorria **exclusivamente** quando o usuário era direcionado para a URL de preferência hospedada do Checkout Pro (`init_point`).  
  Por ser uma página externa pertencente ao Mercado Pago/Mercado Livre, o motor antifraude e de identificação do Mercado Pago impõe que compradores que tenham contas associadas ao seu e-mail, telefone ou cookies no navegador realizem login com senha ou código de verificação, impedindo uma experiência de convidado (guest) fluida dentro do site do EJC.
- **Solução Definitiva:**  
  O **Card Payment Brick (Checkout Transparente)** resolve esse problema na raiz, pois renderiza os campos do cartão diretamente no DOM do checkout do EJC. O participante preenche o cartão no próprio site, a biblioteca oficial gera o token criptografado e o backend processa via `POST /v1/payments`, sem nenhuma tela externa ou exigência de login.

---

## 3. DECISÃO DA API E DA MODALIDADE (B3)

| Critério | Card Payment Brick + Payments API (`POST /v1/payments`) | Card Brick + Orders API (`/v1/orders`) | Checkout Pro por Link (`init_point`) |
|---|---|---|---|
| **Compatibilidade com o código atual** | **100% Compatível [VERIFICADO]**: Toda a estrutura de `checkout.html`, `checkout-process` e `pix-webhook` já foi projetada para esta API. | Baixa: Exige reescrever o fluxo de ordens e merchant orders. | Parcial: O frontend já abandonou esta modalidade no commit `92dfe3f`. |
| **Experiência (Formulário dentro do EJC)** | **Totalmente dentro do EJC**: O participante nunca sai do site e nunca é solicitado a logar no Mercado Pago. | Totalmente dentro do EJC. | **Não**: Redireciona para fora do site do EJC para URL externa do Mercado Pago. |
| **Suporte a idempotência** | **Nativo [VERIFICADO]**: Suporte oficial ao cabeçalho `X-Idempotency-Key` na API `/v1/payments`. | Suporte via chaves de pedido. | Suporte na criação da preferência. |
| **Modelo de webhook e conciliação** | **Unificado e maduro [VERIFICADO]**: Notificações de evento `payment`, verificação via HMAC-SHA256 (`x-signature`) e consulta `GET /v1/payments/{id}`. | Mais complexo (eventos de merchant_order e payment). | Notificações de preferência e pagamento. |
| **Parcelas e taxas disponíveis** | Consulta oficial via `GET /v1/payment_methods/installments`, respeitando o teto de parcelas do admin. | Requer configuração de ordem. | Configurado nas regras da preferência. |
| **Pagamento sem conta Mercado Pago (Guest)** | **100% Suportado**: O participante paga como convidado fornecendo apenas cartão, titular e CPF. | Suportado. | **Instável**: Mercado Pago frequentemente força login de contas identificadas. |
| **Volume de mudança** | **MÍNIMO E CIRÚRGICO**: Apenas corrigir a persistência prévia no Supabase e sanear o tratamento de retorno. | Alto: Grande refatoração de contratos. | Médio: Mas mantém a experiência indesejada de redirecionamento. |
| **Risco de regressão (incl. Pix e legado)** | **ZERO**: O fluxo do Pix é 100% isolado. As 33 preferências legadas de Checkout Pro continuam conciliáveis pelo webhook. | Alto. | Médio. |

**Decisão Técnica:**  
Adotar oficialmente o **Card Payment Brick (Checkout Transparente) integrado à Payments API (`POST /v1/payments`)**.

---

## 4. PLANO DE IMPLEMENTAÇÃO (B4)

### 4.1 Correções Cirúrgicas a Serem Aplicadas

1. **Correção da Persistência Prévia da Transação de Cartão (Bug Central de Aprovação):**
   - **Localização:** `supabase/functions/checkout-process/index.ts` (linhas 1910–1965).
   - **Ação:** Antes de chamar `mpCriarPagamentoCartao(...)` ou logo no início do fluxo do cartão, persistir a tentativa em `public.pagamentos` com `status: "processing"` (ou `"pending"`), contendo o `txid`, `inscricao_id`, `valorNumerico`, `nome_pagador`, `email`, `whatsapp_pagador`, `parcelas` e `metadata` com `order_id` e `external_reference`.
   - **Resultado:** Quando o Mercado Pago responder `status: "approved"`, a chamada a `confirmarPagamentoResiliente` (e consequentemente a RPC `confirmar_pagamento_unificado`) encontrará a linha no banco com sucesso, atualizará o status para `approved` e confirmará a inscrição do participante em `public.inscricoes`.
2. **Tratamento de Rejeições e Respostas de Erro:**
   - Se a operadora recusar o cartão (`status === "rejected"`), atualizar a linha em `pagamentos` para `status: "rejected"`, registrar o `status_detail` no metadata, e retornar HTTP 200 com `{ success: false, status: "rejected", mensagem_usuario: ... }` para que o Card Brick encerre o spinner e reative o botão para nova tentativa sem recarregar a página.
   - Se a API do MP lançar exceção (ex.: erro 400 por dados de cartão inválidos), atualizar o registro para `rejected` com o detalhe do erro e retornar JSON estruturado com mensagem compreensível.
3. **Garantia de Vínculo com a Inscrição (`inscricao_id`):**
   - Garantir que `checkout.html` salve o `inscricao_id` na sessão no final da Etapa 1 e o transmita obrigatoriamente no payload de pagamento.
   - O backend valida a existência e integridade do `inscricao_id` antes de submeter ao Mercado Pago.
4. **Isolamento e Desativação Segura do Fallback do Checkout Pro:**
   - No endpoint `checkout-process`, se `metodo === "credit_card"`, exigir obrigatoriamente o `token`.
   - Rejeitar com erro 400 claro caso o token não seja fornecido, evitando que o backend gere preferências invisíveis do Checkout Pro.
   - Preservar o tratamento no webhook `pix-webhook` para que os 33 pagamentos pendentes legados do Checkout Pro continuem aptos a serem conciliados caso algum participante conclua o pagamento dessas preferências antigas.
5. **Robustez do Script `checkout.html` (Proteção Anti-TDZ):**
   - Adicionar teste automatizado de integridade estática que garanta que todas as variáveis de estado do cartão permaneçam no topo do script antes de qualquer função de renderização.

---

### 4.2 Arquivos Afetados vs. Escopo Protegido

- **Arquivos a serem alterados (cirurgicamente):**
  1. `supabase/functions/checkout-process/index.ts` (apenas o bloco de cartão de crédito: persistência prévia e reconciliação atômica).
  2. `checkout.html` (garantia de passagem do `inscricao_id` e robustez do tratamento de retorno de recusa).
  3. `api/checkout-process.js` (atualização em espelho para paridade com o ambiente Supabase Edge).
- **Arquivos e módulos ESTRITAMENTE PROTEGIDOS (NÃO TOCAR):**
  - Todas as funções, endpoints e regras do **Pix** (`supabase/functions/pix-create/index.ts`, bloco `if (metodoFinal === "pix")`, etc.).
  - Valores oficiais de inscrição, lotes e configurações promocionais (`configuracoes_financeiras`).
  - Campo de limite de parcelas configurado pelo administrador (`card_max_installments`).
  - Painel administrativo e rotinas de gestão de inscritos e fotos.

---

### 4.3 Estratégia de Idempotência e Tratamento de Estados

- **Chave de Idempotência:** `X-Idempotency-Key: CARD-${txid}`, onde `txid` é gerado unicamente a partir de timestamp e entropia criptográfica por tentativa.
- **Estados Financeiros:**
  - `pending` / `processing`: Tentativa gerada antes da chamada à API.
  - `approved`: Transação liquidada e confirmada via RPC `confirmar_pagamento_unificado`.
  - `in_process`: Transação retida para análise de risco; polling ativado no frontend e aguardando webhook.
  - `rejected`: Cartão recusado; inscrição permanece elegível para nova tentativa.
  - `cancelled`: Transação cancelada sem aprovação.

---

### 4.4 Plano de Testes Obrigatórios

1. **Testes Unitários / Sintáticos:**
   - Verificação de sintaxe de todos os arquivos modificados (`node -c`).
   - Teste automatizado anti-TDZ: validação estática de que `mpInstallmentsCache` e variáveis de controle estão no topo do script.
2. **Testes de Integração com Mocks / Sandbox (sem dados reais):**
   - Criação de tentativa de cartão com token mockado.
   - Validação da persistência prévia em `public.pagamentos`.
   - Simulação de aprovação e execução da RPC `confirmar_pagamento_unificado`.
   - Simulação de recusa e validação de liberação do botão para nova tentativa sem F5.
   - Simulação de webhook com assinatura HMAC-SHA256 (`x-signature`).
   - Teste de concorrência com envio de requisições simultâneas com mesmo `txid`.
3. **Teste de Não-Regressão do Pix:**
   - Execução do fluxo de geração de Pix antes e depois da implementação para assegurar 100% de estabilidade.

---

### 4.5 Decisões Submetidas ao Responsável Humano

Antes de avançar para a Fase C (escrita de código), submetemos as seguintes decisões:

1. **Destino do registro de teste `CARDMUN4JDMZV02T` e dos 33 registros pendentes de Checkout Pro:**
   - *Recomendação do Engenheiro:* **Manter intactos [PRESERVAR]**. Eles estão identificados, não afetam contagens financeiras de aprovados e sua preservação atende às regras inegociáveis de auditoria.
2. **Destino do deploy legado da Vercel (`site-ejc-eight.vercel.app`):**
   - *Recomendação do Engenheiro:* Manter como está, sem receber tráfego de produção (o DNS oficial já aponta para Cloudflare Pages).
3. **Aprovação da modalidade oficial:**
   - *Recomendação do Engenheiro:* Confirmar a adoção definitiva do **Card Payment Brick (Checkout Transparente)** via Payments API (`POST /v1/payments`).

---

## ⛔ PORTÃO DE APROVAÇÃO DA FASE B
Este plano de implementação conclui a Fase B.  
**Nenhum arquivo de código foi editado.**  
Aguardando aprovação humana explícita para iniciar a **Fase C (Implementação e Testes)**.
