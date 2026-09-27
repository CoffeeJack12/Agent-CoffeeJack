import json
import re
import sys
import unicodedata

from rapidfuzz import fuzz, process
from wordfreq import top_n_list, zipf_frequency
from pyarabic import araby

# Fallback only. Keep lists intentionally small so the large Wordfreq
# database stays on disk and this process exits immediately after one lookup.
EN_FUZZY_LIMIT = 30000
MAX_UNKNOWN = 3

DOMAIN_TERMS = [
    "luatools", "coffeejack", "bitrix24", "steam", "ollama", "github",
    "cloudflare", "google", "windows", "powershell", "javascript", "python",
]

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

def normalize_arabic(value):
    value = araby.strip_tashkeel(value)
    value = araby.strip_tatweel(value)
    value = araby.normalize_ligature(value)
    return unicodedata.normalize("NFKC", value)

def correct_latin(token, common_en):
    lower = token.lower()
    if lower in ALIASES:
        return ALIASES[lower], "alias"
    if not lower.isalpha() or len(lower) < 4 or len(lower) > 18:
        return token, None
    if zipf_frequency(lower, "en") >= 2.2:
        return token, None

    domain = process.extractOne(
        lower, DOMAIN_TERMS, scorer=fuzz.ratio, score_cutoff=72
    )
    if domain:
        value = domain[0]
        mapped = ALIASES.get(value, value)
        if value == "luatools":
            mapped = "LuaTools"
        elif value == "coffeejack":
            mapped = "CoffeeJack"
        elif value == "bitrix24":
            mapped = "Bitrix24"
        return mapped, "domain_fuzzy"

    common = process.extractOne(
        lower, common_en, scorer=fuzz.ratio, score_cutoff=91
    )
    if common and abs(len(common[0]) - len(lower)) <= 2:
        return common[0], "wordfreq_fuzzy"
    return token, None

def enrich(text):
    normalized = normalize_arabic(str(text or ""))
    common_en = None
    changes = []
    low_frequency_checked = 0

    parts = re.split(r"([A-Za-z][A-Za-z'_-]*)", normalized)
    for i in range(1, len(parts), 2):
        token = parts[i]
        lower = token.lower()
        if lower in ALIASES:
            corrected, reason = ALIASES[lower], "alias"
        elif (
            lower.isalpha()
            and 4 <= len(lower) <= 18
            and zipf_frequency(lower, "en") < 2.2
            and low_frequency_checked < MAX_UNKNOWN
        ):
            if common_en is None:
                common_en = top_n_list("en", EN_FUZZY_LIMIT)
            corrected, reason = correct_latin(token, common_en)
            low_frequency_checked += 1
        else:
            corrected, reason = token, None
        if corrected != token:
            parts[i] = corrected
            changes.append({"from": token, "to": corrected, "reason": reason})

    return {
        "text": "".join(parts),
        "changed": bool(changes),
        "changes": changes,
        "wordfreq_fallback": True,
        "candidate_limit": EN_FUZZY_LIMIT,
    }

if __name__ == "__main__":
    try:
        raw = sys.argv[1] if len(sys.argv) > 1 else ""
        print(json.dumps(enrich(raw), ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({
            "text": sys.argv[1] if len(sys.argv) > 1 else "",
            "changed": False,
            "changes": [],
            "error": str(exc),
        }, ensure_ascii=False))
