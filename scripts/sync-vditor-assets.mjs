import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const source = dirname(require.resolve('vditor/package.json'));
const project = fileURLToPath(new URL('../', import.meta.url));
const destination = join(project, 'public/vendor/vditor');
mkdirSync(destination, { recursive: true });
// Runtime-loaded parser, locale, icons, math fonts and content themes stay offline.
for (const folder of ['js', 'css', 'images']) {
  cpSync(join(source, 'dist', folder), join(destination, 'dist', folder), {
    recursive: true,
    filter: path => !path.endsWith('.map') && !path.endsWith('.d.ts'),
  });
}
writeFileSync(join(destination, 'LICENSE'), readFileSync(join(source, 'LICENSE')));

// Use the same KaTeX runtime and fonts as the application's read-only renderer.
const katex = dirname(require.resolve('katex/package.json'));
const mathDestination = join(destination, 'dist/js/katex');
for (const name of ['katex.min.js', 'katex.min.css', 'fonts']) {
  cpSync(join(katex, 'dist', name), join(mathDestination, name), { recursive: true });
}
cpSync(join(katex, 'LICENSE'), join(mathDestination, 'LICENSE'));
