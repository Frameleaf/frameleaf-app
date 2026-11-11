#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#if defined(__x86_64__) && !defined(__ILP32__)
#define NATIVE_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define NATIVE_ARCH AUDIT_ARCH_AARCH64
#else
#error "Unsupported media runner architecture"
#endif

#define REJECT (SECCOMP_RET_ERRNO | EPERM)
#define DENY(nr) \
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_##nr, 0, 1), \
    BPF_STMT(BPF_RET | BPF_K, REJECT)
#define LOCAL_SOCKET(syscall_name) \
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_##syscall_name, 0, 4), \
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])), \
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_UNIX, 1, 0), \
    BPF_STMT(BPF_RET | BPF_K, REJECT), \
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr))

static int lock_network(void) {
    struct sock_filter rules[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, NATIVE_ARCH, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#if defined(__x86_64__)
        /* A different ABI cannot use the native syscall allow rules. */
        BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 0x40000000U, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
#endif
        LOCAL_SOCKET(socket),
        LOCAL_SOCKET(socketpair),
        DENY(io_uring_setup),
        DENY(io_uring_register),
        DENY(io_uring_enter),
        DENY(ptrace),
        DENY(process_vm_readv),
        DENY(process_vm_writev),
        DENY(pidfd_getfd),
        DENY(pidfd_send_signal),
        DENY(kcmp),
        DENY(bpf),
        DENY(perf_event_open),
        DENY(userfaultfd),
        /* Reject descriptor passing over AF_UNIX, including inherited stdio. */
        DENY(recvmsg),
        DENY(recvmmsg),
        DENY(sendmsg),
        DENY(sendmmsg),
        DENY(setsid),
        DENY(setpgid),
        DENY(unshare),
        DENY(setns),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_fprog program = {
        .len = (unsigned short)(sizeof(rules) / sizeof(rules[0])),
        .filter = rules,
    };
    return prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) ||
           prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program);
}

static int safe_stdio(void) {
    for (int i = 0; i < 3; i++) {
        struct stat info;
        if (fstat(i, &info)) {
            return 0;
        }
        if (S_ISSOCK(info.st_mode)) {
            struct sockaddr_storage address;
            socklen_t len = sizeof(address);
            if (getsockname(i, (struct sockaddr *)&address, &len) ||
                address.ss_family != AF_UNIX) {
                return 0;
            }
        }
    }
    return 1;
}

int main(int argc, char **argv) {
    if (argc < 4 || argv[3][0] != '/') {
        return 125;
    }

    uid_t caller = getuid();
    char *end;
    errno = 0;
    unsigned long requested = strtoul(argv[2], &end, 10);
    if (errno || *end || requested < 200000 || requested > 9999999) {
        return 125;
    }
    uid_t runner = caller ? caller : (uid_t)requested;
    int directory = open(argv[1], O_RDONLY | O_CLOEXEC | O_DIRECTORY | O_NOFOLLOW);
    struct stat info;
    if (directory < 0 || fstat(directory, &info) ||
        info.st_uid != caller || (info.st_mode & 077) || fchdir(directory)) {
        return 125;
    }

    if (!caller &&
        (fchown(directory, runner, runner) || setgroups(0, NULL) ||
         setresgid(runner, runner, runner) || setresuid(runner, runner, runner))) {
        return 125;
    }
    struct rlimit core = {0, 0};
    struct rlimit files = {256, 256};
    if (!getuid() || !geteuid() || setrlimit(RLIMIT_CORE, &core) ||
        setrlimit(RLIMIT_NOFILE, &files) || !safe_stdio() ||
        syscall(SYS_close_range, 3U, ~0U, 0U) || lock_network()) {
        return 125;
    }

    umask(077);
    execv(argv[3], &argv[3]);
    return 125;
}
