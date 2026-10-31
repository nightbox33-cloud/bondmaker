const fs = require('fs');
const path = require('path');
const solc = require('solc');

const POC_DIR = __dirname;
const REPO_ROOT = path.resolve(POC_DIR, '..', '..');

function findImports(importPath) {
  const normalized = importPath.replace(/^(\.\.\/)+/, '');

  if (normalized.startsWith('node_modules/@openzeppelin/')) {
    const full = path.join(POC_DIR, normalized);
    if (fs.existsSync(full)) return { contents: fs.readFileSync(full, 'utf8') };
    return { error: `not found: ${importPath}` };
  }

  if (normalized.startsWith('contracts/')) {
    const full = path.join(REPO_ROOT, normalized);
    if (fs.existsSync(full)) return { contents: fs.readFileSync(full, 'utf8') };
    return { error: `not found: ${importPath}` };
  }

  const candidates = [
    path.join(REPO_ROOT, 'contracts', normalized),
    path.join(REPO_ROOT, normalized),
    path.join(POC_DIR, 'node_modules/@openzeppelin/contracts', normalized),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return { contents: fs.readFileSync(candidate, 'utf8') };
  }
  return { error: `not found: ${importPath}` };
}

function compileAll() {
  const entries = [
    'contracts/bondMaker/BondMakerCollateralizedEth.sol',
    'contracts/bondMaker/EthBondMakerCollateralizedUsdc.sol',
    'contracts/bondToken/BondTokenFactory.sol',
    'contracts/bondTokenName/BondTokenName.sol',
    'contracts/oracle/oracle.test.sol',
    'contracts/token/USDC.test.sol',
    'contracts/oracle/PriceInverseOracle.sol',
    'contracts/token/ERC20Mintable.sol',
    'contracts/bondPricer/BondPricer.sol',
    'contracts/bondPricer/SbtPricerWithStableBorder.sol',
  ];

  const sources = {};
  for (const entry of entries) {
    sources[entry] = {
      content: fs.readFileSync(path.join(REPO_ROOT, entry), 'utf8'),
    };
  }

  const input = {
    language: 'Solidity',
    sources,
    settings: {
      optimizer: { enabled: true, runs: 20000 },
      evmVersion: 'constantinople',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };

  const output = JSON.parse(
    solc.compile(JSON.stringify(input), { import: findImports }),
  );
  const errors = (output.errors || []).filter((e) => e.severity === 'error');
  if (errors.length) {
    for (const error of errors) console.error(error.formattedMessage);
    throw new Error('compile failed');
  }

  const artifacts = {};
  for (const [file, contracts] of Object.entries(output.contracts)) {
    for (const [name, contract] of Object.entries(contracts)) {
      if (contract.evm && contract.evm.bytecode && contract.evm.bytecode.object) {
        artifacts[name] = {
          abi: contract.abi,
          bytecode: `0x${contract.evm.bytecode.object}`,
          file,
        };
      }
    }
  }

  fs.writeFileSync(
    path.join(POC_DIR, 'artifacts.json'),
    JSON.stringify(artifacts, null, 1),
  );
  console.log('compiled:', Object.keys(artifacts).sort().join(', '));
  return artifacts;
}

if (require.main === module) compileAll();
module.exports = { compileAll };
