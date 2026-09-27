"""Deterministic text embeddings for IRIS Vector Search.

Feature hashing of word unigrams, bigrams and character trigrams into a fixed-size,
L2-normalised vector. No model download, works offline on Community Edition, and is
good enough to find log lines describing the same kind of problem.
"""
import hashlib
import math
import re

from .logparse import template

DIM = 256
_WORD_RE = re.compile(r"[a-z_%$][a-z0-9_.%$]*", re.I)


def _bucket(token):
    h = int.from_bytes(hashlib.blake2b(token.encode(), digest_size=8).digest(), "little")
    return h % DIM, (1.0 if (h >> 63) & 1 else -1.0)


def features(text):
    norm = template(text).lower()
    words = _WORD_RE.findall(norm)
    feats = [("w:" + w, 1.0) for w in words]
    feats += [("b:" + a + " " + b, 0.7) for a, b in zip(words, words[1:])]
    for w in words:
        padded = f"^{w}$"
        feats += [("c:" + padded[i:i + 3], 0.3) for i in range(len(padded) - 2)]
    return feats


def embed(text):
    vec = [0.0] * DIM
    for tok, weight in features(text):
        idx, sign = _bucket(tok)
        vec[idx] += sign * weight
    n = math.sqrt(sum(v * v for v in vec)) or 1.0
    return [round(v / n, 6) for v in vec]


def to_vector_string(vec):
    return ",".join(repr(v) for v in vec)
