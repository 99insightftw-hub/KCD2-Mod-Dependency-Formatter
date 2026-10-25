'use strict';
const {app,BrowserWindow}=require('electron'),assert=require('assert/strict'),fs=require('fs/promises'),path=require('path');
const application=path.resolve(process.argv[2]),out=path.resolve(__dirname,'../../test-output/tape-motion-'+Date.now());
app.commandLine.appendSwitch('disable-gpu');app.setPath('userData',path.join(out,'profile'));const wait=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{await fs.mkdir(out,{recursive:true});const w=new BrowserWindow({show:false,width:1100,height:800,webPreferences:{backgroundThrottling:false,preload:path.join(__dirname,'desktop-order-ui-preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});await w.loadFile(path.join(application,'src/index.html'));const js=s=>w.webContents.executeJavaScript(s);for(let i=0;i<150;i++){if(await js('typeof busy!=="undefined"&&!busy'))break;await wait(20);}let cases=0;const check=async s=>{assert(await js(s),s);cases++;};
w.webContents.debugger.attach('1.3');await w.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});await wait(40);await js('busy=true;sync();void 0');await wait(80);
await check('document.querySelector(".masthead").classList.contains("tapes-scanning")');
await check('[...document.querySelectorAll(".tape-top img")].every(n=>getComputedStyle(n).animationName==="tape-scan")');
await js('busy=false;sync();void 0');await wait(30);
await check('[...document.querySelectorAll(".tape-top img")].every(n=>getComputedStyle(n).animationName==="none")');
for(let i=0;i<2;i++){await js('window.scrollTo(0,400);document.querySelectorAll(".tape-top")['+i+'].click();void 0');await check('scrollY===0&&document.querySelectorAll(".tape-top")['+i+'].getAnimations().length===1');}
await js('[...document.querySelectorAll(".tape-top")].forEach(n=>n.getAnimations().forEach(a=>{if(a.effect.getTiming().duration!==280)throw Error("Unexpected duration");a.finish();}));void 0');await wait(40);await check('[...document.querySelectorAll(".tape-top")].every(n=>n.getAnimations().length===0)');
await w.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await wait(40);await js('busy=true;sync();document.querySelector(".tape-top").click();void 0');await wait(40);
await check('document.querySelector(".tape-top").getAnimations().length===1');
await check('[...document.querySelectorAll(".tape-top img")].every(n=>getComputedStyle(n).animationName==="tape-scan")');
w.webContents.debugger.detach();assert(!w.isVisible());const result={passed:true,cases,scope:'Hidden UI animation fixture; scan state, click, completion, reduced motion and top navigation'};await fs.writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));app.quit();}).catch(e=>{console.error(e);app.exit(1)});
