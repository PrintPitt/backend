// Klien viem bersama untuk script ops dan service backend. Konfigurasi lewat env; private key tidak pernah ditulis ke file.
import { createPublicClient, createWalletClient, defineChain, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { anvil, monadTestnet } from 'viem/chains';
import { deploymentUntuk, fotokopiKilatAbi, tidrxAbi } from '@printpitt/shared';

export const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
const POLL_MS = Number(process.env.POLL_MS ?? 300);

/** Chain, public client, contract, dan token tIDRX. CONTRACT_ADDRESS / TOKEN_ADDRESS / BATAS_ANTRE di env menimpa file deployment. */
export async function koneksi() {
  const probe = createPublicClient({ transport: http(RPC_URL) });
  const chainId = await probe.getChainId();
  const chain =
    chainId === monadTestnet.id ? monadTestnet : chainId === anvil.id ? anvil : defineChain({ ...anvil, id: chainId });
  // Blok Monad ~0,3 dtk (SPK-03): polling receipt default viem (4 dtk) terlalu lambat.
  const pub = createPublicClient({ chain, transport: http(RPC_URL), pollingInterval: POLL_MS });
  const override = process.env.CONTRACT_ADDRESS as Hex | undefined;
  const d = override
    ? { address: override, tidrx: process.env.TOKEN_ADDRESS, batasAntre: Number(process.env.BATAS_ANTRE ?? 45) }
    : deploymentUntuk(chainId);
  const contract = { address: d.address as Hex, abi: fotokopiKilatAbi } as const;
  const token = { address: (process.env.TOKEN_ADDRESS ?? d.tidrx) as Hex, abi: tidrxAbi } as const;
  if (!token.address) throw new Error('Alamat tIDRX tidak ada: set TOKEN_ADDRESS atau export ulang deployment');
  return { chain, chainId, pub, contract, token, batasAntre: BigInt(d.batasAntre) };
}

export type Koneksi = Awaited<ReturnType<typeof koneksi>>;

/** Wallet client untuk satu private key dari env (null bila env kosong dan tidak wajib). */
export function dompet(k: Koneksi, namaKunci: string, wajib = true) {
  const key = process.env[namaKunci] as Hex | undefined;
  if (!key){ if (wajib) throw new Error(`Set env ${namaKunci} (private key). Jangan simpan di file.`); return null; }
  const account = privateKeyToAccount(key);
  return createWalletClient({ chain: k.chain, account, transport: http(RPC_URL), pollingInterval: POLL_MS });
}

/** Untuk script CLI: koneksi + satu wallet. */
export async function siapkan(namaKunci: string) {
  const k = await koneksi();
  const wallet = dompet(k, namaKunci)!;
  return { ...k, wallet, account: wallet.account };
}

export const jeda = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function log(tag: string, ...args: unknown[]) {
  console.log(new Date().toISOString().slice(11, 19), `[${tag}]`, ...args);
}

export const pesanError = (e: unknown) => (e as Error).message.split('\n')[0];

/** Error yang dijawab ke klien HTTP sebagai `{ error: code }` dengan status ini. */
export class ApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, status: number) { super(code); this.code = code; this.status = status; }
}
