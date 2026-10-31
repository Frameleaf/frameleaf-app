"""Fresh hosted-VM intake/control workload; deliberately contains no audio/browser launch."""
import errno,hashlib,json,os,platform,stat,subprocess,sys,time,urllib.request,zlib
from pathlib import Path
from release import publish_release

def run(argv,timeout=10):return subprocess.check_output(argv,text=True,timeout=timeout,stderr=subprocess.STDOUT).strip()
def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def emit(out,name,data):publish_release(out/name,data)
def identities(root):
 files=[]
 for path in sorted(root.rglob('*')):
  if path.is_symlink():
   target=path.resolve();assert target.is_relative_to(root),'unconfined dependency link'
   files.append([str(path.relative_to(root)),'link',os.readlink(path)])
  elif path.is_file():files.append([str(path.relative_to(root)),path.stat().st_size,sha(path)])
 return files
def acquire(config,out):
 node=Path(config['node']);npm=str(Path(config['npm']))
 assert run([str(node),'--version'])=='v22.23.4';assert run([str(node),npm,'--version'])=='11.8.0'
 lock=Path(config['input'])/'studio/engine-package-lock.json';assert sha(lock)=='8b117f02224f297ba7511ac47f15a29532a38e9a59fa910d55c2aa9236f437f0'
 data=json.loads(lock.read_text());assert all(p.get('integrity') and p.get('resolved','').startswith('https://registry.npmjs.org/') for k,p in data['packages'].items() if k and not p.get('link'));(out/'package-lock.json').write_bytes(lock.read_bytes())
 (out/'package.json').write_text(json.dumps(data['packages']['']))
 archive=out/'freecut-4d62e8082c5eb387a96275bcbd323d28f6e41a62.tar.gz'
 url='https://codeload.github.com/walterlow/freecut/tar.gz/4d62e8082c5eb387a96275bcbd323d28f6e41a62'
 with urllib.request.urlopen(url,timeout=30) as response,archive.open('xb') as destination:
  count=0
  while chunk:=response.read(1048576):
   count+=len(chunk);assert count<=134217728;destination.write(chunk)
 assert sha(archive)=='b4224e5c219a6302586cbe2242e9e6d299dfd1878f1fcd0f2d77ea3db12a5d32'
 subprocess.run([str(node),npm,'ci','--ignore-scripts','--no-audit','--no-fund'],cwd=out,check=True,timeout=420)
 cli=out/'node_modules/playwright/cli.js'
 subprocess.run([str(node),str(cli),'install','chromium','--only-shell'],cwd=out,check=True,timeout=180)
 browsers=json.loads((out/'node_modules/playwright-core/browsers.json').read_text())
 shell=next(x for x in browsers['browsers'] if x['name']=='chromium-headless-shell')
 assert shell['revision']=='1223' and shell['browserVersion']=='148.0.7778.96'
 executable=out/'browsers/chromium_headless_shell-1223/chrome-headless-shell-linux64/chrome-headless-shell'
 assert executable.is_file()
 libraries={}
 for binary in [node,Path(sys.executable),executable]:
  linked=run(['/usr/bin/ldd',str(binary)]);assert 'not found' not in linked
  (out/(binary.name+'.ldd.txt')).write_text(linked+'\n')
  for line in linked.splitlines():
   for token in line.split():
    if token.startswith('/') and Path(token).is_file():libraries[token]={'realpath':str(Path(token).resolve()),'sha256':sha(token)}
 (out/'runtime-libraries.json').write_text(json.dumps(libraries,sort_keys=True))
 deps=identities(out/'node_modules');resources=identities(executable.parent)
 (out/'dependencies.json').write_text(json.dumps(deps))
 (out/'browser-resources.json').write_text(json.dumps(resources))
 emit(out,'acquired.json',{'nodeVersion':'22.23.4','nodeSha256':sha(node),'npmVersion':'11.8.0','npmSha256':sha(npm),'playwrightVersion':json.loads((out/'node_modules/playwright/package.json').read_text())['version'],'browserRevision':1223,'browserVersion':shell['browserVersion'],'browserExecutableSha256':sha(executable),'dependencyFiles':len(deps),'dependencyManifestSha256':sha(out/'dependencies.json'),'browserManifestSha256':sha(out/'browser-resources.json'),'archiveSha256':sha(archive),'kernel':platform.release(),'python':sys.version,'pythonExecutableSha256':sha(sys.executable),'zlibCompile':zlib.ZLIB_VERSION,'zlibRuntime':zlib.ZLIB_RUNTIME_VERSION,'audioOrBrowserLaunched':False,'npmLifecycleScriptsExecuted':False})
class InvalidMigrationSetup(AssertionError):pass
def target_identity(path):
 try:
  fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
  try:
   info=os.fstat(fd)
   if not stat.S_ISREG(info.st_mode) or info.st_uid!=0:raise InvalidMigrationSetup('target is not a root-owned regular control file')
   os.read(fd,8192)
   return {'device':info.st_dev,'inode':info.st_ino,'uid':info.st_uid,'type':'regular'}
  finally:os.close(fd)
 except OSError as error:raise InvalidMigrationSetup('unreadable/missing target: '+str(path)) from error
def migration_refusals(targets):
 assert len(targets)==4
 refusals=[]
 for target in targets:
  identity=target_identity(target['path'])
  if identity!={k:target[k] for k in ['device','inode','uid','type']}:raise InvalidMigrationSetup('migration object identity changed')
  try:
   fd=os.open(target['path'],os.O_WRONLY|os.O_NOFOLLOW)
   try:os.write(fd,str(os.getpid()).encode())
   finally:os.close(fd)
  except OSError as error:
   if error.errno not in [errno.EPERM,errno.EACCES,errno.EROFS]:raise InvalidMigrationSetup('non-permission migration failure: '+str(error.errno)) from error
   refusals.append({**target,'errno':error.errno})
  else:raise AssertionError('migration boundary writable')
 return refusals
def controls(config,out,targets):
 status=dict(line.split(':',1) for line in Path('/proc/self/status').read_text().splitlines() if ':' in line)
 assert os.getuid()!=0 and status['NoNewPrivs'].strip()=='1'
 for name in ['CapEff','CapPrm','CapInh','CapAmb']:assert int(status[name].strip(),16)==0
 membership=Path('/proc/self/cgroup').read_text().strip();group=membership.split('::',1)[1]
 refusals=migration_refusals(targets)
 try:os.setuid(0)
 except PermissionError:pass
 else:raise AssertionError('privilege regain')
 result=subprocess.run(['/usr/bin/sudo','-n','/usr/bin/id','-u'],capture_output=True,text=True,timeout=3)
 assert result.returncode!=0,'setuid exec regained privilege'
 emit(out,'controls-ready.json',{'membership':membership,'migrationRefusals':refusals,'noNewPrivileges':1,'capabilitiesZero':True,'setuidExecRefused':True,'parent':os.getpid()})
 # Detached descendants are born before any ancestry census (there is none).
 for index in range(8):
  child=os.fork()
  if child==0:
   os.setsid();grandchild=os.fork()
   if grandchild:os._exit(0)
   emit(out,'detached-'+str(index)+'.json',{'pid':os.getpid(),'parent':os.getppid(),'cgroup':Path('/proc/self/cgroup').read_text().strip(),'setsidBeforeObservation':True})
   while True:time.sleep(1)
  os.waitpid(child,0)
 emit(out,'detached-ready.json',{'descendants':8,'membership':membership})
 # Keep genuine forks racing with the root's kernel cgroup.kill.
 for index in range(4):
  child=os.fork()
  if child==0:
   nested=os.fork()
   if nested==0:time.sleep(.05);os._exit(0)
   os.waitpid(nested,0)
   emit(out,'forker-'+str(index)+'.json',{'membership':Path('/proc/self/cgroup').read_text().strip(),'completedForksAtLeast':1})
   while True:
    nested=os.fork()
    if nested==0:time.sleep(.05);os._exit(0)
    os.waitpid(nested,0)
 while True:time.sleep(1)
def main():
 config=json.loads(Path(sys.argv[1]).read_text());out=Path(config['output']);mode=config['mode']
 deadline=time.monotonic()+10;release=Path(config['release'])
 while not release.exists():
  if time.monotonic()>deadline:raise TimeoutError('unreleased gate')
  time.sleep(.02)
 record=json.loads(release.read_text());assert record['configSha256']==sha(sys.argv[1])
 assert Path('/proc/self/cgroup').read_text().strip()=='0::'+record['controlGroup']
 emit(out,'gate-released.json',{'membership':record['controlGroup'],'mode':mode})
 if mode=='acquire':acquire(config,out)
 elif mode=='controls':controls(config,out,record['migrationTargets'])
 elif mode=='hold':
  while True:time.sleep(1)
 else:raise AssertionError(mode)
if __name__=='__main__':main()
