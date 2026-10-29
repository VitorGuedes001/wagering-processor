/**
 * Demonstração do que a onda 1 entrega no domínio (docs/ONDA-1.md §3.2).
 * Não toca banco nem fila: é a regra de negócio pura, como os use cases vão usá-la.
 *
 *   bun scripts/demo-onda1.ts
 */
import { decideWager, type WagerDecision } from '../src/domain/decide-wager';
import { WalletBalanceChanged } from '../src/domain/events/wallet-balance-changed';
import { Money } from '../src/domain/money';
import { payloadHash } from '../src/domain/payload-hash';
import { reconcile } from '../src/domain/reconcile';
import { type BackoffPolicy, WagerTransaction, WagerTransactionKind, type SubmittableKind } from '../src/domain/wager-transaction';
import { Wallet } from '../src/domain/wallet';
import type { WalletLedgerEntry } from '../src/domain/wallet-ledger-entry';

const BACKOFF: BackoffPolicy = { baseMs: 1_000, maxMs: 300_000, maxAttempts: 10 };
const at = new Date('2026-10-28T12:00:00.000Z');
const id = () => crypto.randomUUID();
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

function title(text: string): void {
  console.log(`\n── ${text}`);
}

function show(decision: WagerDecision): string {
  return decision.type === 'REJECT' ? `REJECT ${decision.code}` : decision.type === 'APPLY' ? `APPLY ${decision.direction ?? '(sem lançamento)'}` : decision.type;
}

const playerId = id();
const walletId = id();
const ledger: WalletLedgerEntry[] = [];

/** `reference` é a transação referenciada, ou só o id externo dela quando ainda não chegou. */
function submit(kind: SubmittableKind, externalTransactionId: string, amount: string, reference?: WagerTransaction | string) {
  const referenceExternalTransactionId = typeof reference === 'string' ? reference : reference?.externalTransactionId;
  const props = {
    providerId: 'provider-a',
    externalTransactionId,
    playerId,
    walletId,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    ...(referenceExternalTransactionId ? { referenceExternalTransactionId } : {}),
  };
  return WagerTransaction.create({
    ...props,
    id: id(),
    idempotencyKey: `provider-a:${externalTransactionId}`,
    payloadHash: payloadHash(props),
    money: brl(amount),
    at,
  });
}

/** O que o use case da T30 fará: decidir e, se for o caso, aplicar no saldo e no ledger. */
function process(wallet: Wallet, tx: WagerTransaction, reference?: WagerTransaction): WagerDecision {
  const decision = decideWager({ transaction: tx, wallet, reference, referenceAlreadyReversed: false, backoff: BACKOFF });
  if (decision.type === 'APPLY') {
    if (decision.direction !== undefined) {
      const move = decision.direction === 'DEBIT' ? wallet.debit.bind(wallet) : wallet.credit.bind(wallet);
      const entry = move(tx.money, tx.id, id(), at);
      ledger.push(entry);
      const event = WalletBalanceChanged.from(wallet, entry, { eventId: id(), correlationId: 'demo', occurredAt: at });
      console.log(`   evento ${event.eventType}: ${JSON.stringify(event.toJSON().data.balanceAfter)}`);
    }
    tx.markProcessed(reference?.id, wallet.balance, at);
  } else if (decision.type === 'REJECT') {
    tx.reject(decision.code, wallet.balance, at);
  } else {
    tx.markPendingReference(at, BACKOFF);
  }
  console.log(`   ${tx.kind} ${tx.money} → ${show(decision)} · status ${tx.status} · saldo ${wallet.balance} · version ${wallet.version}`);
  return decision;
}

title('1. Money: dinheiro nunca é number (restrição 5.1)');
for (const amount of ['25.00', '25', '25.5', '1e3', '-5.00', 25 as unknown as string]) {
  try {
    console.log(`   ${JSON.stringify(amount)} → ${Money.from({ amount, currency: 'BRL' })}`);
  } catch (error) {
    console.log(`   ${JSON.stringify(amount)} → rejeitado: ${(error as Error).name}`);
  }
}

title('2. Wallet aberta com 100.00 BRL (OPENING gera lançamento, version 1)');
const openingId = id();
const { wallet, openingEntry } = Wallet.open({ id: walletId, playerId, initialBalance: brl('100.00'), openingTransactionId: openingId, openingEntryId: id(), at });
const opening = WagerTransaction.opening({ id: openingId, walletId, playerId, money: brl('100.00'), at });
if (openingEntry) ledger.push(openingEntry);
console.log(`   saldo ${wallet.balance} · version ${wallet.version} · OPENING ${opening.status}`);

title('3. Cenário obrigatório (CHALLENGE §8): duas BET de 80.00 sobre 100.00');
const bet = submit(WagerTransactionKind.Bet, 'bet-1', '80.00');
process(wallet, bet);
process(wallet, submit(WagerTransactionKind.Bet, 'bet-2', '80.00'));
console.log('   (aqui é sequencial; a prova com 3 processos em paralelo é a T32, onda 3)');

title('4. Ciclo de uma rodada: WIN, REFUND da BET e ROLLBACK do WIN');
const win = submit(WagerTransactionKind.Win, 'win-1', '30.00', bet);
process(wallet, win, bet);
process(wallet, submit(WagerTransactionKind.Refund, 'refund-1', '80.00', bet), bet);
process(wallet, submit(WagerTransactionKind.Rollback, 'rollback-1', '30.00', win), win);

title('5. Fora de ordem: REFUND de uma BET que ainda não chegou');
process(wallet, submit(WagerTransactionKind.Refund, 'refund-orphan', '10.00', 'bet-que-ainda-nao-chegou'), undefined);

title('6. Reconciliação: saldo materializado contra o ledger (CHALLENGE §9)');
const result = reconcile(wallet, ledger);
console.log(`   stored ${result.storedBalance} · calculated ${result.calculatedBalance} · difference ${result.difference}`);
console.log(`   consistent ${result.consistent} · cadeia íntegra ${result.chainIntact} · lançamentos ${result.checkedEntries}`);

title('7. Idempotência: mesmo comando, mesmo hash; payload diferente, hash diferente');
const base = { providerId: 'provider-a', externalTransactionId: 't-1', playerId, walletId, roundId: 'r', gameId: 'g', kind: WagerTransactionKind.Bet, money: { amount: '25.00', currency: 'BRL' } } as const;
console.log(`   igual:     ${payloadHash(base) === payloadHash({ ...base })}`);
console.log(`   diferente: ${payloadHash(base) === payloadHash({ ...base, money: { amount: '26.00', currency: 'BRL' } })}`);
