import json,os,time
def publish_release(path,value):
 data=(json.dumps(value,separators=(',',':'))+'\n').encode();assert len(data)<=4096
 directory=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 temp='.release-'+str(time.monotonic_ns());identity=None
 try:
  owner=os.fstat(directory);assert owner.st_uid==os.geteuid() and owner.st_mode&0o022==0
  fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=directory)
  identity=os.fstat(fd)
  assert identity.st_uid==os.geteuid()
  with os.fdopen(fd,'wb') as stream:
   stream.write(data);stream.flush();os.fsync(stream.fileno())
   os.fchmod(stream.fileno(),0o444);os.fsync(stream.fileno())
  # Hard-link publication is atomic and refuses an existing destination.
  os.link(temp,path.name,src_dir_fd=directory,dst_dir_fd=directory,follow_symlinks=False)
  os.fsync(directory)
 finally:
  try:
   if identity is not None:
    current=os.stat(temp,dir_fd=directory,follow_symlinks=False)
    assert (current.st_dev,current.st_ino)==(identity.st_dev,identity.st_ino),'temporary identity changed; preserve foreign replacement'
    os.unlink(temp,dir_fd=directory);os.fsync(directory)
  finally:os.close(directory)
