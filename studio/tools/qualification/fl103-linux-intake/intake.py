"""Root-only fresh ephemeral GitHub VM intake. No audio render or browser execution."""
import errno,hashlib,json,os,platform,stat,shutil,signal,subprocess,sys,sysconfig,time
from pathlib import Path
sys.dont_write_bytecode=True  # Keep startup imports from dirtying the reviewed checkout.
from release import publish_release

PREFIX='fl103-intake-'
# The reviewed engine recipe the intake accepts; source_test.py keeps it equal to studio/engine-build.json.
RECIPE_SOURCE_SHA256='e3f7e88e3e38e6ace377a230b47ec41f9197db373cbb5932024dd94b9b67c7e9'
RECIPE_PATCH_COUNT=137
LIMITS={'cpu.max':'200000 100000','memory.max':'2147483648','memory.swap.max':'0','pids.max':'128'}
def command(argv,timeout=10):return subprocess.check_output(argv,text=True,stderr=subprocess.STDOUT,timeout=timeout).strip()
def system_state(base):
 result=subprocess.run(['/usr/bin/systemctl','is-system-running','--wait'],text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=10)
 publish_release(base/'evidence/systemd-state.json',{'state':result.stdout.strip()[:200],'status':result.returncode,'stderr':result.stderr[:200]})
 assert not result.stderr and (result.stdout.strip(),result.returncode) in [('running',0),('degraded',1)],'unexpected systemd state/exit status'
def digest(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def readfd(fd):os.lseek(fd,0,0);return os.read(fd,8192).decode()
def populated(fd):return dict(line.split() for line in readfd(fd).splitlines())['populated']=='1'
def safe_id(value):
 assert value and len(value)<=40 and all(c in '0123456789-' for c in value)
 return value
def config_for(base,mode,node,npm,input_path):
 return {'mode':mode,'node':str(node),'npm':str(npm),'input':str(input_path),'output':str(base/'storage'/mode),'release':str(base/'control'/(mode+'-release.json')),'siblingProcs':str(base/'sibling')}
def unit_text(base,unit,mode,uid,node,config,seconds):
 assert mode in ['acquire','controls','hold-deadline','hold-cancel','hold-unreleased']
 return '\n'.join(['[Unit]','Description=FL103 finite no-audio Linux intake '+mode,'[Service]','Type=exec','RemainAfterExit=yes','User='+str(uid),'Group='+str(uid),'ExecStart=/usr/bin/python3 '+str(base/'source/payload.py')+' '+str(config),'Environment=HOME='+str(base/'storage'/mode),'Environment=PLAYWRIGHT_BROWSERS_PATH='+str(base/'storage'/mode/'browsers'),'Environment=PATH='+str(node.parent)+':/usr/bin:/bin','WorkingDirectory='+str(base/'storage'/mode),'UMask=0077','NoNewPrivileges=yes','CapabilityBoundingSet=','AmbientCapabilities=','ProtectSystem=strict','ProtectHome=yes','PrivateDevices=yes','PrivateTmp=yes','ProtectControlGroups=yes','ProtectKernelTunables=yes','ProtectKernelModules=yes','ProtectKernelLogs=yes','RestrictNamespaces=~cgroup','RestrictSUIDSGID=yes','LockPersonality=yes','InaccessiblePaths=-/run/dbus -/run/systemd/private -/run/user','ReadWritePaths='+str(base/'storage'/mode),'PrivateNetwork='+('no' if mode=='acquire' else 'yes'),'CPUQuota=200%','CPUQuotaPeriodSec=100ms','MemoryMax=2G','MemorySwapMax=0','TasksMax=128','RuntimeMaxSec='+str(seconds),'TimeoutStopSec=10','KillMode=control-group','SendSIGKILL=yes','StandardOutput=journal','StandardError=journal',''])
def stat_identity(path):
 st=Path(path).stat();return {'device':st.st_dev,'inode':st.st_ino,'uid':st.st_uid}
def owned_record(path):
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  st=os.fstat(fd);assert stat.S_ISREG(st.st_mode) and st.st_uid==os.geteuid() and st.st_mode&0o022==0
  data=os.read(fd,65537);assert len(data)<=65536
  return json.loads(data)
 finally:os.close(fd)
def cgroup_path(record):return Path('/sys/fs/cgroup'+record['controlGroup'])
def closure_matches(record,receipt):
 return all(receipt.get(key)==record[key] for key in ['mode','unit','invocation','controlGroup','identity','configSha256']) and receipt.get('cleanup')=='kernel-cgroup-populated-zero' and receipt.get('populatedAfterKill')==0
def kill_readback(kill,events,report):
 try:
  assert kill is not None and events is not None,'ownership descriptors unavailable'
  os.write(kill,b'1');end=time.monotonic()+10
  while populated(events) and time.monotonic()<end:time.sleep(.05)
  report['populatedAfterKill']=int(populated(events))
  assert report['populatedAfterKill']==0,'populated after deadline'
  report['cleanup']='kernel-cgroup-populated-zero'
 except Exception as error:
  report['cleanup']='UNKNOWN';report['cleanupError']=type(error).__name__+': '+str(error)[:200]
def cleanup_registered(base,label='main'):
 report={'cleanup':'kernel-cgroup-populated-zero','groups':[]}
 # Cgroup records have a disjoint namespace; malformed records fail closed.
 for path in sorted((base/'control').glob('cgroup-*-owner.json')):
  row={'registration':path.name,'cleanup':'UNKNOWN'}
  try:
   record=owned_record(path);unit=record['unit']
   assert record['kind']=='cgroup' and record['mode'] in ['acquire','controls','hold-deadline','hold-cancel','hold-unreleased']
   assert path.name=='cgroup-'+record['mode']+'-owner.json'
   assert unit.startswith(PREFIX) and unit.endswith('.service') and '/' not in unit
   assert record['controlGroup']=='/system.slice/'+unit and record['invocation'] and record['configSha256']
   group=cgroup_path(record)
   if not group.exists():
    assert closure_matches(record,owned_record(base/'evidence'/(record['mode']+'.json'))),'missing group without authenticated matching populated-zero closure'
    row['cleanup']='prior-bound-populated-zero'
   else:
    assert stat_identity(group)==record['identity'],'cgroup identity changed: preserve replacement'
    fd=os.open(group,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);kill=events=None
    try:
     assert {'device':os.fstat(fd).st_dev,'inode':os.fstat(fd).st_ino,'uid':os.fstat(fd).st_uid}==record['identity']
     kill=os.open('cgroup.kill',os.O_WRONLY,dir_fd=fd);events=os.open('cgroup.events',os.O_RDONLY,dir_fd=fd)
     kill_readback(kill,events,row)
    finally:
     for descriptor in [kill,events,fd]:
      if descriptor is not None:os.close(descriptor)
    assert row['cleanup']=='kernel-cgroup-populated-zero'
    command(['/usr/bin/systemctl','stop',unit])
  except Exception as error:
   row['cleanup']='UNKNOWN';row['error']=type(error).__name__+': '+str(error)[:200]
  if row['cleanup']=='UNKNOWN':report['cleanup']='UNKNOWN'
  report['groups'].append(row)
 publish_release(base/'evidence'/('reconciliation-'+label+'.json'),report)
 return report
def cleanup_all(base):
 report={'registeredCgroupsReconciled':False,'exactScratchMountRemoved':False,'cleanup':'UNKNOWN','audioQualified':False}
 try:
  reconciliation=cleanup_registered(base,'workflow')
  assert reconciliation['cleanup']=='kernel-cgroup-populated-zero','registered cgroup reconciliation UNKNOWN'
  report['registeredCgroupsReconciled']=True
  if not os.path.lexists(base/'control/mount-owner.json'):
   setup=owned_record(base/'control/setup-owner.json')
   assert setup['kind']=='before-resources' and setup['base']==str(base)
   assert not base.is_symlink() and not (base/'storage').is_symlink()
   assert setup['identity']==stat_identity(base) and setup['storageIdentity']==stat_identity(base/'storage')
   assert not os.path.lexists(base/'control/resource-setup-started.json') and reconciliation['groups']==[]
   current=json.loads(command(['/usr/bin/findmnt','-J','-T',str(base/'storage')]))['filesystems'][0]
   assert current['target'] in [str(path) for path in (base/'storage').parents],'scratch mount absence unproven: preserve it'
   report.update(resourceSetupNeverStarted=True,setupSha256=digest(base/'control/setup-owner.json'),exactScratchMountAbsent=True,readbackTarget=current['target'],cleanup='verified')
  else:
   expected=owned_record(base/'control/mount-owner.json')
   current=json.loads(command(['/usr/bin/findmnt','-J','-T',str(base/'storage')]))['filesystems'][0]
   if current['target']==str(base/'storage'):
    assert current==expected,'scratch mount identity changed; preserve replacement'
    command(['/usr/bin/umount',str(base/'storage')],15)
   final=json.loads(command(['/usr/bin/findmnt','-J','-T',str(base/'storage')]))['filesystems'][0]
   assert final['target']!=str(base/'storage')
   report.update(exactScratchMountRemoved=True,readbackTarget=final['target'],cleanup='verified')
 except Exception as error:report['error']=type(error).__name__+': '+str(error)[:200]
 finally:publish_release(base/'evidence/workflow-cleanup.json',report)
 assert report['cleanup']=='verified','workflow closure UNKNOWN'
def finish_phase(base,mode,unit,unit_path,report,kill,events,fd):
 # Descriptor failure must still leave an UNKNOWN receipt; recovery never upgrades it.
 kill_readback(kill,events,report)
 try:command(['/usr/bin/systemctl','stop',unit])
 except Exception as error:report['recoveryError']=type(error).__name__+': '+str(error)[:200]
 for descriptor in [kill,events,fd]:
  if descriptor is not None:
   try:os.close(descriptor)
   except Exception as error:report['closeError']=type(error).__name__+': '+str(error)[:200]
 try:
  unit_path.unlink();command(['/usr/bin/systemctl','daemon-reload'])
 except Exception as error:report['unitRecoveryError']=type(error).__name__+': '+str(error)[:200]
 publish_release(base/'evidence'/(mode+'.json'),report)
def phase(base,mode,uid,node,npm,input_path,identifier):
 out=base/'storage'/mode;out.mkdir(mode=0o700);os.chown(out,uid,uid)
 config=config_for(base,mode,node,npm,input_path)
 if mode.startswith('hold-'):config['mode']='hold'
 config_path=base/'control'/(mode+'-config.json');publish_release(config_path,config)
 unit=PREFIX+identifier+'-'+mode+'.service';unit_path=Path('/run/systemd/system')/unit
 seconds=600 if mode=='acquire' else 2 if mode=='hold-deadline' else 30
 unit_path.write_text(unit_text(base,unit,mode,uid,node,config_path,seconds));unit_path.chmod(0o644)
 command(['/usr/bin/systemctl','daemon-reload']);assert command(['/usr/bin/systemctl','show',unit,'-p','InvocationID','--value'])==''
 fd=events=kill=None;report={'mode':mode,'unit':unit,'cleanup':'UNKNOWN'}
 try:
  command(['/usr/bin/systemctl','start',unit]);group=command(['/usr/bin/systemctl','show',unit,'-p','ControlGroup','--value'])
  assert group=='/system.slice/'+unit
  fd=os.open('/sys/fs/cgroup'+group,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);st=os.fstat(fd);assert st.st_uid==0
  identity={'device':st.st_dev,'inode':st.st_ino,'uid':st.st_uid}
  events=os.open('cgroup.events',os.O_RDONLY,dir_fd=fd);kill=os.open('cgroup.kill',os.O_WRONLY,dir_fd=fd)
  actual={}
  for name in LIMITS:
   descriptor=os.open(name,os.O_RDONLY,dir_fd=fd)
   try:actual[name]=readfd(descriptor).strip()
   finally:os.close(descriptor)
  assert actual==LIMITS and populated(events)
  invocation=command(['/usr/bin/systemctl','show',unit,'-p','InvocationID','--value']);assert invocation
  binding={'kind':'cgroup','mode':mode,'unit':unit,'invocation':invocation,'controlGroup':group,'identity':identity,'configSha256':digest(config_path)}
  publish_release(base/'control'/('cgroup-'+mode+'-owner.json'),binding)
  report.update(binding,limits=actual)
  if mode!='hold-unreleased':
   release={'configSha256':digest(config_path),'controlGroup':group}
   if mode=='controls':
    from payload import target_identity
    targets=['/sys/fs/cgroup/cgroup.procs','/sys/fs/cgroup'+group+'/cgroup.procs',str(Path('/sys/fs/cgroup'+group).parent/'cgroup.procs'),str(Path(config['siblingProcs']).resolve(strict=True))]
    release['migrationTargets']=[{'path':target,**target_identity(target)} for target in targets]
   publish_release(Path(config['release']),release)
  end=time.monotonic()+(610 if mode=='acquire' else 20)
  while time.monotonic()<end:
   state=command(['/usr/bin/systemctl','show',unit,'-p','SubState','--value'])
   if mode=='controls' and (out/'detached-ready.json').exists() and all((out/('forker-'+str(i)+'.json')).exists() for i in range(4)):
    witnesses=[json.loads((out/('detached-'+str(i)+'.json')).read_text()) for i in range(8)]
    assert all(x['cgroup']=='0::'+group and x['setsidBeforeObservation'] for x in witnesses)
    report['detachedWitnesses']=witnesses;report['parallelForkers']=4
    report['privilegeAndMigration']=json.loads((out/'controls-ready.json').read_text())
    refusals=report['privilegeAndMigration']['migrationRefusals']
    assert len(refusals)==4 and all(x['errno'] in [errno.EPERM,errno.EACCES,errno.EROFS] for x in refusals)
    assert [{k:v for k,v in x.items() if k!='errno'} for x in refusals]==release['migrationTargets']
    report['forkerWitnesses']=[json.loads((out/('forker-'+str(i)+'.json')).read_text()) for i in range(4)]
    assert all(x['membership']=='0::'+group and x['completedForksAtLeast']>=1 for x in report['forkerWitnesses'])
    # No census; kill while four forkers are active.
    os.write(kill,b'1');report['kernelKillDuringParallelFork']=True;break
   if mode=='hold-cancel' and (out/'gate-released.json').exists():
    command(['/usr/bin/systemctl','stop',unit]);report['explicitOwnedUnitCancellation']=True;break
   if state in ['exited','failed','dead']:break
   time.sleep(.05)
  else:raise TimeoutError('root phase deadline')
  report['result']=command(['/usr/bin/systemctl','show',unit,'-p','Result','--value'])
  report['status']=command(['/usr/bin/systemctl','show',unit,'-p','ExecMainStatus','--value'])
  if mode=='acquire':assert report['result']=='success' and report['status']=='0' and (out/'acquired.json').is_file()
  if mode=='controls':assert report.get('kernelKillDuringParallelFork')
  if mode=='hold-deadline':assert report['result']=='timeout' and (out/'gate-released.json').exists()
  if mode=='hold-cancel':assert report.get('explicitOwnedUnitCancellation')
  if mode=='hold-unreleased':assert report['status']=='1' and not (out/'gate-released.json').exists()
 finally:
  finish_phase(base,mode,unit,unit_path,report,kill,events,fd)
 assert report['cleanup']=='kernel-cgroup-populated-zero'
def snapshot_runtime(base,node):
 # Candidate filesystem closure, never a claim of dynamic browser linkage completeness.
 root=base/'storage/runtime-root';root.mkdir(mode=0o700)
 files=json.loads((base/'storage/acquire/runtime-libraries.json').read_text())
 paths=set(files)|{str(Path(p).resolve()) for p in files}
 paths.update(['/etc/os-release','/etc/hosts','/etc/nsswitch.conf','/etc/ssl/certs/ca-certificates.crt',sys.executable,str(Path(sys.executable).resolve())])
 for source in sorted(paths):
  src=Path(source);target=root/source.lstrip('/');target.parent.mkdir(parents=True,exist_ok=True)
  if src.is_symlink():target.symlink_to(os.readlink(src))
  else:shutil.copy2(src,target)
 # Preserve absolute install paths used by exact argv and stdlib lookup in later RootDirectory.
 for source in [node.parent.parent,Path(sysconfig.get_path('stdlib'))]:
  assert source.is_absolute() and source not in [Path('/'),Path('/usr'),Path('/usr/lib')]
  target=root/str(source).lstrip('/');target.parent.mkdir(parents=True,exist_ok=True)
  shutil.copytree(source,target,symlinks=True,dirs_exist_ok=True)
 inventory=[]
 for path in sorted(root.rglob('*')):
  if path.is_symlink():inventory.append([str(path.relative_to(root)),'link',os.readlink(path)])
  elif path.is_file():inventory.append([str(path.relative_to(root)),path.stat().st_size,digest(path)])
 (base/'evidence/runtime-root-files.json').write_text(json.dumps(inventory,separators=(',',':')))
 publish_release(base/'evidence/runtime-root.json',{'manifestSha256':digest(base/'evidence/runtime-root-files.json'),'fileCount':len(inventory),'kind':'candidate-static-runtime-closure','browserLaunched':False,'dynamicLinkageQualified':False,'notHostRootfsImage':True})
def main():
 assert os.geteuid()==0
 assert Path('/usr/bin/prlimit').is_file()
 mode,identifier,checkout,node_arg,npm_arg=sys.argv[1:];identifier=safe_id(identifier);base=Path('/opt')/(PREFIX+identifier)
 if mode=='--cleanup':
  if base.exists():cleanup_all(base)
  return
 assert mode=='--run';base.mkdir(mode=0o755);(base/'control').mkdir(mode=0o755);(base/'source').mkdir(mode=0o755);(base/'evidence').mkdir(mode=0o700)
 storage=base/'storage';storage.mkdir()
 publish_release(base/'control/setup-owner.json',{'kind':'before-resources','base':str(base),'identity':stat_identity(base),'storageIdentity':stat_identity(storage)})
 checkout=Path(checkout).resolve();node=Path(node_arg).resolve();npm=Path(npm_arg).resolve()
 assert node.is_file() and npm.is_file()
 assert Path('/sys/fs/cgroup/cgroup.controllers').is_file() and 'memory' in Path('/sys/fs/cgroup/cgroup.controllers').read_text()
 system_state(base)
 checkout_status=command(['/usr/bin/git','-C',str(checkout),'status','--porcelain'])
 assert checkout_status=='','dirty reviewed checkout (first 4096 characters): '+checkout_status[:4096]
 head=command(['/usr/bin/git','-C',str(checkout),'rev-parse','HEAD'])
 recipe=json.loads((checkout/'studio/engine-build.json').read_text());assert recipe['sourceSha256']==RECIPE_SOURCE_SHA256 and len(recipe['patches'])==RECIPE_PATCH_COUNT
 assert digest(checkout/'studio/engine-package-lock.json')==recipe['lockfileSha256']
 for patch in recipe['patches']:assert digest(checkout/'studio'/patch['path'])==patch['sha256']
 source=Path(__file__).resolve().parent
 for name in ['payload.py','release.py']:shutil.copyfile(source/name,base/'source'/name)
 input_path=base/'input';(input_path/'studio').mkdir(parents=True,mode=0o755)
 shutil.copyfile(checkout/'studio/engine-package-lock.json',input_path/'studio/engine-package-lock.json')
 username='fl103-intake';assert subprocess.run(['/usr/bin/id',username],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode!=0
 publish_release(base/'control/resource-setup-started.json',{'setupSha256':digest(base/'control/setup-owner.json')})
 command(['/usr/sbin/useradd','--system','--user-group','--no-create-home','--shell','/usr/sbin/nologin',username]);uid=int(command(['/usr/bin/id','-u',username]));assert command(['/usr/bin/id','-G',username])==str(uid)
 image=base/'storage.ext4'
 with image.open('xb') as stream:stream.truncate(8*1024**3)
 command(['/usr/sbin/mkfs.ext4','-q','-F',str(image)],60);command(['/usr/bin/mount','-o','loop,nodev,nosuid',str(image),str(storage)],30)
 publish_release(base/'control/mount-owner.json',json.loads(command(['/usr/bin/findmnt','-J','-T',str(storage)]))['filesystems'][0])
 sibling=Path('/sys/fs/cgroup')/(PREFIX+identifier+'-refusal');sibling.mkdir();(base/'sibling').symlink_to(sibling/'cgroup.procs')
 report={'head':head,'heldAncestor':'76ca660c20b1ca4861636fe03c20d28d584f9ccb','osRelease':Path('/etc/os-release').read_text(),'kernel':platform.uname()._asdict(),'systemd':command(['/usr/bin/systemctl','--version']),'python':sys.version,'pythonExecutableSha256':digest(sys.executable),'mount':command(['/usr/bin/findmnt','-J','-T',str(storage)]),'recipeSha256':digest(checkout/'studio/engine-build.json'),'sourceSha256':recipe['sourceSha256'],'patchCount':len(recipe['patches']),'hostRootMount':command(['/usr/bin/findmnt','-J','-T','/']),'procVersion':Path('/proc/version').read_text(),'audioOrBrowserLaunched':False,'runtimeGrant':'hosted-intake-only'}
 (base/'evidence/dpkg.tsv').write_text(command(['/usr/bin/dpkg-query','-W','-f=${Package}\t${Version}\t${Architecture}\n'])+'\n')
 report['dpkgManifestSha256']=digest(base/'evidence/dpkg.tsv')
 for filename in ['/etc/os-release','/usr/bin/systemctl','/usr/lib/systemd/systemd','/usr/bin/python3']:
  report.setdefault('rootfsFiles',{})[filename]={'realpath':str(Path(filename).resolve()),'sha256':digest(filename)}
 shutil.copyfile(checkout/'studio/engine-build.json',base/'evidence/engine-build.json')
 publish_release(base/'evidence/platform.json',report)
 def interrupted(signum,frame):raise KeyboardInterrupt(str(signum))
 signal.signal(signal.SIGTERM,interrupted);signal.signal(signal.SIGINT,interrupted)
 try:
  for item in ['hold-unreleased','controls','hold-deadline','hold-cancel','acquire']:phase(base,item,uid,node,npm,input_path,identifier)
  snapshot_runtime(base,node)
  publish_release(base/'evidence/COMPLETE.json',{'intakeOnly':True,'kernelControls':True,'audioQualified':False,'platformIdentitiesCollected':True})
 finally:
  reconciliation=cleanup_registered(base)
  assert reconciliation['cleanup']=='kernel-cgroup-populated-zero','main closure UNKNOWN'
  sibling.rmdir()
  # Storage remains mounted only until the workflow archives it, then its exact mount is removed.
if __name__=='__main__':main()
