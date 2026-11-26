pragma circom 2.1.6;

/*
 * transact: the single circuit behind every deposit, private transfer and
 * withdrawal in the shielded pool.
 *
 * One transaction spends up to two notes and creates exactly two notes:
 *
 *   note       = (amount, owner public key, blinding)
 *   public key = Poseidon(private key)
 *   commitment = Poseidon(TAG_NOTE, amount, pubKey, blinding)
 *   nullifier  = Poseidon(TAG_NULLIFIER, commitment, leaf index, private key)
 *
 * What the circuit proves, and nothing more:
 *   1. every input note that carries value is a leaf of the commitment tree
 *      under a published root;
 *   2. the prover knows the private key that owns every input note;
 *   3. the nullifiers are derived correctly and are distinct;
 *   4. inputs + publicAmount = outputs (value is conserved);
 *   5. every output amount is below 2^96, so no sum wraps the field;
 *   6. the auditor ciphertext really seals the sender key and both outputs;
 *   7. the statement is bound to extDataHash.
 *
 * The domain tags keep hashes of different kinds from ever colliding: a
 * commitment can never double as a nullifier or as a keystream word.
 */

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/switcher.circom";
include "circomlib/circuits/babyjub.circom";
include "circomlib/circuits/escalarmulany.circom";
include "circomlib/circuits/escalarmulfix.circom";

// Root of the incremental Merkle path that starts at `leaf` on position `index`.
// Level 0 pairs the leaf with its sibling, exactly as the contract does when it
// inserts two leaves side by side.
template MerkleRoot(levels) {
    signal input leaf;
    signal input index;
    signal input siblings[levels];
    signal output root;

    component bits = Num2Bits(levels);
    bits.in <== index;

    component sw[levels];
    component h[levels];
    signal cur[levels + 1];
    cur[0] <== leaf;
    for (var i = 0; i < levels; i++) {
        sw[i] = Switcher();
        sw[i].sel <== bits.out[i];
        sw[i].L <== cur[i];
        sw[i].R <== siblings[i];

        h[i] = Poseidon(2);
        h[i].inputs[0] <== sw[i].outL;
        h[i].inputs[1] <== sw[i].outR;
        cur[i + 1] <== h[i].out;
    }
    root <== cur[levels];
}

template Transact(levels) {
    var AMOUNT_BITS = 96;
    var NONCE_BITS = 251;
    var AUDIT_WORDS = 5;
    var TAG_NOTE = 1;
    var TAG_NULLIFIER = 2;
    var TAG_AUDIT = 3;
    // Generator of the prime-order subgroup of BabyJubJub, in twisted Edwards form.
    var BASE8[2] = [
        5299619240641551281634865583518297030282874472190772894086521144482721001553,
        16950150798460657717958625567821834550301663161624707787222815936182638968203
    ];

    // ---------------------------------------------------------------- public
    // Order matters: the pool contract assembles these 16 words.
    signal input root;                    // [0]
    signal input publicAmount;            // [1] deposit - withdrawal - fee, in the field
    signal input extDataHash;             // [2]
    signal input inputNullifier[2];       // [3..4]
    signal input outputCommitment[2];     // [5..6]
    signal input auditorPubKey[2];        // [7..8]
    signal input auditEphemeral[2];       // [9..10]
    signal input auditCipher[AUDIT_WORDS]; // [11..15]

    // --------------------------------------------------------------- private
    signal input privKey;
    signal input inAmount[2];
    signal input inBlinding[2];
    signal input inPathIndex[2];
    signal input inPathElements[2][levels];
    signal input outAmount[2];
    signal input outPubKey[2];
    signal input outBlinding[2];
    signal input auditNonce;

    // The spender's public key. Every input note must be owned by it.
    component pk = Poseidon(1);
    pk.inputs[0] <== privKey;

    // ------------------------------------------------------- input notes
    component inCommit[2];
    component inNull[2];
    component inRoot[2];
    component inIsEmpty[2];
    var sumIn = 0;
    for (var i = 0; i < 2; i++) {
        inCommit[i] = Poseidon(4);
        inCommit[i].inputs[0] <== TAG_NOTE;
        inCommit[i].inputs[1] <== inAmount[i];
        inCommit[i].inputs[2] <== pk.out;
        inCommit[i].inputs[3] <== inBlinding[i];

        inNull[i] = Poseidon(4);
        inNull[i].inputs[0] <== TAG_NULLIFIER;
        inNull[i].inputs[1] <== inCommit[i].out;
        inNull[i].inputs[2] <== inPathIndex[i];
        inNull[i].inputs[3] <== privKey;
        inNull[i].out === inputNullifier[i];

        inRoot[i] = MerkleRoot(levels);
        inRoot[i].leaf <== inCommit[i].out;
        inRoot[i].index <== inPathIndex[i];
        for (var j = 0; j < levels; j++) {
            inRoot[i].siblings[j] <== inPathElements[i][j];
        }

        // A note worth zero is a place holder: it needs no place in the tree.
        // Any other note must sit under the published root.
        inIsEmpty[i] = IsZero();
        inIsEmpty[i].in <== inAmount[i];
        (1 - inIsEmpty[i].out) * (root - inRoot[i].root) === 0;

        sumIn += inAmount[i];
    }

    // The same note cannot be spent twice inside one transaction.
    component sameNullifier = IsEqual();
    sameNullifier.in[0] <== inputNullifier[0];
    sameNullifier.in[1] <== inputNullifier[1];
    sameNullifier.out === 0;

    // ------------------------------------------------------ output notes
    component outCommit[2];
    component outRange[2];
    var sumOut = 0;
    for (var i = 0; i < 2; i++) {
        // Amounts stay below 2^96, so no sum of four of them reaches the field
        // size and the conservation rule below cannot wrap around.
        outRange[i] = Num2Bits(AMOUNT_BITS);
        outRange[i].in <== outAmount[i];

        outCommit[i] = Poseidon(4);
        outCommit[i].inputs[0] <== TAG_NOTE;
        outCommit[i].inputs[1] <== outAmount[i];
        outCommit[i].inputs[2] <== outPubKey[i];
        outCommit[i].inputs[3] <== outBlinding[i];
        outCommit[i].out === outputCommitment[i];

        sumOut += outAmount[i];
    }

    // -------------------------------------------------- value is conserved
    sumIn + publicAmount === sumOut;

    // -------------------------------------------------- the auditor's copy
    // ElGamal style: R = nonce * BASE8 is published, the shared point is
    // nonce * auditorPubKey, and every word is masked by a Poseidon stream
    // keyed on that point. Because all of this is constrained, a sender cannot
    // hand the auditor garbage: the record decrypts to the sender key and the
    // two output notes, or the proof does not exist.
    component onCurve = BabyCheck();
    onCurve.x <== auditorPubKey[0];
    onCurve.y <== auditorPubKey[1];

    component nonceBits = Num2Bits(NONCE_BITS);
    nonceBits.in <== auditNonce;

    component ephemeral = EscalarMulFix(NONCE_BITS, BASE8);
    component shared = EscalarMulAny(NONCE_BITS);
    for (var i = 0; i < NONCE_BITS; i++) {
        ephemeral.e[i] <== nonceBits.out[i];
        shared.e[i] <== nonceBits.out[i];
    }
    shared.p[0] <== auditorPubKey[0];
    shared.p[1] <== auditorPubKey[1];
    ephemeral.out[0] === auditEphemeral[0];
    ephemeral.out[1] === auditEphemeral[1];

    signal plain[AUDIT_WORDS];
    plain[0] <== pk.out;         // sender
    plain[1] <== outAmount[0];   // output 0: amount
    plain[2] <== outPubKey[0];   //          owner
    plain[3] <== outAmount[1];   // output 1: amount
    plain[4] <== outPubKey[1];   //          owner

    // The first nullifier in the key makes every keystream unique to this
    // transaction, so a reused nonce never repeats a keystream.
    component stream[AUDIT_WORDS];
    for (var i = 0; i < AUDIT_WORDS; i++) {
        stream[i] = Poseidon(4);
        stream[i].inputs[0] <== TAG_AUDIT;
        stream[i].inputs[1] <== shared.out[0];
        stream[i].inputs[2] <== inputNullifier[0];
        stream[i].inputs[3] <== i;
        auditCipher[i] === plain[i] + stream[i].out;
    }

    // Ties the proof to the recipient, relayer, fee and encrypted notes: a
    // public input is otherwise free, so it is folded into one constraint.
    signal extSquare;
    extSquare <== extDataHash * extDataHash;
}

component main {public [
    root, publicAmount, extDataHash, inputNullifier, outputCommitment,
    auditorPubKey, auditEphemeral, auditCipher
]} = Transact(24);
