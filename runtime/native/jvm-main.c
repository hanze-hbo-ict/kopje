/*
 * jvm-main.c — Kopje's JVM entry point for the Emscripten build (PLAN.md N1).
 *
 * Replaces JavaBox's build/jvm-main.c (MIT, © 2026 Brian Martin) at build time; the
 * JavaBox repository itself stays pinned and unmodified. Compared with upstream:
 *   - no Doom / Web Audio / Canvas / key-queue natives and no headless-AWT initIDs stubs
 *     (java.desktop is not in the image); none of their exports
 *   - no EM_JS FS/stdin hooks (they ran on the JVM pthread, not the main thread; the
 *     runtime host creates directories in preRun)
 *   - stdin ring buffer without the lost-wakeup race: the reader waits on a sequence
 *     counter that the writer bumps after publishing data
 *   - built-in --patch-module for the sun.nio.fs patch (PLAN.md F1)
 *
 * The three non-static stdin functions are referenced from libjava (io_util_md.c,
 * __EMSCRIPTEN__ branch of the OpenJDK port) and must keep their names and signatures.
 * Diff this file against upstream build/jvm-main.c on every JavaBox bump.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <stdint.h>
#include <jni.h>
#include <emscripten.h>
#include <emscripten/threading.h>

/* ── stdin ring buffer (fd 0) ───────────────────────────────────────────────── */

#define RING_SIZE 3072

static unsigned char ring[RING_SIZE];
static volatile int32_t write_pos = 0;   /* next byte to write   */
static volatile int32_t read_pos = 0;    /* next byte to read    */
static volatile int32_t data_seq = 0;    /* bumped after every write; futex word */
static int ring_enabled = 0;

/* Blocking read of one byte (JVM thread). Returns EOF never: the ring has no EOF;
 * the Kopje driver reads student input from a MEMFS file instead and only a
 * program that opens FileDescriptor.in directly ends up here. */
int stdin_read_byte(void) {
    for (;;) {
        int32_t seq = __atomic_load_n(&data_seq, __ATOMIC_ACQUIRE);
        int32_t wp = __atomic_load_n(&write_pos, __ATOMIC_ACQUIRE);
        int32_t rp = __atomic_load_n(&read_pos, __ATOMIC_RELAXED);
        if (rp != wp) {
            unsigned char byte = ring[rp];
            __atomic_store_n(&read_pos, (rp + 1) % RING_SIZE, __ATOMIC_RELEASE);
            return byte;
        }
        /* Sleeps only if no write happened since `seq` was read: no lost wake-up. */
        emscripten_futex_wait((volatile void*)&data_seq, (uint32_t)seq, INFINITY);
    }
}

int jvm_use_ring_buffer_stdin(void) { return ring_enabled; }

int jvm_stdin_available(void) {
    int32_t wp = __atomic_load_n(&write_pos, __ATOMIC_ACQUIRE);
    int32_t rp = __atomic_load_n(&read_pos, __ATOMIC_RELAXED);
    return (wp - rp + RING_SIZE) % RING_SIZE;
}

EMSCRIPTEN_KEEPALIVE
void jvm_enable_ring_buffer_stdin(void) { ring_enabled = 1; }

/* Non-blocking write from the browser thread. Returns the number of bytes accepted
 * (less than len when the ring is full); never spins on the caller's thread. */
EMSCRIPTEN_KEEPALIVE
int jvm_stdin_write(const char* data, int len) {
    if (!data || len <= 0) return 0;
    int n = 0;
    while (n < len) {
        int32_t wp = __atomic_load_n(&write_pos, __ATOMIC_RELAXED);
        int32_t rp = __atomic_load_n(&read_pos, __ATOMIC_ACQUIRE);
        if ((wp + 1) % RING_SIZE == rp) break;          /* full */
        ring[wp] = (unsigned char)data[n++];
        __atomic_store_n(&write_pos, (wp + 1) % RING_SIZE, __ATOMIC_RELEASE);
    }
    if (n > 0) {
        __atomic_add_fetch(&data_seq, 1, __ATOMIC_RELEASE);
        emscripten_futex_wake((volatile void*)&data_seq, INT32_MAX);
    }
    return n;
}

/* ── JVM entry ──────────────────────────────────────────────────────────────── */

int main(int argc, char** argv) {
    /* os::jvm_path() reads JAVA_HOME before -Djava.home is parsed. */
    setenv("JAVA_HOME", "/opt/jdk", 1);
    setenv("HOME", "/root", 1);
    setenv("USER", "root", 1);

    JavaVMOption options[40];
    int n = 0;
    options[n++].optionString = "-Djava.home=/opt/jdk";
    options[n++].optionString = "-Xint";
    /* E6: Emscripten's mmap backs every reservation with real memory, so keep them small.
     * Measured (Chromium, docs/baseline.md): WASM heap per runtime 308 MB -> 220 MB. */
    options[n++].optionString = "-Xmx96m";
    options[n++].optionString = "-XX:ReservedCodeCacheSize=8m";   /* -Xint: no JIT code */
    options[n++].optionString = "-XX:MaxMetaspaceSize=64m";
    options[n++].optionString = "-Xss512k";
    options[n++].optionString = "-Xshare:off";
    options[n++].optionString = "-XX:+UseSerialGC";
    options[n++].optionString = "-XX:-UsePerfData";
    options[n++].optionString = "-XX:+ReduceSignalUsage";
    options[n++].optionString = "-Xlog:all=off";
    options[n++].optionString = "-XX:-OmitStackTraceInFastThrow";
    options[n++].optionString = "--patch-module=java.base=/opt/jdk/patch/java.base";
    options[n++].optionString = "-Djava.class.path=/opt/javabox";
    options[n++].optionString = "-Dfile.encoding=UTF-8";
    options[n++].optionString = "-Dstdout.encoding=UTF-8";
    options[n++].optionString = "-Dstderr.encoding=UTF-8";
    options[n++].optionString = "-Dsun.jnu.encoding=UTF-8";
    options[n++].optionString = "-Duser.home=/root";
    options[n++].optionString = "-Duser.dir=/root";
    /* Extra options from Module.arguments come last so they can override. */
    for (int i = 1; i < argc && n < (int)(sizeof(options) / sizeof(options[0])); i++) {
        options[n++].optionString = argv[i];
    }

    JavaVMInitArgs vm_args;
    vm_args.version = JNI_VERSION_21;
    vm_args.nOptions = n;
    vm_args.options = options;
    vm_args.ignoreUnrecognized = JNI_FALSE;

    JavaVM* vm;
    JNIEnv* env;
    if (JNI_CreateJavaVM(&vm, (void**)&env, &vm_args) != JNI_OK) {
        fprintf(stderr, "ERROR: JNI_CreateJavaVM failed\n");
        return 1;
    }

    jclass cls = (*env)->FindClass(env, "CompileServer");
    if (cls == NULL) {
        fprintf(stderr, "ERROR: could not find CompileServer\n");
        if ((*env)->ExceptionCheck(env)) (*env)->ExceptionDescribe(env);
        (*vm)->DestroyJavaVM(vm);
        return 1;
    }
    jmethodID mainMethod = (*env)->GetStaticMethodID(env, cls, "main", "([Ljava/lang/String;)V");
    if (mainMethod == NULL) {
        fprintf(stderr, "ERROR: could not find CompileServer.main\n");
        (*vm)->DestroyJavaVM(vm);
        return 1;
    }
    jobjectArray args = (*env)->NewObjectArray(env, 0, (*env)->FindClass(env, "java/lang/String"), NULL);
    (*env)->CallStaticVoidMethod(env, cls, mainMethod, args);
    if ((*env)->ExceptionCheck(env)) (*env)->ExceptionDescribe(env);
    (*vm)->DestroyJavaVM(vm);
    return 0;
}
