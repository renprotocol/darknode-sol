import BN from "bn.js";

import {
    DarknodeRegistryLogicV1Instance,
    DarknodeRegistryStoreInstance,
    DarknodeSlasherInstance,
    RenProxyAdminInstance,
    RenTokenInstance,
    GetOperatorDarknodesInstance
} from "../types/truffle-contracts";
import {
    deployProxy,
    ID,
    MINIMUM_BOND,
    MINIMUM_EPOCH_INTERVAL_SECONDS,
    MINIMUM_POD_SIZE,
    NULL,
    PUBK,
    waitForEpoch
} from "./helper/testUtils";

const Claimer = artifacts.require("Claimer");
const ForceSend = artifacts.require("ForceSend");
const RenToken = artifacts.require("RenToken");
const DarknodeRegistryStore = artifacts.require("DarknodeRegistryStore");
const DarknodeRegistryProxy = artifacts.require("DarknodeRegistryProxy");
const DarknodeRegistryLogicV1 = artifacts.require("DarknodeRegistryLogicV1");
const DarknodeSlasher = artifacts.require("DarknodeSlasher");
const NormalToken = artifacts.require("NormalToken");
const RenProxyAdmin = artifacts.require("RenProxyAdmin");
const GetOperatorDarknodes = artifacts.require("GetOperatorDarknodes");

const { config } = require("../migrations/networks");

const numAccounts = 10;

contract("DarknodeRegistry", (accounts: string[]) => {
    let ren: RenTokenInstance;
    let dnrs: DarknodeRegistryStoreInstance;
    let dnr: DarknodeRegistryLogicV1Instance;
    let slasher: DarknodeSlasherInstance;
    let proxyAdmin: RenProxyAdminInstance;

    before(async () => {
        ren = await RenToken.deployed();
        dnrs = await DarknodeRegistryStore.deployed();
        const dnrProxy = await DarknodeRegistryProxy.deployed();
        dnr = await DarknodeRegistryLogicV1.at(dnrProxy.address);
        slasher = await DarknodeSlasher.deployed();
        proxyAdmin = await RenProxyAdmin.deployed();
        await dnr.updateSlasher(slasher.address);
        await dnr
            .epoch({ from: accounts[1] })
            .should.be.rejectedWith(
                /DarknodeRegistry: not authorized to call first epoch/
            );
        await waitForEpoch(dnr);

        for (let i = 1; i < numAccounts; i++) {
            await ren.transfer(accounts[i], MINIMUM_BOND);
        }
    });

    it("should return empty list when no darknodes are registered", async () => {
        const nodes = (await dnr.getPreviousDarknodes(NULL, 100)).filter(
            x => x !== NULL
        );
        nodes.length.should.equal(0);
    });

    it("can update minimum bond", async () => {
        await dnr.updateMinimumBond(0x1);
        await waitForEpoch(dnr);
        (await dnr.minimumBond()).should.bignumber.equal(1);
        await dnr
            .updateMinimumBond(MINIMUM_BOND, { from: accounts[1] })
            .should.be.rejectedWith(/Ownable: caller is not the owner/);
        await dnr.updateMinimumBond(MINIMUM_BOND);
        (await dnr.minimumBond()).should.bignumber.equal(1);
        await waitForEpoch(dnr);
        (await dnr.minimumBond()).should.bignumber.equal(MINIMUM_BOND);
    });

    it("can update minimum pod size", async () => {
        await dnr.updateMinimumPodSize(0x0);
        await waitForEpoch(dnr);
        (await dnr.minimumPodSize()).should.bignumber.equal(0);
        await dnr
            .updateMinimumPodSize(MINIMUM_POD_SIZE, { from: accounts[1] })
            .should.be.rejectedWith(/Ownable: caller is not the owner/);
        await dnr.updateMinimumPodSize(MINIMUM_POD_SIZE);
        (await dnr.minimumPodSize()).should.bignumber.equal(0);
        await waitForEpoch(dnr);
        (await dnr.minimumPodSize()).should.bignumber.equal(MINIMUM_POD_SIZE);
    });

    it("can update minimum epoch interval", async () => {
        await dnr.updateMinimumEpochInterval(0x0);
        await waitForEpoch(dnr);
        (await dnr.minimumEpochInterval()).should.bignumber.equal(0);
        await dnr
            .updateMinimumEpochInterval(MINIMUM_EPOCH_INTERVAL_SECONDS, {
                from: accounts[1]
            })
            .should.be.rejectedWith(/Ownable: caller is not the owner/);
        await dnr.updateMinimumEpochInterval(MINIMUM_EPOCH_INTERVAL_SECONDS);
        (await dnr.minimumEpochInterval()).should.bignumber.equal(0);
        await waitForEpoch(dnr);
        (await dnr.minimumEpochInterval()).should.bignumber.equal(
            MINIMUM_EPOCH_INTERVAL_SECONDS
        );
    });

    it("can not register a Dark Node with a bond less than the minimum bond", async () => {
        const lowBond = MINIMUM_BOND.sub(new BN(1));
        await ren.approve(dnr.address, lowBond, { from: accounts[0] });
        await dnr
            .register(ID("A"), PUBK("A"))
            .should.be.rejectedWith(/ERC20: transfer amount exceeds allowance/); // failed transfer
    });

    it("cannot register a darknode with address zero", async () => {
        await dnr
            .register(NULL, PUBK("A"))
            .should.be.rejectedWith(
                /DarknodeRegistry: darknode address cannot be zero/
            ); // failed transfer
    });

    it("can not call epoch before the minimum time interval", async () => {
        await waitForEpoch(dnr);
        await dnr
            .epoch()
            .should.be.rejectedWith(
                /DarknodeRegistry: epoch interval has not passed/
            );
    });

    it("can register, deregister and refund Darknodes", async function() {
        this.timeout(1000 * 1000);
        // [ACTION] Register
        for (let i = 0; i < numAccounts; i++) {
            await ren.approve(dnr.address, MINIMUM_BOND, { from: accounts[i] });
            await dnr.register(ID(i), PUBK(i), { from: accounts[i] });
        }

        const nodeCount = 10;
        await ren.transfer(accounts[2], MINIMUM_BOND.mul(new BN(nodeCount)));
        await ren.approve(dnr.address, MINIMUM_BOND.mul(new BN(nodeCount)), {
            from: accounts[2]
        });

        for (let i = numAccounts; i < numAccounts + nodeCount; i++) {
            await dnr.register(ID(i), PUBK(i), { from: accounts[2] });
        }

        // Wait for epoch
        await waitForEpoch(dnr);

        const getOperatorDarknodes = await GetOperatorDarknodes.new(
            dnr.address
        );

        (
            await getOperatorDarknodes.getOperatorDarknodes(accounts[2])
        ).length.should.bignumber.equal(nodeCount + 1); // +1 from the first loop

        // [ACTION] Deregister
        for (let i = 0; i < numAccounts; i++) {
            await dnr.deregister(ID(i), { from: accounts[i] });
        }

        for (let i = numAccounts; i < numAccounts + nodeCount; i++) {
            await dnr.deregister(ID(i), { from: accounts[2] });
        }

        // Wait for two epochs
        await waitForEpoch(dnr);
        await waitForEpoch(dnr);

        // [ACTION] Refund
        for (let i = 0; i < numAccounts; i++) {
            await dnr.refund(ID(i), { from: accounts[i] });
        }

        for (let i = numAccounts; i < numAccounts + nodeCount; i++) {
            await dnr.refund(ID(i), { from: accounts[2] });
        }

        await ren.transfer(accounts[0], MINIMUM_BOND.mul(new BN(nodeCount)), {
            from: accounts[2]
        });
    });

    it("can check darknode statuses", async () => {
        // WARNING: A lot of code a head

        const owner = accounts[2];
        const id = ID("0");
        const pubk = PUBK("0");

        // [SETUP] Wait for epoch to reset `isRegisteredInPreviousEpoch`
        await waitForEpoch(dnr);

        // [CHECK]
        (await dnr.isRefunded(id)).should.be.true;
        (await dnr.isPendingRegistration(id)).should.be.false;
        (await dnr.isRegistered(id)).should.be.false;
        (await dnr.isDeregisterable(id)).should.be.false;
        (await dnr.isPendingDeregistration(id)).should.be.false;
        (await dnr.isDeregistered(id)).should.be.false;
        (await dnr.isRefundable(id)).should.be.false;
        (await dnr.isRegisteredInPreviousEpoch(id)).should.be.false;

        // [ACTION] Register
        await ren.approve(dnr.address, MINIMUM_BOND, { from: owner });
        await dnr.register(id, pubk, { from: owner });

        // [CHECK]
        (await dnr.isRefunded(id)).should.be.false;
        (await dnr.isPendingRegistration(id)).should.be.true;
        (await dnr.isRegistered(id)).should.be.false;
        (await dnr.isDeregisterable(id)).should.be.false;
        (await dnr.isPendingDeregistration(id)).should.be.false;
        (await dnr.isDeregistered(id)).should.be.false;
        (await dnr.isRefundable(id)).should.be.false;
        (await dnr.isRegisteredInPreviousEpoch(id)).should.be.false;

        await waitForEpoch(dnr);

        // [CHECK]
        (await dnr.isRefunded(id)).should.be.false;
        (await dnr.isPendingRegistration(id)).should.be.false;
        (await dnr.isRegistered(id)).should.be.true;
        (await dnr.isDeregisterable(id)).should.be.true;
        (await dnr.isPendingDeregistration(id)).should.be.false;
        (await dnr.isDeregistered(id)).should.be.false;
        (await dnr.isRefundable(id)).should.be.false;
        (await dnr.isRegisteredInPreviousEpoch(id)).should.be.false;

        await waitForEpoch(dnr);

        // [CHECK]
        (await dnr.isRefunded(id)).should.be.false;
        (await dnr.isPendingRegistration(id)).should.be.false;
        (await dnr.isRegistered(id)).should.be.true;
        (await dnr.isDeregisterable(id)).should.be.true;
        (await dnr.isPendingDeregistration(id)).should.be.false;
        (await dnr.isDeregistered(id)).should.be.false;
        (await dnr.isRefundable(id)).should.be.false;
        (await dnr.isRegisteredInPreviousEpoch(id)).should.be.true;

        // [ACTION] Deregister
        await dnr.deregister(id, { from: owner });

        // [CHECK]
        (await dnr.isRefunded(id)).should.be.false;
        (await dnr.isPendingRegistration(id)).should.be.false;
        (await dnr.isRegistered(id)).should.be.true;
        (await dnr.isDeregisterable(id)).should.be.false;
        (await dnr.isPendingDeregistration(id)).should.be.true;
        (await dnr.isDeregistered(id)).should.be.false;
        (await dnr.isRefundable(id)).should.be.false;
        (await dnr.isRegisteredInPreviousEpoch(id)).should.be.true;

        // [ACTION] Wait for epoch
        await waitForEpoch(dnr);

        (await dnr.isRefunded(id)).should.be.false;
        (await dnr.isPendingRegistration(id)).should.be.false;
        (await dnr.isRegistered(id)).should.be.false;
        (await dnr.isDeregisterable(id)).should.be.false;
        (await dnr.isPendingDeregistration(id)).should.be.false;
        (await dnr.isDeregistered(id)).should.be.true;
        (await dnr.isRefundable(id)).should.be.false;
        (await dnr.isRegisteredInPreviousEpoch(id)).should.be.true;

        // [ACTION] Wait for epoch
        await waitForEpoch(dnr);

        (await dnr.isRefunded(id)).should.be.false;
        (await dnr.isPendingRegistration(id)).should.be.false;
        (await dnr.isRegistered(id)).should.be.false;
        (await dnr.isDeregisterable(id)).should.be.false;
        (await dnr.isPendingDeregistration(id)).should.be.false;
        (await dnr.isDeregistered(id)).should.be.true;
        (await dnr.isRefundable(id)).should.be.true;
        (await dnr.isRegisteredInPreviousEpoch(id)).should.be.false;

        // [ACTION] Refund
        await dnr.refund(id, { from: accounts[0] });

        (await dnr.isRefunded(id)).should.be.true;
        (await dnr.isPendingRegistration(id)).should.be.false;
        (await dnr.isRegistered(id)).should.be.false;
        (await dnr.isDeregisterable(id)).should.be.false;
        (await dnr.isPendingDeregistration(id)).should.be.false;
        (await dnr.isDeregistered(id)).should.be.false;
        (await dnr.isRefundable(id)).should.be.false;
        (await dnr.isRegisteredInPreviousEpoch(id)).should.be.false;
    });

    it("bond is exactly the minimum bond", async () => {
        const owner = accounts[2];
        const id = ID("0");
        const pubk = PUBK("0");

        const renBalanceBefore = new BN(await ren.balanceOf(owner));

        // Approve more than minimum bond
        await ren.approve(dnr.address, MINIMUM_BOND.mul(new BN(2)), {
            from: owner
        });

        // Register
        await dnr.register(id, pubk, { from: owner });

        // Only minimum bond should have been transferred
        (await ren.balanceOf(owner)).should.bignumber.equal(
            renBalanceBefore.sub(MINIMUM_BOND)
        );

        // [RESET]
        await waitForEpoch(dnr);
        await dnr.deregister(id, { from: owner });
        await waitForEpoch(dnr);
        await waitForEpoch(dnr);
        await dnr.refund(id, { from: owner });
    });

    it("[SETUP] Register darknodes for next tests", async () => {
        for (let i = 0; i < numAccounts; i++) {
            await ren.approve(dnr.address, MINIMUM_BOND, { from: accounts[i] });
            await dnr.register(ID(i), PUBK(i), { from: accounts[i] });
        }
        await waitForEpoch(dnr);
    });

    it("can not register a node twice", async () => {
        await ren.approve(dnr.address, MINIMUM_BOND, { from: accounts[0] });
        await dnr
            .register(ID("0"), PUBK("0"))
            .should.be.rejectedWith(
                /DarknodeRegistry: must be refunded or never registered/
            );
    });

    it("can not deregister a node which is not registered", async () => {
        await dnr
            .deregister(ID("-1"))
            .should.be.rejectedWith(/DarknodeRegistry: must be deregisterable/);
    });

    it("only darknode owner can deregister darknode", async () => {
        await dnr
            .deregister(ID("0"), { from: accounts[9] })
            .should.be.rejectedWith(/DarknodeRegistry: must be darknode owner/);
    });

    it("can get the owner of the Dark Node", async () => {
        (await dnr.getDarknodeOperator(ID("0"))).should.equal(accounts[0]);
    });

    it("can get the bond of the Dark Node", async () => {
        (await dnr.getDarknodeBond(ID("0"))).should.bignumber.equal(
            MINIMUM_BOND
        );
    });

    it("can get the Public Key of the Dark Node", async () => {
        (await dnr.getDarknodePublicKey(ID("0"))).should.equal(PUBK("0"));
    });

    it("can deregister dark nodes", async () => {
        await dnr.deregister(ID("0"), { from: accounts[0] });
        await dnr.deregister(ID("1"), { from: accounts[1] });
        await dnr.deregister(ID("4"), { from: accounts[4] });
        await dnr.deregister(ID("5"), { from: accounts[5] });
        await dnr.deregister(ID("8"), { from: accounts[8] });
        await dnr.deregister(ID("9"), { from: accounts[9] });
        await waitForEpoch(dnr);
        (await dnr.isDeregistered(ID("0"))).should.be.true;
        (await dnr.isDeregistered(ID("1"))).should.be.true;
        (await dnr.isDeregistered(ID("4"))).should.be.true;
        (await dnr.isDeregistered(ID("5"))).should.be.true;
        (await dnr.isDeregistered(ID("8"))).should.be.true;
        (await dnr.isDeregistered(ID("9"))).should.be.true;
    });

    it("can't deregister twice", async () => {
        await dnr
            .deregister(ID("0"), { from: accounts[0] })
            .should.be.rejectedWith(/must be deregisterable/);
    });

    it("can get the current epoch's registered dark nodes", async () => {
        const nodes = (await dnr.getDarknodes(NULL, 0)).filter(x => x !== NULL);
        nodes.length.should.equal(numAccounts - 6);
        nodes[0].should.equal(ID("2"));
        nodes[1].should.equal(ID("3"));
        nodes[2].should.equal(ID("6"));
        nodes[3].should.equal(ID("7"));
    });

    it("can get the previous epoch's registered dark nodes", async () => {
        let nodes = (await dnr.getPreviousDarknodes(NULL, 0)).filter(
            x => x !== NULL
        );
        nodes.length.should.equal(numAccounts);

        await waitForEpoch(dnr);

        nodes = (await dnr.getPreviousDarknodes(NULL, 0)).filter(
            x => x !== NULL
        );
        nodes.length.should.equal(numAccounts - 6);
    });

    it("can get the dark nodes in multiple calls", async () => {
        const nodes = [];

        let start = NULL;
        do {
            const newNodes = await dnr.getDarknodes(start, 2);
            start = newNodes[newNodes.length - 1];
            for (const node of newNodes) {
                if (node !== NULL && nodes.indexOf(node) === -1) {
                    nodes.push(node);
                }
            }
        } while (start !== NULL);

        nodes.length.should.equal(numAccounts - 6);
        nodes[0].should.equal(ID("2"));
        nodes[1].should.equal(ID("3"));
        nodes[2].should.equal(ID("6"));
        nodes[3].should.equal(ID("7"));
    });

    it("can get the previous epoch's dark nodes in multiple calls", async () => {
        const nodes = [];

        let start = NULL;
        do {
            const newNodes = await dnr.getPreviousDarknodes(start, 2);
            start = newNodes[newNodes.length - 1];
            for (const node of newNodes) {
                if (node !== NULL && nodes.indexOf(node) === -1) {
                    nodes.push(node);
                }
            }
        } while (start !== NULL);

        nodes.length.should.equal(numAccounts - 6);
        nodes[0].should.equal(ID("2"));
        nodes[1].should.equal(ID("3"));
        nodes[2].should.equal(ID("6"));
        nodes[3].should.equal(ID("7"));
    });

    it("should fail to refund before deregistering", async () => {
        await dnr
            .refund(ID("3"), { from: accounts[3] })
            .should.be.rejectedWith(/must be deregistered/);
    });

    it("can deregister and refund dark nodes", async () => {
        // Deregister
        await dnr.deregister(ID("2"), { from: accounts[2] });
        await dnr.deregister(ID("3"), { from: accounts[3] });
        await dnr.deregister(ID("6"), { from: accounts[6] });
        await dnr.deregister(ID("7"), { from: accounts[7] });

        (await dnr.isPendingDeregistration(ID("2"))).should.be.true;
        (await dnr.isPendingDeregistration(ID("3"))).should.be.true;
        (await dnr.isPendingDeregistration(ID("6"))).should.be.true;
        (await dnr.isPendingDeregistration(ID("7"))).should.be.true;

        // Call epoch
        await waitForEpoch(dnr);

        (await dnr.isRegisteredInPreviousEpoch(ID("2"))).should.be.true;
        (await dnr.isRegisteredInPreviousEpoch(ID("3"))).should.be.true;
        (await dnr.isRegisteredInPreviousEpoch(ID("6"))).should.be.true;
        (await dnr.isRegisteredInPreviousEpoch(ID("7"))).should.be.true;
        (await dnr.isDeregistered(ID("2"))).should.be.true;
        (await dnr.isDeregistered(ID("3"))).should.be.true;
        (await dnr.isDeregistered(ID("6"))).should.be.true;
        (await dnr.isDeregistered(ID("7"))).should.be.true;
        const previousDarknodesEpoch1 = (
            await dnr.getPreviousDarknodes(NULL, 0)
        ).filter(x => x !== NULL);
        await waitForEpoch(dnr);
        const previousDarknodesEpoch2 = (
            await dnr.getPreviousDarknodes(NULL, 0)
        ).filter(x => x !== NULL);
        (
            previousDarknodesEpoch1.length - previousDarknodesEpoch2.length
        ).should.be.equal(4);
        (await dnr.isDeregistered(ID("2"))).should.be.true;
        (await dnr.isDeregistered(ID("3"))).should.be.true;
        (await dnr.isDeregistered(ID("6"))).should.be.true;
        (await dnr.isDeregistered(ID("7"))).should.be.true;

        // Refund
        await dnr.refund(ID("2"), { from: accounts[2] });
        await dnr.refund(ID("3"), { from: accounts[3] });
        await dnr.refund(ID("6"), { from: accounts[6] });
        await dnr.refund(ID("7"), { from: accounts[7] });

        (await dnr.isRefunded(ID("2"))).should.be.true;
        (await dnr.isRefunded(ID("3"))).should.be.true;
        (await dnr.isRefunded(ID("6"))).should.be.true;
        (await dnr.isRefunded(ID("7"))).should.be.true;
        (await ren.balanceOf(accounts[2])).should.bignumber.equal(MINIMUM_BOND);
        (await ren.balanceOf(accounts[3])).should.bignumber.equal(MINIMUM_BOND);
        (await ren.balanceOf(accounts[6])).should.bignumber.equal(MINIMUM_BOND);
        (await ren.balanceOf(accounts[7])).should.bignumber.equal(MINIMUM_BOND);
    });

    it("anyone can refund", async () => {
        const owner = accounts[2];
        const id = ID("2");
        const pubk = PUBK("2");

        // [SETUP] Register and then deregister nodes
        await ren.approve(dnr.address, MINIMUM_BOND, { from: owner });
        await dnr.register(id, pubk, { from: owner });
        await waitForEpoch(dnr);
        await dnr.deregister(id, { from: owner });
        (await dnr.isPendingDeregistration(id)).should.be.true;
        await waitForEpoch(dnr);
        await waitForEpoch(dnr);

        // [ACTION] Refund
        await dnr.refund(id, { from: accounts[0] });

        // [CHECK] Refund was successful and bond was returned
        (await dnr.isRefunded(id)).should.be.true;
        (await ren.balanceOf(owner)).should.bignumber.equal(MINIMUM_BOND);
    });

    it("should fail to refund twice", async () => {
        await dnr
            .refund(ID("2"))
            .should.be.rejectedWith(
                /must be deregistered for at least one epoch/
            );
    });

    it("should throw if refund fails", async () => {
        // [SETUP]
        await ren.approve(dnr.address, MINIMUM_BOND, { from: accounts[0] });
        await dnr.register(ID("2"), PUBK("2"));
        await waitForEpoch(dnr);
        await dnr.deregister(ID("2"));
        await waitForEpoch(dnr);
        await waitForEpoch(dnr);
        await waitForEpoch(dnr);

        // [CHECK] Refund fails if transfer fails
        await ren.pause();
        await dnr.refund(ID("2")).should.be.rejectedWith(/Pausable: paused/);
        await ren.unpause();

        // [RESET]
        await dnr.refund(ID("2"));
    });

    it("should not refund for an address which is never registered", async () => {
        await dnr
            .refund(ID("-1"))
            .should.be.rejectedWith(
                /DarknodeRegistry: must be deregistered for at least one epoch/
            );
    });

    it("can update DarknodePayment", async () => {
        const darknodePayment = await dnr.darknodePayment();
        await dnr
            .updateDarknodePayment(NULL)
            .should.be.rejectedWith(
                /DarknodeRegistry: invalid Darknode Payment address/
            );

        await dnr.updateDarknodePayment(accounts[0]);
        await dnr.updateDarknodePayment(darknodePayment);
    });

    it("cannot slash unregistered darknodes", async () => {
        // Update slasher address
        const newSlasher = accounts[0];
        await dnr.updateSlasher(newSlasher);
        await waitForEpoch(dnr);

        (await dnr.slasher()).should.equal(newSlasher);
        await dnr
            .slash(ID("2"), newSlasher, new BN(70))
            .should.be.rejectedWith(/DarknodeRegistry: invalid darknode/);

        // Reset slasher address
        await dnr.updateSlasher(slasher.address);
        await waitForEpoch(dnr);
        (await dnr.slasher()).should.equal(slasher.address);
    });

    it("cannot slash with an invalid percent", async () => {
        // Update slasher address
        const newSlasher = accounts[0];
        await dnr.updateSlasher(newSlasher);
        await waitForEpoch(dnr);
        (await dnr.slasher()).should.equal(newSlasher);

        // Register darknode 3
        await ren.approve(dnr.address, MINIMUM_BOND, { from: accounts[2] });
        await dnr.register(ID("2"), PUBK("2"), { from: accounts[2] });
        await waitForEpoch(dnr);

        await dnr
            .slash(ID("2"), newSlasher, new BN(101))
            .should.be.rejectedWith(/DarknodeRegistry: invalid percent/);
        await dnr
            .slash(ID("2"), newSlasher, new BN(328293))
            .should.be.rejectedWith(/DarknodeRegistry: invalid percent/);
        await dnr
            .slash(ID("2"), newSlasher, new BN(923))
            .should.be.rejectedWith(/DarknodeRegistry: invalid percent/);

        // Reset slasher
        await dnr.updateSlasher(slasher.address);
        await waitForEpoch(dnr);
        (await dnr.slasher()).should.equal(slasher.address);

        // De-register darknode 3
        await dnr.deregister(ID("2"), { from: accounts[2] });
        (await dnr.isPendingDeregistration(ID("2"))).should.be.true;

        // Call epoch
        await waitForEpoch(dnr);
        await waitForEpoch(dnr);
        (await dnr.isDeregistered(ID("2"))).should.be.true;

        // Refund darknode 3
        await dnr.refund(ID("2"), { from: accounts[2] });
        (await dnr.isRefunded(ID("2"))).should.be.true;
    });

    it("can update slasher address", async () => {
        // [CHECK] This test assumes different previous and new slashers
        const previousSlasher = await dnr.slasher();
        const newSlasher = accounts[3];
        previousSlasher.should.not.equal(newSlasher);

        // [CHECK] The slasher can't be updated to 0x0
        await dnr
            .updateSlasher(NULL)
            .should.be.rejectedWith(
                /DarknodeRegistry: invalid slasher address/
            );

        // [ACTION] Update slasher address
        await dnr.updateSlasher(newSlasher);
        // [CHECK] Verify the address hasn't changed before an epoch
        (await dnr.slasher()).should.equal(previousSlasher);

        // [CHECK] Verify the new slasher address after an epoch
        await waitForEpoch(dnr);
        (await dnr.slasher()).should.equal(newSlasher);

        // [RESET] Reset the slasher address to the previous slasher address
        await dnr.updateSlasher(previousSlasher);
        await waitForEpoch(dnr);
        (await dnr.slasher()).should.equal(previousSlasher);
    });

    it("anyone except the slasher can not call slash", async () => {
        // [SETUP] Set slasher to accounts[3]
        const slasherOwner = accounts[0];
        const notSlasher = accounts[4];

        // [SETUP] Register darknodes 3, 4, 7 and 8
        await ren.approve(dnr.address, MINIMUM_BOND, { from: accounts[2] });
        await ren.approve(dnr.address, MINIMUM_BOND, { from: accounts[3] });
        await ren.approve(dnr.address, MINIMUM_BOND, { from: accounts[6] });
        await ren.approve(dnr.address, MINIMUM_BOND, { from: accounts[7] });
        await dnr.register(ID("2"), PUBK("2"), { from: accounts[2] });
        await dnr.register(ID("3"), PUBK("3"), { from: accounts[3] });
        await dnr.register(ID("6"), PUBK("6"), { from: accounts[6] });
        await dnr.register(ID("7"), PUBK("7"), { from: accounts[7] });
        await waitForEpoch(dnr);
        await dnr.deregister(ID("3"), { from: accounts[3] });
        await waitForEpoch(dnr);
        await waitForEpoch(dnr);

        const slashPercent = 20;

        // [CHECK] Only the slasher can call `slash`
        await dnr
            .slash(ID("2"), ID("6"), slashPercent, { from: notSlasher })
            .should.be.rejectedWith(/DarknodeRegistry: must be slasher/);
        await dnr
            .slash(ID("2"), ID("6"), slashPercent, { from: slasherOwner })
            .should.be.rejectedWith(/DarknodeRegistry: must be slasher/);
        await slasher
            .slash(ID("2"), ID("6"), slashPercent, { from: notSlasher })
            .should.be.rejectedWith(/Ownable: caller is not the owner/);

        await slasher.slash(ID("2"), ID("6"), slashPercent, {
            from: slasherOwner
        });
        await slasher
            .slash(ID("3"), ID("6"), slashPercent, { from: slasherOwner })
            .should.be.rejectedWith(/DarknodeRegistry: invalid darknode/);

        // // NOTE: The darknode doesn't prevent slashing a darknode twice
        await slasher.slash(ID("2"), ID("6"), slashPercent, {
            from: slasherOwner
        });
    });

    it("transfer ownership of the dark node store", async () => {
        const newDnr = await deployProxy<DarknodeRegistryLogicV1Instance>(
            web3,
            DarknodeRegistryProxy,
            DarknodeRegistryLogicV1,
            proxyAdmin.address,
            [
                { type: "string", value: "test" },
                { type: "address", value: RenToken.address },
                { type: "address", value: dnrs.address },
                { type: "uint256", value: config.MINIMUM_BOND.toString() },
                { type: "uint256", value: config.MINIMUM_POD_SIZE },
                {
                    type: "uint256",
                    value: config.MINIMUM_EPOCH_INTERVAL_SECONDS
                },
                { type: "uint256", value: 0 }
            ],
            { from: accounts[0] }
        );

        // [ACTION] Initiate ownership transfer to wrong account
        await dnr.transferStoreOwnership(newDnr.address);

        // [CHECK] Owner should still be the DNR
        (await dnrs.owner()).should.equal(newDnr.address);

        // [RESET] Initiate ownership transfer back to DNR
        await newDnr.transferStoreOwnership(dnr.address);

        // [CHECK] Owner should now be the DNR
        (await dnrs.owner()).should.equal(dnr.address);
    });

    it("can't arbitrarily increase bond", async () => {
        // [SETUP] Transfer store to main account
        const claimer = await Claimer.new(dnrs.address);
        await dnr.transferStoreOwnership(claimer.address);
        await claimer.transferStoreOwnership(accounts[0]);
        await dnrs.claimOwnership({ from: accounts[0] });

        const previousRenBalance = new BN(await ren.balanceOf(accounts[0]));

        // [ACTION] Decrease bond (used for bond slashing)
        const difference = new BN(1);
        const previousBond = new BN(await dnrs.darknodeBond(ID("7")));
        await dnrs.updateDarknodeBond(ID("7"), previousBond.sub(difference));

        // [CHECK] Decreasing bond transfers different to owner
        const afterRenBalance = new BN(await ren.balanceOf(accounts[0]));
        afterRenBalance
            .sub(previousRenBalance)
            .should.be.bignumber.equal(difference);

        // [CHECK] Can't increase bond again
        await dnrs
            .updateDarknodeBond(ID("7"), previousBond)
            .should.be.rejectedWith(
                /DarknodeRegistryStore: bond not decreased/
            );

        // [RESET] Transfer store back to DNR
        await dnrs.transferOwnership(dnr.address);
        await dnr.claimStoreOwnership();
    });

    it("can't decrease bond without transferring REN", async () => {
        // [SETUP] Transfer store to main account
        const claimer = await Claimer.new(dnrs.address);
        await dnr.transferStoreOwnership(claimer.address);
        await claimer.transferStoreOwnership(accounts[0]);
        await dnrs.claimOwnership({ from: accounts[0] });

        // [SETUP] Pause REN to make transfer fail
        await ren.pause();

        // [CHECK] Can't decrease bond if REN is paused
        await dnrs
            .updateDarknodeBond(ID("7"), new BN(0))
            .should.be.rejectedWith(/Pausable: paused/);

        // [RESET] Unpause REN
        await ren.unpause();

        // [RESET] Transfer store back to DNR
        await dnrs.transferOwnership(dnr.address);
        await dnr.claimStoreOwnership();
    });

    describe("recovering funds", () => {
        it("should be able to withdraw funds that are mistakenly sent to the Darknode Registry", async () => {
            await ren.transfer(dnr.address, 1000);

            // Only the owner can recover tokens
            await dnr
                .recoverTokens(ren.address, { from: accounts[1] })
                .should.be.rejectedWith(/Ownable: caller is not the owner/);

            // Recover REN
            const initialRenBalance = new BN(
                (await ren.balanceOf(accounts[0])).toString()
            );
            await dnr.recoverTokens(ren.address, { from: accounts[0] });
            const finalRenBalance = new BN(
                (await ren.balanceOf(accounts[0])).toString()
            );
            finalRenBalance.sub(initialRenBalance).should.bignumber.equal(1000);

            // Recover ETH
            const forceSend = await ForceSend.new();
            await forceSend.send(dnr.address, { value: "1" });
            (
                await web3.eth.getBalance(dnr.address)
            ).should.bignumber.greaterThan(0);
            await dnr.recoverTokens(NULL, { from: accounts[0] });
            (await web3.eth.getBalance(dnr.address)).should.bignumber.equal(0);
        });

        it("should be able to withdraw funds that are mistakenly sent to the Darknode Registry Store", async () => {
            // [SETUP] Transfer store to main account
            const claimer = await Claimer.new(dnrs.address);
            await dnr.transferStoreOwnership(claimer.address);
            await claimer.transferStoreOwnership(accounts[0]);
            await dnrs.claimOwnership({ from: accounts[0] });

            const token = await NormalToken.new();
            await token.transfer(dnrs.address, 1000);
            await ren.transfer(dnrs.address, 1000);

            const initialRenBalance = new BN(
                (await ren.balanceOf(accounts[0])).toString()
            );

            // Can't recover REN
            await dnrs
                .recoverTokens(ren.address, { from: accounts[0] })
                .should.be.rejectedWith(
                    /CanReclaimTokens: token is not recoverable/
                );

            // Only the owner can recover tokens
            await dnrs
                .recoverTokens(token.address, { from: accounts[1] })
                .should.be.rejectedWith(/Ownable: caller is not the owner/);

            // Can recover unrelated token
            const initialTokenBalance = new BN(
                (await token.balanceOf(accounts[0])).toString()
            );
            await dnrs.recoverTokens(token.address, { from: accounts[0] });
            const finalTokenBalance = new BN(
                (await token.balanceOf(accounts[0])).toString()
            );
            finalTokenBalance
                .sub(initialTokenBalance)
                .should.bignumber.equal(1000);

            // Recover ETH
            const forceSend = await ForceSend.new();
            await forceSend.send(dnrs.address, { value: "1" });
            (
                await web3.eth.getBalance(dnrs.address)
            ).should.bignumber.greaterThan(0);
            await dnrs.recoverTokens(NULL, { from: accounts[0] });
            (await web3.eth.getBalance(dnrs.address)).should.bignumber.equal(0);

            // Check that no REN was transferred
            const finalRenBalance = new BN(
                (await ren.balanceOf(accounts[0])).toString()
            );
            finalRenBalance.should.bignumber.equal(initialRenBalance);

            // [RESET] Transfer store back to DNR
            await dnrs.transferOwnership(dnr.address);
            await dnr.claimStoreOwnership();
        });
    });

    describe("when darknode payment is not set", async () => {
        let newDNRstore: DarknodeRegistryStoreInstance;
        let newDNR: DarknodeRegistryLogicV1Instance;

        before(async () => {
            // Deploy a new DNR and DNR store
            newDNRstore = await DarknodeRegistryStore.new(
                "test",
                RenToken.address
            );
            newDNR = await deployProxy<DarknodeRegistryLogicV1Instance>(
                web3,
                DarknodeRegistryProxy,
                DarknodeRegistryLogicV1,
                proxyAdmin.address,
                [
                    { type: "string", value: "test" },
                    { type: "address", value: RenToken.address },
                    { type: "address", value: newDNRstore.address },
                    { type: "uint256", value: config.MINIMUM_BOND.toString() },
                    { type: "uint256", value: config.MINIMUM_POD_SIZE },
                    {
                        type: "uint256",
                        value: config.MINIMUM_EPOCH_INTERVAL_SECONDS
                    },
                    { type: "uint256", value: 0 }
                ],
                { from: accounts[0] }
            );

            // Initiate ownership transfer of DNR store
            await newDNRstore.transferOwnership(newDNR.address);
            await newDNR.claimStoreOwnership();
        });

        it("can still call epoch", async () => {
            await waitForEpoch(newDNR);
            await waitForEpoch(newDNR);
        });

        it("cannot slash", async () => {
            (await newDNR.owner()).should.equal(accounts[0]);
            const newSlasher = accounts[0];
            await newDNR.updateSlasher(newSlasher);
            await waitForEpoch(newDNR);
            (await newDNR.slasher()).should.equal(newSlasher);

            // We should have enough balance to register a darknode
            if (new BN(await ren.balanceOf(accounts[8])).lt(MINIMUM_BOND)) {
                await ren.transfer(accounts[8], MINIMUM_BOND);
            }
            await ren.approve(newDNR.address, MINIMUM_BOND, {
                from: accounts[8]
            });
            await newDNR.register(ID("8"), PUBK("8"), { from: accounts[8] });
            await waitForEpoch(newDNR);
            await newDNR
                .slash(ID("8"), newSlasher, new BN(10))
                .should.be.rejectedWith(
                    /DarknodeRegistry: invalid payment address/
                );
        });
    });

    describe("upgrade DarknodeRegistry while maintaining store", async () => {
        let newDNR: DarknodeRegistryLogicV1Instance;

        let preCountPreviousEpoch: BN;
        let preCount: BN;
        let preCountNextEpoch: BN;
        let preDarknodes: string[];

        before(async () => {
            // Wait for epoch twice so that the number of darknodes in each
            // epoch is the same.
            await waitForEpoch(dnr);
            await waitForEpoch(dnr);

            preCountPreviousEpoch = new BN(
                (await dnr.numDarknodesPreviousEpoch()).toString()
            );
            preCount = new BN((await dnr.numDarknodes()).toString());
            preCountNextEpoch = new BN(
                (await dnr.numDarknodesNextEpoch()).toString()
            );
            preDarknodes = await dnr.getDarknodes(NULL, 0);

            // Deploy a new DNR and DNR store
            newDNR = await deployProxy<DarknodeRegistryLogicV1Instance>(
                web3,
                DarknodeRegistryProxy,
                DarknodeRegistryLogicV1,
                proxyAdmin.address,
                [
                    { type: "string", value: "test" },
                    { type: "address", value: RenToken.address },
                    { type: "address", value: dnrs.address },
                    { type: "uint256", value: config.MINIMUM_BOND.toString() },
                    { type: "uint256", value: config.MINIMUM_POD_SIZE },
                    {
                        type: "uint256",
                        value: config.MINIMUM_EPOCH_INTERVAL_SECONDS
                    },
                    { type: "uint256", value: 0 }
                ],
                { from: accounts[0] }
            );

            // Initiate ownership transfer of DNR store
            await dnr.transferStoreOwnership(newDNR.address);

            // Wait for epoch to populate numDarknodesPreviousEpoch
            await waitForEpoch(newDNR);
        });

        after(async () => {
            await newDNR.transferStoreOwnership(dnr.address);

            await waitForEpoch(dnr);

            new BN(
                (await dnr.numDarknodes()).toString()
            ).should.bignumber.equal(preCount.add(new BN(1)));
        });

        it("number of darknodes is correct", async () => {
            const countPreviousEpoch = new BN(
                (await newDNR.numDarknodesPreviousEpoch()).toString()
            );
            const count = new BN((await newDNR.numDarknodes()).toString());
            const countNextEpoch = new BN(
                (await newDNR.numDarknodesNextEpoch()).toString()
            );
            const darknodes = await newDNR.getDarknodes(NULL, 0);

            countPreviousEpoch.should.bignumber.equal(preCountPreviousEpoch);
            count.should.bignumber.equal(preCount);
            countNextEpoch.should.bignumber.equal(preCountNextEpoch);
            darknodes.should.deep.equal(preDarknodes);

            await ren.approve(newDNR.address, MINIMUM_BOND);
            await newDNR.register(ID("10"), PUBK("10"));

            new BN(
                (await newDNR.numDarknodesNextEpoch()).toString()
            ).should.bignumber.equal(countNextEpoch.add(new BN(1)));

            await waitForEpoch(newDNR);

            new BN(
                (await newDNR.numDarknodes()).toString()
            ).should.bignumber.equal(count.add(new BN(1)));
        });
    });

    // Takes 30 minutes - keep as it.skip when not running
    it.skip("[LONG] can register 6000 dark nodes", async () => {
        const MAX_DARKNODES = 6000;

        // Fund the darknode operator (6000 dark nodes cost a lot to operate!)
        for (let i = 1; i < numAccounts; i++) {
            const balance = await web3.eth.getBalance(accounts[i]);
            web3.eth.sendTransaction({
                to: accounts[0],
                from: accounts[i],
                value: balance,
                gasPrice: 0
            });
        }

        await ren.approve(dnr.address, MINIMUM_BOND.mul(new BN(MAX_DARKNODES)));

        for (let i = 0; i < MAX_DARKNODES; i++) {
            process.stdout.write(`\rRegistering Darknode #${i}`);

            await dnr.register(ID(i), PUBK(i));
        }

        console.debug("");

        await waitForEpoch(dnr);

        let start = NULL;
        do {
            const nodes = await dnr.getDarknodes(start, 50);
            console.debug(nodes);
            start = nodes[nodes.length - 1];
        } while (start !== NULL);

        const numDarknodes = await dnr.numDarknodes();
        numDarknodes.should.bignumber.equal(MAX_DARKNODES);

        for (let i = 0; i < MAX_DARKNODES; i++) {
            process.stdout.write(`\rDeregistering Darknode #${i}`);
            await dnr.deregister(ID(i));
        }

        console.debug("");

        await waitForEpoch(dnr);
        await waitForEpoch(dnr);

        for (let i = 0; i < MAX_DARKNODES; i++) {
            process.stdout.write(`\rRefunding Darknode #${i}`);
            await dnr.refund(ID(i));
        }

        console.debug("");
    });
});
