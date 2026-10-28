---
name: explicar-mudanca
description: Explica ao humano o diff de uma tarefa TNN ou de uma branch do Wagering Processor, trecho a trecho, na ordem da nota, ligando cada mudança à regra dos docs que a motiva. Use quando o humano pedir para explicar, entender, percorrer ou fazer walkthrough de uma mudança, tarefa, branch ou commit.
---

# Explicar mudança

Objetivo: o humano entender **o que mudou e por quê** a ponto de aprovar ou
recusar com segurança. Você é professor, não vendedor. Aponte também o que está
fraco.

## 1. Montar o mapa

```bash
git diff --stat main...<branch>
git log --format='%h %s%n%b' main..<branch>
```

Leia a nota da tarefa e use a "Ordem de leitura do diff" dela. Sem nota, ordene
assim: domínio → aplicação → infraestrutura → interface → testes.

## 2. Explicar em blocos pequenos

Para cada arquivo, nessa ordem, um bloco de cada vez:

1. **Papel:** uma frase sobre o que este arquivo é no sistema.
2. **O que mudou:** o trecho relevante (poucas linhas, com `arquivo:linha`).
3. **Por quê:** a regra que motiva, com referência (ex.: "SCHEMA 4.2 passo 4:
   segunda busca sob o lock, porque o atalho do passo 2 não protege corrida").
4. **O que aconteceria sem isso:** o cenário de falha concreto.
5. **Teste que prova:** o ID e onde está.

Depois de cada arquivo, pare e pergunte se pode seguir. Não despeje o diff
inteiro de uma vez.

## 3. Fechar

- Resuma em 3 a 5 linhas o comportamento novo do sistema.
- Liste o que **você** acha frágil ou não coberto, mesmo que o revisor tenha
  aprovado.
- Sugira 1 ou 2 perguntas que o humano pode fazer para testar o próprio
  entendimento. Exemplo: "o que acontece se duas instâncias receberem a mesma
  mensagem ao mesmo tempo?".

## Regras

- Não invente motivo. Se a nota e os docs não justificam um trecho, diga isso: é
  achado.
- Prefira o vocabulário dos docs (wallet, ledger, inbox, outbox, `failureCode`).
- Responda em português.
