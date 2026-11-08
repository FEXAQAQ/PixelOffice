const {spawn}=require('child_process');
function execute(file,args,{cwd,timeoutMs=1800000,signal,onProcess=()=>{},onOutput=()=>{},kill}) {
  if (signal?.aborted) return Promise.reject(Error('任務已中止'));
  return new Promise((resolve,reject)=>{
    let out='',err='',timedOut=false,settled=false,truncated=false;
    // Only package-manager .cmd shims need a Windows shell; every argument is restricted.
    const shell=process.platform==='win32' && ['npm','pnpm','yarn','bun'].includes(file);
    if (shell && args.some(a=>!/^[A-Za-z0-9_./:@=,+-]+$/.test(a))) return reject(Error('命令參數不合法'));
    const proc=spawn(shell ? file+'.cmd' : file,args,{cwd,shell,windowsHide:true,env:process.env});
    onProcess(proc);
    const stop=()=>kill(proc);
    const timer=setTimeout(()=>{timedOut=true;stop();},timeoutMs);
    signal?.addEventListener('abort',stop,{once:true});
    function done(error,code) {
      if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',stop);
      onProcess(null);
      if(error)return reject(error);
      if(signal?.aborted)return reject(Error('任務已中止'));
      resolve({code:timedOut?124:code,out,err,timedOut,truncated});
    }
    proc.stdout.on('data',d=>{truncated ||= out.length+d.length>100000;out=(out+d).slice(-100000);onOutput(d.toString(),'stdout');});
    proc.stderr.on('data',d=>{err=(err+d).slice(-100000);onOutput(d.toString(),'stderr');});
    proc.on('error',e=>done(e));proc.on('close',code=>done(null,code));
  });
}
module.exports={execute};
