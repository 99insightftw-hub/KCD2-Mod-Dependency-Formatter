'use strict';
const {app,BrowserWindow,ipcMain,dialog,shell}=require('electron');
const localizer=require('./src/native-localize').createLocalizer();
const uiDialog=Object.fromEntries(['showMessageBox','showOpenDialog','showSaveDialog'].map(method=>[method,(window,options)=>dialog[method](window,localizer.dialogOptions(options))]));
const fs=require('fs/promises'),path=require('path'),{Worker}=require('worker_threads');
const {discover,resolveGame}=require('./src/discovery'),{nexusFiles,githubRelease}=require('./src/catalog');
const {pathToFileURL}=require('url');
const appDocument=pathToFileURL(path.join(__dirname,'src/index.html')).href;
const {installPrepared,undoPrepared,exportVortexHelper}=require('./src/downloads');
const vortexBridge=require('./src/vortex-bridge');
const {createPreferences}=require('./src/preferences');
const {gameClosed}=require('./src/repairs');
const workerResult=require('./src/worker-result');
const setup=require('./src/dependency-setup');
const {snapshot:modSnapshot}=require('./src/mod-change-watch');
const {inspectRuntimeEvidence}=require('./src/runtime-evidence');
const {inspectWorkshop}=require('./src/workshop');
const {discoverCommonDownloads,commonDownloadRoots}=require('./src/download-discovery');
const {launchDevmode}=require('./src/launch'),{spawn}=require('child_process');
let downloadFolder,downloadObservations=[],foundDownloads=new Map();
app.setName('KCD2 Mod Dependency Formatter');
// Keep the existing storage path so backups from previous releases remain recoverable.
app.setPath('userData',path.join(app.getPath('appData'),'Elfis Combat Setup'));
const preferences=createPreferences(app.getPath('userData'));
let preferencesLoaded=false;
async function loadPreferences(){const saved=await preferences.read();if(!preferencesLoaded){downloadFolder=saved.downloadFolder||undefined;preferencesLoaded=true;}return saved;}
let win,report,download,worker,busy=false,lastReceipt,archiveJob,closeNotice=false,scanCancelled=false,scanCancellable=false;
const autoOrdersCreated=new Set();
let watchBaseline=null,watchCandidate=null,watchHits=0,watchPolling=false,watchGeneration=0;
function resetWatch(){watchGeneration++;watchBaseline=null;watchCandidate=null;watchHits=0;}
async function readModSnapshot(game){try{return await modSnapshot(game);}catch(error){return {complete:false,signature:null,detail:error.message};}}
function protectActiveOperation(event){
  if(!busy)return;
  event.preventDefault();
  if(closeNotice||!win||win.isDestroyed())return;
  closeNotice=true;
  uiDialog.showMessageBox(win,{type:'info',buttons:['Keep app open'],defaultId:0,cancelId:0,message:'An operation is still running',detail:'Wait until it finishes before closing the app. If Cancel operation is available, use it and wait for cancellation to finish. Backups and restores must not be interrupted.'}).catch(()=>{}).finally(()=>{closeNotice=false;});
}
const sevenZip=()=>path.join(process.resourcesPath,'7za.exe');
function handle(name,fn) {ipcMain.handle(name,async(event,...args)=>{
  if(!win||win.isDestroyed()||event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame||event.senderFrame.url!==appDocument)throw Error('Unknown sender');
  try{return {ok:true,value:await fn(...args)};}catch(e){return {ok:false,error:e.message,...(e.automaticOrder?{automaticOrder:e.automaticOrder}:{})};}
});}
async function choose(properties,filters) {return (await uiDialog.showOpenDialog(win,{properties,filters})).filePaths[0]||null;}
async function exclusive(fn) {if(busy)throw Error('An operation is already running.');busy=true;try{return await fn();}finally{busy=false;}}
async function archiveOperation(data) {
  const flag=new Int32Array(new SharedArrayBuffer(4));
  const job=new Worker(path.join(__dirname,'src/archive-worker.js'),{workerData:{...data,cancel:flag.buffer,sevenZip:sevenZip()}});
  archiveJob={job,flag};win.webContents.send('cancellable',true);
  try{return await workerResult(job,{onProgress:progress=>{if(!win.isDestroyed())win.webContents.send('progress',progress);}});}
  finally{archiveJob=null;if(!win.isDestroyed())win.webContents.send('cancellable',false);}
}
handle('cancel',async()=>{if(worker&&scanCancellable){scanCancelled=true;await worker.terminate();return true;}if(!archiveJob)return false;Atomics.store(archiveJob.flag,0,1);return true;});
handle('get-preferences',loadPreferences);
handle('set-language',locale=>localizer.setLanguage(locale));
handle('discover',()=>discover());
handle('invalidate-scan',()=>{if(busy)throw Error('Wait for the current operation.');resetWatch();report=download=setupPreview=null;return true;});
handle('browse',kind=>kind==='exe'?choose(['openFile'],[{name:'KCD2 executable',extensions:['exe']}]):choose(['openDirectory']));
handle('scan',input=>exclusive(async()=>{
  resetWatch();report=download=setupPreview=null;
  scanCancelled=false;scanCancellable=false;
  let automaticOrder=null;
  try{
    const selectedGame=await resolveGame(String(input)),before=await readModSnapshot(selectedGame);
    worker=new Worker(path.join(__dirname,'src/scan-worker.js'),{workerData:{input:String(input)}});
    scanCancellable=true;win.webContents.send('cancellable',true);
    let result=await workerResult(worker,{key:'report',onProgress:progress=>{if(!scanCancelled&&!win.isDestroyed())win.webContents.send('progress',progress);}});
    if(scanCancelled)throw Error('Scan cancelled. No game files changed.');
    automaticOrder=result.order.exists?{state:'existing',message:'Your existing mod_order.txt was kept.'}:
      {state:'suppressed',message:'Automatic creation is paused for this game during this session. Reopen the app to check again.'};
    if(!result.order.exists&&!autoOrdersCreated.has(result.game.root.toLowerCase())){
      scanCancellable=false;worker=null;win.webContents.send('cancellable',false);
      automaticOrder=await setup.ensureMissingOrder(result,path.join(app.getPath('userData'),'repairs'));
      if(automaticOrder.receipt){setupReceipt=automaticOrder.receipt;autoOrdersCreated.add(result.game.root.toLowerCase());}
      if(automaticOrder.state==='created'){
        autoOrdersCreated.add(result.game.root.toLowerCase());setupReceipt=automaticOrder.receipt;
        worker=new Worker(path.join(__dirname,'src/scan-worker.js'),{workerData:{input:String(input)}});
        result=await workerResult(worker,{key:'report'});
      }
    }
    result.automaticOrder=automaticOrder;
    let prospective=result;
    if(result.mods.some(mod=>!mod.workshop&&!mod.active)){
      worker=new Worker(path.join(__dirname,'src/scan-worker.js'),{workerData:{input:String(input),activateLocal:true}});
      prospective=await workerResult(worker,{key:'report',onProgress:progress=>{if(!scanCancelled&&!win.isDestroyed())win.webContents.send('progress',progress);}});
      if(scanCancelled)throw Error('Scan cancelled. No game files changed.');
    }
    result.prospectiveDependencies=prospective.dependencies;result.prospectiveRequirements=prospective.requirements;
    const loaderFiles=[...new Set(prospective.findings.filter(f=>f.severity==='error'&&['ASI plugins have no recognized loader','LuaDB has no recognized loader'].includes(f.title)).flatMap(f=>f.files||[]))];
    result.loaderNotices=loaderFiles.length?[{id:'asi-loader-choice',consumers:loaderFiles.map(file=>path.basename(file)),detail:'These ASI plugins need a loader. Use Ultimate ASI Loader or a KCSE build that supports ASI loading.'}]:[];
    result.runtimeEvidence=await inspectRuntimeEvidence(result.game,{mods:result.mods});
    const after=await readModSnapshot(result.game);
    if(before.complete&&after.complete&&before.signature===after.signature)watchBaseline=after.signature;
    else {watchBaseline=before.complete?before.signature:null;watchCandidate=after.complete?after.signature:null;watchHits=0;}
    if(scanCancelled)throw Error('Scan cancelled. No game files changed.');
    await preferences.update({gameRoot:result.game.root});
    return report=result;
  }catch(e){
    if(automaticOrder?.receipt){e.automaticOrder=automaticOrder;e.message='The load-order operation has a recovery record, but refreshing the results failed. '+e.message+' Recovery record: '+automaticOrder.receipt;}
    else if(scanCancelled)throw Error('Scan cancelled. No game files changed.');
    throw e;
  }
  finally{worker=null;scanCancellable=false;if(!win.isDestroyed())win.webContents.send('cancellable',false);}
}));
handle('check-mod-changes',async()=>{
 if(busy||watchPolling)return {changed:false,busy:true};
 if(!report)return {changed:false,available:false};
 const selected=report,generation=watchGeneration;watchPolling=true;
 try{
  const current=await readModSnapshot(selected.game);
  if(busy||report!==selected||generation!==watchGeneration)return {changed:false,busy:true};
  if(!current.complete){watchCandidate=null;watchHits=0;return {changed:false,waiting:true,detail:typeof current.detail==='string'?current.detail:'Some mod files are still being checked.'};}
  if(current.signature===watchBaseline){watchCandidate=null;watchHits=0;return {changed:false};}
  if(current.signature!==watchCandidate){watchCandidate=current.signature;watchHits=1;return {changed:false,waiting:true};}
  watchHits++;return watchHits>=2?{changed:true}:{changed:false,waiting:true};
 }finally{watchPolling=false;}
});
let setupPreview,setupReceipt;
handle('recover-setup',()=>exclusive(async()=>{
 const receipt=await choose(['openFile'],[{name:'Setup repair receipt',extensions:['json']}]);if(!receipt)return null;
 const answer=await uiDialog.showMessageBox(win,{type:'question',buttons:['Cancel','Restore this repair'],defaultId:0,cancelId:0,message:'Undo the change saved in this repair record?',detail:'Close the game first. The app will check the backup and current files before restoring them. If the files have changed since this repair, it will stop.'});
 if(answer.response!==1)return null;
 const saved=JSON.parse(await fs.readFile(receipt,'utf8'));
 const restore=saved.kind==='dependency-setup-order-v1'?setup.undoSetup:saved.kind==='order'?require('./src/repairs').undoOrder:saved.kind==='mod-import-v1'?require('./src/mod-import').undo:saved.kind==='dependency'?undoPrepared:saved.kind==='elfis-setup-v1'?require('./src/setup').undoSetup:null;
 if(!restore)throw Error('This receipt is not supported by this version.');
 const result=await restore(receipt,path.join(app.getPath('userData'),'repairs'));
 if(saved.kind==='dependency-setup-order-v1'&&saved.created&&saved.game?.root)autoOrdersCreated.add(saved.game.root.toLowerCase());
 setupReceipt=setupPreview=null;report=download=setupPreview=null;return result;
}));
handle('setup-status',()=>exclusive(async()=>{if(!report)throw Error('Scan first.');return setup.inspectSetup(report);}));
handle('preview-setup',()=>exclusive(async()=>{if(!report)throw Error('Scan first.');return setupPreview=await setup.previewSetup(report);}));
handle('apply-setup',()=>exclusive(async()=>{
 if(!report||!setupPreview)throw Error('Preview the mod list first.');
 const answer=await uiDialog.showMessageBox(win,{type:'question',buttons:['Cancel','Update mod list'],defaultId:0,cancelId:0,message:'Update mod_order.txt?',detail:'The list will include the installed local mod folders shown in the preview. Previously excluded mods may be enabled. Unmatched entries are kept for Workshop or unavailable mods. Review each reason before updating. A backup record is kept for undo. Close KCD2 before continuing.'});
 if(answer.response!==1)return null;
 const result=await setup.applySetup(report,setupPreview,path.join(app.getPath('userData'),'repairs'));
 setupReceipt=result.receipt;setupPreview=null;report=download=setupPreview=null;return result;
}));
handle('undo-setup',()=>exclusive(async()=>{
 if(!setupReceipt)throw Error('No setup repair from this session to undo.');
 const saved=JSON.parse(await fs.readFile(setupReceipt,'utf8'));
 const result=await setup.undoSetup(setupReceipt,path.join(app.getPath('userData'),'repairs'));
 if(saved.created&&saved.game?.root)autoOrdersCreated.add(saved.game.root.toLowerCase());
 setupReceipt=setupPreview=null;report=download=setupPreview=null;return result;
}));
handle('undo',()=>exclusive(async()=>{if(!lastReceipt)throw Error('No dependency install from this session to undo.');const result=await undoPrepared(lastReceipt,path.join(app.getPath('userData'),'repairs'));lastReceipt=report=download=setupPreview=null;return result;}));
async function findDownloads(){
 if(!preferencesLoaded)await loadPreferences();
 const location=name=>{try{return app.getPath(name);}catch{return null;}};
 const roots=commonDownloadRoots({preferred:downloadFolder,downloads:location('downloads'),desktop:location('desktop'),documents:location('documents'),home:location('home')});
 const result=await discoverCommonDownloads(roots,{known:downloadObservations});
 downloadObservations=result.observations||[];
 foundDownloads=new Map(result.candidates.map(candidate=>[candidate.path,candidate]));
 return {folder:result.folder,folders:result.folders,candidates:result.candidates,pending:result.pending,warning:result.warning};
}
handle('find-downloads',findDownloads);
handle('choose-download-folder',()=>exclusive(async()=>{
 const folder=await choose(['openDirectory']);if(folder){downloadFolder=folder;preferencesLoaded=true;downloadObservations=[];foundDownloads.clear();await preferences.update({downloadFolder:folder});}
 return findDownloads();
}));
handle('check-found-download',file=>exclusive(async()=>{
 if(!report)throw Error('Check your game setup first.');
 const candidate=foundDownloads.get(file);if(!candidate)throw Error('Refresh Downloads and choose a detected archive.');
 const current=await fs.lstat(file);
 if(candidate.kind==='folder' ? !current.isDirectory()||current.isSymbolicLink()||(await require('./src/extracted-folder').inspectFolder(file)).fingerprint!==candidate.fingerprint : !current.isFile()||current.isSymbolicLink()||current.nlink>1||current.size!==candidate.size||current.mtimeMs!==candidate.mtimeMs)throw Error('This download is still changing. Wait for completion, then refresh.');
 download=null;
 return download=await archiveOperation({operation:'check',file,game:report.game});
}));
handle('check-extracted-folder',()=>exclusive(async()=>{
 if(!report)throw Error('Scan the intended installation first.');
 const folder=await choose(['openDirectory']);if(!folder)return null;download=null;
 return download=await archiveOperation({operation:'check',file:folder,game:report.game});
}));
handle('check-download',()=>exclusive(async()=>{
  if(!report)throw Error('Scan the intended installation first.');
  const file=await choose(['openFile'],[{name:'Dependency download',extensions:['zip','7z']}]);
  if(!file)return null;download=null;
  return download=await archiveOperation({operation:'check',file,game:report.game});
}));
handle('export-download',()=>exclusive(async()=>{
  if(!download||!report)throw Error('Check a dependency download first.');
  const destination=await choose(['openDirectory','createDirectory']);
  return destination?archiveOperation({operation:'export',plan:download,game:report.game,destination,vortex:false}):null;
}));
handle('export-vortex-download',()=>exclusive(async()=>{
  if(!download||!report)throw Error('Check a dependency download first.');
  const destination=await choose(['openDirectory','createDirectory']);
  return destination?archiveOperation({operation:'export',plan:download,game:report.game,destination,vortex:true}):null;
}));
handle('vortex-bridge-status',()=>vortexBridge.status(vortexBridge.bridgeRoot(app.getPath('appData')),report?.game.root));
handle('export-vortex-helper',()=>exclusive(async()=>{
  const helperVersion=require('./src/vortex-helper/info.json').version;
  const result=await uiDialog.showSaveDialog(win,{title:'Save the Vortex connection helper',defaultPath:'KCD2-Formatter-Vortex-Helper-'+helperVersion+'.zip',filters:[{name:'Vortex extension',extensions:['zip']}]});
  if(result.canceled||!result.filePath)return null;
  await exportVortexHelper(result.filePath);return {destination:result.filePath};
}));
handle('install-with-vortex',()=>exclusive(async()=>{
  if(!download||!report)throw Error('Check a dependency download first.');
  if(!await gameClosed())throw Error('Close KCD2 before installing through Vortex.');
  const base=vortexBridge.bridgeRoot(app.getPath('appData')),connection=await vortexBridge.status(base,report.game.root);
  if(!connection.ready)throw Error(connection.message);
  const workshop=await inspectWorkshop(report.game);
  if(!workshop.complete||workshop.pending||workshop.items.some(item=>['pending','missing'].includes(item.state)))throw Error('Let Steam finish its Workshop downloads, then check your setup again.');
  const fresh=await archiveOperation({operation:'check',file:download.source,game:report.game});
  if(fresh.sourceHash!==download.sourceHash||JSON.stringify(fresh.files)!==JSON.stringify(download.files))throw Error('The download or installed files changed. Review the download again.');
  if(fresh.vortexBlockers?.length)throw Error(fresh.vortexBlockers.join(' '));
  const job=await vortexBridge.createJob(base);
  await archiveOperation({operation:'export',plan:fresh,game:report.game,destination:job.directory,vortex:true,workshopFingerprint:workshop.fingerprint});
  if(!await gameClosed())throw Error('Close KCD2 before installing through Vortex.');
  if((await inspectWorkshop(report.game)).fingerprint!==workshop.fingerprint)throw Error('Steam Workshop changed while preparing this installation. Check your setup again.');
  win.webContents.send('progress','Vortex is handling this installation. Complete any Vortex conflict or permission prompts.');
  const result=await vortexBridge.install(base,job,report.game.root,connection.profileId,{gameBin:report.game.bin,workshopFingerprint:workshop.fingerprint,onProgress:message=>{if(!win.isDestroyed())win.webContents.send('progress',message);}});
  download=null;resetWatch();return result;
}));
handle('install-download',()=>exclusive(async()=>{
  if(!download||!report)throw Error('Check a dependency download first.');
  const r=await uiDialog.showMessageBox(win,{type:'warning',buttons:['Cancel','Install these files'],defaultId:0,cancelId:0,message:'Install the files you reviewed?',detail:'Close KCD2 first. Only use a download from an author you trust. The app will install the files shown and save backups before replacing files. It will stop if another mod manager controls them or a game loader would be replaced. After installing, check dependencies again.'});
  if(r.response!==1)return null;
  const result=await installPrepared(download,report,path.join(app.getPath('userData'),'repairs'),sevenZip());lastReceipt=result.receipt;report=download=setupPreview=null;return result;
}));
handle('launch-devmode',()=>exclusive(async()=>{
 if(watchPolling)throw Error('Wait for automatic checks to finish before launching.');
 if(!report)throw Error('Check your setup first.');
 return launchDevmode(report.game,{openExternal:url=>shell.openExternal(url),spawn});
}));
handle('open-workshop-item',id=>{if(typeof id!=='string'||! /^[1-9][0-9]{0,19}$/.test(id))throw Error('Invalid Workshop item ID');return shell.openExternal('https://steamcommunity.com/sharedfiles/filedetails/?id='+id);});
handle('open-nexus',id=>shell.openExternal(nexusFiles(id)));
handle('open-plugin-github',id=>shell.openExternal(githubRelease(id)));
handle('open-asi-author',()=>shell.openExternal('https://github.com/ThirteenAG/Ultimate-ASI-Loader/releases'));
app.whenReady().then(()=>{
  win=new BrowserWindow({width:1120,height:860,minWidth:850,minHeight:650,backgroundColor:'#191919',title:'KCD2 Mod Dependency Formatter',icon:path.join(__dirname,'src/assets/app/kcd2-icon.ico'),
    webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  win.removeMenu();win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.on('close',protectActiveOperation);
  win.webContents.on('will-navigate',event=>event.preventDefault());
  win.webContents.on('will-frame-navigate',event=>event.preventDefault());
  win.loadFile(path.join(__dirname,'src/index.html'));
});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',event=>{if(busy){protectActiveOperation(event);return;}worker?.terminate();if(archiveJob)Atomics.store(archiveJob.flag,0,1);});
