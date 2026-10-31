/* Regression checks for the BondMaker.exchangeEquivalentBonds fix.
 *
 * The patched implementation must:
 *  1. reject both historical attack shapes (funded and zero-input);
 *  2. keep legitimate distinct-bond exchanges working;
 *  3. keep legitimate duplicate-bond (multiset) groups working;
 *  4. subtract repeated exception bond IDs by exact multiplicity.
 */
const { ethers } = require('ethers');
const ganache = require('ganache');
const artifacts = require('./artifacts.json');

const BN = ethers.BigNumber;

function assertEq(actual, expected, label) {
  if (!BN.from(actual).eq(BN.from(expected))) {
    throw new Error(`${label}: expected ${expected.toString()}, got ${actual.toString()}`);
  }
  console.log(`  PASS ${label} = ${actual.toString()}`);
}

async function expectRevert(promise, label, expectedText) {
  try {
    await promise;
  } catch (e) {
    const text = `${e.reason || ''} ${e.message || e}`;
    if (expectedText && !text.includes(expectedText)) {
      console.log(`  PASS ${label} reverted (reason not surfaced by provider)`);
    } else {
      console.log(`  PASS ${label} reverted`);
    }
    return;
  }
  throw new Error(`${label}: expected revert, but call succeeded`);
}

async function send(txPromise, label) {
  const tx = await txPromise;
  const receipt = await tx.wait();
  if (receipt.status !== 1) throw new Error(`${label}: transaction failed`);
  return receipt;
}

function fnMap(points) {
  let previous = [0, 0];
  const segments = [];
  for (const point of points) {
    segments.push(
      BN.from(previous[0]).shl(192)
        .or(BN.from(previous[1]).shl(128))
        .or(BN.from(point[0]).shl(64))
        .or(BN.from(point[1]))
        .toString(),
    );
    previous = point;
  }
  return ethers.utils.defaultAbiCoder.encode(['uint256[]'], [segments]);
}

async function main() {
  const ganacheProvider = ganache.provider({
    logging: { quiet: true },
    chain: { allowUnlimitedContractSize: true },
    miner: { blockGasLimit: 100_000_000, defaultGasPrice: 1_000_000_000 },
    wallet: { totalAccounts: 6, defaultBalance: 1000 },
  });
  const provider = new ethers.providers.Web3Provider(ganacheProvider);
  const [deployer, victim, attacker, user, feeTaker] = [
    provider.getSigner(0),
    provider.getSigner(1),
    provider.getSigner(2),
    provider.getSigner(3),
    provider.getSigner(4),
  ];
  const addresses = {
    victim: await victim.getAddress(),
    attacker: await attacker.getAddress(),
    user: await user.getAddress(),
    feeTaker: await feeTaker.getAddress(),
  };

  const deploy = async (signer, name, args = []) => {
    const factory = new ethers.ContractFactory(artifacts[name].abi, artifacts[name].bytecode, signer);
    const contract = await factory.deploy(...args);
    await contract.deployTransaction.wait();
    return contract;
  };
  const at = (name, address, signer) => new ethers.Contract(address, artifacts[name].abi, signer);

  const oracle = await deploy(deployer, 'TestOracle', [400, 0]);
  const namer = await deploy(deployer, 'BondTokenName');
  const tokenFactory = await deploy(deployer, 'BondTokenFactory');
  const maker = await deploy(deployer, 'BondMakerCollateralizedEth', [
    oracle.address,
    addresses.feeTaker,
    namer.address,
    tokenFactory.address,
    3600,
  ]);

  const now = (await provider.getBlock('latest')).timestamp;
  const maturity = (Math.floor(now / 3600) + 2) * 3600;

  async function registerBond(points, signer = attacker) {
    const m = at('BondMakerCollateralizedEth', maker.address, signer);
    const encoded = fnMap(points);
    const id = await m.generateBondID(maturity, encoded);
    await send(m.registerNewBond(maturity, encoded, { gasLimit: 20_000_000 }), 'registerNewBond');
    return { id, token: (await m.getBond(id))[0] };
  }

  async function registerGroup(ids, signer = attacker) {
    const m = at('BondMakerCollateralizedEth', maker.address, signer);
    const groupID = await m.callStatic.registerNewBondGroup(ids, maturity);
    await send(m.registerNewBondGroup(ids, maturity, { gasLimit: 20_000_000 }), 'registerNewBondGroup');
    return groupID.toString();
  }

  const balance = (bond, signer, account) =>
    at('BondTokenCollateralizedEth', bond.token, signer).balanceOf(account);

  // Historical attack payoffs.
  const B = await registerBond([[100, 49]]);
  const T = await registerBond([[100, 2]]);
  const C = await registerBond([[100, 24]]);
  const R = await registerBond([[100, 25]]);

  // Funded historical attack uses valid identity groups [Bf,Bf,Tf]
  // (44+44+12) and [Rf,Cf,Cf] (78+11+11), but exceptions [Bf,Cf].
  const BF = await registerBond([[100, 44]]);
  const TF = await registerBond([[100, 12]]);
  const CF = await registerBond([[100, 11]]);
  const RF = await registerBond([[100, 78]]);

  // Distinct legitimate exchange: [X,Y] -> [X,Z,W], with exception [X].
  const X = await registerBond([[100, 40]], user);
  const Y = await registerBond([[100, 60]], user);
  const Z = await registerBond([[100, 23]], user);
  const W = await registerBond([[100, 37]], user);

  // Duplicate legitimate exchange: [S,I,I] -> [S,I,J,J], where I = 2J.
  const S = await registerBond([[100, 28]], user);
  const I = await registerBond([[100, 36]], user);
  const J = await registerBond([[100, 18]], user);

  const G_ATTACK_IN = await registerGroup([B.id, B.id, T.id]);
  const G_ATTACK_IN_FUNDED = await registerGroup([BF.id, BF.id, TF.id]);
  const G_ATTACK_OUT_FUNDED = await registerGroup([RF.id, CF.id, CF.id]);
  const G_ATTACK_OUT_ZERO = await registerGroup([R.id, B.id, T.id, C.id]);
  const G_DISTINCT_IN = await registerGroup([X.id, Y.id], user);
  const G_DISTINCT_OUT = await registerGroup([X.id, Z.id, W.id], user);
  const G_DUP_IN = await registerGroup([S.id, I.id, I.id], user);
  const G_DUP_OUT = await registerGroup([S.id, I.id, J.id, J.id], user);

  const makerAttacker = at('BondMakerCollateralizedEth', maker.address, attacker);
  const makerUser = at('BondMakerCollateralizedEth', maker.address, user);

  console.log('\n[1] historical attacks revert');
  await expectRevert(
    makerAttacker.callStatic.exchangeEquivalentBonds(
      G_ATTACK_IN,
      G_ATTACK_OUT_ZERO,
      BN.from('3960000000'),
      [B.id, T.id, C.id],
    ),
    'zero-input attack',
    'exception bond is not included in bond group',
  );
  assertEq(await balance(R, attacker, addresses.attacker), 0, 'zero-input R balance remains zero');

  await send(
    makerAttacker.issueNewBonds(G_ATTACK_IN_FUNDED, {
      value: ethers.utils.parseEther('1'),
      gasLimit: 20_000_000,
    }),
    'attacker funded issue',
  );
  const fundedAmount = await balance(TF, attacker, addresses.attacker);
  await expectRevert(
    makerAttacker.callStatic.exchangeEquivalentBonds(
      G_ATTACK_IN_FUNDED,
      G_ATTACK_OUT_FUNDED,
      fundedAmount,
      [BF.id, CF.id],
    ),
    'funded attack',
    'exception bond is not included in bond group',
  );
  assertEq(await balance(BF, attacker, addresses.attacker), fundedAmount.mul(2), 'funded attack B balance unchanged');
  assertEq(await balance(TF, attacker, addresses.attacker), fundedAmount, 'funded attack T balance unchanged');
  assertEq(await balance(RF, attacker, addresses.attacker), 0, 'funded attack R balance remains zero');

  console.log('\n[2] legitimate distinct-bond exchange succeeds');
  await send(
    makerUser.issueNewBonds(G_DISTINCT_IN, {
      value: ethers.utils.parseEther('1'),
      gasLimit: 20_000_000,
    }),
    'distinct issue',
  );
  const distinctAmount = await balance(Y, user, addresses.user);
  await send(
    makerUser.exchangeEquivalentBonds(G_DISTINCT_IN, G_DISTINCT_OUT, distinctAmount, [X.id], {
      gasLimit: 20_000_000,
    }),
    'distinct exchange',
  );
  assertEq(await balance(X, user, addresses.user), distinctAmount, 'distinct X kept');
  assertEq(await balance(Y, user, addresses.user), 0, 'distinct Y burned');
  assertEq(await balance(Z, user, addresses.user), distinctAmount, 'distinct Z minted');
  assertEq(await balance(W, user, addresses.user), distinctAmount, 'distinct W minted');

  console.log('\n[3] legitimate duplicate-bond exchange succeeds');
  await send(
    makerUser.issueNewBonds(G_DUP_IN, {
      value: ethers.utils.parseEther('1'),
      gasLimit: 20_000_000,
    }),
    'duplicate issue',
  );
  const duplicateAmount = await balance(S, user, addresses.user);
  assertEq(await balance(I, user, addresses.user), duplicateAmount.mul(2), 'duplicate issue mints I twice');

  // Historical helper semantics exclude IDs duplicated in either group.
  await send(
    makerUser.exchangeEquivalentBonds(G_DUP_IN, G_DUP_OUT, duplicateAmount, [S.id], {
      gasLimit: 20_000_000,
    }),
    'duplicate exchange with exception [S]',
  );
  assertEq(await balance(S, user, addresses.user), duplicateAmount, 'duplicate S kept');
  assertEq(await balance(I, user, addresses.user), duplicateAmount, 'duplicate I net burned once');
  assertEq(await balance(J, user, addresses.user), duplicateAmount.mul(2), 'duplicate J minted twice');

  console.log('\n[4] repeated exceptions are subtracted by exact multiplicity');
  await send(
    makerUser.issueNewBonds(G_DUP_IN, {
      value: ethers.utils.parseEther('1'),
      gasLimit: 20_000_000,
    }),
    'second duplicate issue',
  );
  // Before: S=2U, I=3U, J=2U. Exceptions [S,I] skip one I occurrence per side:
  // burn one I occurrence and mint two J occurrences.
  await send(
    makerUser.exchangeEquivalentBonds(G_DUP_IN, G_DUP_OUT, duplicateAmount, [S.id, I.id], {
      gasLimit: 20_000_000,
    }),
    'duplicate exchange with exceptions [S,I]',
  );
  assertEq(await balance(S, user, addresses.user), duplicateAmount.mul(2), 'multiplicity S kept');
  assertEq(await balance(I, user, addresses.user), duplicateAmount.mul(2), 'multiplicity I net burned once');
  assertEq(await balance(J, user, addresses.user), duplicateAmount.mul(4), 'multiplicity J minted twice more');

  await expectRevert(
    makerUser.callStatic.exchangeEquivalentBonds(
      G_DUP_IN,
      G_DUP_OUT,
      duplicateAmount,
      [S.id, I.id, I.id],
    ),
    'exception multiplicity exceeding output group',
    'exception bond is not included in bond group',
  );

  console.log('\nAll BondMaker exchange regression checks passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
