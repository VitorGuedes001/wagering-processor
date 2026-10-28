---
name: entregar-tarefa
description: Fecha uma tarefa TNN do Wagering Processor para revisão. Faz rebase na main, roda o gate de testes pelo que a branch tocou e completa a nota de mudança. Use quando a implementação de uma tarefa terminar ou quando pedirem para entregar, finalizar ou preparar a tarefa para revisão.
---

# Entregar tarefa

A tarefa só sai daqui como `Testada`. Quem marca `Revisada`, `Validada` e
`Entregue` são o revisor cruzado e o humano.

## 1. Atualizar com a main

```bash
git rebase main
```

Os worktrees compartilham o mesmo `.git`, então a `main` que você vê já é a
atual. Não precisa de `fetch`.

Em conflito: resolva só nos arquivos da sua tarefa. Se o conflito é em arquivo
de outra tarefa, pare e informe o humano.

## 2. Gate

```bash
bun run tarefa:gate
```

O gate roda typecheck, a verificação das skills e os testes de unidade e de
arquitetura. Depois roda os níveis de integração e de concorrência conforme os
arquivos que a branch tocou. Um nível sem testes ainda é pulado, e o gate diz
isso.

- **Vermelho:** corrija o código. **Nunca** afrouxe teste de aceite nem
  constraint para passar. Se o teste parece errado, é decisão pendente.
- **Teste instável** (passa às vezes): é bug. Não entregue.

## 3. Completar a nota

Em `docs/notas/TNN-*.md`, confira que estão preenchidos:

- **O que muda:** uma frase por arquivo;
- **Por quê:** com referências aos docs;
- **Ordem de leitura do diff:** do arquivo mais central ao periférico, com o que
  olhar em cada um;
- **Como verificar:** comandos exatos;
- **Decisões pendentes:** vazio, ou cada item com proposta e motivo;
- **Pedidos ao integrador** e **Fora de escopo**.

Atualize a linha de estado da nota para `Estado: Testada`.

## 4. Conferir o escopo

```bash
git diff --stat main...HEAD
```

Todo arquivo da lista precisa estar nos "Arquivos que vou tocar" da nota. Se
algum não está, desfaça a mudança nele ou justifique na nota.

## 5. Avisar

Commit da nota (`docs(tNN): nota de entrega`) e diga ao humano:

> TNN pronta para revisão cruzada: branch `tNN-…`, nota em `docs/notas/TNN-….md`.
> Gate verde: <níveis que rodaram>.
