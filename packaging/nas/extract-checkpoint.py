"""Extract an owner-reviewed disposable media archive; reject escaping paths and links."""
import pathlib
import sys
import tarfile

archive, destination = sys.argv[1:]
root = pathlib.Path(destination)
if root.exists():
    raise ValueError("Media restore destination must be fresh")
with tarfile.open(archive, "r:") as source:
    members = source.getmembers()
    seen = set()
    for member in members:
        name = pathlib.PurePosixPath(member.name)
        if name.is_absolute() or ".." in name.parts or not name.parts or "\\" in member.name:
            raise ValueError("Unsafe media checkpoint path")
        normalized = str(name)
        if not (member.isfile() or member.isdir()) or normalized in seen:
            raise ValueError("Media links, special files and duplicate paths are forbidden")
        if member.mode & 0o7000:
            raise ValueError("Special permission bits are forbidden")
        seen.add(normalized)
    root.mkdir(mode=0o700)
    source.extractall(root, members=members, filter="data")
