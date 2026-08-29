#!/usr/bin/env node
// The `paybox` command installed by `npm install -g paybox-emulator` (and what
// `npx paybox-emulator` runs). It does two things before loading the bundle,
// and both have to happen before anything imports `node:sqlite`, which is why
// the bundle is loaded with a dynamic import at the very end rather than a
// static one at the top (static imports are hoisted above this code).
//
// 1. Refuse old Node with a message that names the fix. The storage layer uses
//    the built-in `node:sqlite`, which arrived in 22.5; on anything older the
//    first sign of trouble would otherwise be ERR_UNKNOWN_BUILTIN_MODULE from
//    deep inside the bundle, and `npx` does not enforce `engines` by itself.
//
// 2. Silence `node:sqlite`'s ExperimentalWarning on Node 22, where it prints on
//    every start and buries the banner. Only that one warning: deprecations and
//    everything else still reach Node's own printer, so nothing is hidden that
//    a developer would want to see. `node --disable-warning=ExperimentalWarning`
//    would be broader and cannot be set from a shebang portably anyway.

const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  process.stderr.write(
    `paybox needs Node 22.5 or newer; this is Node ${process.versions.node}.\n` +
      'It uses the built-in node:sqlite module, so there is nothing to compile — ' +
      'upgrading Node is the whole fix.\n',
  );
  process.exit(1);
}

const printers = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && /sqlite/i.test(warning.message)) return;
  for (const print of printers) print.call(process, warning);
});

await import('../dist/paybox.js');
