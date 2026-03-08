const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

async function buildClientBundle() {
  const root = path.resolve(__dirname, '..');
  const jsDir = path.join(root, 'public', 'js');
  const jsQrPath = path.join(root, 'node_modules', 'jsqr', 'dist', 'jsQR.js');

  if (!fs.existsSync(jsQrPath)) {
    throw new Error('Missing jsQR dependency. Run: npm install');
  }

  const jsQrSource = fs.readFileSync(jsQrPath, 'utf8');

  const orderedFiles = ['crypto.js', 'peer.js', 'transfer.js', 'app.js'];

  const parts = orderedFiles.map((name) => {
    const full = path.join(jsDir, name);
    if (!fs.existsSync(full)) {
      throw new Error(`Missing client file: ${full}`);
    }
    return fs.readFileSync(full, 'utf8');
  });

  const source = [jsQrSource, ...parts].join('\n;\n');

  const result = await esbuild.transform(source, {
    loader: 'js',
    minify: true,
    sourcemap: false,
    target: ['es2020'],
  });

  const outFile = path.join(jsDir, 'app.bundle.min.js');
  fs.writeFileSync(outFile, result.code, 'utf8');
  console.log(`Built ${path.relative(root, outFile)}`);
}

buildClientBundle().catch((error) => {
  console.error(error);
  process.exit(1);
});
