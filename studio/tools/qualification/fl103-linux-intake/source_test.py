"""Pure source/filesystem checks, including import-only Python and temporary Git fixtures. Never runs intake main or kernel controls."""
import errno,ast,hashlib,importlib.util,json,os,subprocess,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from release import publish_release
import intake
import payload

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[3]
class SourceChecks(unittest.TestCase):
 def test_syntax(self):
  for path in HERE.glob('*.py'):ast.parse(path.read_text())
 def test_exact_current_recipe_and_lock(self):
  data=json.loads((ROOT/'studio/engine-build.json').read_text())
  self.assertEqual(len(data['patches']),133)
  self.assertEqual(data['sourceSha256'],'3aed97c3a3e98844f1d742d1d53acc6094a6b92e478c4db1bd27ac972c7a66ce')
  self.assertEqual(intake.digest(ROOT/'studio/engine-package-lock.json'),data['lockfileSha256'])
  for item in data['patches']:self.assertEqual(intake.digest(ROOT/'studio'/item['path']),item['sha256'])
 def test_unit_scopes_and_limits(self):
  for mode in ['acquire','controls','hold-deadline','hold-cancel','hold-unreleased']:
   text=intake.unit_text(Path('/opt/fl103-intake-1-1'),'fl103-intake-1-1-'+mode+'.service',mode,123,Path('/opt/node/bin/node'),Path('/opt/config'),2)
   for value in ['NoNewPrivileges=yes','CapabilityBoundingSet=','AmbientCapabilities=','ProtectControlGroups=yes','RestrictNamespaces=~cgroup','MemoryMax=2G','MemorySwapMax=0','TasksMax=128','CPUQuota=200%','RuntimeMaxSec=2','KillMode=control-group','ProtectHome=yes','ProtectSystem=strict']:
    self.assertIn(value,text)
   self.assertIn('PrivateNetwork='+('no' if mode=='acquire' else 'yes'),text)
   self.assertNotIn('Environment=GITHUB',text)
 def test_publication_complete_before_visible(self):
  with tempfile.TemporaryDirectory() as temp:
   path=Path(temp)/'release';value={'complete':[1,2,3]};real=os.link
   def check(src,dst,**kw):
    self.assertFalse(path.exists())
    fd=os.open(src,os.O_RDONLY,dir_fd=kw['src_dir_fd'])
    try:self.assertEqual(json.loads(os.read(fd,4096)),value)
    finally:os.close(fd)
    return real(src,dst,**kw)
   with patch('release.os.link',check):publish_release(path,value)
   self.assertEqual(json.loads(path.read_text()),value)
   self.assertEqual(path.stat().st_mode&0o777,0o444)
   self.assertEqual([x.name for x in Path(temp).iterdir()],['release'])
 def test_existing_destination_preserved(self):
  with tempfile.TemporaryDirectory() as temp:
   path=Path(temp)/'release';path.write_text('foreign')
   with self.assertRaises(FileExistsError):publish_release(path,{'new':True})
   self.assertEqual(path.read_text(),'foreign')
 def test_existing_symlink_preserved(self):
  with tempfile.TemporaryDirectory() as temp:
   target=Path(temp)/'target';target.write_text('foreign');path=Path(temp)/'release';path.symlink_to(target)
   with self.assertRaises(FileExistsError):publish_release(path,{'new':True})
   self.assertTrue(path.is_symlink());self.assertEqual(target.read_text(),'foreign')
 def test_no_numeric_pid_signal_or_census(self):
  text=(HERE/'intake.py').read_text()
  for token in ['os.kill(', 'killpg(', "['ps'", '/proc/*']:self.assertNotIn(token,text)
  self.assertIn("os.open('cgroup.kill'",text)
  self.assertLess(text.index("events=os.open('cgroup.events'",text.index('def phase')),text.index("publish_release(Path(config['release']),release)"))
 def test_detached_parallel_privilege_and_cancel_controls_present(self):
  text=(HERE/'payload.py').read_text();owner=(HERE/'intake.py').read_text()
  for value in ['os.setsid()','grandchild=os.fork()','range(8)','range(4)','os.setuid(0)',"record['migrationTargets']","'/usr/bin/sudo','-n'"]:self.assertIn(value,text)
  for value in ['kernelKillDuringParallelFork','explicitOwnedUnitCancellation',"report['result']=='timeout'","not (out/'gate-released.json').exists()"]:self.assertIn(value,owner)
 def test_fresh_vm_exact_push_only(self):
  text=(ROOT/'.github/workflows/fl103-linux-intake.yml').read_text()
  for value in ["workflow_dispatch:","github.repository == 'Frameleaf/frameleaf-qualification' && github.ref == 'refs/heads/aj/fl103-linux-intake-execute'",'runs-on: ubuntu-24.04','timeout-minutes: 25','contents: read','persist-credentials: false','retention-days: 7']:self.assertIn(value,text)
  for value in ['ubuntu-slim','self-hosted','secrets.','push:','paths:','inputs:','pull_request:','--with-deps']:self.assertNotIn(value,text)
 def test_acquisition_has_no_browser_or_audio_launch(self):
  text=(HERE/'payload.py').read_text()
  self.assertIn("'install','chromium','--only-shell'",text)
  self.assertIn("'--ignore-scripts'",text)
  for value in ['.launch(','.launchPersistentContext(', 'OfflineAudioContext','processAudio(', 'createAudioBuffer(']:self.assertNotIn(value,text)
 def test_safe_identifier(self):
  self.assertEqual(intake.safe_id('123-1'),'123-1')
  for value in ['../foreign','', 'x', '1'*41]:
   with self.assertRaises(AssertionError):intake.safe_id(value)
class CorrectionChecks(unittest.TestCase):
 def setup_base(self,temp):
  base=Path(temp)
  for name in ['control','evidence','storage']:(base/name).mkdir()
  return base
 def registration(self,base):
  record={'kind':'cgroup','mode':'controls','unit':'fl103-intake-1-1-controls.service','invocation':'fresh-invocation','controlGroup':'/system.slice/fl103-intake-1-1-controls.service','identity':{'device':1,'inode':2,'uid':0},'configSha256':'config-hash'}
  (base/'control/cgroup-controls-owner.json').write_text(json.dumps(record))
  return record
 def test_mixed_registry_reaches_exact_mount_cleanup(self):
  with tempfile.TemporaryDirectory() as temp:
   base=self.setup_base(temp);expected={'target':str(base/'storage'),'source':'/dev/loop-owned'}
   (base/'control/mount-owner.json').write_text(json.dumps(expected))
   record=self.registration(base);(base/'evidence/controls.json').write_text(json.dumps({**record,'cleanup':'kernel-cgroup-populated-zero','populatedAfterKill':0}))
   with patch('intake.cgroup_path',return_value=base/'absent'),patch('intake.command',side_effect=[json.dumps({'filesystems':[expected]}),'',json.dumps({'filesystems':[{'target':'/'}]})]) as command:
    intake.cleanup_all(base)
   self.assertEqual(command.call_args_list[1].args[0],['/usr/bin/umount',str(base/'storage')])
   self.assertEqual(json.loads((base/'evidence/workflow-cleanup.json').read_text())['cleanup'],'verified')
 def test_malformed_cgroup_record_refused_and_unknown_saved(self):
  with tempfile.TemporaryDirectory() as temp:
   base=self.setup_base(temp);(base/'control/cgroup-bad-owner.json').write_text('{}')
   with patch('intake.command') as command:
    with self.assertRaises(AssertionError):intake.cleanup_all(base)
   command.assert_not_called()
   report=json.loads((base/'evidence/workflow-cleanup.json').read_text())
   self.assertFalse(report['registeredCgroupsReconciled']);self.assertEqual(report['cleanup'],'UNKNOWN')
 def missing_case(self,change=None,receipt=True):
  with tempfile.TemporaryDirectory() as temp:
   base=self.setup_base(temp);record=self.registration(base)
   proof={**record,'cleanup':'kernel-cgroup-populated-zero','populatedAfterKill':0}
   if change:proof.update(change)
   if receipt:(base/'evidence/controls.json').write_text(json.dumps(proof))
   with patch('intake.cgroup_path',return_value=base/'absent'),patch('intake.command') as command:
    report=intake.cleanup_registered(base)
   command.assert_not_called();return report
 def test_missing_group_without_closure_unknown(self):self.assertEqual(self.missing_case(receipt=False)['cleanup'],'UNKNOWN')
 def test_missing_group_with_matching_authenticated_closure(self):
  report=self.missing_case();self.assertEqual(report['cleanup'],'kernel-cgroup-populated-zero');self.assertEqual(report['groups'][0]['cleanup'],'prior-bound-populated-zero')
 def test_stale_mismatched_closure_unknown(self):
  for change in [{'invocation':'stale'},{'identity':{'device':1,'inode':99,'uid':0}},{'configSha256':'stale'},{'unit':'foreign.service'},{'controlGroup':'/foreign'},{'mode':'acquire'},{'populatedAfterKill':1},{'cleanup':'UNKNOWN'}]:
   with self.subTest(change=change):self.assertEqual(self.missing_case(change)['cleanup'],'UNKNOWN')
 def test_untrusted_closure_file_refused(self):
  with tempfile.TemporaryDirectory() as temp:
   base=self.setup_base(temp);record=self.registration(base);proof=base/'evidence/controls.json'
   proof.write_text(json.dumps({**record,'cleanup':'kernel-cgroup-populated-zero','populatedAfterKill':0}));proof.chmod(0o666)
   with patch('intake.cgroup_path',return_value=base/'absent'):report=intake.cleanup_registered(base)
   self.assertEqual(report['cleanup'],'UNKNOWN')
 def test_phase_write_and_read_errors_preserve_unknown_receipts(self):
  for failing in ['write','read']:
   with self.subTest(failing=failing),tempfile.TemporaryDirectory() as temp:
    base=self.setup_base(temp);unit_path=base/'unit';unit_path.write_text('unit');report={'cleanup':'UNKNOWN','unit':'owned'}
    real_close=os.close
    with patch('intake.os.write',side_effect=OSError(errno.EIO,'write failed') if failing=='write' else lambda *a:1),patch('intake.populated',side_effect=OSError(errno.EIO,'read failed')),patch('intake.command',side_effect=RuntimeError('recovery failed')),patch('intake.os.close',side_effect=lambda fd:None if fd in [10001,10002,10003] else real_close(fd)):
     intake.finish_phase(base,'controls','owned',unit_path,report,10001,10002,10003)
    saved=json.loads((base/'evidence/controls.json').read_text());self.assertEqual(saved['cleanup'],'UNKNOWN');self.assertIn('cleanupError',saved);self.assertIn('recoveryError',saved)
 def test_migration_accepts_only_bound_permission_denials(self):
  identity={'device':1,'inode':2,'uid':0,'type':'regular'};targets=[{'path':'target-'+str(i),**identity} for i in range(4)]
  for error in [errno.EPERM,errno.EACCES,errno.EROFS]:
   with patch('payload.target_identity',return_value=identity),patch('payload.os.open',side_effect=OSError(error,'denied')):
    evidence=payload.migration_refusals(targets)
   self.assertEqual([x['errno'] for x in evidence],[error]*4);self.assertEqual(evidence[0]['inode'],2)
 def test_migration_missing_wrong_and_replaced_targets_invalid(self):
  with tempfile.TemporaryDirectory() as temp:
   for path in [Path(temp)/'missing-sibling',Path(temp)]:
    with self.assertRaises(payload.InvalidMigrationSetup):payload.target_identity(path)
  identity={'device':1,'inode':2,'uid':0,'type':'regular'};targets=[{'path':'target-'+str(i),**identity} for i in range(4)]
  with patch('payload.target_identity',return_value={**identity,'inode':99}):
   with self.assertRaises(payload.InvalidMigrationSetup):payload.migration_refusals(targets)
  for error in [errno.ENOENT,errno.ENOTDIR,errno.EIO]:
   with patch('payload.target_identity',return_value=identity),patch('payload.os.open',side_effect=OSError(error,'invalid')):
    with self.assertRaises(payload.InvalidMigrationSetup):payload.migration_refusals(targets)
class PreflightChecks(unittest.TestCase):
 def setup(self,temp):
  base=Path(temp)
  for name in ['control','evidence','storage']:(base/name).mkdir()
  publish_release(base/'control/setup-owner.json',{'kind':'before-resources','base':str(base),'identity':intake.stat_identity(base),'storageIdentity':intake.stat_identity(base/'storage')})
  return base
 def test_startup_import_preserves_clean_git_checkout(self):
  env={key:value for key,value in os.environ.items() if key not in ['PYTHONDONTWRITEBYTECODE','PYTHONPYCACHEPREFIX','GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE']}
  with tempfile.TemporaryDirectory() as temp:
   base=Path(temp)
   entry=base/HERE.relative_to(ROOT);entry.mkdir(parents=True)
   for name in ['intake.py','release.py']:(entry/name).write_bytes((HERE/name).read_bytes())
   for parent in [HERE,*HERE.parents[:4]]:
    ignore=parent/'.gitignore'
    if ignore.is_file():
     target=base/ignore.relative_to(ROOT);target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(ignore.read_bytes())
   subprocess.run(['git','init','-q',temp],check=True,env=env)
   subprocess.run(['git','-C',temp,'add','.'],check=True,env=env)
   subprocess.run(['git','-C',temp,'-c','user.name=Source fixture','-c','user.email=fixture@invalid','-c','commit.gpgsign=false','commit','-qm','temporary import-only fixture'],check=True,env=env)
   status=lambda:subprocess.check_output(['git','-C',temp,'status','--porcelain'],text=True,env=env)
   self.assertEqual(status(),'')
   subprocess.run([sys.executable,'-c',"import runpy; runpy.run_path('intake.py',run_name='__import_only__')"],cwd=entry,check=True,env=env)
   self.assertEqual(status(),'')
   self.assertFalse((entry/'__pycache__').exists())
 def test_system_state_exact_pairs_and_receipt(self):
  self.assertTrue(callable(getattr(intake,'system_state',None)))
  for state,status in [('running',0),('degraded',1)]:
   with self.subTest(state=state),tempfile.TemporaryDirectory() as temp:
    base=self.setup(temp)
    with patch('intake.subprocess.run',return_value=intake.subprocess.CompletedProcess([],status,state+'\n','')) as run:
     intake.system_state(base)
    run.assert_called_once_with(['/usr/bin/systemctl','is-system-running','--wait'],text=True,stdout=intake.subprocess.PIPE,stderr=intake.subprocess.PIPE,timeout=10)
    self.assertEqual(json.loads((base/'evidence/systemd-state.json').read_text()),{'state':state,'status':status,'stderr':''})
 def test_boot_starting_waits_once_for_terminal_state_with_existing_deadline(self):
  for state,status in [('running',0),('degraded',1)]:
   with self.subTest(state=state),tempfile.TemporaryDirectory() as temp:
    base=self.setup(temp)
    def boot(argv,**options):
     self.assertEqual(options['timeout'],10)
     return intake.subprocess.CompletedProcess(argv,status,state,'') if '--wait' in argv else intake.subprocess.CompletedProcess(argv,1,'starting','')
    with patch('intake.subprocess.run',side_effect=boot) as run,patch('intake.command') as command:
     intake.system_state(base)
    self.assertEqual(run.call_count,1);command.assert_not_called()
    self.assertEqual(json.loads((base/'evidence/systemd-state.json').read_text())['state'],state)
 def test_system_state_mismatch_unknown_and_unexpected_errors_fail_closed(self):
  self.assertTrue(callable(getattr(intake,'system_state',None)))
  for state,status,stderr in [('running',1,''),('degraded',0,''),('unknown',1,''),('starting',1,''),('degraded',2,''),('running',0,'diagnostic'),('',1,'')]:
   with self.subTest(state=state,status=status),tempfile.TemporaryDirectory() as temp:
    base=self.setup(temp)
    with patch('intake.subprocess.run',return_value=intake.subprocess.CompletedProcess([],status,state,stderr)):
     with self.assertRaises(AssertionError):intake.system_state(base)
    self.assertTrue((base/'evidence/systemd-state.json').is_file())
 def test_generic_command_still_rejects_nonzero(self):
  error=intake.subprocess.CalledProcessError(1,['systemctl'],output='degraded\n')
  with patch('intake.subprocess.check_output',side_effect=error):
   with self.assertRaises(intake.subprocess.CalledProcessError):intake.command(['/usr/bin/systemctl','is-system-running'])
 def test_system_state_timeout_propagates(self):
  self.assertTrue(callable(getattr(intake,'system_state',None)))
  with tempfile.TemporaryDirectory() as temp,patch('intake.subprocess.run',side_effect=intake.subprocess.TimeoutExpired('systemctl',10)):
   with self.assertRaises(intake.subprocess.TimeoutExpired):intake.system_state(self.setup(temp))
 def test_authenticated_pre_resource_absence_closes_without_unmount(self):
  with tempfile.TemporaryDirectory() as temp:
   base=self.setup(temp)
   with patch('intake.command',return_value=json.dumps({'filesystems':[{'target':'/'}]})) as command:intake.cleanup_all(base)
   self.assertEqual(command.call_args_list[0].args[0],['/usr/bin/findmnt','-J','-T',str(base/'storage')]);self.assertEqual(command.call_count,1)
   report=json.loads((base/'evidence/workflow-cleanup.json').read_text())
   self.assertEqual(report['cleanup'],'verified');self.assertTrue(report['resourceSetupNeverStarted']);self.assertTrue(report['exactScratchMountAbsent']);self.assertFalse(report['exactScratchMountRemoved'])
 def test_missing_owner_never_proves_absence(self):
  for defect in ['missing-setup','started','dangling-started','wrong-base','wrong-identity','wrong-storage','writable-setup','registered-group','mounted','wrong-target','readback-error']:
   with self.subTest(defect=defect),tempfile.TemporaryDirectory() as temp:
    base=self.setup(temp);setup=base/'control/setup-owner.json'
    if defect=='missing-setup':setup.unlink()
    if defect=='started':publish_release(base/'control/resource-setup-started.json',{})
    if defect=='dangling-started':(base/'control/resource-setup-started.json').symlink_to(base/'missing')
    if defect in ['wrong-base','wrong-identity','wrong-storage']:
     setup.chmod(0o600);record=json.loads(setup.read_text())
     if defect=='wrong-base':record['base']='foreign'
     elif defect=='wrong-identity':record['identity']['inode']+=1
     else:record['storageIdentity']['inode']+=1
     setup.write_text(json.dumps(record));setup.chmod(0o444)
    if defect=='writable-setup':setup.chmod(0o666)
    if defect=='registered-group':(base/'control/cgroup-bad-owner.json').write_text('{}')
    target=str(base/'storage') if defect=='mounted' else '/foreign' if defect=='wrong-target' else '/'
    with patch('intake.command',side_effect=OSError('readback failed') if defect=='readback-error' else lambda *a:json.dumps({'filesystems':[{'target':target}]})) as command:
     with self.assertRaises(AssertionError):intake.cleanup_all(base)
    self.assertEqual(json.loads((base/'evidence/workflow-cleanup.json').read_text())['cleanup'],'UNKNOWN')
    self.assertFalse(any(x.args[0][0]=='/usr/bin/umount' for x in command.call_args_list))
 def test_main_failure_before_resource_start_has_authenticated_closure(self):
  with tempfile.TemporaryDirectory() as temp:
   root=Path(temp);fixture=root/'fixture';fixture.write_text('memory');node=root/'node';node.write_text('');npm=root/'npm';npm.write_text('')
   def paths(value):return root if value=='/opt' else fixture if value in ['/usr/bin/prlimit','/sys/fs/cgroup/cgroup.controllers'] else Path(value)
   with patch('intake.Path',side_effect=paths),patch('intake.os.geteuid',side_effect=[0]+[os.geteuid()]*100),patch('intake.sys.argv',['intake.py','--run','123-1',str(root),str(node),str(npm)]),patch('intake.subprocess.run',return_value=intake.subprocess.CompletedProcess([],1,'unknown','')),patch('intake.command',return_value='') as command:
    with self.assertRaises(AssertionError):intake.main()
   base=root/'fl103-intake-123-1';self.assertTrue((base/'control/setup-owner.json').is_file());self.assertFalse((base/'control/resource-setup-started.json').exists());self.assertEqual(list((base/'control').glob('cgroup-*-owner.json')),[])
   command.assert_not_called()
   with patch('intake.command',return_value=json.dumps({'filesystems':[{'target':'/'}]})):intake.cleanup_all(base)
   self.assertEqual(json.loads((base/'evidence/workflow-cleanup.json').read_text())['cleanup'],'verified')
if __name__=='__main__':unittest.main()
