import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money';
import { reconcile } from '../../src/domain/reconcile';
import { Wallet } from '../../src/domain/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../../src/domain/wallet-ledger-entry';

const T0 = new Date('2026-10-28T10:00:00.000Z');
const T1 = new Date('2026-10-28T10:01:00.000Z');
const T2 = new Date('2026-10-28T10:02:00.000Z');
const T3 = new Date('2026-10-28T10:03:00.000Z');

const WALLET_ID = '0192f000-0000-7000-8000-0000000000aa';
const PLAYER_ID = '0192f000-0000-7000-8000-0000000000bb';

const money = (amount: string, currency = 'BRL'): Money =>
  amount.startsWith('-')
    ? Money.fromPersistence(amount, currency)
    : Money.from({ amount, currency });

describe('reconcile — MODELAGEM §11 e §12', () => {
  test('consistente: wallet aberta com saldo zero e sem lançamentos', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      initialBalance: money('0.00'),
      openingTransactionId: 'tx-open-unused',
      openingEntryId: 'entry-open-unused',
      at: T0,
    });
    expect(openingEntry).toBeUndefined();

    const result = reconcile(wallet, []);

    expect(result.walletId).toBe(WALLET_ID);
    expect(result.storedBalance.equals(money('0.00'))).toBe(true);
    expect(result.calculatedBalance.equals(money('0.00'))).toBe(true);
    expect(result.difference.equals(money('0.00'))).toBe(true);
    expect(result.chainIntact).toBe(true);
    expect(result.consistent).toBe(true);
    expect(result.checkedEntries).toBe(0);
  });

  test('consistente: wallet aberta com saldo zero e primeiro lançamento em walletVersion = 2 (MODELAGEM §3, §11)', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      initialBalance: money('0.00'),
      openingTransactionId: 'tx-open-unused',
      openingEntryId: 'entry-open-unused',
      at: T0,
    });
    expect(openingEntry).toBeUndefined();

    const e1 = wallet.credit(money('100.00'), 'tx-1', 'entry-1', T1);
    const e2 = wallet.debit(money('35.00'), 'tx-2', 'entry-2', T2);
    const e3 = wallet.credit(money('15.00'), 'tx-3', 'entry-3', T3);

    expect(e1.walletVersion).toBe(2);
    expect(e1.balanceBefore.equals(money('0.00'))).toBe(true);

    const result = reconcile(wallet, [e1, e2, e3]);

    expect(result.walletId).toBe(WALLET_ID);
    expect(result.storedBalance.equals(money('80.00'))).toBe(true);
    expect(result.calculatedBalance.equals(money('80.00'))).toBe(true);
    expect(result.difference.equals(money('0.00'))).toBe(true);
    expect(result.chainIntact).toBe(true);
    expect(result.consistent).toBe(true);
    expect(result.checkedEntries).toBe(3);
  });

  test('consistente: wallet aberta com saldo positivo (OPENING em walletVersion = 1) e sequência de débitos e créditos', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      initialBalance: money('100.00'),
      openingTransactionId: 'tx-open',
      openingEntryId: 'entry-open',
      at: T0,
    });
    expect(openingEntry).toBeDefined();

    const e2 = wallet.debit(money('100.00'), 'tx-2', 'entry-2', T1);
    const e3 = wallet.credit(money('42.50'), 'tx-3', 'entry-3', T2);

    const result = reconcile(wallet, [openingEntry!, e2, e3]);

    expect(result.storedBalance.equals(money('42.50'))).toBe(true);
    expect(result.calculatedBalance.equals(money('42.50'))).toBe(true);
    expect(result.difference.equals(money('0.00'))).toBe(true);
    expect(result.chainIntact).toBe(true);
    expect(result.consistent).toBe(true);
    expect(result.checkedEntries).toBe(3);
  });

  test('saldo divergente para mais (stored > calculated): difference positiva, chainIntact = true, consistent = false', () => {
    const { openingEntry } = Wallet.open({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      initialBalance: money('100.00'),
      openingTransactionId: 'tx-open',
      openingEntryId: 'entry-open',
      at: T0,
    });
    const tamperedWallet = Wallet.rehydrate({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      currency: 'BRL',
      balance: money('150.00'),
      version: 1,
      createdAt: T0,
      updatedAt: T0,
    });

    const result = reconcile(tamperedWallet, [openingEntry!]);

    expect(result.storedBalance.equals(money('150.00'))).toBe(true);
    expect(result.calculatedBalance.equals(money('100.00'))).toBe(true);
    expect(result.difference.equals(money('50.00'))).toBe(true);
    expect(result.difference.isPositive()).toBe(true);
    expect(result.chainIntact).toBe(true);
    expect(result.consistent).toBe(false);
    expect(result.checkedEntries).toBe(1);
  });

  test('saldo divergente para menos (stored < calculated): difference negativa, chainIntact = true, consistent = false', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      initialBalance: money('100.00'),
      openingTransactionId: 'tx-open',
      openingEntryId: 'entry-open',
      at: T0,
    });
    const e2 = wallet.credit(money('50.00'), 'tx-2', 'entry-2', T1);

    const tamperedWallet = Wallet.rehydrate({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      currency: 'BRL',
      balance: money('120.00'),
      version: 2,
      createdAt: T0,
      updatedAt: T1,
    });

    const result = reconcile(tamperedWallet, [openingEntry!, e2]);

    expect(result.storedBalance.equals(money('120.00'))).toBe(true);
    expect(result.calculatedBalance.equals(money('150.00'))).toBe(true);
    expect(result.difference.equals(money('-30.00'))).toBe(true);
    expect(result.difference.isNegative()).toBe(true);
    expect(result.difference.toJSON()).toEqual({ amount: '-30.00', currency: 'BRL' });
    expect(result.chainIntact).toBe(true);
    expect(result.consistent).toBe(false);
    expect(result.checkedEntries).toBe(2);
  });

  test('wallet com saldo positivo mas sem lançamentos: calculatedBalance = 0.00, chainIntact = true, consistent = false', () => {
    const wallet = Wallet.rehydrate({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      currency: 'BRL',
      balance: money('75.00'),
      version: 1,
      createdAt: T0,
      updatedAt: T0,
    });

    const result = reconcile(wallet, []);

    expect(result.storedBalance.equals(money('75.00'))).toBe(true);
    expect(result.calculatedBalance.equals(money('0.00'))).toBe(true);
    expect(result.difference.equals(money('75.00'))).toBe(true);
    expect(result.chainIntact).toBe(true);
    expect(result.consistent).toBe(false);
    expect(result.checkedEntries).toBe(0);
  });

  test('cadeia quebrada no primeiro lançamento (balanceBefore !== 0.00), mesmo quando stored == calculated', () => {
    const wallet = Wallet.rehydrate({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      currency: 'BRL',
      balance: money('90.00'),
      version: 1,
      createdAt: T0,
      updatedAt: T0,
    });
    const firstNotFromZero = WalletLedgerEntry.create({
      id: 'entry-1',
      walletId: WALLET_ID,
      transactionId: 'tx-1',
      walletVersion: 1,
      direction: LedgerDirection.Credit,
      money: money('90.00'),
      balanceBefore: money('10.00'),
      balanceAfter: money('100.00'),
      at: T0,
    });

    const result = reconcile(wallet, [firstNotFromZero]);

    expect(result.storedBalance.equals(money('90.00'))).toBe(true);
    expect(result.calculatedBalance.equals(money('90.00'))).toBe(true);
    expect(result.difference.equals(money('0.00'))).toBe(true);
    expect(result.chainIntact).toBe(false);
    expect(result.consistent).toBe(false);
    expect(result.checkedEntries).toBe(1);
  });

  test('cadeia quebrada no meio (balanceBefore !== balanceAfter anterior), mesmo quando stored == calculated', () => {
    // Σ CREDIT − Σ DEBIT = 100 − 20 + 50 = 130.00, igual ao storedBalance da wallet
    const wallet = Wallet.rehydrate({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      currency: 'BRL',
      balance: money('130.00'),
      version: 3,
      createdAt: T0,
      updatedAt: T2,
    });

    const e1 = WalletLedgerEntry.create({
      id: 'entry-1',
      walletId: WALLET_ID,
      transactionId: 'tx-1',
      walletVersion: 1,
      direction: LedgerDirection.Credit,
      money: money('100.00'),
      balanceBefore: money('0.00'),
      balanceAfter: money('100.00'),
      at: T0,
    });
    // Salto: balanceBefore é 80.00 em vez de 100.00
    const e2BrokenGap = WalletLedgerEntry.create({
      id: 'entry-2',
      walletId: WALLET_ID,
      transactionId: 'tx-2',
      walletVersion: 2,
      direction: LedgerDirection.Debit,
      money: money('20.00'),
      balanceBefore: money('80.00'),
      balanceAfter: money('60.00'),
      at: T1,
    });
    const e3 = WalletLedgerEntry.create({
      id: 'entry-3',
      walletId: WALLET_ID,
      transactionId: 'tx-3',
      walletVersion: 3,
      direction: LedgerDirection.Credit,
      money: money('50.00'),
      balanceBefore: money('60.00'),
      balanceAfter: money('110.00'),
      at: T2,
    });

    const result = reconcile(wallet, [e1, e2BrokenGap, e3]);

    expect(result.storedBalance.equals(money('130.00'))).toBe(true);
    expect(result.calculatedBalance.equals(money('130.00'))).toBe(true);
    expect(result.difference.equals(money('0.00'))).toBe(true);
    expect(result.chainIntact).toBe(false);
    expect(result.consistent).toBe(false);
    expect(result.checkedEntries).toBe(3);
  });

  test('lançamento reidratado com aritmética interna corrompida (!isBalanced) marca chainIntact = false e consistent = false', () => {
    const wallet = Wallet.rehydrate({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      currency: 'BRL',
      balance: money('50.00'),
      version: 1,
      createdAt: T0,
      updatedAt: T0,
    });
    const corruptedEntry = WalletLedgerEntry.rehydrate({
      id: 'entry-corrupted',
      walletId: WALLET_ID,
      transactionId: 'tx-1',
      walletVersion: 1,
      direction: LedgerDirection.Credit,
      money: money('50.00'),
      balanceBefore: money('0.00'),
      balanceAfter: money('99.00'),
      createdAt: T0,
    });

    const result = reconcile(wallet, [corruptedEntry]);

    expect(result.storedBalance.equals(money('50.00'))).toBe(true);
    expect(result.calculatedBalance.equals(money('50.00'))).toBe(true);
    expect(result.difference.equals(money('0.00'))).toBe(true);
    expect(result.chainIntact).toBe(false);
    expect(result.consistent).toBe(false);
    expect(result.checkedEntries).toBe(1);
  });
});
