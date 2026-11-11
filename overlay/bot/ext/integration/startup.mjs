/**
 * Однократная подготовка overlay перед импортом ядра.
 * Навигация: [Обвязка](../README.md).
 * Локальные пакеты владельца: [local-ext](../local-ext.mjs).
 */
import { Bot } from 'grammy';
import { enrichPath } from '../ensure-cli.mjs';
import { syncExtAuthGate } from '../setup-bypass.mjs';
import { hydrateLocalSshHost, installLocalSshFetchPatch } from '../local-ssh.mjs';
import { loadLocalExt, MSB_LOCAL_API } from '../local-ext.mjs';
import { installUpdateHook } from './update-hook.mjs';
import { EXT_MARKER } from './shared.mjs';

let prepared = false;

export async function prepare() {
  if (prepared) return;
  prepared = true;

  process.env.PATH = enrichPath(process.env);

  try {
    await hydrateLocalSshHost();
    installLocalSshFetchPatch();
  } catch (err) {
    console.error(`${EXT_MARKER} local-ssh boot:`, err?.message || err);
  }

  try {
    await syncExtAuthGate();
  } catch (err) {
    console.error(`${EXT_MARKER} setup-bypass boot:`, err?.message || err);
  }

  installUpdateHook(Bot);

  try {
    await loadLocalExt({ apiVersion: MSB_LOCAL_API, hooks: {} });
  } catch (err) {
    console.error(`${EXT_MARKER} local-ext boot:`, err?.message || err);
  }

  console.error(`${EXT_MARKER} Bot.prototype.handleUpdate patched (ESM Bot)`);
}
