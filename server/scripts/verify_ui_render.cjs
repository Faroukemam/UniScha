// Render each routed page without starting a browser or touching saved data.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const client = path.join(root, 'client');
const clientRequire = createRequire(path.join(client, 'package.json'));
const esbuild = clientRequire('esbuild');
const app = fs.readFileSync(path.join(client, 'src/App.jsx'), 'utf8');
const pages = [...app.matchAll(/import (\w+Page) from '(\.\/pages\/[^']+)'/g)];
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unisc-ui-render-'));
const outfile = path.join(directory, 'render.cjs');
try {
  const imports = pages.map(([, name, file]) => `import ${name} from ${JSON.stringify(path.join(client, 'src', file))};`).join('\n');
  const contents = `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import {StaticRouter} from 'react-router-dom/server'; ${imports}
    const pages = {${pages.map(([, name]) => name).join(',')}};
    for (const [name, Page] of Object.entries(pages)) {
      const html = renderToStaticMarkup(<StaticRouter location="/"><Page /></StaticRouter>);
      if (!html || !html.includes('class=')) throw new Error(name + ': no page content');
      console.log('PASS ' + name + ' (' + html.length + ' characters)');
    }
    console.log(JSON.stringify({pages: Object.keys(pages).length, result: 'PASS', scope: 'Initial component rendering; browser interactions and layout are not covered.'}));`;
  esbuild.buildSync({ stdin: { contents, resolveDir: client, loader: 'jsx' }, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', outfile, logLevel: 'silent' });
  require(outfile);
} finally {
  const resolved = fs.realpathSync(directory);
  if (!resolved.startsWith(fs.realpathSync(os.tmpdir()) + path.sep)) throw new Error('Unexpected temporary path');
  fs.rmSync(resolved, { recursive: true, force: true });
}
