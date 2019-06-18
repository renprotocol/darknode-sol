import BN from "bn.js";
import { randomBytes } from "crypto";
import { ecrecover, ecsign, pubToAddress } from "ethereumjs-util";

import { BTCShifterInstance, ShifterInstance, zBTCInstance } from "../types/truffle-contracts";
import { increaseTime, NULL } from "./helper/testUtils";

const BTCShifter = artifacts.require("BTCShifter");
const zBTC = artifacts.require("zBTC");

contract("Shifter", ([defaultAcc, feeRecipient, user, malicious]) => {
    let btcShifter: BTCShifterInstance;
    let zbtc: zBTCInstance;

    // We generate a new account so that we have access to its private key for
    // `ecsign`. Web3's sign functions all prefix the message being signed.
    let mintAuthority;
    let privKey;

    const feeInBips = new BN(10);

    before(async () => {
        zbtc = await zBTC.new();
        mintAuthority = web3.eth.accounts.create();
        privKey = Buffer.from(mintAuthority.privateKey.slice(2), "hex")

        btcShifter = await BTCShifter.new(
            NULL,
            zbtc.address,
            feeRecipient,
            mintAuthority.address,
            feeInBips,
        );

        await zbtc.transferOwnership(btcShifter.address);
        await btcShifter.claimTokenOwnership();
    });

    const removeFee = (value, bips) => value.sub(value.mul(new BN(bips)).div(new BN(10000)))

    const mintTest = async (shifter: ShifterInstance, value: BN) => {
        const nHash = `0x${randomBytes(32).toString("hex")}`;
        const pHash = `0x${randomBytes(32).toString("hex")}`;

        const hash = await shifter.sigHash(user, value.toNumber(), nHash, pHash);
        const sig = ecsign(Buffer.from(hash.slice(2), "hex"), privKey);

        pubToAddress(ecrecover(Buffer.from(hash.slice(2), "hex"), sig.v, sig.r, sig.s)).toString("hex")
            .should.equal(mintAuthority.address.slice(2).toLowerCase());

        const sigString = `0x${sig.r.toString("hex")}${sig.s.toString("hex")}${(sig.v).toString(16)}`;

        (await shifter.verifySig(user, value.toNumber(), nHash, pHash, sigString))
            .should.be.true;

        const balanceBefore = new BN((await zbtc.balanceOf(user)).toString());
        await shifter.shiftIn(value.toNumber(), nHash, pHash, sigString, { from: user });
        (await zbtc.balanceOf(user)).should.bignumber.equal(balanceBefore.add(removeFee(value, 10)));

        return [pHash, nHash];
    }

    const burnTest = async (shifter: ShifterInstance, value: BN) => {
        const btcAddress = `0x${randomBytes(35).toString("hex")}`;
        await shifter.shiftOut(btcAddress, removeFee(value, 10).toNumber(), { from: user });
    }

    describe("can mint and burn", () => {
        const value = new BN(200000);
        it("can mint tokens with an unused hash, valid signature and pHash", async () => mintTest(btcShifter, value));
        it("can burn tokens", async () => burnTest(btcShifter, value));
        it("won't mint for the same nHash and pHash twice", async () => {
            const [pHash, nHash] = await mintTest(btcShifter, value);

            const hash = await btcShifter.sigHash(user, value.toNumber(), nHash, pHash);
            const sig = ecsign(Buffer.from(hash.slice(2), "hex"), privKey);
            const sigString = `0x${sig.r.toString("hex")}${sig.s.toString("hex")}${(sig.v).toString(16)}`;

            await (btcShifter.shiftIn(value.toNumber(), nHash, pHash, sigString, { from: user }))
                .should.be.rejectedWith(/nonce hash already spent/);
        });

        it("can mint for the same pHash with a different nHash", async () => {
            const [pHash, _] = await mintTest(btcShifter, value);

            const nHash = `0x${randomBytes(32).toString("hex")}`;

            const hash = await btcShifter.sigHash(user, value.toNumber(), nHash, pHash);
            const sig = ecsign(Buffer.from(hash.slice(2), "hex"), privKey);
            const sigString = `0x${sig.r.toString("hex")}${sig.s.toString("hex")}${(sig.v).toString(16)}`;

            const balanceBefore = new BN((await zbtc.balanceOf(user)).toString());
            await btcShifter.shiftIn(value.toNumber(), nHash, pHash, sigString, { from: user });
            (await zbtc.balanceOf(user)).should.bignumber.equal(balanceBefore.add(removeFee(value, 10)));

            await burnTest(btcShifter, value);
        });

        it("won't mind with an invalid signature", async () => {
            const nHash1 = `0x${randomBytes(32).toString("hex")}`;
            const nHash2 = `0x${randomBytes(32).toString("hex")}`;
            const pHash = `0x${randomBytes(32).toString("hex")}`;

            const hash = await btcShifter.sigHash(user, value.toNumber(), nHash1, pHash);
            const sig = ecsign(Buffer.from(hash.slice(2), "hex"), privKey);

            const sigString = `0x${sig.r.toString("hex")}${sig.s.toString("hex")}${(sig.v).toString(16)}`;

            await (btcShifter.shiftIn(value.toNumber(), nHash2, pHash, sigString, { from: user }))
                .should.be.rejectedWith(/invalid signature/);
        });

        it("can't call forwardShiftOut", async () => {
            const btcAddress = `0x${randomBytes(35).toString("hex")}`;
            await (btcShifter.forwardShiftOut(user, btcAddress, removeFee(value, 10).toNumber(), { from: malicious }))
                .should.be.rejectedWith(/not authorized to burn on behalf of user/);
        })
    });

    describe("upgrading shifter", () => {
        let newShifter;

        // Reset the upgrade
        after(async () => {
            // Trying to reset upgrade in btcShifter without owning the token
            await btcShifter.upgradeShifter(NULL, { from: mintAuthority.address });
            await increaseTime(2 * 60 * 60 * 24);
            await (btcShifter.upgradeShifter(NULL, { from: mintAuthority.address }))
                .should.be.rejectedWith(/must be owner of token to reset upgrade/);

            // Upgrade newShifter to point to btcShifter
            await newShifter.upgradeShifter(btcShifter.address, { from: mintAuthority.address });
            await increaseTime(2 * 60 * 60 * 24);
            await newShifter.upgradeShifter(btcShifter.address, { from: mintAuthority.address });

            // Reset the upgrade in btcShifter
            await btcShifter.upgradeShifter(NULL, { from: mintAuthority.address });
            await increaseTime(2 * 60 * 60 * 24);
            await btcShifter.upgradeShifter(NULL, { from: mintAuthority.address });
        });

        it("can upgrade the shifter", async () => {
            newShifter = await BTCShifter.new(
                btcShifter.address,
                zbtc.address,
                feeRecipient,
                mintAuthority.address,
                feeInBips,
            );

            // Fund and unlock the mintAuthority
            await web3.eth.sendTransaction({ to: mintAuthority.address, from: defaultAcc, value: web3.utils.toWei("1") });
            await web3.eth.personal.importRawKey(mintAuthority.privateKey, "");
            await web3.eth.personal.unlockAccount(mintAuthority.address, "", 6000);

            await (btcShifter.upgradeShifter(newShifter.address, { from: malicious }))
                .should.be.rejectedWith(/must be mint authority/);

            await btcShifter.upgradeShifter(newShifter.address, { from: mintAuthority.address });

            // Too soon
            await btcShifter.upgradeShifter(newShifter.address, { from: mintAuthority.address });
            (await zbtc.owner()).should.equal(btcShifter.address);

            // Sleep for two days
            await increaseTime(2 * 60 * 60 * 24);

            // Not soo soon
            await btcShifter.upgradeShifter(newShifter.address, { from: mintAuthority.address });
            (await zbtc.owner()).should.equal(newShifter.address);
        });

        describe("can mint and burn using old shifter", () => {
            const value = new BN(200000);
            it("can mint tokens", async () => mintTest(btcShifter, value));
            it("can burn tokens", async () => burnTest(btcShifter, value))
        });

        describe("can mint and burn using new shifter", () => {
            const value = new BN(200000);
            it("can mint tokens", async () => mintTest(newShifter, value));
            it("can burn tokens", async () => burnTest(newShifter, value))
        });

        it("can't upgrade to an invalid shifter", async () => {
            await newShifter.upgradeShifter(malicious, { from: mintAuthority.address });

            // Sleep for two days
            await increaseTime(2 * 60 * 60 * 24);

            // Not soo soon
            await (newShifter.upgradeShifter(malicious, { from: mintAuthority.address }))
                .should.be.rejectedWith(/revert/);
        });
    });


    describe("updating fee recipient", () => {
        it("can upgrade the shifter", async () => {
            // Fund and unlock the mintAuthority
            await web3.eth.sendTransaction({ to: mintAuthority.address, from: defaultAcc, value: web3.utils.toWei("1") });
            await web3.eth.personal.importRawKey(mintAuthority.privateKey, "");
            await web3.eth.personal.unlockAccount(mintAuthority.address, "", 6000);

            await (btcShifter.updateFeeRecipient(malicious, { from: malicious }))
                .should.be.rejectedWith(/must be mint authority/);
            await btcShifter.updateFeeRecipient(user, { from: mintAuthority.address });
            await btcShifter.updateFeeRecipient(feeRecipient, { from: mintAuthority.address });
        });
    });
});
