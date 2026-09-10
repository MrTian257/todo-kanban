import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const source = dirname(require.resolve('vditor/package.json'));
const project = fileURLToPath(new URL('../', import.meta.url));
const destination = join(project, 'public/vendor/vditor');
rmSync(join(destination, "dist"), { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
// 离线同步解析器、语言和主题；不复制任何第三方字体文件。
for (const folder of ['js', 'css', 'images']) {
  cpSync(join(source, 'dist', folder), join(destination, 'dist', folder), {
    recursive: true,
    filter: path => !path.endsWith('.map') && !path.endsWith('.d.ts') && !/\.(woff2?|ttf|otf|eot)$/i.test(path),
  });
}
writeFileSync(join(destination, 'LICENSE'), readFileSync(join(source, 'LICENSE')));

// Vditor 固定传入 output=html；本地运行时适配为 MathML，免去数学字体资源。
const katex = dirname(require.resolve('katex/package.json'));
const mathDestination = join(destination, 'dist/js/katex');
mkdirSync(mathDestination, { recursive: true });
const runtime = readFileSync(join(katex, 'dist/katex.min.js'), 'utf8');
writeFileSync(join(mathDestination, 'katex.min.js'), runtime + `
;(function () {
  var original = window.katex.renderToString;
  window.katex.renderToString = function (math, options) {
    return original.call(window.katex, math, Object.assign({}, options, { output: "mathml", trust: false }));
  };
})();
`);
writeFileSync(join(mathDestination, 'katex.min.css'), '.katex-display{display:block;margin:1em 0;text-align:center}.katex math{white-space:normal}');
cpSync(join(katex, 'LICENSE'), join(mathDestination, 'LICENSE'));
