"""Pure source/filesystem checks. Never executes intake subprocesses or kernel controls."""
import errno,ast,hashlib,importlib.util,json,os,tempfile,unittest
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
 def test_exact_125_recipe_and_lock(self):
  data=json.loads((ROOT/'studio/engine-build.json').read_text())
  self.assertEqual(len(data['patches']),125)
  self.assertEqual(data['sourceSha256'],'6d1edf68bb2d67195f3cfa5a58b78fe1c36148069934efef3060962d199e645d')
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
if __name__=='__main__':unittest.main()
