// Note delivery. A note's amount and blinding are sealed to the recipient's encryption key
// and published with the transaction, so the recipient needs nothing but the chain to find
// its money.
//
//   layout: ephemeral X25519 public key (32) | nonce (12) | AES-256-GCM(amount 32 | blinding 32) | tag (16)
//
// The owner's public key is not inside: the recipient knows it, and it accepts a decrypted
// note as its own only if the note's commitment matches the one on chain.
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hexToBytes, toHex } from "viem";

const INFO = new TextEncoder().encode("shielded-note-v1");
export const NOTE_BYTES = 32 + 12 + 64 + 16;

const toBytes32 = (v) => hexToBytes(toHex(v, { size: 32 }));
const fromBytes = (b) => BigInt(toHex(b));

async function aesKey(shared, ephemeral, usage) {
  const raw = hkdf(sha256, shared, ephemeral, INFO, 32);
  return globalThis.crypto.subtle.importKey("raw", raw, "AES-GCM", false, [usage]);
}

/** Seals `note` to the X25519 public key `encKeyHex`. Returns 124 bytes as hex. */
export async function encryptNote(note, encKeyHex) {
  const ephPriv = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const ephPub = x25519.getPublicKey(ephPriv);
  const key = await aesKey(x25519.getSharedSecret(ephPriv, hexToBytes(encKeyHex)), ephPub, "encrypt");
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const plain = new Uint8Array(64);
  plain.set(toBytes32(note.amount), 0);
  plain.set(toBytes32(note.blinding), 32);
  const sealed = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
  const out = new Uint8Array(NOTE_BYTES);
  out.set(ephPub, 0);
  out.set(iv, 32);
  out.set(sealed, 44);
  return toHex(out);
}

/** `{ amount, blinding }` when this note was sealed to us, otherwise null. Never throws. */
export async function decryptNote(hex, encPriv) {
  let bytes;
  try {
    bytes = hexToBytes(hex);
  } catch {
    return null;
  }
  if (bytes.length !== NOTE_BYTES) return null;
  try {
    const ephPub = bytes.slice(0, 32);
    const key = await aesKey(x25519.getSharedSecret(encPriv, ephPub), ephPub, "decrypt");
    const plain = new Uint8Array(await globalThis.crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(32, 44) }, key, bytes.slice(44)));
    return { amount: fromBytes(plain.slice(0, 32)), blinding: fromBytes(plain.slice(32)) };
  } catch {
    return null;
  }
}
