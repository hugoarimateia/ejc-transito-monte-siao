# RELATÓRIO 1 — AUDITORIA FINANCEIRA E DE INSCRIÇÕES
## EJC TRÂNSITO MONTE SIÃO — ANÁLISE FORENSE E COMPARATIVA COM O BACKUP HISTÓRICO DA VERCEL

**Data da Perícia:** 07 de Novembro de 2026 — 14:35 (Horário Local / America/Fortaleza UTC-3)  
**Ambiente de Execução:** Produção (`guppedddwnuvluhiaaas.supabase.co` / Cloudflare Pages / Mercado Pago)  
**Regime Operacional:** Estritamente Somente Leitura (*Read-Only*) — Sem alterações de código, registros, banco ou deploys.

---

### SUMÁRIO EXECUTIVO

Esta perícia consolida, revalida e aprofunda os achados dos relatórios anteriores a partir da confrontação direta entre:
1. Os registros vivos do banco de dados PostgreSQL de produção (`guppedddwnuvluhiaaas`).
2. Os backups lógicos e físicos integrais da era Vercel preservados em `data/backups/` (notadamente os dumps de 02/10/2026 e 04/10/2026).
3. O histórico de commits Git do repositório (ramos `origin/main` e `backup/main`).
4. Os payloads originais de webhooks do Mercado Pago arquivados em formato JSONB.

**Conclusões Centrais:**
- **Pagamentos de R$ 0,01:** Comprovou-se de forma documental e independente que **nenhum participante real pagou R$ 0,01**. Todas as 4 transações aprovadas foram testes técnicos de infraestrutura executados pelo desenvolvedor do projeto (`085.***.***-02`), cujo arquivamento no banco ocorreu sistematicamente **após** a liquidação financeira. No backup histórico da era Vercel (02/10/2026), identificou-se também uma bateria de testes de formulário abortados na noite de 28/09/2026, com apenas um registro sintético de R$ 0,01 que foi cancelado manualmente pela coordenação (`Cancelamento manual (soft-cancel)`).
- **Valores Divergentes de R$ 50,00:**
  - **R$ 51,50 (3 transações de cartão de crédito):** Estão **totalmente comprovadas e regulares**. Trata-se da aplicação da taxa administrativa oficial de R$ 1,50 para cartão à vista (`taxa_adicional_1x: 1.5`), introduzida formalmente no commit `a3903ec` e confirmada no payload do Mercado Pago (`transaction_amount: 51.5`).
  - **R$ 70,00 (2 transações Pix — Larissa e Alanna):** **Não existiam no backup da Vercel em 02/10/2026**. Surgiram posteriormente via inserção sintética manual no script `.auditoria-local/execute_reparos_g3.js` (linhas 94 e 246), sem qualquer payload de webhook do gateway no banco. Mantêm-se classificadas como **Divergência Pendente de Validação Financeira Externa** no extrato do Mercado Pago.
- **Pagamentos Aprovados Sem Vínculo (`inscricao_id IS NULL`):** Foram catalogadas **7 transações aprovadas órfãs** totalizando R$ 350,00. Identificou-se que a causa preponderante são divergências tipográficas em e-mails digitados no checkout em relação à inscrição (ex.: `luisagabrielly@...` vs `luisagabriellyw@...`, `yannimarques2109@...` vs `yannimarques2198@...`, e-mail iCloud vs Gmail de Davi Paulo).
- **Caso da Participante Luísa Barreto:** Confirmou-se pericialmente que a participante **efetuou com sucesso o pagamento de R$ 50,00 via cartão de crédito (`CARDMW5662ZYMQ4T`) em 06/11/2026 às 13:09:01 Local**, devidamente aprovado pelo Mercado Pago. O vínculo falhou por omissão da letra "w" no e-mail no momento do pagamento. **É terminantemente proibido cobrar a participante novamente.**
- **Falha no Mecanismo de Busca do Checkout:** Dissecou-se a função `buscar_inscricoes` tanto na Edge Function atual (`supabase/functions/checkout-process/index.ts`, linhas 909-915) quanto no código legado da Vercel (`api/checkout-process.js`, linha 638). Constatou-se que a exclusão de participantes com status `recusado` decorre de um filtro rígido herdado diretamente da arquitetura da Vercel: `.in("pagamento_status", ["pendente", "cancelado"])`.

---

### 1. METODOLOGIA, UNIVERSO EXAMINADO E PRESERVAÇÃO READ-ONLY

#### 1.1. Credenciais e Modo de Conexão
- A consulta ao banco foi realizada em sessão efêmera autenticada via PostgreSQL CLI da CLI oficial do Supabase, aplicando de modo forçado no início da sessão:
  ```sql
  SET ROLE postgres;
  SET TRANSACTION READ ONLY;
  ```
- Nenhuma operação de escrita (`INSERT`, `UPDATE`, `DELETE`, `ALTER`, `DROP`, `TRUNCATE` ou RPC mutativa) foi invocada.
- O repositório Git local permaneceu com a árvore de trabalho 100% limpa (`working tree clean`).

#### 1.2. Universo de Dados Inspecionado (Timestamp: 07/11/2026 14:35 Local)
- **Tabela `public.inscricoes`:** 493 registros no total (420 ativos e 73 arquivados).
  - Ativos: `pendente` (244), `confirmado` (152), `cancelado` (18), `informado` (3), `approved` (2), `recusado` (1).
  - Arquivados: `cancelado` (57), `pendente` (11), `confirmado` (5).
- **Tabela `public.pagamentos`:** 347 registros no total.
  - Aprovados (`approved` / `confirmed`): 137 transações.
  - Cancelados / Expirados (`cancelled` / `cancelado`): 162 transações.
  - Rejeitados (`rejected`): 19 transações.
  - Pendentes (`pending`): 29 transações.
  - Pagamentos Aprovados Órfãos (`status = approved AND inscricao_id IS NULL`): 7 transações.
- **Tabela `public.auditoria_transacoes`:** 1.129 eventos de auditoria registrados cronologicamente.
- **Backups Físicos e Lógicos:** 11 artefatos em `data/backups/` e 16 subdiretórios de checkpoints em `backups/`.

---

### 2. INVENTÁRIO DO BACKUP HISTÓRICO DA ERA VERCEL

O projeto utilizou a plataforma Vercel como hospedagem de frontend e execução de Serverless Functions (diretório `api/`) até o início de outubro de 2026, momento em que foi realizada a migração para Cloudflare Pages e Supabase Edge Functions.

#### 2.1. Inventário de Arquivos do Backup Histórico (`data/backups/`)

| Nome do Arquivo | Data/Hora de Modificação | Tamanho (Bytes) | Hash Criptográfico (SHA-256) | Natureza do Conteúdo |
| :--- | :---: | :---: | :--- | :--- |
| `BACKUP_PRE_EDGE_FUNCTION_2026-10-02T14-14-49-325Z.json` | 02/10/2026 11:14:53 | 82.113 | `47D44ED1DF549B63E6D9E9AECF2B8F73033BBFA46CC93C4C632B826E2A38E90C` | Dump de configurações financeiras, subs, whatsapp e estado local Vercel. |
| `BACKUP_LOGICO_COMPLETO_2026-10-02T14-26-12-925Z.json` | 02/10/2026 11:26:15 | 56.209 | `7422B40A1F853D0221090C3A02658DB81121CFA367115373C5728C005EE79196` | Backup lógico das tabelas de configuração. |
| `BACKUP_LOGICO_COMPLETO_2026-10-02T14-26-12-925Z.sql` | 02/10/2026 11:26:15 | 95.892 | `6D96137D5B721A19E0252E3F4A902082CCBB3FF7E33692B0E9196BEADE6814A0` | Instruções DDL e DML SQL das tabelas de parametrização. |
| `DEFINITIVE_BACKUP_ETAPA1E_2026-10-02T17-38-15-658Z.json` | 02/10/2026 14:38:16 | 2.702.508 | `F2AB061F8C97C6C44367D98782CBB39D54F1620454832E500A4435D77B924C0F` | **Dump Pericial Canônico da Era Vercel**: 364 inscrições, 138 pagamentos, 620 auditorias. |
| `DEFINITIVE_BACKUP_ETAPA1E_2026-10-02T17-38-15-658Z.sql` | 02/10/2026 14:38:16 | 2.237.255 | `2ED702D4823DD3A9424CD72D3B32D16F796104407B9543CAA6738775C90A1B32` | Script SQL completo com `INSERT INTO` de todas as tabelas em 02/10/2026. |
| `BASELINE_INTEGRIDADE_ETAPA1E.json` | 02/10/2026 14:38:16 | 2.372 | `C02707C9C06F8405FE297DB5F572F3BC8F3D41CFC03767584528C49F20373DCC` | Hashes SHA-256 de integridade e inventário de storage (442 fotos). |
| `AUDITORIA_RELATORIO_ETAPA1E_2026-10-02T17-38-15-658Z.json` | 02/10/2026 14:38:16 | 122.200 | `F1DB03C3A5543BFFE5D308900F55DD90AFDDEF37D12DDC8A2AE1C9A328FFC2B1` | Relatório de auditoria e validação de consistência relacional. |
| `backup_test_inscricoes_20260929.json` | 29/09/2026 11:56:51 | 90.808 | `C46DC9F38052557B9D428A0B7C50596ADA2932F4E25ED2DAD79D4AE8A779B62B` | Instantâneo das primeiras inscrições de teste no pré-lançamento. |
| `dns_backup_2026-10-04T00-36-29-512Z.json` | 03/10/2026 21:36:29 | 949 | — | Registro pericial da transição de DNS para a Cloudflare. |
| `DEFINITIVE_BACKUP_POST_CUTOVER_2026-10-04T02-21-17.681Z.json` | 03/10/2026 23:21:26 | 3.090.645 | `77DB5D536177210E8A76C6B46A44D53725C4310C330982282798088A20C4648C` | Backup canônico imediatamente posterior ao cutover oficial. |
| `DEFINITIVE_BACKUP_POST_CUTOVER_2026-10-04T02-21-17.681Z.sql` | 03/10/2026 23:21:26 | 2.216.714 | `3514913ECEE5E1BA6CB7B139C9D6CA2C63B172BF23388AAC037CED688134DF14` | Dump SQL pós-migração. |

#### 2.2. Separação de Natureza e Lacunas do Backup
- **Dados Financeiros:** O arquivo `DEFINITIVE_BACKUP_ETAPA1E_2026-10-02T17-38-15-658Z.json` contém dados financeiros e cadastrais autênticos da era Vercel. Nele constavam exatamente **138 pagamentos** e **364 inscrições**.
- **Código-Fonte Histórico:** O diretório `api/` na raiz do projeto preserva as Serverless Functions originais desenvolvidas para o Node.js runtime da Vercel (`api/checkout-process.js`, `api/sub-counts.js`, `api/admin.js`, etc.), juntamente com o arquivo [vercel.json](file:///d:/Documentos/Projetos/SITE%20EJC/vercel.json) de roteamento e headers.
- **Lacunas Identificadas:** Os backups locais contêm os payloads recebidos pelos webhooks registrados nas tabelas, mas **não contêm o extrato bancário externo do Mercado Pago**. Transações que foram inseridas sinteticamente no banco sem webhook não possuem rastreabilidade de payload dentro do repositório.

---

### 3. REVALIDAÇÃO DOS CASOS DE R$ 0,01

#### 3.1. Reavaliação dos Quatro Pagamentos Aprovados de R$ 0,01

A análise forense confirmou nos payloads originais do Mercado Pago e no histórico Git que os quatro pagamentos aprovados de R$ 0,01 foram gerados em baterias de testes técnicos pelo desenvolvedor:

```mermaid
timeline
    title Cronologia Pericial dos Testes de R$ 0,01 e Arquivamento
    section 29/09/2026 - Pré-Lançamento Oficial
      02:49 Local : Pgto PIXMUM99J2L81XU (R$ 0,01)
      12:01 Local : Arquivamento na limpeza de homologação
      22:38 Local : Pgto PIXMUNCNCLSGB3D (R$ 0,01)
      22:49 Local : Pgto PIXMUNG5H6WFSFP (R$ 0,01)
      23:27 Local : Arquivamento das transações no reset oficial pré-lançamento
    section 10/10/2026 - Homologação de Cartão
      12:54 Local : Pgto CARDMV2KQCCEPM04 (R$ 0,01)
      13:00 Local : Arquivamento 6 min após o teste (teste_producao_reajuste_lote_hugo)
```

1. **`CARDMV2KQCCEPM04` (Cartão de Crédito — 10/10/2026):**
   - Transação MP: ID `183470505214`, status `approved`, valor R$ 0,01.
   - Pagador registrado: `hugoarimateiab@gmail.com`, CPF `085.***.***-02`.
   - Momento do pagamento: 10/10/2026 12:54:21 Local.
   - Momento do arquivamento: 10/10/2026 13:00:20 Local (**exatamente 6 minutos depois**).
   - Motivo registrado: `teste_producao_reajuste_lote_hugo`.
2. **`PIXMUM99J2L81XU` (Pix — 29/09/2026):**
   - Transação MP: ID `181399663926`, status `approved`, valor R$ 0,01.
   - Nome do titular cadastrado na inscrição: `"Hugo Teste final com foto"`.
   - Pagador registrado no gateway: `hugoarimateia@outlook.com`, CPF `085.***.***-02`.
   - Arquivado em lote no ciclo matinal de reset pré-lançamento.
3. **`PIXMUNCNCLSGB3D` (Pix — 29/09/2026):**
   - Transação MP: ID `180536029091`, status `approved`, valor R$ 0,01.
   - Pagador registrado: `hugoariamteiab@gmail.com`, CPF `085.***.***-02`.
   - Pagamento às 22:38 Local; arquivamento às 23:27 Local (**49 minutos depois**) na grande limpeza pré-abertura (`reset_limpeza_testes_pre_lancamento`).
4. **`PIXMUNG5H6WFSFP` (Pix — 29/09/2026):**
   - Transação MP: ID `180548559833`, status `approved`, valor R$ 0,01.
   - Pagador registrado: `hugoarimateia@outlook.com`, CPF `085.***.***-02`.
   - Pagamento às 22:49 Local; arquivamento às 23:27 Local (**38 minutos depois**).

#### 3.2. Achados Adicionais no Backup Histórico da Vercel (Etapa 1E)
No backup `DEFINITIVE_BACKUP_ETAPA1E_2026-10-02T17-38-15-658Z.json`, foram identificadas outras tentativas de R$ 0,01 criadas em 28/09/2026 entre 22:10 e 22:17 Local (ex.: `PIXMULZER6S5A4Y`, `PIXMULZCY7Z2F4U`, etc.).
- A inspeção revelou que tratavam-se de testes de submissão do formulário enquanto o preço técnico na API de homologação estava em R$ 0,01.
- Todas as cobranças no gateway para esses participantes externos **expiraram sem pagamento** (`status: cancelled`, `status_detail: expired`). Os participantes posteriormente se inscreveram no site oficial em outubro e pagaram regularmente o valor integral de R$ 50,00 (ex.: Lyvia de Freitas Santos e João Vinícius Paulino Maciel, ambos com pagamento confirmado de R$ 50,00).
- Um único registro associado a Jailton Jenderson Alves Souto (`PIXMULZCOOW73OI`) apresentava carimbo sintético de pagamento, porém sem ID de Mercado Pago (`mp_id: null`) e sem payload. Esse registro foi cancelado manualmente pela coordenação e arquivado (`Cancelamento manual (soft-cancel) pela coordenação`).

> [!IMPORTANT]
> **Conclusão Categórica:** Fica ratificado pericialmente com 100% de solidez que **nenhum participante real pagou R$ 0,01**. Todas as 4 transações aprovadas foram testes técnicos de infraestrutura executados pelo desenvolvedor do projeto.

---

### 4. ANÁLISE DE VALORES DIVERGENTES DE R$ 50,00

#### 4.1. Pagamentos no Valor de R$ 51,50 (Cartão de Crédito 1x)
A auditoria detectou três transações aprovadas de R$ 51,50 no banco de produção:
1. `CARDMVPYG3HWEMN5` (26/10/2026 21:36 Local) — Marcelle Lopes Guimarães.
2. `CARDMVV54WS4Y8RO` (30/10/2026 12:42 Local) — Evellyn Santana Martins.
3. `CARDMW5RTXEP4QI9` (06/11/2026 23:15 Local) — Myrella Porto Araújo.

**Evidência Técnica da Regra e Cobrança:**
- No arquivo `supabase/functions/checkout-process/index.ts` (linhas 1970-2025) e no commit `a3903ec` ("fix(financeiro): auditoria forense, aprovacao manual canonica e taxa de cartao 1x"), instituiu-se a cobrança da taxa operacional de conveniência de R$ 1,50 para pagamentos em 1 parcela no cartão.
- Os metadados gravados em cada uma dessas transações registram:
  ```json
  {
    "valor_base": 50,
    "total_cobrado": 51.5,
    "taxa_adicional_1x": 1.5,
    "provedor": "mercadopago_direct_card"
  }
  ```
- No caso de `CARDMVV54WS4Y8RO`, o payload original do Mercado Pago confirma: `transaction_amount: 51.5`, `total_paid_amount: 51.5`, com tarifa de processamento MP de R$ 1,28 deduzida no gateway.
- **Classificação:** **Totalmente Explicado e Regular**. O valor cobrado seguiu estritamente a regra contratual vigente para cartão de crédito à vista.

#### 4.2. Pagamentos no Valor de R$ 70,00 (Larissa Magalhães e Alanna Maria)
- **TXIDs:** `PIXMUNIVSYZZ5ZW` (Larissa) e `PIXMUOALY4GRCZF` (Alanna).
- **Confronto com o Backup da Vercel:** No backup `DEFINITIVE_BACKUP_ETAPA1E_2026-10-02T17-38-15-658Z.json`, **essas duas transações NÃO existiam**.
- **Origem da Injeção no Banco:** O arquivo `.auditoria-local/execute_reparos_g3.js` comprova que ambos os registros foram criados via script de reparo posterior, injetando o literal `70.00` nas linhas 94 e 246.
- **Divergência Documental:** Ambas as participantes pertenciam ao 1º Lote Oficial (preço de R$ 50,00) e assinalaram no formulário que **não desejavam camisa adicional** (`quer_camisa_adicional = false`, `quantidade_camisas_adicionais = 0`). A menção a R$ 65,00 no relatório anterior decorreu de uma suposição teórica de cálculo de camisa do 1º Lote (R$ 50 + R$ 15), enquanto o script gravou R$ 70,00 (regra do 2º Lote: R$ 50 + R$ 20).
- **Classificação:** **Divergência Pendente de Validação Financeira Externa**. Não há payload do Mercado Pago gravado no banco (`payload_webhook = null`). A confirmação de se o participante pagou R$ 50,00 ou R$ 70,00 depende exclusivamente da consulta ao extrato da conta do Mercado Pago da coordenação.

---

### 5. AUDITORIA DE PAGAMENTOS APROVADOS SEM VÍNCULO (`inscricao_id IS NULL`)

A auditoria identificou **7 pagamentos aprovados no gateway cujas transações não possuem vínculo com a respectiva inscrição** na tabela `pagamentos`. O cruzamento individualizado com os cadastros revelou:

| # | TXID / Gateway ID | Data/Hora Pgto (Local) | Valor | Pagador no Gateway | E-mail no Pagamento | Inscrição Compatível Identificada | E-mail na Inscrição | Status Atual da Inscrição | Causa Raiz da Falha de Vínculo | Grau de Certeza |
| :-: | :--- | :---: | :---: | :--- | :--- | :--- | :--- | :---: | :--- | :---: |
| 1 | `CARDMW5662ZYMQ4T` | 06/11 13:09 | R$ 50,00 | Luísa Gabrielly Barreto | `luisagabrielly@...` | `0bf52dbb-fa68-...` | `luisagabriellyw@...` | `cancelado` | Erro tipográfico no e-mail (omissão da letra "w"). | **100% (Cabal)** |
| 2 | `PIXMVQRQAJWFHUG` | 27/10 11:16 | R$ 50,00 | Yanni Barros Marques | `yannimarques2109@...` | `32bfdfa1-26b9-...` | `yannimarques2198@...` | `pendente` | Erro tipográfico no e-mail (`2109` vs `2198`). | **100% (Cabal)** |
| 3 | `PIXMW5NN6JNHKLZ` | 07/11 00:16 | R$ 50,00 | Davi Paulo Madureira Assis | `davipauloss09@...` | `dd58a895-d107-...` | `davipmas@icloud.com` | `pendente` | Uso de provedores de e-mail distintos (Gmail vs iCloud). | **100% (Cabal)** |
| 4 | `PIXMV4OBW6M3XPJ` | 12/10 00:11 | R$ 50,00 | Erasmo gama da silva júnior | `erasmogama99@...` | `f06e31a5-2c10-...` | `erasmogama99@...` | `informado` | Pagamento efetuado em 12/10; formulário preenchido apenas em 28/10 como espécie. | **100% (Cabal)** |
| 5 | `PIXMVHEN139MSGQ` | 21/10 21:59 | R$ 50,00 | Icaro Vasiljevic | `icarovasiljevic@...` | `f8be015f-8229-...` | `icarovasiljevic@...` | `informado` | Pagamento efetuado em 21/10; formulário preenchido apenas em 29/10 como manual. | **100% (Cabal)** |
| 6 | `PIXMV4G0E0BUVSM` | 11/10 20:17 | R$ 50,00 | Maria Eduarda Lopes da Silva | `dudsmaria3030@...` | Nenhuma localizada | — | — | Pagador gerou Pix direto no checkout sem ficha cadastral prévia na base. | **Pendente de Ficha** |
| 7 | `PIXMUO8PLO0AWQN` | 30/09 12:32 | R$ 50,00 | Participante EJC | `tiphannybeatriz.c2@...` | Nenhuma localizada | — | — | Pagamento avulso em 30/09 sem correspondência nominal ou por e-mail na base. | **Pendente de Ficha** |

---

### 6. CASO DETALHADO DA PARTICIPANTE LUÍSA BARRETO

#### 6.1. Reconstituição Forense e Validade do Pix
1. **05/11/2026 12:51:57 Local:** Gerado o Pix `PIXMW3Q4C0BRTJC` (MP ID `187922399448`) no valor de R$ 50,00.
   - O campo `expiracao` na tabela local gravou 15 minutos (`13:06:55 Local`), mas a API do Mercado Pago concedeu validade de 24 horas (`date_of_expiration: 2026-11-06T12:51:56 Local`).
   - Durante a auditoria de 05/11, o Pix estava tecnicamente aberto (`pending`) no gateway.
2. **05/11/2026 12:53:40 Local (1m43s após o Pix):** A participante tentou pagar com cartão de crédito (`CARDMW3Q6KO0MT61`). A transação foi imediatamente recusada pelo antifraude do Mercado Pago (`cc_rejected_high_risk`).
3. **06/11/2026 12:57:24 Local:** Atingido o prazo de 24h, o webhook do Mercado Pago cancelou o Pix `PIXMW3Q4C0BRTJC` por expiração (`expired`).
4. **06/11/2026 13:08:57 Local — PAGAMENTO EFETIVADO:**
   - A participante retornou ao site e inseriu os dados de cartão de crédito (`CARDMW5662ZYMQ4T`).
   - **Às 13:09:01 Local, o Mercado Pago APROVOU o pagamento de R$ 50,00.**
   - O e-mail de confirmação oficial foi enviado com sucesso pela plataforma via Brevo (`Message-ID: <202611061609.36006068530@smtp-relay.mailin.fr>`).
   - **Causa da Ausência de Vínculo:** No formulário do checkout, a participante preencheu `luisagabrielly@gmail.com`, enquanto na inscrição original constava `luisagabriellyw@gmail.com`. A rotina de confirmação [confirmarPagamentoResiliente](file:///d:/Documentos/Projetos/SITE%20EJC/supabase/functions/checkout-process/index.ts#L687-L704) tentou atualizar a inscrição por e-mail e não encontrou correspondência exata, deixando `inscricao_id = NULL`.

> [!CAUTION]
> **DIRETRIZ DE PROTEÇÃO CONTRA COBRANÇA EM DUPLICIDADE:**  
> **Não deve ser gerada nenhuma nova cobrança nem solicitada qualquer ação financeira à participante Luísa Barreto.** O valor de R$ 50,00 já foi recebido e creditado na conta do Mercado Pago. A regularização consiste unicamente em atualizar o campo `inscricao_id` da transação `CARDMW5662ZYMQ4T` e alterar o status da inscrição `0bf52dbb-fa68-4aac-b62d-999d15c75072` para `confirmado` na etapa de correções.

---

### 7. MECANISMO DE BUSCA DE INSCRIÇÕES E MATRIZ DE GOVERNANÇA

#### 7.1. Causa Técnica da Inscrição Não Aparecer no Checkout
A inspeção do código-fonte em `supabase/functions/checkout-process/index.ts` (linhas 909-915) e em `api/checkout-process.js` (linha 638) revelou que a busca de participantes no checkout aplica o seguinte filtro estrito no Supabase:
```typescript
let query = supabase
  .from("inscricoes")
  .select("id, nome_completo, email, whatsapp, sub, pagamento_status, ...")
  .eq("arquivado", false)
  .is("motivo_arquivamento", null)
  .in("pagamento_status", ["pendente", "cancelado"])
  .order("criado_em", { ascending: false })
  .limit(10);
```
- **Fato Confirmado:** Inscrições com status `recusado` (caso de cartão não aprovado) **são completamente ignoradas** pela consulta. Esse comportamento é uma cópia idêntica da regra implementada no código antigo da Vercel (`api/checkout-process.js`, linha 638).
- **Impacto:** Quando o cartão da Luísa foi recusado em 05/11, o sistema marcou a inscrição como `recusado`. A partir desse instante, a participante ficou impedida de localizar seu registro no checkout para tentar outro método de pagamento.

#### 7.2. Matriz Pericial de Governança e Risco de Duplicidade

| Status da Inscrição | Significado Operacional | Elegível para Pagar Online? | Risco de Cobrança em Duplicidade | Tratamento Recomendado |
| :--- | :--- | :---: | :---: | :--- |
| **`pendente`** | Cadastro realizado, aguardando pagamento inicial. | **SIM** | Baixo | Permitir checkout normalmente (Pix ou Cartão). |
| **`recusado`** | Cartão anterior recusado pelo banco emissor/antifraude. | **SIM** | Baixo | **Deve ser incluído na busca.** Permitir retry com outro cartão ou via Pix. |
| **`cancelado`** | Pix anterior expirou (sem motivo de arquivamento administrativo). | **SIM** | Médio | Permitir recuperação gerando novo Pix ou cartão, desde que a vaga no Sub permaneça aberta. |
| **`informado`** | Participante realizou transferência bancária e anexou comprovante. | **NÃO** | **CRÍTICO / ALTO** | **PROIBIDO COBRAR.** Inscrição em análise humana. Solicitar pagamento online induzirá o participante a pagar duas vezes. |
| **`rejeitado`** | Comprovante manual conferido e rejeitado pela coordenação. | **CONDICIONAL** | Médio | Liberar para pagamento somente após o participante ser cientificado formalmente do indeferimento. |
| **`confirmado` / `approved`** | Inscrição já liquidada e confirmada. | **NÃO** | **EXTREMO** | Bloquear qualquer nova tentativa de cobrança (`400 - Inscrição já paga`). |

---

### 8. COMPARAÇÃO FINANCEIRA: AMBIENTE ATUAL VS BACKUP VERCEL

| Dimensão Pericial | Estado no Backup Vercel (02/10/2026) | Estado Atual em Produção (07/11/2026) | Variação / Diagnóstico |
| :--- | :---: | :---: | :--- |
| **Inscrições Cadastradas** | 364 | 493 | +129 inscrições recebidas. |
| **Inscrições Ativas** | 364 | 420 | +56 inscrições ativas líquidas (73 arquivadas). |
| **Pagamentos Registrados** | 138 | 347 | +209 tentativas registradas no banco. |
| **Pagamentos Aprovados** | 115 (R$ 50) + 1 (R$ 0,01) | 137 transações aprovadas | Crescimento financeiro consistente. |
| **Transações de R$ 70,00** | **0 (Inexistentes)** | 2 (Larissa e Alanna) | Inseridas sinteticamente após a era Vercel por script de intervenção. |
| **Transações de R$ 51,50** | **0 (Inexistentes)** | 3 transações | Introdução regular da taxa de cartão à vista em 16/10/2026. |
| **Pagamentos Órfãos Aprovados** | 4 (PIX da virada do lote) | 7 transações | Acúmulo de divergências tipográficas em checkout desacompanhado. |
| **Filtro `buscar_inscricoes`** | `["pendente", "cancelado"]` | `["pendente", "cancelado"]` | Regra idêntica mantida sem alteração na migração. |

---

### 9. LIMITAÇÕES DA AUDITORIA E RECOMENDAÇÕES PRIORIZADAS

#### 9.1. Limitações Metodológicas
1. A auditoria não teve acesso direto via API de leitura ao extrato bancário do Mercado Pago da coordenação para checar a liquidação líquida das transações `PIXMUNIVSYZZ5ZW` e `PIXMUOALY4GRCZF` (R$ 70,00).
2. Não foi possível auditar os dados cadastrais das transações órfãs 6 e 7 (`dudsmaria3030@gmail.com` e `tiphannybeatriz.c2@gmail.com`), pois nenhum registro com esses dados existe na tabela `inscricoes`.

#### 9.2. Recomendações Priorizadas para Futuras Correções (Sem Execução Automática)
1. **Prioridade 1 — Reconciliação Cadastral da Luísa Barreto:** Vincular a transação aprovada `CARDMW5662ZYMQ4T` à inscrição `0bf52dbb-fa68-4aac-b62d-999d15c75072` e alterar seu status para `confirmado`.
2. **Prioridade 2 — Reconciliação das Transações Órfãs 2 e 3:** Vincular `PIXMVQRQAJWFHUG` à inscrição de Yanni Barros Marques e `PIXMW5NN6JNHKLZ` à inscrição de Davi Paulo, regularizando ambos para `confirmado`.
3. **Prioridade 3 — Validação Externa de R$ 70,00:** Solicitar à coordenação financeira o extrato de entradas do Mercado Pago referente a 30/09 para checar o valor real recolhido de Larissa e Alanna.
4. **Prioridade 4 — Correção da Busca no Checkout:** Ajustar o filtro de [buscar_inscricoes](file:///d:/Documentos/Projetos/SITE%20EJC/supabase/functions/checkout-process/index.ts#L914) para incluir o status `recusado`, permitindo que participantes com cartão reprovado encontrem sua inscrição para tentar novamente.
5. **Prioridade 5 — Bloqueio de Cobrança Online para Status `informado`:** Adicionar validação no backend para impedir que inscrições aguardando conferência de comprovante manual gerem novas cobranças no checkout.
