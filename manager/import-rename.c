// SPDX-License-Identifier: AGPL-3.0-or-later
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <linux/fs.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

static bool name_ok(const char *name) {
  return *name && !strchr(name, '/') && strcmp(name, ".") && strcmp(name, "..");
}
static bool number(const char *text, uintmax_t *value) {
  if (!*text) return false;
  for (const char *p = text; *p; p++) if (*p < '0' || *p > '9') return false;
  char *end;
  errno = 0;
  *value = strtoumax(text, &end, 10);
  return !errno && !*end;
}
int main(int argc, char **argv) {
  uintmax_t device, inode;
  struct stat source_parent, target_parent, before, after;
  if (argc != 5 || !name_ok(argv[1]) || !name_ok(argv[2]) ||
      !number(argv[3], &device) || !number(argv[4], &inode)) return 2;
  if (fstat(3, &source_parent) || fstat(4, &target_parent) ||
      !S_ISDIR(source_parent.st_mode) || !S_ISDIR(target_parent.st_mode)) return 2;
  if (source_parent.st_dev != target_parent.st_dev) return 78;
  if (fstatat(3, argv[1], &before, AT_SYMLINK_NOFOLLOW) || !S_ISREG(before.st_mode) ||
      before.st_nlink != 1 || (uintmax_t)before.st_dev != device ||
      (uintmax_t)before.st_ino != inode) return 80;
  // Never emulate this syscall: its native failure preserves the no-overwrite guarantee.
  if (syscall(SYS_renameat2, 3, argv[1], 4, argv[2], RENAME_NOREPLACE)) {
    if (errno == ENOSYS || errno == EINVAL || errno == EOPNOTSUPP) return 77;
    if (errno == EXDEV) return 78;
    if (errno == EEXIST || errno == ENOTEMPTY) return 79;
    return 1;
  }
  int synced = fsync(3);
  if (fsync(4)) synced = -1;
  if (synced) return 1;
  if (fstatat(4, argv[2], &after, AT_SYMLINK_NOFOLLOW) || !S_ISREG(after.st_mode) ||
      after.st_nlink != 1 || after.st_dev != before.st_dev || after.st_ino != before.st_ino)
    return 80;
  return 0;
}
