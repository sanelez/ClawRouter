// src/polymarket/wallet-adapter.ts
//
// Bridges the ported Polymarket trading engine to ClawRouter's own wallet. The
// blockrun-mcp engine reads its signer from `../wallet.js#getOrCreateWalletKey`
// (the ~/.blockrun/.session key); ClawRouter instead derives its EVM key from a
// BIP-39 mnemonic and stores the resulting private key at
// ~/.openclaw/blockrun/wallet.key (see src/auth.ts). This module re-exports the
// two symbols the engine needs — `getOrCreateWalletKey` and `getChainBalance` —
// backed by ClawRouter's key so Polymarket bets are signed by the SAME wallet
// that pays for x402 LLM calls (the user's decision: one wallet, one bankroll).
//
// A private key is chain-agnostic: the ClawRouter EVM key pays API fees on Base
// AND authorizes bets on Polygon. The key never leaves the machine.
import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPublicClient, http, getAddress, type Hex } from "viem";
import { base } from "viem/chains";
import { BASE_USDC, ERC20_ABI, PUSD_DECIMALS } from "./constants.js";

// Mirror src/auth.ts: ClawRouter stores the derived EVM private key here, or the
// operator overrides it with BLOCKRUN_WALLET_KEY (same env auth.ts honors).
const WALLET_FILE = join(homedir(), ".openclaw", "blockrun", "wallet.key");

// Public Base RPCs with fallback, mirroring BASE_RPC_URLS usage elsewhere.
const BASE_RPC_URLS = [
  "https://mainnet.base.org",
  "https://base.llamarpc.com",
  "https://1rpc.io/base",
];

/**
 * The ClawRouter EVM private key used as the Polymarket signer. Synchronous by
 * design (the engine's client factory is sync) — reads BLOCKRUN_WALLET_KEY, else
 * the on-disk key auth.ts writes. Throws with actionable guidance if neither is
 * present, since every trading action needs a signer.
 */
export function getOrCreateWalletKey(): Hex {
  const envKey = process.env.BLOCKRUN_WALLET_KEY?.trim();
  if (envKey && /^0x[0-9a-fA-F]{64}$/.test(envKey)) return envKey as Hex;

  let key: string;
  try {
    key = fs.readFileSync(WALLET_FILE, "utf-8").trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `No ClawRouter wallet found at ${WALLET_FILE}. Run ClawRouter setup / the /wallet ` +
          `command to generate one (or set BLOCKRUN_WALLET_KEY) before trading on Polymarket.`,
        { cause: err },
      );
    }
    throw err;
  }

  if (/^0x[0-9a-fA-F]{64}$/.test(key)) return key as Hex;
  throw new Error(
    `Wallet file at ${WALLET_FILE} is present but not a 0x-prefixed 64-hex key. ` +
      `Restore your backup or set BLOCKRUN_WALLET_KEY.`,
  );
}

function createBaseClient() {
  return createPublicClient({ chain: base, transport: http(BASE_RPC_URLS[0]) });
}
let _baseClient: ReturnType<typeof createBaseClient> | null = null;
function baseClient() {
  return (_baseClient ??= createBaseClient());
}

/**
 * Base USDC balance (in dollars) for `address`. The engine only ever calls this
 * with chain:"base" (fund.ts, to check the bankroll before a deposit); the
 * "solana" branch is unreachable here but kept for signature parity — Polymarket
 * funding is Base-only. Returns null on read failure so callers treat it as $0.
 */
export async function getChainBalance(
  chain: "base" | "solana",
  address: string,
): Promise<number | null> {
  if (chain === "solana") return null; // Polymarket funding never uses Solana.
  try {
    const raw = (await baseClient().readContract({
      address: BASE_USDC as Hex,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [getAddress(address)],
    })) as bigint;
    return Number(raw) / 10 ** PUSD_DECIMALS; // USDC and pUSD share 6 decimals.
  } catch {
    return null;
  }
}
