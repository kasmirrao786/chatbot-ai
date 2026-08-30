"""
numbers.py — query-time number normalization for search().

Survey/polling source documents mix numeral and word forms of numbers
("20% said yes" vs. "twenty percent said yes"), and embedding models
generally don't learn a strong semantic link between a digit and its
spelled-out word — "20" and "twenty" end up in different, weakly-related
regions of vector space. A user asking "how many said twenty percent"
can miss a chunk that only ever wrote "20%", and vice versa.

This is a query-time side job, not an ingestion-time rewrite: it runs
inline inside search() on every live chat turn, generating a small set of
query variants (numerals normalized to words, words normalized to
numerals, "%" <-> "percent"), retrieving for each, and merging results by
node id. It's called "option (c)" — as opposed to (a) precomputing/storing
both forms for every chunk at ingest time, or (b) doing the conversion in
the Node backend before it ever reaches the KB Service — because it keeps
all retrieval logic inside the KB Service's boundary and needs no changes
to what's stored, at the cost of a couple of extra (cheap, local,
no-network) retrieval passes per chat turn.
"""
import re

_ONES = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
    "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14,
    "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18,
    "nineteen": 19,
}
_TENS = {
    "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50,
    "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90,
}
_NUM_TO_WORD = {v: k for k, v in {**_ONES, **_TENS}.items()}
_WORD_TO_NUM = {**_ONES, **_TENS}

# Matches "twenty", "twenty-five", "twenty five" (hyphen or space joiner).
_WORD_NUM_RE = re.compile(
    r"\b(" + "|".join(sorted(_TENS, key=len, reverse=True)) + r")"
    r"(?:[\s-](" + "|".join(sorted(_ONES, key=len, reverse=True)) + r"))?\b",
    re.IGNORECASE,
)

# Matches a bare integer (e.g. in "20%" or "there are 45 respondents").
_DIGIT_RE = re.compile(r"\b\d{1,3}\b")


def _words_to_digits(text: str) -> str:
    def repl(m):
        tens_word = m.group(1).lower()
        ones_word = m.group(2)
        value = _TENS[tens_word] + (_ONES[ones_word.lower()] if ones_word else 0)
        return str(value)

    return _WORD_NUM_RE.sub(repl, text)


def _digits_to_words(text: str) -> str:
    def repl(m):
        value = int(m.group(0))
        if value in _NUM_TO_WORD:
            return _NUM_TO_WORD[value]
        if 21 <= value <= 99 and value % 10 != 0:
            return f"{_NUM_TO_WORD[(value // 10) * 10]}-{_NUM_TO_WORD[value % 10]}"
        return m.group(0)  # outside the small range we handle — leave as-is

    return _DIGIT_RE.sub(repl, text)


def _percent_variants(text: str) -> list:
    out = []
    if "%" in text:
        out.append(text.replace("%", " percent"))
    if re.search(r"\bpercent\b", text, re.IGNORECASE):
        out.append(re.sub(r"\s*\bpercent\b", "%", text, flags=re.IGNORECASE))
    return out


def generate_query_variants(query: str, max_variants: int = 4) -> list:
    """Return [query] plus up to (max_variants - 1) deduped number-normalized
    variants. Order: original first (kept as top priority on tie), then
    digit-normalized, word-normalized, percent-swapped forms."""
    variants = [query]

    digitized = _words_to_digits(query)
    if digitized != query:
        variants.append(digitized)

    worded = _digits_to_words(query)
    if worded != query:
        variants.append(worded)

    for base in list(variants):
        for pv in _percent_variants(base):
            if pv not in variants:
                variants.append(pv)

    # De-dupe while preserving order, then cap.
    seen = set()
    deduped = []
    for v in variants:
        key = v.lower()
        if key not in seen:
            seen.add(key)
            deduped.append(v)
    return deduped[:max_variants]
