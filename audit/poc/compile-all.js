const fs = require('fs');
const path = require('path');
const solc = require('solc');

const POC_DIR = __dirname;
const REPO_ROOT = path.resolve(POC_DIR, '..', '..');

function walk(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.name.endsWith('.sol')) files.push(full);
  }
  return files;
}

function findImports(importPath) {
  const normalized = importPath.replace(/^(\.\.\/)+/, '');
  const candidates = [
    path.join(POC_DIR, normalized),
    path.join(REPO_ROOT, normalized),
    path.join(REPO_ROOT, 'contracts', normalized),
    path.join(POC_DIR, 'node_modules/@openzeppelin/contracts', normalized),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return { contents: fs.readFileSync(candidate, 'utf8') };
  }
  return { error: `not found: ${importPath}` };
}

const files = walk(path.join(REPO_ROOT, 'contracts'));
const sources = {};
for (const file of files) {
  const key = path.relative(REPO_ROOT, file).split(path.sep).join('/');
  sources[key] = { content: fs.readFileSync(file, 'utf8') };
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

const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
const errors = (output.errors || []).filter((e) => e.severity === 'error');
const warnings = (output.errors || []).filter((e) => e.severity === 'warning');
for (const warning of warnings) console.warn(warning.formattedMessage.trim());
if (errors.length) {
  for (const error of errors) console.error(error.formattedMessage);
  process.exit(1);
}

let contractCount = 0;
for (const byName of Object.values(output.contracts || {})) {
  contractCount += Object.keys(byName).length;
}
console.log(
  `compiled ${files.length} source files / ${contractCount} contracts with solc ${solc.version()}`,
);
