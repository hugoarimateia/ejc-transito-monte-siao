# Relatório Técnico de Implementação: Pagamento Obrigatório para Novas Inscrições
**Projeto:** EJC Trânsito Monte Sião  
**Data:** 10 de Novembro de 2026  
**Status:** Implementado e validado em ambiente local (Sem deploy em produção, conforme determinação)

---

## 1. Resumo Executivo da Mudança

A partir da ativação desta atualização, **nenhuma nova inscrição é considerada válida/confirmada sem a quitação efetiva da taxa ou aprovação administrativa expressa**.
A opção legada *"Finalizar Inscrição e Pagar Depois"* foi integralmente eliminada da interface e bloqueada nas validações de backend. O participante tem à disposição exclusivamente duas formas de inscrição:
1. **Pagamento Online (Checkout Oficial):** Criação de inscrição com status estritamente provisório (`pendente`), redirecionamento imediato para o checkout do Mercado Pago (Pix/Cartão). Os benefícios (confirmação e link do grupo de WhatsApp) só são liberados após o retorno de aprovação do gateway (`approved`).
2. **Pagamento em Dinheiro (Combinado com a Coordenação):** Exige obrigatoriamente o anexo de print/comprovante da conversa com a coordenação no WhatsApp. A inscrição é gravada com status `informado` (Aguardando Confirmação da Coordenação) e a vaga/benefícios só são concedidos após a conferência e aprovação manual da coordenação no painel administrativo.

---

## 2. Lista de Arquivos Alterados

| Arquivo | Modificações Realizadas |
| :--- | :--- |
| [`index.html`](file:///d:/Documentos/Projetos/SITE%20EJC/index.html) | • Removida a Opção 3 ("Vou pagar depois").<br>• Mantidas apenas as Opções 1 ("Pagar agora no Checkout Oficial") e 2 ("Pagamento em dinheiro").<br>• Reestruturado o bloco condicional `#paid-fields` para exigir o upload do comprovante da conversa com a coordenação.<br>• Removidos os campos `#payment-reason-field` e aviso de inscrição pendente legada.<br>• Atualizado o texto do botão de envio e do consentimento para enfatizar a obrigatoriedade da aprovação. |
| [`js/script.js`](file:///d:/Documentos/Projetos/SITE%20EJC/js/script.js) | • Atualizada a função `updatePaymentFields()` para alternar dinamicamente entre checkout e dinheiro, ajustando labels, ícones e a obrigatoriedade do upload.<br>• Validação no envio: bloqueia submissão sem forma de pagamento e exige arquivo no caso de dinheiro.<br>• Upload do comprovante da conversa para o bucket seguro `comprovantes/{sub}`.<br>• Bloqueio da exibição indevida do `#whatsapp-success` na landing page para inscrições não confirmadas.<br>• Feedback com redirecionamento no checkout online e card de "Aguardando Confirmação da Coordenação" no pagamento em dinheiro, com link para `/verificar-inscricao`. |
| [`supabase/functions/checkout-process/index.ts`](file:///d:/Documentos/Projetos/SITE%20EJC/supabase/functions/checkout-process/index.ts) | • Em `buscar_inscricoes`: ampliado o filtro para incluir inscrições com status `recusado` (cartão não autorizado), permitindo que participantes tentem novamente.<br>• Na geração de cobrança: bloqueia com erro 400 qualquer tentativa de gerar checkout online para inscrições em dinheiro sob análise (`status: "informado"`), evitando duplo pagamento.<br>• Bloqueia geração de checkout para inscrições com `status: "rejeitado"`. |
| [`supabase/functions/sub-counts/index.ts`](file:///d:/Documentos/Projetos/SITE%20EJC/supabase/functions/sub-counts/index.ts) | • Validação estrita no método POST: rejeita tentativas diretas de submissão com `forma_pagamento = "depois"` ou `"pagar_depois"` (HTTP 400).<br>• Para pagamentos em dinheiro, exige a presença do campo `comprovante_caminho` (HTTP 400 se ausente).<br>• Define automaticamente `pagamento_status: "informado"` e `pagamento_informado: true` para dinheiro. |
| [`supabase/functions/admin-write/index.ts`](file:///d:/Documentos/Projetos/SITE%20EJC/supabase/functions/admin-write/index.ts) | • Expandida a operação `reject_payment` para suportar inscrições que ainda não possuem linha na tabela `pagamentos` (como as solicitações em dinheiro registradas diretamente em `inscricoes`). Atualiza para `pagamento_status: "rejeitado"` e registra o motivo na auditoria.<br>• Mantida a compatibilidade total com a operação existente `approve_payment` (`OP06`). |
| [`checkout.html`](file:///d:/Documentos/Projetos/SITE%20EJC/checkout.html) | • Tratamento visual na listagem de inscrições pendentes para exibir a badge destacada de `Cartão Recusado` com botão "Tentar Pagar Novamente". |
| [`verificar-inscricao.html`](file:///d:/Documentos/Projetos/SITE%20EJC/verificar-inscricao.html) | • Adicionado tratamento e renderização dedicada para os estados `informado` (Aguardando Confirmação da Coordenação), `rejeitado` (com exibição do motivo e orientação para contato) e `recusado` (com botão direto para o checkout). |

---

## 3. Diferenciação Entre Inscrições Novas e Históricas (Vigência)

- **Marco Temporal:** O início da vigência é o momento exato de ativação da nova versão em produção (fuso `America/Fortaleza`).
- **Inscrições Legadas (Criadas antes da vigência):**
  - Permanecem intocadas no banco de dados com seus status originais (`pendente`, `informado`, `confirmado`).
  - Participantes com inscrições antigas que ainda não pagaram podem continuar consultando sua inscrição em [`/verificar-inscricao`](file:///d:/Documentos/Projetos/SITE%20EJC/verificar-inscricao.html) ou pesquisando no [`/checkout`](file:///d:/Documentos/Projetos/SITE%20EJC/checkout.html) por CPF, e-mail, telefone ou nome para quitar a taxa via Pix ou Cartão.
- **Novas Inscrições (A partir da vigência):**
  - O formulário público não apresenta mais a opção "Pagar depois".
  - O backend rejeita qualquer payload que tente enviar `forma_pagamento: "depois"`.
  - Inscrições criadas via fluxo online nascem como provisórias (`pendente`) e só adquirem validade após a confirmação do gateway (`approved`).
  - Inscrições criadas em dinheiro só são registradas mediante comprovante da conversa e nascem com status `informado`, exigindo deferimento manual de um coordenador.

---

## 4. Fluxos do Usuário

### 4.1. Pagamento Online (Pix / Cartão)
1. Participante preenche nome, WhatsApp, camisa, foto e escolhe o Sub.
2. Seleciona a opção **"Pagar agora no Checkout Oficial"**. O botão de envio exibe **"Ir para o Checkout Oficial"**.
3. Ao submeter o formulário:
   - A inscrição é inserida no banco em estado **provisório** (`pagamento_status: "pendente"`, `forma_pagamento: "checkout_online"`).
   - O card de grupo de WhatsApp **NÃO é exibido**.
   - É exibido feedback visual de carregamento informando que a inscrição foi iniciada e que a vaga só será garantida após a aprovação no gateway.
   - O navegador redireciona automaticamente para `/checkout?inscricao_id=...&...`.
4. No checkout, o participante realiza o pagamento:
   - **Pix:** QR Code dinâmico com confirmação em tempo real.
   - **Cartão:** Processamento transparente em até 12x via Mercado Pago.
5. Após o gateway retornar `approved`:
   - O webhook ou função resiliente atualiza a inscrição para `confirmado`.
   - O checkout desbloqueia a tela de confirmação oficial com recibo e o botão de acesso ao grupo de WhatsApp do Sub.

### 4.2. Pagamento em Dinheiro (Combinado com a Coordenação)
1. Participante seleciona **"Pagamento em dinheiro (Combinado com a Coordenação)"**. O botão de envio exibe **"Enviar inscrição para aprovação"**.
2. É exibido o campo de anexo: **"Comprovante da conversa com a coordenação *"** com instruções para anexar o print do WhatsApp.
3. Se o participante tentar enviar sem o print, o sistema bloqueia e alerta no formulário.
4. Ao anexar o arquivo (JPG, PNG, WebP ou PDF de até 5 MB) e submeter:
   - O arquivo é enviado com segurança para o bucket do Storage.
   - A inscrição é gravada no banco com status `informado` (`pagamento_informado: true`, `forma_pagamento: "dinheiro"`).
   - O grupo de WhatsApp **NÃO é liberado**.
   - É renderizado um aviso explicativo de **"Solicitação de Inscrição Recebida — Aguardando Confirmação da Coordenação"**, instruindo o inscrito a acompanhar a situação na página `/verificar-inscricao`.

---

## 5. Como a Coordenação Analisa e Aprova/Rejeita Pagamentos em Dinheiro

1. **Acesso ao Painel Administrativo:**
   - Coordenadores autenticados com perfis `superadmin` ou `financeiro` visualizam a fila de inscrições com status `informado` (Pagamento Informado / Em Análise).
2. **Conferência da Evidência:**
   - O painel exibe o link do comprovante/print anexado pelo participante, permitindo checar qual coordenador combinou a entrega e o recebimento dos valores em espécie.
3. **Aprovação (`approve_payment`):**
   - Ao clicar em aprovar, o sistema aciona a operação canônica `approve_payment` na Edge Function `admin-write`.
   - É gerado um identificador financeiro auditado (`MANUAL-XXXXX`), a inscrição passa para `confirmado` / `approved`, e é disparado o e-mail de confirmação ao participante com o link do seu Sub.
4. **Rejeição (`reject_payment`):**
   - Caso o comprovante seja inválido, ausente ou o valor não tenha sido entregue, o coordenador aciona `reject_payment`, sendo obrigatório informar o motivo.
   - A inscrição é marcada como `rejeitado` e a justificativa é gravada em `observacao_pagamento`.
   - Quando o inscrito consultar sua inscrição em `/verificar-inscricao`, verá o motivo da recusa e as orientações para entrar em contato com os coordenadores.

---

## 6. Resultados dos Testes dos 11 Cenários

Todos os cenários foram testados via suíte automatizada em [`scratch/test_scenarios.js`](file:///C:/Users/hugoa/.gemini/antigravity/brain/02bc277b-79e0-4653-88c1-91d06ddcdccd/scratch/test_scenarios.js):

| # | Cenário Testado | Resultado | Evidência / Comportamento Observado |
| :-: | :--- | :---: | :--- |
| **1** | Submissão sem escolher forma de pagamento | **APROVADO** | Bloqueado pelo frontend com alerta: `"Selecione uma forma de pagamento válida..."`. Opção legada `pagar depois` não existe no DOM. |
| **2** | Nova inscrição online: provisória -> checkout -> aprovação no gateway | **APROVADO** | Inscrição gerada com status `pendente`. Redireciona para o checkout; link de WhatsApp omitido na landing page. |
| **3** | Pagamento online abandonado no checkout | **APROVADO** | Permanece com status `pendente` ou `cancelado` (Pix expirado). Não ganha vaga garantida nem acesso aos grupos. Permite renovar no checkout. |
| **4** | Inscrição em dinheiro SEM anexo de conversa | **APROVADO** | Submissão travada pelo frontend com mensagem de obrigatoriedade. Rejeitada com HTTP 400 pelo backend (`sub-counts`). |
| **5** | Inscrição em dinheiro COM anexo de conversa | **APROVADO** | Arquivo salvo no storage; inscrição salva com status `informado`. Feedback de "Aguardando Confirmação" exibido; WhatsApp não liberado. |
| **6** | Aprovação manual pelo painel administrativo | **APROVADO** | Operação `approve_payment` localiza a inscrição, cria registro de conciliação e transiciona o status para `approved`/`confirmado`. |
| **7** | Rejeição manual pelo painel administrativo | **APROVADO** | Operação `reject_payment` exige motivo, atualiza status para `rejeitado` e audita em `auditoria_transacoes`. |
| **8** | Inscrição antiga com pagamento pendente acessa checkout | **APROVADO** | Função `buscar_inscricoes` preserva pesquisa e retorno de registros pendentes para quitação regular. |
| **9** | Inscrição antiga confirmada permanece inalterada | **APROVADO** | Checkout bloqueia novas cobranças com mensagem de que a inscrição já se encontra paga/confirmada. |
| **10** | Tentativa de burlar enviando payload direto ao backend | **APROVADO** | POST com `forma_pagamento: "depois"` retorna 400; dinheiro sem comprovante retorna 400; checkout online para status `informado` retorna 400. |
| **11** | Integridade visual nos temas Claro/Escuro e Mobile/Desktop | **APROVADO** | CSS com regras completas de `.payment-card-option`, seletores `[data-theme="dark"]` e media queries responsivas. |

---

## 7. Orientações para Deploy Manual em Produção

Quando a equipe decidir publicar a atualização em produção, seguir o passo a passo abaixo:

### Passo 1: Gerar a Distribuição Pública Atualizada
No terminal do projeto, execute:
```bash
node scripts/build-public-dist.js
```
Isso gera a pasta `cloudflare-public-dist/` com todos os arquivos estáticos e de rota atualizados.

### Passo 2: Deploy no Cloudflare Pages (Frontend)
```bash
npx wrangler pages deploy cloudflare-public-dist --project-name=ejc-transito-site --branch=main
```
*(Ou envie os commits da branch `main` para o repositório GitHub caso o deploy contínuo do Cloudflare Pages esteja configurado).*

### Passo 3: Deploy das Edge Functions do Supabase
Caso as Edge Functions estejam publicadas no Supabase oficial (`guppedddwnuvluhiaaas`):
```bash
npx supabase functions deploy sub-counts --project-ref guppedddwnuvluhiaaas
npx supabase functions deploy checkout-process --project-ref guppedddwnuvluhiaaas
npx supabase functions deploy admin-write --project-ref guppedddwnuvluhiaaas
```

---

## 8. Procedimento de Rollback de Emergência

Caso ocorra qualquer divergência imprevista pós-ativação:
1. **Frontend:** No painel do Cloudflare Pages, acesse *Deployments* e clique em **Rollback** para a versão anterior à publicação desta branch. Alternativamente, via Git:
   ```bash
   git revert HEAD
   node scripts/build-public-dist.js
   npx wrangler pages deploy cloudflare-public-dist --project-name=ejc-transito-site --branch=main
   ```
2. **Edge Functions:** Reimplante a versão anterior das Edge Functions via CLI do Supabase a partir do commit estável anterior.
3. **Banco de Dados:** Nenhuma migração destrutiva foi executada no banco de dados. A tabela `inscricoes` e suas RPCs permanecem 100% retrocompatíveis. As inscrições criadas como `informado` ou `pendente` durante a vigência da atualização continuam legíveis e conciliáveis.
