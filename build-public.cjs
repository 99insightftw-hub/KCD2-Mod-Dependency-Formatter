'use strict';
// Windows portable build from this checkout, npm's pinned packages, and disclosed vendor runtimes.
const fs=require('fs/promises'),path=require('path'),crypto=require('crypto'),{execFileSync}=require('child_process');
const root=__dirname,sha=b=>crypto.createHash('sha256').update(b).digest('hex');
async function inventory(dir,base=dir,result={}){for(const e of (await fs.readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const f=path.join(dir,e.name);if(e.isSymbolicLink())throw Error('Linked build input: '+f);if(e.isDirectory())await inventory(f,base,result);else result[path.relative(base,f).replaceAll('\\','/')]=sha(await fs.readFile(f));}return result;}
async function main(){
 if(process.platform!=='win32'||process.arch!=='x64')throw Error('Build on Windows x64.');
 const output=path.resolve(process.argv[2]||path.join(root,'dist','KCD2 Mod Dependency Formatter 1.0.0'));
 if(await fs.stat(output).catch(()=>null))throw Error('Choose a new, nonexistent output folder.');
 const pins=JSON.parse(await fs.readFile(path.join(root,'vendor-sha256.json'),'utf8'));
 const actual=await inventory(path.join(root,'vendor'),root);if(JSON.stringify(actual)!==JSON.stringify(pins))throw Error('Vendor runtime hashes changed.');
 require('./tools/bundle-locales.cjs')();
 const pkg=require('./package.json'),electron=path.join(root,'node_modules/electron/dist');
 if(require('./node_modules/electron/package.json').version!==pkg.devDependencies.electron)throw Error('Electron version mismatch. Run npm ci.');
 await fs.mkdir(output,{recursive:true});
 for(const e of await fs.readdir(electron,{withFileTypes:true}))if(e.name!=='resources')await fs.cp(path.join(electron,e.name),path.join(output,e.name),{recursive:true,errorOnExist:true});
 const app=path.join(output,'resources/app');await fs.mkdir(app,{recursive:true});
 for(const n of ['main.js','preload.js','package.json','package-lock.json','LICENSE','THIRD_PARTY_NOTICES.txt','src'])await fs.cp(path.join(root,n),path.join(app,n),{recursive:true});
 // Install only locked production dependencies, without executing dependency install scripts.
 execFileSync('cmd.exe',['/d','/s','/c','npm ci --omit=dev --ignore-scripts --no-audit --no-fund'],{cwd:app,stdio:'inherit',windowsHide:true});
 for(const n of ['7za.exe','7ZIP-LICENSE.txt'])await fs.copyFile(path.join(root,'vendor',n),path.join(output,'resources',n));
 const exe=path.join(output,pkg.productName+'.exe');await fs.rename(path.join(output,'electron.exe'),exe);
 const icon=path.join(root,'src/assets/app/kcd2-icon.ico');await fs.copyFile(icon,path.join(output,'resources/app-icon.ico'));
 execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'set-app-icon.ps1'),'-Exe',exe,'-Icon',icon],{stdio:'inherit',windowsHide:true});
 await fs.copyFile(path.join(root,'README.txt'),path.join(output,'README.txt'));
 const files=await inventory(output),archives=Object.keys(files).filter(n=>/\.(zip|7z|rar|asar)$/i.test(n));if(archives.length)throw Error('Nested archive present: '+archives.join(', '));
 const receipt={version:pkg.version,format:'unpacked Electron app; no Python or RPG helper runtime',files,treeSha256:sha(Buffer.from(JSON.stringify(files))),vendorManifestSha256:sha(await fs.readFile(path.join(root,'vendor-sha256.json')))};
 await fs.writeFile(output+'.build.json',JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify({output,files:Object.keys(files).length,treeSha256:receipt.treeSha256,nestedArchives:archives}));
}
main().catch(e=>{console.error(e);process.exitCode=1});
