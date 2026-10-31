'use strict';
// Dopo l'impacchettamento: imposta icona e informazioni di versione dell'eseguibile Windows
// senza bisogno di Wine (resedit è JavaScript puro).
const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const ResEdit = await import('resedit');
  const PE = await import('pe-library');
  const { productName } = context.packager.appInfo;
  const version = context.packager.appInfo.version;
  const exePath = path.join(context.appOutDir, `${productName}.exe`);
  const exe = PE.NtExecutable.from(fs.readFileSync(exePath));
  const res = PE.NtExecutableResource.from(exe);

  const ico = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(__dirname, 'icon.ico')));
  const groups = res.entries.filter((e) => e.type === 14);
  const target = groups[0] || { id: 1, lang: 1033 };
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, target.id, target.lang, ico.icons.map((i) => i.data));

  const vis = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  const vi = vis[0] || ResEdit.Resource.VersionInfo.createEmpty();
  const [a, b, c] = version.split('.').map((n) => parseInt(n, 10) || 0);
  const lang = vi.getAllLanguagesForStringValues()[0] || { lang: 1033, codepage: 1200 };
  vi.setFileVersion(a, b, c, 0, lang.lang);
  vi.setProductVersion(a, b, c, 0, lang.lang);
  vi.setStringValues(lang, {
    FileDescription: productName,
    ProductName: productName,
    CompanyName: 'Redmango S.r.l.',
    LegalCopyright: 'Redmango S.r.l.',
    OriginalFilename: `${productName}.exe`,
    InternalName: productName,
  });
  vi.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
  console.log(`  • icona e versione impostate su ${path.basename(exePath)}`);
};
