import importlib.util
import json
import os
import re
import subprocess
import sys
import unicodedata
from pathlib import Path

from pyarabic import araby

# Fallback only. Keep lists intentionally small so the large Wordfreq
# database stays on disk and this process exits immediately after one lookup.
# Farasa runs the locally installed QCRI jar directly: farasapy's wrapper would
# download missing binaries and cache user text on disk, both of which are
# unacceptable for a local-only assistant.
EN_FUZZY_LIMIT = 30000
MAX_UNKNOWN = 3
FARASA_TIMEOUT_S = float(os.environ.get("COFFEEJACK_FARASA_TIMEOUT", "3.2"))
MAX_ARABIC_WORDS = 48

DOMAIN_TERMS = [
    "luatools", "coffeejack", "bitrix24", "steam", "ollama", "github",
    "cloudflare", "google", "windows", "powershell", "javascript", "python",
]
DOMAIN_DISPLAY = {
    "luatools": "LuaTools",
    "coffeejack": "CoffeeJack",
    "bitrix24": "Bitrix24",
}

ALIASES = {
    "luaools": "LuaTools",
    "luatols": "LuaTools",
    "luatool": "LuaTools",
    "luatoolz": "LuaTools",
    "coffejack": "CoffeeJack",
    "coffeejack": "CoffeeJack",
    "britrix": "Bitrix24",
    "bitrex": "Bitrix24",
}

ARABIC_WORD_RE = re.compile(r"[\u0621-\u064a\u0671-\u06d3]+")
LATIN_TOKEN_RE = re.compile(r"([A-Za-z][A-Za-z0-9'_-]*)")

# Plain lowercase typos may be corrected against the small domain list; tokens
# that look like names or identifiers need much stronger evidence.
DOMAIN_CUTOFF_PLAIN = 78
DOMAIN_CUTOFF_PROTECTED = 90
COMMON_CUTOFF = 91


def normalize_arabic(value):
    value = araby.strip_tashkeel(value)
    value = araby.strip_tatweel(value)
    value = araby.normalize_ligature(value)
    return unicodedata.normalize("NFKC", value)


def repo_root():
    return Path(__file__).resolve().parents[2]


def find_java():
    # Only the portable runtime is trusted: a system JRE on PATH/JAVA_HOME is
    # neither pinned nor guaranteed to be local-only.
    java = repo_root() / ".runtime" / "farasa-jre" / "bin" / ("java.exe" if os.name == "nt" else "java")
    return str(java) if java.is_file() else None


def find_farasa_jar():
    override = os.environ.get("COFFEEJACK_FARASA_JAR")
    if override:
        return override if Path(override).is_file() else None
    try:
        # find_spec locates the package without executing farasa/__init__.py,
        # which would import requests/tqdm for nothing.
        spec = importlib.util.find_spec("farasa")
    except (ImportError, ValueError):
        return None
    if not spec or not spec.submodule_search_locations:
        return None
    for location in spec.submodule_search_locations:
        jar = Path(location) / "farasa_bin" / "lib" / "FarasaSegmenterJar.jar"
        if jar.is_file():
            return str(jar)
    return None


def farasa_status():
    java = find_java()
    jar = find_farasa_jar()
    return {"java": bool(java), "jar": bool(jar), "available": bool(java and jar)}


def kill_on_close_job():
    """Windows job that kills the JVM whenever this worker dies, however it dies.

    Node may TerminateProcess the worker on abort before taskkill /T can walk
    the tree, which would otherwise orphan java.exe.
    """
    if os.name != "nt":
        return None
    try:
        import ctypes
        from ctypes import wintypes

        class IO_COUNTERS(ctypes.Structure):
            _fields_ = [(name, ctypes.c_ulonglong) for name in (
                "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                "ReadTransferCount", "WriteTransferCount", "OtherTransferCount",
            )]

        class BASIC_LIMITS(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_int64),
                ("PerJobUserTimeLimit", ctypes.c_int64),
                ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD),
            ]

        class EXTENDED_LIMITS(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", BASIC_LIMITS),
                ("IoInfo", IO_COUNTERS),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryLimit", ctypes.c_size_t),
                ("PeakJobMemoryLimit", ctypes.c_size_t),
            ]

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        kernel32.SetInformationJobObject.restype = wintypes.BOOL
        kernel32.SetInformationJobObject.argtypes = [
            wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
        ]
        job = kernel32.CreateJobObjectW(None, None)
        if not job:
            return None
        info = EXTENDED_LIMITS()
        info.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not kernel32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info)):
            return None
        return job
    except Exception:
        return None


def assign_to_job(job, handle):
    if not job or os.name != "nt":
        return False
    try:
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
        kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        if handle is None:
            kernel32.GetCurrentProcess.restype = wintypes.HANDLE
            handle = kernel32.GetCurrentProcess()
        return bool(kernel32.AssignProcessToJobObject(job, handle))
    except Exception:
        return False


# The job handle must live as long as the worker; closing it kills the JVM.
_FARASA_JOB = None


def start_farasa():
    global _FARASA_JOB
    java = find_java()
    jar = find_farasa_jar()
    if not java or not jar:
        return None, "unavailable"
    self_in_job = False
    if os.name == "nt":
        _FARASA_JOB = kill_on_close_job()
        if not _FARASA_JOB:
            return None, "unavailable"
        # Joining the job before Popen makes the JVM inherit it from birth.
        self_in_job = assign_to_job(_FARASA_JOB, None)
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    try:
        proc = subprocess.Popen(
            [java, "-Dfile.encoding=UTF-8", "-jar", jar, "-l", "true"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            creationflags=flags,
        )
    except OSError:
        return None, "unavailable"
    if os.name == "nt" and not self_in_job and not assign_to_job(_FARASA_JOB, int(proc._handle)):
        proc.kill()
        proc.communicate()
        return None, "unavailable"
    return proc, "started"


def finish_farasa(proc, arabic_words):
    payload = (" ".join(arabic_words) + "\n").encode("utf-8")
    try:
        stdout, _ = proc.communicate(payload, timeout=FARASA_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.communicate()
        return None, "timeout"
    except OSError:
        proc.kill()
        return None, "failed"
    if proc.returncode != 0:
        return None, "failed"
    return stdout.decode("utf-8", "replace"), "ok"


def correct_latin(token, common_en, protected):
    from rapidfuzz import fuzz, process

    lower = token.lower()
    domain = process.extractOne(
        lower,
        DOMAIN_TERMS,
        scorer=fuzz.ratio,
        score_cutoff=DOMAIN_CUTOFF_PROTECTED if protected else DOMAIN_CUTOFF_PLAIN,
    )
    if domain and domain[0][0] == lower[0] and abs(len(domain[0]) - len(lower)) <= 2:
        return DOMAIN_DISPLAY.get(domain[0], domain[0]), "domain_fuzzy"
    if protected:
        return token, None

    common = process.extractOne(
        lower, common_en, scorer=fuzz.ratio, score_cutoff=COMMON_CUTOFF
    )
    if common and abs(len(common[0]) - len(lower)) <= 2:
        return common[0], "wordfreq_fuzzy"
    return token, None


def looks_like_identifier(token, prefix):
    if any(ch.isdigit() or ch in "_-'" for ch in token):
        return True
    if prefix[-1:] in ("\\", "/", ".", ":", "@", "#", "$", "`", '"'):
        return True
    rest = token[1:]
    if rest and any(ch.isupper() for ch in rest):
        return True
    return token[0].isupper()


def correct_latin_tokens(text):
    parts = LATIN_TOKEN_RE.split(text)
    if len(parts) == 1:
        return text, []
    from wordfreq import top_n_list, zipf_frequency

    common_en = None
    changes = []
    low_frequency_checked = 0
    for i in range(1, len(parts), 2):
        token = parts[i]
        lower = token.lower()
        if lower in ALIASES:
            corrected, reason = ALIASES[lower], "alias"
        elif (
            lower.isalpha()
            and 4 <= len(lower) <= 18
            and low_frequency_checked < MAX_UNKNOWN
            and zipf_frequency(lower, "en") < 2.2
        ):
            if common_en is None:
                common_en = top_n_list("en", EN_FUZZY_LIMIT)
            protected = looks_like_identifier(token, parts[i - 1])
            corrected, reason = correct_latin(token, common_en, protected)
            low_frequency_checked += 1
        else:
            corrected, reason = token, None
        if corrected != token:
            parts[i] = corrected
            changes.append({"from": token, "to": corrected, "reason": reason})
    return "".join(parts), changes


def routing_stems(farasa_output, arabic_words):
    present = set(arabic_words)
    stems = []
    for word in ARABIC_WORD_RE.findall(farasa_output or ""):
        if len(word) < 2 or word in present or word in stems:
            continue
        stems.append(word)
    return stems[:MAX_ARABIC_WORDS]


def enrich(text, use_farasa):
    normalized = normalize_arabic(str(text or ""))
    arabic_words = ARABIC_WORD_RE.findall(normalized)[:MAX_ARABIC_WORDS]

    proc, farasa_state = (None, "skipped")
    if use_farasa and arabic_words:
        proc, farasa_state = start_farasa()

    try:
        corrected, changes = correct_latin_tokens(normalized)
    except Exception:
        if proc:
            proc.kill()
            proc.communicate()
        raise

    stems = []
    if proc:
        output, farasa_state = finish_farasa(proc, arabic_words)
        if output:
            stems = routing_stems(output, arabic_words)

    return {
        "text": corrected,
        "changed": bool(changes),
        "changes": changes,
        "wordfreq_fallback": True,
        "farasa": farasa_state,
        "routing_stems": stems,
    }


def main(argv):
    if "--probe" in argv:
        return {"ok": True, "farasa": farasa_status()}
    raw = sys.stdin.buffer.read().decode("utf-8", "replace")
    try:
        return enrich(raw, use_farasa="--farasa" in argv)
    except Exception as exc:
        return {"text": raw, "changed": False, "changes": [], "error": str(exc)[:200]}


if __name__ == "__main__":
    print(json.dumps(main(sys.argv[1:]), ensure_ascii=True))
