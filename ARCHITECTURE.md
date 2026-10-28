# Architecture

Decisões, trade-offs e limitações do Wagering Processor. Cada seção é escrita
quando o bloco correspondente fica pronto ([docs/PLANO.md](docs/PLANO.md)). Até
lá, aponta para o documento de planejamento de origem.

## 1. Visão geral

_A escrever no B12._ Fonte: [docs/ARQUITETURA.md](docs/ARQUITETURA.md) §2.

## 2. Modelo de domínio e `Money`

_A escrever no B1._ Fonte: [docs/MODELAGEM.md](docs/MODELAGEM.md).

## 3. ORM, mapeamento e estratégia transacional

_A escrever no B3._ Fonte: [docs/SCHEMA.md](docs/SCHEMA.md) §7, [docs/ARQUITETURA.md](docs/ARQUITETURA.md) D25.

## 4. Schema e garantias no banco

_A escrever no B2._ Fonte: [docs/SCHEMA.md](docs/SCHEMA.md) §2–3.

## 5. Concorrência

_A escrever no B5._ Fonte: [docs/SCHEMA.md](docs/SCHEMA.md) §4.

## 6. Idempotência

_A escrever no B4._ Fonte: [docs/MODELAGEM.md](docs/MODELAGEM.md) §9.

## 7. Contrato HTTP e códigos de falha

_A escrever no B4._ Fonte: [docs/ARQUITETURA.md](docs/ARQUITETURA.md) §6, [docs/MODELAGEM.md](docs/MODELAGEM.md) §10.

## 8. Mensageria: inbox, outbox, retry e DLQ

_A escrever no B6 e B7._ Fonte: [docs/ARQUITETURA.md](docs/ARQUITETURA.md) §7, [docs/SCHEMA.md](docs/SCHEMA.md) §4.4–4.5.

## 9. Referências fora de ordem

_A escrever no B8._ Fonte: [docs/MODELAGEM.md](docs/MODELAGEM.md) D11.

## 10. Observabilidade

_A escrever no B10._ Fonte: [docs/ARQUITETURA.md](docs/ARQUITETURA.md) §9.

## 11. Autenticação

_A escrever no B12._ Fonte: [docs/ARQUITETURA.md](docs/ARQUITETURA.md) §10.

## 12. Testes

_A escrever no B12._ Fonte: [docs/TESTES.md](docs/TESTES.md).

## 13. Ambiente e stack sob Bun

- A CLI do MikroORM 7 roda sob Bun (`bunx --bun mikro-orm`). O fallback para
  Node, previsto no passo 1, não foi necessário.
- TypeScript 7 removeu `baseUrl`. O alias `@/*` usa `paths` relativo.
- `prom-client` foi depreciado. O projeto usa o sucessor oficial,
  `@prometheus-io/client`, com a mesma API.
- Entidades são registradas explicitamente com `ReflectMetadataProvider`. Não há
  varredura de pastas, que depende de ts-morph.

## 14. Limitações conhecidas

Orçamento de 36 h ([docs/PLANO.md](docs/PLANO.md) §2):

- sem teste automatizado de desligamento por `SIGTERM`. Não existe no Windows,
  e o teste exige Linux;
- a aplicação roda fora do Compose (`bun run start:dev`). Só a infra está no
  Compose;
- ≥ 3 instâncias é provado pelos cenários de concorrência com três processos,
  não por um cenário misto dedicado;
- sem teste de carga.
