'use strict';
const path = require('path');

// Theatrical Autobrew's author explicitly says not to run it alongside
// JerryYOJ's Autobrew. JerryYOJ's CMake target produces Autobrew.dll.
const SOURCE = 'https://github.com/EvanJGagnon/KCD2-Mods/blob/main/docs/theatrical_autobrew.txt';
const JERRY_BUILD = 'https://github.com/JerryYOJ/libKCD2/blob/master/Projects/Autobrew/.buildenv/CMakeLists.txt';

function explicitPluginConflicts(mods, binaries) {
  const theatrical = mods.filter(m => m.active &&
    String(m.declaredId || '').toLowerCase() === 'theatrical_autobrew' &&
    binaries.some(b => b.owner === m.id && b.active && b.placed && b.valid && b.architecture === 'x64' && path.basename(b.file).toLowerCase() === 'kcd2_alchemy.dll'));
  if (!theatrical.length) return [];

  const jerry = binaries.filter(b => b.active && b.placed && b.valid &&
    b.architecture === 'x64' &&
    path.basename(b.file).toLowerCase() === 'autobrew.dll' &&
    /[\\/]KCSE[\\/]Plugins[\\/]Autobrew\.dll$/i.test(b.file));
  const findings = [];
  for (const t of theatrical) for (const b of jerry) {
    const owner = mods.find(m => m.active && m.id === b.owner &&
      m.native.some(file => file.toLowerCase() === b.file.toLowerCase()));
    // If a DLL has a manifest owner, the scanner has linked it to that exact
    // active provider. A loose game-root KCSE plugin is also active by layout.
    if (b.owner && !owner) continue;
    findings.push({
      severity: 'review',
      title: 'Possible incompatible Autobrew combination',
      detail: 'An active Autobrew.dll was found alongside Theatrical Autobrew. If it is JerryYOJ’s Autobrew, the author says to disable one of them. The filename has not been verified against an author binary hash.',
      files: [t.manifestPath, b.file],
      source: SOURCE,
      sourceBuild: JERRY_BUILD,
      code: 'declared-autobrew-conflict'
    });
  }
  return findings;
}

module.exports = { explicitPluginConflicts };
